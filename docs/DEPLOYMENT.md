# Deployment

This guide is for a real deployment. It has **not** been carried out yet: no
server, domain or payment provider is set up. For the local demo, see the
README.

`YOUR_DOMAIN` below is a placeholder. No domain is registered yet. Nothing in the
code assumes one, and every address comes from configuration.

## Shape

The simplest production layout is one hostname behind a reverse proxy:

| Path on `https://YOUR_DOMAIN` | Goes to |
| --- | --- |
| `/api/v1/*`, `/sdk/*`, `/assets/*`, `/api/docs*`, `/sellers.json`, `/health`, `/ready` | API (port 4000) |
| everything else | web (port 3000) |

The web server proxies the API paths too, so routing everything to the web
container also works. A direct proxy rule for the API is faster for ad traffic.

Services: PostgreSQL 16, Redis 7, `api`, `worker` (at least one), `web`.
Do **not** run `apps/demo-site` in production; it refuses to start there anyway.

## 1. Build images

```bash
docker build --target api    -t blissnova-api .
docker build --target worker -t blissnova-worker .
docker build --target web    -t blissnova-web --build-arg API_INTERNAL_URL=http://api:4000 .
```

`API_INTERNAL_URL` is the address the web container uses to reach the API on
your private network. It is fixed when the image is built. Leave
`NEXT_PUBLIC_DEMO_MODE` unset.

## 2. Configure

Start from `.env.example`. For production:

```
NODE_ENV=production
PUBLIC_SITE_URL=https://YOUR_DOMAIN
PUBLIC_API_URL=https://YOUR_DOMAIN
CORS_ORIGINS=https://YOUR_DOMAIN
ADS_TXT_DOMAIN=YOUR_DOMAIN       # what publishers write in ads.txt; defaults to the PUBLIC_SITE_URL host
TCF_VENDOR_ID=                   # IAB Global Vendor List id, only after registering with IAB Europe; empty = ads under GDPR stay contextual
COOKIE_SECURE=true
TRUST_PROXY=true                 # only when the reverse proxy below is in front
GEO_COUNTRY_HEADER=              # e.g. cf-ipcountry if your CDN sets one
GEOIP_DB_PATH=                   # else a .mmdb country database (DB-IP Lite or GeoLite2), refreshed monthly
EMAIL_PROVIDER=smtp              # with SMTP_* filled in
EVENT_PROCESSING=queue
STORAGE_DIR=/data/storage        # a persistent volume
APP_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)
TRACKING_TOKEN_KEYS=k1:$(openssl rand -base64 32)
```

Keep secrets in your host's secret store or an env file readable only by the
service user. Never commit them, and never put them in `NEXT_PUBLIC_*`
variables: those are visible in the browser.

### Startup safety checks

With `NODE_ENV=production`, the API **refuses to start** and lists every problem if:

- `ENABLE_DEV_PAYMENTS` or `ENABLE_DEV_VERIFICATION_SIMULATOR` is on;
- `VERIFICATION_ALLOW_HTTP` or `VERIFICATION_PRIVATE_HOST_ALLOWLIST` is set;
- `SEED_DEMO_DATA` is on;
- `COOKIE_SECURE` is false;
- `APP_SECRET` or `TRACKING_TOKEN_KEYS` look like placeholders, or `ENCRYPTION_KEY` is all zeros;
- the public URLs are localhost or not https;
- `CORS_ORIGINS` is localhost or `*`;
- `EMAIL_PROVIDER=log`, or `smtp` without a host.

Missing required secrets fail validation before any of these checks. See
`productionProblems()` in `apps/api/src/config.ts`.

## 3. Database

```bash
docker run --rm --env-file prod.env blissnova-api node dist/scripts/migrate.js
docker run --rm -it --env-file prod.env blissnova-api node dist/scripts/create-admin.js --email you@YOUR_DOMAIN --name "Your Name"
```

`create-admin` reads the password from `ADMIN_PASSWORD` or prompts for it. It
never accepts the password on the command line. Do not run the demo seed in
production.

## 4. Run

Run `api`, `worker` and `web` with `restart: unless-stopped`, the env file, and
the storage volume mounted on the API. Each image has a health check:

- API: `GET /ready`, which checks the database and Redis;
- web: `GET /`.

## 5. Reverse proxy (nginx example)

```nginx
server {
  listen 443 ssl http2;
  server_name YOUR_DOMAIN;
  ssl_certificate     /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;
  client_max_body_size 6m;   # creative uploads

  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  location ~ ^/(api/v1|sdk|assets|api/docs|health|ready)(/|$) { proxy_pass http://127.0.0.1:4000; }
  location = /sellers.json { proxy_pass http://127.0.0.1:4000; }
  location / { proxy_pass http://127.0.0.1:3000; }
}
server { listen 80; server_name YOUR_DOMAIN; return 301 https://$host$request_uri; }
```

Set `TRUST_PROXY=true` only when a proxy like this one is in front. Otherwise
visitors could forge `X-Forwarded-For`.

## 6. Payments

No provider is connected. Until one is:

- advertisers fund their accounts by bank transfer;
- finance staff confirm the transfer in Admin, Finance;
- the confirmation is recorded in the ledger with an audit entry.

To use Stripe, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, then point a
Stripe webhook at `https://YOUR_DOMAIN/api/v1/webhooks/payments/stripe`. Test it in Stripe
test mode first. This integration has not been exercised against Stripe. Balances
are credited only by the verified webhook, never by the browser returning from
checkout.

## 7. After going live

- Change the demo placeholders in Admin, Content: legal pages, FAQ and contact details. Use real information only.
- Review Admin, Settings: eligibility rules, invalid-traffic thresholds, frequency caps, revenue share and retention.
- Set up backups (see OPERATIONS.md) and test a restore.
