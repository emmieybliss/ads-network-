# Security

## Accounts and sessions

- Passwords are hashed with argon2id. An account locks after five failed logins. Login errors do not say which part was wrong.
- Sessions use opaque random tokens. Only a hash is stored. The cookies are HttpOnly, SameSite=Lax, and Secure in production.
- CSRF uses the double-submit pattern: the `bn_csrf` cookie must be echoed in `x-csrf-token` on every state-changing request.
- TOTP MFA is optional for users.
- Step-up re-authentication (password, plus TOTP if enabled) is required for sensitive actions: money, roles, suspensions, settings and exports.
- API keys (`bnk_<prefix>_<secret>`) are scoped per organization. Only a hash is stored, and the secret is shown once.
- RBAC covers 11 platform roles and 3 organization roles. A non-member gets 404, not 403, so organization ids cannot be probed.

## Input and output

- Every request body, query and parameter is validated with zod schemas.
- SQL is always parameterized.
- CSV exports neutralize formula injection (`=`, `+`, `-`, `@`).
- Creative uploads accept PNG, JPEG, GIF and WEBP only, checked by magic bytes, and are stored content-addressed. SVG and HTML are refused.
- Destination URLs are https or http only, with no embedded credentials, no private hosts and no blocked domains.
- The ad tag never uses `innerHTML` and never runs advertiser JavaScript.
- Domain verification uses an SSRF-safe fetch:
  - https only;
  - DNS is resolved first, and private, loopback, link-local and reserved addresses are refused;
  - redirects are limited and re-checked;
  - responses are capped in size and time.

## Secrets

- `.env.example` contains placeholders only.
- Production startup refuses placeholder or missing secrets, development flags, insecure cookies, localhost URLs and wildcard CORS (see DEPLOYMENT.md).
- Logs redact the authorization header, cookies, CSRF tokens, `set-cookie`, passwords and tokens.
- No secret is ever placed in `NEXT_PUBLIC_*` variables or browser-visible markup.
- Tracking tokens are AES-256-GCM with a key ring (`TRACKING_TOKEN_KEYS`). Add a new key first and remove the old one after a day to rotate without losing in-flight events.

## Abuse and rate limits

- Per-bucket rate limits apply to auth, management, serve, events and webhooks.
- Known crawlers and headless browsers get no ads.
- The invalid-traffic scoring and frequency caps are described in ARCHITECTURE.md.
- Anyone can file an abuse report from `/report-abuse`. Trust and safety staff handle reports in Admin, Support.

## Not done

- No third-party penetration test or audit has been carried out.
- Run `pnpm audit` before every release.

## Reporting a vulnerability

Until a security contact is published, report vulnerabilities privately to the
repository owner. Do not open a public issue.
