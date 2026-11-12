import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUser, reserve, setSettings, TEST_PASSWORD, uniq } from '../helpers/fixtures';

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

async function signedIn() {
  const u = await makeUser(h.db);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { user: u, cl };
}

async function publisher() {
  const s = await signedIn();
  const org = await makeOrg(h.db, { type: 'publisher', ownerId: s.user.id });
  const site = await makeSite(h.db, { orgId: org, domain: 'pub.example.org' });
  return { org, site, cl: s.cl };
}

async function advertiser(acceptRefresh = true) {
  const s = await signedIn();
  const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
  await fundOrg(h.db, org, '100');
  const campaign = await makeCampaign(h.db, { orgId: org, rate: '2.00', lifetime: '50', daily: null });
  if (!acceptRefresh) await h.db.query('UPDATE campaigns SET accept_refresh = false WHERE id = $1', [campaign]);
  await makeCreative(h.db, { campaignId: campaign, orgId: org, format: 'text' });
  await reserve(h.db, campaign);
  return { org, campaign, cl: s.cl };
}

type Unit = { slot: string; refresh?: number; inst?: number };
const serve = (siteKey: string, units: Unit[], pv: string) => h.app.inject({
  method: 'POST', url: '/api/v1/serve', remoteAddress: '203.0.113.9', headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
  payload: { siteKey, units, page: { url: 'http://pub.example.org/story' }, pv },
}).then((r) => JSON.parse(r.body) as { ads: Array<{ slot: string; refresh?: { seconds: number; max: number }; ad: { token: string } | null }> });

/** Pretend the slot's current ad has been on screen for `ms`. */
async function age(unitId: string, pv: string, ms: number, inst = 0) {
  await h.app.ctx.redis.set(`rf:${pv}:${unitId}:${inst}`, String(Date.now() - ms), 'EX', 1800);
}

const settingsChanged = () => h.app.ctx.settings.invalidate();

describe('viewable auto-refresh', () => {
  it('lets publishers opt placements in, only for types that can refresh', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    const r = await p.cl.post(base, { key: 'side', name: 'Sidebar', width: 300, height: 250, refreshEnabled: true, refreshSeconds: 45, refreshMax: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ refreshEnabled: true, refreshSeconds: 45, refreshMax: 3 });
    // Under 30 seconds is refused.
    expect((await p.cl.post(base, { key: 'fast', name: 'Fast', width: 300, height: 250, refreshEnabled: true, refreshSeconds: 10 })).status).toBe(400);
    // Interstitials never refresh, whatever was asked.
    const ist = await p.cl.post(base, { key: 'ist', name: 'Between pages', display: 'interstitial', refreshEnabled: true });
    expect(ist.body.data.refreshEnabled).toBe(false);
    // Turning a refreshing placement into an interstitial switches refresh off.
    const moved = await p.cl.patch(`/api/v1/orgs/${p.org}/units/${r.body.data.id}`, { display: 'interstitial', width: null, height: null });
    expect(moved.body.data.refreshEnabled).toBe(false);
  });

  it('refreshes only after the interval, in order and up to the limit, and records refreshed impressions apart', async () => {
    const p = await publisher();
    const unit = (await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/units`, { key: 'side', name: 'Sidebar', formats: ['text'], width: 300, height: 250, refreshEnabled: true, refreshSeconds: 45, refreshMax: 2 })).body.data;
    const adv = await advertiser();
    const pv = uniq('pv0000000000');

    const first = await serve(p.site.publicKey, [{ slot: 'side', inst: 0 }], pv);
    expect(first.ads[0]!.ad).not.toBeNull();
    expect(first.ads[0]!.refresh).toEqual({ seconds: 45, max: 2 });

    // Too early: refused, and the slot keeps its ad.
    const early = await serve(p.site.publicKey, [{ slot: 'side', refresh: 1, inst: 0 }], pv);
    expect(early.ads[0]!.ad).toBeNull();
    expect(early.ads[0]!.refresh).toBeUndefined();

    await age(unit.id, pv, 46_000);
    const r1 = await serve(p.site.publicKey, [{ slot: 'side', refresh: 1, inst: 0 }], pv);
    expect(r1.ads[0]!.ad).not.toBeNull();
    expect(r1.ads[0]!.refresh).toEqual({ seconds: 45, max: 2 });

    // Out of order (skipping 2), then past the limit.
    await age(unit.id, pv, 46_000);
    expect((await serve(p.site.publicKey, [{ slot: 'side', refresh: 3, inst: 0 }], pv)).ads[0]!.ad).toBeNull();
    expect((await serve(p.site.publicKey, [{ slot: 'side', refresh: 2, inst: 0 }], pv)).ads[0]!.ad).not.toBeNull();
    await age(unit.id, pv, 46_000);
    expect((await serve(p.site.publicKey, [{ slot: 'side', refresh: 3, inst: 0 }], pv)).ads[0]!.ad).toBeNull();

    // A refresh with no earlier ad in this page view is refused.
    expect((await serve(p.site.publicKey, [{ slot: 'side', refresh: 1, inst: 0 }], uniq('pv0000000000'))).ads[0]!.ad).toBeNull();

    // Both impressions are reported; the refreshed one is marked and counted apart.
    for (const t of [first.ads[0]!.ad!.token, r1.ads[0]!.ad!.token]) {
      const ev = await h.app.inject({ method: 'POST', url: '/api/v1/events', headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org', referer: 'http://pub.example.org/story' }, payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t }, { id: uniq('ev0000000000'), type: 'viewable', t }] } });
      expect(ev.statusCode).toBe(202);
    }
    const rows = (await h.db.query(`SELECT refresh_count, count(*)::int AS n FROM ad_events WHERE type = 'render' AND status = 'valid' GROUP BY 1 ORDER BY 1`)).rows;
    expect(rows).toEqual([{ refresh_count: 0, n: 1 }, { refresh_count: 1, n: 1 }]);
    const { aggregateDay } = await import('@blissnova/api/services/events');
    await aggregateDay(h.db, new Date().toISOString().slice(0, 10));
    const pubReport = await p.cl.get(`/api/v1/orgs/${p.org}/reports?groupBy=unit`);
    expect(pubReport.body.data.totals).toMatchObject({ validImpressions: 2, refreshedImpressions: 1, refreshedViewableImpressions: 1, refreshedShare: 50 });
    expect(BigInt(pubReport.body.data.totals.refreshedEarningsMicros)).toBeGreaterThan(0n);
    const advReport = await adv.cl.get(`/api/v1/orgs/${adv.org}/reports?groupBy=campaign`);
    expect(advReport.body.data.totals).toMatchObject({ refreshedImpressions: 1 });
    expect(advReport.body.data.totals.refreshedSpendMicros).toBe('2000');
    const csv = await p.cl.get(`/api/v1/orgs/${p.org}/reports/export?groupBy=unit`);
    expect(String(csv.body)).toContain('Refreshed impressions');
  });

  it('keeps opted-out campaigns out of refreshed slots and follows the network switch', async () => {
    const p = await publisher();
    const unit = (await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/units`, { key: 'side', name: 'Sidebar', formats: ['text'], width: 300, height: 250, refreshEnabled: true })).body.data;
    await advertiser(false);
    const pv = uniq('pv0000000000');
    const first = await serve(p.site.publicKey, [{ slot: 'side' }], pv);
    expect(first.ads[0]!.ad).not.toBeNull();
    await age(unit.id, pv, 31_000);
    const r1 = await serve(p.site.publicKey, [{ slot: 'side', refresh: 1 }], pv);
    // Allowed, but nobody who accepts refreshed impressions: no ad, and the slot may try again later.
    expect(r1.ads[0]!.ad).toBeNull();
    expect(r1.ads[0]!.refresh).toBeDefined();

    // The network minimum wins over a shorter publisher interval, and the network can turn refresh off.
    await setSettings(h.db, 'adRefresh', { minSeconds: 60, maxPerPageView: 2 });
    settingsChanged();
    expect((await serve(p.site.publicKey, [{ slot: 'side' }], uniq('pv0000000000'))).ads[0]!.refresh).toEqual({ seconds: 60, max: 2 });
    await setSettings(h.db, 'adRefresh', { enabled: false });
    settingsChanged();
    expect((await serve(p.site.publicKey, [{ slot: 'side' }], uniq('pv0000000000'))).ads[0]!.refresh).toBeUndefined();
  });

  it('lets advertisers opt a campaign out of refreshed impressions', async () => {
    const adv = await advertiser();
    const get = await adv.cl.get(`/api/v1/orgs/${adv.org}/campaigns/${adv.campaign}`);
    expect(get.body.data.acceptRefresh).toBe(true);
    const r = await adv.cl.patch(`/api/v1/orgs/${adv.org}/campaigns/${adv.campaign}`, { acceptRefresh: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.acceptRefresh).toBe(false);
    // Not a targeting change: no new review.
    expect(r.body.data.status).toBe('active');
  });
});
