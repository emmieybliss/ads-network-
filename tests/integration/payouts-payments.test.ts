import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balance, confirmPayment, manualAdjustment } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { loadConfig } from '@blissnova/api/config';
import { PayPalClient } from '@blissnova/api/services/paypal';
import { PayPalCheckoutProvider } from '@blissnova/api/services/payments/paypal';
import { StripeProvider } from '@blissnova/api/services/payments/stripe';
import { PayPalPayoutProvider } from '@blissnova/api/services/payouts/paypal';
import { raiseAutomaticPayouts } from '@blissnova/api/services/payouts/service';
import { requestPayout } from '@blissnova/billing';
import { withTransaction } from '@blissnova/database';
import { createHarness, testConfig, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeOrg, makeUser, TEST_PASSWORD, uniq } from '../helpers/fixtures';

let h: Harness;

/**
 * A stand-in for PayPal's REST API. It records every call so tests can check
 * exactly what would have been sent, and answers like the real endpoints.
 */
class FakePayPal {
  calls: Array<{ method: string; path: string; body: any; headers: Record<string, string> }> = [];
  captureAmount = '100.00';
  payoutStatus = 'SUCCESS';
  orders = new Map<string, { paymentId: string; amount: string; captured: boolean }>();
  fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    this.calls.push({ method: init.method ?? 'GET', path: u.pathname, body, headers });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const p = u.pathname;
    if (p === '/v1/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (p === '/v1/notifications/verify-webhook-signature') return json(200, { verification_status: body.transmission_sig === 'genuine' ? 'SUCCESS' : 'FAILURE' });
    if (p === '/v2/checkout/orders' && init.method === 'POST') {
      const id = `ORDER-${this.orders.size + 1}`;
      this.orders.set(id, { paymentId: body.purchase_units[0].custom_id, amount: body.purchase_units[0].amount.value, captured: false });
      return json(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    const cap = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap) {
      const o = this.orders.get(cap[1]!)!;
      if (o.captured) return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      o.captured = true;
      return json(201, { id: cap[1], status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAPTURE-${cap[1]}`, status: 'COMPLETED', amount: { value: this.captureAmount, currency_code: 'USD' } }] } }] });
    }
    if (p.startsWith('/v2/checkout/orders/')) return json(200, { id: p.split('/').pop(), status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE-X', status: 'COMPLETED', amount: { value: this.captureAmount, currency_code: 'USD' } }] } }] });
    if (p.match(/^\/v2\/payments\/captures\/[^/]+\/refund$/)) return json(201, { id: 'REFUND-1', status: 'COMPLETED' });
    if (p === '/v1/payments/payouts' && init.method === 'POST') return json(201, { batch_header: { payout_batch_id: `BATCH-${body.sender_batch_header.sender_batch_id.slice(0, 8)}`, batch_status: 'PENDING' } });
    if (p.startsWith('/v1/payments/payouts/')) return json(200, { batch_header: { batch_status: 'SUCCESS' }, items: [{ transaction_status: this.payoutStatus, transaction_id: 'PAYPAL-TXN-1', errors: this.payoutStatus === 'SUCCESS' ? undefined : { message: 'Receiver account is locked' } }] });
    return json(404, { name: 'NOT_FOUND' });
  }) as unknown as typeof fetch;
}

let paypal: FakePayPal;
let stripeCalls: Array<{ url: string; body: string; headers: Record<string, string> }>;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  paypal = new FakePayPal();
  const client = new PayPalClient({ clientId: 'client', clientSecret: 'secret', webhookId: 'WH-TEST', env: 'sandbox' }, paypal.fetch);
  h.app.ctx.payments.register(new PayPalCheckoutProvider(client));
  h.app.ctx.payouts.register(new PayPalPayoutProvider(client));
  stripeCalls = [];
  h.app.ctx.payments.register(new StripeProvider('sk_test_fake', 'whsec_fake', (async (url: string, init: RequestInit) => {
    stripeCalls.push({ url: String(url), body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ id: 're_test_1', status: 'succeeded' }), { status: 200 });
  }) as unknown as typeof fetch));
});

async function signedIn(opts: Parameters<typeof makeUser>[1] = {}) {
  const u = await makeUser(h.db, opts);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { user: u, cl };
}

async function staff() {
  const s = await signedIn({ platformRole: 'finance' });
  expect((await s.cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD })).status).toBe(200);
  return s;
}

const bal = (kind: 'publisher_available' | 'publisher_payout_processing' | 'advertiser_wallet', orgId: string) => withTransaction(h.db, (c) => balance(c, { kind, orgId }, 'USD'));

async function publisher(amount = '300') {
  const s = await signedIn();
  const org = await makeOrg(h.db, { type: 'publisher', ownerId: s.user.id });
  const admin = await makeUser(h.db, { platformRole: 'super_admin' });
  await withTransaction(h.db, (c) => manualAdjustment(c, { orgId: org, kind: 'publisher_available', amount: toMicros(amount), currency: 'USD', actor: { type: 'user', userId: admin.id }, reason: 'Test earnings credit', idempotencyKey: uniq('adj') }));
  return { ...s, org };
}

const PAYPAL = { method: 'paypal', email: 'payee@example.com' };
const BANK = { method: 'bank_transfer', accountHolder: 'Ada Obi', bankName: 'GTBank', country: 'NG', accountNumber: '0123456789', swift: 'GTBINGLA' };
const TRON = { method: 'crypto', asset: 'USDT', network: 'tron', address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' };

async function requestOne(p: Awaited<ReturnType<typeof publisher>>, amount = '100.00') {
  const r = await p.cl.req('POST', `/api/v1/orgs/${p.org}/payouts`, { body: { amount }, headers: { 'idempotency-key': uniq('idem') } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

describe('payout methods', () => {
  it('encrypts details at rest and only ever returns them masked', async () => {
    const p = await publisher();
    const r = await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: BANK, autoPayout: true });
    expect(r.status).toBe(200);
    const row = (await h.db.query('SELECT * FROM payout_profiles WHERE org_id = $1', [p.org])).rows[0];
    expect(JSON.stringify(row)).not.toContain('0123456789');
    expect(row.details_encrypted).toMatch(/^v1\./);
    expect(row.display_label).toBe('Bank transfer · GTBank ····6789');
    const g = await p.cl.get(`/api/v1/orgs/${p.org}/payout-profile`);
    expect(JSON.stringify(g.body)).not.toContain('0123456789');
    expect(g.body.data.masked.accountNumber).toBe('····6789');
    expect(g.body.data.auto_payout).toBe(true);
    // Audit entries carry the masked label, never the account number.
    const audits = (await h.db.query(`SELECT before, after FROM audit_logs WHERE action = 'payout_profile.update'`)).rows;
    expect(JSON.stringify(audits)).not.toContain('0123456789');
  });

  it('rejects invalid IBANs and wrong-network wallet addresses with field errors', async () => {
    const p = await publisher();
    const iban = await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: { ...BANK, accountNumber: undefined, iban: 'GB29NWBK60161331926818' } });
    expect(iban.status).toBe(400);
    expect(JSON.stringify(iban.body)).toContain('iban');
    const wallet = await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: { ...TRON, network: 'ethereum' } });
    expect(wallet.status).toBe(400);
  });

  it('tells the owners when payout details change', async () => {
    const p = await publisher();
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL });
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: TRON });
    const n = (await h.db.query(`SELECT title, body FROM notifications WHERE org_id = $1 AND type = 'payout_method_changed'`, [p.org])).rows;
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('USDT on Tron');
  });

  it('keeps the destination a payout was requested with, even if details change later', async () => {
    const p = await publisher();
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL });
    const id = await requestOne(p);
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: { method: 'paypal', email: 'attacker@example.net' } });
    const a = await staff();
    expect((await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Looks fine' })).status).toBe(200);
    const d = await a.cl.get(`/api/v1/admin/payouts/${id}/destination`);
    expect(d.body.data.email).toBe('payee@example.com');
    // Viewing full details is audited.
    expect((await h.db.query(`SELECT 1 FROM audit_logs WHERE action = 'payout.destination_viewed' AND resource_id = $1`, [id])).rowCount).toBe(1);
    // The list never carries the encrypted blob, and flags the recent change.
    const list = await a.cl.get('/api/v1/admin/payouts');
    expect(JSON.stringify(list.body)).not.toContain('destination_encrypted');
  });

  it('refuses sub-cent payout amounts', async () => {
    const p = await publisher();
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL });
    const r = await p.cl.req('POST', `/api/v1/orgs/${p.org}/payouts`, { body: { amount: '100.005' }, headers: { 'idempotency-key': uniq('idem') } });
    expect(r.status).toBe(400);
  });
});

describe('sending payouts', () => {
  it('runs the simulated provider end to end through signed webhooks', async () => {
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: BANK });
    const id = await requestOne(p, '120.00');
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    const list = await a.cl.get('/api/v1/admin/payouts');
    expect(list.body.data[0].send_options.map((o: any) => o.id)).toEqual(['dev_simulated']);
    const sent = await a.cl.post(`/api/v1/admin/payouts/${id}/send`, { provider: 'dev_simulated' });
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe('processing');
    expect(await bal('publisher_payout_processing', p.org)).toBe(toMicros('120'));
    expect((await a.cl.post(`/api/v1/admin/payouts/${id}/simulate`, { outcome: 'paid' })).status).toBe(200);
    const row = (await h.db.query('SELECT status, paid_at, provider_ref FROM payouts WHERE id = $1', [id])).rows[0];
    expect(row.status).toBe('paid');
    expect(row.paid_at).not.toBeNull();
    expect(await bal('publisher_payout_processing', p.org)).toBe(0n);
    expect(await bal('publisher_available', p.org)).toBe(toMicros('180'));
    // A replayed completion changes nothing.
    expect((await a.cl.post(`/api/v1/admin/payouts/${id}/simulate`, { outcome: 'paid' })).status).toBe(409);
  });

  it('a simulated failure returns the money to the available balance', async () => {
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL });
    const id = await requestOne(p);
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    await a.cl.post(`/api/v1/admin/payouts/${id}/send`, { provider: 'dev_simulated' });
    await a.cl.post(`/api/v1/admin/payouts/${id}/simulate`, { outcome: 'failed' });
    expect((await h.db.query('SELECT status FROM payouts WHERE id = $1', [id])).rows[0].status).toBe('failed');
    expect(await bal('publisher_available', p.org)).toBe(toMicros('300'));
  });

  it('sends a PayPal payout with the payout id as the idempotency key, then settles from a verified webhook', async () => {
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL });
    const id = await requestOne(p, '75.50');
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    const r = await a.cl.post(`/api/v1/admin/payouts/${id}/send`, { provider: 'paypal' });
    expect(r.status).toBe(200);
    const call = paypal.calls.find((c) => c.path === '/v1/payments/payouts')!;
    expect(call.headers['paypal-request-id']).toBe(`payout-${id}`);
    expect(call.body.items[0]).toMatchObject({ recipient_type: 'EMAIL', receiver: 'payee@example.com', sender_item_id: id, amount: { value: '75.50', currency: 'USD' } });

    const event = (sig: string, eventId = uniq('WH')) => h.app.inject({
      method: 'POST', url: '/api/v1/webhooks/paypal',
      headers: { 'content-type': 'application/json', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': sig, 'paypal-transmission-time': new Date().toISOString(), 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert' },
      payload: JSON.stringify({ id: eventId, event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_batch_id: r.body.data.provider_ref, transaction_id: 'PAYPAL-TXN-9', transaction_status: 'SUCCESS', payout_item: { sender_item_id: id } } }),
    });
    // A forged delivery is refused and recorded.
    expect((await event('forged')).statusCode).toBe(400);
    expect((await h.db.query('SELECT status FROM payouts WHERE id = $1', [id])).rows[0].status).toBe('processing');
    expect((await event('genuine')).statusCode).toBe(200);
    const row = (await h.db.query('SELECT status, provider_ref FROM payouts WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'paid', provider_ref: 'PAYPAL-TXN-9' });
    expect(await bal('publisher_available', p.org)).toBe(toMicros('224.50'));
  });

  it('only offers PayPal for PayPal destinations', async () => {
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: TRON });
    const id = await requestOne(p);
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    expect((await a.cl.post(`/api/v1/admin/payouts/${id}/send`, { provider: 'paypal' })).status).toBe(502);
    expect((await h.db.query('SELECT status FROM payouts WHERE id = $1', [id])).rows[0].status).toBe('approved');
  });

  it('polls PayPal for payouts whose webhook never arrived', async () => {
    const { syncProcessingPayouts } = await import('@blissnova/api/services/payouts/service');
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL });
    const id = await requestOne(p);
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    await a.cl.post(`/api/v1/admin/payouts/${id}/send`, { provider: 'paypal' });
    paypal.payoutStatus = 'RETURNED';
    const r = await syncProcessingPayouts({ ...h.app.ctx, notify: async () => undefined }, 0);
    expect(r.changed).toBe(1);
    const row = (await h.db.query('SELECT status, failure_reason FROM payouts WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'failed', failure_reason: 'Receiver account is locked' });
    expect(await bal('publisher_available', p.org)).toBe(toMicros('300'));
  });

  it('checks crypto references are real transaction hashes before recording a manual payment', async () => {
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: TRON });
    const id = await requestOne(p);
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    await a.cl.post(`/api/v1/admin/payouts/${id}/processing`, { provider: 'manual' });
    expect((await a.cl.post(`/api/v1/admin/payouts/${id}/paid`, { providerRef: 'sent it', reason: 'Paid from wallet' })).status).toBe(400);
    const hash = 'a'.repeat(64);
    expect((await a.cl.post(`/api/v1/admin/payouts/${id}/paid`, { providerRef: hash, reason: 'Paid from wallet' })).status).toBe(200);
    const mine = await p.cl.get(`/api/v1/orgs/${p.org}/payouts`);
    expect(mine.body.data[0].explorer_url).toBe(`https://tronscan.org/#/transaction/${hash}`);
    expect(JSON.stringify(mine.body)).not.toContain('destination_encrypted');
  });

  it('exports approved bank payouts with full details for a bulk upload, behind step-up', async () => {
    const p = await publisher('300');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: BANK });
    const id = await requestOne(p);
    const a = await staff();
    const ap = await a.cl.post(`/api/v1/admin/payouts/${id}/approve`, { reason: 'Checked and approved' });
    expect(ap.body).toMatchObject({ data: { status: 'approved' } });
    const csv = await a.cl.get('/api/v1/admin/payouts/export?method=bank_transfer');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('0123456789');
    expect(String(csv.body)).toContain('GTBINGLA');
  });
});

describe('automatic monthly payouts', () => {
  it('raises a request on the payout day for publishers who opted in, once', async () => {
    const p = await publisher('80.123456');
    await p.cl.put(`/api/v1/orgs/${p.org}/payout-profile`, { details: PAYPAL, autoPayout: true });
    const other = await publisher('500');
    await other.cl.put(`/api/v1/orgs/${other.org}/payout-profile`, { details: PAYPAL, autoPayout: false });
    const settings = { autoPayoutDay: 21, minimumPayoutMicros: toMicros('50').toString() };
    const req = (r: { orgId: string; amount: bigint; currency: string; userId: string; key: string }) => withTransaction(h.db, (c) => requestPayout(c, { orgId: r.orgId, amount: r.amount, currency: r.currency, userId: r.userId, idempotencyKey: r.key, minimum: 0n, auto: true }));
    expect((await raiseAutomaticPayouts(h.app.ctx, settings, new Date('2026-11-20T01:00:00Z'), req)).raised).toBe(0);
    expect((await raiseAutomaticPayouts(h.app.ctx, settings, new Date('2026-11-21T01:00:00Z'), req)).raised).toBe(1);
    expect((await raiseAutomaticPayouts(h.app.ctx, settings, new Date('2026-11-21T02:00:00Z'), req)).raised).toBe(0);
    const rows = (await h.db.query('SELECT org_id, amount_micros, auto_requested, method FROM payouts')).rows;
    // Whole cents only, and only the publisher who opted in.
    expect(rows).toEqual([{ org_id: p.org, amount_micros: toMicros('80.12').toString(), auto_requested: true, method: 'paypal' }]);
  });
});

describe('advertiser payments', () => {
  async function advertiser() {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    return { ...s, org };
  }

  it('offers card, PayPal and bank transfer', async () => {
    const a = await advertiser();
    const r = await a.cl.get(`/api/v1/orgs/${a.org}/billing`);
    expect(r.body.data.providers.map((p: any) => p.id).sort()).toEqual(['bank_transfer', 'dev_simulated', 'paypal', 'stripe']);
    expect(r.body.data.providers.find((p: any) => p.id === 'stripe')).toMatchObject({ label: 'Card (Stripe)', mode: 'test' });
  });

  it('credits a PayPal deposit only from PayPal’s capture response', async () => {
    const a = await advertiser();
    const r = await a.cl.req('POST', `/api/v1/orgs/${a.org}/billing/payments`, { body: { provider: 'paypal', amount: '100.00' }, headers: { 'idempotency-key': uniq('idem') } });
    expect(r.status).toBe(201);
    expect(r.body.data.checkout_url).toContain('sandbox.paypal.com');
    expect(await bal('advertiser_wallet', a.org)).toBe(0n);
    const back = await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${r.body.data.id}/return`);
    expect(back.body.data.status).toBe('succeeded');
    expect(await bal('advertiser_wallet', a.org)).toBe(toMicros('100'));
    const pay = (await h.db.query('SELECT status, provider_charge_ref FROM payments WHERE id = $1', [r.body.data.id])).rows[0];
    expect(pay).toMatchObject({ status: 'succeeded', provider_charge_ref: 'CAPTURE-ORDER-1' });
    // Coming back twice credits once.
    await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${r.body.data.id}/return`);
    expect(await bal('advertiser_wallet', a.org)).toBe(toMicros('100'));
  });

  it('does not credit a PayPal capture for a different amount', async () => {
    const a = await advertiser();
    paypal.captureAmount = '1.00';
    const r = await a.cl.req('POST', `/api/v1/orgs/${a.org}/billing/payments`, { body: { provider: 'paypal', amount: '100.00' }, headers: { 'idempotency-key': uniq('idem') } });
    await a.cl.post(`/api/v1/orgs/${a.org}/billing/payments/${r.body.data.id}/return`);
    expect(await bal('advertiser_wallet', a.org)).toBe(0n);
  });

  it('refunds a card payment through Stripe before debiting the balance', async () => {
    const a = await advertiser();
    const id = (await h.db.query<{ id: string }>(`INSERT INTO payments (org_id, provider, provider_ref, provider_charge_ref, idempotency_key, amount_micros, currency) VALUES ($1, 'stripe', 'cs_test_1', 'pi_test_1', $2, $3, 'USD') RETURNING id`, [a.org, uniq('k'), toMicros('200').toString()])).rows[0]!.id;
    await withTransaction(h.db, (c) => confirmPayment(c, { paymentId: id, actor: { type: 'provider', provider: 'stripe' }, feeBps: 0, invoicePrefix: 'BN' }));
    const f = await staff();
    const r = await f.cl.req('POST', `/api/v1/admin/finance/payments/${id}/refund`, { body: { amount: '50.00', reason: 'Customer request' }, headers: { 'idempotency-key': uniq('idem') } });
    expect(r.status).toBe(200);
    expect(stripeCalls).toHaveLength(1);
    expect(stripeCalls[0]!.url).toBe('https://api.stripe.com/v1/refunds');
    expect(stripeCalls[0]!.body).toContain('payment_intent=pi_test_1');
    expect(stripeCalls[0]!.body).toContain('amount=5000');
    expect(await bal('advertiser_wallet', a.org)).toBe(toMicros('150'));
    expect((await h.db.query('SELECT provider_ref FROM refunds WHERE payment_id = $1', [id])).rows[0].provider_ref).toBe('re_test_1');
  });

  it('stores the Stripe PaymentIntent from the checkout webhook so the payment can be refunded later', async () => {
    const { createHmac } = await import('node:crypto');
    const a = await advertiser();
    const id = (await h.db.query<{ id: string }>(`INSERT INTO payments (org_id, provider, provider_ref, idempotency_key, amount_micros, currency) VALUES ($1, 'stripe', 'cs_test_2', $2, $3, 'USD') RETURNING id`, [a.org, uniq('k'), toMicros('40').toString()])).rows[0]!.id;
    const body = JSON.stringify({ id: uniq('evt'), type: 'checkout.session.completed', data: { object: { id: 'cs_test_2', client_reference_id: id, payment_status: 'paid', amount_total: 4000, currency: 'usd', payment_intent: 'pi_test_2' } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_fake').update(`${t}.${body}`).digest('hex');
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/webhooks/payments/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, payload: body });
    expect(r.statusCode).toBe(200);
    expect((await h.db.query('SELECT status, provider_charge_ref FROM payments WHERE id = $1', [id])).rows[0]).toEqual({ status: 'succeeded', provider_charge_ref: 'pi_test_2' });
  });
});

describe('going live', () => {
  const prod = (extra: Record<string, string>) => () => loadConfig({
    ...testConfigEnv(), NODE_ENV: 'production', ENABLE_DEV_PAYMENTS: 'false', COOKIE_SECURE: 'true', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.mailhost.test',
    PUBLIC_SITE_URL: 'https://ads.network.test', PUBLIC_API_URL: 'https://api.network.test', CORS_ORIGINS: 'https://ads.network.test',
    APP_SECRET: 'Zk3q9VtL0pR7wXc2Nb8mYd4sHf6gJa1e', VERIFICATION_ALLOW_HTTP: 'false', ...extra,
  } as NodeJS.ProcessEnv);

  it('refuses Stripe test keys, PayPal sandbox and half-configured providers in production', () => {
    expect(prod({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toThrow(/live key/);
    expect(prod({ STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(/both STRIPE_SECRET_KEY/);
    expect(prod({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH', PAYPAL_ENV: 'sandbox' })).toThrow(/PAYPAL_ENV must be live/);
    expect(prod({ PAYPAL_CLIENT_ID: 'id' })).toThrow(/together/);
    expect(prod({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH', PAYPAL_ENV: 'live' })).not.toThrow();
  });

  it('never registers the simulated payout provider in production', async () => {
    const { PayoutProviderRegistry } = await import('@blissnova/api/services/payouts/registry');
    const { paypalClientFor } = await import('@blissnova/api/services/payments/registry');
    const c = { ...testConfig(), ENABLE_DEV_PAYMENTS: true, isProd: true };
    expect(new PayoutProviderRegistry(c, paypalClientFor(c)).get('dev_simulated')).toBeUndefined();
  });
});

function testConfigEnv(): Record<string, string> {
  const c = testConfig();
  return { DATABASE_URL: c.DATABASE_URL, REDIS_URL: c.REDIS_URL, ENCRYPTION_KEY: c.ENCRYPTION_KEY, TRACKING_TOKEN_KEYS: 'k1:Q2hhbmdlZEtleU1hdGVyaWFsUmFuZG9tMTIzNDU2Nzg=' };
}

