import { hostAuthorized, normalizeHost } from './hashing';

/**
 * Traffic source of a page view, from the referring host only (the ad tag
 * never sends the full referring URL):
 *   direct    no referrer (typed address, bookmark, app, or a stripped referrer)
 *   internal  another page of the same site
 *   search    a search engine
 *   social    a social network or messaging app
 *   referral  any other site
 */
export type TrafficSource = 'direct' | 'internal' | 'search' | 'social' | 'referral';

// Country domains: example.com, example.de, example.co.uk, example.com.br.
const TLD = String.raw`(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})`;
const SEARCH = new RegExp(String.raw`(^|\.)(google\.${TLD}|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.${TLD}|yandex\.${TLD}|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com|naver\.com|seznam\.cz|ask\.com|aol\.com)$`);
const SOCIAL = new RegExp(String.raw`(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|pinterest\.${TLD}|pin\.it|reddit\.com|tiktok\.com|youtube\.com|youtu\.be|whatsapp\.com|wa\.me|telegram\.org|t\.me|threads\.net|bsky\.app|snapchat\.com|quora\.com|tumblr\.com|vk\.com|discord\.com|news\.ycombinator\.com|flipboard\.com)$`);

export function trafficSource(referrerHost: string | null | undefined, site: { domain: string; allowedDomains?: readonly string[]; includeSubdomains?: boolean }): TrafficSource {
  const h = referrerHost ? normalizeHost(referrerHost) : '';
  if (!h) return 'direct';
  if (hostAuthorized(h, site.domain, site.allowedDomains ?? [], site.includeSubdomains ?? true)) return 'internal';
  if (SEARCH.test(h)) return 'search';
  if (SOCIAL.test(h)) return 'social';
  return 'referral';
}

/** The hostname of a referrer value (a URL or a bare host), or null. */
export function referrerHostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  try {
    return normalizeHost(new URL(v.includes('://') ? v : `https://${v}`).hostname) || null;
  } catch {
    return null;
  }
}
