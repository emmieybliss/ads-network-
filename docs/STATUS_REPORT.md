# BlissNova Ad Network: status report

Date: 28 October 2026. Branch `main` at `a507bd9` (pull requests #2 to #8 and #10 merged).

This report was checked against the code on `main`. The build and test suite
were run in the cloud build environment (Linux, PostgreSQL 16, Redis 7). That
is **not** your PC, and nothing has been deployed to a public server. No real
payment provider or partner network is connected.

Status words used below:

- **Built**: in the code and exercised by a test or a browser run.
- **Simulated**: real code that has only run against a simulator or a mocked API.
- **Partial**: a basic version exists.
- **Missing**: no code for it yet.
- **Needs you**: blocked on an account, contract, domain or company detail only you can provide.

## 1. Project folder

- **Repository:** `emmieybliss/ads-network-` on GitHub, branch `main`.
- **On your PC:** `BlissNova-AdNetwork`, cloned from the repository. Pull `main` to get the latest.

## 2. Applications and services

| Service | What it is |
| --- | --- |
| `web` (Next.js 15) | marketing site, publisher, advertiser and admin portals |
| `api` (Fastify 5) | REST API under `/api/v1`, ad serving, events, click redirect, the `/sdk/ads.js` tag, OpenAPI at `/api/docs` |
| `worker` (BullMQ) | event processing, report aggregation every minute, settlement, partner sync, payouts, report emails, alerts, retention |
| `demo-site` | fictional publisher page for local testing (refuses production) |
| PostgreSQL 16, Redis 7 | database, cache and queues |

## 3. Running the demo

**Windows, Node only (recommended):** double-click `Start BlissNova demo.bat`,
and `Stop BlissNova demo.bat` to stop. It runs an embedded PostgreSQL and an
in-memory Redis stand-in, so frequency caps and rate limits reset on restart.
Data lives in `%LOCALAPPDATA%\BlissNova-demo`. The demo logins and generated
password are printed in the start window.

**Docker:** `scripts/start-demo.ps1` or `scripts/start-demo.sh` (see README).

| What | URL |
| --- | --- |
| Website and dashboards | http://localhost:3000 |
| API health | http://localhost:4000/ready |
| API reference | http://localhost:3000/api/docs |
| Demo publisher website | http://localhost:3100 |
| Mailpit (Docker route only) | http://localhost:8025 |

Demo accounts (development only): `admin@example.com`, `advertiser@example.com`,
`publisher@example.com`. The password is generated on first start; none is committed.

## 4. Built

- **Accounts:** registration, email verification, password reset, TOTP MFA, step-up, session revocation, CSRF, lockout, rate limits, audit log, 11 platform roles plus organization roles, team invites, API keys.
- **Domain verification:** DNS TXT, HTML file and meta tag over an SSRF-safe fetch (private IPs blocked, every redirect checked, time and size limits). Development simulator refused in production.
- **Publisher onboarding:** site lifecycle from Draft to Approved/Rejected/Suspended, configurable eligibility checklist, verification never approves on its own. ads.txt line per publisher and public sellers.json.
- **Advertiser platform:** CPM, CPC (behind a switch) and flat campaigns; lifetime and daily budgets; even or fast pacing; frequency caps; targeting by country, device, site category, keyword, and site/placement lists; image, text, native and pop creatives with review and versions; conversion tracking.
- **Ad serving:** eligibility checks, ranking by priority and expected value with pacing, Redis frequency caps and budget reservation, signed delivery tokens, safe no-fill.
- **Ad tag:** about 8 KB gzipped, closed shadow root, lazy loading, viewability (50% for 1 s), batching, multiple slots; anchor, side rail, interstitial, auto in-article, native and pop formats; TCF v2.2, GPP, US Privacy and GPC consent with a non-personalized fallback.
- **Tracking and invalid traffic:** unique event ids, replay and sequence checks, deduplication, separate request/impression/viewable/click/invalid/billable counts, combined IVT score, fraud cases, exclusions and publisher appeals.
- **Money:** double-entry ledger in exact micro-units, wallet, transactional budget reservation, invoices, refunds, disputes, adjustments, settlement, 10 reconciliation checks, premium tier and earnings guarantees, payout requests with monthly auto-requests, simulated payment and payout providers refused in production.
- **Reports:** publisher and advertiser reports by date, site, placement, page, country, device and source; page RPM; CSV export; CTR from totals; audience, sources, time in view, world map; scheduled report emails.
- **Admin control center:** users, organizations, sites, domains, campaigns, creative review, finance, payouts, pricing, fraud, security, audit, support, content, settings, system health, partner networks, analytics.
- **Operations:** Docker Compose stack, Windows double-click demo, production startup refuses unsafe configuration, deployment guide.

## 5. Simulated (real code, never run against the real service)

- **Stripe** card payments: tested only against mocked Stripe responses.
- **PayPal** deposits and PayPal Payouts: tested only against a mocked PayPal API, not the PayPal sandbox.
- **Partner networks** (MGID, Revcontent, Taboola, Outbrain): only the simulated partner adapter exists.
- **Domain verification on a public domain:** the real methods have only run against test fixtures; on localhost the development simulator is used.

## 6. Partial

- **Viewable refresh:** the tag has a manual `refresh()` for new slots; no automatic refresh after time in view.
- **Contextual targeting:** keyword and site-category matching; pages are not read or classified automatically.
- **Bot detection:** user-agent patterns plus behaviour scoring; no datacenter IP lists, browser integrity checks or outside IVT vendor.
- **Country:** needs a CDN country header or a `.mmdb` GeoIP file, neither bundled. Demo country history is labelled sample data.
- **Bank and crypto payouts:** staff pay outside the platform and record the reference.
- **Reports** refresh every minute, not instantly.
- **Auctions:** campaigns compete in an internal ranking only.

## 7. Missing

- Header bidding (Prebid.js, Prebid Server) and OpenRTB demand.
- Video ads (VAST, outstream or instream).
- Content recommendation widgets.
- Tax form collection (W-9, W-8BEN) for publishers.
- Self-service personal-data export and account deletion.
- Public hosting, monitoring and running backups.
- Third-party security review.

## 8. Tests executed (28 Oct 2026, on `main`)

| Command | Result |
| --- | --- |
| `pnpm -r build` | succeeded |
| `pnpm test` (Vitest: unit, integration, security) | 27 files, **477 of 477 passed** |

`scripts/e2e-demo.mjs` and `scripts/acceptance-ui.mjs` were run on 27 Oct
against the Docker stack and passed; they were not re-run for this report.

## 9. Needs you for production

- A domain name and DNS, and a TLS certificate (for example Let's Encrypt).
- A server or hosting account for PostgreSQL, Redis and the containers, plus backups.
- An email (SMTP) provider.
- A PayPal business account with Payouts enabled (sandbox keys are free and would let the integration be tested for real).
- A Stripe account, if you want card payments.
- Partner network accounts and API access, MGID first.
- IAB Europe TCF vendor registration (`TCF_VENDOR_ID`); without it EU visitors get only non-personalized ads.
- Signed SSP contracts before header bidding is worth building.
- Your real company details, legal pages, FAQ and support email (Admin → Content holds placeholders).

## 10. Choosing a domain and deploying later

1. Register a domain you control. Nothing in the code assumes a particular name.
2. Point an `A`/`AAAA` record at your server and obtain a TLS certificate.
3. Follow `docs/DEPLOYMENT.md`: build the images; set `PUBLIC_SITE_URL`, `PUBLIC_API_URL` and `CORS_ORIGINS` to `https://your-domain`; generate new secrets; configure SMTP; keep both simulators off. Startup refuses anything unsafe.
4. Run migrations and `create-admin`. Do not run the demo seed.
5. Put nginx (example in DEPLOYMENT.md) in front, and set `TRUST_PROXY=true`.
6. Configure payment providers using `docs/PAYMENTS_AND_PAYOUTS.md`.
7. Replace placeholder content, review settings, set up backups, and test a restore.
8. Publisher tags generated after this point use your domain automatically. Tags made in the demo point to localhost and must be re-copied.
