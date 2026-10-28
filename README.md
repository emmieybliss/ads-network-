# BlissNova Ad Network

A standalone, self-hosted advertising network. Advertisers fund campaigns and
upload creatives. Publishers verify their websites and paste one script tag. The
platform picks an ad, records impressions and clicks, filters invalid traffic,
bills advertisers and credits publishers through a double-entry ledger.

It is not a WordPress plugin and does not need WordPress. Any website that can
include a `<script>` tag can show ads.

> **No public domain yet.** Every public address comes from environment
> variables. The local demo runs entirely on `localhost` and needs no domain.

## Run the local demo on Windows without Docker (recommended)

This works like the eSIM demo: double-click a file and it opens small windows.
It needs only [Node.js](https://nodejs.org) 20 or newer. No Docker, WSL,
PostgreSQL or Redis.

1. Double-click **Start BlissNova demo.bat** in the project folder. The first
   start installs packages and builds everything, which takes several minutes.
   Later starts take seconds, and it rebuilds by itself after a `git pull`.
2. Three minimized windows open (API, Web, Demo site) and the browser opens
   <http://localhost:3000> and the demo publisher page <http://localhost:3100>.
   The demo logins and the generated password are printed in the start window.
3. Double-click **Stop BlissNova demo.bat** to stop. Your data is kept.

How it works: `apps/api/dist/local.js` starts PostgreSQL from the
`embedded-postgres` package, keeps Redis-style counters in memory, runs the
worker's scheduled jobs on timers, and writes emails as text files. Data,
generated secrets and emails live in `%LOCALAPPDATA%\BlissNova-demo` (outside
OneDrive). Delete that folder to start over with fresh demo data. This runner
refuses to start with `NODE_ENV=production`; it is for the demo only.

On macOS or Linux: `pnpm install && pnpm --filter @blissnova/api build && pnpm demo:local`
starts the API the same way (then run the web app and demo site as below).

## Run the local demo (Docker)

Requirements: Docker Desktop (Windows/macOS) or Docker Engine with Compose v2.

```bash
# macOS / Linux / Git Bash
scripts/start-demo.sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\start-demo.ps1
```

The first run builds the images, which takes a few minutes. It also writes
`.env.demo` with random secrets and a random demo password (the file is
gitignored). When it finishes, it prints:

| What | Where |
| --- | --- |
| Marketing site and dashboards | http://localhost:3000 |
| API (`/ready`, `/health`) | http://localhost:4000 |
| API reference (Swagger UI) | http://localhost:3000/api/docs |
| Demo publisher website | http://localhost:3100 |
| Mailpit (every email the demo sends) | http://localhost:8025 |

Demo logins (password is `SEED_PASSWORD` in `.env.demo`):

- `admin@example.com`: platform super admin
- `advertiser@example.com`: owner of "Demo Advertiser Co [demo]"
- `publisher@example.com`: owner of "Demo Publisher Media [demo]"

The seed creates:

- a verified, approved demo website (`demo-publisher.localhost`, also allowed on `localhost`) with three placements (banner, text and native);
- three active campaigns funded by a **simulated** payment (no money moves);
- 14 days of generated sample statistics.

Everything is labelled `[demo]`, and the dashboards show a demo-data notice.

**Try the whole flow:** open http://localhost:3100. A banner, a text ad and a native ad load
through `/sdk/ads.js`. Click one, wait about a minute (the worker refreshes
reports every minute), then refresh the publisher or advertiser reports. Today's
row goes up. Repeated views from one browser hit frequency caps, and very fast
or repeated clicks are filtered as invalid, as they would be on a live site.

Automated checks against the running demo (need Node 20+ and `pnpm install`):

```bash
npx playwright install chromium     # once
export DEMO_PASSWORD=<SEED_PASSWORD from .env.demo>
pnpm demo:e2e          # banner shows, impression and click recorded, report updates
pnpm demo:acceptance   # registers a publisher, verifies email via Mailpit, adds and
                       # simulates verification of a site, admin approves it, creates
                       # a placement and tag, advertiser submits a campaign, admin approves
```

| Task | Command |
| --- | --- |
| Stop (keeps data) | `scripts/stop-demo.sh` / `scripts\stop-demo.ps1` |
| Wipe and re-seed | `scripts/reset-demo.sh` / `scripts\reset-demo.ps1` |
| Logs | `docker compose --env-file .env.demo logs -f api worker web` |

If something goes wrong, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Run without Docker (development)

Requirements: Node 20+, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env    # then fill in DATABASE_URL, REDIS_URL and the three secrets
# for local work also set: COOKIE_SECURE=false ENABLE_DEV_PAYMENTS=true ENABLE_DEV_VERIFICATION_SIMULATOR=true
pnpm --filter @blissnova/ad-tag build
pnpm db:migrate
SEED_PASSWORD=choose-a-local-password pnpm db:seed
pnpm dev:api        # http://localhost:4000
pnpm dev:worker
pnpm dev:web        # http://localhost:3000
pnpm dev:demo-site  # http://localhost:3100
```

## What is in the repository

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 15: the marketing site plus the publisher, advertiser and admin portals |
| `apps/api` | Fastify 5 REST API: auth, organizations, sites and verification, campaigns, serving, events, billing, reports, admin |
| `apps/worker` | BullMQ worker: event processing, report aggregation, settlement, alerts, retention |
| `apps/demo-site` | A fictional publisher page for local testing (refuses to run in production) |
| `sdk/ad-tag` | The publisher script served at `/sdk/ads.js` |
| `packages/*` | shared (roles, statuses, metrics, settings), database (migrations), tracking (tokens, invalid traffic), ad-decision, billing (ledger) |
| `tests/` | Unit, integration and security tests (Vitest) |
| `docs/` | Architecture, deployment, operations, security, privacy, troubleshooting, OpenAPI |

The publisher snippet:

```html
<script async src="https://YOUR-API-HOST/sdk/ads.js"
        data-site-key="pk_..." data-slot="your-placement"></script>
```

The dashboard generates it from `PUBLIC_API_URL`, so no host is hardcoded.

## Tests

The integration tests need PostgreSQL and Redis. They default to
`postgres://bn:bn@localhost:5432/blissnova_test` and `redis://localhost:6379/1`.
Override them with `TEST_DATABASE_URL` and `TEST_REDIS_URL`.

```bash
pnpm test          # everything
pnpm typecheck
pnpm audit
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data flow, design decisions and deviations
- [Deployment](docs/DEPLOYMENT.md): production setup, secrets, reverse proxy, startup safety checks
- [Operations](docs/OPERATIONS.md): health checks, queues, backups and restore, retention
- [Security](docs/SECURITY.md) and [Privacy](docs/PRIVACY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [OpenAPI](docs/openapi.json): also live at `/api/docs`
- [Implementation checklist](docs/IMPLEMENTATION_CHECKLIST.md)

## Status and honest limits

- Nothing has been deployed to a public server.
- No real payment provider is connected. Stripe (cards) and PayPal (deposits
  and publisher payouts) are written and tested against simulated API
  responses, not against the live services. Until they are configured, funding
  is by bank transfer confirmed by finance staff, and bank and crypto payouts
  are paid by staff and recorded with their reference. The simulated provider
  works only outside production. See docs/PAYMENTS_AND_PAYOUTS.md for the
  accounts and keys needed to go live.
- No GeoIP database is bundled. Country targeting relies on a header from a CDN
  you trust, or reports "ZZ" (unknown).
- No company registration details, addresses, customers, testimonials or
  performance figures are included. Add real ones only when you have them.
