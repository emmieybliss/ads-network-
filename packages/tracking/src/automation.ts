/**
 * Browser automation signals. The ad tag reports a small bitmask of what it
 * sees in the page (sdk/ad-tag/src/bn.ts keeps the same numbers); the API adds
 * what it sees in the request headers. Strong signals are definitive on their
 * own; weak ones only add to the anomaly score, because privacy tools and
 * unusual browsers can trip them too.
 */
export const CLIENT_FLAG = {
  /** navigator.webdriver is true: the browser is driven by WebDriver, Puppeteer or Playwright. */
  WEBDRIVER: 1,
  /** Globals left behind by automation tools (PhantomJS, Nightmare, Selenium, ChromeDriver). */
  AUTOMATION_GLOBALS: 2,
  /** Window with no outer size while the page is visible: typical of headless browsers. */
  HEADLESS_WINDOW: 4,
  /** A Chrome user agent without the window.chrome object that every desktop Chrome has. */
  CHROME_MISMATCH: 8,
  /** The screen reports zero width or height. */
  ZERO_SCREEN: 16,
  /** No preferred languages at all. */
  NO_LANGUAGES: 32,
  /** The click was dispatched by script (event.isTrusted is false). */
  SYNTHETIC_CLICK: 64,
  /** Mouse device, but the pointer never moved over the page before the click. */
  NO_POINTER_MOVEMENT: 128,
} as const;

const STRONG = CLIENT_FLAG.WEBDRIVER | CLIENT_FLAG.AUTOMATION_GLOBALS | CLIENT_FLAG.SYNTHETIC_CLICK;

const WEAK: Array<[number, number, string]> = [
  [CLIENT_FLAG.HEADLESS_WINDOW, 40, 'headless_window'],
  [CLIENT_FLAG.CHROME_MISMATCH, 30, 'chrome_mismatch'],
  [CLIENT_FLAG.ZERO_SCREEN, 30, 'zero_screen'],
  [CLIENT_FLAG.NO_LANGUAGES, 20, 'no_languages'],
  [CLIENT_FLAG.NO_POINTER_MOVEMENT, 25, 'no_pointer'],
];

export interface AutomationAssessment { definite: boolean; score: number; signals: string[] }

/** Request header facts the API reads for each event. */
export interface HeaderFacts { ua: string; acceptLanguage?: string | null; secFetchSite?: string | null; secChUa?: string | null }

/** Browsers that send Sec-Fetch-* on every request: Chrome/Edge 80+, Firefox 90+, Safari 16.4+. */
function sendsFetchMetadata(ua: string): boolean {
  const chrome = /(?:Chrome|CriOS|Edg)\/(\d+)/.exec(ua);
  if (chrome) return Number(chrome[1]) >= 80;
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (ff) return Number(ff[1]) >= 90;
  const safari = /Version\/(\d+)\.(\d+).*Safari\//.exec(ua);
  if (safari) return Number(safari[1]) > 16 || (Number(safari[1]) === 16 && Number(safari[2]) >= 4);
  return false;
}

export function assessAutomation(clientFlags: number | null | undefined, h: HeaderFacts | null): AutomationAssessment {
  const signals: string[] = [];
  let score = 0;
  const f = clientFlags ?? 0;
  if (f & STRONG) {
    if (f & CLIENT_FLAG.WEBDRIVER) signals.push('webdriver');
    if (f & CLIENT_FLAG.AUTOMATION_GLOBALS) signals.push('automation_globals');
    if (f & CLIENT_FLAG.SYNTHETIC_CLICK) signals.push('synthetic_click');
    return { definite: true, score: 100, signals };
  }
  for (const [bit, add, name] of WEAK) {
    if (f & bit) { score += add; signals.push(name); }
  }
  if (h) {
    if (!h.acceptLanguage) { score += 15; signals.push('no_accept_language'); }
    if (sendsFetchMetadata(h.ua) && !h.secFetchSite) { score += 20; signals.push('no_fetch_metadata'); }
  }
  return { definite: false, score: Math.min(100, score), signals };
}

/**
 * Click cadence. People click irregularly; scripts click on a timer. With at
 * least five clicks, intervals whose spread is tiny relative to their mean
 * (coefficient of variation under 0.15) look machine-made.
 */
export function roboticCadence(timestamps: readonly number[]): { robotic: boolean; cv: number | null } {
  if (timestamps.length < 5) return { robotic: false, cv: null };
  const t = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i]! - t[i - 1]!);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return { robotic: true, cv: 0 };
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const cv = sd / mean;
  return { robotic: cv < 0.15, cv };
}
