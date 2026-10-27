#!/usr/bin/env node
/**
 * End-to-end check of the local demo, run against a stack that is already up
 * (scripts/start-demo.sh or docker compose):
 *
 *   1. the demo publisher page shows a banner served by the ad SDK,
 *   2. the impression is recorded,
 *   3. a click on the banner is tracked (the redirect to the advertiser's page
 *      is intercepted, so nothing leaves the machine),
 *   4. the publisher dashboard's numbers for today go up.
 *
 * Usage:  DEMO_PASSWORD=... node scripts/e2e-demo.mjs
 * Env:    WEB_URL (http://localhost:3000), DEMO_SITE_URL (http://localhost:3100),
 *         DEMO_PUBLISHER_EMAIL (publisher@example.com), DEMO_PASSWORD (required),
 *         E2E_SCREENSHOTS (directory, optional)
 *
 * Uses Playwright's Chromium. Exits non-zero on the first failed step.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = (process.env.WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const SITE = (process.env.DEMO_SITE_URL || 'http://localhost:3100').replace(/\/$/, '');
const EMAIL = process.env.DEMO_PUBLISHER_EMAIL || 'publisher@example.com';
const PASSWORD = process.env.DEMO_PASSWORD;
const SHOTS = process.env.E2E_SCREENSHOTS;
if (!PASSWORD) {
  console.error('Set DEMO_PASSWORD to the demo accounts\' password (SEED_PASSWORD in .env.demo).');
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`- ${msg}`);
const fail = (msg) => { throw new Error(msg); };
const today = new Date().toISOString().slice(0, 10);

async function totals(request, orgId) {
  const r = await request.get(`${WEB}/api/v1/orgs/${orgId}/reports?from=${today}&to=${today}&groupBy=day`);
  if (!r.ok()) fail(`report request failed: ${r.status()}`);
  return (await r.json()).data.totals;
}

async function waitFor(fn, what, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const browser = await chromium.launch();
try {
  // Publisher session in the dashboard (first-party cookies on the web origin).
  const dash = await browser.newContext();
  const login = await dash.request.post(`${WEB}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  if (!login.ok()) fail(`login failed: ${login.status()} ${await login.text()}`);
  const me = await (await dash.request.get(`${WEB}/api/v1/auth/me`)).json();
  const org = (me.user ?? me).organizations?.find((o) => o.type === 'publisher');
  if (!org) fail('the demo publisher account has no publisher organization; was the demo seed run?');
  const before = await totals(dash.request, org.id);
  step(`signed in as ${EMAIL}; today so far: ${before.validImpressions} valid impressions, ${before.validClicks} valid clicks`);

  // Automated browsers are filtered as invalid traffic: the headless user agent
  // must get no ad. This is the crawler filter working, not a failure.
  const bot = await browser.newPage();
  const botServe = bot.waitForResponse((r) => r.url().includes('/api/v1/serve') && r.request().method() === 'POST');
  await bot.goto(SITE, { waitUntil: 'domcontentloaded' });
  const botStatus = (await (await botServe).json()).status;
  if (botStatus !== 'blocked') fail(`expected the headless browser to be filtered, got status "${botStatus}"`);
  step('headless browser user agent was filtered as a crawler (no ad served)');
  await bot.close();

  // A separate, cookie-less visitor with an ordinary desktop browser user agent
  // opens the demo publisher website.
  const visitor = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });
  const page = await visitor.newPage();
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Advertiser landing page (intercepted by the demo test)</p>' }));
  const served = page.waitForResponse((r) => r.url().includes('/api/v1/serve') && r.request().method() === 'POST');
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  const serveRes = await served;
  if (!serveRes.ok()) fail(`ad request failed: ${serveRes.status()}`);
  // The ad renders in a closed shadow root (publisher CSS cannot hide the
  // "Sponsored" label), so the test checks the slot's state, the image request
  // and the slot's rendered size rather than reaching inside it.
  const imageLoaded = page.waitForResponse((r) => r.url().includes('/assets/') && r.ok() && (r.headers()['content-type'] ?? '').startsWith('image/'));
  const banner = page.locator('[data-bn-slot="demo-leaderboard"][data-bn-state="filled"]');
  await banner.waitFor({ state: 'visible', timeout: 15_000 });
  await imageLoaded;
  const box = await waitFor(async () => { const b = await banner.boundingBox(); return b && b.height >= 60 ? b : null; }, 'the banner to take its size');
  step(`banner rendered on the demo publisher page (${Math.round(box.width)}x${Math.round(box.height)} px)`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '1-demo-site.png') });

  const afterImp = await waitFor(async () => {
    const t = await totals(dash.request, org.id);
    return t.validImpressions > before.validImpressions ? t : null;
  }, 'the impression to reach the dashboard (the worker refreshes reports every minute)', 150_000);
  step(`impression recorded: valid impressions ${before.validImpressions} -> ${afterImp.validImpressions}`);

  // Give the visitor a human-like pause before clicking.
  await sleep(2_500);
  // The ad opens in a new tab, so watch responses across the whole visitor context.
  const clickRes = visitor.waitForEvent('response', { predicate: (r) => r.url().includes('/api/v1/click'), timeout: 15_000 });
  await banner.scrollIntoViewIfNeeded();
  const b = await banner.boundingBox();
  await page.mouse.click(b.x + Math.min(b.width, 728) / 2, b.y + b.height / 2);
  const cr = await clickRes;
  if (cr.status() !== 302) fail(`click redirect returned ${cr.status()}`);
  step(`click tracked: redirected to ${cr.headers().location}`);

  const afterClick = await waitFor(async () => {
    const t = await totals(dash.request, org.id);
    return t.validClicks > before.validClicks ? t : null;
  }, 'the click to reach the dashboard (the worker refreshes reports every minute)', 150_000);
  step(`dashboard updated: valid clicks ${before.validClicks} -> ${afterClick.validClicks}, CTR ${afterClick.ctr}%`);

  // The same numbers on the publisher's report page in the dashboard.
  const ui = await dash.newPage();
  await ui.goto(`${WEB}/publisher/reports`, { waitUntil: 'networkidle' });
  await ui.getByText('Valid impressions').first().waitFor({ timeout: 15_000 });
  if (SHOTS) await ui.screenshot({ path: join(SHOTS, '2-publisher-reports.png'), fullPage: true });
  step('publisher reports page loaded in the dashboard');
  console.log('\nDemo end-to-end check passed.');
} catch (err) {
  console.error(`\nDemo end-to-end check FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
