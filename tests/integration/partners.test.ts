import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balance, reconcile } from '@blissnova/billing';
import { productionProblems } from '@blissnova/api/config';
import { PartnerRegistry, syncPartnerCampaigns } from '@blissnova/api/services/partners';
import { toMicros } from '@blissnova/shared';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeOrg, makeUser, reserve, setSettings, TEST_PASSWORD } from '../helpers/fixtures';

let h: Harness;
let clock = Date.now();
const MIN = 60_000;

beforeAll(async () => {
  h = await createHarness({ ENABLE_DEV_PARTNER_SIMULATOR: 'true' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  clock = Date.now();
  h.app.ctx.partners = new PartnerRegistry(h.config, h.redis, { now: () => clock, reviewMs: MIN });
  await h.db.query(`UPDATE partner_networks SET enabled = false, markup_bps = 2500, min_cpc_micros = 10000`);
  await setSettings(h.db, 'pricing', { cpcEnabled: true });
});

const sync = (campaignId?: string) => syncPartnerCampaigns({ db: h.db, partners: h.app.ctx.partners, publicUrl: (k) => `http://assets.test/${k}`, log: { warn: () => undefined } }, { campaignId });

async function login(email: string) {
  const cl = new Client(h.app);
  const r = await cl.post('/api/v1/auth/login', { email, password: TEST_PASSWORD });
  expect(r.status).toBe(200);
  return cl;
}

async function nativeAd(campaignId: string, orgId: string, headline = 'A calmer way to plan your week') {
  const sha = randomBytes(32).toString('hex');
  const asset = (await h.db.query(`INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key) VALUES ($1, $2, 'image/png', 120, 600, 314, $3) RETURNING id`, [orgId, sha, `test/${sha}.png`])).rows[0].id;
  const id = (await h.db.query(
    `INSERT INTO creatives (campaign_id, org_id, name, format, status, version, approved_version, headline, body, asset_id, width, height, destination_url, sponsor_name)
     VALUES ($1, $2, 'Native', 'native', 'approved', 1, 1, $3, 'Short body', $4, 600, 314, 'https://example.com/plan', 'Example Co') RETURNING id`, [campaignId, orgId, headline, asset])).rows[0].id;
  await h.db.query(`INSERT INTO creative_versions (creative_id, version, snapshot) VALUES ($1, 1, $2)`,
    [id, JSON.stringify({ format: 'native', headline, body: 'Short body', storageKey: `test/${sha}.png`, destinationUrl: 'https://example.com/plan', sponsorName: 'Example Co' })]);
  return id;
}

/** An admin who has switched the simulated partner on, and an advertiser with a funded, live CPC campaign that has a native ad. */
async function setup(opts: { lifetime?: string; daily?: string | null; model?: 'cpc' | 'cpm'; rate?: string; headline?: string } = {}) {
  const admin = await makeUser(h.db, { platformRole: 'super_admin' });
  const owner = await makeUser(h.db);
  const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.id });
  await fundOrg(h.db, org, '2000');
  const campaign = await makeCampaign(h.db, { orgId: org, model: opts.model ?? 'cpc', rate: opts.rate ?? '0.50', lifetime: opts.lifetime ?? '500', daily: opts.daily === undefined ? null : opts.daily });
  await reserve(h.db, campaign);
  await nativeAd(campaign, org, opts.headline);
  const adminCl = await login(admin.email);
  expect((await adminCl.patch('/api/v1/admin/partners/simulated', { enabled: true, reason: 'Local demo' })).status).toBe(200);
  const adv = await login(owner.email);
  return { org, campaign, adv, adminCl };
}

const pc = async (campaignId: string) => (await h.db.query(`SELECT * FROM partner_campaigns WHERE campaign_id = $1`, [campaignId])).rows[0];
const inTx = async <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => {
  const c = await h.db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } finally {
    c.release();
  }
};

describe('partner networks: production safety', () => {
  it('refuses to start in production with the partner simulator enabled', () => {
    const problems = productionProblems({ ...h.config, ENABLE_DEV_PARTNER_SIMULATOR: true }, ['https://ads.example.org']);
    expect(problems.some((p) => p.includes('ENABLE_DEV_PARTNER_SIMULATOR'))).toBe(true);
  });

  it('never registers the simulator in production, even if the flag were set', () => {
    const reg = new PartnerRegistry({ ...h.config, ENABLE_DEV_PARTNER_SIMULATOR: true, isProd: true }, h.redis);
    expect(reg.get('simulated')).toBeUndefined();
    expect(reg.describe('simulated').available).toBe(false);
  });

  it('hides the simulator from staff and refuses to switch on a network that is not connected', async () => {
    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    const cl = await login(admin.email);
    h.app.ctx.partners = new PartnerRegistry({ ...h.config, ENABLE_DEV_PARTNER_SIMULATOR: false }, h.redis);
    const list = await cl.get('/api/v1/admin/partners');
    expect(list.status).toBe(200);
    const ids = list.body.data.map((n: any) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['mgid', 'revcontent', 'taboola', 'outbrain']));
    expect(ids).not.toContain('simulated');
    expect(list.body.data.every((n: any) => n.available === false)).toBe(true);
    const r = await cl.patch('/api/v1/admin/partners/mgid', { enabled: true, reason: 'Try it' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not connected/);
  });

  it('lets only pricing managers change markup', async () => {
    const support = await makeUser(h.db, { platformRole: 'support' });
    const cl = await login(support.email);
    expect((await cl.patch('/api/v1/admin/partners/simulated', { markupPercent: 5, reason: 'Cheaper' })).status).toBe(403);
  });
});

describe('partner networks: advertiser choice', () => {
  it('offers enabled networks and saves a budget share', async () => {
    const { org, campaign, adv } = await setup();
    const offered = await adv.get(`/api/v1/orgs/${org}/partner-networks`);
    expect(offered.body.data.map((n: any) => n.id)).toEqual(['simulated']);
    expect(offered.body.data[0].serviceFeePercent).toBe(25);
    const r = await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 40 }] });
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ networkId: 'simulated', budgetPercent: 40 });
    // Saving pushes it to the partner straight away because the campaign is live.
    expect(r.body.data[0].status).toBe('in_review');
  });

  it('refuses CPM campaigns, disabled networks, shares over 100% and bids under the partner minimum', async () => {
    const { org, campaign, adv, adminCl } = await setup();
    expect((await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'mgid', budgetPercent: 10 }] })).status).toBe(400);
    expect((await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 101 }] })).status).toBe(400);
    const cpm = await makeCampaign(h.db, { orgId: org, model: 'cpm', rate: '3.00', lifetime: '100' });
    await nativeAd(cpm, org);
    const r = await adv.put(`/api/v1/orgs/${org}/campaigns/${cpm}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 10 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/cost-per-click/);
    await adminCl.patch('/api/v1/admin/partners/simulated', { minCpc: '1.00', reason: 'Raise the floor' });
    const low = await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 10 }] });
    expect(low.status).toBe(400);
    expect(low.body.error.message).toMatch(/at least 1\.25/);
  });

  it('does not let another advertiser read or change the distribution', async () => {
    const { org, campaign } = await setup();
    const other = await makeUser(h.db);
    await makeOrg(h.db, { type: 'advertiser', ownerId: other.id });
    const cl = await login(other.email);
    expect([403, 404]).toContain((await cl.get(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`)).status);
    expect([403, 404]).toContain((await cl.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [] })).status);
  });
});

describe('partner networks: sync and billing', () => {
  it('runs the campaign on the partner, then charges cost plus markup and keeps the books balanced', async () => {
    const { org, campaign, adv } = await setup();
    await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 40 }] });
    clock += 2 * MIN;
    await sync();
    expect((await pc(campaign)).status).toBe('active');
    const ads = (await h.db.query(`SELECT status FROM partner_creatives`)).rows;
    expect(ads).toEqual([{ status: 'approved' }]);

    clock += 30 * MIN;
    await sync();
    const row = await pc(campaign);
    expect(Number(row.clicks)).toBeGreaterThan(0);
    expect(BigInt(row.cost_micros)).toBeGreaterThan(0n);
    // Default 25% markup: the advertiser pays partner cost x 1.25.
    expect(BigInt(row.charged_micros)).toBe(BigInt(row.cost_micros) + (BigInt(row.cost_micros) * 2500n) / 10_000n);
    const c = (await h.db.query('SELECT spent_micros FROM campaigns WHERE id = $1', [campaign])).rows[0];
    expect(c.spent_micros).toBe(row.charged_micros);
    expect(await inTx((cl) => balance(cl, { kind: 'partner_payable' }, 'USD'))).toBe(BigInt(row.cost_micros));

    // Another pass with no new delivery charges nothing more.
    await sync();
    expect((await pc(campaign)).charged_micros).toBe(row.charged_micros);
    for (const check of await reconcile(h.db)) expect(check.ok, `${check.name}: ${JSON.stringify(check.rows)}`).toBe(true);

    const report = await adv.get(`/api/v1/orgs/${org}/reports/sources?campaignId=${campaign}`);
    const partnerRow = report.body.data.rows.find((r: any) => r.source === 'simulated');
    expect(partnerRow).toMatchObject({ clicks: Number(row.clicks), spendMicros: row.charged_micros });
    expect(partnerRow.costMicros).toBeUndefined(); // partner cost and margin are for staff only
  });

  it('never charges past the partner share or the campaign budget', async () => {
    const { org, campaign, adv } = await setup({ lifetime: '20', rate: '1.00' });
    await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 50 }] });
    for (let i = 0; i < 6; i++) {
      clock += 240 * MIN;
      await sync();
    }
    const row = await pc(campaign);
    expect(BigInt(row.charged_micros)).toBeLessThanOrEqual(toMicros('10'));
    expect(BigInt(row.charged_micros)).toBeGreaterThan(toMicros('8'));
    expect(row.status).toBe('paused');
    expect(row.status_reason).toMatch(/share of the budget/);
    for (const check of await reconcile(h.db)) expect(check.ok, check.name).toBe(true);
  });

  it('pauses on the partner when the campaign pauses, and stops when it is archived', async () => {
    const { org, campaign, adv } = await setup();
    await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 40 }] });
    clock += 2 * MIN;
    await sync();
    expect((await adv.post(`/api/v1/orgs/${org}/campaigns/${campaign}/pause`)).status).toBe(200);
    await sync();
    const paused = await pc(campaign);
    expect(paused.status).toBe('paused');
    clock += 60 * MIN;
    await sync();
    expect((await pc(campaign)).clicks).toBe(paused.clicks); // nothing accrues while paused
    expect((await adv.post(`/api/v1/orgs/${org}/campaigns/${campaign}/archive`)).status).toBe(200);
    await sync();
    expect((await pc(campaign)).status).toBe('stopped');
    for (const check of await reconcile(h.db)) expect(check.ok, check.name).toBe(true);
  });

  it('shows the partner’s own rejection of an ad', async () => {
    const { org, campaign, adv } = await setup({ headline: 'This miracle tea melts fat overnight' });
    await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 40 }] });
    clock += 2 * MIN;
    await sync();
    const view = await adv.get(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`);
    const p = view.body.data.partners[0];
    expect(p.status).toBe('rejected');
    expect(p.ads[0].status).toBe('rejected');
    expect(p.ads[0].rejectionReason).toMatch(/exaggerated/);
  });

  it('lets staff hold a partner campaign, and the advertiser remove one while keeping its history', async () => {
    const { org, campaign, adv, adminCl } = await setup();
    await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [{ networkId: 'simulated', budgetPercent: 40 }] });
    clock += 2 * MIN;
    await sync();
    const id = (await pc(campaign)).id;
    const held = await adminCl.post(`/api/v1/admin/partner-campaigns/${id}/hold`, { reason: 'Checking the landing page' });
    expect(held.status).toBe(200);
    expect(held.body.data).toMatchObject({ status: 'paused', adminHold: true });
    await adminCl.post(`/api/v1/admin/partner-campaigns/${id}/release`, { reason: 'Landing page is fine' });
    expect((await pc(campaign)).status).toBe('active');
    clock += 20 * MIN;
    await sync();
    const r = await adv.put(`/api/v1/orgs/${org}/campaigns/${campaign}/partners`, { networks: [] });
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ status: 'stopped', statusReason: 'Removed by the advertiser.' });
    for (const check of await reconcile(h.db)) expect(check.ok, check.name).toBe(true);
  });
});
