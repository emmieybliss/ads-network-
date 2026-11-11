import { describe, expect, it } from 'vitest';
import { CLIENT_FLAG, assessAutomation, assessEvent, classifyIp, ipToBigInt, isValidCidr, parseCidr, roboticCadence, DATACENTER_RANGES_SOURCES } from '@blissnova/tracking';
import { settingsSchema } from '@blissnova/shared';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const OLD_BROWSER = 'Mozilla/5.0 (Windows NT 6.1; rv:60.0) Gecko/20100101 Firefox/60.0';

describe('data-center IP ranges', () => {
  it('parses IPv4, IPv6 and IPv4-mapped addresses', () => {
    expect(ipToBigInt('1.2.3.4')).toEqual({ v6: false, value: 0x01020304n });
    expect(ipToBigInt('::ffff:1.2.3.4')).toEqual({ v6: false, value: 0x01020304n });
    expect(ipToBigInt('2001:db8::1')?.value).toBe(0x20010db8000000000000000000000001n);
    expect(ipToBigInt('[2001:db8::1]')?.v6).toBe(true);
    expect(ipToBigInt('300.1.1.1')).toBeNull();
    expect(ipToBigInt('not an ip')).toBeNull();
  });

  it('parses CIDR ranges to their network bounds', () => {
    expect(parseCidr('203.0.113.77/24')).toEqual({ v6: false, start: 0xcb007100n, end: 0xcb0071ffn });
    expect(isValidCidr('203.0.113.0/24')).toBe(true);
    expect(isValidCidr('203.0.113.0')).toBe(false);
    expect(isValidCidr('203.0.113.0/40')).toBe(false);
  });

  it('flags addresses in the bundled provider-published list', () => {
    expect(DATACENTER_RANGES_SOURCES.length).toBeGreaterThan(0);
    // Amazon S3 and EC2 ranges, IPv4 and IPv6.
    expect(classifyIp('3.5.140.2')).toBe('datacenter');
    expect(classifyIp('18.204.0.1')).toBe('datacenter');
    expect(classifyIp('2600:1f18::1')).toBe('datacenter');
  });

  it('leaves home, private and loopback addresses alone', () => {
    for (const ip of ['127.0.0.1', '192.168.1.5', '10.0.0.8', '::1', '2001:db8::1', '198.51.100.20']) expect(classifyIp(ip)).toBe('other');
  });

  it('applies staff-added ranges, and trusted ranges win over everything', () => {
    expect(classifyIp('203.0.113.9', { extra: ['203.0.113.0/24'] })).toBe('datacenter');
    expect(classifyIp('2001:db8:1::5', { extra: ['2001:db8:1::/48'] })).toBe('datacenter');
    expect(classifyIp('3.5.140.2', { trusted: ['3.5.140.0/24'] })).toBe('trusted');
    expect(classifyIp('203.0.113.9', { extra: ['203.0.113.0/24'], trusted: ['203.0.113.0/28'] })).toBe('trusted');
  });

  it('settings accept CIDR ranges and refuse anything else', () => {
    expect(settingsSchema.parse({ ivt: { extraDatacenterRanges: ['203.0.113.0/24', '2001:db8::/32'] } }).ivt.extraDatacenterRanges).toHaveLength(2);
    expect(() => settingsSchema.parse({ ivt: { extraDatacenterRanges: ['example.com'] } })).toThrow();
    expect(() => settingsSchema.parse({ ivt: { trustedRanges: ['1.2.3.4'] } })).toThrow();
  });
});

describe('browser automation signals', () => {
  const headers = { ua: CHROME, acceptLanguage: 'en-GB,en;q=0.9', secFetchSite: 'cross-site' };

  it('treats WebDriver, automation tools and script clicks as definite', () => {
    for (const f of [CLIENT_FLAG.WEBDRIVER, CLIENT_FLAG.AUTOMATION_GLOBALS, CLIENT_FLAG.SYNTHETIC_CLICK]) {
      const a = assessAutomation(f, headers);
      expect(a.definite).toBe(true);
      expect(a.score).toBe(100);
    }
  });

  it('adds weak signals to a score instead of condemning on one', () => {
    expect(assessAutomation(0, headers)).toEqual({ definite: false, score: 0, signals: [] });
    const one = assessAutomation(CLIENT_FLAG.NO_LANGUAGES, headers);
    expect(one.definite).toBe(false);
    expect(one.score).toBe(20);
    const many = assessAutomation(CLIENT_FLAG.HEADLESS_WINDOW | CLIENT_FLAG.CHROME_MISMATCH | CLIENT_FLAG.ZERO_SCREEN, headers);
    expect(many.score).toBe(100);
    expect(many.signals).toEqual(['headless_window', 'chrome_mismatch', 'zero_screen']);
  });

  it('notices browser headers a modern browser always sends', () => {
    const a = assessAutomation(null, { ua: CHROME, acceptLanguage: null, secFetchSite: null });
    expect(a.signals).toEqual(['no_accept_language', 'no_fetch_metadata']);
    expect(a.score).toBe(35);
    // Old browsers never sent fetch metadata, so its absence means nothing there.
    expect(assessAutomation(null, { ua: OLD_BROWSER, acceptLanguage: 'en', secFetchSite: null }).score).toBe(0);
  });

  it('recognises clicks on a timer, not human ones', () => {
    const t0 = 1_700_000_000_000;
    expect(roboticCadence([t0, t0 + 10_000, t0 + 20_000, t0 + 30_000, t0 + 40_000]).robotic).toBe(true);
    expect(roboticCadence([t0, t0 + 10_050, t0 + 19_980, t0 + 30_010, t0 + 40_000, t0 + 50_020]).robotic).toBe(true);
    expect(roboticCadence([t0, t0 + 4_000, t0 + 31_000, t0 + 38_000, t0 + 95_000]).robotic).toBe(false);
    expect(roboticCadence([t0, t0 + 10_000, t0 + 20_000]).robotic).toBe(false); // too few to say
  });
});

describe('event assessment with the new signals', () => {
  it('marks data-center, automated and robotic traffic invalid with their own reasons', () => {
    expect(assessEvent({ datacenter: true }, 60)).toMatchObject({ valid: false, reason: 'datacenter' });
    expect(assessEvent({ automation: true }, 60)).toMatchObject({ valid: false, reason: 'automation' });
    expect(assessEvent({ roboticClicks: true }, 60)).toMatchObject({ valid: false, reason: 'click_pattern' });
  });

  it('counts clicks per network as well as per visitor', () => {
    const r = assessEvent({ ipClicksLastHour: 31, maxClicksPerIpPerHour: 30, missingReferrer: true }, 60);
    expect(r).toMatchObject({ valid: false, reason: 'click_burst' });
    expect(assessEvent({ ipClicksLastHour: 30, maxClicksPerIpPerHour: 30 }, 60).valid).toBe(true);
  });

  it('lets weak automation evidence tip an already doubtful event', () => {
    expect(assessEvent({ automationScore: 35, automationSignals: ['no_accept_language', 'no_fetch_metadata'] }, 60).valid).toBe(true);
    const r = assessEvent({ automationScore: 35, automationSignals: ['no_accept_language', 'no_fetch_metadata'], renderToClickMs: 100, minRenderToClickMs: 300 }, 60);
    expect(r.valid).toBe(false);
    expect(r.signals).toContain('no_fetch_metadata');
  });

  it('a click on an ad that was never viewable is only a weak sign', () => {
    const r = assessEvent({ clickWithoutViewable: true }, 60);
    expect(r).toMatchObject({ valid: true, score: 15 });
    expect(r.signals).toEqual(['click_not_viewable']);
  });
});
