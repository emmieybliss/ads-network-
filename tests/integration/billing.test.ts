import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balance, excludeEvents, finalizeEarnings, manualAdjustment, reconcile, requestPayout, approvePayout, markPayoutPaid, settleCampaign } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, setSettings, TEST_PASSWORD, uniq } from '../helpers/fixtures';

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

async function signedIn(opts: Parameters<typeof makeUser>[1] = {}) {
  const u = await makeUser(h.db, opts);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { user: u, cl };
}

async function inTx<T>(fn: (c: Parameters<typeof settleCampaign>[0]) => Promise<T>): Promise<T> {
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

const wallet = (orgId: string) => inTx((c) => balance(c, { kind: 'advertiser_wallet', orgId }, 'USD'));
const available = (orgId: string) => inTx((c) => balance(c, { kind: 'publisher_available', orgId }, 'USD'));
const pending = (orgId: string) => inTx((c) => balance(c, { kind: 'publisher_pending', orgId }, 'USD'));

function devSignature(body: string, secret: string) {
  return createHmac('sha256', `${secret}:dev-payments`).update(body).digest('hex');
}

describe('funding an advertiser account', () => {
  it('does not credit anything until the provider confirms', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.req('POST', `/api/v1/orgs/${org}/billing/payments`, {
      body: { provider: 'dev_simulated', amount: '100.00' },
      headers: { 'idempotency-key': uniq('idem') },
    });
    expect(r.status).toBeLessThan(300);
    expect(r.body.data.status).toBe('pending');
    // A pending payment must move no money. This is the rule that stops a
    // browser redirect from crediting an account.
    expect(await wallet(org)).toBe(0n);
    expect((await h.db.query('SELECT 1 FROM ledger_transactions')).rowCount).toBe(0);
  });

  it('requires an idempotency key', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.post(`/api/v1/orgs/${org}/billing/payments`, { provider: 'dev_simulated', amount: '100.00' });
    expect(r.status).toBe(400);
  });

  it('returns the same payment for a repeated idempotency key', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const key = uniq('idem');
    const a = await s.cl.req('POST', `/api/v1/orgs/${org}/billing/payments`, { body: { provider: 'dev_simulated', amount: '100.00' }, headers: { 'idempotency-key': key } });
    const b = await s.cl.req('POST', `/api/v1/orgs/${org}/billing/payments`, { body: { provider: 'dev_simulated', amount: '100.00' }, headers: { 'idempotency-key': key } });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect((await h.db.query('SELECT 1 FROM payments')).rowCount).toBe(1);
  });

  it('refuses an amount with more than two decimal places', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.req('POST', `/api/v1/orgs/${org}/billing/payments`, {
      body: { provider: 'dev_simulated', amount: '100.001' },
      headers: { 'idempotency-key': uniq('idem') },
    });
    expect(r.status).toBe(400);
  });
});

describe('payment webhooks', () => {
  async function pendingPayment(orgId: string, amount = '100.00') {
    const id = (
      await h.db.query<{ id: string }>(
        `INSERT INTO payments (id, org_id, provider, idempotency_key, amount_micros, fee_micros, currency, status, refunded_micros, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'dev_simulated', $2, $3, 0, 'USD', 'pending', 0, now(), now()) RETURNING id`,
        [orgId, uniq('idem'), toMicros(amount).toString()],
      )
    ).rows[0]!.id;
    return id;
  }

  function hook(paymentId: string, amount = '100.00', eventId = uniq('evt'), outcome: 'succeeded' | 'failed' = 'succeeded') {
    const body = JSON.stringify({ id: eventId, paymentId, outcome, amountMicros: toMicros(amount).toString(), currency: 'USD' });
    return { body, signature: devSignature(body, h.config.APP_SECRET) };
  }

  const post = (body: string, headers: Record<string, string>) =>
    h.app.inject({ method: 'POST', url: '/api/v1/webhooks/payments/dev_simulated', headers: { 'content-type': 'application/json', ...headers }, payload: body });

  it('credits the wallet on a correctly signed success', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const payment = await pendingPayment(org, '250.00');
    const { body, signature } = hook(payment, '250.00');
    const r = await post(body, { 'x-dev-signature': signature });
    expect(r.statusCode).toBeLessThan(300);
    expect(await wallet(org)).toBe(toMicros('250'));
  });

  it('refuses an unsigned or wrongly signed webhook and credits nothing', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const payment = await pendingPayment(org);
    const { body } = hook(payment);

    expect((await post(body, {})).statusCode).toBe(400);
    expect((await post(body, { 'x-dev-signature': 'f'.repeat(64) })).statusCode).toBe(400);
    expect(await wallet(org)).toBe(0n);
  });

  it('records a bad signature as a security event', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const { body } = hook(await pendingPayment(org));
    await post(body, { 'x-dev-signature': 'f'.repeat(64) });
    const rows = await h.db.query(`SELECT 1 FROM security_events WHERE type = 'webhook_signature_invalid'`);
    expect(rows.rowCount).toBeGreaterThan(0);
  });

  it('credits only once when the provider retries the same event', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const payment = await pendingPayment(org, '100.00');
    const { body, signature } = hook(payment, '100.00', 'evt-fixed-id');

    for (let i = 0; i < 4; i++) await post(body, { 'x-dev-signature': signature });
    expect(await wallet(org)).toBe(toMicros('100'));
    const credits = await h.db.query(`SELECT 1 FROM ledger_transactions WHERE reference_type = 'payment' AND reference_id = $1`, [payment]);
    expect(credits.rowCount).toBe(1);
  });

  it('credits only once when the same event arrives concurrently', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const payment = await pendingPayment(org, '100.00');
    const { body, signature } = hook(payment, '100.00', 'evt-concurrent');
    await Promise.all(Array.from({ length: 6 }, () => post(body, { 'x-dev-signature': signature })));
    expect(await wallet(org)).toBe(toMicros('100'));
  });

  it('refuses to credit an amount that does not match the payment', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const payment = await pendingPayment(org, '100.00');
    // A webhook claiming more than the payment was created for must not be honoured.
    const { body, signature } = hook(payment, '10000.00');
    await post(body, { 'x-dev-signature': signature });
    expect(await wallet(org)).toBe(0n);
  });

  it('marks a failed payment failed without moving money', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const payment = await pendingPayment(org);
    const { body, signature } = hook(payment, '100.00', uniq('evt'), 'failed');
    await post(body, { 'x-dev-signature': signature });
    const row = await h.db.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [payment]);
    expect(row.rows[0]!.status).toBe('failed');
    expect(await wallet(org)).toBe(0n);
  });
});

describe('the ledger itself', () => {
  it('refuses an unbalanced transaction', async () => {
    const { post } = await import('@blissnova/billing');
    await expect(
      inTx((c) =>
        post(c, {
          type: 'adjustment',
          currency: 'USD',
          idempotencyKey: uniq('k'),
          reference: { type: 'test', id: uniq('r') },
          actor: { type: 'system' },
          reason: 'deliberately unbalanced',
          entries: [
            { account: { kind: 'cash_clearing' }, amount: 100n },
            { account: { kind: 'platform_revenue' }, amount: -50n },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a transaction with a single entry', async () => {
    const { post } = await import('@blissnova/billing');
    await expect(
      inTx((c) =>
        post(c, {
          type: 'adjustment',
          currency: 'USD',
          idempotencyKey: uniq('k'),
          reference: { type: 'test', id: uniq('r') },
          actor: { type: 'system' },
          reason: 'single entry',
          entries: [{ account: { kind: 'cash_clearing' }, amount: 0n }],
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a reason-free transaction, so every movement is explainable', async () => {
    const { post, transfer } = await import('@blissnova/billing');
    await expect(
      inTx((c) =>
        post(c, {
          type: 'adjustment',
          currency: 'USD',
          idempotencyKey: uniq('k'),
          reference: { type: 'test', id: uniq('r') },
          actor: { type: 'system' },
          reason: '   ',
          entries: transfer({ kind: 'cash_clearing' }, { kind: 'platform_revenue' }, 100n),
        }),
      ),
    ).rejects.toThrow();
  });

  it('will not let an entry be changed or deleted afterwards', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    await fundOrg(h.db, org, '100');
    await expect(h.db.query('UPDATE ledger_entries SET amount_micros = 1')).rejects.toThrow();
    await expect(h.db.query('DELETE FROM ledger_entries')).rejects.toThrow();
  });

  it('applies the same posting once when its idempotency key repeats', async () => {
    const { post, transfer } = await import('@blissnova/billing');
    const key = uniq('idem');
    const once = () =>
      inTx((c) =>
        post(c, {
          type: 'adjustment',
          currency: 'USD',
          idempotencyKey: key,
          reference: { type: 'test', id: 'r1' },
          actor: { type: 'system' },
          reason: 'repeated posting',
          entries: transfer({ kind: 'cash_clearing' }, { kind: 'platform_revenue' }, 1000n),
        }),
      );
    const a = await once();
    const b = await once();
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
    expect((await h.db.query('SELECT 1 FROM ledger_transactions')).rowCount).toBe(1);
  });
});

describe('budget reservation', () => {
  it('refuses to reserve more than the wallet holds', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    await fundOrg(h.db, org, '10');
    const campaign = await makeCampaign(h.db, { orgId: org, lifetime: '1000' });
    await expect(reserve(h.db, campaign)).rejects.toThrow(/insufficient|funds/i);
  });

  it('moves money out of the wallet and into the campaign reserve', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    await fundOrg(h.db, org, '1000');
    const campaign = await makeCampaign(h.db, { orgId: org, lifetime: '400' });
    await reserve(h.db, campaign);
    expect(await wallet(org)).toBe(toMicros('600'));
    const reserved = await inTx((c) => balance(c, { kind: 'campaign_reserve', orgId: org, campaignId: campaign }, 'USD'));
    expect(reserved).toBe(toMicros('400'));
  });
});

describe('settlement and publisher earnings', () => {
  async function delivered(opts: { impressions: number; cpm: string; shareBps: number }) {
    const advUser = await makeUser(h.db);
    const pubUser = await makeUser(h.db);
    const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
    const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: opts.shareBps });
    const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
    const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'] });
    await fundOrg(h.db, advOrg, '5000');
    const campaign = await makeCampaign(h.db, { orgId: advOrg, rate: opts.cpm, lifetime: '1000', daily: null });
    await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image' });
    await reserve(h.db, campaign);
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);

    for (let i = 0; i < opts.impressions; i++) {
      const served = await h.app.inject({
        method: 'POST',
        url: '/api/v1/serve',
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36', origin: 'http://pub.example.org' },
        payload: { siteKey: site.publicKey, units: [{ slot: unit.key }], page: { url: 'http://pub.example.org/a' }, pv: uniq('pv0000000000') },
      });
      const ad = JSON.parse(served.body).ads[0].ad;
      if (!ad) break;
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36', referer: 'http://pub.example.org/a' },
        payload: { events: [{ id: uniq('ev0000000000'), type: 'render', t: ad.token }] },
      });
    }
    return { advOrg, pubOrg, campaign, site, unit };
  }

  it('splits a charge between the publisher and the platform', async () => {
    // 100 impressions at a $10 CPM is $1.00 of spend; 70% to the publisher.
    const d = await delivered({ impressions: 100, cpm: '10.00', shareBps: 7000 });
    const out = await inTx((c) => settleCampaign(c, d.campaign, 30));
    expect(out).toHaveLength(1);
    expect(out[0]!.charge).toBe(toMicros('1'));
    expect(out[0]!.publisher).toBe(toMicros('0.70'));

    // Earnings sit in "pending" until the hold period passes.
    expect(await pending(d.pubOrg)).toBe(toMicros('0.70'));
    expect(await available(d.pubOrg)).toBe(0n);

    const platform = await inTx((c) => balance(c, { kind: 'platform_revenue' }, 'USD'));
    expect(platform).toBe(toMicros('0.30'));
  });

  it('settles the same events only once', async () => {
    const d = await delivered({ impressions: 50, cpm: '10.00', shareBps: 7000 });
    await inTx((c) => settleCampaign(c, d.campaign, 30));
    const again = await inTx((c) => settleCampaign(c, d.campaign, 30));
    expect(again).toHaveLength(0);
    // 50 impressions at a $10 CPM is $0.50 of spend; the publisher's 70% share
    // is $0.35, and settling twice must not double it.
    expect(await pending(d.pubOrg)).toBe(toMicros('0.35'));
  });

  it('moves earnings to available once the hold period is over', async () => {
    const d = await delivered({ impressions: 100, cpm: '10.00', shareBps: 7000 });
    await inTx((c) => settleCampaign(c, d.campaign, 0));
    const finalized = await inTx((c) => finalizeEarnings(c));
    expect(finalized).toBeGreaterThan(0);
    expect(await available(d.pubOrg)).toBe(toMicros('0.70'));
    expect(await pending(d.pubOrg)).toBe(0n);
  });

  it('holds earnings back while the hold period still runs', async () => {
    const d = await delivered({ impressions: 100, cpm: '10.00', shareBps: 7000 });
    await inTx((c) => settleCampaign(c, d.campaign, 30));
    await inTx((c) => finalizeEarnings(c));
    expect(await available(d.pubOrg)).toBe(0n);
  });

  it('reverses a settled charge when the events are later excluded as invalid', async () => {
    const d = await delivered({ impressions: 100, cpm: '10.00', shareBps: 7000 });
    await inTx((c) => settleCampaign(c, d.campaign, 30));
    const before = await pending(d.pubOrg);
    expect(before).toBe(toMicros('0.70'));

    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    const ids = (await h.db.query<{ id: string }>(`SELECT id FROM ad_events WHERE billable LIMIT 40`)).rows.map((r) => r.id);
    const out = await inTx((c) =>
      excludeEvents(c, { eventIds: ids, actor: { type: 'user', userId: admin.id }, reason: 'Invalid traffic review', caseId: null }),
    );
    expect(out.excluded).toBe(40);
    expect(out.reversed).toBe(toMicros('0.40'));

    // The publisher's pending balance comes down by their share of it.
    expect(await pending(d.pubOrg)).toBe(toMicros('0.42'));
    // The advertiser's spend is reduced too.
    const camp = await h.db.query<{ spent_micros: string }>('SELECT spent_micros FROM campaigns WHERE id = $1', [d.campaign]);
    expect(camp.rows[0]!.spent_micros).toBe(toMicros('0.60').toString());
    // The reversal is itself a ledger entry, not an edit of the original.
    const reversals = await h.db.query(`SELECT 1 FROM ledger_transactions WHERE type = 'charge_reversal'`);
    expect(reversals.rowCount).toBeGreaterThan(0);
  });

  it('keeps every reconciliation check passing through all of that', async () => {
    const d = await delivered({ impressions: 100, cpm: '10.00', shareBps: 7000 });
    await inTx((c) => settleCampaign(c, d.campaign, 0));
    await inTx((c) => finalizeEarnings(c));
    const checks = await reconcile(h.db);
    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(8);
  });
});

describe('payouts', () => {
  async function publisherWithFunds(amount = '500') {
    const u = await makeUser(h.db);
    const org = await makeOrg(h.db, { type: 'publisher', ownerId: u.id });
    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    // Credit the publisher's available balance through an auditable adjustment.
    await inTx((c) =>
      manualAdjustment(c, {
        orgId: org,
        kind: 'publisher_available',
        amount: toMicros(amount),
        currency: 'USD',
        actor: { type: 'user', userId: admin.id },
        reason: 'Test credit for payout flow',
        idempotencyKey: uniq('adj'),
      }),
    );
    await h.db.query(
      `INSERT INTO payout_profiles (org_id, method, display_label, currency, updated_by) VALUES ($1, 'bank_transfer', 'Test account', 'USD', $2)`,
      [org, u.id],
    );
    return { org, owner: u, admin };
  }

  it('refuses a payout larger than the available balance', async () => {
    const p = await publisherWithFunds('100');
    await expect(
      inTx((c) => requestPayout(c, { orgId: p.org, amount: toMicros('200'), currency: 'USD', userId: p.owner.id, idempotencyKey: uniq('po'), minimum: 0n })),
    ).rejects.toThrow();
  });

  it('refuses a payout below the platform minimum', async () => {
    const p = await publisherWithFunds('100');
    await expect(
      inTx((c) => requestPayout(c, { orgId: p.org, amount: toMicros('5'), currency: 'USD', userId: p.owner.id, idempotencyKey: uniq('po'), minimum: toMicros('50') })),
    ).rejects.toThrow();
  });

  it('will not let the requester approve their own payout', async () => {
    const p = await publisherWithFunds('500');
    const payout = await inTx((c) =>
      requestPayout(c, { orgId: p.org, amount: toMicros('100'), currency: 'USD', userId: p.owner.id, idempotencyKey: uniq('po'), minimum: 0n }),
    );
    await expect(
      inTx((c) => approvePayout(c, payout.id, { type: 'user', userId: p.owner.id }, 'self approval attempt')),
    ).rejects.toThrow();
  });

  it('moves money from available to in-flight to paid, once each', async () => {
    const p = await publisherWithFunds('500');
    const payout = await inTx((c) =>
      requestPayout(c, { orgId: p.org, amount: toMicros('100'), currency: 'USD', userId: p.owner.id, idempotencyKey: uniq('po'), minimum: 0n }),
    );
    // A request alone moves no money: it is a claim, not a transfer.
    expect(await available(p.org)).toBe(toMicros('500'));

    // Approval is what moves the money out of the available balance and into
    // the in-flight account.
    await inTx((c) => approvePayout(c, payout.id, { type: 'user', userId: p.admin.id }, 'Approved in test'));
    expect(await available(p.org)).toBe(toMicros('400'));
    expect(await inTx((c) => balance(c, { kind: 'publisher_payout_processing', orgId: p.org }, 'USD'))).toBe(toMicros('100'));

    // Paying it clears the in-flight account out to cash.
    await inTx((c) => markPayoutPaid(c, payout.id, { type: 'user', userId: p.admin.id }, 'TEST-REF-1', 'Paid in test'));
    expect(await available(p.org)).toBe(toMicros('400'));
    expect(await inTx((c) => balance(c, { kind: 'publisher_payout_processing', orgId: p.org }, 'USD'))).toBe(0n);
    const row = await h.db.query<{ status: string }>('SELECT status FROM payouts WHERE id = $1', [payout.id]);
    expect(row.rows[0]!.status).toBe('paid');

    const failed = (await reconcile(h.db)).filter((c) => !c.ok);
    expect(failed.map((f) => f.name)).toEqual([]);
  });

  it('allows only one open payout request at a time', async () => {
    const p = await publisherWithFunds('500');
    await inTx((c) => requestPayout(c, { orgId: p.org, amount: toMicros('100'), currency: 'USD', userId: p.owner.id, idempotencyKey: uniq('po'), minimum: 0n }));
    await expect(
      inTx((c) => requestPayout(c, { orgId: p.org, amount: toMicros('100'), currency: 'USD', userId: p.owner.id, idempotencyKey: uniq('po'), minimum: 0n })),
    ).rejects.toThrow();
  });
});

describe('manual adjustments', () => {
  it('requires a reason and records who made it', async () => {
    const u = await makeUser(h.db);
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: u.id });
    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    await expect(
      inTx((c) => manualAdjustment(c, { orgId: org, kind: 'advertiser_wallet', amount: toMicros('10'), currency: 'USD', actor: { type: 'user', userId: admin.id }, reason: '', idempotencyKey: uniq('adj') })),
    ).rejects.toThrow();

    await inTx((c) =>
      manualAdjustment(c, { orgId: org, kind: 'advertiser_wallet', amount: toMicros('10'), currency: 'USD', actor: { type: 'user', userId: admin.id }, reason: 'Goodwill credit, ticket 123', idempotencyKey: uniq('adj') }),
    );
    const txn = await h.db.query<{ actor_user_id: string; reason: string }>(`SELECT actor_user_id, reason FROM ledger_transactions WHERE type = 'adjustment'`);
    expect(txn.rows[0]!.actor_user_id).toBe(admin.id);
    expect(txn.rows[0]!.reason).toContain('ticket 123');
  });
});
