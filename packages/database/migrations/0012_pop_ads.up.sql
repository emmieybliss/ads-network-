-- Pop-up and pop-under placements, and the "pop" creative format that fills them.
--   popup     the advertiser's landing page opens in a new tab or window in front
--   popunder  the same, with focus handed back to the publisher's page where the browser allows it
-- Both open only from a visitor's click on the page, at most once per page view,
-- and within the placement's own frequency limits (which the network's limits can tighten further).
-- A pop creative is just a reviewed landing page; it never fills an in-page slot.
ALTER TABLE ad_units DROP CONSTRAINT ad_units_display_check;
ALTER TABLE ad_units
  ADD CONSTRAINT ad_units_display_check CHECK (display IN ('inline', 'anchor', 'rail_left', 'rail_right', 'interstitial', 'popup', 'popunder')),
  ADD COLUMN pop_max_per_day integer NOT NULL DEFAULT 1 CHECK (pop_max_per_day BETWEEN 1 AND 20),
  ADD COLUMN pop_minutes_between integer NOT NULL DEFAULT 60 CHECK (pop_minutes_between BETWEEN 1 AND 1440);

ALTER TABLE creatives DROP CONSTRAINT creatives_format_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_format_check CHECK (format IN ('image', 'text', 'native', 'pop'));

-- Sites accept pops unless staff take the format off a site; nothing pops until the publisher adds a pop placement.
ALTER TABLE sites ALTER COLUMN allowed_formats SET DEFAULT '{image,text,native,pop}';
UPDATE sites SET allowed_formats = array_append(allowed_formats, 'pop') WHERE NOT ('pop' = ANY (allowed_formats));
