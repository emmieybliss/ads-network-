import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, TEST_PASSWORD, uniq } from '../helpers/fixtures';

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

const today = () => new Date().toISOString().slice(0, 10);

async function setup(domain = 'pub.example.org') {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pub = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: 7000 });
  const site = await makeSite(h.db, { orgId: pub, domain });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  const unit2 = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  await fundOrg(h.db, adv, '500');
  const campaign = await makeCampaign(h.db, { orgId: adv, rate: '4.00', lifetime: '100', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: adv, format: 'image', width: 300, height: 250 });
  await reserve(h.db, campaign);
  h.app.ctx.settings.invalidate();
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: pubUser.email, password: TEST_PASSWORD });
  const advCl = new Client(h.app);
  await advCl.post('/api/v1/auth/login', { email: advUser.email, password: TEST_PASSWORD });
  return { adv, pub, site, unit, unit2, cl, advCl, domain };
}

async function serve(s: { site: { publicKey: string }; domain: string }, slots: string[], url: string, pv: string) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/serve', headers: { 'user-agent': BROWSER_UA, origin: `http://${s.domain}` },
    payload: { siteKey: s.site.publicKey, units: slots.map((slot) => ({ slot })), page: { url }, pv },
  });
  return JSON.parse(r.body).ads as Array<{ ad: { token: string } | null }>;
}

async function render(token: string, domain: string) {
  await h.app.inject({
    method: 'POST', url: '/api/v1/events', headers: { 'user-agent': BROWSER_UA, origin: `http://${domain}`, referer: `http://${domain}/` },
    payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t: token }] },
  });
}

describe('page views and page RPM', () => {
  it('counts a page view once however many requests the page makes, and stores the path only', async () => {
    const s = await setup();
    const pv = uniq('pv0000000000');
    await serve(s, [s.unit.key], 'http://pub.example.org/guides/one?utm_source=x&email=a@b.c#top', pv);
    await serve(s, [s.unit2.key], 'http://pub.example.org/guides/one?utm_source=x', pv);
    await serve(s, [s.unit.key], 'http://pub.example.org/guides/two', uniq('pv0000000000'));
    const rows = (await h.db.query('SELECT page_path, views::int FROM page_views ORDER BY page_path')).rows;
    expect(rows).toEqual([{ page_path: '/guides/one', views: 1 }, { page_path: '/guides/two', views: 1 }]);
    const served = (await h.db.query(`SELECT DISTINCT page_path FROM ad_events WHERE type = 'served' ORDER BY 1`)).rows.map((r) => r.page_path);
    expect(served).toEqual(['/guides/one', '/guides/two']);
  });

  it('carries the page into later events and computes page RPM from validated earnings', async () => {
    const s = await setup();
    // Two views of /a and one of /b, each rendering the ad it gets.
    for (const path of ['/a', '/a', '/b']) {
      const ads = await serve(s, [s.unit.key], `http://pub.example.org${path}`, uniq('pv0000000000'));
      await render(ads[0]!.ad!.token, s.domain);
    }
    const renders = (await h.db.query(`SELECT page_path, count(*)::int AS n FROM ad_events WHERE type = 'render' GROUP BY 1 ORDER BY 1`)).rows;
    expect(renders).toEqual([{ page_path: '/a', n: 2 }, { page_path: '/b', n: 1 }]);

    const { aggregateDay } = await import('@blissnova/api/services/events');
    await aggregateDay(h.db, today());

    const r = await s.cl.get(`/api/v1/orgs/${s.pub}/reports/pages`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // $4 CPM at a 70% share is 2800 micros per valid impression; page RPM = earnings / views x 1000.
    const a = r.body.data.rows.find((x: any) => x.path === '/a');
    expect(a).toMatchObject({ domain: 'pub.example.org', pageviews: 2, validImpressions: 2, earningsMicros: '5600', impressionsPerPageview: 1, pageRpmMicros: '2800000' });
    expect(r.body.data.rows[0].path).toBe('/a'); // highest earning first
    expect(r.body.data.totals).toMatchObject({ pageviews: 3, validImpressions: 3, earningsMicros: '8400', pageRpmMicros: '2800000' });

    const dash = await s.cl.get(`/api/v1/orgs/${s.pub}/dashboard`);
    expect(dash.body.data.pageviews).toBe(3);
    expect(dash.body.data.pageRpmMicros).toBe('2800000');

    const csv = await s.cl.get(`/api/v1/orgs/${s.pub}/reports/pages/export`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('Page RPM');
  });

  it('shows each publisher only their own pages, and is not offered to advertisers', async () => {
    const s = await setup();
    const other = await setup('other.example.org');
    await serve(s, [s.unit.key], 'http://pub.example.org/mine', uniq('pv0000000000'));
    await serve(other, [other.unit.key], 'http://other.example.org/theirs', uniq('pv0000000000'));
    const mine = await s.cl.get(`/api/v1/orgs/${s.pub}/reports/pages`);
    expect(mine.body.data.rows.map((x: any) => x.path)).toEqual(['/mine']);
    expect([403, 404]).toContain((await s.cl.get(`/api/v1/orgs/${other.pub}/reports/pages`)).status);
    expect((await s.advCl.get(`/api/v1/orgs/${s.adv}/reports/pages`)).status).toBe(400);
  });
});
