import { createHmac } from 'node:crypto';

/**
 * Privacy-conscious identifiers. Raw IP addresses and visitor ids are never
 * stored. IP hashes use a daily salt so they cannot be joined across days;
 * visitor hashes are stable only for visitors who allowed personalization.
 */
export function ipHash(secret: string, ip: string, day = new Date().toISOString().slice(0, 10)): string {
  return createHmac('sha256', secret).update(`ip|${day}|${ip}`).digest('base64url').slice(0, 22);
}

export function visitorHash(secret: string, visitorId: string): string {
  return createHmac('sha256', secret).update(`v|${visitorId}`).digest('base64url').slice(0, 22);
}

export function uaHash(secret: string, ua: string): string {
  return createHmac('sha256', secret).update(`ua|${ua}`).digest('base64url').slice(0, 16);
}

/** Normalise a hostname for domain authorization checks. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '').replace(/:\d+$/, '');
}

/** True if `host` is the site domain, one of its subdomains, or an explicitly allowed domain. */
export function hostAuthorized(host: string, siteDomain: string, allowed: readonly string[] = []): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const d of [siteDomain, ...allowed].map(normalizeHost)) {
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}
