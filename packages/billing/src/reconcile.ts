import type { PoolClient, Pool } from 'pg';

export interface ReconciliationCheck { name: string; ok: boolean; detail: string; rows?: unknown[] }

/**
 * Cross-checks the ledger against operational tables. Any failing check is a
 * discrepancy for finance to investigate; nothing is auto-corrected.
 */
export async function reconcile(db: Pool | PoolClient): Promise<ReconciliationCheck[]> {
  const checks: ReconciliationCheck[] = [];

  const unbalanced = await db.query(`SELECT transaction_id, SUM(amount_micros)::text AS sum FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_micros) <> 0 LIMIT 50`);
  checks.push({ name: 'Every ledger transaction balances', ok: unbalanced.rowCount === 0, detail: `${unbalanced.rowCount} unbalanced transaction(s)`, rows: unbalanced.rows });

  // Retention-safe: settled charges are summarised in settlements, so raw events can be purged without breaking this check.
  const spend = await db.query(`
    SELECT c.id, c.name, c.spent_micros::text AS recorded, (COALESCE(s.net, 0) + COALESCE(u.total, 0) + COALESCE(pc.charged, 0))::text AS from_charges
    FROM campaigns c
    LEFT JOIN (SELECT campaign_id, SUM(charge_micros - reversed_micros) AS net FROM settlements GROUP BY campaign_id) s ON s.campaign_id = c.id
    LEFT JOIN (SELECT campaign_id, SUM(cost_micros) AS total FROM ad_events WHERE billable AND settlement_id IS NULL GROUP BY campaign_id) u ON u.campaign_id = c.id
    LEFT JOIN (SELECT campaign_id, SUM(charged_micros) AS charged FROM partner_campaigns GROUP BY campaign_id) pc ON pc.campaign_id = c.id
    WHERE c.spent_micros <> COALESCE(s.net, 0) + COALESCE(u.total, 0) + COALESCE(pc.charged, 0) LIMIT 50`);
  checks.push({ name: 'Campaign spend equals settled plus unsettled billable charges plus partner-network charges', ok: spend.rowCount === 0, detail: `${spend.rowCount} campaign(s) differ`, rows: spend.rows });

  const reserve = await db.query(`
    SELECT c.id, c.name, c.reserved_micros::text AS reserved, COALESCE(s.net, 0)::text AS settled_net, COALESCE(pc.charged, 0)::text AS partner_charged, COALESCE(l.bal, 0)::text AS ledger_balance
    FROM campaigns c
    LEFT JOIN (SELECT campaign_id, SUM(charge_micros - reversed_micros) AS net FROM settlements GROUP BY campaign_id) s ON s.campaign_id = c.id
    LEFT JOIN (SELECT campaign_id, SUM(charged_micros) AS charged FROM partner_campaigns GROUP BY campaign_id) pc ON pc.campaign_id = c.id
    LEFT JOIN (SELECT a.campaign_id, -SUM(e.amount_micros) AS bal FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'campaign_reserve' GROUP BY a.campaign_id) l ON l.campaign_id = c.id
    WHERE c.reserved_micros - COALESCE(s.net, 0) - COALESCE(pc.charged, 0) <> COALESCE(l.bal, 0) LIMIT 50`);
  checks.push({ name: 'Campaign reserve ledger matches reserved budget minus settled and partner-network charges', ok: reserve.rowCount === 0, detail: `${reserve.rowCount} campaign(s) differ`, rows: reserve.rows });

  const unsettledOld = await db.query(`SELECT campaign_id, count(*)::text AS n FROM ad_events WHERE billable AND settlement_id IS NULL AND received_at < now() - interval '2 hours' GROUP BY campaign_id LIMIT 50`);
  checks.push({ name: 'No billable events left unsettled for more than 2 hours', ok: unsettledOld.rowCount === 0, detail: `${unsettledOld.rowCount} campaign(s) with stale unsettled events`, rows: unsettledOld.rows });

  const negative = await db.query(`
    SELECT a.kind, a.org_id, a.campaign_id, a.currency, (-SUM(e.amount_micros))::text AS balance FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
    WHERE a.kind IN ('advertiser_wallet', 'campaign_reserve', 'publisher_payout_processing') GROUP BY a.id HAVING -SUM(e.amount_micros) < 0 LIMIT 50`);
  checks.push({ name: 'Wallets, reserves and in-flight payouts are not negative', ok: negative.rowCount === 0, detail: `${negative.rowCount} negative balance(s)`, rows: negative.rows });

  const payments = await db.query(`
    SELECT p.id, p.status FROM payments p LEFT JOIN ledger_transactions t ON t.id = p.ledger_txn_id
    WHERE (p.status IN ('succeeded', 'refunded', 'partially_refunded') AND t.id IS NULL) OR (p.status IN ('pending', 'failed', 'cancelled') AND p.ledger_txn_id IS NOT NULL) LIMIT 50`);
  checks.push({ name: 'Confirmed payments have exactly one ledger credit; unconfirmed have none', ok: payments.rowCount === 0, detail: `${payments.rowCount} inconsistent payment(s)`, rows: payments.rows });

  const payouts = await db.query(`
    SELECT id, status FROM payouts WHERE (status IN ('approved', 'processing', 'paid', 'failed') AND approve_txn_id IS NULL) OR (status IN ('paid', 'failed') AND final_txn_id IS NULL) LIMIT 50`);
  checks.push({ name: 'Payout status matches ledger postings', ok: payouts.rowCount === 0, detail: `${payouts.rowCount} inconsistent payout(s)`, rows: payouts.rows });

  const settlementSums = await db.query(`
    SELECT s.id FROM settlements s JOIN ledger_entries e ON e.transaction_id = s.ledger_txn_id JOIN ledger_accounts a ON a.id = e.account_id AND a.kind = 'campaign_reserve'
    WHERE e.amount_micros <> s.charge_micros LIMIT 50`);
  checks.push({ name: 'Settlement records match their ledger charge', ok: settlementSums.rowCount === 0, detail: `${settlementSums.rowCount} mismatched settlement(s)`, rows: settlementSums.rows });

  const guarantees = await db.query(`
    SELECT g.id FROM publisher_guarantees g LEFT JOIN ledger_entries e ON e.transaction_id = g.ledger_txn_id
      LEFT JOIN ledger_accounts a ON a.id = e.account_id AND a.kind = 'publisher_pending'
    WHERE g.topup_micros > 0 GROUP BY g.id, g.topup_micros HAVING COALESCE(-SUM(e.amount_micros) FILTER (WHERE a.id IS NOT NULL), 0) <> g.topup_micros LIMIT 50`);
  checks.push({ name: 'Guarantee top-ups match their ledger postings', ok: guarantees.rowCount === 0, detail: `${guarantees.rowCount} mismatched top-up(s)`, rows: guarantees.rows });

  const partner = await db.query(`
    SELECT pc.id, pc.charged_micros::text AS recorded, COALESCE(l.total, 0)::text AS ledger FROM partner_campaigns pc
    LEFT JOIN (SELECT t.reference_id, SUM(e.amount_micros) AS total FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id AND a.kind = 'campaign_reserve'
               WHERE t.type = 'partner_charge' GROUP BY t.reference_id) l ON l.reference_id = pc.id::text
    WHERE pc.charged_micros <> COALESCE(l.total, 0) LIMIT 50`);
  checks.push({ name: 'Partner-network charges match their ledger postings', ok: partner.rowCount === 0, detail: `${partner.rowCount} mismatched partner campaign(s)`, rows: partner.rows });

  return checks;
}
