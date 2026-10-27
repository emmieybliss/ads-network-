#!/usr/bin/env node
/**
 * Browser walkthrough of the demo's acceptance flows, run against the Docker
 * demo (scripts/start-demo.sh). It drives the real UI with Playwright:
 *   publisher: register, verify email (via Mailpit), sign in, add a website,
 *              verify it with the development simulator, submit it for review
 *   admin:     approve the website
 *   publisher: create a placement and copy the ad tag
 *   advertiser: create a campaign with a text creative and submit it
 *   admin:     approve the creative and the campaign
 * Screenshots of each step go to ACCEPTANCE_SCREENSHOTS (default ./acceptance-screenshots).
 *
 * Usage:  DEMO_PASSWORD=... node scripts/acceptance-ui.mjs
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const WEB = (process.env.WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const MAILPIT = (process.env.MAILPIT_URL || 'http://localhost:8025').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD;
const OUT = process.env.ACCEPTANCE_SCREENSHOTS || 'acceptance-screenshots';
if (!PASSWORD) { console.error('Set DEMO_PASSWORD (SEED_PASSWORD in .env.demo).'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const run = Date.now().toString(36);
const newPublisher = { email: `walkthrough-${run}@example.com`, password: `Walkthrough-${run}-pw`, org: `Walkthrough Publisher ${run} [demo]` };
const siteDomain = `walkthrough-${run}.localhost`;
let shot = 0;
const step = (m) => console.log(`- ${m}`);
async function snap(page, name) { await page.screenshot({ path: join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`), fullPage: false }); }

async function signIn(browser, email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return page;
}

/** Confirm the step-up dialog if the action asks for it. */
async function confirmStepUp(page, password) {
  const dlg = page.locator('#su-pw');
  if (await dlg.isVisible({ timeout: 2_500 }).catch(() => false)) {
    await dlg.fill(password);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await dlg.waitFor({ state: 'hidden' });
  }
}

async function verificationLink(email) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    const m = list.messages?.[0];
    if (m) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      const link = (msg.Text || msg.HTML || '').match(/https?:\/\/[^\s"<>]+verify-email[^\s"<>]*/);
      if (link) return link[0].replace(/&amp;/g, '&');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no verification email for ${email} arrived in Mailpit`);
}

const browser = await chromium.launch();
try {
  // Publisher registration
  const reg = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await reg.goto(`${WEB}/register`);
  await reg.getByRole('button', { name: 'Monetize a site' }).click();
  await reg.getByLabel('Your name').fill('Walkthrough Publisher');
  await reg.getByLabel('Work email').fill(newPublisher.email);
  await reg.locator('#password').fill(newPublisher.password);
  await reg.locator('#org').fill(newPublisher.org);
  await reg.getByRole('checkbox').check();
  await snap(reg, 'register');
  await reg.getByRole('button', { name: 'Create account' }).click();
  await reg.getByText('Check your email').waitFor();
  step(`registered ${newPublisher.email}`);

  const link = await verificationLink(newPublisher.email);
  await reg.goto(link);
  await reg.getByText(/verified/i).first().waitFor({ timeout: 20_000 });
  await snap(reg, 'email-verified');
  step('verified the email address through the link delivered to Mailpit');

  const pub = await signIn(browser, newPublisher.email, newPublisher.password);
  await pub.waitForLoadState('networkidle');
  await snap(pub, 'publisher-first-sign-in');
  step(`signed in; landed on ${new URL(pub.url()).pathname}`);

  // Add a website and verify it with the development simulator
  await pub.goto(`${WEB}/publisher/sites/new`);
  await pub.getByLabel('Website name').fill(`Walkthrough site ${run}`);
  await pub.getByLabel('Domain').fill(siteDomain);
  await pub.getByRole('button', { name: 'Create and continue' }).click();
  await pub.waitForURL(/\/publisher\/sites\/[0-9a-f-]{36}/);
  const siteUrl = pub.url();
  await pub.getByText('Verify that you own this domain').waitFor();
  await snap(pub, 'site-verification-methods');
  await pub.getByRole('button', { name: 'Simulate verification' }).click();
  await pub.getByText('Simulated verification').first().waitFor();
  step(`added ${siteDomain} and verified it with the development simulator`);

  // Submit for review
  await pub.getByLabel('Main language').fill('en');
  await pub.getByLabel('Main audience country').fill('US');
  await pub.getByLabel('Describe the site').fill('A walkthrough test site used to check the publisher onboarding flow locally.');
  await pub.getByText('I accept the').click();
  await snap(pub, 'site-submit-form');
  await pub.getByRole('button', { name: 'Submit for review' }).click();
  await pub.getByText('Submitted for review').first().waitFor();
  await snap(pub, 'site-submitted');
  step('submitted the site for review');

  // Admin reviews and approves
  const admin = await signIn(browser, 'admin@example.com', PASSWORD);
  await admin.goto(`${WEB}/admin/sites`);
  await admin.getByText(siteDomain).first().click();
  await admin.waitForURL(/\/admin\/sites\/[0-9a-f-]{36}/);
  await admin.getByText('Approval is a human decision').waitFor();
  await admin.getByRole('button', { name: 'Start review' }).click();
  await confirmStepUp(admin, PASSWORD);
  await admin.getByText('Under review').first().waitFor();
  const checklist = admin.locator('div.space-y-2').filter({ has: admin.getByText('Domain control verified') }).getByRole('checkbox');
  for (const box of await checklist.all()) if (!(await box.isChecked())) await box.check();
  await admin.getByLabel('Reason or note to the publisher').fill('Walkthrough approval.');
  await snap(admin, 'admin-site-review');
  await admin.getByRole('button', { name: 'Approve' }).click();
  await confirmStepUp(admin, PASSWORD);
  await admin.getByText('Approved').first().waitFor();
  await snap(admin, 'admin-site-approved');
  step('admin approved the site using the eligibility checklist');

  // Publisher adds a placement and gets the tag
  await pub.goto(siteUrl);
  await pub.getByRole('tab', { name: 'Placements' }).click();
  await pub.getByRole('button', { name: 'Add placement' }).click();
  await pub.getByLabel('Name').fill('Article top');
  await pub.getByLabel('Slot key').fill('article-top');
  await pub.getByRole('button', { name: 'Save' }).click();
  await pub.getByText('article-top').first().waitFor();
  await snap(pub, 'placement-created');
  await pub.getByRole('tab', { name: 'Ad tag' }).click();
  await pub.getByText('Install the ad tag').waitFor();
  const snippet = await pub.locator('pre, code').filter({ hasText: 'data-slot="article-top"' }).first().innerText();
  if (!/data-site-key="pk_/.test(snippet) || !snippet.includes('/sdk/ads.js')) throw new Error('the generated tag is missing the SDK URL or site key');
  await snap(pub, 'ad-tag');
  step('created placement article-top and got its tag: ' + snippet.replace(/\s+/g, ' ').slice(0, 160));

  // Advertiser creates a campaign with a text creative and submits it
  const campaignName = `Walkthrough campaign ${run} [demo]`;
  const adv = await signIn(browser, 'advertiser@example.com', PASSWORD);
  await adv.goto(`${WEB}/advertiser/campaigns/new`);
  await adv.getByLabel('Campaign name').fill(campaignName);
  await adv.locator('#rate').fill('1.50');
  await adv.getByLabel('Lifetime budget').fill('50.00');
  await snap(adv, 'campaign-new');
  await adv.getByRole('button', { name: 'Create draft' }).click();
  await adv.waitForURL(/\/advertiser\/campaigns\/[0-9a-f-]{36}/);
  const campaignUrl = adv.url().split('?')[0];
  await adv.getByRole('button', { name: 'Add creative' }).first().click();
  const dlg = adv.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Walkthrough text ad');
  await dlg.getByLabel('Format').selectOption('text');
  await dlg.getByLabel('Headline').fill('Walkthrough sponsored message');
  await dlg.getByLabel('Body').fill('A text creative created by the local acceptance walkthrough.');
  await dlg.getByLabel('Call to action').fill('Learn more');
  await dlg.getByLabel('Destination URL').fill('https://example.com/walkthrough');
  await snap(adv, 'creative-new');
  await dlg.getByRole('button', { name: 'Add creative' }).click();
  await dlg.waitFor({ state: 'hidden' });
  await adv.getByText('Walkthrough text ad').first().waitFor();
  await adv.getByRole('button', { name: 'Submit for review' }).click();
  await confirmStepUp(adv, PASSWORD);
  await adv.getByText('Pending review').first().waitFor();
  await snap(adv, 'campaign-submitted');
  step(`advertiser created "${campaignName}" with a text creative and submitted it`);

  // Admin approves the creative, then the campaign
  await admin.goto(`${WEB}/admin/creatives`);
  const card = admin.locator('div').filter({ hasText: 'Walkthrough text ad' }).filter({ has: admin.getByRole('button', { name: 'Approve' }) }).last();
  await card.getByRole('button', { name: 'Approve' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await confirmStepUp(admin, PASSWORD);
  await admin.getByRole('dialog').waitFor({ state: 'hidden' });
  await snap(admin, 'admin-creative-approved');
  await admin.goto(`${WEB}/admin/campaigns?q=${encodeURIComponent(`Walkthrough campaign ${run}`)}`);
  await admin.getByText(campaignName).first().click();
  await admin.waitForURL(/\/admin\/campaigns\/[0-9a-f-]{36}/);
  await admin.getByRole('button', { name: 'Approve' }).first().click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await confirmStepUp(admin, PASSWORD);
  await admin.getByText(/^(Active|Scheduled)$/).first().waitFor();
  await snap(admin, 'admin-campaign-approved');
  await adv.goto(campaignUrl);
  await adv.getByText(/^(Active|Scheduled)$/).first().waitFor();
  step('admin approved the creative and the campaign; the advertiser sees it as live');
  console.log('\nAcceptance walkthrough passed.');
} catch (err) {
  console.error(`\nWalkthrough FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
