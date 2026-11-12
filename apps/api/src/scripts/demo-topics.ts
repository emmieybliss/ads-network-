import type { Pool, PoolClient } from 'pg';
import { classifyPage } from '@blissnova/ad-decision';
import { aggregateDay } from '../services/events';
import { writePageContext } from '../services/page-context';

/**
 * Page topics for the demo website. The demo site's articles are each on a
 * different topic; these are their titles, descriptions and opening text, run
 * through the real classifier so sample history has topics before anyone has
 * visited. A live visit classifies the full page again once its text differs.
 */
export const DEMO_PAGES: Array<{ path: string; title: string; description: string; text: string; weight: number }> = [
  { path: '/', title: 'Five small habits for a calmer workday', description: 'How the BlissNova ad tag works on a page, with small habits for a calmer workday.', weight: 3,
    text: 'This page exists so you can watch the BlissNova ad tag work end to end. A leaderboard placement requests an image ad and an in-article placement requests a native ad. Healthy habits, short breaks and a calm routine.' },
  { path: '/calmer-workday', title: 'Five small habits for a calmer workday', description: 'How the BlissNova ad tag works on a page, with small habits for a calmer workday.', weight: 2,
    text: 'This page exists so you can watch the BlissNova ad tag work end to end. A leaderboard placement requests an image ad and an in-article placement requests a native ad. Healthy habits, short breaks and a calm routine.' },
  { path: '/houseplants-guide', title: 'A beginner\'s guide to keeping houseplants alive', description: 'Light, water, pots and soil: simple care for indoor plants.', weight: 2,
    text: 'Most houseplants that struggle indoors are short of light or get too much water. Water when the top of the soil is dry. Pots without drainage holes cause trouble. Repot when roots circle the pot.' },
  { path: '/lisbon-weekend', title: 'A weekend in Lisbon on a small budget', description: 'Travel guide: where to stay, what to see and how to get around Lisbon for less.', weight: 2,
    text: 'Lisbon is one of the easiest European cities for a short trip. Flights take under three hours and the airport is close to the centre. Stay in a guesthouse or hostel, buy a transport card for the tram and metro, and visit the viewpoints and Belém.' },
  { path: '/index-funds-explained', title: 'Index funds explained in plain words', description: 'Personal finance: what index funds are, what they cost and how people use them to invest for retirement.', weight: 2,
    text: 'An index fund buys every stock in a market index. Fees are low and the expense ratio matters over decades of retirement savings. Build an emergency fund and pay off credit card debt before you invest.' },
  { path: '/weeknight-pasta', title: 'A 20-minute weeknight tomato pasta', description: 'Recipe: a quick tomato and garlic pasta dinner from pantry ingredients.', weight: 2,
    text: 'This recipe turns tinned tomatoes, garlic and pasta into dinner in twenty minutes. Cook the spaghetti, simmer the sauce with olive oil and chilli, toss with basil and serve with cheese.' },
];

/** Classify the demo pages and store the results (an existing page is left as it is). */
async function storeDemoPages(db: Pool | PoolClient, siteId: string) {
  for (const p of DEMO_PAGES) {
    const c = classifyPage({ title: p.title, description: p.description, text: p.text, path: p.path, lang: 'en' });
    const exists = (await db.query('SELECT 1 FROM page_contexts WHERE site_id = $1 AND page_path = $2', [siteId, p.path])).rowCount;
    if (exists) continue;
    await writePageContext(db as Pool, { siteId, path: p.path, title: p.title, lang: 'en', topics: c.topics, primary: c.primary, safety: c.safety, flags: c.flags, terms: c.terms, hash: c.hash, version: c.version, enoughText: c.enoughText });
  }
}

/** Sets each sample 'served' event's topic from its page. */
async function tagSampleEvents(db: Pool | PoolClient, siteId: string) {
  await db.query(
    `UPDATE ad_events e SET topic = COALESCE(pc.override_topics[1], pc.primary_topic), brand_safety = COALESCE(pc.override_safety, pc.brand_safety)
     FROM page_contexts pc
     WHERE e.site_id = $1 AND pc.site_id = e.site_id AND pc.page_path = e.page_path AND e.type = 'served' AND e.client_event_id LIKE 'demo-sample:%'`, [siteId]);
}

/** For a fresh seed: classify the demo pages and tag the sample events (aggregation runs after). */
export async function seedDemoTopics(c: PoolClient, siteId: string) {
  await storeDemoPages(c, siteId);
  await tagSampleEvents(c, siteId);
}

/**
 * Upgrades demo data seeded before page topics existed, once: spreads the
 * sample in-page deliveries over all demo articles (so several topics show),
 * rebuilds the sample page views, classifies the demo pages, tags the sample
 * events and re-aggregates the sample days. Touches only rows labelled
 * "demo-sample:" and the demo website. Returns the number of days re-aggregated.
 */
export async function upgradeDemoTopics(db: Pool, siteDomain: string, onStart?: () => void): Promise<number> {
  const site = (await db.query<{ id: string }>('SELECT id FROM sites WHERE domain = $1', [siteDomain])).rows[0];
  if (!site) return 0;
  const done = (await db.query('SELECT 1 FROM page_contexts WHERE site_id = $1 LIMIT 1', [site.id])).rowCount;
  const samples = (await db.query(`SELECT 1 FROM ad_events WHERE site_id = $1 AND client_event_id LIKE 'demo-sample:%' LIMIT 1`, [site.id])).rowCount;
  if (done || !samples) return 0;
  onStart?.();
  const client = await db.connect();
  let days: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '10min'`);
    // In-page placements only: pop placements live on their own test page.
    const pages = DEMO_PAGES.flatMap((p) => Array<string>(p.weight).fill(p.path));
    await client.query(
      `CREATE TEMP TABLE demo_page ON COMMIT DROP AS
       SELECT d.delivery_id, ($2::text[])[1 + floor(random() * cardinality($2::text[]))::int] AS path
       FROM (SELECT DISTINCT e.delivery_id FROM ad_events e JOIN ad_units u ON u.id = e.unit_id
             WHERE e.site_id = $1 AND e.client_event_id LIKE 'demo-sample:%' AND e.type = 'served' AND u.display NOT IN ('popup', 'popunder')) d`, [site.id, pages]);
    await client.query('CREATE INDEX ON demo_page (delivery_id)');
    await client.query(`UPDATE ad_events e SET page_path = p.path FROM demo_page p WHERE e.delivery_id = p.delivery_id AND e.client_event_id LIKE 'demo-sample:%'`);
    await client.query(`UPDATE conversions c SET page_path = p.path FROM demo_page p WHERE c.delivery_id = p.delivery_id`);
    days = (await client.query<{ day: string }>(
      `SELECT DISTINCT to_char(occurred_at, 'YYYY-MM-DD') AS day FROM ad_events WHERE site_id = $1 AND client_event_id LIKE 'demo-sample:%' ORDER BY 1`, [site.id])).rows.map((r) => r.day);
    // Page views for the sample days, as the seed computes them: the most ads one campaign served on the page that day.
    await client.query(`DELETE FROM page_views WHERE site_id = $1 AND day = ANY($2::date[])`, [site.id, days]);
    await client.query(
      `INSERT INTO page_views (day, site_id, page_path, views)
       SELECT day, $1, page_path, max(n) FROM (
         SELECT occurred_at::date AS day, page_path, campaign_id, count(*) AS n FROM ad_events
         WHERE site_id = $1 AND type = 'served' AND page_path IS NOT NULL AND occurred_at::date = ANY($2::date[])
         GROUP BY 1, 2, 3) u
       GROUP BY day, page_path`, [site.id, days]);
    await storeDemoPages(client, site.id);
    await tagSampleEvents(client, site.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  for (const day of days) await aggregateDay(db, day);
  return days.length;
}
