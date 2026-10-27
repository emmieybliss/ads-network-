-- Automatic in-article placement: the ad tag inserts ads between paragraphs
-- of the article, using one of the site's in-page placements, within the
-- limits the publisher sets here.
ALTER TABLE sites
  ADD COLUMN auto_ads_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_ads_unit_id uuid REFERENCES ad_units(id) ON DELETE SET NULL,
  ADD COLUMN auto_ads_max integer NOT NULL DEFAULT 3 CHECK (auto_ads_max BETWEEN 1 AND 6),
  ADD COLUMN auto_ads_spacing integer NOT NULL DEFAULT 4 CHECK (auto_ads_spacing BETWEEN 2 AND 20),
  ADD COLUMN auto_ads_first_after integer NOT NULL DEFAULT 3 CHECK (auto_ads_first_after BETWEEN 1 AND 20),
  ADD COLUMN auto_ads_selector text CHECK (auto_ads_selector IS NULL OR char_length(auto_ads_selector) <= 200),
  ADD CONSTRAINT sites_auto_ads_unit CHECK (NOT auto_ads_enabled OR auto_ads_unit_id IS NOT NULL);
