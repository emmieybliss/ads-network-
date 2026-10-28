import { describe, expect, it } from 'vitest';
import { browserFamily, osFamily, referrerHostOf, trafficSource } from '@blissnova/tracking';
import { previousRange } from '@blissnova/api/services/analytics';

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidFacebook: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 [FBAN/EMA;FBLC/en_US;FBAV/400.0]',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  winOpera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/115.0.0.0',
};

describe('operating system and browser families', () => {
  it.each([
    ['macChrome', 'macos', 'chrome'], ['winEdge', 'windows', 'edge'], ['iphoneSafari', 'ios', 'safari'], ['iphoneChrome', 'ios', 'chrome'],
    ['androidSamsung', 'android', 'samsung'], ['androidFacebook', 'android', 'in_app'], ['linuxFirefox', 'linux', 'firefox'], ['chromebook', 'chromeos', 'chrome'],
    ['winOpera', 'windows', 'opera'],
  ] as const)('%s is %s / %s', (k, os, browser) => {
    expect(osFamily(UA[k])).toBe(os);
    expect(browserFamily(UA[k])).toBe(browser);
  });

  it('treats a missing user agent as other', () => {
    expect(osFamily('')).toBe('other');
    expect(browserFamily(undefined)).toBe('other');
  });
});

describe('traffic source', () => {
  const site = { domain: 'news.example.org', allowedDomains: ['amp.example.net'], includeSubdomains: true };
  it.each([
    [null, 'direct'], ['', 'direct'], ['https://news.example.org/a', 'internal'], ['www.news.example.org', 'internal'], ['https://m.news.example.org/', 'internal'],
    ['https://amp.example.net/x', 'internal'], ['https://www.google.co.uk/', 'search'], ['https://duckduckgo.com/', 'search'], ['https://t.co/xyz', 'social'],
    ['https://l.facebook.com/l.php', 'social'], ['https://www.reddit.com/r/x', 'social'], ['https://blog.example.com/post', 'referral'], ['not a url at all', 'direct'],
  ])('%s -> %s', (ref, expected) => {
    expect(trafficSource(referrerHostOf(ref), site)).toBe(expected);
  });

  it('does not count a look-alike domain as search', () => {
    expect(trafficSource('google.com.evil.example', site)).toBe('referral');
    expect(trafficSource('notgoogle.com', site)).toBe('referral');
  });
});

describe('comparison period', () => {
  it('is the same number of days immediately before', () => {
    expect(previousRange({ from: '2026-10-01', to: '2026-10-30' })).toEqual({ from: '2026-09-01', to: '2026-09-30', days: 30 });
    expect(previousRange({ from: '2026-10-28', to: '2026-10-28' })).toEqual({ from: '2026-10-27', to: '2026-10-27', days: 1 });
  });
});

describe('report email periods', () => {
  it('picks the latest complete day, Monday-to-Sunday week and calendar month in UTC', async () => {
    const { latestPeriod, nextSendAt } = await import('@blissnova/api/services/report-emails');
    const wed = new Date('2026-10-28T08:00:00Z');
    expect(latestPeriod('daily', wed)).toMatchObject({ from: '2026-10-27', to: '2026-10-27' });
    expect(latestPeriod('weekly', wed)).toMatchObject({ from: '2026-10-19', to: '2026-10-25' });
    expect(latestPeriod('weekly', new Date('2026-10-26T05:00:00Z'))).toMatchObject({ from: '2026-10-19', to: '2026-10-25' });
    expect(latestPeriod('monthly', wed)).toMatchObject({ from: '2026-09-01', to: '2026-09-30', label: 'September 2026' });
    expect(latestPeriod('monthly', new Date('2026-01-05T00:00:00Z'))).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    // Not sent yet: now. Already sent: 01:00 UTC on the day the next period is complete.
    expect(nextSendAt('weekly', null, wed)).toBe(wed.toISOString());
    expect(nextSendAt('weekly', '2026-10-25', wed)).toBe('2026-11-02T01:00:00.000Z');
    expect(nextSendAt('monthly', '2026-09-30', wed)).toBe('2026-11-01T01:00:00.000Z');
    expect(nextSendAt('daily', '2026-10-27', wed)).toBe('2026-10-29T01:00:00.000Z');
  });
});
