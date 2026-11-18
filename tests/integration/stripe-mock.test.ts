/**
 * Stripe end to end against stripe-mock (github.com/stripe/stripe-mock), which
 * answers with Stripe's real API schema and rejects unknown or malformed
 * parameters. It checks that every request we send to Stripe is one Stripe
 * accepts, and walks a card deposit from checkout to webhook to refund.
 *
 *   go install github.com/stripe/stripe-mock@latest && stripe-mock -http-port 12111
 *   STRIPE_MOCK_URL=http://localhost:12111 pnpm vitest run tests/integration/stripe-mock.test.ts
 *
 * Skipped when STRIPE_MOCK_URL is not set. stripe-mock keeps no state, so the
 * webhook events are built here and signed exactly as Stripe signs them.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balance } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { StripeProvider } from '@blissnova/api/services/payments/stripe';
import { withTransaction } from '@blissnova/database';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeOrg, makeUser, TEST_PASSWORD, uniq } from '../helpers/fixtures';

const MOCK = process.env.STRIPE_MOCK_URL;
const WHSEC = 'whsec_blissnova_mock_test';

let h: Harness;
let calls: Array<{ path: string; status: number; body: string }>;

describe.skipIf(!MOCK)('Stripe card deposits against stripe-mock', () => {
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
    calls = [];
    // Real HTTP to stripe-mock; we only record what went over the wire.
    const recording = (async (url: string | URL, init?: RequestInit) => {
      const res = await fetch(url, init);
      calls.push({ path: new URL(String(url)).pathname, status: res.status, body: String(init?.body ?? '') });
      return res;
    }) as typeof fetch;
    h.app.ctx.payments.register(new StripeProvider('sk_test_123', WHSEC, recording, MOCK));
  });

  const bal = (orgId: string) => withTransaction(h.db, (c) => balance(c, { kind: 'advertiser_wallet', orgId }, 'USD'));

  async function signedIn(opts: Parameters<typeof makeUser>[1] = {}) {
    const u = await makeUser(h.db, opts);
    const cl = new Client(h.app);
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    return { user: u, cl };
  }
  async function advertiser() {
    const s = await signedIn();
    return { ...s, org: await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id }) };
  }
  async function deposit(a: { cl: Client; org: string }, amount: string) {
    const r = await a.cl.req('POST', `/api/v1/orgs/${a.org}/billing/payments`, { body: { provider: 'stripe', amount }, headers: { 'idempotency-key': uniq('idem') } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as { id: string; provider_ref: string; checkout_url: string; status: string };
  }
  function webhook(type: string, object: Record<string, unknown>, opts: { secret?: string; t?: number; id?: string } = {}) {
    const body = JSON.stringify({ id: opts.id ?? `evt_${randomUUID().replace(/-/g, '')}`, object: 'event', type, livemode: false, data: { object: { object: 'checkout.session', ...object } } });
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', opts.secret ?? WHSEC).update(`${t}.${body}`).digest('hex');
    return h.app.inject({ method: 'POST', url: '/api/v1/webhooks/payments/stripe', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': `t=${t},v1=${sig}` }, payload: body });
  }
  const paidSession = (p: { id: string; provider_ref: string }, cents: number, extra: Record<string, unknown> = {}) => ({
    id: p.provider_ref, client_reference_id: p.id, metadata: { payment_id: p.id }, payment_status: 'paid', status: 'complete', amount_total: cents, currency: 'usd', payment_intent: 'pi_mock_1', ...extra,
  });

  it('authenticates (admin connection test)', async () => {
    const res = await h.app.ctx.payments.get('stripe')!.testConnection();
    expect(res).toEqual({ ok: true, detail: 'Authenticated request to Stripe succeeded' });
    expect(calls).toEqual([expect.objectContaining({ path: '/v1/balance', status: 200 })]);
  });

  it('creates a Checkout Session Stripe accepts, then credits only on the signed webhook', async () => {
    const a = await advertiser();
    const p = await deposit(a, '125.50');
    // stripe-mock validated every form parameter against Stripe's API schema.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/v1/checkout/sessions', status: 200 });
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get('line_items[0][price_data][unit_amount]')).toBe('12550');
    expect(sent.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(sent.get('client_reference_id')).toBe(p.id);
    expect(sent.get('success_url')).toContain(`/advertiser/billing?payment=${p.id}`);
    expect(p.provider_ref).toMatch(/^cs_/);
    expect(p.checkout_url).toMatch(/^https:\/\//);
    expect(p.status).toBe('pending');
    expect(await bal(a.org)).toBe(0n);

    const r = await webhook('checkout.session.completed', paidSession(p, 12550));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ received: true });
    expect(await bal(a.org)).toBe(toMicros('125.50'));
    expect((await h.db.query('SELECT status, provider_charge_ref FROM payments WHERE id = $1', [p.id])).rows[0]).toEqual({ status: 'succeeded', provider_charge_ref: 'pi_mock_1' });
    expect((await h.db.query(`SELECT kind FROM invoices WHERE payment_id = $1`, [p.id])).rows).toEqual([{ kind: 'receipt' }]);
  });

  it('ignores replays, bad signatures, stale timestamps and mismatched amounts', async () => {
    const a = await advertiser();
    const p = await deposit(a, '50.00');
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    expect((await webhook('checkout.session.completed', paidSession(p, 5000), { secret: 'whsec_wrong' })).statusCode).toBe(400);
    expect((await webhook('checkout.session.completed', paidSession(p, 5000), { t: Math.floor(Date.now() / 1000) - 600 })).statusCode).toBe(400);
    expect((await webhook('checkout.session.completed', paidSession(p, 1), { id: `${id}_x` })).json()).toEqual({ received: true, processed: false });
    expect(await bal(a.org)).toBe(0n);
    await webhook('checkout.session.completed', paidSession(p, 5000), { id });
    expect((await webhook('checkout.session.completed', paidSession(p, 5000), { id })).json()).toEqual({ received: true, duplicate: true });
    // A second, different event for the same session must not credit twice either.
    await webhook('checkout.session.async_payment_succeeded', paidSession(p, 5000));
    expect(await bal(a.org)).toBe(toMicros('50'));
    expect(Number((await h.db.query(`SELECT count(*) FROM security_events WHERE type = 'webhook_signature_invalid'`)).rows[0].count)).toBe(2);
  });

  it('waits for delayed payment methods and fails expired sessions', async () => {
    const a = await advertiser();
    const p = await deposit(a, '40.00');
    expect((await webhook('checkout.session.completed', paidSession(p, 4000, { payment_status: 'unpaid' }))).json()).toEqual({ received: true, ignored: true });
    expect(await bal(a.org)).toBe(0n);
    await webhook('checkout.session.async_payment_succeeded', paidSession(p, 4000));
    expect(await bal(a.org)).toBe(toMicros('40'));

    const q = await deposit(a, '30.00');
    await webhook('checkout.session.expired', paidSession(q, 3000, { payment_status: 'unpaid', status: 'expired' }));
    expect((await h.db.query('SELECT status FROM payments WHERE id = $1', [q.id])).rows[0].status).toBe('failed');
  });

  it('refunds through Stripe with a request Stripe accepts, then debits the balance', async () => {
    const a = await advertiser();
    const p = await deposit(a, '200.00');
    await webhook('checkout.session.completed', paidSession(p, 20000));
    const f = await signedIn({ platformRole: 'finance' });
    expect((await f.cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD })).status).toBe(200);
    calls = [];
    const r = await f.cl.req('POST', `/api/v1/admin/finance/payments/${p.id}/refund`, { body: { amount: '75.00', reason: 'Unused budget returned' }, headers: { 'idempotency-key': uniq('idem') } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls).toEqual([expect.objectContaining({ path: '/v1/refunds', status: 200 })]);
    expect(new URLSearchParams(calls[0]!.body).get('amount')).toBe('7500');
    expect(new URLSearchParams(calls[0]!.body).get('payment_intent')).toBe('pi_mock_1');
    expect(await bal(a.org)).toBe(toMicros('125'));
    expect((await h.db.query('SELECT status FROM payments WHERE id = $1', [p.id])).rows[0].status).toBe('partially_refunded');
  });

  it('reports a card dispute to finance without touching the balance', async () => {
    const a = await advertiser();
    const p = await deposit(a, '60.00');
    await webhook('checkout.session.completed', paidSession(p, 6000));
    const r = await webhook('charge.dispute.created', { object: 'dispute', id: 'dp_mock_1', charge: 'ch_mock_1', payment_intent: 'pi_mock_1', amount: 6000, currency: 'usd', reason: 'fraudulent', status: 'needs_response' });
    expect(r.statusCode).toBe(200);
    expect(await bal(a.org)).toBe(toMicros('60'));
    const ev = (await h.db.query(`SELECT severity, subject, detail FROM security_events WHERE type = 'payment_disputed'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ severity: 'critical', subject: p.id });
    expect(ev[0].detail).toMatchObject({ provider: 'stripe', dispute: 'dp_mock_1', reason: 'fraudulent', amount: '60.00 USD' });
  });
});
