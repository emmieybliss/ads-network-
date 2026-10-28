import type { Pool } from 'pg';
import { aggregateDay } from '../services/events';

/**
 * Sample visitor countries, weighted towards the larger markets. A SQL
 * expression; each evaluation draws one ISO 3166 code ("ZZ" is unknown).
 */
export const DEMO_COUNTRY_SQL = `(ARRAY['US','US','US','US','US','US','US','US','US','GB','GB','GB','IN','IN','IN','CA','CA','DE','DE','AU','AU','NG','NG','PH','PH','BR','BR','FR','MX','ES','IT','NL','ZA','KE','GH','PK','ID','JP','SE','PL','TR','EG','AE','SG','IE','NZ','ZZ'])[1 + floor(random() * 47)::int]`;

/**
 * Upgrades demo data seeded before advanced analytics existed, so a demo that
 * is already installed shows the new views without a reset. It touches only
 * generated sample events (client ids starting with "demo-sample:") and the
 * demo website they belong to, and does nothing once the sample events carry
 * a traffic source. Everything it adds is labelled the same way.
 *
 * Returns the number of days re-aggregated (0 when nothing needed doing).
 */
export async function upgradeDemoAnalytics(db: Pool, onStart?: () => void): Promise<number> {
  const pending = (await db.query(`SELECT 1 FROM ad_events WHERE client_event_id LIKE 'demo-sample:%' AND source = 'unknown' LIMIT 1`)).rowCount;
  if (!pending) return 0;
  onStart?.();
  const client = await db.connect();
  let days: string[] = [];
  try {
    await client.query('BEGIN');
    // A one-off pass over every sample event: allow it more than the usual statement time.
    await client.query(`SET LOCAL statement_timeout = '10min'`);
    // One OS, browser, source and country per delivery, matching its device, shared by all its events.
    await client.query(
      `CREATE TEMP TABLE demo_platform ON COMMIT DROP AS
       WITH d AS (
         SELECT DISTINCT ON (delivery_id) delivery_id, device FROM ad_events WHERE client_event_id LIKE 'demo-sample:%' AND source = 'unknown'
       )
         SELECT delivery_id,
           CASE device
             WHEN 'desktop' THEN (ARRAY['windows|chrome','windows|chrome','windows|edge','macos|chrome','macos|safari','linux|firefox'])[1 + floor(random() * 6)::int]
             WHEN 'mobile' THEN (ARRAY['ios|safari','ios|safari','ios|chrome','android|chrome','android|chrome','android|samsung','android|in_app'])[1 + floor(random() * 7)::int]
             ELSE (ARRAY['ios|safari','android|chrome'])[1 + floor(random() * 2)::int]
           END AS osbr,
           (ARRAY['search','search','search','search','social','social','direct','direct','referral','internal','internal','internal'])[1 + floor(random() * 12)::int] AS src,
           -- A pool of sample visitors, so reach and frequency look like returning readers rather than one view each.
           md5('demo-visitor-' || floor(random() * 20000)::int) AS vis,
           ${DEMO_COUNTRY_SQL} AS country
         FROM d`);
    await client.query('CREATE INDEX ON demo_platform (delivery_id)');
    await client.query('ANALYZE demo_platform');
    await client.query(
      `UPDATE ad_events e SET os = split_part(p.osbr, '|', 1), browser = split_part(p.osbr, '|', 2), source = p.src, visitor_hash = p.vis, country = p.country
       FROM demo_platform p WHERE e.delivery_id = p.delivery_id AND e.client_event_id LIKE 'demo-sample:%'`);
    await client.query('ANALYZE ad_events');
    // Time in view for each valid sample impression.
    await client.query(
      `INSERT INTO ad_events (client_event_id, delivery_id, type, status, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, visitor_hash, ip_hash,
                              country, device, os, browser, source, page_host, page_path, currency, in_view_ms, occurred_at, received_at)
       SELECT 'demo-sample:' || gen_random_uuid(), r.delivery_id, 'inview', 'valid', r.campaign_id, r.creative_id, r.advertiser_org_id, r.site_id, r.unit_id, r.publisher_org_id, r.visitor_hash, r.ip_hash,
              r.country, r.device, r.os, r.browser, r.source, r.page_host, r.page_path, r.currency,
              CASE WHEN v.delivery_id IS NOT NULL THEN 1000 + floor(random() * 24000)::int ELSE floor(random() * 900)::int END,
              r.occurred_at + interval '40 seconds', r.occurred_at + interval '40 seconds'
       FROM ad_events r
       LEFT JOIN (SELECT DISTINCT delivery_id FROM ad_events WHERE type = 'viewable' AND client_event_id LIKE 'demo-sample:%') v ON v.delivery_id = r.delivery_id
       WHERE r.client_event_id LIKE 'demo-sample:%' AND r.type = 'render' AND r.status = 'valid'
         AND r.delivery_id NOT IN (SELECT delivery_id FROM ad_events WHERE type = 'inview')`);
    // Sample conversions on about one in ten valid sample clicks.
    await client.query(`UPDATE campaigns SET conversion_tracking = true WHERE id IN (SELECT DISTINCT campaign_id FROM ad_events WHERE client_event_id LIKE 'demo-sample:%')`);
    await client.query(
      `INSERT INTO conversions (delivery_id, event_name, order_ref, value_micros, currency, method, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id,
                                country, device, os, browser, source, page_path, click_at, occurred_at)
       SELECT delivery_id, ev, 'demo-sample:' || gen_random_uuid(), CASE WHEN ev = 'purchase' THEN (15 + floor(random() * 65))::bigint * 1000000 ELSE 0 END, currency,
              CASE WHEN random() < 0.5 THEN 'pixel' ELSE 'postback' END, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id,
              country, device, os, browser, source, page_path, occurred_at, occurred_at + make_interval(mins => 2 + floor(random() * 90)::int)
       FROM (SELECT *, CASE WHEN random() < 0.6 THEN 'purchase' ELSE 'signup' END AS ev FROM ad_events
             WHERE client_event_id LIKE 'demo-sample:%' AND type = 'click' AND status = 'valid' AND random() < 0.1) k
       ON CONFLICT DO NOTHING`);
    // Page views by source, device and country, in the same mix as the served sample ads; entrances start sessions.
    days = (await client.query<{ day: string }>(
      `SELECT DISTINCT to_char(occurred_at, 'YYYY-MM-DD') AS day FROM ad_events WHERE client_event_id LIKE 'demo-sample:%' ORDER BY 1`)).rows.map((r) => r.day);
    await client.query(
      `INSERT INTO site_traffic_daily (day, site_id, source, device, country, pageviews, sessions)
       SELECT day, site_id, source, device, country, pv, CASE WHEN source = 'internal' THEN 0 ELSE pv END FROM (
         SELECT e.occurred_at::date AS day, e.site_id, e.source, e.device, e.country,
                round(v.views * count(*)::numeric / sum(count(*)) OVER (PARTITION BY e.occurred_at::date, e.site_id))::bigint AS pv
         FROM ad_events e
         JOIN (SELECT day, site_id, sum(views) AS views FROM page_views GROUP BY 1, 2) v ON v.day = e.occurred_at::date AND v.site_id = e.site_id
         WHERE e.client_event_id LIKE 'demo-sample:%' AND e.type = 'served'
         GROUP BY 1, 2, 3, 4, 5, v.views) t
       WHERE pv > 0
       ON CONFLICT (day, site_id, source, device, country) DO NOTHING`);
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
