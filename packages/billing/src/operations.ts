import type { PoolClient } from 'pg';
import { applyBps } from '@blissnova/shared';
import { LedgerError, balance, lockAccount, post, transfer, type AccountRef } from './ledger';

/**
 * Financial workflows built on the ledger. All functions expect to run in a
 * transaction owned by the caller, so a workflow and its audit/notification
 * side-records commit or roll back together.
 */
export type Actor = { type: 'user'; userId: string } | { type: 'system' } | { type: 'provider'; provider: string };

export class BillingError extends Error {
  constructor(message: string, public code: 'not_found' | 'conflict' | 'insufficient_funds' | 'invalid' | 'limit') {
    super(message);
  }
}

const big = (v: string | number | bigint | null | undefined) => BigInt(v ?? 0);

// ---------------------------------------------------------------- payments

export async function confirmPayment(client: PoolClient, args: { paymentId: string; actor: Actor; feeBps: number; providerRef?: string; note?: string; invoicePrefix: string }) {
  const r = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [args.paymentId]);
  const p = r.rows[0];
  if (!p) throw new BillingError('Payment not found', 'not_found');
  if (p.status === 'succeeded') return { payment: p, created: false };
  if (p.status !== 'pending') throw new BillingError(`Payment is ${p.status} and cannot be confirmed`, 'conflict');
  const amount = big(p.amount_micros);
  const fee = applyBps(amount, args.feeBps);
  const entries: Array<{ account: AccountRef; amount: bigint }> = [
    { account: { kind: 'cash_clearing' }, amount },
    { account: { kind: 'advertiser_wallet' as const, orgId: p.org_id }, amount: -(amount - fee) },
  ];
  if (fee > 0n) entries.push({ account: { kind: 'platform_fees' as const }, amount: -fee });
  const txn = await post(client, {
    type: 'payment', currency: p.currency, idempotencyKey: `payment:${p.id}`, reference: { type: 'payment', id: p.id },
    actor: args.actor, reason: args.note || `Payment confirmed via ${p.provider}`, entries,
  });
  const upd = await client.query(
    `UPDATE payments SET status = 'succeeded', fee_micros = $2, ledger_txn_id = $3, confirmed_at = now(), updated_at = now(),
       provider_ref = COALESCE($4, provider_ref), confirmed_by = $5, confirmation_note = $6 WHERE id = $1 RETURNING *`,
    [p.id, fee.toString(), txn.id, args.providerRef ?? null, args.actor.type === 'user' ? args.actor.userId : null, args.note ?? null],
  );
  await issueInvoice(client, {
    orgId: p.org_id, kind: 'receipt', currency: p.currency, total: amount, paymentId: p.id, prefix: args.invoicePrefix,
    lines: [
      { description: `Account funding via ${p.provider}`, amountMicros: amount.toString() },
      ...(fee > 0n ? [{ description: 'Platform fee (included)', amountMicros: (-fee).toString() }] : []),
    ],
  });
  return { payment: upd.rows[0], created: true };
}

export async function failPayment(client: PoolClient, paymentId: string, reason: string) {
  await client.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`, [paymentId, reason.slice(0, 500)]);
}

export async function refundPayment(client: PoolClient, args: { paymentId: string; amount: bigint; actor: { type: 'user'; userId: string }; reason: string; idempotencyKey: string; providerRef?: string; invoicePrefix: string }) {
  const prior = await client.query('SELECT * FROM refunds WHERE idempotency_key = $1', [args.idempotencyKey]);
  if (prior.rows[0]) return { refund: prior.rows[0], created: false };
  const r = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [args.paymentId]);
  const p = r.rows[0];
  if (!p) throw new BillingError('Payment not found', 'not_found');
  if (!['succeeded', 'partially_refunded'].includes(p.status)) throw new BillingError('Only settled payments can be refunded', 'conflict');
  if (args.amount <= 0n) throw new BillingError('Refund amount must be positive', 'invalid');
  const refundable = big(p.amount_micros) - big(p.refunded_micros);
  if (args.amount > refundable) throw new BillingError('Refund exceeds the refundable amount of this payment', 'limit');
  await lockAccount(client, { kind: 'advertiser_wallet', orgId: p.org_id }, p.currency);
  const wallet = await balance(client, { kind: 'advertiser_wallet', orgId: p.org_id }, p.currency);
  if (wallet < args.amount) throw new BillingError('Refund exceeds the unreserved wallet balance. Release campaign budgets first.', 'insufficient_funds');
  const refundId = (await client.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const txn = await post(client, {
    type: 'refund', currency: p.currency, idempotencyKey: `refund:${args.idempotencyKey}`, reference: { type: 'refund', id: refundId },
    actor: args.actor, reason: args.reason,
    entries: [
      { account: { kind: 'advertiser_wallet', orgId: p.org_id }, amount: args.amount },
      { account: { kind: 'cash_clearing' }, amount: -args.amount },
    ],
  });
  const refund = await client.query(
    `INSERT INTO refunds (id, payment_id, org_id, amount_micros, currency, status, reason, provider_ref, ledger_txn_id, actor_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9, $10) RETURNING *`,
    [refundId, p.id, p.org_id, args.amount.toString(), p.currency, args.reason, args.providerRef ?? null, txn.id, args.actor.userId, args.idempotencyKey],
  );
  const newRefunded = big(p.refunded_micros) + args.amount;
  await client.query(`UPDATE payments SET refunded_micros = $2, status = $3, updated_at = now() WHERE id = $1`, [p.id, newRefunded.toString(), newRefunded === big(p.amount_micros) ? 'refunded' : 'partially_refunded']);
  await issueInvoice(client, { orgId: p.org_id, kind: 'credit_note', currency: p.currency, total: -args.amount, paymentId: p.id, refundId, prefix: args.invoicePrefix, lines: [{ description: `Refund: ${args.reason}`, amountMicros: (-args.amount).toString() }] });
  return { refund: refund.rows[0], created: true };
}

export async function issueInvoice(client: PoolClient, a: { orgId: string; kind: 'receipt' | 'statement' | 'credit_note'; currency: string; total: bigint; lines: Array<{ description: string; amountMicros: string }>; paymentId?: string; refundId?: string; periodStart?: string; periodEnd?: string; prefix: string }) {
  const seq = await client.query<{ n: string }>(`SELECT nextval('invoice_number_seq')::text AS n`);
  const number = `${a.prefix}-${new Date().getUTCFullYear()}-${seq.rows[0]!.n}`;
  const r = await client.query(
    `INSERT INTO invoices (number, org_id, kind, currency, total_micros, lines, period_start, period_end, payment_id, refund_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, kind, period_start, period_end) DO NOTHING RETURNING *`,
    [number, a.orgId, a.kind, a.currency, a.total.toString(), JSON.stringify(a.lines), a.periodStart ?? null, a.periodEnd ?? null, a.paymentId ?? null, a.refundId ?? null],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------- campaign budgets

/** Move funds from the advertiser wallet into the campaign reserve so that reserved == lifetime budget. */
export async function reserveCampaignBudget(client: PoolClient, campaignId: string, actor: Actor) {
  const c = (await client.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
  if (!c) throw new BillingError('Campaign not found', 'not_found');
  const need = big(c.lifetime_budget_micros) - big(c.reserved_micros);
  if (need <= 0n) return { reserved: 0n };
  const wallet = { kind: 'advertiser_wallet' as const, orgId: c.org_id };
  await lockAccount(client, wallet, c.currency);
  const available = await balance(client, wallet, c.currency);
  if (available < need) throw new BillingError(`Insufficient funds: ${need} micros needed, ${available} available`, 'insufficient_funds');
  await post(client, {
    type: 'campaign_reserve', currency: c.currency, idempotencyKey: `reserve:${c.id}:${c.lifetime_budget_micros}`,
    reference: { type: 'campaign', id: c.id }, actor, reason: 'Reserve campaign budget',
    entries: transfer(wallet, { kind: 'campaign_reserve', orgId: c.org_id, campaignId: c.id }, need),
  });
  await client.query('UPDATE campaigns SET reserved_micros = lifetime_budget_micros WHERE id = $1', [c.id]);
  return { reserved: need };
}

/** Return reserved funds above the (reduced) lifetime budget to the wallet. */
export async function releaseExcessReserve(client: PoolClient, campaignId: string, actor: Actor) {
  const c = (await client.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
  if (!c) throw new BillingError('Campaign not found', 'not_found');
  const excess = big(c.reserved_micros) - big(c.lifetime_budget_micros);
  if (excess <= 0n) return { released: 0n };
  await post(client, {
    type: 'campaign_release', currency: c.currency, idempotencyKey: `release-excess:${c.id}:${c.reserved_micros}:${c.lifetime_budget_micros}`,
    reference: { type: 'campaign', id: c.id }, actor, reason: 'Lifetime budget reduced',
    entries: transfer({ kind: 'campaign_reserve', orgId: c.org_id, campaignId: c.id }, { kind: 'advertiser_wallet', orgId: c.org_id }, excess),
  });
  await client.query('UPDATE campaigns SET reserved_micros = lifetime_budget_micros WHERE id = $1', [c.id]);
  return { released: excess };
}

/** Settle outstanding charges, then return any unspent reserve to the wallet. */
export async function releaseCampaignReserve(client: PoolClient, campaignId: string, actor: Actor, reason: string, holdDays: number) {
  await settleCampaign(client, campaignId, holdDays);
  const c = (await client.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
  if (!c) throw new BillingError('Campaign not found', 'not_found');
  const reserveRef = { kind: 'campaign_reserve' as const, orgId: c.org_id, campaignId: c.id };
  const remaining = await balance(client, reserveRef, c.currency);
  if (remaining > 0n) {
    const n = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger_transactions WHERE reference_type = 'campaign' AND reference_id = $1 AND type = 'campaign_release'`, [c.id])).rows[0]!.n;
    await post(client, {
      type: 'campaign_release', currency: c.currency, idempotencyKey: `release:${c.id}:${n}:${remaining}`,
      reference: { type: 'campaign', id: c.id }, actor, reason,
      entries: transfer(reserveRef, { kind: 'advertiser_wallet', orgId: c.org_id }, remaining),
    });
  }
  await client.query('UPDATE campaigns SET reserved_micros = spent_micros WHERE id = $1', [c.id]);
  return { released: remaining > 0n ? remaining : 0n };
}

/**
 * Concurrency-safe charge. The conditional UPDATE takes a row lock on the
 * campaign, so simultaneous charges serialize and the WHERE clause guarantees
 * spend never exceeds the lifetime budget, the reserved funds, the daily
 * budget or delivery limits. Returns false when the charge is refused.
 */
export async function recordCharge(client: PoolClient, a: { campaignId: string; costMicros: bigint; kind: 'impression' | 'click'; day: string }): Promise<boolean> {
  const imp = a.kind === 'impression' ? 1 : 0;
  const clk = a.kind === 'click' ? 1 : 0;
  await client.query('SAVEPOINT charge');
  const upd = await client.query<{ daily_budget_micros: string | null }>(
    `UPDATE campaigns SET spent_micros = spent_micros + $2, billable_impressions = billable_impressions + $3, billable_clicks = billable_clicks + $4, updated_at = now()
     WHERE id = $1 AND status IN ('active', 'paused')
       AND spent_micros + $2 <= lifetime_budget_micros AND spent_micros + $2 <= reserved_micros
       AND (max_impressions IS NULL OR billable_impressions + $3 <= max_impressions)
       AND (max_clicks IS NULL OR billable_clicks + $4 <= max_clicks)
     RETURNING daily_budget_micros`,
    [a.campaignId, a.costMicros.toString(), imp, clk],
  );
  if (!upd.rows[0]) {
    await client.query('ROLLBACK TO SAVEPOINT charge');
    return false;
  }
  const daily = upd.rows[0].daily_budget_micros;
  const d = await client.query(
    `INSERT INTO campaign_daily_spend (campaign_id, day, spent_micros, impressions, clicks) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (campaign_id, day) DO UPDATE SET spent_micros = campaign_daily_spend.spent_micros + EXCLUDED.spent_micros,
       impressions = campaign_daily_spend.impressions + EXCLUDED.impressions, clicks = campaign_daily_spend.clicks + EXCLUDED.clicks
     WHERE $6::bigint IS NULL OR campaign_daily_spend.spent_micros + EXCLUDED.spent_micros <= $6::bigint
     RETURNING spent_micros`,
    [a.campaignId, a.day, a.costMicros.toString(), imp, clk, daily],
  );
  if (!d.rows[0] || (daily !== null && big(d.rows[0].spent_micros) > big(daily))) {
    await client.query('ROLLBACK TO SAVEPOINT charge');
    return false;
  }
  await client.query('RELEASE SAVEPOINT charge');
  return true;
}

/** Turn unsettled billable events into ledger charges, one settlement per publisher organization. Idempotent. */
export async function settleCampaign(client: PoolClient, campaignId: string, holdDays: number) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settle:${campaignId}`]);
  const c = (await client.query('SELECT id, org_id, currency FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!c) throw new BillingError('Campaign not found', 'not_found');
  const pubs = await client.query<{ publisher_org_id: string }>(
    `SELECT DISTINCT publisher_org_id FROM ad_events WHERE campaign_id = $1 AND billable AND settlement_id IS NULL`, [campaignId]);
  const results: Array<{ settlementId: string; charge: bigint; publisher: bigint }> = [];
  for (const { publisher_org_id: pubOrg } of pubs.rows) {
    const sid = (await client.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    const agg = await client.query<{ n: string; charge: string; pub: string }>(
      `WITH upd AS (
         UPDATE ad_events SET settlement_id = $3 WHERE campaign_id = $1 AND publisher_org_id = $2 AND billable AND settlement_id IS NULL
         RETURNING cost_micros, publisher_micros)
       SELECT count(*)::text AS n, COALESCE(sum(cost_micros), 0)::text AS charge, COALESCE(sum(publisher_micros), 0)::text AS pub FROM upd`,
      [campaignId, pubOrg, sid],
    );
    const charge = big(agg.rows[0]!.charge);
    const pub = big(agg.rows[0]!.pub);
    if (Number(agg.rows[0]!.n) === 0) continue;
    if (pub > charge) throw new LedgerError('Publisher share exceeds charge');
    const entries = [
      { account: { kind: 'campaign_reserve' as const, orgId: c.org_id, campaignId }, amount: charge },
      ...(pub > 0n ? [{ account: { kind: 'publisher_pending' as const, orgId: pubOrg }, amount: -pub }] : []),
      ...(charge - pub > 0n ? [{ account: { kind: 'platform_revenue' as const }, amount: -(charge - pub) }] : []),
    ];
    let txnId: string | null = null;
    if (charge > 0n) {
      txnId = (await post(client, {
        type: 'ad_charge', currency: c.currency, idempotencyKey: `settle:${sid}`, reference: { type: 'settlement', id: sid },
        actor: { type: 'system' }, reason: `Advertising charges for ${agg.rows[0]!.n} billable events`, entries,
      })).id;
    } else {
      continue;
    }
    await client.query(
      `INSERT INTO settlements (id, campaign_id, advertiser_org_id, publisher_org_id, currency, event_count, charge_micros, publisher_micros, ledger_txn_id, hold_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(days => $10))`,
      [sid, campaignId, c.org_id, pubOrg, c.currency, Number(agg.rows[0]!.n), charge.toString(), pub.toString(), txnId, holdDays],
    );
    results.push({ settlementId: sid, charge, publisher: pub });
  }
  return results;
}

/** Move publisher earnings whose hold period has ended from pending to available. */
export async function finalizeEarnings(client: PoolClient, now = new Date()) {
  const due = await client.query(
    `SELECT * FROM settlements WHERE finalized_at IS NULL AND hold_until <= $1 ORDER BY hold_until LIMIT 500 FOR UPDATE SKIP LOCKED`, [now]);
  let count = 0;
  for (const s of due.rows) {
    const amount = big(s.publisher_micros) - big(s.reversed_publisher_micros);
    let txnId: string | null = null;
    if (amount > 0n) {
      txnId = (await post(client, {
        type: 'earnings_finalize', currency: s.currency, idempotencyKey: `finalize:${s.id}`, reference: { type: 'settlement', id: s.id },
        actor: { type: 'system' }, reason: 'Hold period ended; earnings finalized',
        entries: transfer({ kind: 'publisher_pending', orgId: s.publisher_org_id }, { kind: 'publisher_available', orgId: s.publisher_org_id }, amount),
      })).id;
    }
    await client.query('UPDATE settlements SET finalized_at = now(), finalize_txn_id = $2 WHERE id = $1', [s.id, txnId]);
    count++;
  }
  return count;
}

/**
 * Exclude events from billable totals (manual IVT decision). Unsettled events
 * simply stop being billable; settled events are reversed with a new ledger
 * transaction. Original ledger rows are never altered.
 */
export async function excludeEvents(client: PoolClient, a: { eventIds: string[]; actor: { type: 'user'; userId: string }; reason: string; caseId?: string | null }) {
  if (a.eventIds.length === 0) return { excluded: 0, reversed: 0n };
  const rows = (await client.query(
    `WITH old AS (SELECT id, billable FROM ad_events WHERE id = ANY($1::uuid[]) AND excluded_at IS NULL FOR UPDATE)
     UPDATE ad_events e SET status = 'invalid', invalid_reason = 'manual_exclusion', billable = false, excluded_at = now(), excluded_by = $2, exclusion_case_id = $3
     FROM old WHERE e.id = old.id
     RETURNING e.id, e.type, old.billable AS was_billable, e.cost_micros, e.publisher_micros, e.settlement_id, e.campaign_id, e.advertiser_org_id, e.publisher_org_id, e.currency, e.occurred_at`,
    [a.eventIds, a.actor.userId, a.caseId ?? null],
  )).rows;
  let reversed = 0n;
  const bySettlement = new Map<string, { charge: bigint; pub: bigint; campaignId: string; advOrg: string; pubOrg: string; currency: string }>();
  for (const e of rows) {
    if (!e.was_billable) continue;
    const cost = big(e.cost_micros);
    const day = new Date(e.occurred_at).toISOString().slice(0, 10);
    await client.query(
      `UPDATE campaigns SET spent_micros = spent_micros - $2, billable_impressions = billable_impressions - $3, billable_clicks = billable_clicks - $4 WHERE id = $1`,
      [e.campaign_id, cost.toString(), e.type === 'render' ? 1 : 0, e.type === 'click' ? 1 : 0]);
    await client.query(`UPDATE campaign_daily_spend SET spent_micros = GREATEST(0, spent_micros - $3) WHERE campaign_id = $1 AND day = $2`, [e.campaign_id, day, cost.toString()]);
    if (e.settlement_id) {
      const cur = bySettlement.get(e.settlement_id) ?? { charge: 0n, pub: 0n, campaignId: e.campaign_id, advOrg: e.advertiser_org_id, pubOrg: e.publisher_org_id, currency: e.currency };
      cur.charge += cost;
      cur.pub += big(e.publisher_micros);
      bySettlement.set(e.settlement_id, cur);
    }
    reversed += cost;
  }
  for (const [sid, s] of bySettlement) {
    const st = (await client.query('SELECT finalized_at FROM settlements WHERE id = $1 FOR UPDATE', [sid])).rows[0];
    const pubKind = st?.finalized_at ? 'publisher_available' as const : 'publisher_pending' as const;
    const entries = [
      { account: { kind: 'campaign_reserve' as const, orgId: s.advOrg, campaignId: s.campaignId }, amount: -s.charge },
      ...(s.pub > 0n ? [{ account: { kind: pubKind, orgId: s.pubOrg }, amount: s.pub }] : []),
      ...(s.charge - s.pub > 0n ? [{ account: { kind: 'platform_revenue' as const }, amount: s.charge - s.pub }] : []),
    ];
    await post(client, {
      type: 'charge_reversal', currency: s.currency, idempotencyKey: `reverse:${sid}:${a.eventIds.slice().sort().join(',').slice(0, 200)}:${s.charge}`,
      reference: { type: 'settlement', id: sid }, actor: a.actor, reason: a.reason, entries,
    });
    await client.query('UPDATE settlements SET reversed_micros = reversed_micros + $2, reversed_publisher_micros = reversed_publisher_micros + $3 WHERE id = $1', [sid, s.charge.toString(), s.pub.toString()]);
  }
  return { excluded: rows.length, reversed };
}

// ---------------------------------------------------------------- payouts

export async function requestPayout(client: PoolClient, a: { orgId: string; amount: bigint; currency: string; userId: string; idempotencyKey: string; minimum: bigint }) {
  const prior = await client.query('SELECT * FROM payouts WHERE idempotency_key = $1', [a.idempotencyKey]);
  if (prior.rows[0]) return prior.rows[0];
  if (a.amount < a.minimum) throw new BillingError(`Minimum payout is ${a.minimum} micros`, 'limit');
  const profile = (await client.query('SELECT * FROM payout_profiles WHERE org_id = $1', [a.orgId])).rows[0];
  if (!profile) throw new BillingError('Add payout details before requesting a payout', 'invalid');
  await lockAccount(client, { kind: 'publisher_available', orgId: a.orgId }, a.currency);
  const available = await balance(client, { kind: 'publisher_available', orgId: a.orgId }, a.currency);
  if (a.amount > available) throw new BillingError('Requested amount exceeds the available balance', 'insufficient_funds');
  const r = await client.query(
    `INSERT INTO payouts (org_id, amount_micros, currency, method_label, idempotency_key, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [a.orgId, a.amount.toString(), a.currency, profile.display_label, a.idempotencyKey, a.userId],
  ).catch((err: { code?: string }) => {
    if (err.code === '23505') throw new BillingError('A payout request is already open for this account', 'conflict');
    throw err;
  });
  return r.rows[0];
}

async function lockPayout(client: PoolClient, id: string) {
  const p = (await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!p) throw new BillingError('Payout not found', 'not_found');
  return p;
}

export async function approvePayout(client: PoolClient, id: string, actor: { type: 'user'; userId: string }, reason: string) {
  const p = await lockPayout(client, id);
  if (p.status !== 'requested') throw new BillingError(`Payout is ${p.status}`, 'conflict');
  if (p.requested_by === actor.userId) throw new BillingError('A payout cannot be approved by the person who requested it', 'conflict');
  const avail = { kind: 'publisher_available' as const, orgId: p.org_id };
  await lockAccount(client, avail, p.currency);
  if ((await balance(client, avail, p.currency)) < big(p.amount_micros)) throw new BillingError('Available balance no longer covers this payout', 'insufficient_funds');
  const txn = await post(client, {
    type: 'payout_approve', currency: p.currency, idempotencyKey: `payout-approve:${p.id}`, reference: { type: 'payout', id: p.id }, actor, reason,
    entries: transfer(avail, { kind: 'publisher_payout_processing', orgId: p.org_id }, big(p.amount_micros)),
  });
  return (await client.query(`UPDATE payouts SET status = 'approved', reviewed_by = $2, review_reason = $3, approve_txn_id = $4, updated_at = now() WHERE id = $1 RETURNING *`, [p.id, actor.userId, reason, txn.id])).rows[0];
}

export async function rejectPayout(client: PoolClient, id: string, actor: { type: 'user'; userId: string }, reason: string) {
  const p = await lockPayout(client, id);
  if (p.status !== 'requested') throw new BillingError(`Payout is ${p.status}`, 'conflict');
  return (await client.query(`UPDATE payouts SET status = 'rejected', reviewed_by = $2, review_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`, [p.id, actor.userId, reason])).rows[0];
}

export async function markPayoutProcessing(client: PoolClient, id: string, provider: string, providerRef: string | null) {
  const p = await lockPayout(client, id);
  if (p.status !== 'approved') throw new BillingError(`Payout is ${p.status}`, 'conflict');
  return (await client.query(`UPDATE payouts SET status = 'processing', provider = $2, provider_ref = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, provider, providerRef])).rows[0];
}

export async function markPayoutPaid(client: PoolClient, id: string, actor: Actor, providerRef: string, reason: string) {
  const p = await lockPayout(client, id);
  if (p.status === 'paid') return p;
  if (!['approved', 'processing'].includes(p.status)) throw new BillingError(`Payout is ${p.status}`, 'conflict');
  const txn = await post(client, {
    type: 'payout_paid', currency: p.currency, idempotencyKey: `payout-paid:${p.id}`, reference: { type: 'payout', id: p.id }, actor, reason,
    entries: [
      { account: { kind: 'publisher_payout_processing', orgId: p.org_id }, amount: big(p.amount_micros) },
      { account: { kind: 'cash_clearing' }, amount: -big(p.amount_micros) },
    ],
  });
  return (await client.query(`UPDATE payouts SET status = 'paid', provider_ref = $2, final_txn_id = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, providerRef, txn.id])).rows[0];
}

export async function markPayoutFailed(client: PoolClient, id: string, actor: Actor, failureReason: string) {
  const p = await lockPayout(client, id);
  if (p.status === 'failed') return p;
  if (!['approved', 'processing'].includes(p.status)) throw new BillingError(`Payout is ${p.status}`, 'conflict');
  const txn = await post(client, {
    type: 'payout_failed', currency: p.currency, idempotencyKey: `payout-failed:${p.id}`, reference: { type: 'payout', id: p.id }, actor, reason: failureReason,
    entries: transfer({ kind: 'publisher_payout_processing', orgId: p.org_id }, { kind: 'publisher_available', orgId: p.org_id }, big(p.amount_micros)),
  });
  return (await client.query(`UPDATE payouts SET status = 'failed', failure_reason = $2, final_txn_id = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, failureReason, txn.id])).rows[0];
}

// ---------------------------------------------------------------- adjustments

const ADJUSTABLE = new Set(['advertiser_wallet', 'publisher_available']);

/** Finance-approved manual credit (positive) or debit (negative) against an organization balance, offset to the adjustments account. */
export async function manualAdjustment(client: PoolClient, a: { orgId: string; kind: 'advertiser_wallet' | 'publisher_available'; currency: string; amount: bigint; actor: { type: 'user'; userId: string }; reason: string; idempotencyKey: string }) {
  if (!ADJUSTABLE.has(a.kind)) throw new BillingError('Account kind cannot be adjusted manually', 'invalid');
  if (a.amount === 0n) throw new BillingError('Amount must be non-zero', 'invalid');
  if (a.reason.trim().length < 5) throw new BillingError('A descriptive reason is required', 'invalid');
  if (a.amount < 0n) {
    await lockAccount(client, { kind: a.kind, orgId: a.orgId }, a.currency);
    if ((await balance(client, { kind: a.kind, orgId: a.orgId }, a.currency)) < -a.amount) throw new BillingError('Debit exceeds balance', 'insufficient_funds');
  }
  return post(client, {
    type: 'adjustment', currency: a.currency, idempotencyKey: `adjust:${a.idempotencyKey}`, reference: { type: 'organization', id: a.orgId }, actor: a.actor, reason: a.reason,
    entries: [
      { account: { kind: a.kind, orgId: a.orgId }, amount: -a.amount },
      { account: { kind: 'adjustments' }, amount: a.amount },
    ],
  });
}
