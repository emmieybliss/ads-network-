-- Refuse to roll back over financial records the older schema cannot hold.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE type = 'partner_charge') THEN
    RAISE EXCEPTION 'Partner charges are recorded in the ledger; rolling back would require removing financial records';
  END IF;
END $$;

DELETE FROM ledger_accounts a WHERE a.kind = 'partner_payable' AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.account_id = a.id);
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check CHECK (type IN (
  'payment', 'campaign_reserve', 'campaign_release', 'ad_charge', 'charge_reversal', 'earnings_finalize',
  'payout_approve', 'payout_paid', 'payout_failed', 'refund', 'adjustment', 'guarantee_topup'));
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'cash_clearing', 'advertiser_wallet', 'campaign_reserve', 'publisher_pending', 'publisher_available',
  'publisher_payout_processing', 'platform_revenue', 'platform_fees', 'adjustments',
  'guarantee_expense'));

DROP TABLE partner_daily_stats;
DROP TABLE partner_creatives;
DROP TABLE partner_campaigns;
DROP TABLE partner_networks;
