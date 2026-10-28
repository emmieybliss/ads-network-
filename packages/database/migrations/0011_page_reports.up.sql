-- Per-page reporting and page RPM. The page path (no host, query or fragment)
-- travels in the signed delivery token, so each event knows its page. Page
-- views are pages where the ad tag requested at least one ad, counted once
-- per page view at the first request.
ALTER TABLE ad_events ADD COLUMN page_path text CHECK (page_path IS NULL OR char_length(page_path) <= 300);

CREATE TABLE page_views (
  day        date NOT NULL,
  site_id    uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_path  text NOT NULL CHECK (char_length(page_path) BETWEEN 1 AND 300),
  views      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site_id, page_path)
);

-- Recomputed per day from ad_events by the aggregation job, like daily_stats.
CREATE TABLE page_daily_stats (
  day               date NOT NULL,
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  publisher_org_id  uuid NOT NULL,
  page_path         text NOT NULL,
  valid_impressions bigint NOT NULL DEFAULT 0,
  valid_clicks      bigint NOT NULL DEFAULT 0,
  publisher_micros  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site_id, page_path)
);
CREATE INDEX page_daily_stats_pub_idx ON page_daily_stats (publisher_org_id, day);
