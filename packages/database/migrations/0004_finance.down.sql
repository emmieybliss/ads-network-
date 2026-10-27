DROP TABLE IF EXISTS disputes, payouts, payout_profiles CASCADE;
ALTER TABLE IF EXISTS ad_events DROP CONSTRAINT IF EXISTS ad_events_settlement_fk;
DROP TABLE IF EXISTS settlements, invoices, refunds, payment_webhook_events, payments, ledger_entries, ledger_transactions, ledger_accounts CASCADE;
DROP SEQUENCE IF EXISTS invoice_number_seq;
DROP FUNCTION IF EXISTS ledger_check_balanced();
