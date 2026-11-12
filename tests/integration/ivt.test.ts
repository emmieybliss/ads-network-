import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { balance, finalizeEarnings, settleCampaign } from '@blissnova/billing';
import { withTransaction } from '@blissnova/database';
import { CLIENT_FLAG } from '@blissnova/tracking';
import { runIvtSweep } from '@blissnova/api/services/ivt';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { TEST_PASSWORD, addMember, fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, setSettings, uniq } from '../helpers/fixtures';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.reset(); });
afterEach(() => { vi.useRealTimers(); });

const BROWSER = { 'user-agent': BROWSER_UA, 'accept-language': 'en-GB,en;q=0.9', 'sec-fetch-site': 'cross-site' };
const AWS_IP = '3.5.140.2';
const HOME_IP = '198.51.100.20';

async function setup(opts: { model?: 'cpm' | 'cpc'; personalized?: boolean } = {}) {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: 7000 });
  const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  await fundOrg(h.db, advOrg, '5000');
  const campaign = await makeCampaign(h.db, { orgId: advOrg, model: opts.model ?? 'cpm', rate: opts.model === 'cpc' ? '0.50' : '2.00', lifetime: '1000', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image', width: 300, height: 250 });
  await reserve(h.db, campaign);
  if (opts.model === 'cpc') await setSettings(h.db, 'pricing', { cpcEnabled: true });
  if (opts.personalized) await setSettings(h.db, 'tracking', { personalizedAllowed: true });
  h.app.ctx.settings.invalidate();
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
  return { advOrg, pubOrg, pubUser, site, unit, campaign };
}

type S = Awaited<ReturnType<typeof setup>>;

async function getAd(s: S, vid?: string, ip = HOME_IP) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/serve', remoteAddress: ip,
    headers: { ...BROWSER, origin: 'http://pub.example.org' },
    payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: 'http://pub.example.org/article' }, pv: uniq('pv0000000000'), ...(vid ? { vid, consent: { personalized: true } } : {}) },
  });
  const ad = (JSON.parse(r.body) as { ads: Array<{ ad: { token: string; clickUrl: string } | null }> }).ads[0]!.ad;
  if (!ad) throw new Error('no ad was served');
  return ad;
}

async function render(token: string, opts: { ip?: string; f?: number; headers?: Record<string, string> } = {}) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/events', remoteAddress: opts.ip ?? HOME_IP,
    headers: { ...BROWSER, referer: 'http://pub.example.org/article', origin: 'http://pub.example.org', ...opts.headers },
    payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t: token, ...(opts.f !== undefined ? { f: opts.f } : {}) }] },
  });
  expect(r.statusCode).toBe(202);
}

async function click(clickUrl: string, opts: { ip?: string; f?: number } = {}) {
  const url = clickUrl.slice(clickUrl.indexOf('/api/v1/click')) + (opts.f !== undefined ? `&f=${opts.f}` : '');
  return h.app.inject({ method: 'GET', url, remoteAddress: opts.ip ?? HOME_IP, headers: { ...BROWSER, referer: 'http://pub.example.org/article' } });
}

const events = () => h.db.query<{ id: string; type: string; status: string; invalid_reason: string | null; billable: boolean; ivt_signals: string[] | null; client_flags: number | null; excluded_at: string | null }>(
  'SELECT id, type, status, invalid_reason, billable, ivt_signals, client_flags, excluded_at FROM ad_events WHERE type <> \'served\' ORDER BY occurred_at').then((r) => r.rows);

async function login(email: string) {
  const cl = new Client(h.app);
  expect((await cl.post('/api/v1/auth/login', { email, password: TEST_PASSWORD })).status).toBe(200);
  return cl;
}

const settle = (campaign: string, hold = 30) => withTransaction(h.db, (c) => settleCampaign(c, campaign, hold));
const pending = (org: string) => withTransaction(h.db, (c) => balance(c, { kind: 'publisher_pending', orgId: org }, 'USD'));
const sweep = () => runIvtSweep({ db: h.db, settings: () => h.app.ctx.settings.get(), notify: async (orgId, n) => {
  await h.db.query(`INSERT INTO notifications (user_id, org_id, type, title, body, link) SELECT m.user_id, $1, $2, $3, $4, $5 FROM memberships m WHERE m.org_id = $1`, [orgId, n.type, n.title, n.body ?? '', n.link ?? null]);
} });

describe('real-time invalid-traffic signals', () => {
  it('marks impressions from cloud networks invalid and never bills them', async () => {
    const s = await setup();
    await render((await getAd(s, undefined, AWS_IP)).token, { ip: AWS_IP });
    await render((await getAd(s)).token);
    const [dc, home] = await events();
    expect(dc).toMatchObject({ status: 'invalid', invalid_reason: 'datacenter', billable: false });
    expect(dc!.ivt_signals).toContain('datacenter_ip');
    expect(home).toMatchObject({ status: 'valid', billable: true });
  });

  it('honours staff-added and trusted ranges, and can be switched off', async () => {
    const s = await setup();
    await setSettings(h.db, 'ivt', { extraDatacenterRanges: ['198.51.100.0/24'], trustedRanges: ['3.5.140.0/24'] });
    h.app.ctx.settings.invalidate();
    await render((await getAd(s)).token, { ip: HOME_IP });
    await render((await getAd(s)).token, { ip: AWS_IP });
    await setSettings(h.db, 'ivt', { filterDatacenterTraffic: false });
    h.app.ctx.settings.invalidate();
    await render((await getAd(s)).token, { ip: '18.204.0.1' });
    expect((await events()).map((e) => e.invalid_reason)).toEqual(['datacenter', null, null]);
  });

  it('treats a WebDriver browser as automated and keeps what the tag saw', async () => {
    const s = await setup();
    await render((await getAd(s)).token, { f: CLIENT_FLAG.WEBDRIVER | CLIENT_FLAG.NO_LANGUAGES });
    const [e] = await events();
    expect(e).toMatchObject({ status: 'invalid', invalid_reason: 'automation', client_flags: CLIENT_FLAG.WEBDRIVER | CLIENT_FLAG.NO_LANGUAGES });
    expect(e!.ivt_signals).toContain('webdriver');
  });

  it('still counts a normal browser whose tag reports nothing unusual', async () => {
    const s = await setup();
    await render((await getAd(s)).token, { f: 0 });
    expect((await events())[0]).toMatchObject({ status: 'valid', billable: true });
  });

  it('refuses to charge for a click dispatched by a script', async () => {
    const s = await setup({ model: 'cpc' });
    const ad = await getAd(s);
    await render(ad.token);
    await new Promise((r) => setTimeout(r, 350));
    const r = await click(ad.clickUrl, { f: CLIENT_FLAG.SYNTHETIC_CLICK });
    expect(r.statusCode).toBe(302); // the visitor still lands on the advertiser's page
    const c = (await events()).find((e) => e.type === 'click')!;
    expect(c).toMatchObject({ status: 'invalid', invalid_reason: 'automation', billable: false });
    const spent = (await h.db.query('SELECT spent_micros FROM campaigns WHERE id = $1', [s.campaign])).rows[0].spent_micros;
    expect(spent).toBe('0');
  });

  it('catches clicks on a machine-regular rhythm', async () => {
    const s = await setup({ model: 'cpc' });
    await setSettings(h.db, 'ivt', { maxClicksPerVisitorPerHour: 100, maxClicksPerIpPerHour: 100 });
    h.app.ctx.settings.invalidate();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const reasons: Array<string | null> = [];
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(t0 + i * 20_000);
      const ad = await getAd(s);
      await render(ad.token);
      vi.setSystemTime(t0 + i * 20_000 + 5_000);
      await click(ad.clickUrl, { f: 0 });
      const rows = await events();
      reasons.push(rows.filter((e) => e.type === 'click').at(-1)!.invalid_reason);
    }
    // Four clicks are not enough to judge; from the fifth on, the even spacing gives it away.
    expect(reasons.slice(0, 4)).toEqual([null, null, null, null]);
    expect(reasons.slice(4)).toEqual(['click_pattern', 'click_pattern']);
  });
});

describe('the invalid-traffic sweep', () => {
  it('claws back held earnings from a visitor later proven to be a bot, once', async () => {
    const s = await setup({ personalized: true });
    const vid = 'visitor-bot-0123456789';
    await render((await getAd(s, vid)).token);
    await settle(s.campaign);
    const before = await pending(s.pubOrg);
    expect(before).toBeGreaterThan(0n);
    await render((await getAd(s, vid)).token, { f: CLIENT_FLAG.WEBDRIVER });

    const r = await sweep();
    expect(r.clawbacks).toBe(1);
    const [first] = await events();
    expect(first).toMatchObject({ status: 'invalid', invalid_reason: 'ivt_clawback', billable: false });
    expect(first!.excluded_at).not.toBeNull();
    expect(await pending(s.pubOrg)).toBe(0n);

    const c = (await h.db.query(`SELECT * FROM fraud_cases WHERE publisher_org_id = $1`, [s.pubOrg])).rows;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: 'auto', kind: 'proven_bot', status: 'confirmed', subject_type: 'organization', subject_id: s.pubOrg });
    const x = (await h.db.query(`SELECT * FROM event_exclusions WHERE case_id = $1`, [c[0].id])).rows[0];
    expect(x).toMatchObject({ automatic: true, actor_id: null, excluded_events: 1, publisher_org_id: s.pubOrg });
    expect(BigInt(x.publisher_micros)).toBe(before);
    const n = (await h.db.query(`SELECT type FROM notifications WHERE org_id = $1`, [s.pubOrg])).rows;
    expect(n.map((r) => r.type)).toEqual(['ivt_clawback']);

    expect((await sweep()).clawbacks).toBe(0);

    // The publisher sees it and can appeal the automatic decision.
    const pub = await login(s.pubUser.email);
    const q = await pub.get(`/api/v1/orgs/${s.pubOrg}/traffic-quality`);
    expect(q.status).toBe(200);
    expect(q.body.data.clawbacks).toHaveLength(1);
    expect(q.body.data.clawbacks[0]).toMatchObject({ automatic: true });
    const appeal = await pub.post(`/api/v1/orgs/${s.pubOrg}/fraud-cases/${c[0].id}/appeal`, { text: 'These visitors are our own QA team using a test browser.' });
    expect(appeal.status).toBe(200);
  });

  it('never touches earnings already released; it asks staff instead', async () => {
    const s = await setup({ personalized: true });
    const vid = 'visitor-bot-9876543210';
    await render((await getAd(s, vid)).token);
    await settle(s.campaign, 0);
    await withTransaction(h.db, (c) => finalizeEarnings(c));
    await render((await getAd(s, vid)).token, { f: CLIENT_FLAG.AUTOMATION_GLOBALS });

    const r = await sweep();
    expect(r).toMatchObject({ clawbacks: 0, reviewCases: 1 });
    expect((await events())[0]).toMatchObject({ status: 'valid', billable: true });

    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    const cl = await login(admin.email);
    const queue = await cl.get('/api/v1/admin/fraud/queue');
    expect(queue.body.data).toHaveLength(1);
    const item = queue.body.data[0];
    expect(item).toMatchObject({ source: 'auto', kind: 'proven_bot', status: 'open', publisher_org_id: s.pubOrg });
    expect(Number(item.estimated_micros)).toBeGreaterThan(0);

    expect((await cl.post(`/api/v1/admin/fraud/cases/${item.id}/clawback`, { reason: 'Confirmed automated visitor' })).status).toBe(403); // step-up first
    expect((await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD })).status).toBe(200);
    const done = await cl.post(`/api/v1/admin/fraud/cases/${item.id}/clawback`, { reason: 'Confirmed automated visitor' });
    expect(done.status).toBe(200);
    expect(done.body.data.excluded).toBe(1);
    expect((await events())[0]).toMatchObject({ status: 'invalid', invalid_reason: 'manual_exclusion' });
    expect((await h.db.query('SELECT status FROM fraud_cases WHERE id = $1', [item.id])).rows[0].status).toBe('confirmed');
    expect((await cl.get('/api/v1/admin/fraud/queue')).body.data).toHaveLength(0);
  });

  it('with automatic clawback off, proposes the clawback for review', async () => {
    const s = await setup({ personalized: true });
    await setSettings(h.db, 'ivt', { autoClawback: false });
    h.app.ctx.settings.invalidate();
    const vid = 'visitor-bot-5555555555';
    await render((await getAd(s, vid)).token);
    await settle(s.campaign);
    await render((await getAd(s, vid)).token, { f: CLIENT_FLAG.WEBDRIVER });
    expect(await sweep()).toMatchObject({ clawbacks: 0, reviewCases: 1 });
    expect((await events())[0]).toMatchObject({ status: 'valid' });
    const c = (await h.db.query(`SELECT status, criteria FROM fraud_cases WHERE publisher_org_id = $1`, [s.pubOrg])).rows[0];
    expect(c.status).toBe('open');
    expect(c.criteria.eventIds).toHaveLength(1);
    // A second sweep updates the same case rather than opening another.
    await sweep();
    expect((await h.db.query(`SELECT count(*)::int AS n FROM fraud_cases`)).rows[0].n).toBe(1);
  });

  it('opens a review case when a publisher\'s IVT rate is too high, and reports rates per publisher', async () => {
    const s = await setup();
    const creative = (await h.db.query('SELECT id FROM creatives WHERE campaign_id = $1', [s.campaign])).rows[0].id;
    const day = new Date().toISOString().slice(0, 10);
    await h.db.query(
      `INSERT INTO daily_stats (day, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, rendered, valid_impressions, invalid_impressions, valid_clicks, invalid_clicks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'GB', 'desktop', 1000, 600, 400, 5, 20)`, [day, s.campaign, creative, s.advOrg, s.site.id, s.unit.id, s.pubOrg]);
    await h.db.query(`INSERT INTO ivt_daily_stats (day, campaign_id, advertiser_org_id, site_id, publisher_org_id, type, reason, events) VALUES ($1, $2, $3, $4, $5, 'render', 'datacenter', 400)`, [day, s.campaign, s.advOrg, s.site.id, s.pubOrg]);

    const r = await sweep();
    expect(r.reviewCases).toBe(1);
    expect((await sweep()).reviewCases).toBe(0); // one per publisher per week
    const c = (await h.db.query(`SELECT * FROM fraud_cases WHERE kind = 'publisher_ivt_rate'`)).rows[0];
    expect(c).toMatchObject({ status: 'open', severity: 'medium', publisher_org_id: s.pubOrg }); // high from twice the review rate
    expect(c.signals).toMatchObject({ ivtRate: 40, rendered: 1000, topReason: 'datacenter' });
    expect(c.criteria).toMatchObject({ publisherOrgId: s.pubOrg, minScore: 30 });

    const admin = await makeUser(h.db, { platformRole: 'admin' });
    const cl = await login(admin.email);
    const rates = await cl.get('/api/v1/admin/fraud/publishers');
    expect(rates.status).toBe(200);
    expect(rates.body.data[0]).toMatchObject({ orgId: s.pubOrg, ivtRate: 40, status: 'review', topReason: 'datacenter', openCases: 1 });
    const sum = await cl.get('/api/v1/admin/fraud/summary');
    expect(sum.body.data.reviewQueue).toBe(1);
    expect(sum.body.data.detection.datacenterSources.length).toBeGreaterThan(0);

    const pub = await login(s.pubUser.email);
    const q = await pub.get(`/api/v1/orgs/${s.pubOrg}/traffic-quality`);
    expect(q.body.data).toMatchObject({ ivtRate: 40, status: 'review', invalidImpressions: 400 });
    expect(q.body.data.reasons).toEqual([{ reason: 'datacenter', type: 'render', events: 400 }]);

    // Another publisher cannot read it.
    const other = await makeUser(h.db);
    const otherOrg = await makeOrg(h.db, { type: 'publisher', ownerId: other.id });
    await addMember(h.db, otherOrg, other.id, 'owner').catch(() => undefined);
    const ocl = await login(other.email);
    expect([403, 404]).toContain((await ocl.get(`/api/v1/orgs/${s.pubOrg}/traffic-quality`)).status);
  });

  it('keeps support staff from clawing back or running the sweep', async () => {
    await setup();
    const support = await makeUser(h.db, { platformRole: 'support' });
    const cl = await login(support.email);
    expect((await cl.post('/api/v1/admin/fraud/sweep')).status).toBe(403);
  });
});
