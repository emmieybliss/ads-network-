-- Partner networks: BlissNova acts as an agency on outside native networks
-- (MGID, Revcontent, Taboola, Outbrain/Teads). An advertiser lets part of a
-- CPC campaign's budget run there; BlissNova pays the partner and charges the
-- advertiser the partner's cost plus a markup.
--
-- Credentials never live in these tables: each adapter reads its own
-- environment variables. The 'simulated' network only works when the
-- development simulator is enabled, which production startup refuses.
CREATE TABLE partner_networks (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name            text NOT NULL,
  website         text,
  dev_only        boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT false,
  -- Added on top of the partner's cost: 2500 = the advertiser pays cost x 1.25.
  markup_bps      integer NOT NULL DEFAULT 2500 CHECK (markup_bps BETWEEN 0 AND 20000),
  min_cpc_micros  bigint NOT NULL DEFAULT 10000 CHECK (min_cpc_micros > 0),
  notes           text NOT NULL DEFAULT '',
  last_check_ok   boolean,
  last_check_detail text,
  last_checked_at timestamptz,
  -- No foreign key: the audit log records who changed what, and these rows must outlive any one user.
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO partner_networks (id, name, website, dev_only, notes) VALUES
  ('mgid', 'MGID', 'https://www.mgid.com', false, 'Agency (Super Client) account; API token from the MGID dashboard.'),
  ('revcontent', 'Revcontent', 'https://www.revcontent.com', false, 'Boosts API; credentials come with the advertiser account.'),
  ('taboola', 'Taboola', 'https://www.taboola.com', false, 'Backstage API; apply for API access and a network account.'),
  ('outbrain', 'Outbrain (Teads)', 'https://www.teads.com', false, 'Amplify API; apply for partner API access.'),
  ('simulated', 'Simulated partner', NULL, true, 'Development only. Pretends to be a partner network so the whole flow can be tried locally.');

-- One row per campaign and partner it is allowed to run on.
CREATE TABLE partner_campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  network_id         text NOT NULL REFERENCES partner_networks(id),
  -- Most of the campaign's lifetime (and daily) budget this partner may spend: 4000 = 40%.
  budget_share_bps   integer NOT NULL CHECK (budget_share_bps BETWEEN 100 AND 10000),
  -- Markup fixed when the advertiser opted in, so later changes do not reprice running campaigns.
  markup_bps         integer NOT NULL CHECK (markup_bps BETWEEN 0 AND 20000),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'active', 'paused', 'rejected', 'error', 'stopped')),
  status_reason      text,
  external_id        text,
  -- Set by BlissNova staff to stop delivery on this partner regardless of the advertiser's choice.
  admin_hold         boolean NOT NULL DEFAULT false,
  admin_hold_reason  text,
  -- The advertiser took this partner off the campaign; the next sync stops it there. Its history is kept.
  removed_at         timestamptz,
  -- What the partner reports it spent, and what BlissNova charged the advertiser for it.
  cost_micros        bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  charged_micros     bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  -- Partner cost BlissNova could not pass on because the campaign budget ran out first.
  absorbed_micros    bigint NOT NULL DEFAULT 0 CHECK (absorbed_micros >= 0),
  impressions        bigint NOT NULL DEFAULT 0,
  clicks             bigint NOT NULL DEFAULT 0,
  pushed_cpc_micros  bigint,
  pushed_total_micros bigint,
  pushed_daily_micros bigint,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, network_id)
);
CREATE INDEX partner_campaigns_network_idx ON partner_campaigns (network_id, status);

-- Each BlissNova-approved creative as the partner sees it. Partners review ads again.
CREATE TABLE partner_creatives (
  partner_campaign_id uuid NOT NULL REFERENCES partner_campaigns(id) ON DELETE CASCADE,
  creative_id         uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  creative_version    integer NOT NULL,
  external_id         text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'removed')),
  rejection_reason    text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_campaign_id, creative_id)
);

-- Partner-reported delivery per UTC day, and what was charged for it.
CREATE TABLE partner_daily_stats (
  partner_campaign_id uuid NOT NULL REFERENCES partner_campaigns(id) ON DELETE CASCADE,
  day                 date NOT NULL,
  impressions         bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks              bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  conversions         bigint NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  cost_micros         bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  charged_micros      bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_campaign_id, day)
);

-- Ledger: what BlissNova owes partners, and the charge that moves an advertiser's reserve there.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN (
  'cash_clearing', 'advertiser_wallet', 'campaign_reserve', 'publisher_pending', 'publisher_available',
  'publisher_payout_processing', 'platform_revenue', 'platform_fees', 'adjustments',
  'guarantee_expense',
  'partner_payable'     -- liability: partner-network spend BlissNova owes the partner
));
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check CHECK (type IN (
  'payment', 'campaign_reserve', 'campaign_release', 'ad_charge', 'charge_reversal', 'earnings_finalize',
  'payout_approve', 'payout_paid', 'payout_failed', 'refund', 'adjustment', 'guarantee_topup', 'partner_charge'));
