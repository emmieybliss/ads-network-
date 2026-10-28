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
- Nine reconciliation checks run on demand from the admin finance page.

Payment confirmation comes from the provider's webhook, or from finance staff for
bank transfers. A browser redirect from a payment page never credits an
account.

## Premium tiers and earnings minimums

Organizations are `standard` or `premium`. An admin with pricing rights changes
this in Admin, Organizations. The change needs a reason and step-up, and it is
audited.

A premium **publisher** can also have an earnings minimum, set per publisher,
for the publisher's share per 1,000 impressions and/or per click:

- **Price floor** (`earnings_mode = floor`). The decision engine drops any
  campaign whose rate times the publisher's revenue share is below the minimum
  (reason `below_floor`). No network money is involved. The trade-off is that
  fewer ads may fill.
- **Guarantee** (`earnings_mode = guarantee`). Every eligible ad serves. Each
  night the worker compares the previous day's valid earnings with the minimum
  (`applyGuarantee` in `packages/billing`):
  - It counts only valid, billable, non-excluded CPM renders and CPC clicks.
  - It pays the shortfall from the platform's `guarantee_expense` account into
    `publisher_pending`, capped by the publisher's monthly cap.
  - It records the day in `publisher_guarantees`.
  - It is idempotent per publisher and day.
  - Top-ups follow the normal hold period before they become available.
  - Reconciliation check 9 confirms that every top-up matches its ledger posting.

A premium publisher can also accept only premium advertisers (`premium_only`).

Nothing is promised to publishers without an agreement. The marketing site says
so. Limitation: a top-up is calculated once per day. If events from that day
are excluded as invalid traffic afterwards, the top-up is not recalculated
automatically. Finance staff can correct it with a manual adjustment, which is
audited.

## Placement types and reserved space

Each ad unit has a `display`: `inline`, `anchor`, `rail_left`, `rail_right` or
`interstitial` (migration 0009). The publisher snippet carries it as
`data-bn-display`, and `/serve` returns it per slot so the tag follows the
server's setting.

- **Inline** snippets reserve space up front: `aspect-ratio` for fixed sizes,
  `min-height` (capped by viewport width) for responsive units with a typical
  size. With `no_fill = keep_space` an empty slot keeps that space instead of
  collapsing, so nothing below it moves.
- **Anchor**: one per page, fixed to the bottom, closable; the tag pads the
  page body by the bar's height so the end of the page stays reachable. At most
  120 px tall.
- **Side rails**: fixed beside the content, requested only when the viewport
  leaves room for a 1024 px content column plus the rail on both sides. At most
  300 px wide.
- **Interstitial**: requested only when the visitor follows a link to another
  page of the same site. The tag waits at most 1.5 s for an ad, otherwise it
  navigates straight away. It shows a clear "Continue to page" button (Escape
  and a backdrop click also continue), at most once per 10 minutes per tab.
- **Pop-up / pop-under** (`popup`, `popunder`, migration 0012): filled only
  by the `pop` creative format, which is a reviewed landing page and nothing
  else, and only by CPM or flat-rate campaigns (a pop has no click to charge).
  The tag requests the pop when the page loads, then opens it with
  `window.open` inside the visitor's first click on the page (never on load,
  never from a click on an ad, a form field or an editable area), at most once
  per page view, and clears `opener` so the landing page cannot script the
  publisher's page. A pop-under then hands focus back to the page; most
  current browsers ignore that, so it can behave like a pop-up. A pop counts
  as an impression only when the browser actually opened it. Per-visitor
  limits are enforced on the server in Redis, keyed by site and hashed IP
  address (so they need nothing stored on the device): the placement's
  `pop_max_per_day` and `pop_minutes_between`, tightened by the network's
  `popAds` settings. Admins can turn pops, or only pop-unders, off
  network-wide; existing pop placements then get no ads.

## Automatic in-article placement

A site can turn on automatic ads (migration 0010): one in-page placement, the
most ads per article (1 to 6), the paragraph after which the first goes, the
paragraphs between ads, and an optional article container selector. The
publisher adds the loader once with `data-auto="1"`. The tag then reads
`GET /api/v1/public/sites/:siteKey/auto` (cacheable for 5 minutes), finds the
article (the selector, a usual article container, or the element with the
most paragraphs), counts paragraphs of real text (skipping lists, tables,
quotes and figures), and inserts slots that reserve their space. It never
places one next to an existing slot or after the last paragraph. The inserted
slots are ordinary slots of that placement, so serving, labels, caps and
reports are unchanged. Pausing the placement turns automatic ads off.

## Page views and page RPM

Page RPM is estimated earnings per 1,000 page views, the main number
publishers compare networks by. A page view here is a page where the ad tag
asked for at least one ad: the first `/serve` request carrying a new page
view id (`pv`, made by the tag per page load) adds one to `page_views` for
that day, site and path; later requests with the same id within 30 minutes
are not counted again (a Redis `SET NX` key). Pages without the tag are not
seen, so this is lower than an analytics tool's count.

The path (no host, query string or fragment, at most 300 characters) goes into
the signed delivery token (`pp`), so every event of that ad, including clicks,
records `ad_events.page_path`. The daily aggregation job rebuilds
`page_daily_stats` (valid impressions, valid clicks, publisher earnings per
site and path) alongside `daily_stats`. `GET /orgs/:orgId/reports/pages`
combines the two and returns page views, impressions per page view, CTR,
estimated earnings and page RPM per page; `/reports/pages/export` gives the
same as CSV. The publisher overview shows page views and page RPM, and the
Reports page has a Pages tab. Migration 0011.

## Consent (TCF v2.2, GPP, US Privacy, GPC)

The ad tag collects signals from the page's CMPs and sends them with each
`/serve` request; it does not decide anything itself. `services/consent.ts`
decodes TCF v2 TC strings (core segment: purposes and vendor consents), GPP
headers (Fibonacci-coded section ids), the GPP US national section and US
Privacy strings, and returns `{ personalized, reason }`. Serving uses a visitor
id only when that is true, and the response tells the tag
(`privacy.personalization`) whether it may keep one. GPP sections the server
cannot decode yet count as an opt-out. TCF consent needs `TCF_VENDOR_ID`; the
network has no IAB registration, so it is unset by default. The demo site's
`/consent-test` page answers the IAB APIs with fixed test signals to show each
outcome.

## ads.txt and sellers.json

Each publisher's seller id is its organization id. The site's Ad tag tab
shows the line to add to `https://<site>/ads.txt`:

```
<ADS_TXT_DOMAIN>, <seller id>, DIRECT
```

**Check now** fetches the file with the same SSRF-safe client used for
verification and records the result on the site, which admins see too. The
result is one of: found, missing, mismatch (wrong id or RESELLER), or error.

`/sellers.json` (IAB Tech Lab 1.0) lists approved publishers that have an
approved site. A publisher can ask to be confidential in Organization settings,
and is then listed by seller id only. The ads.txt result does not block serving.

## Native ads

A native creative has an image, a headline, optional body and call to action,
and a required sponsor name. The tag renders it inside the same closed shadow
root as the other formats, as a card that follows the page's light or dark
scheme. The card always starts with a "Sponsored · {sponsor}" line above the
headline, so it cannot be mistaken for editorial content. Publishers opt in per
site and per placement through the `native` format.

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
- **Formats are image, text and native.** Images only for uploaded creatives (PNG, JPEG, GIF, WEBP, checked by magic
  bytes). SVG and HTML creatives are not accepted, so no advertiser markup or
  script runs on publisher pages.
- **Country** comes from a trusted CDN header (`GEO_COUNTRY_HEADER`). No GeoIP
  database is bundled.
