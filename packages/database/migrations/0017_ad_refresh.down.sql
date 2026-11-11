ALTER TABLE daily_stats
  DROP COLUMN refreshed_impressions, DROP COLUMN refreshed_viewable_impressions,
  DROP COLUMN refreshed_spend_micros, DROP COLUMN refreshed_publisher_micros;
ALTER TABLE ad_events DROP COLUMN refresh_count;
ALTER TABLE campaigns DROP COLUMN accept_refresh;
ALTER TABLE ad_units DROP COLUMN refresh_enabled, DROP COLUMN refresh_seconds, DROP COLUMN refresh_max;
