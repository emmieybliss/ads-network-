-- Country targeting: countries a campaign never runs in (also with "all countries").
ALTER TABLE campaign_targeting ADD COLUMN exclude_countries text[] NOT NULL DEFAULT '{}';

-- Live reports. inserted_at is when the row was written (occurred_at can be
-- earlier, for queued events); the live rollup adds rows by it every few
-- seconds, and report_rollup records how far that has got. Existing rows get
-- the migration time, which the first rollup treats as already built.
ALTER TABLE ad_events ADD COLUMN inserted_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversions ADD COLUMN inserted_at timestamptz NOT NULL DEFAULT now();
-- Rows are written in time order, so a BRIN index is tiny and enough.
CREATE INDEX ad_events_inserted_brin ON ad_events USING brin (inserted_at);
CREATE INDEX conversions_inserted_brin ON conversions USING brin (inserted_at);
CREATE TABLE report_rollup (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  built_through  timestamptz NOT NULL,
  -- Last time the aggregates changed; dashboards reload when it moves.
  changed_at     timestamptz NOT NULL DEFAULT now(),
  full_built_at  timestamptz,
  events_added   bigint NOT NULL DEFAULT 0
);

-- Two-step verification.
ALTER TABLE users
  -- The last 30-second step a code was accepted for, so a code works once.
  ADD COLUMN mfa_last_step bigint,
  ADD COLUMN mfa_enabled_at timestamptz;
UPDATE users SET mfa_enabled_at = updated_at WHERE mfa_enabled;

-- One-time backup codes, stored as hashes only.
CREATE TABLE mfa_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);
CREATE INDEX mfa_backup_codes_user_idx ON mfa_backup_codes (user_id) WHERE used_at IS NULL;

-- "Don't ask again on this device": a signed-in browser skips the code for 30 days.
CREATE TABLE mfa_trusted_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX mfa_trusted_devices_user_idx ON mfa_trusted_devices (user_id) WHERE revoked_at IS NULL;

ALTER TABLE auth_events DROP CONSTRAINT auth_events_type_check;
ALTER TABLE auth_events ADD CONSTRAINT auth_events_type_check CHECK (type IN ('login_success', 'login_failure', 'logout', 'mfa_success', 'mfa_failure', 'password_reset', 'password_changed', 'session_revoked', 'step_up', 'step_up_failure', 'locked_out',
  'mfa_enabled', 'mfa_disabled', 'mfa_backup_code_used', 'mfa_reset'));
