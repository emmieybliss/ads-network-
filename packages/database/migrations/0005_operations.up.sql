-- Operational records: payment provider connection checks and data export requests.
CREATE TABLE provider_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  ok          boolean NOT NULL,
  detail      text NOT NULL,
  checked_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_checks_idx ON provider_checks (provider, created_at DESC);

CREATE TABLE data_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  org_id       uuid REFERENCES organizations(id),
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count    integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
