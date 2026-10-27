# Architecture

## Components

```
 browser (publisher page)                       browser (dashboards)
   │  <script src=…/sdk/ads.js data-site-key data-slot>   │
   │                                                     ▼
   │                                          apps/web  (Next.js, :3000)
   │                                            │  proxies /api/v1, /sdk, /assets, /api/docs
   ▼                                            ▼
 apps/api  (Fastify, :4000) ───────────── PostgreSQL 16 (all state, ledger)
   │   serve · events · click · management API        ▲
   └──── Redis 7 (rate limits, caps, queues) ◄── apps/worker (BullMQ)
```

- **apps/web**: the marketing site (16 homepage sections) and three portals:
  publisher, advertiser and admin. The browser talks only to the web app's own
  origin. The web server proxies API paths, so session cookies stay first-party
  and production can use a single hostname. `API_INTERNAL_URL` is read when the
  app is built.
- **apps/api**: every rule is enforced here: auth, RBAC, state machines, money
  and invalid-traffic decisions. The UI hides actions a user cannot take, but
  the API is the authority.
- **apps/worker**: background work on three schedules.
  - Every minute: report aggregation for today, campaign lifecycle, settlement and spend counter sync.
  - Every five minutes: budget and low-balance alerts, plus anomaly detection.
  - Daily: retention, flat-rate allocation, payment expiry and statements.
  - From the queues: tracking events when `EVENT_PROCESSING=queue`, emails and serve logs.
- **sdk/ad-tag**: a 9 kB script with no dependencies.
  - Each slot renders inside a closed shadow root, so publisher CSS cannot hide the "Sponsored" label.
  - Creative text is set with `textContent`, never `innerHTML`.
  - Advertiser JavaScript is never executed.
  - Slots load lazily.
  - A viewable impression is reported when 50% of the ad is visible for one second.
  - Events are batched with `sendBeacon`.
  - A visitor id is stored only while the page signals consent for personalization.
  - On any error the slot collapses.
  - It sets `data-bn-state="filled"` or `"empty"` on the slot.

## Ad request to dashboard

1. **Serve.** The tag POSTs `/api/v1/serve` with the site key, slots and page URL.
   - The API checks that the site is approved and the page host is authorized for that site.
   - Known crawlers and headless browsers get no ad.
   - The deterministic decision engine (`packages/ad-decision`) picks a campaign by priority, then expected value, then pacing. It applies targeting, frequency caps and budget.
   - Each ad carries an encrypted, expiring delivery token (AES-256-GCM key ring).
2. **Render, viewable.** The tag posts these events with the token. The API
   decrypts the token, deduplicates, checks the sequence (no viewable or click
   without a render) and scores invalid traffic (`packages/tracking/ivt.ts`).
   Hard failures make an event invalid on their own. Soft signals add to a
   score, and the event is invalid only when the score reaches a configurable
   threshold.
3. **Click.** The ad links to `/api/v1/click?t=…`, which records the click and
   redirects only to the destination stored for the creative. The caller cannot
   supply a URL.
4. **Charge.** A valid billable event charges the campaign. CPM is charged per
   valid render and CPC per valid click. The charge goes through the ledger, and
   budgets are reserved up front so spend cannot exceed them.
5. **Report.** The worker rebuilds today's `daily_stats` from events every
   minute. Reports and CSV exports read `daily_stats`. CTR = valid clicks / valid
   impressions × 100, and invalid traffic is shown separately and never earns.
6. **Settle.** Settlement moves charged amounts into publisher earnings at the
   organization's revenue share. Payouts are requested by the publisher and
   approved by finance staff.

## Money

All amounts are integer **micros** (1/1,000,000 of the currency unit) stored as
`bigint`, so there is no floating-point arithmetic. The ledger is double-entry:

- Every transaction must balance in one currency. A deferred constraint trigger enforces this.
- Entries are append-only. A trigger refuses UPDATE and DELETE.
- Every posting has an idempotency key.
- Corrections are new adjustment transactions with a reason and an audit record. Nothing is silently modified or deleted.
- Eight reconciliation checks run on demand from the admin finance page.

Payment confirmation comes from the provider's webhook, or from finance staff for
bank transfers. A browser redirect from a payment page never credits an
account.

## Sites and verification

A site moves through `draft → verification_pending → verified → submitted →
under_review → approved` (also `rejected`, `suspended`). Ownership is proven
by a DNS TXT record, an HTML file or a meta tag, fetched with an SSRF-safe
client. That client allows https only, refuses private and reserved addresses
after DNS resolution, limits redirects, and limits size and time. Verification alone
never approves a site. An admin reviews it against the eligibility checklist,
which is configurable in admin settings. No minimum traffic threshold is
hardcoded.

The **verification simulator** (`ENABLE_DEV_VERIFICATION_SIMULATOR`) and the
**simulated payment provider** (`ENABLE_DEV_PAYMENTS`) exist for local work and
the demo. The API refuses to start with either enabled when
`NODE_ENV=production`. `tests/security/verification.test.ts` covers this: it checks
the startup refusal, and also checks that the simulator endpoints do not exist
and simulated sites never serve ads, even when a production app is forced to
run with the flags on.

## Roles

There are 11 platform roles, from super_admin through finance, support, trust and
safety, and others; see `packages/shared/src/permissions.ts`. There are also 3
organization roles: owner, manager and analyst. Admin actions that matter, such
as money, suspensions and settings, require a reason and recent re-authentication
(step-up), and they write to the audit log.

## Decisions and deviations

- **Standalone, not a WordPress plugin.** The original plan included a
  WordPress plugin. The revised specification dropped it: any site uses the
  script tag. The API-key management API remains for future integrations.
- **No separate "approved" campaign status.** Admin approval moves a campaign
  straight to `active`, or to `scheduled` if its start date is in the future.
- **Reports are near real time, not instant.** Live events appear after the
  next aggregation run, which happens within about one minute.
- **Images only for uploaded creatives** (PNG, JPEG, GIF, WEBP, checked by magic
  bytes). SVG and HTML creatives are not accepted, so no advertiser markup or
  script runs on publisher pages.
- **Country** comes from a trusted CDN header (`GEO_COUNTRY_HEADER`). No GeoIP
  database is bundled.
