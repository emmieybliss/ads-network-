DROP TABLE site_traffic_daily;
DROP TABLE ivt_daily_stats;
DROP TABLE hourly_stats;
-- Fold the new dimensions back into one row per old key, keeping history.
CREATE TEMP TABLE daily_stats_fold ON COMMIT DROP AS
  SELECT day, campaign_id, creative_id, min(advertiser_org_id::text)::uuid AS advertiser_org_id, site_id, unit_id, min(publisher_org_id::text)::uuid AS publisher_org_id, country, device,
    sum(served) AS served, sum(rendered) AS rendered, sum(valid_impressions) AS valid_impressions, sum(invalid_impressions) AS invalid_impressions,
    sum(viewable_impressions) AS viewable_impressions, sum(valid_clicks) AS valid_clicks, sum(invalid_clicks) AS invalid_clicks,
    sum(billable_impressions) AS billable_impressions, sum(billable_clicks) AS billable_clicks, sum(spend_micros) AS spend_micros, sum(publisher_micros) AS publisher_micros
  FROM daily_stats GROUP BY day, campaign_id, creative_id, site_id, unit_id, country, device;
DELETE FROM daily_stats;
ALTER TABLE daily_stats DROP CONSTRAINT daily_stats_pkey;
ALTER TABLE daily_stats ADD PRIMARY KEY (day, campaign_id, creative_id, site_id, unit_id, country, device);
ALTER TABLE daily_stats
  DROP COLUMN os, DROP COLUMN browser, DROP COLUMN source, DROP COLUMN in_view_ms, DROP COLUMN in_view_samples,
  DROP COLUMN conversions, DROP COLUMN conversion_value_micros;
INSERT INTO daily_stats (day, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, served, rendered, valid_impressions,
  invalid_impressions, viewable_impressions, valid_clicks, invalid_clicks, billable_impressions, billable_clicks, spend_micros, publisher_micros)
  SELECT * FROM daily_stats_fold;
DROP TABLE conversions;
ALTER TABLE campaigns DROP COLUMN conversion_tracking, DROP COLUMN attribution_window_days;
DELETE FROM ad_events WHERE type = 'inview';
ALTER TABLE ad_events DROP CONSTRAINT ad_events_type_check;
ALTER TABLE ad_events ADD CONSTRAINT ad_events_type_check CHECK (type IN ('served', 'render', 'viewable', 'click'));
ALTER TABLE ad_events DROP COLUMN os, DROP COLUMN browser, DROP COLUMN source, DROP COLUMN in_view_ms;
