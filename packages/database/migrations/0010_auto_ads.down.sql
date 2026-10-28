ALTER TABLE sites
  DROP CONSTRAINT sites_auto_ads_unit,
  DROP COLUMN auto_ads_selector,
  DROP COLUMN auto_ads_first_after,
  DROP COLUMN auto_ads_spacing,
  DROP COLUMN auto_ads_max,
  DROP COLUMN auto_ads_unit_id,
  DROP COLUMN auto_ads_enabled;
