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

export type OsFamily = 'windows' | 'macos' | 'ios' | 'android' | 'linux' | 'chromeos' | 'other';

/** Operating system family, for reports only. Order matters: iPadOS and Android user agents also mention desktop systems. */
export function osFamily(ua: string | undefined | null): OsFamily {
  if (!ua) return 'other';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  if (/cros/i.test(ua)) return 'chromeos';
  if (/windows/i.test(ua)) return 'windows';
  if (/mac os x|macintosh/i.test(ua)) return 'macos';
  if (/linux|x11/i.test(ua)) return 'linux';
  return 'other';
}

export type BrowserFamily = 'chrome' | 'safari' | 'firefox' | 'edge' | 'samsung' | 'opera' | 'in_app' | 'other';

/** Browser family, for reports only. Brands built on Chromium identify themselves before the Chrome token, so check them first. */
export function browserFamily(ua: string | undefined | null): BrowserFamily {
  if (!ua) return 'other';
  if (/FBAN|FBAV|Instagram|Line\/|; wv\)|GSA\//.test(ua)) return 'in_app';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Firefox\/|FxiOS/.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS|Chromium/.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}
