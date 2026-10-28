-- Advanced analytics: audience dimensions, sessions, time in view,
-- conversions, hourly and invalid-traffic aggregates.
--
-- Every new event dimension is derived on the server at serve time: the
-- operating system and browser family from the user agent, and the traffic
-- source from the referring host the ad tag reports (host only, never a full
-- URL). They travel in the encrypted delivery token like country and device.
ALTER TABLE ad_events
  ADD COLUMN os text NOT NULL DEFAULT 'other',
  ADD COLUMN browser text NOT NULL DEFAULT 'other',
  ADD COLUMN source text NOT NULL DEFAULT 'unknown',
  -- Time the creative was at least 50% in view in a visible tab, reported once
  -- per delivery by the tag (an 'inview' event) when the visitor leaves.
  ADD COLUMN in_view_ms integer CHECK (in_view_ms IS NULL OR in_view_ms BETWEEN 0 AND 3600000);
ALTER TABLE ad_events DROP CONSTRAINT ad_events_type_check;
ALTER TABLE ad_events ADD CONSTRAINT ad_events_type_check CHECK (type IN ('served', 'render', 'viewable', 'click', 'inview'));

-- Advertiser conversion tracking. When enabled, the click redirect adds
-- bn_click_id to the landing page URL; a pixel or server postback reporting
-- that id records a conversion attributed to the click.
ALTER TABLE campaigns
  ADD COLUMN conversion_tracking boolean NOT NULL DEFAULT false,
  ADD COLUMN attribution_window_days integer NOT NULL DEFAULT 30 CHECK (attribution_window_days BETWEEN 1 AND 90);

CREATE TABLE conversions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id       uuid NOT NULL,
  event_name        text NOT NULL CHECK (event_name ~ '^[a-z0-9_]{1,40}$'),
  -- Empty when the advertiser sent no order id; one conversion per (click, event, order).
  order_ref         text NOT NULL DEFAULT '' CHECK (char_length(order_ref) <= 100),
  value_micros      bigint NOT NULL DEFAULT 0 CHECK (value_micros >= 0),
  currency          text NOT NULL DEFAULT 'USD',
  method            text NOT NULL CHECK (method IN ('pixel', 'postback')),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creative_id       uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  advertiser_org_id uuid NOT NULL REFERENCES organizations(id),
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  unit_id           uuid NOT NULL REFERENCES ad_units(id) ON DELETE CASCADE,
  publisher_org_id  uuid NOT NULL REFERENCES organizations(id),
  country           text NOT NULL DEFAULT 'ZZ',
  device            text NOT NULL DEFAULT 'other',
  os                text NOT NULL DEFAULT 'other',
  browser           text NOT NULL DEFAULT 'other',
  source            text NOT NULL DEFAULT 'unknown',
  page_path         text,
  click_at          timestamptz NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, event_name, order_ref)
);
CREATE INDEX conversions_campaign_time_idx ON conversions (campaign_id, occurred_at);
CREATE INDEX conversions_time_idx ON conversions (occurred_at);

-- daily_stats gains the new dimensions and metrics. Existing rows keep the
-- defaults until their day is next recomputed.
ALTER TABLE daily_stats
  ADD COLUMN os text NOT NULL DEFAULT 'other',
  ADD COLUMN browser text NOT NULL DEFAULT 'other',
  ADD COLUMN source text NOT NULL DEFAULT 'unknown',
  ADD COLUMN in_view_ms bigint NOT NULL DEFAULT 0,
  ADD COLUMN in_view_samples bigint NOT NULL DEFAULT 0,
  ADD COLUMN conversions bigint NOT NULL DEFAULT 0,
  ADD COLUMN conversion_value_micros bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_stats DROP CONSTRAINT daily_stats_pkey;
ALTER TABLE daily_stats ADD PRIMARY KEY (day, campaign_id, creative_id, site_id, unit_id, country, device, os, browser, source);

-- Hour-level aggregate (UTC) for hour-of-day charts and the weekday x hour heatmap.
CREATE TABLE hourly_stats (
  hour                timestamptz NOT NULL,
  campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  advertiser_org_id   uuid NOT NULL,
  site_id             uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  publisher_org_id    uuid NOT NULL,
  valid_impressions   bigint NOT NULL DEFAULT 0,
  viewable_impressions bigint NOT NULL DEFAULT 0,
  valid_clicks        bigint NOT NULL DEFAULT 0,
  spend_micros        bigint NOT NULL DEFAULT 0,
  publisher_micros    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, campaign_id, site_id)
);
CREATE INDEX hourly_stats_adv_idx ON hourly_stats (advertiser_org_id, hour);
CREATE INDEX hourly_stats_pub_idx ON hourly_stats (publisher_org_id, hour);

-- Rejected events by reason, so every party can see why traffic was not counted.
CREATE TABLE ivt_daily_stats (
  day               date NOT NULL,
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  advertiser_org_id uuid NOT NULL,
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  publisher_org_id  uuid NOT NULL,
  type              text NOT NULL,
  reason            text NOT NULL,
  events            bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, campaign_id, site_id, type, reason)
);
CREATE INDEX ivt_daily_stats_pub_idx ON ivt_daily_stats (publisher_org_id, day);
CREATE INDEX ivt_daily_stats_adv_idx ON ivt_daily_stats (advertiser_org_id, day);

-- Page views and sessions by traffic source, device and country. A session
-- starts with a page view whose referrer is not the site itself (an entrance),
-- so no identifier or device storage is needed to count sessions.
CREATE TABLE site_traffic_daily (
  day       date NOT NULL,
  site_id   uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source    text NOT NULL,
  device    text NOT NULL,
  country   text NOT NULL,
  pageviews bigint NOT NULL DEFAULT 0,
  sessions  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site_id, source, device, country)
);
