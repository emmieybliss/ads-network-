-- Viewable auto-refresh. A placement can show a new ad after the current one
-- has been at least half in view, in a visible tab, for the placement's
-- interval (30 seconds at the least). Off by default: the publisher turns it
-- on per placement, the network can switch it off everywhere (settings group
-- adRefresh), and an advertiser can keep a campaign out of refreshed
-- impressions.

ALTER TABLE ad_units
  ADD COLUMN refresh_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN refresh_seconds integer NOT NULL DEFAULT 30 CHECK (refresh_seconds BETWEEN 30 AND 600),
  ADD COLUMN refresh_max integer NOT NULL DEFAULT 4 CHECK (refresh_max BETWEEN 1 AND 20);

-- Advertisers buy refreshed impressions unless they say otherwise.
ALTER TABLE campaigns ADD COLUMN accept_refresh boolean NOT NULL DEFAULT true;

-- 0 for the first ad a slot showed on a page view, 1 for the first refresh, and so on.
ALTER TABLE ad_events ADD COLUMN refresh_count smallint NOT NULL DEFAULT 0 CHECK (refresh_count BETWEEN 0 AND 20);

-- Refreshed impressions are reported apart from first impressions.
ALTER TABLE daily_stats
  ADD COLUMN refreshed_impressions bigint NOT NULL DEFAULT 0,
  ADD COLUMN refreshed_viewable_impressions bigint NOT NULL DEFAULT 0,
  ADD COLUMN refreshed_spend_micros bigint NOT NULL DEFAULT 0,
  ADD COLUMN refreshed_publisher_micros bigint NOT NULL DEFAULT 0;
