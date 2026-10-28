-- Scheduled performance report emails: one subscription per user and organization.
CREATE TABLE report_subscriptions (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  frequency        text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  -- Last day of the most recent period already emailed; NULL until the first one.
  last_period_end  date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX report_subscriptions_frequency_idx ON report_subscriptions (frequency, last_period_end);
