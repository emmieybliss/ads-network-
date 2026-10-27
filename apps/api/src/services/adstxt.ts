/**
 * ads.txt and sellers.json (IAB Tech Lab). A publisher adds one line to
 * https://its-domain/ads.txt declaring the network as a DIRECT seller of its
 * inventory, with its seller id; buyers cross-check the id against the
 * network's public /sellers.json.
 */
import type { AppConfig } from '../config';
import { FetchBlockedError, isReservedHostname, safeFetch, type SafeFetchOptions } from './verification';

export type AdsTxtStatus = 'unchecked' | 'found' | 'missing' | 'mismatch' | 'error';

/** The network's own domain as it appears in ads.txt lines and sellers.json. */
export function networkDomain(cfg: Pick<AppConfig, 'ADS_TXT_DOMAIN' | 'PUBLIC_SITE_URL'>): string {
  return cfg.ADS_TXT_DOMAIN || new URL(cfg.PUBLIC_SITE_URL).hostname.toLowerCase();
}

/** A publisher's seller id is its organization id: stable, unique and already public in reports. */
export function adsTxtLine(domain: string, sellerId: string): string {
  return `${domain}, ${sellerId}, DIRECT`;
}

export interface AdsTxtRecord { domain: string; accountId: string; relationship: string }

/** Data records of an ads.txt file. Comments, blank lines and variables (contact=, subdomain=…) are skipped. */
export function parseAdsTxt(body: string): AdsTxtRecord[] {
  const out: AdsTxtRecord[] = [];
  for (const raw of body.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.split('#')[0]!.trim();
    if (!line || !line.includes(',')) continue;
    const [domain, accountId, relationship] = line.split(',').map((f) => f.trim());
    if (!domain || !accountId || !relationship) continue;
    out.push({ domain: domain.toLowerCase(), accountId, relationship: relationship.toUpperCase() });
  }
  return out;
}

export interface AdsTxtCheck { status: Exclude<AdsTxtStatus, 'unchecked'>; detail: string }

/** Compares the site's ads.txt with the expected line. Pure, so it is easy to test. */
export function matchAdsTxt(records: AdsTxtRecord[], domain: string, sellerId: string): AdsTxtCheck {
  const ours = records.filter((r) => r.domain === domain);
  const exact = ours.filter((r) => r.accountId === sellerId);
  if (exact.some((r) => r.relationship === 'DIRECT')) return { status: 'found', detail: 'The BlissNova line is in ads.txt.' };
  if (exact.length) return { status: 'mismatch', detail: `The line for ${domain} says ${exact[0]!.relationship}. It must say DIRECT.` };
  if (ours.length) return { status: 'mismatch', detail: `ads.txt lists ${domain} with a different seller id. Replace it with the line shown here.` };
  return { status: 'missing', detail: `ads.txt was found but has no line for ${domain}.` };
}

export async function checkAdsTxt(
  host: string,
  domain: string,
  sellerId: string,
  cfg: Pick<AppConfig, 'VERIFICATION_ALLOW_HTTP' | 'VERIFICATION_PRIVATE_HOST_ALLOWLIST' | 'isProd'>,
  doFetch: typeof safeFetch = safeFetch,
): Promise<AdsTxtCheck> {
  const scheme = cfg.VERIFICATION_ALLOW_HTTP && !cfg.isProd && isReservedHostname(host) ? 'http' : 'https';
  const opts: SafeFetchOptions = {
    allowedHosts: [host, `www.${host}`],
    allowHttp: cfg.VERIFICATION_ALLOW_HTTP && !cfg.isProd,
    privateAllowlist: cfg.isProd ? [] : cfg.VERIFICATION_PRIVATE_HOST_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean),
    maxBytes: 1_000_000,
  };
  try {
    const res = await doFetch(`${scheme}://${host}/ads.txt`, opts);
    if (res.status === 404) return { status: 'missing', detail: `There is no ads.txt at ${scheme}://${host}/ads.txt (HTTP 404).` };
    if (res.status !== 200) return { status: 'error', detail: `${host}/ads.txt returned HTTP ${res.status}.` };
    if (/html/i.test(res.contentType) || /<html|<body/i.test(res.body)) return { status: 'error', detail: 'The address returned a web page, not a plain-text ads.txt file.' };
    return matchAdsTxt(parseAdsTxt(res.body), domain, sellerId);
  } catch (err) {
    if (err instanceof FetchBlockedError) return { status: 'error', detail: err.message.slice(0, 300) };
    return { status: 'error', detail: (err as Error).message.slice(0, 300) };
  }
}
