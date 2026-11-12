DROP TABLE topic_daily_stats;
ALTER TABLE ad_events DROP COLUMN topic, DROP COLUMN brand_safety;
ALTER TABLE campaign_targeting DROP COLUMN topics, DROP COLUMN exclude_topics, DROP COLUMN brand_safety;
DROP TABLE page_contexts;
