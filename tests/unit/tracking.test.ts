import { describe, expect, it } from 'vitest';
import {
  assessEvent,
  deviceCategory,
  generateTokenKey,
  hostAuthorized,
  ipHash,
  isKnownCrawler,
  normalizeHost,
  parseKeyring,
  signDeliveryToken,
  uaHash,
  verifyDeliveryToken,
  visitorHash,
  type DeliveryClaims,
} from '@blissnova/tracking';

const SECRET = 'a-test-secret-of-at-least-32-characters';

function ring(spec?: string) {
  return parseKeyring(spec ?? `k1:${generateTokenKey()}`);
}

function claims(over: Partial<DeliveryClaims> = {}): DeliveryClaims {
  const now = Date.now();
  return {
    d: '11111111-1111-4111-8111-111111111111',
    c: 'camp-1',
    cr: 'cr-1',
    ao: 'adv-1',
    s: 'site-1',
    u: 'unit-1',
    po: 'pub-1',
    pm: 'cpm',
    r: '2500000',
    cur: 'USD',
    sh: 7000,
    ph: 'example.org',
    co: 'US',
    dv: 'desktop',
    ct: true,
    iat: now,
    exp: now + 60_000,
    ...over,
  };
}

describe('delivery tokens', () => {
  it('round-trips every claim, including the rate as a string', () => {
    const r = ring();
    const c = claims({ r: '9007199254740993' }); // larger than Number.MAX_SAFE_INTEGER
    const res = verifyDeliveryToken(r, signDeliveryToken(r, c));
    expect(res.ok).toBe(true);
    expect(res.claims).toEqual(c);
    expect(res.claims!.r).toBe('9007199254740993');
  });

  it('does not expose campaign or pricing details in the token text', () => {
    const r = ring();
    const token = signDeliveryToken(r, claims({ c: 'secret-campaign-name' }));
    expect(token).not.toContain('secret-campaign-name');
    expect(token).not.toContain('2500000');
    expect(token).not.toContain('cpm');
  });

  it('rejects a token whose ciphertext was tampered with', () => {
    const r = ring();
    const token = signDeliveryToken(r, claims());
    const [kid, payload] = token.split('.');
    const bytes = Buffer.from(payload!, 'base64url');
    bytes[20] = bytes[20]! ^ 0xff;
    const res = verifyDeliveryToken(r, `${kid}.${bytes.toString('base64url')}`);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('token_invalid');
  });

  it('rejects a token re-labelled with a different key id', () => {
    const k1 = generateTokenKey();
    const k2 = generateTokenKey();
    const r = parseKeyring(`k1:${k1},k2:${k2}`);
    const token = signDeliveryToken(r, claims());
    const swapped = `k2.${token.split('.')[1]}`;
    // The key id is authenticated as additional data, so this cannot verify.
    expect(verifyDeliveryToken(r, swapped).ok).toBe(false);
  });

  it('rejects a token signed with a key that is not in the ring', () => {
    const token = signDeliveryToken(ring(`k1:${generateTokenKey()}`), claims());
    expect(verifyDeliveryToken(ring(`k1:${generateTokenKey()}`), token).ok).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    const r = ring();
    for (const bad of ['', '.', 'k1', 'k1.', 'k1.!!!!', 'no-dot', 'k1.AAAA', 'x'.repeat(5000)]) {
      const res = verifyDeliveryToken(r, bad);
      expect(res.ok, JSON.stringify(bad.slice(0, 20))).toBe(false);
    }
  });

  it('reports expiry separately from invalidity, and still returns the claims', () => {
    const r = ring();
    const now = Date.now();
    const token = signDeliveryToken(r, claims({ iat: now - 10_000, exp: now - 5_000 }));
    const res = verifyDeliveryToken(r, token, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('token_expired');
    // The click route needs the claims of an expired token to record the event.
    expect(res.claims?.c).toBe('camp-1');
  });

  it('accepts an expired token inside an explicit grace window', () => {
    const r = ring();
    const now = Date.now();
    const token = signDeliveryToken(r, claims({ exp: now - 1000 }));
    expect(verifyDeliveryToken(r, token, now, 0).ok).toBe(false);
    expect(verifyDeliveryToken(r, token, now, 60_000).ok).toBe(true);
  });

  describe('key rotation', () => {
    it('signs with the first key and still verifies the older ones', () => {
      const old = generateTokenKey();
      const fresh = generateTokenKey();
      const before = parseKeyring(`k1:${old}`);
      const inFlight = signDeliveryToken(before, claims());

      const after = parseKeyring(`k2:${fresh},k1:${old}`);
      expect(after.activeKid).toBe('k2');
      // Tokens issued before the rotation keep working.
      expect(verifyDeliveryToken(after, inFlight).ok).toBe(true);
      // New tokens carry the new key id.
      expect(signDeliveryToken(after, claims()).startsWith('k2.')).toBe(true);
    });

    it('refuses a key ring that is empty or malformed', () => {
      for (const bad of ['', 'nokey', 'k1:', ':abc', 'k1:not-base64-32-bytes']) {
        expect(() => parseKeyring(bad), bad).toThrow();
      }
    });
  });
});

describe('pseudonymous hashing', () => {
  it('never returns the input', () => {
    expect(ipHash(SECRET, '203.0.113.9')).not.toContain('203.0.113');
    expect(visitorHash(SECRET, 'visitor-abc')).not.toContain('visitor-abc');
  });

  it('is stable for the same input on the same day', () => {
    expect(ipHash(SECRET, '203.0.113.9', '2026-06-15')).toBe(ipHash(SECRET, '203.0.113.9', '2026-06-15'));
  });

  it('rotates the IP salt daily, so hashes cannot be joined across days', () => {
    expect(ipHash(SECRET, '203.0.113.9', '2026-06-15')).not.toBe(ipHash(SECRET, '203.0.113.9', '2026-06-16'));
  });

  it('is keyed by the application secret, so hashes are useless to anyone else', () => {
    expect(ipHash('another-secret-of-at-least-32-characters', '203.0.113.9', '2026-06-15')).not.toBe(ipHash(SECRET, '203.0.113.9', '2026-06-15'));
  });

  it('keeps a visitor hash stable across days (it is consented, not rotated)', () => {
    expect(visitorHash(SECRET, 'v1')).toBe(visitorHash(SECRET, 'v1'));
    expect(visitorHash(SECRET, 'v1')).not.toBe(visitorHash(SECRET, 'v2'));
  });

  it('hashes user agents rather than storing them verbatim', () => {
    expect(uaHash(SECRET, 'Mozilla/5.0 something')).not.toContain('Mozilla');
    expect(uaHash(SECRET, 'a')).toHaveLength(16);
  });
});

describe('domain authorization', () => {
  it('normalises hosts the way publishers write them', () => {
    expect(normalizeHost('WWW.Example.ORG')).toBe('example.org');
    expect(normalizeHost('example.org.')).toBe('example.org');
    expect(normalizeHost('example.org:8080')).toBe('example.org');
    expect(normalizeHost('  example.org ')).toBe('example.org');
  });

  it('allows the site domain and its subdomains', () => {
    expect(hostAuthorized('example.org', 'example.org')).toBe(true);
    expect(hostAuthorized('news.example.org', 'example.org')).toBe(true);
    expect(hostAuthorized('www.example.org', 'example.org')).toBe(true);
  });

  it('allows additional registered domains', () => {
    expect(hostAuthorized('other.test', 'example.org', ['other.test'])).toBe(true);
  });

  it('refuses a lookalike domain that merely ends with the site domain', () => {
    // "notexample.org" must not pass as a subdomain of "example.org".
    expect(hostAuthorized('notexample.org', 'example.org')).toBe(false);
    expect(hostAuthorized('example.org.attacker.test', 'example.org')).toBe(false);
  });

  it('refuses an empty host', () => {
    expect(hostAuthorized('', 'example.org')).toBe(false);
  });
});

describe('user-agent classification', () => {
  it('treats a missing user agent as a crawler', () => {
    // An ad request with no user agent is not a browser we should bill for.
    expect(isKnownCrawler(undefined)).toBe(true);
    expect(isKnownCrawler('')).toBe(true);
  });

  it('recognises common bots, tools and headless browsers', () => {
    for (const ua of ['Googlebot/2.1', 'curl/8.4.0', 'python-requests/2.31', 'HeadlessChrome/120', 'facebookexternalhit/1.1', 'Mozilla/5.0 ... PhantomJS']) {
      expect(isKnownCrawler(ua), ua).toBe(true);
    }
  });

  it('does not flag ordinary browsers', () => {
    for (const ua of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ]) {
      expect(isKnownCrawler(ua), ua).toBe(false);
    }
  });

  it('classifies device categories', () => {
    expect(deviceCategory('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(deviceCategory('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceCategory('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop');
    expect(deviceCategory('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('mobile');
    expect(deviceCategory('Mozilla/5.0 (Linux; Android 14; Tab) Safari')).toBe('tablet');
    expect(deviceCategory(undefined)).toBe('other');
  });
});

describe('invalid-traffic assessment', () => {
  const THRESHOLD = 60;

  it('passes an unremarkable event', () => {
    const r = assessEvent({ ipRequestsPerMinute: 3, maxRequestsPerMinute: 60 }, THRESHOLD);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.score).toBe(0);
  });

  it('fails immediately on a hard signal, whatever the threshold', () => {
    const hard: Array<[keyof Parameters<typeof assessEvent>[0], string]> = [
      ['trackingDisabled', 'tracking_disabled'],
      ['tokenInvalid', 'token_invalid'],
      ['tokenExpired', 'token_expired'],
      ['duplicate', 'duplicate'],
      ['replay', 'replay'],
      ['siteInactive', 'site_inactive'],
      ['domainMismatch', 'domain_mismatch'],
      ['crawler', 'crawler'],
      ['sequenceViolation', 'sequence'],
    ];
    for (const [signal, reason] of hard) {
      const r = assessEvent({ [signal]: true }, 100);
      expect(r.valid, String(signal)).toBe(false);
      expect(r.reason, String(signal)).toBe(reason);
    }
  });

  it('does not condemn traffic on one weak signal alone', () => {
    // A missing referrer is suspicious but ordinary (privacy settings, apps).
    const r = assessEvent({ missingReferrer: true }, THRESHOLD);
    expect(r.valid).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.signals).toContain('no_referrer');
  });

  it('accumulates weak signals until they cross the threshold', () => {
    const r = assessEvent(
      { missingReferrer: true, renderToClickMs: 10, minRenderToClickMs: 500, tokenAgeMs: 10 },
      THRESHOLD,
    );
    expect(r.valid).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(r.reason).toBe('click_too_fast');
  });

  it('flags a click that arrives impossibly soon after the render', () => {
    const r = assessEvent({ renderToClickMs: 5, minRenderToClickMs: 500, visitorClicksLastHour: 9, maxClicksPerVisitorPerHour: 5 }, THRESHOLD);
    expect(r.valid).toBe(false);
  });

  it('flags a request rate far above the configured ceiling', () => {
    const r = assessEvent({ ipRequestsPerMinute: 600, maxRequestsPerMinute: 60, missingReferrer: true }, THRESHOLD);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('rate_anomaly');
  });

  it('does not flag a rate at or just under the ceiling', () => {
    expect(assessEvent({ ipRequestsPerMinute: 60, maxRequestsPerMinute: 60 }, THRESHOLD).valid).toBe(true);
  });

  it('keeps the score within 0..100 so it can be stored and compared', () => {
    const r = assessEvent(
      { ipRequestsPerMinute: 100_000, maxRequestsPerMinute: 1, renderToClickMs: 0, minRenderToClickMs: 1000, visitorClicksLastHour: 999, maxClicksPerVisitorPerHour: 1, missingReferrer: true, tokenAgeMs: 0 },
      THRESHOLD,
    );
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('a threshold of 100 only rejects hard failures and the very worst scores', () => {
    expect(assessEvent({ missingReferrer: true, tokenAgeMs: 1 }, 100).valid).toBe(true);
  });

  it('records which signals fired, so a publisher appeal can be investigated', () => {
    const r = assessEvent({ ipRequestsPerMinute: 120, maxRequestsPerMinute: 60 }, THRESHOLD);
    expect(r.signals.join(',')).toMatch(/rate:120/);
  });
});
