# BlissNova Ad Network: implementation checklist

`[x]` = built and exercised as described in the "verified" notes; `[~]` = built,
partially exercised; `[ ]` = not done. Nothing here claims a production
deployment.

## Platform
- [x] Standalone platform: no WordPress plugin or dependency
- [x] pnpm monorepo: apps (web, api, worker, demo-site), packages (shared, database, tracking, ad-decision, billing), sdk/ad-tag
- [x] Env-driven brand and URLs; no hardcoded domain, no localhost in production output
- [x] 11 platform roles + 3 organization roles (RBAC matrix in `packages/shared`)
- [x] Migrations (up/down) with an advisory-locked runner; bundled `migrate` entry point

## Web (`apps/web`, Next.js 15)
- [x] Marketing site: 16 homepage sections, advertisers, publishers, formats, requirements, pricing, docs, resources, legal, policies, abuse report
- [x] Auth: register, login with MFA, verify email, reset password; step-up modal for sensitive actions
- [x] Publisher portal: sites, verification (DNS/HTML/meta + dev simulator), submission with eligibility checks, placements, tag snippets, reports, earnings and payouts, policy and appeals
- [x] Advertiser portal: campaigns (targeting, budget, schedule, caps), creatives with preview, reports, billing (payments, invoices, ledger, refunds, disputes)
- [x] Admin control center: users, orgs, sites, domains, campaigns, creative review, finance, payouts, pricing, invalid traffic and fraud cases, security, audit, support, settings, content, system health
- [x] Account: team, API keys, organization, security; support tickets
- [x] Demo-data notice; development-only simulated checkout page

## API (`apps/api`, Fastify 5)
- [x] Auth, sessions, CSRF, API keys, MFA, step-up, rate limits, lockout
- [x] Domain verification over an SSRF-safe fetch; development-only simulator refused in production
- [x] Site lifecycle with configurable eligibility rules; verification alone never approves
- [x] Campaigns and creatives with review and versions
- [x] Serving, events and click redirect; invalid-traffic scoring; frequency caps; budget reservation
- [x] Double-entry ledger, payments (bank transfer confirmation, Stripe written but untested against Stripe, simulated dev provider), invoices, refunds, disputes, settlement, payouts, adjustments, reconciliation
- [x] Reports with CSV export (CTR = valid clicks / valid impressions × 100)
- [x] OpenAPI at `/api/docs`; `docs/openapi.json` generated
- [x] Production startup refuses unsafe configuration

## Worker and ad tag
- [x] Worker: aggregation, lifecycle, settlement, alerts, anomaly detection, retention, statements
- [x] Ad tag `/sdk/ads.js` with `data-site-key` / `data-slot`: closed shadow root, lazy load, viewability, sendBeacon, consent API

## Local demo
- [x] Demo seed (admin, advertiser, publisher, verified local site, campaigns, labelled sample statistics); refuses production
- [x] Demo publisher website (`apps/demo-site`, port 3100)
- [x] Dockerfile (api, worker, web, demo-site targets) and `docker-compose.yml` with health checks
- [x] start/stop/reset scripts for bash and PowerShell
- [x] `scripts/e2e-demo.mjs`: banner renders, impression and click recorded, dashboard updates
- [x] `scripts/acceptance-ui.mjs`: browser walkthrough of registration, email verification (Mailpit), site + simulator, admin site approval, placement + tag, campaign + creative submission, admin approvals

## Tests and docs
- [x] Vitest suite: unit, integration and security
- [x] README, ARCHITECTURE, DEPLOYMENT, OPERATIONS, SECURITY, PRIVACY, TROUBLESHOOTING

## Premium tiers and native ads
- [x] Premium tier for advertisers and publishers, set by admins with a reason, step-up and an audit entry
- [x] Per-publisher earnings minimum per 1,000 impressions and per click, as a price floor or a capped network-funded guarantee
- [x] Nightly guarantee top-ups through the ledger, idempotent, held like other earnings, with reconciliation check 9
- [x] Premium-advertisers-only inventory
- [x] Native ad format: creative editor, review, serving, tag rendering with a "Sponsored · sponsor" line, demo placement

## Network parity (see the comparison doc)
- [x] ads.txt line per publisher, on-demand check, status for admins; public sellers.json with confidential option
- [x] IAB TCF v2.2, GPP, US Privacy and GPC consent signals, decided on the server; consent test page on the demo site
- [x] Sticky anchor, side rail and interstitial placements; inline slots reserve their space and can keep it on no fill
- [x] Automatic in-article placement (per-site settings, tag inserts slots between paragraphs)
- [x] Page RPM and per-page earnings reports (page views per page view id, page path on events, Pages tab, CSV export)

## Verified
Runs on 27 Oct 2026, in the build container with local PostgreSQL 16 and Redis 7,
not on the owner's PC:
- `pnpm test`: 21 files, 392 tests passed
- `scripts/e2e-demo.mjs` passed against the bundled processes and against the Docker Compose stack
- `scripts/acceptance-ui.mjs` passed against the Docker Compose stack
- seed: all nine ledger reconciliation checks passed

## Not done
- [ ] Deployment to a public server (no domain yet)
- [ ] Real payment provider connected and tested
- [ ] GeoIP database (country comes from a trusted CDN header, if configured)
- [ ] Third-party security review
