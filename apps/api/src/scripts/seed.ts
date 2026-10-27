/**
 * Development/demo seed.
 *
 * Creates clearly-labelled fictional organisations, users, sites and campaigns so
 * the portals have something to show locally. It contains no real company,
 * customer, bank or payment-provider data and must never be pointed at a
 * production database.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm db:seed
 *
 * Guards:
 *   - refuses to run when NODE_ENV=production unless SEED_DEMO_DATA=yes
 *   - refuses to run if the database already holds non-demo organisations
 *     (override with SEED_FORCE=yes)
 *   - passwords come from SEED_PASSWORD, or a random one is generated and
 *     printed once; nothing is hardcoded
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createPool, withTransaction } from '@blissnova/database';
import { confirmPayment, reserveCampaignBudget } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { hashPassword, randomToken } from '../lib/crypto';

const DEMO_TAG = '[demo]';
const CURRENCY = 'USD';

function envFlag(name: string) {
  return (process.env[name] ?? '').toLowerCase() === 'yes';
}

function pk() {
  return `pk_${randomBytes(15).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`;
}

async function user(c: PoolClient, email: string, name: string, hash: string) {
  const r = await c.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', now())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email, name, hash],
  );
  return r.rows[0]!.id;
}

async function org(c: PoolClient, name: string, type: 'advertiser' | 'publisher', createdBy: string, extra: { website?: string; revenueShareBps?: number } = {}) {
  const r = await c.query<{ id: string }>(
    `INSERT INTO organizations (name, type, status, website, country, billing_email, currency, revenue_share_bps, created_by)
     VALUES ($1, $2, 'approved', $3, 'US', $4, $5, $6, $7) RETURNING id`,
    [name, type, extra.website ?? null, `billing+${type}@example.com`, CURRENCY, extra.revenueShareBps ?? null, createdBy],
  );
  const id = r.rows[0]!.id;
  await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, createdBy]);
  return id;
}

async function main() {
  if (process.env.NODE_ENV === 'production' && !envFlag('SEED_DEMO_DATA')) {
    console.error('Refusing to seed demo data with NODE_ENV=production. Set SEED_DEMO_DATA=yes only if you really mean it.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const pool = createPool(process.env.DATABASE_URL);
  const existing = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM organizations WHERE name NOT LIKE $1`, [`%${DEMO_TAG}%`]);
  if (existing.rows[0]!.n !== '0' && !envFlag('SEED_FORCE')) {
    console.error(`This database already holds ${existing.rows[0]!.n} non-demo organisation(s). Refusing to seed. Set SEED_FORCE=yes to override.`);
    await pool.end();
    process.exit(1);
  }

  const password = process.env.SEED_PASSWORD ?? `${randomToken(9)}Aa1!`;
  const generated = !process.env.SEED_PASSWORD;
  const hash = await hashPassword(password);
  const system = { type: 'system' as const };

  const out = await withTransaction(pool, async (c) => {
    // --- platform content so the marketing pages are not blank -------------
    await c.query(
      `INSERT INTO content_items (kind, slug, title, body, sort_order, published) VALUES
         ('faq', 'what-is-blissnova', 'What is the BlissNova Ad Network?', 'A multi-publisher advertising network: advertisers run campaigns, publishers place ad units on their sites, and the platform handles delivery, measurement and payouts.', 1, true),
         ('faq', 'how-are-clicks-counted', 'How are impressions and clicks counted?', 'Every delivery is recorded, then filtered for invalid traffic. Only valid events are reported and billed. Click-through rate is valid clicks divided by valid impressions.', 2, true),
         ('faq', 'when-do-publishers-get-paid', 'When do publishers get paid?', 'Earnings move from pending to available after the platform hold period, then can be requested as a payout. Payout methods and schedules are configured by the platform operator.', 3, true),
         ('faq', 'what-do-i-need-to-start', 'What do I need to start?', 'Advertisers need a funded account balance and at least one approved creative. Publishers need a verified site and an ad unit, then paste the JavaScript ad tag into any page; no plugin is needed.', 4, true),
         ('legal', 'terms', 'Terms of service', 'Placeholder. The platform operator must supply their own terms of service before launch.', 1, false),
         ('legal', 'privacy', 'Privacy policy', 'Placeholder. The platform operator must supply their own privacy policy before launch.', 2, false)
       ON CONFLICT (kind, slug) DO NOTHING`,
    );
    const planCount = (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM pricing_plans')).rows[0]!.n;
    if (planCount === '0') await c.query(
      `INSERT INTO pricing_plans (audience, name, summary, price_label, features, cta_label, highlighted, sort_order, published) VALUES
         ('advertiser', 'CPM', 'Pay per thousand valid impressions.', 'From $1.00 CPM', ARRAY['Image and text creatives','Country, device and keyword targeting','Frequency capping','CSV reporting'], 'Start advertising', false, 1, true),
         ('advertiser', 'CPC', 'Pay per valid click.', 'From $0.05 per click', ARRAY['Click-through reporting','Invalid-click filtering','Budget pacing','Creative versioning'], 'Start advertising', true, 2, true),
         ('publisher', 'Revenue share', 'Keep a share of the revenue your inventory earns.', 'Set per publisher', ARRAY['Site verification','Unlimited ad units','JavaScript ad tag for any site','Earnings and payout tracking'], 'Become a publisher', false, 1, true)
       `,
    );

    // Cost-per-click is off by default on a fresh platform; the demo includes a
    // CPC campaign, so turn it on here (an operator decision, not a default).
    await c.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('pricing', jsonb_build_object('cpcEnabled', true), now())
       ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || jsonb_build_object('cpcEnabled', true), updated_at = now()`,
    );

    // --- people -------------------------------------------------------------
    const advUser = await user(c, 'advertiser@example.com', `Avery Advertiser ${DEMO_TAG}`, hash);
    const pubUser = await user(c, 'publisher@example.com', `Parker Publisher ${DEMO_TAG}`, hash);

    const advOrg = await org(c, `Northwind Coffee Roasters ${DEMO_TAG}`, 'advertiser', advUser, { website: 'https://example.com' });
    const pubOrg = await org(c, `Daily Dispatch Media ${DEMO_TAG}`, 'publisher', pubUser, { website: 'https://example.org', revenueShareBps: 7000 });

    // --- publisher inventory ------------------------------------------------
    const siteKey = pk();
    const site = (await c.query<{ id: string }>(
      `INSERT INTO sites (org_id, name, domain, allowed_domains, category, status, public_key, verified_at, approved_at)
       VALUES ($1, $2, 'example.org', ARRAY['example.org','www.example.org','localhost'], 'news', 'approved', $3, now(), now()) RETURNING id`,
      [pubOrg, `Daily Dispatch ${DEMO_TAG}`, siteKey],
    )).rows[0]!.id;

    const units: Array<{ id: string; key: string }> = [];
    for (const u of [
      { key: 'leaderboard_728x90', name: 'Header leaderboard', w: 728, h: 90, pos: 'header' },
      { key: 'sidebar_300x250', name: 'Sidebar rectangle', w: 300, h: 250, pos: 'sidebar' },
      { key: 'in_article_text', name: 'In-article text unit', w: null as number | null, h: null as number | null, pos: 'in_content' },
    ]) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO ad_units (site_id, key, name, formats, width, height, responsive, position, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active') RETURNING id`,
        [site, u.key, u.name, u.w ? ['image'] : ['text'], u.w, u.h, u.w === null, u.pos],
      );
      units.push({ id: r.rows[0]!.id, key: u.key });
    }
    await c.query(
      `INSERT INTO payout_profiles (org_id, method, display_label, currency, updated_by) VALUES ($1, 'bank_transfer', 'Demo bank account (no real details)', $2, $3)
       ON CONFLICT (org_id) DO NOTHING`,
      [pubOrg, CURRENCY, pubUser],
    );

    // --- advertiser funding (a simulated payment, not a real one) -----------
    const payment = (await c.query<{ id: string }>(
      `INSERT INTO payments (id, org_id, provider, idempotency_key, amount_micros, fee_micros, currency, status, refunded_micros, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'dev_simulated', $2, $3, 0, $4, 'pending', 0, $5, now(), now()) RETURNING id`,
      [advOrg, `seed-${randomToken(8)}`, toMicros('2500').toString(), CURRENCY, advUser],
    )).rows[0]!.id;
    await confirmPayment(c, { paymentId: payment, actor: system, feeBps: 0, providerRef: 'seed-demo', note: 'Demo funding, no money moved', invoicePrefix: 'BN' });

    // --- campaigns ----------------------------------------------------------
    const campaigns: Array<{ id: string; name: string }> = [];
    const specs = [
      { name: `Spring blend launch ${DEMO_TAG}`, model: 'cpm', rate: '2.50', lifetime: '600', daily: '50', priority: 7, format: 'image' as const },
      { name: `Subscription offer ${DEMO_TAG}`, model: 'cpc', rate: '0.18', lifetime: '400', daily: '40', priority: 5, format: 'text' as const },
    ];
    for (const s of specs) {
      const camp = (await c.query<{ id: string }>(
        `INSERT INTO campaigns (org_id, name, status, pricing_model, rate_micros, currency, lifetime_budget_micros, daily_budget_micros, timezone, start_at, pacing, priority, submitted_at, approved_at, created_by)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, 'UTC', now() - interval '1 day', 'even', $8, now(), now(), $9) RETURNING id`,
        [advOrg, s.name, s.model, toMicros(s.rate).toString(), CURRENCY, toMicros(s.lifetime).toString(), toMicros(s.daily).toString(), s.priority, advUser],
      )).rows[0]!.id;
      await c.query(`INSERT INTO campaign_targeting (campaign_id, countries, devices) VALUES ($1, ARRAY[]::text[], ARRAY[]::text[])`, [camp]);
      await c.query(`INSERT INTO campaign_caps (campaign_id, scope, max_impressions, window_seconds) VALUES ($1, 'visitor', 3, 86400)`, [camp]);
      await reserveCampaignBudget(c, camp, system);
      campaigns.push({ id: camp, name: s.name });

      if (s.format === 'image') {
        // A 1x1 transparent PNG placeholder: no third-party artwork is bundled.
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
        const sha = randomToken(32);
        const asset = (await c.query<{ id: string }>(
          `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key, created_by)
           VALUES ($1, $2, 'image/png', $3, 728, 90, $4, $5) RETURNING id`,
          [advOrg, sha, png.byteLength, `demo/${sha}.png`, advUser],
        )).rows[0]!.id;
        const cr = (await c.query<{ id: string }>(
          `INSERT INTO creatives (campaign_id, org_id, name, format, status, version, approved_version, asset_id, width, height, destination_url, display_url, alt_text, created_by)
           VALUES ($1, $2, $3, 'image', 'approved', 1, 1, $4, 728, 90, 'https://example.com/spring-blend', 'example.com', 'Demo placeholder banner', $5) RETURNING id`,
          [camp, advOrg, `Leaderboard banner ${DEMO_TAG}`, asset, advUser],
        )).rows[0]!.id;
        await c.query(
          `INSERT INTO creative_versions (creative_id, version, snapshot, created_by) VALUES ($1, 1, $2, $3)`,
          [cr, JSON.stringify({ format: 'image', assetId: asset, storageKey: `demo/${sha}.png`, width: 728, height: 90, destinationUrl: 'https://example.com/spring-blend', displayUrl: 'example.com', altText: 'Demo placeholder banner' }), advUser],
        );
      } else {
        const cr = (await c.query<{ id: string }>(
          `INSERT INTO creatives (campaign_id, org_id, name, format, status, version, approved_version, headline, body, cta, destination_url, display_url, created_by)
           VALUES ($1, $2, $3, 'text', 'approved', 1, 1, 'Fresh coffee, every week', 'A demo text advertisement used for local development only.', 'See the offer', 'https://example.com/subscribe', 'example.com', $4) RETURNING id`,
          [camp, advOrg, `Subscription text ad ${DEMO_TAG}`, advUser],
        )).rows[0]!.id;
        await c.query(
          `INSERT INTO creative_versions (creative_id, version, snapshot, created_by) VALUES ($1, 1, $2, $3)`,
          [cr, JSON.stringify({ format: 'text', headline: 'Fresh coffee, every week', body: 'A demo text advertisement used for local development only.', cta: 'See the offer', destinationUrl: 'https://example.com/subscribe', displayUrl: 'example.com' }), advUser],
        );
      }
    }

    return { siteKey, units, campaigns, advOrg, pubOrg };
  });

  await pool.end();

  console.log(`\nDemo data seeded. Every record is fictional and tagged "${DEMO_TAG}".\n`);
  console.log('  Advertiser login   advertiser@example.com');
  console.log('  Publisher login    publisher@example.com');
  console.log(generated ? `  Password (generated, shown once)  ${password}` : '  Password           (from SEED_PASSWORD)');
  console.log(`\n  Site key           ${out.siteKey}`);
  console.log(`  Ad unit slots      ${out.units.map((u) => u.key).join(', ')}`);
  console.log(`  Campaigns          ${out.campaigns.length} active, budget reserved from a simulated $2,500 funding payment`);
  console.log('\nNo platform administrator is created here. Run: pnpm admin:create --email you@example.com --name "Your Name"\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
