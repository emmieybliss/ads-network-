-- ads.txt: each publisher lists the network as an authorized seller of its
-- inventory. We record the last check of each site's /ads.txt so publishers
-- and reviewers can see whether the line is in place.
ALTER TABLE sites
  ADD COLUMN ads_txt_status text NOT NULL DEFAULT 'unchecked'
    CHECK (ads_txt_status IN ('unchecked', 'found', 'missing', 'mismatch', 'error')),
  ADD COLUMN ads_txt_checked_at timestamptz,
  ADD COLUMN ads_txt_detail text CHECK (ads_txt_detail IS NULL OR char_length(ads_txt_detail) <= 500);

-- sellers.json: a publisher may ask to be listed as confidential (seller id only).
ALTER TABLE organizations ADD COLUMN sellers_json_confidential boolean NOT NULL DEFAULT false;
