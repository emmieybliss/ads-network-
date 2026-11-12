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
const TRAVEL = { title: 'A weekend in Lisbon on a small budget', description: 'Travel guide to Lisbon.', headings: ['Where to stay', 'Getting around'], text: 'Flights take under three hours and the airport is close to the centre. Stay in a hostel, buy a transport card for the tram, and visit the viewpoints. Book hotels early for summer.', lang: 'en' };
const FINANCE = { title: 'Index funds explained in plain words', text: 'An index fund buys every stock in a market index. Fees are low and the expense ratio matters over decades of retirement savings. Build an emergency fund first.', lang: 'en' };
const VIOLENT = { title: 'Gunman kills three in mass shooting', text: 'Police said the death toll rose after the massacre. Graphic violence was reported.', lang: 'en' };

type Targeting = { topics?: string[]; excludeTopics?: string[]; brandSafety?: 'strict' | 'standard' | 'relaxed'; keywords?: string[] };

async function setup(campaigns: Targeting[], siteCategory = 'general') {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pub = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: 7000 });
  const domain = 'topics.example.org';
  const site = await makeSite(h.db, { orgId: pub, domain, category: siteCategory });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  await fundOrg(h.db, adv, '500');
  const ids: string[] = [];
  for (const t of campaigns) {
    const id = await makeCampaign(h.db, { orgId: adv, rate: '4.00', lifetime: '50', daily: null, targeting: t });
    await makeCreative(h.db, { campaignId: id, orgId: adv, format: 'image', width: 300, height: 250 });
    await reserve(h.db, id);
    ids.push(id);
  }
  h.app.ctx.settings.invalidate();
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
  const pubCl = new Client(h.app);
  await pubCl.post('/api/v1/auth/login', { email: pubUser.email, password: TEST_PASSWORD });
  const advCl = new Client(h.app);
  await advCl.post('/api/v1/auth/login', { email: advUser.email, password: TEST_PASSWORD });
  return { adv, pub, site, unit, domain, ids, pubCl, advCl };
}

type S = Awaited<ReturnType<typeof setup>>;

async function serve(s: S, path: string, context?: object, pv = uniq('pv0000000000')) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/serve', headers: { 'user-agent': BROWSER_UA, origin: `http://${s.domain}` },
    payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: `http://${s.domain}${path}`, context }, pv },
  });
  expect(r.statusCode, r.body).toBe(200);
  return JSON.parse(r.body).ads[0] as { ad: null | { token: string } };
}

async function campaignOf(token: string) {
  const r = await h.db.query(`SELECT campaign_id FROM ad_events WHERE type = 'served' ORDER BY occurred_at DESC LIMIT 1`);
  return token ? r.rows[0]?.campaign_id : null;
}

describe('automatic page topics', () => {
  it('classifies a page from the text sample, stores only the result and tags the delivery', async () => {
    const s = await setup([{}]);
    const ad = await serve(s, '/lisbon-weekend', TRAVEL);
    expect(ad.ad).not.toBeNull();
    const pc = (await h.db.query('SELECT * FROM page_contexts WHERE site_id = $1', [s.site.id])).rows[0];
    expect(pc).toMatchObject({ page_path: '/lisbon-weekend', primary_topic: 'travel', brand_safety: 'safe', title: TRAVEL.title, language: 'en' });
    expect(JSON.stringify(pc)).not.toContain('transport card'); // the body text is not stored
    const served = (await h.db.query(`SELECT topic, brand_safety FROM ad_events WHERE type = 'served'`)).rows[0];
    expect(served).toEqual({ topic: 'travel', brand_safety: 'safe' });
  });

  it('targets campaigns by topic and keeps them off excluded topics', async () => {
    const s = await setup([{ topics: ['travel'] }, { topics: ['finance'] }]);
    const [travel, finance] = s.ids;
    await serve(s, '/lisbon', TRAVEL);
    expect(await campaignOf('x')).toBe(travel);
    await serve(s, '/funds', FINANCE);
    expect(await campaignOf('x')).toBe(finance);
    // A page with too little text has no topic: neither topic campaign is eligible.
    expect((await serve(s, '/hello', { title: 'Hello', text: 'Welcome.' })).ad).toBeNull();
  });

  it('uses the site category until a page is classified, and detected terms as keywords', async () => {
    const s = await setup([{ topics: ['travel'] }, { keywords: ['hostel'] }], 'travel');
    // No text sample (an older tag): the site category says travel.
    const first = await serve(s, '/no-text');
    expect(first.ad).not.toBeNull();
    // The keyword campaign matches a term detected in the text, with no keywords meta tag.
    await h.db.query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [s.ids[0]]);
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);
    await serve(s, '/lisbon', TRAVEL);
    expect(await campaignOf('x')).toBe(s.ids[1]);
  });

  it('serves no ads on high-risk pages and respects each campaign\'s brand-safety level', async () => {
    const s = await setup([{ brandSafety: 'relaxed' }]);
    const blocked = await serve(s, '/news/shooting', VIOLENT);
    expect(blocked.ad).toBeNull();
    const stats = (await h.db.query('SELECT requests::int, blocked::int FROM unit_request_stats')).rows[0];
    expect(stats).toEqual({ requests: 1, blocked: 1 });
    // Medium risk (a gambling page): the standard campaign stays off it, the relaxed one may serve.
    const casino = { title: 'Best online casino bonus and free spins', text: 'Play slots, roulette, blackjack and poker with sports betting odds.', lang: 'en' };
    expect((await serve(s, '/casino', casino)).ad).not.toBeNull();
    await h.db.query(`UPDATE campaign_targeting SET brand_safety = 'standard'`);
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);
    expect((await serve(s, '/casino', casino)).ad).toBeNull();
  });

  it('lets staff correct a page, which wins over detection and is audited', async () => {
    const s = await setup([{ brandSafety: 'strict' }]);
    expect((await serve(s, '/news/shooting', VIOLENT)).ad).toBeNull();
    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    const cl = new Client(h.app);
    await cl.post('/api/v1/auth/login', { email: admin.email, password: TEST_PASSWORD });
    const list = await cl.get('/api/v1/admin/page-topics?safety=flagged');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data[0]).toMatchObject({ path: '/news/shooting', brandSafety: 'high', effectiveSafety: 'high' });
    expect(list.body.summary.high).toBe(1);

    const put = await cl.put('/api/v1/admin/page-topics/override', { siteId: s.site.id, path: '/news/shooting', topics: ['news'], safety: 'safe', reason: 'Satire page, reviewed' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const ad = await serve(s, '/news/shooting', VIOLENT);
    expect(ad.ad).not.toBeNull();
    expect((await h.db.query(`SELECT topic FROM ad_events WHERE type = 'served'`)).rows[0].topic).toBe('news');
    const audit = (await h.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'page_topics.%'`)).rows;
    expect(audit).toEqual([{ action: 'page_topics.override' }]);

    // Clearing goes back to detection.
    await cl.put('/api/v1/admin/page-topics/override', { siteId: s.site.id, path: '/news/shooting', topics: null, safety: null, reason: 'Back to detection' });
    expect((await serve(s, '/news/shooting', VIOLENT)).ad).toBeNull();

    // The tester classifies without storing anything.
    const test = await cl.post('/api/v1/admin/page-topics/test', { title: TRAVEL.title, text: TRAVEL.text });
    expect(test.body.data).toMatchObject({ primary: 'travel', safety: 'safe' });
    expect(Number((await h.db.query('SELECT count(*) FROM page_contexts')).rows[0].count)).toBe(1);
  });

  it('is not open to advertisers or publishers', async () => {
    const s = await setup([{}]);
    expect([401, 403]).toContain((await s.pubCl.get('/api/v1/admin/page-topics')).status);
    expect([401, 403]).toContain((await s.advCl.post('/api/v1/admin/page-topics/test', { title: 'x' })).status);
  });

  it('does not classify again until the text changes and the interval has passed', async () => {
    const s = await setup([{}]);
    await serve(s, '/p', TRAVEL);
    const first = (await h.db.query('SELECT content_hash, classified_at FROM page_contexts')).rows[0];
    await serve(s, '/p', FINANCE); // changed text, but within the reclassify interval
    expect((await h.db.query('SELECT primary_topic, content_hash FROM page_contexts')).rows[0]).toMatchObject({ primary_topic: 'travel', content_hash: first.content_hash });
    await h.db.query(`UPDATE page_contexts SET classified_at = now() - interval '2 hours'`);
    await h.redis.flushdb();
    await serve(s, '/p', FINANCE);
    expect((await h.db.query('SELECT primary_topic FROM page_contexts')).rows[0].primary_topic).toBe('finance');
  });

  it('reports performance by topic for publishers and advertisers, and topics on the pages report', async () => {
    const s = await setup([{}]);
    for (const [path, ctx] of [['/lisbon', TRAVEL], ['/lisbon', TRAVEL], ['/funds', FINANCE]] as const) {
      const ad = await serve(s, path, ctx);
      await h.app.inject({
        method: 'POST', url: '/api/v1/events', headers: { 'user-agent': BROWSER_UA, origin: `http://${s.domain}`, referer: `http://${s.domain}/` },
        payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t: ad.ad!.token }] },
      });
    }
    const { aggregateDay } = await import('@blissnova/api/services/events');
    await aggregateDay(h.db, today());
    const rows = (await h.db.query('SELECT topic, valid_impressions::int AS n FROM topic_daily_stats ORDER BY topic')).rows;
    expect(rows).toEqual([{ topic: 'finance', n: 1 }, { topic: 'travel', n: 2 }]);

    const pubA = await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics`);
    expect(pubA.status).toBe(200);
    const travel = pubA.body.data.topics.rows.find((r: any) => r.topic === 'travel');
    expect(travel).toMatchObject({ label: 'Travel', validImpressions: 2, pageviews: 2, earningsMicros: '5600', pageRpmMicros: '2800000' });
    expect(pubA.body.data.topics.safety).toEqual([{ level: 'safe', pages: 2, pageviews: 3 }]);

    const advA = await s.advCl.get(`/api/v1/orgs/${s.adv}/analytics`);
    expect(advA.body.data.topics.rows.map((r: any) => [r.topic, r.validImpressions])).toEqual([['travel', 2], ['finance', 1]]);
    expect(advA.body.data.topics.safety).toBeNull();
    expect(advA.body.data.topics.rows[0].pageviews).toBeUndefined();

    const pages = await s.pubCl.get(`/api/v1/orgs/${s.pub}/reports/pages`);
    expect(pages.body.data.rows.find((r: any) => r.path === '/lisbon')).toMatchObject({ topic: 'travel', brandSafety: 'safe', reviewed: false });
    const csv = await s.pubCl.get(`/api/v1/orgs/${s.pub}/reports/pages/export`);
    expect(String(csv.body)).toContain('Brand safety');
    expect(String(csv.body)).toContain('Travel');
  });

  it('saves topic targeting on campaigns through the API', async () => {
    const s = await setup([]);
    const body = {
      name: 'Topic campaign', pricingModel: 'cpm', rate: '3.00', lifetimeBudget: '50', startAt: new Date(Date.now() + 3600_000).toISOString(),
      targeting: { topics: ['travel', 'food'], excludeTopics: ['news'], brandSafety: 'strict' },
    };
    const r = await s.advCl.post(`/api/v1/orgs/${s.adv}/campaigns`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.targeting).toMatchObject({ topics: ['travel', 'food'], excludeTopics: ['news'], brandSafety: 'strict' });
    const bad = await s.advCl.post(`/api/v1/orgs/${s.adv}/campaigns`, { ...body, targeting: { topics: ['travel'], excludeTopics: ['travel'] } });
    expect(bad.status).toBe(400);
    const unknown = await s.advCl.post(`/api/v1/orgs/${s.adv}/campaigns`, { ...body, targeting: { topics: ['not_a_topic'] } });
    expect(unknown.status).toBe(400);
  });
});
