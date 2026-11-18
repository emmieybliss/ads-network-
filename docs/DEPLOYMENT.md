# Deployment

A step-by-step guide to putting BlissNova on the internet on one server. It
has **not** been carried out yet: no server, domain or payment account
exists. Everything here was checked locally: the production compose file
validates, and the API starts and passes all production safety checks with
the settings from `deploy/prod.env.example`.

For the local demo on your PC, see the README.

## What you need (and what it costs)

| Item | Recommendation | Why | Rough cost |
| --- | --- | --- | --- |
| Domain | A `.com` at **Cloudflare Registrar** | Sold at cost with no markup on renewal, and the DNS, free HTTPS proxy, DDoS protection and visitor-country header come with it | about $10–11 a year |
| Server | One Linux VPS with **4 GB RAM, 2 vCPU, 40 GB+ disk**, Ubuntu 24.04. Hetzner (cheapest, Europe) or DigitalOcean (London or Frankfurt region; easiest card sign-up from Nigeria) | Runs everything below in Docker | about $5–25 a month depending on provider; check the current price |
| Outgoing email | **Brevo** SMTP relay | Free tier covers launch volume (about 300 emails a day), works with any SMTP app, simple domain verification | free to start |
| Incoming email | **Cloudflare Email Routing** | Forwards `support@yourdomain` to your Gmail for free | free |
| Card payments | **Paystack** (see PAYMENTS_AND_PAYOUTS.md) | Stripe does not onboard businesses registered in Nigeria; Paystack does, and can take USD | per-transaction fee only |
| Backups | The server provider's snapshot add-on, plus a daily database dump copied off the server | Ad network money records must survive a dead server | about 20% of the server price |

A small server is plenty for launch traffic. When ad requests grow, move
PostgreSQL to a managed database first, then add API containers.

**Accounts only you can create** (they need your identity, card or business
documents): Cloudflare, the server provider, Brevo, Paystack (or Stripe),
and a PayPal business account if you want PayPal.

## Shape

```
visitor ─ Cloudflare (DNS + proxy) ─ Caddy :443 ─┬─ /api/v1, /sdk, /assets, /sellers.json ─ api :4000 ─┬─ PostgreSQL
                                                  └─ everything else ─────────────────────── web :3000   └─ Redis ─ worker
```

All of it runs from `deploy/docker-compose.prod.yml`. Caddy gets the HTTPS
certificate by itself. Only ports 80 and 443 are open to the internet.

## Step 1. Domain and DNS (Cloudflare)

1. Create a Cloudflare account, then **Domain Registration → Register
   Domains** and buy the domain. It is added to your Cloudflare DNS
   automatically.
2. After step 2 gives you the server's IP address, add two DNS records,
   at first as **DNS only** (grey cloud):
   - `A`, name `@`, value = server IPv4
   - `A`, name `www`, value = server IPv4
3. **SSL/TLS → Overview**: set the mode to **Full (strict)**. Leave
   *Always Use HTTPS* off; Caddy already redirects, and the setting can block
   certificate renewal.
4. Once step 5 shows the site on `https://`, switch both records to
   **Proxied** (orange cloud). Keep `GEO_COUNTRY_HEADER=cf-ipcountry` in
   `prod.env`: Cloudflare then tells the platform each visitor's country.
   `deploy/Caddyfile` trusts Cloudflare's address ranges to name the real
   visitor IP, so invalid-traffic checks and frequency caps see visitors,
   not Cloudflare.

## Step 2. Server

1. Create the VPS (Ubuntu 24.04, 4 GB RAM). Add your SSH key while creating
   it, so you never log in with a password.
2. Log in and install Docker and a firewall:

   ```bash
   ssh root@SERVER_IP
   apt update && apt -y upgrade
   curl -fsSL https://get.docker.com | sh
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
   adduser --disabled-password --gecos "" blissnova && usermod -aG docker blissnova
   ```

3. Get the code:

   ```bash
   su - blissnova
   git clone https://github.com/emmieybliss/ads-network-.git ~/app
   cd ~/app
   ```

   The repository is private: create a read-only **deploy key** (GitHub →
   repository Settings → Deploy keys) or a fine-grained token with read
   access, and clone with it.

## Step 3. Email (Brevo)

1. Create a Brevo account. **Senders, Domains & Dedicated IPs → Domains →
   Add a domain**, enter your domain, and add the DNS records Brevo shows
   (DKIM and the Brevo code) in Cloudflare as **DNS only** (grey cloud).
2. Add a DMARC record in Cloudflare: `TXT`, name `_dmarc`,
   value `v=DMARC1; p=none; rua=mailto:you@yourdomain`.
3. **SMTP & API → SMTP**: copy the login and create an SMTP key. These are
   `SMTP_USER` and `SMTP_PASS`.
4. In Cloudflare, **Email → Email Routing**: forward `support@` (and any
   other address you publish) to your Gmail.
5. After launch, set the sender name and address (for example
   `no-reply@yourdomain`) in **Admin → Settings → Email**.

## Step 4. Settings file

```bash
cp deploy/prod.env.example deploy/prod.env
chmod 600 deploy/prod.env
sh deploy/gen-secrets.sh        # prints the five secret lines
nano deploy/prod.env            # paste them, then replace every CHANGE
```

Fill in: `SITE_DOMAIN`, `ACME_EMAIL`, the three `https://` addresses (all the
same domain), the secrets, `SMTP_USER` and `SMTP_PASS`, and the payment keys
you have. Leave payment keys empty until the account is live; deposits then
work by bank transfer.

`deploy/prod.env` is git-ignored. Keep a copy in a password manager: losing
`ENCRYPTION_KEY` makes saved payout details and two-factor secrets
unreadable.

### Startup safety checks

With `NODE_ENV=production`, the API **refuses to start** and lists every problem if:

- `ENABLE_DEV_PAYMENTS`, `ENABLE_DEV_VERIFICATION_SIMULATOR` or `ENABLE_DEV_PARTNER_SIMULATOR` is on;
- `VERIFICATION_ALLOW_HTTP` or `VERIFICATION_PRIVATE_HOST_ALLOWLIST` is set;
- `SEED_DEMO_DATA` is on, or `COOKIE_SECURE` is false;
- `APP_SECRET` or `TRACKING_TOKEN_KEYS` look like placeholders, or `ENCRYPTION_KEY` is all zeros;
- the public URLs are localhost or not https, or `CORS_ORIGINS` is localhost or `*`;
- `EMAIL_PROVIDER` is `log` or `file`, or `smtp` without a host;
- a payment key is a test key (`sk_test_`), PayPal is in sandbox, a provider is half configured,
  or `STRIPE_API_BASE` / `PAYSTACK_API_BASE` point anywhere but the real provider.

See `productionProblems()` in `apps/api/src/config.ts`.

## Step 5. Start it

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env ps
```

The first build takes several minutes. `migrate` runs the database
migrations and exits; `api`, `worker`, `web` and `caddy` stay up. Check:

```bash
curl -s https://YOUR_DOMAIN/ready      # {"status":"ready","checks":{"database":"ok","redis":"ok"}}
```

If the API exits at once, read its log; it names every unsafe setting:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env logs api
```

## Step 6. First admin account

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env run --rm api \
  node dist/scripts/create-admin.js --email you@YOUR_DOMAIN --name "Your Name"
```

It asks for the password (it never takes one on the command line). Sign in
at `https://YOUR_DOMAIN/login` and turn on two-factor login for the account.
Do not run the demo seed in production.

## Step 7. Payments

Follow PAYMENTS_AND_PAYOUTS.md for each provider. Each needs its webhook URL
set to your domain:

| Provider | Webhook URL |
| --- | --- |
| Paystack | `https://YOUR_DOMAIN/api/v1/webhooks/payments/paystack` |
| Stripe | `https://YOUR_DOMAIN/api/v1/webhooks/payments/stripe` |
| PayPal | `https://YOUR_DOMAIN/api/v1/webhooks/paypal` |

Then in **Admin → Finance → Providers**, press **Test connection** for each,
make one small real deposit, and refund it.

## Step 8. Before you announce it

- Replace the placeholder legal pages, FAQ and company details in **Admin →
  Content**. Use real information only.
- Review **Admin → Settings**: revenue share, minimum deposit, payout
  threshold, invalid-traffic thresholds, frequency caps, retention.
- `https://YOUR_DOMAIN/sellers.json` lists your publishers; check the
  ads.txt line publishers are told to add.
- Set up backups (below) and test a restore once.

## Backups

Daily database dump at 02:30, kept 14 days on the server. Copy them off the
server too (for example with `rclone` to Cloudflare R2 or Google Drive).

```bash
mkdir -p ~/backups
crontab -e
# add:
30 2 * * * cd ~/app && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env exec -T postgres pg_dump -U blissnova -Fc blissnova > ~/backups/blissnova-$(date +\%F).dump && find ~/backups -name '*.dump' -mtime +14 -delete
```

Restore (into an empty database): see OPERATIONS.md. Creative uploads live in
the `storage` volume; the provider's server snapshots cover it.

## Updating

```bash
cd ~/app && git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build
```

Migrations run automatically before the new API starts. Take a database dump
first.

## Without Docker Compose

The same images work on any container host. Build them:

```bash
docker build --target api    -t blissnova-api .
docker build --target worker -t blissnova-worker .
docker build --target web    -t blissnova-web --build-arg API_INTERNAL_URL=http://api:4000 --build-arg NEXT_PUBLIC_SITE_URL=https://YOUR_DOMAIN .
```

Route `/api/v1/*`, `/sdk/*`, `/assets/*`, `/api/docs*`, `/sellers.json`,
`/health` and `/ready` to the API (port 4000) and everything else to web
(port 3000). Set `TRUST_PROXY=true` only when a reverse proxy is in front;
otherwise visitors could forge `X-Forwarded-For`. Never run
`apps/demo-site` in production; it refuses to start there anyway.
