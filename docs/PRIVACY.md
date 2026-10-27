# Privacy and data retention

## What the ad tag does and does not do

- It sets **no cookies**.
- It stores a visitor id in `localStorage` only while the page signals consent
  for personalized ads (`window.blissnova.setConsent({ personalized: true })`).
  Revoking consent deletes the id.
- Without consent, ads are contextual: they are chosen from the page, placement
  and site category only.
- It does not try to bypass consent decisions, browser privacy protections or ad
  blockers. If it is blocked, the slot stays empty.

## What the platform stores about visitors

- **No raw IP addresses.** IPs are hashed with a salt that rotates daily, so a
  hash cannot be linked across days.
- The user agent is reduced to a device category and a hash.
- Country comes only from a CDN header you configure. Otherwise it is "ZZ".
- The page host and path are stored, without the query string or fragment.

## Retention (configurable in Admin, Settings)

| Data | Default | Notes |
| --- | --- | --- |
| Raw ad events | 90 days | Removed only once settled or non-billable |
| Daily report aggregates | 2,555 days (about 7 years) | Needed for statements and disputes |
| Expired or revoked sessions | 30 days after expiry | |
| Email and reset tokens | 7 days after expiry | |
| Ledger, invoices, audit log | kept | Financial and audit records are never silently deleted |

## Accounts

Logs never contain passwords, raw session tokens or payment credentials.
Account holders can see and revoke their own sessions. Set up data export and
deletion requests in line with the law where you operate. This software does
not make you compliant by itself.
