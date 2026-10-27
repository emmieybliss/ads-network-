# BlissNova Ad Network — Implementation Checklist

Status legend: `[x]` done and type-checked, `[~]` partially done, `[ ]` not started.
"Done" here means the code exists and compiles. Items are only marked verified where a
test or command was actually executed — see `docs/STATUS_REPORT.md` for what has been run.

## Platform foundation
- [x] pnpm monorepo (`apps/*`, `packages/*`, `sdk/*`), TS 5.9 strict + `noUncheckedIndexedAccess`
- [x] `packages/shared` — brand (env-driven, no hardcoded domain), money micros, metric
      definitions (CTR = valid clicks / valid impressions × 100), RBAC permission matrix
      (11 platform roles + 3 org roles), status machines, platform settings schema
- [x] `packages/database` — 5 migration pairs (up/down), pool + transaction helper,
      migration runner with advisory lock, CLI (`up`/`down`/`status`)
- [x] `packages/tracking` — delivery token sign/verify (AES-256-GCM key ring), UA
      classification, IP/visitor hashing with rotating daily salt, IVT scoring
- [x] `packages/ad-decision` — pure deterministic decision engine (priority → expected
      value → pacing, hash tiebreak)
- [x] `packages/billing` — double-entry ledger (balanced-transaction constraint trigger,
      append-only entries, idempotency keys), charge/settle/payout/adjustment operations,
      8-check reconciliation
- [ ] `packages/database/src/seed.ts` — demo-only seed, gated behind `SEED_DEMO_DATA`

## API (`apps/api`, Fastify 5)
- [x] Config with zod env validation + production guards
- [x] App: zod schema compiler, OpenAPI/Swagger UI at `/api/docs`, CORS delegator,
      per-bucket rate limiting, maintenance mode, `/health` + `/ready`
- [x] Auth: argon2id, sessions + double-submit CSRF, API keys (`bnk_<prefix>_<secret>`),
      email verification, password reset, lockout, TOTP MFA, step-up re-auth
- [x] RBAC guards: `requireUser` / `requirePlatform` / `requireOrg(perm)` (non-members → 404)
- [x] Orgs, memberships, invitations, API keys
- [x] Advertiser: campaigns (+history, duplicate, lifecycle), assets, creatives + versions
- [x] Publisher: sites (DNS/file/meta verification, SSRF-safe fetch), units, tags,
      earnings, payout profile, payouts, fraud appeals
- [x] Reports + CSV export (formula-injection guarded) + dashboard
- [x] Billing: payments (Stripe REST / manual bank transfer / dev simulated), invoices,
      ledger view, refunds, disputes, idempotent webhook handler
- [x] Serving: `/serve`, `/events`, `/click`, public site status, ad tag + asset static routes
- [x] Admin control center A–L: users, orgs, inventory, campaigns, finance, fraud, platform
- [x] Integrations: WordPress site sync + stats (API-key auth)
- [x] Scripts: `create-admin`, OpenAPI JSON generator
- [ ] Advertiser restriction enforcement (allowed pricing models, max budget) — optional

## Worker (`apps/worker`, BullMQ)
- [x] Queues: events, serve-log, email, maintenance
- [x] Jobs: aggregate refresh, campaign lifecycle, settlement, spend counter sync, budget
      and low-balance alerts, anomaly detection, daily maintenance (flat-rate allocation,
      payment expiry, retention purge, monthly statements)
- [x] Schedulers (minutely / 5-minutely / daily) + heartbeat + graceful shutdown

## Ad tag (`sdk/ad-tag`)
- [ ] Vanilla TS `bn.js`: shadow DOM render, lazy load, viewability (50% / 1s),
      batched `sendBeacon`, consent API, safe collapse on error
- [ ] esbuild bundle to `dist/bn.js`

## Dashboard (`apps/dashboard`, Vite + React)
- [ ] Design tokens, light/dark theme
- [ ] Marketing homepage (no fabricated metrics; pricing + FAQ from API)
- [ ] Auth pages
- [ ] Advertiser portal
- [ ] Publisher portal
- [ ] Admin app
- [ ] Dev checkout page

## WordPress plugin (`wordpress/blissnova-ad-network`)
- [ ] Plugin bootstrap, settings page (nonces + capability checks), server-side API key
- [ ] Placement sync, verification meta tag injection
- [ ] Shortcode `[blissnova_ad slot="…"]`, `blissnova_ad_render()`, Gutenberg block
- [ ] Auto placement, exclusions, consent, stats, diagnostics, disconnect
- [ ] `uninstall.php`, `readme.txt`, `tests/run.php`

## Tests
- [ ] vitest config (test DB, `EVENT_PROCESSING=inline`)
- [ ] Unit: money, metrics, decision engine, IVT, token, permissions, statuses
- [ ] Integration: auth, campaign lifecycle, creative review, serving, events, billing,
      settlement, payouts, admin flows, reports
- [ ] Security: org isolation, CSRF, rate limits, SSRF, escalation, injection
- [ ] Concurrency: budget races, frequency caps, event dedupe, webhook idempotency
- [ ] End-to-end scenario + load test (`tests/load/serve.mjs`)

## Ops & docs
- [ ] `.env.example` (placeholders + localhost defaults)
- [ ] Dockerfiles, `docker-compose.yml` (postgres, redis, mailpit, api, worker, dashboard), nginx
- [ ] `README.md`, `docs/ARCHITECTURE.md` (incl. deviations), operations, deployment,
      security, tracking/viewability limitations, backup/restore, incident process
- [ ] `docs/openapi.json` generated
- [ ] `pnpm audit`
