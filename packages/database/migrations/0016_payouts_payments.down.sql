ALTER TABLE payments DROP COLUMN provider_charge_ref;
DROP INDEX payouts_processing_idx;
ALTER TABLE payouts DROP COLUMN method, DROP COLUMN destination_encrypted, DROP COLUMN auto_requested, DROP COLUMN sent_at, DROP COLUMN paid_at;
ALTER TABLE payout_profiles DROP COLUMN details_encrypted, DROP COLUMN auto_payout, DROP COLUMN details_changed_at;
UPDATE payout_profiles SET method = 'other' WHERE method = 'crypto';
ALTER TABLE payout_profiles DROP CONSTRAINT payout_profiles_method_check;
ALTER TABLE payout_profiles ADD CONSTRAINT payout_profiles_method_check CHECK (method IN ('bank_transfer', 'paypal', 'other'));
