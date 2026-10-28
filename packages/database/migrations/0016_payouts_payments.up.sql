-- Publisher payout destinations (PayPal, bank transfer, crypto) and provider-driven
-- payouts and refunds. Full destination details are AES-256-GCM encrypted by the
-- API (ENCRYPTION_KEY); only masked labels are stored in clear text.

ALTER TABLE payout_profiles DROP CONSTRAINT payout_profiles_method_check;
ALTER TABLE payout_profiles ADD CONSTRAINT payout_profiles_method_check CHECK (method IN ('bank_transfer', 'paypal', 'crypto', 'other'));
ALTER TABLE payout_profiles
  ADD COLUMN details_encrypted text,
  ADD COLUMN auto_payout boolean NOT NULL DEFAULT false,
  ADD COLUMN details_changed_at timestamptz;

-- Each payout keeps the destination it was requested for, so a later change of
-- payout details cannot redirect money that is already on its way.
ALTER TABLE payouts
  ADD COLUMN method text CHECK (method IN ('bank_transfer', 'paypal', 'crypto', 'other')),
  ADD COLUMN destination_encrypted text,
  ADD COLUMN auto_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN paid_at timestamptz;
UPDATE payouts p SET method = pp.method FROM payout_profiles pp WHERE pp.org_id = p.org_id AND p.method IS NULL;
CREATE INDEX payouts_processing_idx ON payouts (provider, updated_at) WHERE status = 'processing';

-- The provider's charge id (Stripe PaymentIntent, PayPal capture), needed to refund through the provider.
ALTER TABLE payments ADD COLUMN provider_charge_ref text;
