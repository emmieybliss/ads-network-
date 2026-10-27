-- Refuse to roll back over data the older schema cannot hold.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM creatives WHERE format = 'native') THEN
    RAISE EXCEPTION 'Native creatives exist; rolling back would require deleting them';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE type = 'guarantee_topup') THEN
    RAISE EXCEPTION 'Guarantee top-ups are recorded in the ledger; rolling back would require removing financial records';
  END IF;
END $$;

UPDATE sites SET allowed_formats = array_remove(allowed_formats, 'native');
ALTER TABLE sites ALTER COLUMN allowed_formats SET DEFAULT '{image,text}';
UPDATE ad_units SET formats = CASE WHEN formats = '{native}' THEN '{image,text}' ELSE array_remove(formats, 'native') END WHERE 'native' = ANY (formats);

ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_native_check;
ALTER TABLE creatives DROP COLUMN IF EXISTS sponsor_name;
ALTER TABLE creatives DROP CONSTRAINT creatives_format_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_format_check CHECK (format IN ('image', 'text'));

DROP TABLE IF EXISTS publisher_guarantees;
DELETE FROM ledger_accounts a WHERE a.kind = 'guarantee_expense' AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.account_id = a.id);
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check CHECK (type IN (
  'payment', 'campaign_reserve', 'campaign_release', 'ad_charge', 'charge_reversal', 'earnings_finalize',
  'payout_approve', 'payout_paid', 'payout_failed', 'refund', 'adjustment'));
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'cash_clearing', 'advertiser_wallet', 'campaign_reserve', 'publisher_pending', 'publisher_available',
  'publisher_payout_processing', 'platform_revenue', 'platform_fees', 'adjustments'));

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_premium_only_check, DROP CONSTRAINT IF EXISTS organizations_guarantee_cap_check,
  DROP CONSTRAINT IF EXISTS organizations_earnings_terms_check,
  DROP COLUMN IF EXISTS premium_advertisers_only, DROP COLUMN IF EXISTS guarantee_monthly_cap_micros, DROP COLUMN IF EXISTS min_cpc_micros,
  DROP COLUMN IF EXISTS min_cpm_micros, DROP COLUMN IF EXISTS earnings_mode, DROP COLUMN IF EXISTS tier;
