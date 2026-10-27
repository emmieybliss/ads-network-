-- Publisher inventory, campaigns, targeting, creatives.

CREATE TABLE sites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  domain           text NOT NULL CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' OR domain = 'localhost'),
  -- Additional hostnames (subdomains, staging) allowed to request ads for this site.
  allowed_domains  text[] NOT NULL DEFAULT '{}',
  category         text NOT NULL DEFAULT 'general',
  status           text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'pending_review', 'approved', 'rejected', 'suspended')),
  status_reason    text,
  public_key       text NOT NULL UNIQUE,
  verified_at      timestamptz,
  approved_at      timestamptz,
  allowed_formats  text[] NOT NULL DEFAULT '{image,text}',
  revenue_share_bps integer CHECK (revenue_share_bps BETWEEN 0 AND 10000),
  blocked_categories text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- One active registration per domain across the network.
CREATE UNIQUE INDEX sites_domain_uniq ON sites (domain) WHERE status <> 'rejected';
CREATE INDEX sites_org_idx ON sites (org_id);

CREATE TABLE site_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  method        text NOT NULL CHECK (method IN ('dns_txt', 'html_file', 'meta_tag')),
  token         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'superseded')),
  attempts      integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  last_error    text,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_verifications_site_idx ON site_verifications (site_id, created_at DESC);

CREATE TABLE ad_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  key         text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  formats     text[] NOT NULL DEFAULT '{image,text}',
  width       integer CHECK (width BETWEEN 1 AND 2000),
  height      integer CHECK (height BETWEEN 1 AND 2000),
  responsive  boolean NOT NULL DEFAULT true,
  position    text NOT NULL DEFAULT 'in_content' CHECK (position IN ('header', 'sidebar', 'in_content', 'footer', 'other')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  admin_blocked boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, key)
);

CREATE TABLE campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  public_ref             text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex'),
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'active', 'paused', 'completed', 'rejected', 'suspended', 'archived')),
  status_reason          text,
  pricing_model          text NOT NULL CHECK (pricing_model IN ('cpm', 'cpc', 'flat')),
  -- CPM: price per 1000 impressions; CPC: price per click; flat: total sponsorship price.
  rate_micros            bigint NOT NULL CHECK (rate_micros > 0),
  currency               text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  lifetime_budget_micros bigint NOT NULL CHECK (lifetime_budget_micros > 0),
  daily_budget_micros    bigint CHECK (daily_budget_micros IS NULL OR daily_budget_micros > 0),
  spent_micros           bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  reserved_micros        bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  max_impressions        bigint CHECK (max_impressions IS NULL OR max_impressions > 0),
  max_clicks             bigint CHECK (max_clicks IS NULL OR max_clicks > 0),
  billable_impressions   bigint NOT NULL DEFAULT 0,
  billable_clicks        bigint NOT NULL DEFAULT 0,
  timezone               text NOT NULL DEFAULT 'UTC',
  start_at               timestamptz NOT NULL,
  end_at                 timestamptz,
  pacing                 text NOT NULL DEFAULT 'even' CHECK (pacing IN ('even', 'asap')),
  priority               integer NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  admin_priority_boost   integer NOT NULL DEFAULT 0 CHECK (admin_priority_boost BETWEEN -5 AND 5),
  version                integer NOT NULL DEFAULT 1,
  submitted_at           timestamptz,
  approved_at            timestamptz,
  approved_by            uuid REFERENCES users(id),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (spent_micros <= lifetime_budget_micros),
  CHECK (end_at IS NULL OR end_at > start_at),
  CHECK (daily_budget_micros IS NULL OR daily_budget_micros <= lifetime_budget_micros)
);
CREATE INDEX campaigns_org_idx ON campaigns (org_id, status);
CREATE INDEX campaigns_status_idx ON campaigns (status) WHERE status IN ('active', 'scheduled');

CREATE TABLE campaign_targeting (
  campaign_id       uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  countries         text[] NOT NULL DEFAULT '{}',
  devices           text[] NOT NULL DEFAULT '{}',
  site_categories   text[] NOT NULL DEFAULT '{}',
  keywords          text[] NOT NULL DEFAULT '{}',
  include_site_ids  uuid[] NOT NULL DEFAULT '{}',
  exclude_site_ids  uuid[] NOT NULL DEFAULT '{}',
  include_unit_ids  uuid[] NOT NULL DEFAULT '{}',
  exclude_unit_ids  uuid[] NOT NULL DEFAULT '{}',
  require_personalized boolean NOT NULL DEFAULT false
);

CREATE TABLE campaign_caps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scope          text NOT NULL CHECK (scope IN ('visitor', 'page')),
  max_impressions integer NOT NULL CHECK (max_impressions BETWEEN 1 AND 10000),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 2592000),
  UNIQUE (campaign_id, scope, window_seconds)
);

CREATE TABLE advertiser_caps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  max_impressions integer NOT NULL CHECK (max_impressions BETWEEN 1 AND 10000),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 2592000),
  UNIQUE (org_id, window_seconds)
);

CREATE TABLE campaign_history (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  before      jsonb,
  after       jsonb,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_history_idx ON campaign_history (campaign_id, created_at DESC);
CREATE TRIGGER campaign_history_immutable BEFORE UPDATE OR DELETE ON campaign_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  sha256      text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  integer NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  storage_key text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_org_idx ON assets (org_id);

CREATE TABLE creatives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  public_ref      text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  format          text NOT NULL CHECK (format IN ('image', 'text')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'archived')),
  version         integer NOT NULL DEFAULT 1,
  approved_version integer,
  headline        text CHECK (headline IS NULL OR char_length(headline) <= 90),
  body            text CHECK (body IS NULL OR char_length(body) <= 200),
  cta             text CHECK (cta IS NULL OR char_length(cta) <= 30),
  asset_id        uuid REFERENCES assets(id),
  width           integer,
  height          integer,
  destination_url text NOT NULL CHECK (char_length(destination_url) <= 2048),
  display_url     text,
  alt_text        text CHECK (alt_text IS NULL OR char_length(alt_text) <= 200),
  rejection_reason text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (format <> 'image' OR asset_id IS NOT NULL),
  CHECK (format <> 'text' OR headline IS NOT NULL)
);
CREATE INDEX creatives_campaign_idx ON creatives (campaign_id, status);

-- Snapshot of every submitted creative version; served content always comes from the approved snapshot.
CREATE TABLE creative_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id  uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creative_id, version)
);

CREATE TABLE creative_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id  uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason       text,
  reviewer_id  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creative_reviews_idx ON creative_reviews (creative_id, created_at DESC);

-- Network-wide inventory rules managed by ad operations (blocked keywords, destination domains, etc.).
CREATE TABLE inventory_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('blocked_destination_domain', 'blocked_keyword', 'blocked_site_category', 'blocked_country')),
  value       text NOT NULL,
  reason      text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
