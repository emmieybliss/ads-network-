-- Event tracking. State model: served -> render -> (viewable) -> click.
-- Raw submissions are classified on ingestion into valid or invalid;
-- billable is a further subset of valid. Requests and rejections are counters.

CREATE TABLE ad_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-generated id; retries of the same submission are ignored.
  client_event_id    text UNIQUE,
  -- Set only on the first counted event of (delivery, type). Guarantees one valid render/viewable/click per delivery.
  event_key          text UNIQUE,
  delivery_id        uuid NOT NULL,
  type               text NOT NULL CHECK (type IN ('served', 'render', 'viewable', 'click')),
  status             text NOT NULL CHECK (status IN ('valid', 'invalid')),
  invalid_reason     text,
  ivt_score          smallint NOT NULL DEFAULT 0,
  billable           boolean NOT NULL DEFAULT false,
  cost_micros        bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  publisher_micros   bigint NOT NULL DEFAULT 0 CHECK (publisher_micros >= 0),
  currency           text NOT NULL DEFAULT 'USD',
  settlement_id      uuid,
  excluded_at        timestamptz,
  excluded_by        uuid REFERENCES users(id),
  exclusion_case_id  uuid,
  campaign_id        uuid NOT NULL REFERENCES campaigns(id),
  creative_id        uuid NOT NULL REFERENCES creatives(id),
  advertiser_org_id  uuid NOT NULL REFERENCES organizations(id),
  site_id            uuid NOT NULL REFERENCES sites(id),
  unit_id            uuid NOT NULL REFERENCES ad_units(id),
  publisher_org_id   uuid NOT NULL REFERENCES organizations(id),
  visitor_hash       text,
  ip_hash            text,
  ua_hash            text,
  country            text NOT NULL DEFAULT 'ZZ',
  device             text NOT NULL DEFAULT 'other',
  contextual         boolean NOT NULL DEFAULT true,
  page_host          text,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'valid' OR invalid_reason IS NOT NULL),
  CHECK (NOT billable OR status = 'valid')
);
CREATE INDEX ad_events_campaign_time_idx ON ad_events (campaign_id, occurred_at);
CREATE INDEX ad_events_site_time_idx ON ad_events (site_id, occurred_at);
CREATE INDEX ad_events_time_idx ON ad_events (occurred_at);
CREATE INDEX ad_events_delivery_idx ON ad_events (delivery_id);
CREATE INDEX ad_events_unsettled_idx ON ad_events (campaign_id) WHERE billable AND settlement_id IS NULL;

-- Daily spend per campaign, used for concurrency-safe daily budget enforcement.
CREATE TABLE campaign_daily_spend (
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  day          date NOT NULL,
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  impressions  bigint NOT NULL DEFAULT 0,
  clicks       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

-- Reporting aggregate, fully recomputed per day by the worker (idempotent).
CREATE TABLE daily_stats (
  day                 date NOT NULL,
  campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creative_id         uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  advertiser_org_id   uuid NOT NULL,
  site_id             uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  unit_id             uuid NOT NULL REFERENCES ad_units(id) ON DELETE CASCADE,
  publisher_org_id    uuid NOT NULL,
  country             text NOT NULL,
  device              text NOT NULL,
  served              bigint NOT NULL DEFAULT 0,
  rendered            bigint NOT NULL DEFAULT 0,
  valid_impressions   bigint NOT NULL DEFAULT 0,
  invalid_impressions bigint NOT NULL DEFAULT 0,
  viewable_impressions bigint NOT NULL DEFAULT 0,
  valid_clicks        bigint NOT NULL DEFAULT 0,
  invalid_clicks      bigint NOT NULL DEFAULT 0,
  billable_impressions bigint NOT NULL DEFAULT 0,
  billable_clicks     bigint NOT NULL DEFAULT 0,
  spend_micros        bigint NOT NULL DEFAULT 0,
  publisher_micros    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, campaign_id, creative_id, site_id, unit_id, country, device)
);
CREATE INDEX daily_stats_adv_idx ON daily_stats (advertiser_org_id, day);
CREATE INDEX daily_stats_pub_idx ON daily_stats (publisher_org_id, day);
CREATE INDEX daily_stats_site_idx ON daily_stats (site_id, day);

-- Ad request counters per placement and day (non-billable operational metric).
CREATE TABLE unit_request_stats (
  day            date NOT NULL,
  unit_id        uuid NOT NULL REFERENCES ad_units(id) ON DELETE CASCADE,
  requests       bigint NOT NULL DEFAULT 0,
  filled         bigint NOT NULL DEFAULT 0,
  no_fill        bigint NOT NULL DEFAULT 0,
  cap_rejects    bigint NOT NULL DEFAULT 0,
  budget_rejects bigint NOT NULL DEFAULT 0,
  blocked        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, unit_id)
);

CREATE TABLE fraud_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('site', 'campaign', 'organization', 'unit')),
  subject_id    uuid NOT NULL,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'confirmed', 'dismissed', 'appealed', 'appeal_upheld', 'appeal_rejected')),
  severity      text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  signals       jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_by     uuid REFERENCES users(id),
  assigned_to   uuid REFERENCES users(id),
  outcome       text,
  appeal_text   text,
  appealed_at   timestamptz,
  appealed_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fraud_cases_status_idx ON fraud_cases (status, created_at DESC);

CREATE TABLE event_exclusions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid REFERENCES fraud_cases(id),
  criteria        jsonb NOT NULL,
  excluded_events integer NOT NULL,
  reversed_micros bigint NOT NULL DEFAULT 0,
  reason          text NOT NULL,
  actor_id        uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE anomaly_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('ctr_spike', 'request_burst', 'click_burst', 'invalid_domain', 'invalid_rate', 'replay_burst')),
  subject_type text NOT NULL,
  subject_id   uuid,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  day          date NOT NULL DEFAULT CURRENT_DATE,
  case_id      uuid REFERENCES fraud_cases(id),
  acknowledged_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject_type, subject_id, day)
);
