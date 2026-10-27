-- Premium tiers, publisher earnings minimums (price floor or network
-- guarantee), and the native ad format.

-- ------------------------------------------------------------ premium tiers
ALTER TABLE organizations
  ADD COLUMN tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'premium')),
  -- Publisher only. 'floor': ads serve only when the publisher's share meets the minimum.
  -- 'guarantee': any ad serves and the network tops earnings up to the minimum, within a monthly cap.
  ADD COLUMN earnings_mode text CHECK (earnings_mode IS NULL OR earnings_mode IN ('floor', 'guarantee')),
  -- Minimum publisher earnings per 1,000 valid impressions (CPM campaigns) and per valid click (CPC campaigns).
  ADD COLUMN min_cpm_micros bigint CHECK (min_cpm_micros IS NULL OR min_cpm_micros > 0),
  ADD COLUMN min_cpc_micros bigint CHECK (min_cpc_micros IS NULL OR min_cpc_micros > 0),
  ADD COLUMN guarantee_monthly_cap_micros bigint CHECK (guarantee_monthly_cap_micros IS NULL OR guarantee_monthly_cap_micros >= 0),
  -- Publisher only: inventory reserved for premium advertisers.
  ADD COLUMN premium_advertisers_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT organizations_earnings_terms_check CHECK (
    earnings_mode IS NULL OR (type = 'publisher' AND tier = 'premium' AND (min_cpm_micros IS NOT NULL OR min_cpc_micros IS NOT NULL))),
  ADD CONSTRAINT organizations_guarantee_cap_check CHECK (earnings_mode IS DISTINCT FROM 'guarantee' OR guarantee_monthly_cap_micros IS NOT NULL),
  ADD CONSTRAINT organizations_premium_only_check CHECK (NOT premium_advertisers_only OR (type = 'publisher' AND tier = 'premium'));

-- ------------------------------------------------------------ guarantee top-ups
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'cash_clearing', 'advertiser_wallet', 'campaign_reserve', 'publisher_pending', 'publisher_available',
  'publisher_payout_processing', 'platform_revenue', 'platform_fees', 'adjustments',
  'guarantee_expense'   -- expense: network-funded top-ups of guaranteed publisher earnings
));
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check CHECK (type IN (
  'payment', 'campaign_reserve', 'campaign_release', 'ad_charge', 'charge_reversal', 'earnings_finalize',
  'payout_approve', 'payout_paid', 'payout_failed', 'refund', 'adjustment', 'guarantee_topup'));

-- One row per publisher organization and UTC day, written once by the worker.
CREATE TABLE publisher_guarantees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  day               date NOT NULL,
  currency          text NOT NULL,
  min_cpm_micros    bigint,
  min_cpc_micros    bigint,
  impressions       bigint NOT NULL,
  clicks            bigint NOT NULL,
  earned_micros     bigint NOT NULL CHECK (earned_micros >= 0),
  required_micros   bigint NOT NULL CHECK (required_micros >= 0),
  shortfall_micros  bigint NOT NULL CHECK (shortfall_micros >= 0),
  topup_micros      bigint NOT NULL CHECK (topup_micros >= 0 AND topup_micros <= shortfall_micros),
  capped            boolean NOT NULL DEFAULT false,
  ledger_txn_id     uuid REFERENCES ledger_transactions(id),
  hold_until        timestamptz NOT NULL,
  finalized_at      timestamptz,
  finalize_txn_id   uuid REFERENCES ledger_transactions(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, day),
  CHECK (topup_micros = 0 OR ledger_txn_id IS NOT NULL)
);
CREATE INDEX publisher_guarantees_hold_idx ON publisher_guarantees (hold_until) WHERE finalized_at IS NULL AND topup_micros > 0;

-- ------------------------------------------------------------ native ads
ALTER TABLE creatives DROP CONSTRAINT creatives_format_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_format_check CHECK (format IN ('image', 'text', 'native'));
ALTER TABLE creatives ADD COLUMN sponsor_name text CHECK (sponsor_name IS NULL OR char_length(sponsor_name) BETWEEN 1 AND 60);
-- Native ads must name who paid for them and carry an image and a headline.
ALTER TABLE creatives ADD CONSTRAINT creatives_native_check CHECK (format <> 'native' OR (asset_id IS NOT NULL AND headline IS NOT NULL AND sponsor_name IS NOT NULL));

ALTER TABLE sites ALTER COLUMN allowed_formats SET DEFAULT '{image,text,native}';
UPDATE sites SET allowed_formats = array_append(allowed_formats, 'native') WHERE NOT ('native' = ANY (allowed_formats));
