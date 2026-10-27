-- BlissNova Ad Network core schema: identity, organizations, RBAC, audit.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  platform_role    text CHECK (platform_role IN ('super_admin', 'admin', 'finance', 'ad_ops', 'support')),
  email_verified_at timestamptz,
  mfa_secret_enc   text,
  mfa_enabled      boolean NOT NULL DEFAULT false,
  suspended_reason text,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_platform_role_idx ON users (platform_role) WHERE platform_role IS NOT NULL;

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  ip_hash       text,
  user_agent    text,
  mfa_verified  boolean NOT NULL DEFAULT false,
  step_up_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  email_hash  text,
  type        text NOT NULL CHECK (type IN ('login_success', 'login_failure', 'logout', 'mfa_success', 'mfa_failure', 'password_reset', 'password_changed', 'session_revoked', 'step_up', 'step_up_failure', 'locked_out')),
  ip_hash     text,
  user_agent  text,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user_idx ON auth_events (user_id, created_at DESC);
CREATE INDEX auth_events_type_idx ON auth_events (type, created_at DESC);

CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  type            text NOT NULL CHECK (type IN ('advertiser', 'publisher')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  website         text,
  country         text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  billing_email   citext,
  currency        text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status_reason   text,
  revenue_share_bps integer CHECK (revenue_share_bps BETWEEN 0 AND 10000),
  restrictions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_type_status_idx ON organizations (type, status);

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'analyst')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'analyst')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_idx ON invitations (org_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL UNIQUE,
  key_hash     text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id),
  rotated_from uuid REFERENCES api_keys(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);

-- Immutable audit trail of sensitive and administrative actions.
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'api_key', 'provider')),
  org_id        uuid REFERENCES organizations(id),
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  before        jsonb,
  after         jsonb,
  reason        text,
  ip_hash       text,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_org_idx ON audit_logs (org_id, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE security_events (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  subject     text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash     text,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_created_idx ON security_events (created_at DESC);

CREATE TABLE admin_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'organization', 'site', 'campaign', 'creative', 'fraud_case', 'payout', 'payment', 'dispute', 'abuse_report')),
  subject_id   uuid NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id),
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_notes_subject_idx ON admin_notes (subject_type, subject_id, created_at DESC);

CREATE TABLE abuse_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_email citext,
  subject_type  text NOT NULL CHECK (subject_type IN ('user', 'organization', 'site', 'creative', 'campaign', 'other')),
  subject_ref   text,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolution    text,
  resolved_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('faq', 'advertiser_policy', 'publisher_policy', 'creative_rules', 'announcement', 'maintenance_notice', 'support_contact', 'doc_link', 'legal')),
  slug        text NOT NULL,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body        text NOT NULL DEFAULT '',
  url         text,
  sort_order  integer NOT NULL DEFAULT 0,
  published   boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, slug)
);

CREATE TABLE pricing_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience    text NOT NULL CHECK (audience IN ('advertiser', 'publisher')),
  name        text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  price_label text NOT NULL DEFAULT '',
  features    text[] NOT NULL DEFAULT '{}',
  cta_label   text NOT NULL DEFAULT 'Get started',
  highlighted boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  published   boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE email_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address  citext NOT NULL,
  template    text NOT NULL,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'not_configured')),
  provider    text,
  provider_message_id text,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX email_outbox_status_idx ON email_outbox (status, created_at);
