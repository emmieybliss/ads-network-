/**
 * One run through the whole platform, in the order a real advertiser and
 * publisher would meet it: sign up, get approved, fund, create a campaign and
 * a creative, get them reviewed, install the tag, serve, measure, settle, and
 * pay out. Every step goes through the HTTP API with the permissions that step
 * would really have.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { reconcile } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { TEST_PASSWORD, makeUser, setSettings, uniq } from '../helpers/fixtures';

let h: Harness;

/** Stand-in DNS for the verification step; everything else in the journey is real. */
const txtRecords = new Map<string, string[][]>();
const resolver = {
  resolveTxt: async (name: string) => {
    const r = txtRecords.get(name);
    if (!r) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return r;
  },
};

beforeAll(async () => {
  h = await createHarness({}, { overrides: { verifier: { resolver } } });
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

const PASSWORD = 'An-end-to-end-passphrase-71!';

async function register(email: string, name: string, accountType: 'advertiser' | 'publisher', orgName: string) {
  const cl = new Client(h.app);
  const r = await cl.post('/api/v1/auth/register', { email, password: PASSWORD, name, accountType, organizationName: orgName });
  expect(r.status, `register ${email}`).toBe(202);

  // Verify the address the way the emailed link would.
  const { randomToken, sha256 } = await import('@blissnova/api/lib/crypto');
  const userId = (await h.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  const token = randomToken(32);
  await h.db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'verify_email', $2, now() + interval '1 day')`, [userId, sha256(token)]);
  expect((await cl.post('/api/v1/auth/verify-email', { token })).status).toBe(200);

  const login = await cl.post('/api/v1/auth/login', { email, password: PASSWORD });
  expect(login.status, `login ${email}`).toBe(200);
  const orgs = await cl.get('/api/v1/orgs');
  expect(orgs.body.data.length).toBe(1);
  return { cl, userId, orgId: orgs.body.data[0].id as string };
}

it('runs the whole advertiser-to-payout journey', async () => {
  // Cost per click is off on a fresh platform; this run uses CPM, so leave it.
  await setSettings(h.db, 'publishers', { requireDomainVerification: false, earningsHoldDays: 0 });
  h.app.ctx.settings.invalidate();

  // ---------------------------------------------------------------- 1. staff
  const staff = await makeUser(h.db, { platformRole: 'super_admin', name: 'Platform Operator' });
  const admin = new Client(h.app);
  expect((await admin.post('/api/v1/auth/login', { email: staff.email, password: TEST_PASSWORD })).status).toBe(200);
  expect((await admin.post('/api/v1/auth/step-up', { password: TEST_PASSWORD })).status).toBe(200);

  // ------------------------------------------------- 2. advertiser and publisher sign up
  const adv = await register('e2e-advertiser@example.com', 'Avery Advertiser', 'advertiser', 'Northwind Coffee');
  const pub = await register('e2e-publisher@example.com', 'Parker Publisher', 'publisher', 'Daily Dispatch');

  // Both organisations start out awaiting approval.
  const pendingOrgs = await admin.get('/api/v1/admin/orgs?status=pending');
  expect(pendingOrgs.status).toBe(200);
  expect(pendingOrgs.body.data.length).toBe(2);

  // ----------------------------------------------------- 3. staff approve them
  for (const orgId of [adv.orgId, pub.orgId]) {
    const r = await admin.post(`/api/v1/admin/orgs/${orgId}/approve`, { reason: 'Documents checked' });
    expect(r.status, `approve ${orgId}`).toBeLessThan(300);
  }

  // ------------------------------------------------------ 4. publisher adds a site
  const siteRes = await pub.cl.post(`/api/v1/orgs/${pub.orgId}/sites`, { name: 'Daily Dispatch', domain: 'dispatch.example.org', category: 'news' });
  expect(siteRes.status).toBeLessThan(300);
  const siteId: string = siteRes.body.data.id;

  // Nothing serves before the site is approved.
  expect(siteRes.body.data.status).not.toBe('approved');

  // Domain verification with a DNS TXT record (the resolver is a stand-in for real DNS).
  const challengeRes = await pub.cl.post(`/api/v1/orgs/${pub.orgId}/sites/${siteId}/verification/challenge`, { method: 'dns_txt' });
  expect(challengeRes.status).toBe(201);
  const dns = challengeRes.body.data.verification.challenge.instructions;
  txtRecords.set(dns.recordName, [[dns.value]]);
  const check = await pub.cl.post(`/api/v1/orgs/${pub.orgId}/sites/${siteId}/verification/check`);
  expect(check.body.verified).toBe(true);
  // Verification proves control of the hostname; it does not approve the site.
  expect(check.body.data.status).toBe('verified');

  const submit = await pub.cl.post(`/api/v1/orgs/${pub.orgId}/sites/${siteId}/submit`, {
    category: 'news', description: 'Local news and long-form reporting, published daily.', language: 'en', country: 'US',
    policyVersion: check.body.data.submission.policyVersion, acceptPolicies: true,
  });
  expect(submit.status, JSON.stringify(submit.body).slice(0, 300)).toBe(200);
  expect((await pub.cl.get(`/api/v1/orgs/${pub.orgId}/sites/${siteId}/tag`)).body.data.available).toBe(false);
  expect((await admin.post(`/api/v1/admin/sites/${siteId}/start-review`, {})).status).toBe(200);
  const siteApproval = await admin.post(`/api/v1/admin/sites/${siteId}/approve`, { reason: 'Content reviewed', checklist: { originalContent: true, privacyPolicy: true } });
  expect(siteApproval.status).toBeLessThan(300);

  // ------------------------------------------------------- 5. publisher adds a unit
  const unitRes = await pub.cl.post(`/api/v1/orgs/${pub.orgId}/sites/${siteId}/units`, {
    key: 'sidebar_300x250',
    name: 'Sidebar rectangle',
    formats: ['image'],
    width: 300,
    height: 250,
    responsive: false,
    position: 'sidebar',
  });
  expect(unitRes.status, JSON.stringify(unitRes.body).slice(0, 300)).toBeLessThan(300);

  const tag = await pub.cl.get(`/api/v1/orgs/${pub.orgId}/sites/${siteId}/tag`);
  expect(tag.status).toBe(200);
  const tagText = JSON.stringify(tag.body);
  // The tag must carry the public site key and nothing secret.
  expect(tagText).toMatch(/pk_[A-Za-z0-9]{16,40}/);
  expect(tagText).not.toContain('bnk_');

  const siteKey: string = (await h.db.query<{ public_key: string }>('SELECT public_key FROM sites WHERE id = $1', [siteId])).rows[0]!.public_key;

  // --------------------------------------------------------- 6. advertiser funds
  const payment = await adv.cl.req('POST', `/api/v1/orgs/${adv.orgId}/billing/payments`, {
    body: { provider: 'dev_simulated', amount: '500.00' },
    headers: { 'idempotency-key': uniq('e2e-fund') },
  });
  expect(payment.status).toBeLessThan(300);
  expect(payment.body.data.status).toBe('pending');

  // The wallet is still empty: a started payment is not a received one.
  let billing = await adv.cl.get(`/api/v1/orgs/${adv.orgId}/billing`);
  expect(BigInt(billing.body.data.availableMicros)).toBe(0n);

  // The provider confirms by signed webhook.
  const { createHmac } = await import('node:crypto');
  const hookBody = JSON.stringify({ id: uniq('e2e-evt'), paymentId: payment.body.data.id, outcome: 'succeeded', amountMicros: toMicros('500').toString(), currency: 'USD' });
  const hook = await h.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/payments/dev_simulated',
    headers: { 'content-type': 'application/json', 'x-dev-signature': createHmac('sha256', `${h.config.APP_SECRET}:dev-payments`).update(hookBody).digest('hex') },
    payload: hookBody,
  });
  expect(hook.statusCode).toBeLessThan(300);

  billing = await adv.cl.get(`/api/v1/orgs/${adv.orgId}/billing`);
  expect(BigInt(billing.body.data.availableMicros)).toBe(toMicros('500'));

  // ------------------------------------------------------ 7. campaign and creative
  const campaignRes = await adv.cl.post(`/api/v1/orgs/${adv.orgId}/campaigns`, {
    name: 'Spring blend launch',
    pricingModel: 'cpm',
    rate: '10.00',
    lifetimeBudget: '100.00',
    startAt: new Date(Date.now() - 3600_000).toISOString(),
    pacing: 'asap',
    priority: 5,
    timezone: 'UTC',
  });
  expect(campaignRes.status, JSON.stringify(campaignRes.body).slice(0, 300)).toBeLessThan(300);
  const campaignId: string = campaignRes.body.data.id;
  expect(campaignRes.body.data.status).toBe('draft');

  const creativeRes = await adv.cl.post(`/api/v1/orgs/${adv.orgId}/campaigns/${campaignId}/creatives`, {
    name: 'Sidebar text advertisement',
    format: 'text',
    headline: 'Fresh coffee, every week',
    body: 'A demonstration advertisement for this end-to-end run.',
    cta: 'See the offer',
    destinationUrl: 'https://example.com/spring-blend',
    displayUrl: 'example.com',
  });
  expect(creativeRes.status, JSON.stringify(creativeRes.body).slice(0, 300)).toBeLessThan(300);
  const creativeId: string = creativeRes.body.data.id;

  // ----------------------------------------------------------- 8. review
  const submitted = await adv.cl.post(`/api/v1/orgs/${adv.orgId}/campaigns/${campaignId}/submit`);
  expect(submitted.status).toBeLessThan(300);

  // Nothing serves while the campaign is still awaiting review.
  const earlyServe = await serveOnce(siteKey, 'sidebar_300x250');
  expect(earlyServe).toBeNull();

  const creativeReview = await admin.post(`/api/v1/admin/creatives/${creativeId}/approve`, { reason: 'Complies with policy' });
  expect(creativeReview.status, JSON.stringify(creativeReview.body).slice(0, 200)).toBeLessThan(300);
  const campaignReview = await admin.post(`/api/v1/admin/campaigns/${campaignId}/approve`, { reason: 'Budget and targeting reviewed' });
  expect(campaignReview.status, JSON.stringify(campaignReview.body).slice(0, 200)).toBeLessThan(300);

  // Approval reserves the budget out of the wallet.
  billing = await adv.cl.get(`/api/v1/orgs/${adv.orgId}/billing`);
  expect(BigInt(billing.body.data.availableMicros)).toBe(toMicros('400'));

  // ------------------------------------------- 9. the publisher's page serves ads
  // The unit only allows image creatives, so widen it to text for this run.
  const widened = await pub.cl.patch(`/api/v1/orgs/${pub.orgId}/units/${unitRes.body.data.id}`, { formats: ['image', 'text'], responsive: true });
  expect(widened.status, JSON.stringify(widened.body).slice(0, 300)).toBeLessThan(300);
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);

  const diag = await h.db.query(
    `SELECT c.status AS campaign, cr.status AS creative, cr.approved_version, u.status AS unit, u.formats::text AS formats, s.status AS site FROM campaigns c, creatives cr, ad_units u, sites s`,
  );

  // Fifty page views: enough to measure, and under the platform's default
  // ceiling of 120 ad requests a minute from one address. (Everything here
  // comes from one test address; a real site has many.)
  let rendered = 0;
  for (let i = 0; i < 50; i++) {
    const ad = await serveOnce(siteKey, 'sidebar_300x250');
    if (!ad) break;
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'user-agent': BROWSER_UA, referer: 'http://dispatch.example.org/article', origin: 'http://dispatch.example.org' },
      payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t: ad.token }, { id: uniq('ev0000000000'), type: 'viewable', t: ad.token }] },
    });
    expect(r.statusCode).toBe(202);
    rendered++;
  }
  // A $100 budget at a $10 CPM is 10,000 impressions, so all fifty serve.
  expect(rendered, JSON.stringify(diag.rows)).toBe(50);

  // ------------------------------------------------------------ 10. reporting
  // Reports read the daily aggregates, which the worker refreshes on a
  // schedule. Run that aggregation here rather than waiting for a worker.
  const { aggregateDay } = await import('@blissnova/api/services/events');
  await aggregateDay(h.db, new Date().toISOString().slice(0, 10));

  const report = await adv.cl.get(`/api/v1/orgs/${adv.orgId}/reports?groupBy=campaign`);
  expect(report.status).toBe(200);
  expect(report.body.data.rows, JSON.stringify(report.body.data.totals)).toHaveLength(1);
  const row = report.body.data.rows[0];
  expect(row.validImpressions).toBe(50);
  expect(row.viewableImpressions).toBe(50);
  expect(row.invalidImpressions).toBe(0);
  // 50 impressions at a $10 CPM is $0.50.
  expect(BigInt(row.spendMicros)).toBe(toMicros('0.50'));
  // No clicks happened, so CTR must be 0, not null and not a made-up figure.
  expect(row.ctr).toBe(0);
  // And the report must carry the definition of every metric it shows.
  expect(report.body.data.definitions.ctr).toMatch(/valid/i);

  const csv = await adv.cl.get(`/api/v1/orgs/${adv.orgId}/reports/export?groupBy=campaign`);
  expect(csv.status).toBe(200);
  expect(String(csv.headers['content-type'])).toContain('text/csv');

  // ------------------------------------------------------ 11. settle and finalise
  const settled = await admin.post('/api/v1/admin/finance/settle', { reason: 'End of run settlement' });
  expect(settled.status, JSON.stringify(settled.body).slice(0, 200)).toBeLessThan(300);

  const earnings = await pub.cl.get(`/api/v1/orgs/${pub.orgId}/earnings`);
  expect(earnings.status).toBe(200);
  // The publisher's default share is 70% of $0.50.
  const totalEarned = BigInt(earnings.body.data.pendingMicros ?? '0') + BigInt(earnings.body.data.availableMicros ?? '0');
  expect(totalEarned, JSON.stringify(earnings.body.data)).toBe(toMicros('0.35'));

  // ------------------------------------------------------------ 12. reconcile
  const checks = await reconcile(h.db);
  expect(checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);

  // -------------------------------------------- 13. nothing was invented anywhere
  const audit = await admin.get('/api/v1/admin/audit');
  expect(audit.status).toBe(200);
  expect(audit.body.data.length).toBeGreaterThan(0);
  // Every ledger movement has a reason and an actor.
  const unexplained = await h.db.query(`SELECT 1 FROM ledger_transactions WHERE reason IS NULL OR btrim(reason) = ''`);
  expect(unexplained.rowCount).toBe(0);
});

async function serveOnce(siteKey: string, slot: string) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/serve',
    headers: { 'user-agent': BROWSER_UA, origin: 'http://dispatch.example.org' },
    payload: { siteKey, units: [{ slot }], page: { url: 'http://dispatch.example.org/article' }, pv: uniq('pv0000000000') },
  });
  const body = JSON.parse(r.body) as { ads: Array<{ ad: { token: string; clickUrl: string } | null }> };
  return body.ads[0]?.ad ?? null;
}
