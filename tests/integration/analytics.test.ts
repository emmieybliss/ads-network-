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
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function setup(domain = 'pub.example.org') {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pub = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: 7000 });
  const site = await makeSite(h.db, { orgId: pub, domain });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  await fundOrg(h.db, adv, '500');
  const campaign = await makeCampaign(h.db, { orgId: adv, rate: '4.00', lifetime: '100', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: adv, format: 'image', width: 300, height: 250 });
  await reserve(h.db, campaign);
  h.app.ctx.settings.invalidate();
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
  const pubCl = new Client(h.app);
  await pubCl.post('/api/v1/auth/login', { email: pubUser.email, password: TEST_PASSWORD });
  const advCl = new Client(h.app);
  await advCl.post('/api/v1/auth/login', { email: advUser.email, password: TEST_PASSWORD });
  return { adv, pub, site, unit, campaign, pubCl, advCl, domain };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function serve(s: Setup, opts: { path?: string; referrer?: string; ua?: string; ip?: string } = {}) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/serve', ...(opts.ip ? { remoteAddress: opts.ip } : {}), headers: { 'user-agent': opts.ua ?? BROWSER_UA, origin: `http://${s.domain}` },
    payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: `http://${s.domain}${opts.path ?? '/a'}`, referrer: opts.referrer }, pv: uniq('pv0000000000') },
  });
  return JSON.parse(r.body).ads[0].ad as { token: string; clickUrl: string };
}

async function events(s: Setup, list: Array<{ type: 'render' | 'viewable' | 'inview'; t: string; ms?: number }>, ua = BROWSER_UA) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/events', headers: { 'user-agent': ua, origin: `http://${s.domain}`, referer: `http://${s.domain}/a` },
    payload: { events: list.map((e) => ({ id: uniq('ev0000000000'), ...e })) },
  });
  return JSON.parse(r.body);
}

async function click(s: Setup, clickUrl: string, ua = BROWSER_UA) {
  return h.app.inject({ method: 'GET', url: clickUrl.slice(clickUrl.indexOf('/api/v1/click')), headers: { 'user-agent': ua, referer: `http://${s.domain}/a` } });
}

const aggregate = async () => (await import('@blissnova/api/services/events')).aggregateDay(h.db, today());

describe('audience dimensions and sessions', () => {
  it('records OS, browser and traffic source on every event, and counts sessions from entrances', async () => {
    const s = await setup();
    const fromSearch = await serve(s, { referrer: 'https://www.google.com/' });
    await events(s, [{ type: 'render', t: fromSearch.token }]);
    const internal = await serve(s, { path: '/b', referrer: `http://${s.domain}/a` });
    await events(s, [{ type: 'render', t: internal.token }]);
    const social = await serve(s, { referrer: 'https://t.co/abc', ua: IPHONE_UA });
    await events(s, [{ type: 'render', t: social.token }], IPHONE_UA);
    await serve(s, {});

    const rows = (await h.db.query(`SELECT os, browser, source FROM ad_events WHERE type = 'render' ORDER BY occurred_at`)).rows;
    expect(rows).toEqual([
      { os: 'macos', browser: 'chrome', source: 'search' },
      { os: 'macos', browser: 'chrome', source: 'internal' },
      { os: 'ios', browser: 'safari', source: 'social' },
    ]);
    const traffic = (await h.db.query(`SELECT source, device, sum(pageviews)::int AS pv, sum(sessions)::int AS sessions FROM site_traffic_daily GROUP BY 1, 2 ORDER BY 1`)).rows;
    expect(traffic).toEqual([
      { source: 'direct', device: 'desktop', pv: 1, sessions: 1 },
      { source: 'internal', device: 'desktop', pv: 1, sessions: 0 },
      { source: 'search', device: 'desktop', pv: 1, sessions: 1 },
      { source: 'social', device: 'mobile', pv: 1, sessions: 1 },
    ]);

    await aggregate();
    const r = await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.traffic).toMatchObject({ pageviews: 4, sessions: 3 });
    expect(d.traffic.pagesPerSession).toBeCloseTo(4 / 3);
    // $4 CPM at 70%: 2800 micros per valid impression, three impressions; session RPM = 8400 / 3 x 1000.
    expect(d.traffic.sessionRpmMicros).toBe('2800000');
    expect(d.breakdowns.os.map((x: any) => [x.key, x.validImpressions])).toEqual([['macos', 2], ['ios', 1]]);
    expect(d.breakdowns.source.find((x: any) => x.key === 'search').earningsMicros).toBe('2800');
    expect(d.funnel.map((x: any) => x.key)).toEqual(['requests', 'filled', 'served', 'rendered', 'valid', 'viewable', 'clicks']);
    expect(d.funnel.find((x: any) => x.key === 'requests').value).toBe(4);
    // Publishers never see advertiser conversion data.
    expect(d.totals.conversions).toBeUndefined();
    expect(d.reach).toBeNull();

    const rep = await s.pubCl.get(`/api/v1/orgs/${s.pub}/reports?groupBy=source`);
    expect(rep.body.data.rows.map((x: any) => x.key).sort()).toEqual(['direct', 'internal', 'search', 'social']);
  });
});

describe('time in view', () => {
  it('averages reported time in view over valid impressions and ignores it without a valid render', async () => {
    const s = await setup();
    const a = await serve(s);
    const b = await serve(s);
    await events(s, [{ type: 'render', t: a.token }, { type: 'render', t: b.token }]);
    await events(s, [{ type: 'viewable', t: a.token }, { type: 'inview', t: a.token, ms: 4000 }, { type: 'inview', t: b.token, ms: 8000 }]);
    // A second report for the same delivery is a duplicate.
    await events(s, [{ type: 'inview', t: a.token, ms: 60000 }]);
    // No render for this one: the in-view report is invalid.
    const c = await serve(s);
    await events(s, [{ type: 'inview', t: c.token, ms: 9000 }]);
    const rows = (await h.db.query(`SELECT status, invalid_reason, in_view_ms FROM ad_events WHERE type = 'inview' ORDER BY in_view_ms`)).rows;
    expect(rows).toEqual([
      { status: 'valid', invalid_reason: null, in_view_ms: 4000 },
      { status: 'valid', invalid_reason: null, in_view_ms: 8000 },
      { status: 'invalid', invalid_reason: 'sequence', in_view_ms: 9000 },
      { status: 'invalid', invalid_reason: 'duplicate', in_view_ms: 60000 },
    ]);
    await aggregate();
    const r = await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics`);
    expect(r.body.data.totals.avgTimeInViewSec).toBe(6);
    expect(r.body.data.placements[0]).toMatchObject({ validImpressions: 2, viewableImpressions: 1, viewabilityRate: 50, avgTimeInViewSec: 6 });
    // Not billable: spend is the two impressions only.
    const spend = (await h.db.query(`SELECT sum(cost_micros)::text AS s FROM ad_events`)).rows[0].s;
    expect(spend).toBe('8000');
  });
});

describe('conversion tracking', () => {
  async function enable(s: Setup, days?: number) {
    const r = await s.advCl.put(`/api/v1/orgs/${s.adv}/campaigns/${s.campaign}/conversion-tracking`, { enabled: true, ...(days ? { attributionWindowDays: days } : {}) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  async function validClick(s: Setup) {
    const ad = await serve(s, { referrer: 'https://www.bing.com/' });
    await events(s, [{ type: 'render', t: ad.token }]);
    await new Promise((r) => setTimeout(r, 320));
    const res = await click(s, ad.clickUrl);
    expect(res.statusCode).toBe(302);
    return res.headers.location as string;
  }

  it('adds the click id to the landing page only when tracking is on', async () => {
    const s = await setup();
    expect(new URL(await validClick(s)).searchParams.get('bn_click_id')).toBeNull();
    await enable(s);
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);
    const id = new URL(await validClick(s)).searchParams.get('bn_click_id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await h.db.query(`SELECT status FROM ad_events WHERE delivery_id = $1 AND type = 'click'`, [id])).rows[0];
    expect(row.status).toBe('valid');
  });

  it('records pixel and postback conversions once, attributed to the click, and reports CPA and ROAS', async () => {
    const s = await setup();
    await enable(s);
    const id = new URL(await validClick(s)).searchParams.get('bn_click_id')!;

    const px = await h.app.inject({ method: 'GET', url: `/api/v1/conversions/pixel?click_id=${id}&event=purchase&value=20.00&currency=USD&order_id=A1` });
    expect(px.statusCode).toBe(200);
    expect(px.headers['content-type']).toContain('image/gif');
    // Same order again (a reloaded thank-you page): ignored.
    await h.app.inject({ method: 'GET', url: `/api/v1/conversions/pixel?click_id=${id}&event=purchase&value=20.00&currency=USD&order_id=A1` });
    const pb = await h.app.inject({ method: 'POST', url: '/api/v1/conversions', payload: { click_id: id, event: 'signup' } });
    expect(JSON.parse(pb.body).data.status).toBe('recorded');
    const dup = await h.app.inject({ method: 'POST', url: '/api/v1/conversions', payload: { click_id: id, event: 'signup' } });
    expect(JSON.parse(dup.body).data.status).toBe('duplicate');

    const rows = (await h.db.query(`SELECT event_name, value_micros::text, method, source, os FROM conversions ORDER BY event_name`)).rows;
    expect(rows).toEqual([
      { event_name: 'purchase', value_micros: '20000000', method: 'pixel', source: 'search', os: 'macos' },
      { event_name: 'signup', value_micros: '0', method: 'postback', source: 'search', os: 'macos' },
    ]);

    await aggregate();
    const r = await s.advCl.get(`/api/v1/orgs/${s.adv}/analytics`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = r.body.data.totals;
    // One CPM impression at $4 = $0.004 spend.
    expect(t).toMatchObject({ validImpressions: 1, validClicks: 1, conversions: 2, conversionValueMicros: '20000000', conversionRate: 200, cpaMicros: '2000' });
    expect(t.roas).toBe(5000);
    expect(r.body.data.conversionEvents.map((e: any) => [e.event, e.conversions])).toEqual([['purchase', 1], ['signup', 1]]);
    expect(r.body.data.funnel.at(-1)).toMatchObject({ key: 'conversions', value: 2 });

    const settings = await s.advCl.get(`/api/v1/orgs/${s.adv}/campaigns/${s.campaign}/conversion-tracking`);
    expect(settings.body.data).toMatchObject({ enabled: true, attributionWindowDays: 30, totals: { conversions: 2, valueMicros: '20000000' } });
    expect(settings.body.data.pixelUrl).toContain('/api/v1/conversions/pixel?click_id={bn_click_id}');
  });

  it('rejects unknown clicks, invalid clicks, campaigns without tracking and clicks outside the window', async () => {
    const s = await setup();
    const post = async (body: Record<string, unknown>) => JSON.parse((await h.app.inject({ method: 'POST', url: '/api/v1/conversions', payload: body })).body).data;
    expect(await post({ click_id: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 'rejected', reason: 'unknown_click' });

    // A click with tracking off is not converted.
    const ad = await serve(s);
    await events(s, [{ type: 'render', t: ad.token }]);
    await new Promise((r) => setTimeout(r, 320));
    await click(s, ad.clickUrl);
    const d = (await h.db.query(`SELECT delivery_id FROM ad_events WHERE type = 'click'`)).rows[0].delivery_id;
    expect(await post({ click_id: d })).toEqual({ status: 'rejected', reason: 'tracking_off' });

    await enable(s, 1);
    await h.db.query(`UPDATE ad_events SET occurred_at = now() - interval '2 days' WHERE type = 'click'`);
    expect(await post({ click_id: d })).toEqual({ status: 'rejected', reason: 'outside_window' });
    await h.db.query(`UPDATE ad_events SET occurred_at = now(), status = 'invalid', invalid_reason = 'click_burst' WHERE type = 'click'`);
    expect(await post({ click_id: d })).toEqual({ status: 'rejected', reason: 'unknown_click' });
    // The pixel always answers with an image, even for bad input.
    const px = await h.app.inject({ method: 'GET', url: '/api/v1/conversions/pixel?click_id=nope' });
    expect(px.statusCode).toBe(200);
    expect((await h.db.query('SELECT count(*)::int AS n FROM conversions')).rows[0].n).toBe(0);
  });

  it('lets only the owning advertiser change conversion settings', async () => {
    const s = await setup();
    const other = await setup('other.example.org');
    expect([403, 404]).toContain((await other.advCl.put(`/api/v1/orgs/${s.adv}/campaigns/${s.campaign}/conversion-tracking`, { enabled: true })).status);
    expect((await other.advCl.put(`/api/v1/orgs/${other.adv}/campaigns/${s.campaign}/conversion-tracking`, { enabled: true })).status).toBe(404);
    expect((await s.pubCl.put(`/api/v1/orgs/${s.pub}/campaigns/${s.campaign}/conversion-tracking`, { enabled: true })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('analytics views', () => {
  it('compares with the previous period, fills the heatmap, lists invalid traffic by reason and stays inside the org', async () => {
    const s = await setup();
    const other = await setup('other.example.org');
    for (let i = 0; i < 3; i++) {
      const ad = await serve(s);
      await events(s, [{ type: 'render', t: ad.token }]);
    }
    const replay = await serve(s);
    await events(s, [{ type: 'render', t: replay.token }]);
    await events(s, [{ type: 'render', t: replay.token }]);
    const theirs = await serve(other);
    await events(other, [{ type: 'render', t: theirs.token }]);
    await aggregate();

    // Either setup's campaign can fill either site, and other test files share the client IP, so compare
    // each view with what was recorded for that org rather than with fixed numbers.
    const count = async (col: string, id: string) =>
      (await h.db.query(`SELECT count(*)::int AS n FROM ad_events WHERE type = 'render' AND status = 'valid' AND ${col} = $1`, [id])).rows[0].n as number;
    const valid = await count('advertiser_org_id', s.adv);
    const validPub = await count('publisher_org_id', s.pub);
    expect(validPub).toBeGreaterThanOrEqual(3);
    const r = await s.advCl.get(`/api/v1/orgs/${s.adv}/analytics`);
    const d = r.body.data;
    expect(d.totals.validImpressions).toBe(valid);
    expect(d.previous.validImpressions).toBe(0);
    expect(d.range.days).toBe(30);
    expect(d.heatmap.timezone).toBe('UTC');
    expect(d.heatmap.cells.reduce((a: number, c: any) => a + c.validImpressions, 0)).toBe(valid);
    expect(d.reach).toMatchObject({ available: true });
    expect(Array.isArray(d.insights)).toBe(true);

    const pub = await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics`);
    expect(pub.body.data.totals.validImpressions).toBe(validPub);
    expect(pub.body.data.ivt).toContainEqual({ type: 'render', reason: 'duplicate', events: 1 });
    // Another publisher's site id as a filter returns nothing of theirs.
    const leak = await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics?siteId=${other.site.id}`);
    expect(leak.body.data.totals.validImpressions).toBe(0);
    expect([403, 404]).toContain((await s.pubCl.get(`/api/v1/orgs/${other.pub}/analytics`)).status);

    const live = await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics/realtime`);
    expect(live.status).toBe(200);
    expect(live.body.data.minutes).toHaveLength(30);
    expect(live.body.data.totals.validImpressions).toBe(validPub);
    expect(live.body.data.activePages).toBe(1);
    expect(live.body.data.top[0].label).toBe('pub.example.org/a');

    // Admin analytics requires a platform role.
    expect((await s.pubCl.get('/api/v1/admin/analytics')).status).toBe(403);
  });

  it('exports the new columns in CSV', async () => {
    const s = await setup();
    const ad = await serve(s);
    await events(s, [{ type: 'render', t: ad.token }]);
    await aggregate();
    const csv = await s.advCl.get(`/api/v1/orgs/${s.adv}/reports/export?groupBy=browser`);
    expect(csv.status).toBe(200);
    const text = String(csv.body);
    expect(text).toContain('Viewability %');
    expect(text).toContain('ROAS');
    expect(text).toContain('chrome');
  });
});

describe('country report', () => {
  it('reads the country from the GeoIP database and reports every country with its share, page views and live counts', async () => {
    const { openGeoDb } = await import('@blissnova/api/lib/geo');
    const geo = openGeoDb(new URL('../fixtures/GeoIP2-Country-Test.mmdb', import.meta.url).pathname, () => undefined);
    expect(geo?.country('81.2.69.160')).toBe('GB');
    expect(geo?.country('127.0.0.1')).toBeNull();
    const saved = h.app.ctx.geo;
    h.app.ctx.geo = geo;
    try {
      const s = await setup();
      // Test-database addresses: 81.2.69.160 is GB, 216.160.83.56 is US; loopback is not in it.
      for (const ip of ['81.2.69.160', '81.2.69.160', '216.160.83.56', '127.0.0.1']) {
        const ad = await serve(s, { ip, referrer: 'https://www.google.com/' });
        await events(s, [{ type: 'render', t: ad.token }]);
      }
      await aggregate();
      const recorded = (await h.db.query(`SELECT country, count(*)::int AS n FROM ad_events WHERE type = 'render' AND status = 'valid' AND publisher_org_id = $1 GROUP BY 1`, [s.pub])).rows;
      const n = (c: string) => recorded.find((r) => r.country === c)?.n ?? 0;
      expect(n('GB') + n('US') + n('ZZ')).toBeGreaterThanOrEqual(3);

      const d = (await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics`)).body.data;
      const gb = d.countries.rows.find((r: any) => r.key === 'GB');
      expect(gb).toMatchObject({ validImpressions: n('GB'), previousValidImpressions: 0 });
      expect(gb.pageviews).toBeGreaterThanOrEqual(1);
      expect(gb.share).toBeCloseTo((n('GB') / d.totals.validImpressions) * 100, 5);
      expect(d.countries.count).toBe(d.countries.rows.filter((r: any) => r.key !== 'ZZ').length);
      expect(d.countries.rows.reduce((a: number, r: any) => a + r.validImpressions, 0)).toBe(d.totals.validImpressions);

      const live = (await s.pubCl.get(`/api/v1/orgs/${s.pub}/analytics/realtime`)).body.data;
      expect(live.countries.find((r: any) => r.country === 'GB')?.validImpressions).toBe(n('GB'));

      // A CDN header, when configured, wins over the database.
      const header = h.app.ctx.config.GEO_COUNTRY_HEADER;
      (h.app.ctx.config as any).GEO_COUNTRY_HEADER = 'cf-ipcountry';
      try {
        const r = await h.app.inject({
          method: 'POST', url: '/api/v1/serve', remoteAddress: '81.2.69.160', headers: { 'user-agent': BROWSER_UA, origin: `http://${s.domain}`, 'cf-ipcountry': 'DE' },
          payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: `http://${s.domain}/c` }, pv: uniq('pv0000000000') },
        });
        expect(r.statusCode).toBe(200);
        const served = (await h.db.query(`SELECT country FROM ad_events WHERE type = 'served' AND page_path = '/c' AND site_id = $1`, [s.site.id])).rows;
        expect(served.map((x) => x.country)).toEqual(['DE']);
      } finally {
        (h.app.ctx.config as any).GEO_COUNTRY_HEADER = header;
      }
    } finally {
      h.app.ctx.geo = saved;
    }
  });

  it('ignores a GeoIP path that is missing or not a database', async () => {
    const { openGeoDb } = await import('@blissnova/api/lib/geo');
    const warnings: string[] = [];
    expect(openGeoDb('', (m) => warnings.push(m))).toBeNull();
    expect(openGeoDb('/nonexistent/country.mmdb', (m) => warnings.push(m))).toBeNull();
    expect(openGeoDb(new URL('../../package.json', import.meta.url).pathname, (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(2);
  });
});

describe('scheduled report emails', () => {
  it('stores the choice per user, sends each complete period once and emails a sample on request', async () => {
    const s = await setup();
    const ad = await serve(s);
    await events(s, [{ type: 'render', t: ad.token }]);
    await aggregate();

    expect((await s.pubCl.get(`/api/v1/orgs/${s.pub}/report-email`)).body.data).toMatchObject({ frequency: 'off', nextSendAt: null });
    const on = await s.pubCl.put(`/api/v1/orgs/${s.pub}/report-email`, { frequency: 'daily' });
    expect(on.status).toBe(200);
    expect(on.body.data.frequency).toBe('daily');
    expect(typeof on.body.data.nextSendAt).toBe('string');

    const { sendDueReports } = await import('@blissnova/api/services/report-emails');
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setUTCHours(2, 0, 0, 0);
    const mails: Array<{ to: string; vars: Record<string, string> }> = [];
    const send = async (to: string, vars: Record<string, string>) => { mails.push({ to, vars }); };
    // The advertiser never subscribed, so only the publisher's user gets one; a second run sends nothing.
    expect(await sendDueReports(h.db, send, 'http://localhost:3000', tomorrow)).toBe(1);
    expect(await sendDueReports(h.db, send, 'http://localhost:3000', tomorrow)).toBe(0);
    expect(mails[0]!.vars.period).toBe(today());
    expect(mails[0]!.vars.report).toContain('Estimated earnings');
    expect(mails[0]!.vars.report).toMatch(/Valid impressions\s+\d/);
    expect(mails[0]!.vars.report).toContain('Top websites');
    expect(mails[0]!.vars.link).toBe('http://localhost:3000/publisher/analytics');
    // Before 01:00 UTC nothing goes out, so the day's aggregates can settle.
    const early = new Date(tomorrow.getTime() + 86_400_000); early.setUTCHours(0, 30, 0, 0);
    expect(await sendDueReports(h.db, send, 'http://localhost:3000', early)).toBe(0);

    expect((await s.pubCl.put(`/api/v1/orgs/${s.pub}/report-email`, { frequency: 'off' })).body.data.frequency).toBe('off');
    expect((await h.db.query('SELECT count(*)::int AS n FROM report_subscriptions')).rows[0].n).toBe(0);

    const sample = await s.advCl.post(`/api/v1/orgs/${s.adv}/report-email/test`, {});
    expect(sample.status).toBe(200);
    const queued = (await h.db.query(`SELECT to_address, subject, body_text FROM email_outbox WHERE template = 'performance_report'`)).rows;
    expect(queued).toHaveLength(1);
    expect(queued[0].to_address).toBe(sample.body.data.sentTo);
    expect(queued[0].body_text).toContain('Advertiser report for');
    expect(queued[0].body_text).toContain('CPA');

    // Another organization's setting is out of reach.
    expect([403, 404]).toContain((await s.pubCl.put(`/api/v1/orgs/${s.adv}/report-email`, { frequency: 'weekly' })).status);
  });
});
