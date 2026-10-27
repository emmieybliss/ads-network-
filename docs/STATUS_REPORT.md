# BlissNova Ad Network: status report

Date: 27 October 2026. Branch `claude/project-thread-3smkp4`, pull request #1 (draft).

Everything below was built and run in the cloud build environment. That is a
Linux container with Docker, PostgreSQL 16 and Redis 7. It was **not** run on
your PC. Nothing has been deployed to a public server, and no real payment
provider is connected.

## 1. Project folder

- **Repository:** `emmieybliss/ads-network-` on GitHub, branch `claude/project-thread-3smkp4`.
- **On your PC:** the target is a `BlissNova-AdNetwork` folder in the folder Claude
  Code was launched from. That copy is created only after you approve the
  setup on your device. Until then, no project exists on your PC.

## 2. Applications and services

| Service | What it is |
| --- | --- |
| `web` (Next.js 15) | marketing site, publisher, advertiser and admin portals |
| `api` (Fastify 5) | REST API under `/api/v1`, ad serving, events, click redirect, the `/sdk/ads.js` tag, OpenAPI at `/api/docs` |
| `worker` (BullMQ) | event processing, report aggregation every minute, settlement, alerts, retention |
| `demo-site` | fictional publisher page for local testing (refuses production) |
| `setup` | one-shot: migrations and demo seed |
| PostgreSQL 16, Redis 7, Mailpit | database, cache and queues, local email inbox |

## 3. Local URLs

| What | URL |
| --- | --- |
| Website and dashboards | http://localhost:3000 |
| API health | http://localhost:4000/ready |
| API reference | http://localhost:3000/api/docs |
| Demo publisher website | http://localhost:3100 |
| Mailpit (demo emails) | http://localhost:8025 |

## 4. Start and stop

Windows PowerShell, from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-demo.ps1   # start (first run builds images)
powershell -ExecutionPolicy Bypass -File scripts\stop-demo.ps1    # stop, keep data
powershell -ExecutionPolicy Bypass -File scripts\reset-demo.ps1   # wipe and re-seed
```

macOS, Linux or Git Bash: `scripts/start-demo.sh`, `scripts/stop-demo.sh` and `scripts/reset-demo.sh`.

## 5. Demo accounts (development only)

| Account | Email |
| --- | --- |
| Super admin | `admin@example.com` |
| Advertiser owner ("Demo Advertiser Co [demo]") | `advertiser@example.com` |
| Publisher owner ("Demo Publisher Media [demo]") | `publisher@example.com` |

- **Password:** the first start generates a random password. It is printed by the start script and stored as `SEED_PASSWORD` in `.env.demo`, which is gitignored. No fixed password is committed.
- **Seed refusals:** the seed refuses to run in production, and refuses to run on a database with non-demo organizations.

## 6. Features implemented and verified

All of the following were exercised in a real browser (Playwright) against the
Docker Compose stack.

**Ad flow (`scripts/e2e-demo.mjs`)**
- A headless browser is filtered as a crawler and gets no ad.
- The banner renders on the demo site.
- Valid impressions are recorded: 0 → 2.
- A click goes through `/api/v1/click` with a 302 redirect.
- The publisher report updates: valid clicks 0 → 1.

**UI walkthrough (`scripts/acceptance-ui.mjs`)**
1. Publisher registers.
2. The verification email is caught by Mailpit and the link verifies the account.
3. The publisher signs in and adds a website.
4. The development simulator verifies the site.
5. The publisher submits the site for review.
6. The admin starts the review, ticks the eligibility checklist and approves.
7. The publisher creates a placement and gets its tag (`/sdk/ads.js` with `data-site-key` and `data-slot`).
8. The advertiser creates a CPM campaign with a text creative and submits it.
9. The admin approves the creative and the campaign.

**Other checks**
- Seed: all nine ledger reconciliation checks pass.
- API and worker production bundles start and pass `/ready`.

**Built in the UI but not each clicked through**
- Finance: payments, refunds, disputes, adjustments, reconciliation and export.
- Payouts.
- Fraud cases with exclusions.
- Settings.
- Audit log.
- Content.
- System health.
- Security.
- API keys.
- MFA.

## 7. Tests executed

| Command | Result |
| --- | --- |
| `pnpm test` (Vitest: unit, integration, security) | 19 files, **385 of 385 passed** |
| `pnpm -r typecheck` | no errors |
| `next build` (web) | succeeded |
| `pnpm audit --prod` | 26 advisories found, fixed by upgrading nodemailer and @fastify/swagger-ui and overriding postcss; now **no known vulnerabilities** |
| `scripts/e2e-demo.mjs` | passed (plain processes and Docker) |
| `scripts/acceptance-ui.mjs` | passed (Docker) |

The tests cover:
- the simulator does not exist in production, even when forced on;
- startup refuses unsafe production configuration;
- SSRF and redirect checks;
- token expiry;
- organization isolation;
- ledger integrity;
- payment idempotency;
- budget races;
- frequency caps;
- event deduplication.

## 8. Outstanding issues and unfinished work

- **Not run on your PC yet.** Docker image builds were tested in Linux, and the PowerShell scripts have not been run on Windows.
- **Stripe:** the integration is written but has never been run against Stripe.
- **No GeoIP database.** Country targeting needs a CDN header.
- **Reports refresh every minute**, not instantly.
- **Organization approval is separate from site approval.** A new publisher's organization shows "Organization pending" until an admin approves it. Site serving does not wait for this; confirm that this is the policy you want.
- **No third-party security review** has been done.
- **Placeholder content.** Legal pages and FAQ in Admin, Content are placeholders, and need your real company details.

## 9. External credentials and services needed for production

- A domain name and TLS certificate, for example from Let's Encrypt.
- A server or hosting for PostgreSQL 16, Redis 7 and the containers, plus backups.
- An SMTP provider, for verification and reset emails.
- A payment provider account if you want card payments (Stripe is supported): `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Without one, funding is by bank transfer confirmed by finance staff.
- Optionally, a CDN that supplies a country header.
- Your real company details, legal pages, support email and payout process.

## 10. Choosing a domain and deploying later

1. Register a domain you control. Nothing in the code assumes a particular name.
2. Point an `A`/`AAAA` record at your server and obtain a TLS certificate.
3. Follow `docs/DEPLOYMENT.md`:
   - build the images;
   - set `PUBLIC_SITE_URL`, `PUBLIC_API_URL` and `CORS_ORIGINS` to `https://your-domain`;
   - generate new secrets;
   - configure SMTP;
   - keep both simulators off.
   
   Startup refuses anything unsafe.
4. Run migrations and `create-admin`. Do not run the demo seed.
5. Put nginx (example in DEPLOYMENT.md) in front, and set `TRUST_PROXY=true`.
6. Replace placeholder content, review settings, set up backups, and test a restore.
7. Publisher tags generated after this point use your domain automatically. Tags made in the demo point to localhost and must be re-copied.
