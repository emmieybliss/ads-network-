DROP TABLE IF EXISTS support_messages, support_cases, site_reviews, site_verification_attempts;
DROP FUNCTION IF EXISTS site_verification_attempts_immutable();
DROP INDEX IF EXISTS site_verifications_open_uniq;
DROP INDEX IF EXISTS site_verifications_token_uniq;
ALTER TABLE site_verifications DROP COLUMN IF EXISTS simulated, DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS consumed_at,
  DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS record_name, DROP COLUMN IF EXISTS hostname;
ALTER TABLE site_verifications DROP CONSTRAINT IF EXISTS site_verifications_status_check;
UPDATE site_verifications SET status = 'superseded' WHERE status IN ('expired', 'revoked');
ALTER TABLE site_verifications ADD CONSTRAINT site_verifications_status_check CHECK (status IN ('pending', 'verified', 'failed', 'superseded'));

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_status_check;
UPDATE sites SET status = CASE
  WHEN status IN ('draft', 'verification_pending') THEN 'pending_verification'
  WHEN status IN ('verified', 'submitted', 'under_review') THEN 'pending_review'
  ELSE status END;
ALTER TABLE sites ALTER COLUMN status SET DEFAULT 'pending_verification';
ALTER TABLE sites ADD CONSTRAINT sites_status_check CHECK (status IN ('pending_verification', 'pending_review', 'approved', 'rejected', 'suspended'));
ALTER TABLE sites DROP COLUMN IF EXISTS verification_simulated, DROP COLUMN IF EXISTS verification_scope, DROP COLUMN IF EXISTS verification_method,
  DROP COLUMN IF EXISTS reviewed_by, DROP COLUMN IF EXISTS review_started_at, DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS policy_accepted_by, DROP COLUMN IF EXISTS policy_accepted_at, DROP COLUMN IF EXISTS policy_version,
  DROP COLUMN IF EXISTS traffic_sources, DROP COLUMN IF EXISTS reported_monthly_pageviews, DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS language, DROP COLUMN IF EXISTS description;
