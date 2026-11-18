import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balance } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { loadConfig } from '@blissnova/api/config';
import { PaystackProvider } from '@blissnova/api/services/payments/paystack';
import { PaymentProviderRegistry } from '@blissnova/api/services/payments/registry';
import { withTransaction } from '@blissnova/database';
import { createHarness, testConfig, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeOrg, makeUser, TEST_PASSWORD, uniq } from '../helpers/fixtures';

const SK = 'sk_test_paystack_fake';
let h: Harness;

/** Stand-in for Paystack's REST API, shaped like the documented responses. Records every call. */
class FakePaystack {
  calls: Array<{ method: string; path: string; body: any; auth: string }> = [];
  txs = new Map<string, { id: number; amount: number; currency: string; status: string }>();
  fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method: init.method ?? 'GET', path: u.pathname, body, auth: (init.headers as Record<string, string>).Authorization });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/transaction/initialize') {
      if (this.txs.has(body.reference)) return json(400, { status: false, message: 'Duplicate Transaction Reference' });
      this.txs.set(body.reference, { id: 4000 + this.txs.size, amount: Number(body.amount), currency: body.currency, status: 'abandoned' });
      return json(200, { status: true, message: 'Authorization URL created', data: { authorization_url: `https://checkout.paystack.com/${body.reference.slice(0, 8)}`, access_code: 'ac', reference: body.reference } });
    }
    const v = u.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (v) {
      const t = this.txs.get(decodeURIComponent(v[1]!));
      return t ? json(200, { status: true, message: 'Verification successful', data: { ...t, reference: v[1], gateway_response: t.status === 'success' ? 'Successful' : 'The transaction was not completed' } }) : json(404, { status: false, message: 'Transaction reference not found' });
    }
    if (u.pathname === '/refund') return json(200, { status: true, message: 'Refund has been queued for processing', data: { id: 77, status: 'pending', amount: Number(body.amount), transaction: { id: Number(body.transaction) } } });
    if (u.pathname === '/balance') return json(200, { status: true, message: 'Balances retrieved', data: [{ currency: 'NGN', balance: 0 }] });
    return json(404, { status: false, message: 'Not found' });
  }) as unknown as typeof fetch;
  pay(ref: string, amount?: number) {
    const t = this.txs.get(ref)!;
    t.status = 'success';
    if (amount !== undefined) t.amount = amount;
    return t;
  }
}

let ps: FakePaystack;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  ps = new FakePaystack();
  h.app.ctx.payments.register(new PaystackProvider(SK, ['NGN', 'USD'], ps.fetch));
});

const bal = (orgId: string) => withTransaction(h.db, (c) => balance(c, { kind: 'advertiser_wallet', orgId }, 'USD'));

async function advertiser() {
  const u = await makeUser(h.db);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { user: u, cl, org: await makeOrg(h.db, { type: 'advertiser', ownerId: u.id }) };
}
async function deposit(a: Awaited<ReturnType<typeof advertiser>>, amount: string) {
  const r = await a.cl.req('POST', `/api/v1/orgs/${a.org}/billing/payments`, { body: { provider: 'paystack', amount }, headers: { 'idempotency-key': uniq('idem') } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; provider_ref: string; checkout_url: string };
}
function webhook(payload: unknown, secret = SK) {
  const body = JSON.stringify(payload);
  return h.app.inject({ method: 'POST', url: '/api/v1/webhooks/payments/paystack', headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', secret).update(body).digest('hex') }, payload: body });
}

describe('Paystack card deposits', () => {
  it('appears as a payment method and passes the connection test', async () => {
    const a = await advertiser();
    const r = await a.cl.get(`/api/v1/orgs/${a.org}/billing`);
    expect(r.body.data.providers.find((p: any) => p.id === 'paystack')).toMatchObject({ label: 'Card (Paystack)', mode: 'test', configured: true });
    expect(await h.app.ctx.payments.get('paystack')!.testConnection()).toEqual({ ok: true, detail: 'Authenticated request to Paystack succeeded' });
  });

  it('starts a checkout with the payer email, amount in cents and our payment id as reference', async () => {
    const a = await advertiser();
    const p = await deposit(a, '120.25');
    expect(p.checkout_url).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    expect(p.provider_ref).toBe(p.id);
    const init = ps.calls.find((c) => c.path === '/transaction/initialize')!;
    expect(init.auth).toBe(`Bearer ${SK}`);
    expect(init.body).toMatchObject({ email: a.user.email, amount: '12025', currency: 'USD', reference: p.id, metadata: { payment_id: p.id, org_id: a.org } });
    expect(init.body.callback_url).toContain(`/advertiser/billing?payment=${p.id}&status=returned`);
    expect(await bal(a.org)).toBe(0n);
  });

  it('credits on return only after Paystack verifies the transaction', async () => {
    const a = await advertiser();
    const p = await deposit(a, '80.00');
    // Returned without paying: still pending.
    expect((await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${p.id}/return`)).body.data.status).toBe('pending');
    expect(await bal(a.org)).toBe(0n);
    ps.pay(p.id);
    expect((await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${p.id}/return`)).body.data.status).toBe('succeeded');
    expect(await bal(a.org)).toBe(toMicros('80'));
    // The webhook arriving afterwards does not credit twice.
    const t = ps.txs.get(p.id)!;
    expect((await webhook({ event: 'charge.success', data: { id: t.id, reference: p.id, status: 'success', amount: 8000, currency: 'USD' } })).statusCode).toBe(200);
    expect(await bal(a.org)).toBe(toMicros('80'));
    expect((await h.db.query('SELECT status, provider_charge_ref FROM payments WHERE id = $1', [p.id])).rows[0]).toEqual({ status: 'succeeded', provider_charge_ref: String(t.id) });
  });

  it('credits from a signed charge.success webhook, and rejects forged or mismatched ones', async () => {
    const a = await advertiser();
    const p = await deposit(a, '50.00');
    const t = ps.pay(p.id);
    const evt = { event: 'charge.success', data: { id: t.id, reference: p.id, status: 'success', amount: 5000, currency: 'USD' } };
    expect((await webhook(evt, 'sk_test_wrong')).statusCode).toBe(400);
    expect((await webhook({ ...evt, data: { ...evt.data, id: 9, amount: 100 } })).json()).toEqual({ received: true, processed: false });
    expect(await bal(a.org)).toBe(0n);
    expect((await webhook(evt)).json()).toEqual({ received: true });
    expect((await webhook(evt)).json()).toEqual({ received: true, duplicate: true });
    expect(await bal(a.org)).toBe(toMicros('50'));
  });

  it('does not credit when Paystack verifies a different amount', async () => {
    const a = await advertiser();
    const p = await deposit(a, '100.00');
    ps.pay(p.id, 100);
    await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${p.id}/return`);
    expect(await bal(a.org)).toBe(0n);
  });

  it('refunds through Paystack before debiting the balance', async () => {
    const a = await advertiser();
    const p = await deposit(a, '200.00');
    const t = ps.pay(p.id);
    await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${p.id}/return`);
    const f = await makeUser(h.db, { platformRole: 'finance' });
    const fc = new Client(h.app);
    await fc.post('/api/v1/auth/login', { email: f.email, password: TEST_PASSWORD });
    await fc.post('/api/v1/auth/step-up', { password: TEST_PASSWORD });
    const r = await fc.req('POST', `/api/v1/admin/finance/payments/${p.id}/refund`, { body: { amount: '20.00', reason: 'Unused budget' }, headers: { 'idempotency-key': uniq('idem') } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ps.calls.find((c) => c.path === '/refund')!.body).toMatchObject({ transaction: String(t.id), amount: '2000', currency: 'USD' });
    expect(await bal(a.org)).toBe(toMicros('180'));
  });

  it('alerts finance about a chargeback without changing the balance', async () => {
    const a = await advertiser();
    const p = await deposit(a, '60.00');
    const t = ps.pay(p.id);
    await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${p.id}/return`);
    const fin = await makeUser(h.db, { platformRole: 'finance' });
    const r = await webhook({ event: 'charge.dispute.create', data: { id: 31, category: 'fraud', currency: 'USD', refund_amount: 6000, transaction: { id: t.id, amount: 6000, currency: 'USD' } } });
    expect(r.statusCode).toBe(200);
    expect(await bal(a.org)).toBe(toMicros('60'));
    expect((await h.db.query(`SELECT severity, subject FROM security_events WHERE type = 'payment_disputed'`)).rows).toEqual([{ severity: 'critical', subject: p.id }]);
    expect((await h.db.query(`SELECT title FROM notifications WHERE user_id = $1`, [fin.id])).rows).toEqual([{ title: 'Card payment disputed' }]);
  });

  it('is offered only for the currencies the business is enabled for', async () => {
    const reg = new PaymentProviderRegistry(testConfig({ PAYSTACK_SECRET_KEY: SK, PAYSTACK_CURRENCIES: 'NGN' }));
    expect(reg.get('paystack')!.supportsCurrency!('USD')).toBe(false);
    expect(reg.get('paystack')!.supportsCurrency!('NGN')).toBe(true);
  });

  it('refuses a Paystack test key or a non-Paystack API address in production', () => {
    const env = (extra: Record<string, string>) => () => loadConfig({
      ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgres://x@db/x', REDIS_URL: 'redis://r:6379', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), TRACKING_TOKEN_KEYS: `k1:${Buffer.alloc(32, 9).toString('base64')}`,
      ENABLE_DEV_PAYMENTS: 'false', COOKIE_SECURE: 'true', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.mailhost.test', SEED_DEMO_DATA: 'false', VERIFICATION_ALLOW_HTTP: 'false', ENABLE_DEV_VERIFICATION_SIMULATOR: 'false', ENABLE_DEV_PARTNER_SIMULATOR: 'false',
      PUBLIC_SITE_URL: 'https://ads.network.test', PUBLIC_API_URL: 'https://ads.network.test', CORS_ORIGINS: 'https://ads.network.test', APP_SECRET: 'Zk3q9VtL0pR7wXc2Nb8mYd4sHf6gJa1e', ...extra,
    } as NodeJS.ProcessEnv);
    expect(env({ PAYSTACK_SECRET_KEY: 'sk_test_abc' })).toThrow(/PAYSTACK_SECRET_KEY must be a live key/);
    expect(env({ PAYSTACK_SECRET_KEY: 'sk_live_abc', PAYSTACK_API_BASE: 'http://localhost:9999' })).toThrow(/PAYSTACK_API_BASE/);
    expect(env({ STRIPE_SECRET_KEY: 'sk_live_a', STRIPE_WEBHOOK_SECRET: 'whsec_a', STRIPE_API_BASE: 'http://localhost:12111' })).toThrow(/STRIPE_API_BASE/);
    expect(env({ PAYSTACK_SECRET_KEY: 'sk_live_abc' })).not.toThrow();
  });
});
