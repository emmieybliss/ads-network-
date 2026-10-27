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

/**
 * True if `host` may display ads for a site: the site domain (with or without
 * www.), an explicitly allowed hostname, or, only when the ownership proof
 * covers them (`includeSubdomains`, a DNS proof), subdomains of the site domain.
 */
export function hostAuthorized(host: string, siteDomain: string, allowed: readonly string[] = [], includeSubdomains = true): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  const main = normalizeHost(siteDomain);
  if (h === main || (includeSubdomains && h.endsWith(`.${main}`))) return true;
  return allowed.map(normalizeHost).some((d) => d !== '' && h === d);
}
