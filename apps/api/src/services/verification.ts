import { resolveTxt, lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { AppConfig } from '../config';

export const VERIFICATION_META_NAME = 'blissnova-site-verification';
export const VERIFICATION_FILE_PATH = '/.well-known/blissnova-verification.txt';
export const VERIFICATION_TXT_PREFIX = 'blissnova-verification=';

export function verificationInstructions(domain: string, token: string) {
  return {
    dns_txt: { label: 'DNS TXT record', instructions: `Add a TXT record to ${domain} with the value below. DNS changes can take up to 48 hours to propagate.`, host: domain, value: `${VERIFICATION_TXT_PREFIX}${token}` },
    html_file: { label: 'Verification file', instructions: `Upload a plain-text file at https://${domain}${VERIFICATION_FILE_PATH} containing only the value below.`, path: VERIFICATION_FILE_PATH, value: token },
    meta_tag: { label: 'HTML meta tag', instructions: `Add this tag inside the <head> of https://${domain}/ (the WordPress plugin can add it for you).`, value: `<meta name="${VERIFICATION_META_NAME}" content="${token}">` },
  };
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
}

/**
 * SSRF-safe GET. The socket connects only to addresses vetted at connection
 * time (defeating DNS rebinding), redirects are refused, and the response
 * size and time are bounded.
 */
export async function safeFetchText(url: string, cfg: Pick<AppConfig, 'VERIFICATION_ALLOW_HTTP' | 'VERIFICATION_PRIVATE_HOST_ALLOWLIST'>, maxBytes = 512_000, timeoutMs = 5000): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(cfg.VERIFICATION_ALLOW_HTTP && u.protocol === 'http:')) throw new Error('Only HTTPS URLs can be checked');
  const allowPrivate = cfg.VERIFICATION_PRIVATE_HOST_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean).includes(u.hostname);
  const lookup: LookupFunction = (hostname, options, cb) => {
    dnsLookup(hostname, { all: true }).then((addrs) => {
      const ok = addrs.filter((a) => allowPrivate || !isPrivateAddress(a.address));
      if (ok.length === 0) return cb(new Error('Host resolves to a private or reserved address'), '', 4);
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof ok) => void)(null, ok);
      cb(null, ok[0]!.address, ok[0]!.family);
    }, (err) => cb(err, '', 4));
  };
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(u, { method: 'GET', lookup, timeout: timeoutMs, headers: { 'user-agent': 'BlissNova-Verification/1.0', accept: 'text/html,text/plain;q=0.9' } }, (res) => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
        res.resume();
        return reject(new Error('Redirects are not followed during verification; serve the file directly'));
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          r.destroy();
          reject(new Error('Response too large'));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('Timed out')));
    r.on('error', reject);
    r.end();
  });
}

export type VerificationOutcome = { ok: true } | { ok: false; error: string };

export async function checkVerification(method: 'dns_txt' | 'html_file' | 'meta_tag', domain: string, token: string, cfg: AppConfig): Promise<VerificationOutcome> {
  try {
    if (method === 'dns_txt') {
      const records = (await resolveTxt(domain)).map((r) => r.join(''));
      return records.includes(`${VERIFICATION_TXT_PREFIX}${token}`) ? { ok: true } : { ok: false, error: 'The TXT record was not found yet' };
    }
    const scheme = cfg.VERIFICATION_ALLOW_HTTP && domain === 'localhost' ? 'http' : 'https';
    if (method === 'html_file') {
      const res = await safeFetchText(`${scheme}://${domain}${VERIFICATION_FILE_PATH}`, cfg, 10_000);
      if (res.status !== 200) return { ok: false, error: `The file returned HTTP ${res.status}` };
      return res.body.trim() === token ? { ok: true } : { ok: false, error: 'The file content does not match the token' };
    }
    const res = await safeFetchText(`${scheme}://${domain}/`, cfg);
    if (res.status !== 200) return { ok: false, error: `The homepage returned HTTP ${res.status}` };
    const re = new RegExp(`<meta[^>]+name=["']${VERIFICATION_META_NAME}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*name=["']${VERIFICATION_META_NAME}["']`, 'i');
    const m = re.exec(res.body);
    return m && (m[1] ?? m[2]) === token ? { ok: true } : { ok: false, error: 'The meta tag was not found on the homepage' };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) };
  }
}

/** Normalise user input like "https://www.Example.com/path" to "example.com". */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/^www\./, '').replace(/\.$/, '');
    if (host === 'localhost') return host;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || isIP(host)) return null;
    return host;
  } catch {
    return null;
  }
}
