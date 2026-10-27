-- Double-entry ledger and financial records. All amounts are bigint micros.
-- Sign convention: positive = debit, negative = credit. Every transaction sums to zero.

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN (
                'cash_clearing',            -- asset: funds held with payment providers / bank
                'advertiser_wallet',        -- liability: confirmed advertiser funds not yet reserved
                'campaign_reserve',         -- liability: advertiser funds reserved for a campaign budget
                'publisher_pending',        -- liability: estimated publisher earnings inside hold period
                'publisher_available',      -- liability: finalized publisher earnings available for payout
                'publisher_payout_processing', -- liability: approved payouts being sent
                'platform_revenue',         -- revenue: network share of advertising charges
                'platform_fees',            -- revenue: advertiser fees on funding
                'adjustments'               -- equity: manual corrections approved by finance
              )),
  org_id      uuid REFERENCES organizations(id),
  campaign_id uuid REFERENCES campaigns(id),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (kind, org_id, campaign_id, currency)
);

CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type IN ('payment', 'campaign_reserve', 'campaign_release', 'ad_charge', 'charge_reversal', 'earnings_finalize', 'payout_approve', 'payout_paid', 'payout_failed', 'refund', 'adjustment')),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL UNIQUE,
  reference_type  text NOT NULL,
  reference_id    text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'system', 'provider')),
  actor_user_id   uuid REFERENCES users(id),
  provider        text,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_type <> 'user' OR actor_user_id IS NOT NULL)
);
CREATE INDEX ledger_transactions_ref_idx ON ledger_transactions (reference_type, reference_id);
CREATE INDEX ledger_transactions_created_idx ON ledger_transactions (created_at DESC);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id     uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_micros  bigint NOT NULL CHECK (amount_micros <> 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries (transaction_id);

CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Enforce balanced, single-currency transactions at commit time.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; bad_currency integer; entry_count integer;
BEGIN
  SELECT COALESCE(SUM(e.amount_micros), 0), COUNT(*) INTO total, entry_count FROM ledger_entries e WHERE e.transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced (sum=%)', NEW.transaction_id, total USING ERRCODE = 'check_violation';
  END IF;
  IF entry_count < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % needs at least two entries', NEW.transaction_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT COUNT(*) INTO bad_currency FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE e.transaction_id = NEW.transaction_id AND a.currency <> t.currency;
  IF bad_currency > 0 THEN
    RAISE EXCEPTION 'Ledger transaction % mixes currencies', NEW.transaction_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  provider        text NOT NULL,
  provider_ref    text,
  idempotency_key text NOT NULL UNIQUE,
  amount_micros   bigint NOT NULL CHECK (amount_micros > 0),
  fee_micros      bigint NOT NULL DEFAULT 0 CHECK (fee_micros >= 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  refunded_micros bigint NOT NULL DEFAULT 0 CHECK (refunded_micros >= 0),
  checkout_url    text,
  failure_reason  text,
  ledger_txn_id   uuid REFERENCES ledger_transactions(id),
  created_by      uuid REFERENCES users(id),
  confirmed_by    uuid REFERENCES users(id),
  confirmation_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref),
  CHECK (refunded_micros <= amount_micros)
);
CREATE INDEX payments_org_idx ON payments (org_id, created_at DESC);

CREATE TABLE payment_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  type              text NOT NULL,
  signature_valid   boolean NOT NULL,
  payload           jsonb NOT NULL,
  processed_at      timestamptz,
  processing_error  text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments(id),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  amount_micros  bigint NOT NULL CHECK (amount_micros > 0),
  currency       text NOT NULL,
  status         text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  reason         text NOT NULL,
  provider_ref   text,
  ledger_txn_id  uuid REFERENCES ledger_transactions(id),
  actor_id       uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE invoice_number_seq START 1000;
CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  kind          text NOT NULL CHECK (kind IN ('receipt', 'statement', 'credit_note')),
  status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  currency      text NOT NULL,
  total_micros  bigint NOT NULL,
  lines         jsonb NOT NULL DEFAULT '[]'::jsonb,
  period_start  date,
  period_end    date,
  payment_id    uuid REFERENCES payments(id),
  refund_id     uuid REFERENCES refunds(id),
  void_reason   text,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, period_start, period_end)
);
CREATE INDEX invoices_org_idx ON invoices (org_id, issued_at DESC);

CREATE TABLE settlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id),
  advertiser_org_id uuid NOT NULL REFERENCES organizations(id),
  publisher_org_id  uuid NOT NULL REFERENCES organizations(id),
  currency          text NOT NULL,
  event_count       integer NOT NULL,
  charge_micros     bigint NOT NULL CHECK (charge_micros >= 0),
  publisher_micros  bigint NOT NULL CHECK (publisher_micros >= 0),
  reversed_micros   bigint NOT NULL DEFAULT 0,
  reversed_publisher_micros bigint NOT NULL DEFAULT 0,
  ledger_txn_id     uuid NOT NULL REFERENCES ledger_transactions(id),
  hold_until        timestamptz NOT NULL,
  finalized_at      timestamptz,
  finalize_txn_id   uuid REFERENCES ledger_transactions(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlements_hold_idx ON settlements (hold_until) WHERE finalized_at IS NULL;
CREATE INDEX settlements_pub_idx ON settlements (publisher_org_id, created_at DESC);
ALTER TABLE ad_events ADD CONSTRAINT ad_events_settlement_fk FOREIGN KEY (settlement_id) REFERENCES settlements(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE payout_profiles (
  org_id         uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  method         text NOT NULL CHECK (method IN ('bank_transfer', 'paypal', 'other')),
  -- Only a masked, human-readable label is stored; full banking details stay with the payout provider.
  display_label  text NOT NULL CHECK (char_length(display_label) <= 120),
  currency       text NOT NULL,
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  amount_micros   bigint NOT NULL CHECK (amount_micros > 0),
  currency        text NOT NULL,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'processing', 'paid', 'rejected', 'failed', 'cancelled')),
  method_label    text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  requested_by    uuid NOT NULL REFERENCES users(id),
  reviewed_by     uuid REFERENCES users(id),
  review_reason   text,
  provider        text,
  provider_ref    text,
  failure_reason  text,
  approve_txn_id  uuid REFERENCES ledger_transactions(id),
  final_txn_id    uuid REFERENCES ledger_transactions(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_org_idx ON payouts (org_id, created_at DESC);
CREATE INDEX payouts_status_idx ON payouts (status);
-- At most one open payout request per publisher.
CREATE UNIQUE INDEX payouts_one_open_idx ON payouts (org_id) WHERE status IN ('requested', 'approved', 'processing');

CREATE TABLE disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL CHECK (subject_type IN ('campaign', 'payment', 'invoice', 'payout', 'other')),
  subject_id   uuid,
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'rejected')),
  resolution   text,
  opened_by    uuid NOT NULL REFERENCES users(id),
  resolved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
