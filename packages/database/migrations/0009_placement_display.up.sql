-- How a placement shows on the page:
--   inline        in the page where the snippet is pasted (the default)
--   anchor        a bar fixed to the bottom of the screen, which the visitor can close
--   rail_left/right  fixed beside the content, only on screens wide enough for it
--   interstitial  full screen between two pages of the site, closable, capped per session
-- and what an inline slot does when no ad fills it: collapse, or keep its
-- reserved space so the page does not shift.
ALTER TABLE ad_units
  ADD COLUMN display text NOT NULL DEFAULT 'inline'
    CHECK (display IN ('inline', 'anchor', 'rail_left', 'rail_right', 'interstitial')),
  ADD COLUMN no_fill text NOT NULL DEFAULT 'collapse'
    CHECK (no_fill IN ('collapse', 'keep_space'));
