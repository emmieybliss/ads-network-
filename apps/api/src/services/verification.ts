import { Resolver } from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import type { AppConfig } from '../config';

/**
 * Automatic domain verification.
 *
 * A challenge proves control of one hostname. It never approves a site: that
 * is a separate review. Three proofs are supported:
 *
 *  - DNS TXT at _blissnova-verification.<host>   (covers subdomains when policy allows)
 *  - a text file at /.well-known/blissnova-verification.txt  (that host only)
 *  - a meta tag in the homepage <head>                       (that host only)
 *
 * Every outbound HTTP request goes through safeFetch, which refuses private
 * and reserved addresses at connection time (so DNS rebinding between the
 * check and the connect does not help), validates every redirect, and bounds
 * time and size.
 */

export type VerificationMethod = 'dns_txt' | 'html_file' | 'meta_tag';
export const VERIFICATION_METHODS: VerificationMethod[] = ['dns_txt', 'html_file', 'meta_tag'];
export const VERIFICATION_META_NAME = 'blissnova-site-verification';
export const VERIFICATION_FILE_PATH = '/.well-known/blissnova-verification.txt';
export const VERIFICATION_TXT_LABEL = '_blissnova-verification';
export const VERIFICATION_TXT_PREFIX = 'blissnova-verification=';

/** 192 bits of randomness; base64url so it is safe in DNS, files and attributes. */
export function newVerificationToken(): string {
  return `bnv_${randomBytes(24).toString('base64url')}`;
}

export function txtRecordName(host: string): string {
  return `${VERIFICATION_TXT_LABEL}.${host}`;
}

export function verificationInstructions(host: string, token: string) {
  return {
    dns_txt: {
      label: 'DNS TXT record',
      recordType: 'TXT',
      recordName: txtRecordName(host),
      value: `${VERIFICATION_TXT_PREFIX}${token}`,
      instructions: `At your DNS provider, add a TXT record named ${txtRecordName(host)} with the value below. DNS changes can take from a few minutes to 48 hours to appear; you can check again at any time.`,
    },
    html_file: {
      label: 'Verification file',
      path: VERIFICATION_FILE_PATH,
      url: `https://${host}${VERIFICATION_FILE_PATH}`,
      value: token,
      instructions: `Create a plain-text file at https://${host}${VERIFICATION_FILE_PATH} whose only content is the value below. It must be served directly (redirects to another host are refused).`,
    },
    meta_tag: {
      label: 'HTML meta tag',
      value: `<meta name="${VERIFICATION_META_NAME}" content="${token}">`,
      instructions: `Add this tag inside the <head> of the page at https://${host}/ and publish the change.`,
    },
  };
}

// ---------------------------------------------------------------- hostnames

const RESERVED_SUFFIXES = ['localhost', 'test', 'example', 'invalid', 'local', 'internal', 'home.arpa', 'example.com', 'example.net', 'example.org'];

/**
 * Names that can never belong to a real publisher on the public internet
 * (RFC 2606, RFC 6761, RFC 6762, RFC 8375). The development simulator may only
 * touch these, so it can never vouch for a domain someone could actually own.
 */
export function isReservedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return RESERVED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Normalise user input like "https://www.Example.com/path" to "example.com". */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    const host = u.hostname.replace(/^www\./, '').replace(/\.$/, '');
    if (host === 'localhost') return host;
    if (host.length > 253 || isIP(host.replace(/^\[|\]$/g, ''))) return null;
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Whether a proof for `siteHost` with the given scope covers `candidate`.
 * 'host' covers the name and its www. form; 'zone' also covers subdomains.
 */
export function hostCovered(siteHost: string, scope: 'host' | 'zone' | null, candidate: string): boolean {
  if (candidate === siteHost || candidate === `www.${siteHost}`) return true;
  return scope === 'zone' && candidate.endsWith(`.${siteHost}`);
}

// ---------------------------------------------------------------- addresses

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, documentation, multicast and reserved ranges, IPv4 and IPv6. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (kind !== 6) return true;
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (v.startsWith('::ffff:')) return true;
  // fc00::/7 unique-local (incl. fd00:ec2::254 metadata), fe80::/10 link-local, ff00::/8 multicast,
  // 64:ff9b::/96 NAT64, 2001:db8::/32 documentation, 2002::/16 6to4, 100::/64 discard.
  return /^(fc|fd|fe[89ab]|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8:') || v.startsWith('2002:') || v.startsWith('100::');
}

// ---------------------------------------------------------------- safe fetch

export interface SafeFetchOptions {
  /** Hostnames a redirect may lead to. Anything else is refused. */
  allowedHosts: string[];
  allowHttp: boolean;
  /** Hosts that may resolve to private addresses (development only). */
  privateAllowlist: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  status: number;
  body: string;
  contentType: string;
  finalUrl: string;
  redirects: string[];
  address?: string;
}

export class FetchBlockedError extends Error {}

function vetUrl(raw: string, opts: SafeFetchOptions): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError('The address could not be parsed');
  }
  if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) throw new FetchBlockedError('Only HTTPS addresses can be checked');
  if (u.username || u.password) throw new FetchBlockedError('Addresses with credentials are refused');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !opts.privateAllowlist.includes(host)) throw new FetchBlockedError('IP addresses cannot be verified; use the hostname');
  if (u.port && !opts.allowHttp && u.port !== '443') throw new FetchBlockedError('Only the standard HTTPS port can be checked');
  if (!opts.allowedHosts.includes(u.hostname)) throw new FetchBlockedError(`Requests to ${u.hostname} are not part of this verification`);
  return u;
}

function oneRequest(u: URL, opts: SafeFetchOptions, deadline: number): Promise<{ res: IncomingMessage; address?: string; body: Buffer }> {
  const allowPrivate = opts.privateAllowlist.includes(u.hostname);
  const lookup: LookupFunction = (hostname, options, cb) => {
    dnsLookup(hostname, { all: true }).then((addrs) => {
      const ok = addrs.filter((a) => allowPrivate || !isPrivateAddress(a.address));
      if (ok.length === 0) return cb(new FetchBlockedError('The host resolves only to private or reserved addresses'), '', 4);
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof ok) => void)(null, ok);
      cb(null, ok[0]!.address, ok[0]!.family);
    }, (err) => cb(err, '', 4));
  };
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const maxBytes = opts.maxBytes ?? 512_000;
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const r = req(u, {
      method: 'GET', lookup, timeout: remaining,
      headers: { 'user-agent': 'BlissNova-Verification/1.0 (+domain ownership check)', accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          // Reject first, then tear the connection down without an error event nobody is listening for.
          reject(new FetchBlockedError('The response was larger than allowed'));
          res.destroy();
          r.destroy();
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ res, address: (res.socket as Socket | null)?.remoteAddress, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    // Belt and braces: whatever the resolver said, check the address the socket actually connected to.
    r.on('socket', (sock: Socket) => {
      sock.once('connect', () => {
        const addr = sock.remoteAddress;
        if (addr && !allowPrivate && isPrivateAddress(addr)) r.destroy(new FetchBlockedError('Connected address is private or reserved'));
      });
    });
    const timer = setTimeout(() => r.destroy(new Error('The request timed out')), remaining);
    r.on('close', () => clearTimeout(timer));
    r.on('timeout', () => r.destroy(new Error('The request timed out')));
    r.on('error', reject);
    r.end();
  });
}

/**
 * GET with SSRF protection. Redirects are followed only to hosts in
 * opts.allowedHosts, never from https to http, and at most maxRedirects times;
 * each hop is re-validated and re-resolved.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 6000);
  const redirects: string[] = [];
  let current = vetUrl(url, opts);
  for (let hop = 0; ; hop++) {
    const { res, address, body } = await oneRequest(current, opts, deadline);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      if (hop >= (opts.maxRedirects ?? 3)) throw new FetchBlockedError('Too many redirects');
      const next = vetUrl(new URL(res.headers.location, current).toString(), opts);
      if (current.protocol === 'https:' && next.protocol === 'http:') throw new FetchBlockedError('Redirects from HTTPS to HTTP are refused');
      redirects.push(next.toString());
      current = next;
      continue;
    }
    return { status, body: body.toString('utf8'), contentType: String(res.headers['content-type'] ?? ''), finalUrl: current.toString(), redirects, address };
  }
}

// ---------------------------------------------------------------- HTML

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos' || k === '#39') return "'";
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

/**
 * The content values of every <meta name="..."> with the given name in the
 * document head. Comments, scripts and the body are ignored, so a token pasted
 * into an article or a commented-out tag does not count.
 */
export function metaContents(html: string, name: string): string[] {
  let head = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');
  const bodyAt = head.search(/<body\b/i);
  const headEnd = head.search(/<\/head\s*>/i);
  const cut = [bodyAt, headEnd].filter((i) => i >= 0);
  if (cut.length) head = head.slice(0, Math.min(...cut));
  const out: string[] = [];
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
    let m: RegExpExecArray | null;
    re.lastIndex = 5; // skip "<meta"
    while ((m = re.exec(tag))) attrs[m[1]!.toLowerCase()] ??= decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if ((attrs.name ?? '').trim().toLowerCase() === name && attrs.content !== undefined) out.push(attrs.content.trim());
  }
  return out;
}

// ---------------------------------------------------------------- checks

export type CheckOutcome = 'success' | 'not_found' | 'mismatch' | 'error' | 'blocked';
export interface CheckResult {
  ok: boolean;
  outcome: CheckOutcome;
  /** A message the publisher can act on. */
  detail: string;
  /** Observations kept for the audit trail. Never page content. */
  evidence: Record<string, unknown>;
}

export function createResolver(cfg: Pick<AppConfig, 'VERIFICATION_DNS_SERVERS'>): Resolver {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  const servers = cfg.VERIFICATION_DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (servers.length) r.setServers(servers);
  return r;
}

export interface CheckDeps {
  resolver?: Pick<Resolver, 'resolveTxt'>;
  fetch?: typeof safeFetch;
}

export async function checkVerification(
  method: VerificationMethod,
  host: string,
  token: string,
  cfg: Pick<AppConfig, 'VERIFICATION_ALLOW_HTTP' | 'VERIFICATION_PRIVATE_HOST_ALLOWLIST' | 'VERIFICATION_DNS_SERVERS' | 'isProd'>,
  deps: CheckDeps = {},
): Promise<CheckResult> {
  const fail = (outcome: CheckOutcome, detail: string, evidence: Record<string, unknown> = {}): CheckResult => ({ ok: false, outcome, detail, evidence });
  try {
    if (method === 'dns_txt') {
      const name = txtRecordName(host);
      const resolver = deps.resolver ?? createResolver(cfg);
      let records: string[];
      try {
        records = (await resolver.resolveTxt(name)).map((r) => r.join('').trim());
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(code)) return fail('not_found', `No TXT record exists at ${name} yet. If you just added it, DNS may still be propagating; try again later.`, { recordName: name, code });
        return fail('error', `The DNS lookup failed (${code || 'unknown error'}). Try again in a few minutes.`, { recordName: name, code });
      }
      const ours = records.filter((r) => r.startsWith(VERIFICATION_TXT_PREFIX));
      if (ours.some((r) => r === `${VERIFICATION_TXT_PREFIX}${token}`)) return { ok: true, outcome: 'success', detail: 'TXT record found', evidence: { recordName: name, records: records.length } };
      if (ours.length) return fail('mismatch', `A BlissNova TXT record exists at ${name} but its value does not match this challenge. Replace it with the current value.`, { recordName: name, records: records.length });
      return fail('not_found', `TXT records exist at ${name}, but none contains the verification value.`, { recordName: name, records: records.length });
    }

    // Plain HTTP is only ever used for reserved development names when the override is on.
    const scheme = cfg.VERIFICATION_ALLOW_HTTP && !cfg.isProd && isReservedHostname(host) ? 'http' : 'https';
    const fetchOpts: SafeFetchOptions = {
      allowedHosts: [host, `www.${host}`],
      allowHttp: cfg.VERIFICATION_ALLOW_HTTP && !cfg.isProd,
      privateAllowlist: cfg.isProd ? [] : cfg.VERIFICATION_PRIVATE_HOST_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean),
      maxBytes: method === 'html_file' ? 4096 : 512_000,
    };
    const doFetch = deps.fetch ?? safeFetch;

    if (method === 'html_file') {
      const res = await doFetch(`${scheme}://${host}${VERIFICATION_FILE_PATH}`, fetchOpts);
      const ev = { status: res.status, contentType: res.contentType.slice(0, 80), redirects: res.redirects.length, bytes: res.body.length };
      if (res.status === 404) return fail('not_found', `${VERIFICATION_FILE_PATH} was not found on ${host} (HTTP 404).`, ev);
      if (res.status !== 200) return fail('error', `The verification file returned HTTP ${res.status}.`, ev);
      if (/html/i.test(res.contentType) || /<html|<body/i.test(res.body)) return fail('mismatch', 'The address returned a web page, not the verification file. Upload a plain-text file containing only the token.', ev);
      return res.body.trim() === token ? { ok: true, outcome: 'success', detail: 'Verification file found', evidence: ev } : fail('mismatch', 'The file exists but its content does not match this challenge.', ev);
    }

    const res = await doFetch(`${scheme}://${host}/`, fetchOpts);
    const ev = { status: res.status, contentType: res.contentType.slice(0, 80), redirects: res.redirects.length, bytes: res.body.length };
    if (res.status !== 200) return fail('error', `The homepage returned HTTP ${res.status}.`, ev);
    const found = metaContents(res.body, VERIFICATION_META_NAME);
    if (found.includes(token)) return { ok: true, outcome: 'success', detail: 'Meta tag found', evidence: { ...ev, tags: found.length } };
    if (found.length) return fail('mismatch', 'A BlissNova meta tag is on the homepage but its content does not match this challenge.', { ...ev, tags: found.length });
    return fail('not_found', `No ${VERIFICATION_META_NAME} meta tag was found in the <head> of https://${host}/.`, ev);
  } catch (err) {
    if (err instanceof FetchBlockedError) return fail('blocked', err.message, {});
    return fail('error', (err as Error).message.slice(0, 300), {});
  }
}
