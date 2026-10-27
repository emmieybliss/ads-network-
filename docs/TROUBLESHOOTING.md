# Troubleshooting

## The demo will not start

| Symptom | Fix |
| --- | --- |
| "Docker is not installed / not running" | Install or start Docker Desktop, wait until it says it is running, and retry. |
| `port is already allocated` / `address already in use` for 3000, 4000 or 3100 | Another program is using the port. Stop it, or change the left side of `ports:` in `docker-compose.yml` (for example `"3001:3000"`). If you change 4000, also update `PUBLIC_API_URL` and `DEMO_API_URL` to match. |
| `POSTGRES_PASSWORD ... run scripts/start-demo first` | You ran `docker compose` directly. Use the start script, which creates `.env.demo`, or pass `--env-file .env.demo`. |
| `setup` exits with an error | `docker compose --env-file .env.demo logs setup`. Migration or seed errors are printed there. A reset (`scripts/reset-demo.sh`) starts clean. |
| Build fails with certificate errors (`SELF_SIGNED_CERT_IN_CHAIN`) | A corporate proxy is intercepting HTTPS. Configure Docker Desktop's proxy and certificate settings, or build on a network without interception. |
| Windows: script "cannot be loaded because running scripts is disabled" | Run `powershell -ExecutionPolicy Bypass -File scripts\start-demo.ps1`. |

## The no-Docker Windows demo will not start

- **"Node.js is not installed" or "too old"**: install the LTS version from
  <https://nodejs.org>, then close and reopen the window.
- **"Port 3000/4000/3100 is already in use"**: run *Stop BlissNova demo.bat*,
  or close the other program using that port.
- **A window closes or shows an error**: the API, Web and Demo site windows
  stay open on errors; read the last lines there. Running the start file again
  is safe.
- **Start over with fresh demo data**: stop the demo, delete
  `%LOCALAPPDATA%\BlissNova-demo`, and start again. This removes the local
  database, the generated password and saved emails.
- **Build problems after updating**: delete
  `%LOCALAPPDATA%\BlissNova-demo\build-stamp.txt` to force a clean install and
  build on the next start.

## The demo page shows no ads

- **Using an automated or headless browser?** It is filtered as a crawler on
  purpose. Use a normal browser.
- **Ad blocker on?** It may block `/sdk/ads.js`, which is expected.
  Allow `localhost`.
- **Reloaded many times?** Frequency caps limit how often one visitor sees the
  same campaign. Wait, or open a private window.
- **Budget used up?** Check the advertiser dashboard, or run
  `scripts/reset-demo.sh`.
- **Did the page load from a host other than `localhost` or
  `demo-publisher.localhost`?** The demo site only authorizes those hosts.
- **Still nothing?** Open the browser's developer tools, Network tab, and look at
  the `serve` request. Its `status` field explains the result:
  - `blocked`: the host is not authorized, or the browser was taken for a crawler;
  - `inactive`: the site key is unknown or the site is not approved;
  - `disabled`: tracking is turned off in Admin, Settings.

## Numbers do not change after viewing or clicking

Reports update within about a minute: the worker rebuilds today's figures every
minute. Check that the worker is running (`docker compose --env-file .env.demo ps`,
or the Admin overview shows "Worker healthy"). Very fast or repeated clicks
count as invalid traffic and appear under Invalid, not Valid.

## Signing in fails

- Use the password from `SEED_PASSWORD` in `.env.demo`.
- Five wrong attempts lock the account. Reset the demo, or wait for the lock
  to expire.
- Use `http://localhost:3000`, not `127.0.0.1`. Cookies are set for the host you
  use, and the demo expects localhost.

## Production startup says "Refusing to start in production"

This is intended. The message lists each unsafe setting. Fix every item; see
DEPLOYMENT.md. Do not switch `NODE_ENV` away from production to get past it.

## Collecting logs for a bug report

```bash
docker compose --env-file .env.demo logs --since 30m api worker web > logs.txt
```

Logs redact cookies, tokens and passwords, but check the file before you share it.
