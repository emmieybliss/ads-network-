-- Refuse to roll back over data the older schema cannot hold.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM creatives WHERE format = 'pop') THEN
    RAISE EXCEPTION 'Pop creatives exist; rolling back would require deleting them';
  END IF;
END $$;

UPDATE ad_units SET formats = '{image,text}' WHERE formats = '{pop}';
UPDATE ad_units SET formats = array_remove(formats, 'pop') WHERE 'pop' = ANY (formats);
UPDATE ad_units SET display = 'inline', status = 'archived' WHERE display IN ('popup', 'popunder');
UPDATE sites SET allowed_formats = array_remove(allowed_formats, 'pop') WHERE 'pop' = ANY (allowed_formats);
ALTER TABLE sites ALTER COLUMN allowed_formats SET DEFAULT '{image,text,native}';

ALTER TABLE creatives DROP CONSTRAINT creatives_format_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_format_check CHECK (format IN ('image', 'text', 'native'));

ALTER TABLE ad_units DROP CONSTRAINT ad_units_display_check;
ALTER TABLE ad_units
  DROP COLUMN pop_minutes_between,
  DROP COLUMN pop_max_per_day,
  ADD CONSTRAINT ad_units_display_check CHECK (display IN ('inline', 'anchor', 'rail_left', 'rail_right', 'interstitial'));
