DROP TABLE IF EXISTS email_outbox, notifications, pricing_plans, content_items, platform_settings, abuse_reports, admin_notes, security_events, audit_logs, api_keys, invitations, memberships, organizations, auth_events, user_tokens, sessions, users CASCADE;
DROP FUNCTION IF EXISTS forbid_mutation();
