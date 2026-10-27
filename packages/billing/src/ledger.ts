import type { PoolClient } from 'pg';

/**
 * Double-entry ledger primitives. Every call must run inside a database
 * transaction (a PoolClient after BEGIN). Postings are idempotent by key:
 * re-posting the same key returns the original transaction and writes nothing.
 * The database itself rejects unbalanced, mixed-currency, updated or deleted
 * ledger rows (see migration 0004), so these checks are defence in depth.
 */
export type AccountKind =
  | 'cash_clearing' | 'advertiser_wallet' | 'campaign_reserve' | 'publisher_pending' | 'publisher_available'
  | 'publisher_payout_processing' | 'platform_revenue' | 'platform_fees' | 'adjustments' | 'guarantee_expense';

export type TxnType =
  | 'payment' | 'campaign_reserve' | 'campaign_release' | 'ad_charge' | 'charge_reversal' | 'earnings_finalize'
  | 'payout_approve' | 'payout_paid' | 'payout_failed' | 'refund' | 'adjustment' | 'guarantee_topup';

export interface AccountRef { kind: AccountKind; orgId?: string | null; campaignId?: string | null }

/** Accounts whose natural balance is a credit (liabilities, revenue, equity). Their displayed balance is the negated sum. */
const CREDIT_NORMAL = new Set<AccountKind>(['advertiser_wallet', 'campaign_reserve', 'publisher_pending', 'publisher_available', 'publisher_payout_processing', 'platform_revenue', 'platform_fees', 'adjustments']);

export interface Posting {
  type: TxnType;
  currency: string;
  idempotencyKey: string;
  reference: { type: string; id: string };
  actor: { type: 'user'; userId: string } | { type: 'system' } | { type: 'provider'; provider: string };
  reason: string;
  entries: Array<{ account: AccountRef; amount: bigint }>;
}

export class LedgerError extends Error {
  constructor(message: string, public code: 'unbalanced' | 'insufficient_funds' | 'invalid' = 'invalid') {
    super(message);
  }
}

export async function accountId(client: PoolClient, ref: AccountRef, currency: string): Promise<string> {
  const orgId = ref.orgId ?? null;
  const campaignId = ref.campaignId ?? null;
  const ins = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (kind, org_id, campaign_id, currency) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, org_id, campaign_id, currency) DO NOTHING RETURNING id`,
    [ref.kind, orgId, campaignId, currency],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const sel = await client.query<{ id: string }>(
    `SELECT id FROM ledger_accounts WHERE kind = $1 AND org_id IS NOT DISTINCT FROM $2 AND campaign_id IS NOT DISTINCT FROM $3 AND currency = $4`,
    [ref.kind, orgId, campaignId, currency],
  );
  return sel.rows[0]!.id;
}

/** Lock an account row so concurrent balance checks on it serialize. */
export async function lockAccount(client: PoolClient, ref: AccountRef, currency: string): Promise<string> {
  const id = await accountId(client, ref, currency);
  await client.query('SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE', [id]);
  return id;
}

/** Natural-sign balance: positive means the account holds value of its normal type. */
export async function balance(client: Pick<PoolClient, 'query'>, ref: AccountRef, currency: string): Promise<bigint> {
  const r = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(e.amount_micros), 0)::text AS total FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.kind = $1 AND a.org_id IS NOT DISTINCT FROM $2 AND a.campaign_id IS NOT DISTINCT FROM $3 AND a.currency = $4`,
    [ref.kind, ref.orgId ?? null, ref.campaignId ?? null, currency],
  );
  const raw = BigInt(r.rows[0]?.total ?? '0');
  return CREDIT_NORMAL.has(ref.kind) ? -raw : raw;
}

export async function post(client: PoolClient, p: Posting): Promise<{ id: string; created: boolean }> {
  if (p.entries.length < 2) throw new LedgerError('A ledger transaction needs at least two entries');
  const sum = p.entries.reduce((acc, e) => acc + e.amount, 0n);
  if (sum !== 0n) throw new LedgerError(`Unbalanced posting (${sum})`, 'unbalanced');
  if (p.entries.some((e) => e.amount === 0n)) throw new LedgerError('Zero-amount entries are not allowed');
  if (!p.reason.trim()) throw new LedgerError('A reason is required for every ledger transaction');

  const existing = await client.query<{ id: string }>('SELECT id FROM ledger_transactions WHERE idempotency_key = $1', [p.idempotencyKey]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

  const actorUser = p.actor.type === 'user' ? p.actor.userId : null;
  const provider = p.actor.type === 'provider' ? p.actor.provider : null;
  const txn = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (type, currency, idempotency_key, reference_type, reference_id, actor_type, actor_user_id, provider, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [p.type, p.currency, p.idempotencyKey, p.reference.type, p.reference.id, p.actor.type, actorUser, provider, p.reason],
  );
  if (!txn.rows[0]) {
    const again = await client.query<{ id: string }>('SELECT id FROM ledger_transactions WHERE idempotency_key = $1', [p.idempotencyKey]);
    return { id: again.rows[0]!.id, created: false };
  }
  const txnId = txn.rows[0].id;
  for (const e of p.entries) {
    const acc = await accountId(client, e.account, p.currency);
    await client.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_micros) VALUES ($1, $2, $3)', [txnId, acc, e.amount.toString()]);
  }
  return { id: txnId, created: true };
}

/** Debit helper: moving `amount` from a credit-normal account `from` to credit-normal account `to`. */
export function transfer(from: AccountRef, to: AccountRef, amount: bigint) {
  return [
    { account: from, amount },        // debit reduces a credit-normal balance
    { account: to, amount: -amount }, // credit increases a credit-normal balance
  ];
}
