import type { Pool } from 'pg';
import { ctr, topicLabel } from '@blissnova/shared';
import type { ReportFilters, ReportScope } from './reports';

/**
 * Reports by page topic. Delivery metrics come from topic_daily_stats (the
 * topic of the page when each ad was served); page views come from
 * page_views joined to each page's current topic. '' is a page without a
 * topic. Brand safety counts pages with views in the period by their
 * current risk level.
 */
export type TopicAudience = 'advertiser' | 'publisher' | 'admin';

/** The topic a page counts under now: a reviewer's first topic, else the detected main topic. */
export const PAGE_TOPIC_SQL = `COALESCE(pc.override_topics[1], pc.primary_topic, '')`;
export const PAGE_SAFETY_SQL = `COALESCE(pc.override_safety, pc.brand_safety, 'unknown')`;

function where(alias: string, scope: ReportScope, f: ReportFilters) {
  const clauses = [`${alias}.day BETWEEN $1::date AND $2::date`];
  const params: unknown[] = [f.from, f.to];
  const add = (col: string, v: unknown) => { params.push(v); clauses.push(`${alias}.${col} = $${params.length}`); };
  if (scope.advertiserOrgId) add('advertiser_org_id', scope.advertiserOrgId);
  if (scope.publisherOrgId) add('publisher_org_id', scope.publisherOrgId);
  if (f.campaignId) add('campaign_id', f.campaignId);
  if (f.siteId) add('site_id', f.siteId);
  return { sql: clauses.join(' AND '), params };
}

export async function topicReport(db: Pool, scope: ReportScope, f: ReportFilters, audience: TopicAudience) {
  const w = where('t', scope, f);
  const money = audience === 'publisher' ? 't.publisher_micros' : 't.spend_micros';
  const delivery = (await db.query(
    `SELECT t.topic, sum(t.valid_impressions)::bigint AS imps, sum(t.viewable_impressions)::bigint AS viewable, sum(t.valid_clicks)::bigint AS clicks, sum(${money})::bigint AS micros
     FROM topic_daily_stats t WHERE ${w.sql} GROUP BY 1`, w.params)).rows;

  // Page views by topic (not for advertisers: page views belong to publishers). Unit filters do not apply.
  const views = new Map<string, number>();
  let safety: Array<{ level: string; pages: number; pageviews: number }> | null = null;
  if (audience !== 'advertiser' && !f.campaignId) {
    const params = [f.from, f.to, scope.publisherOrgId ?? null, f.siteId ?? null];
    const from = `page_views v JOIN sites s ON s.id = v.site_id LEFT JOIN page_contexts pc ON pc.site_id = v.site_id AND pc.page_path = v.page_path
                  WHERE v.day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR s.org_id = $3) AND ($4::uuid IS NULL OR v.site_id = $4)`;
    const [byTopic, bySafety] = await Promise.all([
      db.query(`SELECT ${PAGE_TOPIC_SQL} AS topic, sum(v.views)::bigint AS views FROM ${from} GROUP BY 1`, params),
      db.query(`SELECT ${PAGE_SAFETY_SQL} AS level, count(DISTINCT (v.site_id, v.page_path))::int AS pages, sum(v.views)::bigint AS views FROM ${from} GROUP BY 1`, params),
    ]);
    for (const r of byTopic.rows) views.set(r.topic, Number(r.views));
    const order = ['safe', 'low', 'medium', 'high', 'unknown'];
    safety = bySafety.rows.map((r) => ({ level: r.level as string, pages: Number(r.pages), pageviews: Number(r.views) }))
      .sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  }

  const keys = new Set([...delivery.map((r) => r.topic as string), ...views.keys()]);
  const byKey = new Map(delivery.map((r) => [r.topic as string, r]));
  const totalImps = delivery.reduce((n, r) => n + Number(r.imps), 0);
  const rows = [...keys].map((topic) => {
    const r = byKey.get(topic);
    const imps = Number(r?.imps ?? 0);
    const clicks = Number(r?.clicks ?? 0);
    const micros = BigInt(r?.micros ?? 0);
    const pv = views.get(topic);
    return {
      topic, label: topic ? topicLabel(topic) : 'Uncategorized',
      validImpressions: imps, viewableImpressions: Number(r?.viewable ?? 0), validClicks: clicks, ctr: ctr(clicks, imps),
      share: totalImps ? (imps / totalImps) * 100 : null,
      [audience === 'publisher' ? 'earningsMicros' : 'spendMicros']: micros.toString(),
      // eCPM for buyers, RPM for publishers: money per 1,000 valid impressions.
      [audience === 'publisher' ? 'rpmMicros' : 'ecpmMicros']: imps ? ((micros * 1000n) / BigInt(imps)).toString() : null,
      ...(pv !== undefined ? { pageviews: pv, pageRpmMicros: pv ? ((micros * 1000n) / BigInt(pv)).toString() : null } : {}),
    };
  }).sort((a, b) => b.validImpressions - a.validImpressions || (b.pageviews ?? 0) - (a.pageviews ?? 0) || a.label.localeCompare(b.label));
  return { rows, safety };
}
