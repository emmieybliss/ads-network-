-- Stronger invalid-traffic detection: what each event tripped, automatic
-- review cases and automatic earnings clawbacks.

-- The signals behind an event's score, for investigation (e.g. {webdriver} or {rate:180/min}).
ALTER TABLE ad_events ADD COLUMN ivt_signals text[];
-- Bitmask of the ad tag's browser checks (see packages/tracking/src/automation.ts).
ALTER TABLE ad_events ADD COLUMN client_flags smallint;
CREATE INDEX ad_events_visitor_time_idx ON ad_events (visitor_hash, occurred_at) WHERE visitor_hash IS NOT NULL;
CREATE INDEX ad_events_ip_time_idx ON ad_events (ip_hash, occurred_at) WHERE ip_hash IS NOT NULL;
CREATE INDEX ad_events_pub_time_idx ON ad_events (publisher_org_id, occurred_at);

-- Cases opened by the sweep are 'auto'; 'kind' says which rule opened them.
-- criteria is what a clawback for the case would exclude (same shape as the
-- exclude endpoint), estimated_micros what it would reverse when opened.
ALTER TABLE fraud_cases
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  ADD COLUMN kind text,
  ADD COLUMN publisher_org_id uuid REFERENCES organizations(id),
  ADD COLUMN criteria jsonb,
  ADD COLUMN estimated_micros bigint NOT NULL DEFAULT 0 CHECK (estimated_micros >= 0),
  ADD COLUMN dedup_key text UNIQUE;
CREATE INDEX fraud_cases_pub_idx ON fraud_cases (publisher_org_id, created_at DESC);

-- Automatic exclusions have no staff actor.
ALTER TABLE event_exclusions ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE event_exclusions
  ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN publisher_org_id uuid REFERENCES organizations(id),
  ADD COLUMN publisher_micros bigint NOT NULL DEFAULT 0 CHECK (publisher_micros >= 0);
ALTER TABLE event_exclusions ADD CONSTRAINT event_exclusions_actor_check CHECK (automatic OR actor_id IS NOT NULL);
CREATE INDEX event_exclusions_pub_idx ON event_exclusions (publisher_org_id, created_at DESC);
