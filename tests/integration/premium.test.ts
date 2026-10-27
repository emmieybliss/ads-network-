import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyGuarantee, balance, finalizeEarnings, reconcile } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { createHarness, type Harness } from '../helpers/app';
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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const today = () => new Date().toISOString().slice(0, 10);

async function inTx<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await h.db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

const pending = (orgId: string) => inTx((c) => balance(c, { kind: 'publisher_pending', orgId }, 'USD'));

async function setPremium(orgId: string, terms: { mode: 'floor' | 'guarantee' | null; minCpm?: string; minCpc?: string; cap?: string; premiumOnly?: boolean }) {
  await h.db.query(
    `UPDATE organizations SET tier = 'premium', earnings_mode = $2, min_cpm_micros = $3, min_cpc_micros = $4, guarantee_monthly_cap_micros = $5, premium_advertisers_only = $6 WHERE id = $1`,
    [orgId, terms.mode, terms.minCpm ? toMicros(terms.minCpm).toString() : null, terms.minCpc ? toMicros(terms.minCpc).toString() : null, terms.cap ? toMicros(terms.cap).toString() : null, terms.premiumOnly ?? false],
  );
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
}

/** A publisher with one site and unit, and an advertiser with a funded CPM campaign. */
async function network(opts: { cpm: string; shareBps: number }) {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: opts.shareBps });
  const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org', formats: ['image', 'text', 'native'] });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'] });
  await fundOrg(h.db, advOrg, '5000');
  const campaign = await makeCampaign(h.db, { orgId: advOrg, rate: opts.cpm, lifetime: '1000', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image' });
  await reserve(h.db, campaign);
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
  return { advUser, pubUser, advOrg, pubOrg, site, unit, campaign };
}

async function serve(siteKey: string, slot: string) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/serve',
    headers: { 'user-agent': UA, origin: 'http://pub.example.org' },
    payload: { siteKey, units: [{ slot }], page: { url: 'http://pub.example.org/a' }, pv: uniq('pv0000000000') },
  });
  return JSON.parse(r.body).ads[0].ad as null | { token: string; format: string; native?: Record<string, string> };
}

async function deliver(n: { site: { publicKey: string }; unit: { key: string } }, impressions: number) {
  for (let i = 0; i < impressions; i++) {
    const ad = await serve(n.site.publicKey, n.unit.key);
    if (!ad) throw new Error('no ad served');
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'user-agent': UA, referer: 'http://pub.example.org/a' },
      payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t: ad.token }] },
    });
  }
}

describe('premium publisher price floor', () => {
  it('serves nothing when no campaign pays the publisher at least the floor', async () => {
    // A $10 CPM at a 50% share pays the publisher $5, under a $10 floor.
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    expect(await serve(n.site.publicKey, n.unit.key)).not.toBeNull();
    await setPremium(n.pubOrg, { mode: 'floor', minCpm: '10' });
    expect(await serve(n.site.publicKey, n.unit.key)).toBeNull();
  });

  it('serves a campaign whose publisher share meets the floor', async () => {
    const n = await network({ cpm: '20.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: 'floor', minCpm: '10' });
    expect(await serve(n.site.publicKey, n.unit.key)).not.toBeNull();
  });

  it('serves only premium advertisers when the publisher reserves its inventory for them', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: null, premiumOnly: true });
    expect(await serve(n.site.publicKey, n.unit.key)).toBeNull();
    await h.db.query(`UPDATE organizations SET tier = 'premium' WHERE id = $1`, [n.advOrg]);
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);
    expect(await serve(n.site.publicKey, n.unit.key)).not.toBeNull();
  });
});

describe('premium publisher guarantee', () => {
  it('tops up a day\'s valid earnings to the minimum from network funds', async () => {
    // 100 impressions at a $10 CPM and 50% share earn the publisher $0.50.
    // A $10 minimum per 1,000 requires $1.00, so the top-up is $0.50.
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: 'guarantee', minCpm: '10', cap: '100' });
    await deliver(n, 100);
    const before = await pending(n.pubOrg);
    const g = await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30));
    expect(g).toMatchObject({ required: toMicros('1'), earned: toMicros('0.50'), shortfall: toMicros('0.50'), topup: toMicros('0.50'), capped: false, created: true });
    expect((await pending(n.pubOrg)) - before).toBe(toMicros('0.50'));
    const expense = await inTx((c) => balance(c, { kind: 'guarantee_expense' }, 'USD'));
    expect(expense).toBe(toMicros('0.50'));
  });

  it('applies a day only once', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: 'guarantee', minCpm: '10', cap: '100' });
    await deliver(n, 20);
    await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30));
    const again = await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30));
    expect(again!.created).toBe(false);
    const txns = await h.db.query(`SELECT 1 FROM ledger_transactions WHERE type = 'guarantee_topup'`);
    expect(txns.rowCount).toBe(1);
  });

  it('never pays more than the monthly cap', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: 'guarantee', minCpm: '10', cap: '0.20' });
    await deliver(n, 100);
    const g = await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30));
    expect(g!.topup).toBe(toMicros('0.20'));
    expect(g!.capped).toBe(true);
  });

  it('pays nothing when earnings already meet the minimum', async () => {
    const n = await network({ cpm: '30.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: 'guarantee', minCpm: '10', cap: '100' });
    await deliver(n, 10);
    const g = await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30));
    expect(g!.topup).toBe(0n);
    expect((await h.db.query(`SELECT 1 FROM ledger_transactions WHERE type = 'guarantee_topup'`)).rowCount).toBe(0);
  });

  it('does nothing for a publisher without a guarantee', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    await deliver(n, 10);
    expect(await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30))).toBeNull();
    await setPremium(n.pubOrg, { mode: 'floor', minCpm: '1' });
    expect(await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 30))).toBeNull();
  });

  it('releases top-ups after the hold period and keeps the ledger reconciled', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    await setPremium(n.pubOrg, { mode: 'guarantee', minCpm: '10', cap: '100' });
    await deliver(n, 100);
    await inTx((c) => applyGuarantee(c, n.pubOrg, today(), 0));
    await inTx((c) => finalizeEarnings(c));
    const available = await inTx((c) => balance(c, { kind: 'publisher_available', orgId: n.pubOrg }, 'USD'));
    expect(available).toBe(toMicros('0.50'));
    const checks = await reconcile(h.db);
    expect(checks.filter((c) => !c.ok).map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    expect(checks.some((c) => /guarantee/i.test(c.name))).toBe(true);
  });
});

describe('admin premium settings', () => {
  async function admin() {
    const u = await makeUser(h.db, { platformRole: 'super_admin' });
    const cl = new Client(h.app);
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    return cl;
  }

  it('requires step-up and records an audit entry', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    const cl = await admin();
    const body = { tier: 'premium', earningsMode: 'floor', minCpm: '10.00', minCpc: '0.50', premiumAdvertisersOnly: false, reason: 'Premium agreement signed' };
    expect((await cl.patch(`/api/v1/admin/orgs/${n.pubOrg}/premium`, body)).status).toBe(403);
    expect((await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD })).status).toBe(200);
    const ok = await cl.patch(`/api/v1/admin/orgs/${n.pubOrg}/premium`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const o = (await h.db.query('SELECT tier, earnings_mode, min_cpm_micros, min_cpc_micros FROM organizations WHERE id = $1', [n.pubOrg])).rows[0];
    expect(o).toEqual({ tier: 'premium', earnings_mode: 'floor', min_cpm_micros: toMicros('10').toString(), min_cpc_micros: toMicros('0.50').toString() });
    const a = await h.db.query(`SELECT reason FROM audit_logs WHERE action = 'organization.premium' AND resource_id = $1`, [n.pubOrg]);
    expect(a.rows[0]!.reason).toBe('Premium agreement signed');
  });

  it('refuses inconsistent terms', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    const cl = await admin();
    await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD });
    const url = `/api/v1/admin/orgs/${n.pubOrg}/premium`;
    const reason = 'Testing validation';
    expect((await cl.patch(url, { tier: 'standard', earningsMode: 'floor', minCpm: '10', reason })).status).toBe(400);
    expect((await cl.patch(url, { tier: 'premium', earningsMode: 'floor', reason })).status).toBe(400);
    expect((await cl.patch(url, { tier: 'premium', earningsMode: 'guarantee', minCpm: '10', reason })).status).toBe(400);
    expect((await cl.patch(`/api/v1/admin/orgs/${n.advOrg}/premium`, { tier: 'premium', earningsMode: 'floor', minCpm: '10', reason })).status).toBe(400);
    expect((await cl.patch(`/api/v1/admin/orgs/${n.advOrg}/premium`, { tier: 'premium', reason })).status).toBe(200);
  });

  it('is not available to roles without pricing rights', async () => {
    const n = await network({ cpm: '10.00', shareBps: 5000 });
    const u = await makeUser(h.db, { platformRole: 'support' });
    const cl = new Client(h.app);
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD });
    expect((await cl.patch(`/api/v1/admin/orgs/${n.pubOrg}/premium`, { tier: 'premium', reason: 'Not allowed' })).status).toBe(403);
  });
});

describe('native ads', () => {
  async function advertiser() {
    const u = await makeUser(h.db);
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: u.id });
    const cl = new Client(h.app);
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const sha = randomBytes(32).toString('hex');
    const asset = (await h.db.query<{ id: string }>(
      `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key) VALUES ($1, $2, 'image/png', 120, 1200, 628, $3) RETURNING id`,
      [org, sha, `test/${sha}.png`])).rows[0]!.id;
    const campaign = await makeCampaign(h.db, { orgId: org, status: 'draft' });
    return { org, cl, asset, campaign };
  }

  const nativeBody = (assetId: string) => ({
    name: 'Native card', format: 'native', assetId, altText: 'A cup of coffee', headline: 'Fresh coffee, every week',
    body: 'A demonstration native advertisement.', cta: 'See the offer', sponsorName: 'Demo Coffee Co', destinationUrl: 'https://example.com/coffee',
  });

  it('requires an image, a headline and a sponsor name', async () => {
    const a = await advertiser();
    const url = `/api/v1/orgs/${a.org}/campaigns/${a.campaign}/creatives`;
    const { sponsorName: _s, ...noSponsor } = nativeBody(a.asset);
    const { assetId: _a, ...noImage } = nativeBody(a.asset);
    expect((await a.cl.post(url, noSponsor)).status).toBe(400);
    expect((await a.cl.post(url, noImage)).status).toBe(400);
    const ok = await a.cl.post(url, nativeBody(a.asset));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.sponsorName).toBe('Demo Coffee Co');
  });

  it('refuses a sponsor name on a non-native creative', async () => {
    const a = await advertiser();
    const text = await a.cl.post(`/api/v1/orgs/${a.org}/campaigns/${a.campaign}/creatives`, { name: 'Text', format: 'text', headline: 'Hello', destinationUrl: 'https://example.com/' });
    expect(text.status).toBe(201);
    expect((await a.cl.patch(`/api/v1/orgs/${a.org}/creatives/${text.body.data.id}`, { sponsorName: 'Sneaky' })).status).toBe(400);
  });

  it('serves a native ad with its sponsor disclosure', async () => {
    const a = await advertiser();
    const created = await a.cl.post(`/api/v1/orgs/${a.org}/campaigns/${a.campaign}/creatives`, nativeBody(a.asset));
    await h.db.query(`UPDATE creatives SET status = 'approved', approved_version = version WHERE id = $1`, [created.body.data.id]);
    await h.db.query(`UPDATE campaigns SET status = 'active' WHERE id = $1`, [a.campaign]);
    await fundOrg(h.db, a.org, '2000');
    await reserve(h.db, a.campaign);
    const pubUser = await makeUser(h.db);
    const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
    const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org', formats: ['image', 'text', 'native'] });
    const unit = await makeUnit(h.db, { siteId: site.id, formats: ['native'], width: null, height: null, responsive: true });
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);
    const ad = await serve(site.publicKey, unit.key);
    expect(ad?.format).toBe('native');
    expect(ad?.native).toMatchObject({ headline: 'Fresh coffee, every week', sponsor: 'Demo Coffee Co', cta: 'See the offer' });
    expect(ad?.native?.imageUrl).toMatch(/\/assets\//);
  });
});
