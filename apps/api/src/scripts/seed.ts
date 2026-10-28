/**
 * Local demo seed.
 *
 * Creates a clearly labelled, fictional demo network: one platform admin, one
 * advertiser, one publisher, one verified local demo website with placements,
 * two approved campaigns, and two weeks of generated sample statistics. Every
 * organization and campaign name carries "[demo]" and every generated event
 * carries a "demo-sample:" id, so none of it can be mistaken for real results.
 * It contains no real company, customer, bank or payment-provider data.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm db:seed
 *
 * Guards:
 *   - refuses to run when NODE_ENV=production (there is no override: demo data
 *     never belongs in a production database)
 *   - refuses to run if the database already holds non-demo organizations
 *     (override with SEED_FORCE=yes on a disposable database)
 *   - the password comes from SEED_PASSWORD, or a random one is generated and
 *     printed once; nothing is hardcoded
 *   - set SEED_SAMPLE_DAYS=0 to skip the generated sample statistics
 */
import type { PoolClient } from 'pg';
import { createPool, withTransaction } from '@blissnova/database';
import { confirmPayment, reserveCampaignBudget, settleCampaign } from '@blissnova/billing';
import { payoutLabel, toMicros, type PayoutDetails } from '@blissnova/shared';
import { encryptDestination } from '../services/payouts/service';
import { hashPassword, randomToken } from '../lib/crypto';
import { aggregateDay } from '../services/events';
import { LocalStorage } from '../lib/storage';
import { createHash } from 'node:crypto';
import { demoBannerPng } from './demo-banner';
import { DEMO_COUNTRY_SQL } from './demo-analytics';

const DEMO_TAG = '[demo]';
const CURRENCY = 'USD';
/** Public site key for the demo website. Site keys are public identifiers (they appear in page markup), not secrets. */
export const DEFAULT_DEMO_SITE_KEY = 'pk_DemoLocalPublisherSite01';
/** A reserved name (RFC 6761) that can never belong to a real publisher. */
export const DEMO_SITE_DOMAIN = 'demo-publisher.localhost';

function envFlag(name: string) {
  return (process.env[name] ?? '').toLowerCase() === 'yes';
}

async function user(c: PoolClient, email: string, name: string, hash: string, platformRole: string | null = null) {
  const r = await c.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, status, email_verified_at, platform_role)
     VALUES ($1, $2, $3, 'active', now(), $4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, platform_role = EXCLUDED.platform_role
     RETURNING id`,
    [email, name, hash, platformRole],
  );
  return r.rows[0]!.id;
}

async function org(c: PoolClient, name: string, type: 'advertiser' | 'publisher', createdBy: string, revenueShareBps: number | null = null) {
  const r = await c.query<{ id: string }>(
    `INSERT INTO organizations (name, type, status, country, billing_email, currency, revenue_share_bps, created_by)
     VALUES ($1, $2, 'approved', 'US', $3, $4, $5, $6) RETURNING id`,
    [name, type, `billing+${type}@example.com`, CURRENCY, revenueShareBps, createdBy],
  );
  const id = r.rows[0]!.id;
  await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, createdBy]);
  return id;
}

// Demo-site pages each placement appears on (the demo home page shows the first article).
const SAMPLE_PAGES: Record<string, string[]> = {
  'demo-native': ['/', '/calmer-workday'],
  'demo-auto': ['/houseplants-guide'],
  default: ['/', '/', '/calmer-workday', '/houseplants-guide'],
};

interface SampleSpec { campaignId: string; creativeId: string; unitId: string; pricing: 'cpm' | 'cpc'; rateMicros: bigint; perDay: [number, number]; ctr: number; pages: string[] }

/**
 * Two weeks of generated sample events for the demo campaigns, inserted as
 * event rows and charged exactly as live traffic would be, so reports, budgets,
 * the ledger and reconciliation all agree. Today is left empty so live demo
 * traffic stands out.
 */
async function sampleHistory(c: PoolClient, specs: SampleSpec[], ctx: { siteId: string; advOrg: string; pubOrg: string; shareBps: number }, days: number) {
  const touched: string[] = [];
  for (let back = days; back >= 1; back--) {
    const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    touched.push(day);
    for (const s of specs) {
      const renders = s.perDay[0] + Math.floor(Math.random() * (s.perDay[1] - s.perDay[0]));
      const costPerImp = s.pricing === 'cpm' ? s.rateMicros / 1000n : 0n;
      const costPerClick = s.pricing === 'cpc' ? s.rateMicros : 0n;
      // One row per event; deliveries are synthetic ids. Roughly 3% of renders are marked invalid as the filters would.
      // Traffic follows a daily curve (busier 08:00-22:00 UTC); country, device, OS, browser and source are drawn from fixed sample mixes.
      await c.query(
        `WITH d0 AS (
           SELECT gen_random_uuid() AS delivery,
                  $1::date + make_interval(hours => (ARRAY[0,1,2,3,4,5,6,6,7,7,8,8,8,9,9,9,10,10,10,11,11,11,12,12,12,12,13,13,13,14,14,14,15,15,15,16,16,16,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,22,22,23])[1 + floor(random() * 59)::int],
                                           secs => floor(random() * 3599)::int) AS at,
                  ${DEMO_COUNTRY_SQL} AS country,
                  (ARRAY['desktop|windows|chrome','desktop|windows|chrome','desktop|windows|edge','desktop|macos|chrome','desktop|macos|safari','desktop|linux|firefox',
                         'mobile|ios|safari','mobile|ios|safari','mobile|ios|chrome','mobile|android|chrome','mobile|android|chrome','mobile|android|samsung','mobile|android|in_app',
                         'tablet|ios|safari','tablet|android|chrome'])[1 + floor(random() * 15)::int] AS platform,
                  (ARRAY['search','search','search','search','social','social','direct','direct','referral','internal','internal','internal'])[1 + floor(random() * 12)::int] AS source,
                  random() < 0.03 AS invalid, random() < 0.66 AS viewable, random() < $9::float AS clicked,
                  md5('demo-visitor-' || floor(random() * 20000)::int) AS visitor, ($15::text[])[1 + floor(random() * cardinality($15::text[]))::int] AS page
           FROM generate_series(1, $2::int)
         ), d AS (
           SELECT *, split_part(platform, '|', 1) AS device, split_part(platform, '|', 2) AS os, split_part(platform, '|', 3) AS browser FROM d0
         ), ev AS (
           SELECT delivery, at, country, device, os, browser, source, visitor, page, 'served' AS type, false AS invalid, NULL::int AS in_view FROM d
           UNION ALL SELECT delivery, at + interval '1 second', country, device, os, browser, source, visitor, page, 'render', invalid, NULL FROM d
           UNION ALL SELECT delivery, at + interval '3 seconds', country, device, os, browser, source, visitor, page, 'viewable', false, NULL FROM d WHERE viewable AND NOT invalid
           UNION ALL SELECT delivery, at + interval '20 seconds', country, device, os, browser, source, visitor, page, 'click', false, NULL FROM d WHERE clicked AND NOT invalid
           UNION ALL SELECT delivery, at + interval '40 seconds', country, device, os, browser, source, visitor, page, 'inview', false,
                            CASE WHEN viewable THEN 1000 + floor(random() * 24000)::int ELSE floor(random() * 900)::int END FROM d WHERE NOT invalid
         )
         INSERT INTO ad_events (client_event_id, delivery_id, type, status, invalid_reason, ivt_score, billable, cost_micros, publisher_micros, currency,
                                campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, visitor_hash, ip_hash, country, device, page_host, page_path, occurred_at, received_at,
                                os, browser, source, in_view_ms)
         SELECT 'demo-sample:' || gen_random_uuid(), delivery, type, CASE WHEN invalid THEN 'invalid' ELSE 'valid' END, CASE WHEN invalid THEN 'anomaly_score' END,
                CASE WHEN invalid THEN 75 ELSE 0 END,
                NOT invalid AND ((type = 'render' AND $10::bigint > 0) OR (type = 'click' AND $11::bigint > 0)),
                CASE WHEN invalid THEN 0 WHEN type = 'render' THEN $10::bigint WHEN type = 'click' THEN $11::bigint ELSE 0 END,
                CASE WHEN invalid THEN 0 WHEN type = 'render' THEN $10::bigint * $12::int / 10000 WHEN type = 'click' THEN $11::bigint * $12::int / 10000 ELSE 0 END,
                $13, $3, $4, $5, $6, $7, $8, visitor, md5(visitor), country, device, $14, page, at, at, os, browser, source, in_view
         FROM ev`,
        [day, renders, s.campaignId, s.creativeId, ctx.advOrg, ctx.siteId, s.unitId, ctx.pubOrg, s.ctr, costPerImp.toString(), costPerClick.toString(), ctx.shareBps, CURRENCY, DEMO_SITE_DOMAIN, s.pages],
      );
      await c.query(
        `INSERT INTO campaign_daily_spend (campaign_id, day, spent_micros, impressions, clicks)
         SELECT $1, $2::date, COALESCE(sum(cost_micros), 0), count(*) FILTER (WHERE type = 'render'), count(*) FILTER (WHERE type = 'click')
         FROM ad_events WHERE campaign_id = $1 AND billable AND occurred_at >= $2::date AND occurred_at < $2::date + 1
         ON CONFLICT (campaign_id, day) DO UPDATE SET spent_micros = EXCLUDED.spent_micros, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks`,
        [s.campaignId, day],
      );
    }
    // Sample conversions: about one in ten valid clicks, reported as a purchase with a value or a sign-up.
    await c.query(
      `INSERT INTO conversions (delivery_id, event_name, order_ref, value_micros, currency, method, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id,
                                country, device, os, browser, source, page_path, click_at, occurred_at)
       SELECT delivery_id, ev, 'demo-sample:' || gen_random_uuid(),
              CASE WHEN ev = 'purchase' THEN (15 + floor(random() * 65))::bigint * 1000000 ELSE 0 END, currency, CASE WHEN random() < 0.5 THEN 'pixel' ELSE 'postback' END,
              campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, os, browser, source, page_path, occurred_at,
              occurred_at + make_interval(mins => 2 + floor(random() * 90)::int)
       FROM (SELECT *, CASE WHEN random() < 0.6 THEN 'purchase' ELSE 'signup' END AS ev FROM ad_events
             WHERE site_id = $2 AND type = 'click' AND status = 'valid' AND occurred_at >= $1::date AND occurred_at < $1::date + 1 AND random() < 0.1) k
       ON CONFLICT DO NOTHING`,
      [day, ctx.siteId],
    );
    // Each sample campaign serves at most one ad per page view, so a page's
    // views are the most ads any one campaign served on it that day.
    await c.query(
      `INSERT INTO page_views (day, site_id, page_path, views)
       SELECT $1::date, $2, page_path, max(n) FROM (
         SELECT page_path, campaign_id, count(*) AS n FROM ad_events
         WHERE site_id = $2 AND type = 'served' AND page_path IS NOT NULL AND occurred_at >= $1::date AND occurred_at < $1::date + 1
         GROUP BY page_path, campaign_id) u
       GROUP BY page_path
       ON CONFLICT (day, site_id, page_path) DO UPDATE SET views = EXCLUDED.views`,
      [day, ctx.siteId],
    );
    // The day's page views split by source, device and country in the same mix as the served ads.
    // Each page reached from outside the site starts a session.
    await c.query(
      `INSERT INTO site_traffic_daily (day, site_id, source, device, country, pageviews, sessions)
       SELECT $1::date, $2, source, device, country, pv, CASE WHEN source = 'internal' THEN 0 ELSE pv END FROM (
         SELECT source, device, country, round((SELECT sum(views) FROM page_views WHERE day = $1::date AND site_id = $2) * count(*)::numeric / sum(count(*)) OVER ())::bigint AS pv
         FROM ad_events WHERE site_id = $2 AND type = 'served' AND occurred_at >= $1::date AND occurred_at < $1::date + 1 GROUP BY 1, 2, 3) t
       WHERE pv > 0
       ON CONFLICT (day, site_id, source, device, country) DO UPDATE SET pageviews = EXCLUDED.pageviews, sessions = EXCLUDED.sessions`,
      [day, ctx.siteId],
    );
  }
  for (const s of specs) {
    await c.query(`UPDATE campaigns SET conversion_tracking = true WHERE id = $1`, [s.campaignId]);
    await c.query(
      `UPDATE campaigns SET spent_micros = t.spend, billable_impressions = t.imps, billable_clicks = t.clicks, updated_at = now()
       FROM (SELECT COALESCE(sum(cost_micros), 0) AS spend, count(*) FILTER (WHERE type = 'render') AS imps, count(*) FILTER (WHERE type = 'click') AS clicks
             FROM ad_events WHERE campaign_id = $1 AND billable) t WHERE id = $1`,
      [s.campaignId],
    );
  }
  return touched;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data with NODE_ENV=production. Demo data never belongs in a production database.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const pool = createPool(process.env.DATABASE_URL);
  const existing = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM organizations WHERE name NOT LIKE $1`, [`%${DEMO_TAG}%`]);
  if (existing.rows[0]!.n !== '0' && !envFlag('SEED_FORCE')) {
    console.error(`This database already holds ${existing.rows[0]!.n} non-demo organization(s). Refusing to seed. Use a separate database for the demo.`);
    await pool.end();
    process.exit(1);
  }
  const already = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM organizations WHERE name LIKE $1`, [`%${DEMO_TAG}%`]);
  if (already.rows[0]!.n !== '0') {
    console.log('Demo data is already present. To start over, run the reset-demo script.');
    await pool.end();
    return;
  }

  const password = process.env.SEED_PASSWORD ?? `${randomToken(9)}Aa1!`;
  const generated = !process.env.SEED_PASSWORD;
  const hash = await hashPassword(password);
  const system = { type: 'system' as const };
  const siteKey = process.env.DEMO_SITE_KEY ?? DEFAULT_DEMO_SITE_KEY;
  const sampleDays = Math.max(0, Math.min(60, Number(process.env.SEED_SAMPLE_DAYS ?? 14)));
  const storageDir = process.env.STORAGE_DIR ?? './storage';

  const out = await withTransaction(pool, async (c) => {
    // --- platform content so the public pages are not blank -----------------
    await c.query(
      `INSERT INTO content_items (kind, slug, title, body, sort_order, published) VALUES
         ('faq', 'what-is-blissnova', 'What is the BlissNova Ad Network?', 'A multi-publisher advertising network: advertisers run campaigns, publishers place ad units on their sites, and the platform handles delivery, measurement and payouts.', 1, true),
         ('faq', 'how-are-clicks-counted', 'How are impressions and clicks counted?', 'Every delivery is recorded, then filtered for invalid traffic. Only valid events are reported and billed. Click-through rate is valid clicks divided by valid impressions, multiplied by 100.', 2, true),
         ('faq', 'when-do-publishers-get-paid', 'When do publishers get paid?', 'Earnings move from pending to available after the platform hold period, then can be requested as a payout. Payout methods and schedules are configured by the platform operator.', 3, true),
         ('faq', 'what-do-i-need-to-start', 'What do I need to start?', 'Advertisers need a funded account balance and at least one approved creative. Publishers need a verified and approved site and a placement, then paste the JavaScript ad tag into any page; no plugin is needed.', 4, true),
         ('legal', 'terms', 'Terms of service', 'Placeholder. The platform operator must supply their own terms of service, reviewed by a qualified professional, before launch.', 1, false),
         ('legal', 'privacy', 'Privacy policy', 'Placeholder. The platform operator must supply their own privacy policy, reviewed by a qualified professional, before launch.', 2, false)
       ON CONFLICT (kind, slug) DO NOTHING`,
    );
    const planCount = (await c.query<{ n: string }>('SELECT count(*)::text AS n FROM pricing_plans')).rows[0]!.n;
    if (planCount === '0') await c.query(
      `INSERT INTO pricing_plans (audience, name, summary, price_label, features, cta_label, highlighted, sort_order, published) VALUES
         ('advertiser', 'Cost per thousand impressions', 'Pay for valid impressions only.', 'Rate set per campaign', ARRAY['Image and text creatives','Country, device and keyword targeting','Frequency capping','CSV reporting'], 'Start advertising', false, 1, true),
         ('advertiser', 'Cost per click', 'Pay for valid clicks only.', 'Rate set per campaign', ARRAY['Click-through reporting','Invalid-click filtering','Budget pacing','Creative versioning'], 'Start advertising', true, 2, true),
         ('publisher', 'Revenue share', 'Earn a share of what your approved inventory earns.', 'Share set by the operator', ARRAY['Automatic domain verification','Unlimited placements','JavaScript ad tag for any site','Earnings and payout tracking'], 'Become a publisher', false, 1, true)
       `,
    );
    // The demo includes a cost-per-click campaign, so enable CPC here (an operator decision, not a platform default).
    await c.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('pricing', jsonb_build_object('cpcEnabled', true), now())
       ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || jsonb_build_object('cpcEnabled', true), updated_at = now()`,
    );
    const holdDays = Number((await c.query(`SELECT COALESCE((value->>'earningsHoldDays')::int, 30) AS d FROM platform_settings WHERE key = 'publishers'`)).rows[0]?.d ?? 30);

    // --- people ---------------------------------------------------------------
    const adminUser = await user(c, 'admin@example.com', `Ada Admin ${DEMO_TAG}`, hash, 'super_admin');
    const advUser = await user(c, 'advertiser@example.com', `Avery Advertiser ${DEMO_TAG}`, hash);
    const pubUser = await user(c, 'publisher@example.com', `Parker Publisher ${DEMO_TAG}`, hash);
    const shareBps = 7000;
    const advOrg = await org(c, `Demo Advertiser Co ${DEMO_TAG}`, 'advertiser', advUser);
    const pubOrg = await org(c, `Demo Publisher Media ${DEMO_TAG}`, 'publisher', pubUser, shareBps);

    // --- the local demo website: verified through the development simulator --
    const site = (await c.query<{ id: string }>(
      `INSERT INTO sites (org_id, name, domain, allowed_domains, category, status, public_key, description, language, country,
                          verified_at, verification_method, verification_scope, verification_simulated, policy_version, policy_accepted_at, policy_accepted_by,
                          submitted_at, review_started_at, reviewed_by, approved_at)
       VALUES ($1, $2, $3, ARRAY['localhost'], 'technology', 'approved', $4, 'Local demo website that ships with the platform for testing ad delivery end to end.', 'en', 'US',
               now(), 'simulated', 'host', true, '2026-10', now(), $5, now(), now(), $6, now()) RETURNING id`,
      [pubOrg, `Demo Publisher Site ${DEMO_TAG}`, DEMO_SITE_DOMAIN, siteKey, pubUser, adminUser],
    )).rows[0]!.id;
    await c.query(
      `INSERT INTO site_verification_attempts (site_id, hostname, method, outcome, detail, simulated, actor_user_id)
       VALUES ($1, $2, 'simulated', 'success', 'Development simulator (demo seed). Never valid in production.', true, $3)`,
      [site, DEMO_SITE_DOMAIN, pubUser],
    );
    await c.query(
      `INSERT INTO site_reviews (site_id, reviewer_id, action, from_status, to_status, checklist, reason)
       VALUES ($1, $2, 'approve', 'under_review', 'approved', '{"demo": true}'::jsonb, 'Demo seed: local demo site approved for testing.')`,
      [site, adminUser],
    );

    const unitSpecs = [
      { key: 'demo-leaderboard', name: 'Header leaderboard', w: 728, h: 90, pos: 'header', formats: ['image'] },
      { key: 'demo-sidebar', name: 'Sidebar text unit', w: null as number | null, h: null as number | null, pos: 'sidebar', formats: ['text'] },
      { key: 'demo-native', name: 'In-article native unit', w: null as number | null, h: null as number | null, pos: 'in_content', formats: ['native'] },
      { key: 'demo-anchor', name: 'Sticky bottom anchor', w: 728, h: 90, pos: 'footer', formats: ['image'], display: 'anchor', responsive: true },
      { key: 'demo-rail', name: 'Right side rail', w: 160, h: 600, pos: 'sidebar', formats: ['image'], display: 'rail_right' },
      { key: 'demo-auto', name: 'Automatic in-article ads', w: null as number | null, h: null as number | null, pos: 'in_content', formats: ['native', 'text'] },
      { key: 'demo-interstitial', name: 'Between-pages interstitial', w: null as number | null, h: null as number | null, pos: 'other', formats: ['native'], display: 'interstitial' },
      { key: 'demo-popunder', name: 'Pop-under on first click', w: null as number | null, h: null as number | null, pos: 'other', formats: ['pop'], display: 'popunder' },
    ] as Array<{ key: string; name: string; w: number | null; h: number | null; pos: string; formats: string[]; display?: string; responsive?: boolean }>;
    const units: Record<string, string> = {};
    for (const u of unitSpecs) {
      units[u.key] = (await c.query<{ id: string }>(
        `INSERT INTO ad_units (site_id, key, name, formats, width, height, responsive, position, display, status, pop_max_per_day, pop_minutes_between)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 3, 15) RETURNING id`,
        [site, u.key, u.name, u.formats, u.w, u.h, u.responsive ?? u.w === null, u.pos, u.display ?? 'inline'],
      )).rows[0]!.id;
    }
    // Automatic in-article ads on the demo site (the second demo article uses them).
    await c.query(`UPDATE sites SET auto_ads_enabled = true, auto_ads_unit_id = $2, auto_ads_max = 3, auto_ads_spacing = 3, auto_ads_first_after = 2 WHERE id = $1`, [site, units['demo-auto']]);
    // A fictional PayPal payout address on a reserved domain, encrypted like real details.
    const demoPayout: PayoutDetails = { method: 'paypal', email: 'demo-publisher@example.com' };
    const key = process.env.ENCRYPTION_KEY;
    await c.query(
      `INSERT INTO payout_profiles (org_id, method, display_label, currency, details_encrypted, details_changed_at, updated_by) VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (org_id) DO NOTHING`,
      key ? [pubOrg, 'paypal', `${payoutLabel(demoPayout)} [demo]`, CURRENCY, encryptDestination(key, demoPayout), pubUser] : [pubOrg, 'bank_transfer', 'Demo account (no real details)', CURRENCY, null, pubUser],
    );

    // --- advertiser funding through the simulated provider (no money moves) ----
    const payment = (await c.query<{ id: string }>(
      `INSERT INTO payments (id, org_id, provider, idempotency_key, amount_micros, fee_micros, currency, status, refunded_micros, created_by)
       VALUES (gen_random_uuid(), $1, 'dev_simulated', $2, $3, 0, $4, 'pending', 0, $5) RETURNING id`,
      [advOrg, `seed-${randomToken(8)}`, toMicros('2000').toString(), CURRENCY, advUser],
    )).rows[0]!.id;
    await confirmPayment(c, { paymentId: payment, actor: system, feeBps: 0, providerRef: 'demo-seed', note: 'Simulated demo funding. No money moved.', invoicePrefix: 'DEMO' });

    // --- banner image asset ----------------------------------------------------
    const png = demoBannerPng(728, 90);
    const sha = createHash('sha256').update(png).digest('hex');
    const storageKey = `creatives/${advOrg}/${sha}.png`;
    await new LocalStorage(storageDir, '').put(storageKey, png);
    const asset = (await c.query<{ id: string }>(
      `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key, created_by)
       VALUES ($1, $2, 'image/png', $3, 728, 90, $4, $5)
       ON CONFLICT (storage_key) DO UPDATE SET storage_key = EXCLUDED.storage_key RETURNING id`,
      [advOrg, sha, png.byteLength, storageKey, advUser],
    )).rows[0]!.id;

    const railPng = demoBannerPng(160, 600);
    const railSha = createHash('sha256').update(railPng).digest('hex');
    const railKey = `creatives/${advOrg}/${railSha}.png`;
    await new LocalStorage(storageDir, '').put(railKey, railPng);
    const railAsset = (await c.query<{ id: string }>(
      `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key, created_by)
       VALUES ($1, $2, 'image/png', $3, 160, 600, $4, $5)
       ON CONFLICT (storage_key) DO UPDATE SET storage_key = EXCLUDED.storage_key RETURNING id`,
      [advOrg, railSha, railPng.byteLength, railKey, advUser],
    )).rows[0]!.id;

    const nativePng = demoBannerPng(600, 314);
    const nativeSha = createHash('sha256').update(nativePng).digest('hex');
    const nativeKey = `creatives/${advOrg}/${nativeSha}.png`;
    await new LocalStorage(storageDir, '').put(nativeKey, nativePng);
    const nativeAsset = (await c.query<{ id: string }>(
      `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key, created_by)
       VALUES ($1, $2, 'image/png', $3, 600, 314, $4, $5)
       ON CONFLICT (storage_key) DO UPDATE SET storage_key = EXCLUDED.storage_key RETURNING id`,
      [advOrg, nativeSha, nativePng.byteLength, nativeKey, advUser],
    )).rows[0]!.id;

    // --- campaigns -------------------------------------------------------------
    const campaigns: Array<{ id: string; name: string; creativeId: string; unit: string; pricing: 'cpm' | 'cpc'; rate: bigint; pop?: boolean }> = [];
    const specs = [
      { name: `Banner campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '2.50', lifetime: '400', daily: '40', unit: 'demo-leaderboard', format: 'image' as const },
      { name: `Text ad campaign ${DEMO_TAG}`, model: 'cpc' as const, rate: '0.20', lifetime: '300', daily: '30', unit: 'demo-sidebar', format: 'text' as const },
      { name: `Native ad campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '4.00', lifetime: '200', daily: '20', unit: 'demo-native', format: 'native' as const },
      { name: `Anchor campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '2.00', lifetime: '150', daily: '15', unit: 'demo-anchor', format: 'image' as const },
      { name: `Side rail campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '2.00', lifetime: '150', daily: '15', unit: 'demo-rail', format: 'image' as const, rail: true },
      { name: `In-article native campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '3.00', lifetime: '150', daily: '15', unit: 'demo-auto', format: 'native' as const },
      { name: `In-article text campaign ${DEMO_TAG}`, model: 'cpc' as const, rate: '0.15', lifetime: '150', daily: '15', unit: 'demo-auto', format: 'text' as const },
      { name: `Interstitial campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '5.00', lifetime: '150', daily: '15', unit: 'demo-interstitial', format: 'native' as const },
      { name: `Native CPC campaign ${DEMO_TAG}`, model: 'cpc' as const, rate: '0.40', lifetime: '250', daily: '40', unit: 'demo-native', format: 'native' as const },
      { name: `Pop traffic campaign ${DEMO_TAG}`, model: 'cpm' as const, rate: '1.50', lifetime: '100', daily: '10', unit: 'demo-popunder', format: 'pop' as const },
    ] as Array<{ name: string; model: 'cpm' | 'cpc'; rate: string; lifetime: string; daily: string; unit: string; format: 'image' | 'text' | 'native' | 'pop'; rail?: boolean }>;
    for (const s of specs) {
      const camp = (await c.query<{ id: string }>(
        `INSERT INTO campaigns (org_id, name, status, pricing_model, rate_micros, currency, lifetime_budget_micros, daily_budget_micros, timezone, start_at, pacing, priority, submitted_at, approved_at, created_by)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, 'UTC', now() - make_interval(days => $8), 'even', 5, now(), now(), $9) RETURNING id`,
        [advOrg, s.name, s.model, toMicros(s.rate).toString(), CURRENCY, toMicros(s.lifetime).toString(), toMicros(s.daily).toString(), sampleDays + 1, advUser],
      )).rows[0]!.id;
      await c.query(`INSERT INTO campaign_targeting (campaign_id, countries, devices, include_unit_ids) VALUES ($1, ARRAY[]::text[], ARRAY[]::text[], ARRAY[$2]::uuid[])`, [camp, units[s.unit]]);
      await c.query(`INSERT INTO campaign_history (campaign_id, actor_id, action, after, reason) VALUES ($1, $2, 'admin_approve', '{"status":"active"}'::jsonb, 'Demo seed')`, [camp, adminUser]);
      await reserveCampaignBudget(c, camp, system);

      const dest = 'https://example.com/demo-offer';
      const v = s.format === 'image' && s.rail
        ? { headline: null, body: null, cta: null, asset: railAsset, w: 160, h: 600, alt: 'Demo advertisement skyscraper', sponsor: null, snapshot: { format: 'image', assetId: railAsset, storageKey: railKey, width: 160, height: 600, destinationUrl: dest, displayUrl: 'example.com', altText: 'Demo advertisement skyscraper' } }
        : s.format === 'image'
        ? { headline: null, body: null, cta: null, asset, w: 728, h: 90, alt: 'Demo advertisement banner', sponsor: null, snapshot: { format: 'image', assetId: asset, storageKey, width: 728, height: 90, destinationUrl: dest, displayUrl: 'example.com', altText: 'Demo advertisement banner' } }
        : s.format === 'native'
          ? { headline: 'Demo native advertisement', body: 'A sample native ad served by your local BlissNova demo. It is labelled Sponsored with the advertiser name.', cta: 'Learn more', asset: nativeAsset, w: 600, h: 314, alt: 'Demo native advertisement image', sponsor: `Demo Advertiser Co ${DEMO_TAG}`,
              snapshot: { format: 'native', assetId: nativeAsset, storageKey: nativeKey, width: 600, height: 314, headline: 'Demo native advertisement', body: 'A sample native ad served by your local BlissNova demo. It is labelled Sponsored with the advertiser name.', cta: 'Learn more', sponsorName: `Demo Advertiser Co ${DEMO_TAG}`, destinationUrl: dest, displayUrl: 'example.com', altText: 'Demo native advertisement image' } }
          : s.format === 'pop'
          ? { headline: null, body: null, cta: null, asset: null, w: null, h: null, alt: null, sponsor: null, snapshot: { format: 'pop', destinationUrl: dest } }
          : { headline: 'Demo text advertisement', body: 'A sample text ad served by your local BlissNova demo.', cta: 'Learn more', asset: null, w: null, h: null, alt: null, sponsor: null, snapshot: { format: 'text', headline: 'Demo text advertisement', body: 'A sample text ad served by your local BlissNova demo.', cta: 'Learn more', destinationUrl: dest, displayUrl: 'example.com' } };
      const snapshot = v.snapshot;
      const label = s.format === 'image' ? 'Banner' : s.format === 'native' ? 'Native ad' : s.format === 'pop' ? 'Pop landing page' : 'Text ad';
      const cr = (await c.query<{ id: string }>(
        `INSERT INTO creatives (campaign_id, org_id, name, format, status, version, approved_version, headline, body, cta, asset_id, width, height, destination_url, display_url, alt_text, sponsor_name, created_by)
         VALUES ($1, $2, $3, $4, 'approved', 1, 1, $5, $6, $7, $8, $9, $10, $11, 'example.com', $12, $13, $14) RETURNING id`,
        [camp, advOrg, `${label} ${DEMO_TAG}`, s.format, v.headline, v.body, v.cta, v.asset, v.w, v.h, dest, v.alt, v.sponsor, advUser],
      )).rows[0]!.id;
      await c.query(`INSERT INTO creative_versions (creative_id, version, snapshot, created_by) VALUES ($1, 1, $2, $3)`, [cr, JSON.stringify(snapshot), advUser]);
      campaigns.push({ id: camp, name: s.name, creativeId: cr, unit: s.unit, pricing: s.model, rate: toMicros(s.rate), pop: s.format === 'pop' });
    }

    // --- partner networks ------------------------------------------------------
    // With the development partner simulator on, the native CPC campaign also runs
    // on the simulated partner; the scheduled sync starts it within a minute.
    if (/^(true|1)$/.test(process.env.ENABLE_DEV_PARTNER_SIMULATOR ?? '') && process.env.NODE_ENV !== 'production') {
      await c.query(`UPDATE partner_networks SET enabled = true, updated_at = now() WHERE id = 'simulated'`);
      const nativeCpc = campaigns.find((x) => x.name.startsWith('Native CPC campaign'))!;
      await c.query(`INSERT INTO partner_campaigns (campaign_id, network_id, budget_share_bps, markup_bps, status_reason) SELECT $1, 'simulated', 4000, markup_bps, 'Starts on the partner network once the campaign is live.' FROM partner_networks WHERE id = 'simulated'`, [nativeCpc.id]);
    }

    // --- generated sample statistics ------------------------------------------
    let days: string[] = [];
    if (sampleDays > 0) {
      days = await sampleHistory(c, campaigns.map((x) => ({
        campaignId: x.id, creativeId: x.creativeId, unitId: units[x.unit]!, pricing: x.pricing, rateMicros: x.rate,
        perDay: x.pricing === 'cpm' ? [600, 1400] : [300, 700], ctr: x.pop ? 0 : x.pricing === 'cpm' ? 0.006 : 0.012, pages: SAMPLE_PAGES[x.unit] ?? SAMPLE_PAGES.default!,
      })), { siteId: site, advOrg, pubOrg, shareBps }, sampleDays);
      for (const x of campaigns) await settleCampaign(c, x.id, holdDays);
    }
    return { units: Object.keys(units), campaigns, days };
  });

  for (const day of out.days) await aggregateDay(pool, day);
  await pool.end();

  console.log(`\nDemo data seeded. Every record is fictional and tagged "${DEMO_TAG}".\n`);
  console.log('  Admin login        admin@example.com');
  console.log('  Advertiser login   advertiser@example.com');
  console.log('  Publisher login    publisher@example.com');
  console.log(generated ? `  Password (generated, shown once)  ${password}` : '  Password           (from SEED_PASSWORD)');
  console.log(`\n  Demo website       ${DEMO_SITE_DOMAIN} (also served on localhost), site key ${siteKey}`);
  console.log(`  Placements         ${out.units.join(', ')}`);
  console.log(`  Campaigns          ${out.campaigns.length} active, funded by a simulated payment (no money moved)`);
  console.log(out.days.length ? `  Sample statistics  ${out.days.length} days of generated demo events (ids start with "demo-sample:"), not real traffic\n` : '  Sample statistics  none (SEED_SAMPLE_DAYS=0)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
