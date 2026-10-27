-- Publisher site lifecycle, expiring verification challenges with an
-- append-only attempt history, site review records, and support cases.

-- ------------------------------------------------------------ site statuses
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_status_check;
UPDATE sites SET status = CASE
  WHEN status = 'pending_verification' THEN 'verification_pending'
  WHEN status = 'pending_review' AND verified_at IS NOT NULL THEN 'submitted'
  WHEN status = 'pending_review' THEN 'verification_pending'
  ELSE status END;
ALTER TABLE sites ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE sites ADD CONSTRAINT sites_status_check CHECK (status IN (
  'draft', 'verification_pending', 'verified', 'submitted', 'under_review', 'approved', 'rejected', 'suspended'));

ALTER TABLE sites
  ADD COLUMN description           text CHECK (description IS NULL OR char_length(description) <= 2000),
  ADD COLUMN language              text CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  ADD COLUMN country               char(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  -- Self-reported by the publisher at submission; never shown as a measured figure.
  ADD COLUMN reported_monthly_pageviews integer CHECK (reported_monthly_pageviews IS NULL OR reported_monthly_pageviews >= 0),
  ADD COLUMN traffic_sources       text CHECK (traffic_sources IS NULL OR char_length(traffic_sources) <= 1000),
  ADD COLUMN policy_version        text,
  ADD COLUMN policy_accepted_at    timestamptz,
  ADD COLUMN policy_accepted_by    uuid REFERENCES users(id),
  ADD COLUMN submitted_at          timestamptz,
  ADD COLUMN review_started_at     timestamptz,
  ADD COLUMN reviewed_by           uuid REFERENCES users(id),
  ADD COLUMN verification_method   text CHECK (verification_method IS NULL OR verification_method IN ('dns_txt', 'html_file', 'meta_tag', 'manual', 'simulated')),
  -- 'zone': proof covers the hostname and its subdomains (DNS); 'host': that hostname (and www.) only.
  ADD COLUMN verification_scope    text CHECK (verification_scope IS NULL OR verification_scope IN ('host', 'zone')),
  -- True when the local-development simulator verified the site. Such a site never serves in production.
  ADD COLUMN verification_simulated boolean NOT NULL DEFAULT false;

UPDATE sites SET verification_method = 'manual', verification_scope = 'host' WHERE verified_at IS NOT NULL AND verification_method IS NULL;

-- ------------------------------------------------------------ challenges
ALTER TABLE site_verifications DROP CONSTRAINT IF EXISTS site_verifications_status_check;
ALTER TABLE site_verifications ADD CONSTRAINT site_verifications_status_check CHECK (status IN ('pending', 'verified', 'failed', 'superseded', 'expired', 'revoked'));
ALTER TABLE site_verifications
  ADD COLUMN hostname     text,
  ADD COLUMN record_name  text,
  ADD COLUMN expires_at   timestamptz,
  ADD COLUMN consumed_at  timestamptz,
  ADD COLUMN created_by   uuid REFERENCES users(id),
  ADD COLUMN simulated    boolean NOT NULL DEFAULT false;
UPDATE site_verifications v SET hostname = s.domain, expires_at = v.created_at + interval '7 days' FROM sites s WHERE s.id = v.site_id;
ALTER TABLE site_verifications ALTER COLUMN hostname SET NOT NULL, ALTER COLUMN expires_at SET NOT NULL;
-- A token is never issued twice, so one cannot be replayed against another challenge.
CREATE UNIQUE INDEX site_verifications_token_uniq ON site_verifications (token);
-- At most one open challenge per site.
CREATE UNIQUE INDEX site_verifications_open_uniq ON site_verifications (site_id) WHERE status IN ('pending', 'failed');

CREATE TABLE site_verification_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id  uuid REFERENCES site_verifications(id) ON DELETE SET NULL,
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hostname      text NOT NULL,
  method        text NOT NULL CHECK (method IN ('dns_txt', 'html_file', 'meta_tag', 'manual', 'simulated', 'revoke')),
  outcome       text NOT NULL CHECK (outcome IN ('success', 'not_found', 'mismatch', 'expired', 'error', 'blocked', 'revoked')),
  detail        text,
  -- What was observed (status code, record count, addresses refused). Never the full page.
  evidence      jsonb NOT NULL DEFAULT '{}',
  simulated     boolean NOT NULL DEFAULT false,
  actor_user_id uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_verification_attempts_site_idx ON site_verification_attempts (site_id, created_at DESC);
CREATE INDEX site_verification_attempts_host_idx ON site_verification_attempts (hostname, created_at DESC);

CREATE FUNCTION site_verification_attempts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'verification attempts are append-only';
END $$;
CREATE TRIGGER site_verification_attempts_no_update BEFORE UPDATE ON site_verification_attempts
  FOR EACH ROW EXECUTE FUNCTION site_verification_attempts_immutable();

-- ------------------------------------------------------------ reviews
CREATE TABLE site_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(id),
  action      text NOT NULL,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  -- Eligibility checklist as the reviewer recorded it: { ruleKey: true|false }.
  checklist   jsonb NOT NULL DEFAULT '{}',
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_reviews_site_idx ON site_reviews (site_id, created_at DESC);

-- ------------------------------------------------------------ support
CREATE TABLE support_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  opened_by   uuid NOT NULL REFERENCES users(id),
  subject     text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 200),
  category    text NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'billing', 'payouts', 'verification', 'policy', 'technical', 'account')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on_customer', 'waiting_on_staff', 'resolved', 'closed')),
  priority    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_cases_org_idx ON support_cases (org_id, created_at DESC);
CREATE INDEX support_cases_status_idx ON support_cases (status, updated_at DESC);

CREATE TABLE support_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  from_staff boolean NOT NULL DEFAULT false,
  -- Staff-only notes are never returned to the customer.
  internal   boolean NOT NULL DEFAULT false,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_case_idx ON support_messages (case_id, created_at);
