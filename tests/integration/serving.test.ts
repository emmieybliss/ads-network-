import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, setSettings, uniq } from '../helpers/fixtures';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

interface ServedAd {
  slot: string;
  ad: null | { format: string; token: string; clickUrl: string; width: number | null; height: number | null; image?: { url: string; alt: string }; text?: Record<string, string> };
}

async function serve(
  body: { siteKey: string; slots: string[]; pageUrl?: string; keywords?: string[]; consent?: object; vid?: string; pv?: string },
  headers: Record<string, string> = {},
) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/serve',
    headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org', ...headers },
    payload: {
      siteKey: body.siteKey,
      units: body.slots.map((slot) => ({ slot })),
      page: { url: body.pageUrl ?? 'http://pub.example.org/article', keywords: body.keywords },
      consent: body.consent,
      vid: body.vid,
      pv: body.pv ?? uniq('pv0000000000'),
    },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as { status: string; ads: ServedAd[] } };
}

/** A publisher site with one fixed-size unit, plus an approved CPM campaign. */
async function scenario(opts: { rate?: string; lifetime?: string; model?: 'cpm' | 'cpc'; formats?: string[] } = {}) {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: 7000 });
  const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: opts.formats ?? ['image'], width: 300, height: 250 });
  await fundOrg(h.db, advOrg, '5000');
  const campaign = await makeCampaign(h.db, { orgId: advOrg, model: opts.model ?? 'cpm', rate: opts.rate ?? '2.00', lifetime: opts.lifetime ?? '1000', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: (opts.formats ?? ['image'])[0] === 'text' ? 'text' : 'image', width: 300, height: 250 });
  await reserve(h.db, campaign);
  if ((opts.model ?? 'cpm') === 'cpc') await setSettings(h.db, 'pricing', { cpcEnabled: true });
  h.app.ctx.settings.invalidate();
  return { advOrg, pubOrg, site, unit, campaign, advUser, pubUser };
}

describe('ad serving', () => {
  it('returns an approved creative for a verified site', async () => {
    const s = await scenario();
    const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    const ad = r.body.ads[0]!.ad;
    expect(ad).not.toBeNull();
    expect(ad!.format).toBe('image');
    expect(ad!.width).toBe(300);
    expect(ad!.token).toBeTruthy();
    expect(ad!.clickUrl).toContain('/click?t=');
  });

  it('never puts an advertiser secret, rate or campaign id in the response', async () => {
    const s = await scenario();
    const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(s.campaign);
    expect(text).not.toContain(s.advOrg);
    expect(text).not.toContain('2000000'); // the rate in micros
  });

  it('records a served event but does not charge for it', async () => {
    const s = await scenario();
    await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] });
    const ev = await h.db.query<{ type: string; billable: boolean; cost_micros: string }>('SELECT type, billable, cost_micros FROM ad_events');
    expect(ev.rows.map((r) => r.type)).toEqual(['served']);
    expect(ev.rows[0]!.billable).toBe(false);
    expect(ev.rows[0]!.cost_micros).toBe('0');
    const camp = await h.db.query<{ spent_micros: string }>('SELECT spent_micros FROM campaigns WHERE id = $1', [s.campaign]);
    expect(camp.rows[0]!.spent_micros).toBe('0');
  });

  it('returns no ad for an unknown slot without failing the whole request', async () => {
    const s = await scenario();
    const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key, 'no_such_slot'] });
    expect(r.body.status).toBe('ok');
    expect(r.body.ads).toHaveLength(2);
    expect(r.body.ads.find((a) => a.slot === 'no_such_slot')!.ad).toBeNull();
  });

  it('refuses an unknown site key', async () => {
    const r = await serve({ siteKey: 'pk_aaaaaaaaaaaaaaaaaaaa', slots: ['some_slot'] });
    expect(r.body.status).toBe('inactive');
    expect(r.body.ads.every((a) => a.ad === null)).toBe(true);
  });

  it('refuses a site that is not approved', async () => {
    const pubUser = await makeUser(h.db);
    const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
    const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org', status: 'verification_pending' });
    const unit = await makeUnit(h.db, { siteId: site.id });
    const r = await serve({ siteKey: site.publicKey, slots: [unit.key] });
    expect(r.body.status).toBe('inactive');
  });

  describe('domain authorisation', () => {
    it('refuses a page on a domain the site has not registered', async () => {
      const s = await scenario();
      const r = await serve(
        { siteKey: s.site.publicKey, slots: [s.unit.key], pageUrl: 'http://stolen-key.example.net/page' },
        { origin: 'http://stolen-key.example.net' },
      );
      expect(r.body.status).toBe('blocked');
      expect(r.body.ads[0]!.ad).toBeNull();
    });

    it('refuses when the page URL is allowed but the Origin header is not', async () => {
      const s = await scenario();
      const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] }, { origin: 'http://attacker.example.net' });
      expect(r.body.status).toBe('blocked');
    });

    it('allows subdomains of the registered domain', async () => {
      const s = await scenario();
      const r = await serve(
        { siteKey: s.site.publicKey, slots: [s.unit.key], pageUrl: 'http://news.pub.example.org/a' },
        { origin: 'http://news.pub.example.org' },
      );
      expect(r.body.status).toBe('ok');
    });

    it('counts a blocked request against the unit, so the publisher can see it', async () => {
      const s = await scenario();
      await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] }, { origin: 'http://attacker.example.net' });
      const stats = await h.db.query<{ blocked: string }>('SELECT blocked FROM unit_request_stats WHERE unit_id = $1', [s.unit.id]);
      expect(Number(stats.rows[0]?.blocked ?? 0)).toBeGreaterThan(0);
    });
  });

  it('serves nothing to a crawler', async () => {
    const s = await scenario();
    const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] }, { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    expect(r.body.status).toBe('blocked');
  });

  it('serves nothing at all when the platform turns tracking off', async () => {
    const s = await scenario();
    await setSettings(h.db, 'tracking', { enabled: false });
    h.app.ctx.settings.invalidate();
    const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key] });
    // Delivery without measurement would be unbillable and unauditable.
    expect(r.body.status).toBe('disabled');
    expect(r.body.ads[0]!.ad).toBeNull();
  });

  describe('frequency caps', () => {
    it('does not put the same campaign twice on one page', async () => {
      const s = await scenario();
      const second = await makeUnit(h.db, { siteId: s.site.id, formats: ['image'], width: 300, height: 250 });
      h.app.ctx.settings.invalidate();
      const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key, second.key] });
      const filled = r.body.ads.filter((a) => a.ad !== null);
      expect(filled).toHaveLength(1);
    });

    it('enforces a per-visitor daily cap when consent allows personalisation', async () => {
      const s = await scenario();
      await setSettings(h.db, 'tracking', { personalizedAllowed: true });
      await setSettings(h.db, 'frequency', { defaultMaxPerVisitorPerDay: 2, defaultMaxPerPage: 1 });
      h.app.ctx.settings.invalidate();

      const vid = 'visitor-abcdefghijklmnop';
      const results: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key], consent: { personalized: true }, vid, pv: uniq('pv0000000000') });
        results.push(r.body.ads[0]!.ad !== null);
      }
      // Two fills, then the cap holds.
      expect(results).toEqual([true, true, false, false]);
    });

    it('counts the cap against served impressions, not against renders', async () => {
      // A page that requests an ad and never renders it still consumes the cap;
      // otherwise a cap could be bypassed by simply not reporting renders.
      const s = await scenario();
      await setSettings(h.db, 'tracking', { personalizedAllowed: true });
      await setSettings(h.db, 'frequency', { defaultMaxPerVisitorPerDay: 1, defaultMaxPerPage: 1 });
      h.app.ctx.settings.invalidate();
      const vid = 'visitor-qrstuvwxyz012345';
      expect((await serve({ siteKey: s.site.publicKey, slots: [s.unit.key], consent: { personalized: true }, vid })).body.ads[0]!.ad).not.toBeNull();
      expect((await serve({ siteKey: s.site.publicKey, slots: [s.unit.key], consent: { personalized: true }, vid })).body.ads[0]!.ad).toBeNull();
    });

    it('does not use a visitor cap when there is no consent', async () => {
      const s = await scenario();
      await setSettings(h.db, 'frequency', { defaultMaxPerVisitorPerDay: 1, defaultMaxPerPage: 1 });
      h.app.ctx.settings.invalidate();
      // Without consent there is no visitor identity to cap, so each page view
      // is capped on its own and delivery continues.
      for (let i = 0; i < 3; i++) {
        const r = await serve({ siteKey: s.site.publicKey, slots: [s.unit.key], pv: uniq('pv0000000000') });
        expect(r.body.ads[0]!.ad, `request ${i}`).not.toBeNull();
      }
    });
  });

  describe('budget', () => {
    it('stops serving once the campaign budget cannot cover another impression', async () => {
      // $0.50 lifetime budget at a $2 CPM is 250 impressions; use a tiny budget
      // so the limit is reached quickly.
      const advUser = await makeUser(h.db);
      const pubUser = await makeUser(h.db);
      const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
      const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
      const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
      const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'] });
      await fundOrg(h.db, advOrg, '100');
      // 2 impressions' worth of budget at a $1,000 CPM ($1 per impression).
      const campaign = await makeCampaign(h.db, { orgId: advOrg, rate: '1000', lifetime: '2', daily: null });
      await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image' });
      await reserve(h.db, campaign);
      h.app.ctx.settings.invalidate();

      // Spend the budget directly, as billing would.
      await h.db.query('UPDATE campaigns SET spent_micros = lifetime_budget_micros WHERE id = $1', [campaign]);
      h.app.ctx.settings.invalidate();
      const { invalidateServingCache } = await import('@blissnova/api/services/serving');
      invalidateServingCache(h.app.ctx);

      const r = await serve({ siteKey: site.publicKey, slots: [unit.key] });
      expect(r.body.ads[0]!.ad).toBeNull();
    });
  });

  describe('targeting', () => {
    it('does not serve a campaign targeting another country', async () => {
      const advUser = await makeUser(h.db);
      const pubUser = await makeUser(h.db);
      const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
      const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
      const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
      const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'] });
      await fundOrg(h.db, advOrg, '1000');
      const campaign = await makeCampaign(h.db, { orgId: advOrg, daily: null, targeting: { countries: ['GB'] } });
      await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image' });
      await reserve(h.db, campaign);
      const { invalidateServingCache } = await import('@blissnova/api/services/serving');
      invalidateServingCache(h.app.ctx);

      // With no trusted geo header the country is unknown ("ZZ"), which cannot
      // match a campaign that targets GB.
      const r = await serve({ siteKey: site.publicKey, slots: [unit.key] });
      expect(r.body.ads[0]!.ad).toBeNull();
    });

    it('serves a keyword-targeted campaign only on a matching page', async () => {
      const advUser = await makeUser(h.db);
      const pubUser = await makeUser(h.db);
      const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
      const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
      const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
      const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'] });
      await fundOrg(h.db, advOrg, '1000');
      const campaign = await makeCampaign(h.db, { orgId: advOrg, daily: null, targeting: { keywords: ['coffee'] } });
      await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image' });
      await reserve(h.db, campaign);
      const { invalidateServingCache } = await import('@blissnova/api/services/serving');
      invalidateServingCache(h.app.ctx);

      expect((await serve({ siteKey: site.publicKey, slots: [unit.key], keywords: ['tea'] })).body.ads[0]!.ad).toBeNull();
      expect((await serve({ siteKey: site.publicKey, slots: [unit.key], keywords: ['coffee'] })).body.ads[0]!.ad).not.toBeNull();
    });
  });

  it('rejects a malformed request rather than guessing', async () => {
    const bad = [
      { siteKey: 'not-a-key', units: [{ slot: 'a' }], page: { url: 'http://x' }, pv: 'pv0000000000' },
      { siteKey: 'pk_aaaaaaaaaaaaaaaaaaaa', units: [], page: { url: 'http://x' }, pv: 'pv0000000000' },
      { siteKey: 'pk_aaaaaaaaaaaaaaaaaaaa', units: [{ slot: 'UPPERCASE' }], page: { url: 'http://x' }, pv: 'pv0000000000' },
      { siteKey: 'pk_aaaaaaaaaaaaaaaaaaaa', units: [{ slot: 'ok_slot' }], page: { url: 'http://x' }, pv: 'short' },
    ];
    for (const payload of bad) {
      const r = await h.app.inject({ method: 'POST', url: '/api/v1/serve', payload, headers: { 'user-agent': BROWSER_UA } });
      expect(r.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
  });

  it('caps how many slots one request may ask for', async () => {
    const payload = {
      siteKey: 'pk_aaaaaaaaaaaaaaaaaaaa',
      units: Array.from({ length: 11 }, (_, i) => ({ slot: `slot_${i}` })),
      page: { url: 'http://pub.example.org/a' },
      pv: 'pv0000000000',
    };
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/serve', payload, headers: { 'user-agent': BROWSER_UA } });
    expect(r.statusCode).toBe(400);
  });

  it('tells browsers never to cache an ad response', async () => {
    const s = await scenario();
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/serve',
      headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
      payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: 'http://pub.example.org/a' }, pv: 'pv0000000000' },
    });
    expect(String(r.headers['cache-control'])).toContain('no-store');
  });
});
