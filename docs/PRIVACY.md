# Privacy and data retention

## What the ad tag does and does not do

- It sets **no cookies**.
- It reads consent signals from the page and sends them with each ad request:
  an IAB TCF v2.2 CMP (`__tcfapi`), an IAB GPP CMP (`__gpp`), the US Privacy
  API (`__uspapi`), Global Privacy Control (`navigator.globalPrivacyControl`
  and the `Sec-GPC` header) and the publisher's own
  `window.blissnova.setConsent()`. It waits up to 2 seconds for a CMP before
  the first ad request.
- The server decides whether an ad may be personalized
  (`apps/api/src/services/consent.ts`). It is contextual when:
  - personalized ads are off for the network (the default);
  - GPC is set, or a US Privacy or GPP US national section shows an opt-out of
    sale, sharing or targeted advertising;
  - a GPP section the server does not decode yet applies (individual US state
    sections, Canada): it is treated as an opt-out;
  - GDPR applies and the TC string lacks consent for purposes 1, 3 and 4 or for
    the network's vendor id. **Without `TCF_VENDOR_ID` (an IAB Global Vendor
    List registration) the network never claims TCF consent**, so every ad
    under GDPR is contextual;
  - the publisher called `setConsent(false)`, or, outside GDPR, never opted in.
- It stores a visitor id in `localStorage` only after the server says
  personalization is allowed, and deletes it as soon as any signal goes against
  it.
- Interstitial placements keep one timestamp in `sessionStorage` (`bn_ist`,
  cleared when the tab closes) so they show at most once every 10 minutes. It
  holds no identifier. Where GDPR applies without consent to store information
  (TCF purpose 1), interstitials are not shown at all.
- Pop-up and pop-under placements store nothing on the device. Their
  per-visitor limits are counted on the server against the same hashed IP
  address used for invalid-traffic checks, per site, and expire within a day.
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
  Page view counts per path (for page RPM) are daily totals with no visitor
  data; the page view id is kept in Redis for 30 minutes only to avoid double
  counting.

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
