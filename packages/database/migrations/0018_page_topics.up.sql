-- Automatic page topics and brand safety.
--
-- The ad tag sends a short text sample of each page (title, description,
-- headings, keywords and the start of the main text) with the page's first
-- ad request. The API classifies it locally into IAB-style topics and a
-- brand-safety risk, and keeps only the result here: the page text itself is
-- never stored. A page is classified again when its text changes.
CREATE TABLE page_contexts (
  site_id            uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_path          text NOT NULL CHECK (char_length(page_path) BETWEEN 1 AND 300),
  title              text CHECK (title IS NULL OR char_length(title) <= 300),
  language           text CHECK (language IS NULL OR char_length(language) <= 20),
  -- Detected: [{"id": "travel", "score": 21.5, "confidence": 0.8}], strongest first.
  topics             jsonb NOT NULL DEFAULT '[]',
  primary_topic      text,
  brand_safety       text NOT NULL DEFAULT 'safe' CHECK (brand_safety IN ('safe', 'low', 'medium', 'high')),
  -- [{"category": "violence", "risk": "medium", "score": 4, "terms": ["..."]}]
  safety_flags       jsonb NOT NULL DEFAULT '[]',
  terms              text[] NOT NULL DEFAULT '{}',
  content_hash       text NOT NULL,
  classifier_version integer NOT NULL,
  enough_text        boolean NOT NULL DEFAULT true,
  -- A reviewer's correction wins over detection until it is cleared.
  override_topics    text[],
  override_safety    text CHECK (override_safety IS NULL OR override_safety IN ('safe', 'low', 'medium', 'high')),
  override_note      text CHECK (override_note IS NULL OR char_length(override_note) <= 500),
  override_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  override_at        timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  classified_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, page_path)
);
CREATE INDEX page_contexts_safety_idx ON page_contexts (brand_safety, classified_at DESC);
CREATE INDEX page_contexts_topic_idx ON page_contexts (primary_topic);

-- Campaign targeting by page topic and brand-safety level.
ALTER TABLE campaign_targeting
  ADD COLUMN topics text[] NOT NULL DEFAULT '{}',
  ADD COLUMN exclude_topics text[] NOT NULL DEFAULT '{}',
  ADD COLUMN brand_safety text NOT NULL DEFAULT 'standard' CHECK (brand_safety IN ('strict', 'standard', 'relaxed'));

-- The page's main topic and risk when the ad was served, on the 'served' row
-- of each delivery. Later events of the delivery are joined to it by delivery id.
ALTER TABLE ad_events
  ADD COLUMN topic text,
  ADD COLUMN brand_safety text;

-- Recomputed per day from ad_events by the aggregation job, like daily_stats.
-- topic is '' when the page had no topic.
CREATE TABLE topic_daily_stats (
  day                  date NOT NULL,
  campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  advertiser_org_id    uuid NOT NULL,
  site_id              uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  publisher_org_id     uuid NOT NULL,
  topic                text NOT NULL,
  valid_impressions    bigint NOT NULL DEFAULT 0,
  viewable_impressions bigint NOT NULL DEFAULT 0,
  valid_clicks         bigint NOT NULL DEFAULT 0,
  spend_micros         bigint NOT NULL DEFAULT 0,
  publisher_micros     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, campaign_id, site_id, topic)
);
CREATE INDEX topic_daily_stats_adv_idx ON topic_daily_stats (advertiser_org_id, day);
CREATE INDEX topic_daily_stats_pub_idx ON topic_daily_stats (publisher_org_id, day);
