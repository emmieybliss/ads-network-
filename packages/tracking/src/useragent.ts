/** Lightweight user-agent classification. Not a fingerprint; used only for device category and crawler signals. */
const CRAWLER_RE = /(bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|outbrain|pinterest|vkshare|w3c_validator|whatsapp|lighthouse|pagespeed|headlesschrome|phantomjs|puppeteer|playwright|selenium|python-requests|python-urllib|curl\/|wget\/|go-http-client|java\/|okhttp|axios\/|node-fetch|httpclient|scrapy|apache-httpclient|libwww)/i;

export function isKnownCrawler(ua: string | undefined | null): boolean {
  if (!ua) return true;
  return CRAWLER_RE.test(ua);
}

export type DeviceCategory = 'desktop' | 'mobile' | 'tablet' | 'other';

export function deviceCategory(ua: string | undefined | null): DeviceCategory {
  if (!ua) return 'other';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/i.test(ua)) return 'mobile';
  if (/windows nt|macintosh|x11|linux|cros/i.test(ua)) return 'desktop';
  return 'other';
}
