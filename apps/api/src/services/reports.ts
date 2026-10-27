import type { Pool } from 'pg';
import { ctr, effectiveCpmMicros } from '@blissnova/shared';

export type GroupBy = 'day' | 'campaign' | 'creative' | 'site' | 'unit' | 'device' | 'country' | 'advertiser' | 'publisher';
export interface ReportScope { advertiserOrgId?: string; publisherOrgId?: string }
export interface ReportFilters { from: string; to: string; campaignId?: string; siteId?: string; unitId?: string }

const GROUPS: Record<GroupBy, { key: string; label: string; join?: string }> = {
  day: { key: `to_char(d.day, 'YYYY-MM-DD')`, label: `to_char(d.day, 'YYYY-MM-DD')` },
  campaign: { key: 'd.campaign_id::text', label: 'c.name', join: 'JOIN campaigns c ON c.id = d.campaign_id' },
  creative: { key: 'd.creative_id::text', label: 'cr.name', join: 'JOIN creatives cr ON cr.id = d.creative_id' },
  site: { key: 'd.site_id::text', label: 's.domain', join: 'JOIN sites s ON s.id = d.site_id' },
  unit: { key: 'd.unit_id::text', label: `u.name || ' (' || s.domain || ')'`, join: 'JOIN ad_units u ON u.id = d.unit_id JOIN sites s ON s.id = d.site_id' },
  device: { key: 'd.device', label: 'd.device' },
  country: { key: 'd.country', label: `CASE WHEN d.country = 'ZZ' THEN 'Unknown' ELSE d.country END` },
  advertiser: { key: 'd.advertiser_org_id::text', label: 'ao.name', join: 'JOIN organizations ao ON ao.id = d.advertiser_org_id' },
  publisher: { key: 'd.publisher_org_id::text', label: 'po.name', join: 'JOIN organizations po ON po.id = d.publisher_org_id' },
};

const SUMS = `sum(d.served)::bigint AS served, sum(d.rendered)::bigint AS rendered, sum(d.valid_impressions)::bigint AS valid_impressions,
  sum(d.invalid_impressions)::bigint AS invalid_impressions, sum(d.viewable_impressions)::bigint AS viewable_impressions, sum(d.valid_clicks)::bigint AS valid_clicks,
  sum(d.invalid_clicks)::bigint AS invalid_clicks, sum(d.billable_impressions)::bigint AS billable_impressions, sum(d.billable_clicks)::bigint AS billable_clicks,
  sum(d.spend_micros)::bigint AS spend_micros, sum(d.publisher_micros)::bigint AS publisher_micros`;

function where(scope: ReportScope, f: ReportFilters) {
  const clauses = ['d.day BETWEEN $1::date AND $2::date'];
  const params: unknown[] = [f.from, f.to];
  const add = (sql: string, v: unknown) => { params.push(v); clauses.push(sql.replace('?', `$${params.length}`)); };
  if (scope.advertiserOrgId) add('d.advertiser_org_id = ?', scope.advertiserOrgId);
  if (scope.publisherOrgId) add('d.publisher_org_id = ?', scope.publisherOrgId);
  if (f.campaignId) add('d.campaign_id = ?', f.campaignId);
  if (f.siteId) add('d.site_id = ?', f.siteId);
  if (f.unitId) add('d.unit_id = ?', f.unitId);
  return { sql: clauses.join(' AND '), params };
}

function shape(r: Record<string, string | null>, audience: 'advertiser' | 'publisher' | 'admin') {
  const n = (k: string) => Number(r[k] ?? 0);
  const spend = BigInt(r.spend_micros ?? 0);
  const out: Record<string, unknown> = {
    served: n('served'), rendered: n('rendered'), validImpressions: n('valid_impressions'), invalidImpressions: n('invalid_impressions'),
    viewableImpressions: n('viewable_impressions'), validClicks: n('valid_clicks'), invalidClicks: n('invalid_clicks'),
    billableImpressions: n('billable_impressions'), billableClicks: n('billable_clicks'),
    ctr: ctr(n('valid_clicks'), n('valid_impressions')),
    viewabilityRate: n('valid_impressions') ? (n('viewable_impressions') / n('valid_impressions')) * 100 : null,
    invalidRate: n('rendered') ? (n('invalid_impressions') / n('rendered')) * 100 : null,
  };
  if (audience !== 'publisher') {
    out.spendMicros = spend.toString();
    out.ecpmMicros = effectiveCpmMicros(spend, n('valid_impressions'))?.toString() ?? null;
    out.ecpcMicros = n('valid_clicks') ? (spend / BigInt(n('valid_clicks'))).toString() : null;
  }
  if (audience !== 'advertiser') {
    out.earningsMicros = r.publisher_micros ?? '0';
    out.rpmMicros = effectiveCpmMicros(BigInt(r.publisher_micros ?? 0), n('valid_impressions'))?.toString() ?? null;
  }
  if (audience === 'admin') out.networkRevenueMicros = (spend - BigInt(r.publisher_micros ?? 0)).toString();
  return out;
}

export async function runReport(db: Pool, scope: ReportScope, f: ReportFilters, groupBy: GroupBy, audience: 'advertiser' | 'publisher' | 'admin', limit = 500) {
  const w = where(scope, f);
  const g = GROUPS[groupBy];
  const rows = (await db.query(
    `SELECT ${g.key} AS key, ${g.label} AS label, ${SUMS} FROM daily_stats d ${g.join ?? ''} WHERE ${w.sql} GROUP BY 1, 2 ORDER BY ${groupBy === 'day' ? '1 ASC' : 'valid_impressions DESC NULLS LAST, 2'} LIMIT ${limit}`, w.params)).rows;
  const totals = (await db.query(`SELECT ${SUMS} FROM daily_stats d WHERE ${w.sql}`, w.params)).rows[0];
  let data: Array<Record<string, unknown>> = rows.map((r) => ({ key: r.key, label: r.label, ...shape(r, audience) }));
  if (groupBy === 'day') data = fillDays(f.from, f.to, data as Array<Record<string, unknown> & { key: string }>, audience);
  return { totals: shape(totals, audience), rows: data };
}

function fillDays(from: string, to: string, rows: Array<Record<string, unknown> & { key: string }>, audience: 'advertiser' | 'publisher' | 'admin') {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: Array<Record<string, unknown>> = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byKey.get(day) ?? { key: day, label: day, ...shape({}, audience) });
  }
  return out;
}

export async function requestStats(db: Pool, publisherOrgId: string | null, f: ReportFilters) {
  const r = (await db.query(
    `SELECT COALESCE(sum(r.requests), 0)::bigint AS requests, COALESCE(sum(r.filled), 0)::bigint AS filled, COALESCE(sum(r.no_fill), 0)::bigint AS no_fill,
            COALESCE(sum(r.cap_rejects), 0)::bigint AS cap_rejects, COALESCE(sum(r.budget_rejects), 0)::bigint AS budget_rejects, COALESCE(sum(r.blocked), 0)::bigint AS blocked
     FROM unit_request_stats r JOIN ad_units u ON u.id = r.unit_id JOIN sites s ON s.id = u.site_id
     WHERE r.day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR s.org_id = $3) AND ($4::uuid IS NULL OR s.id = $4)`,
    [f.from, f.to, publisherOrgId, f.siteId ?? null])).rows[0];
  const req = Number(r.requests);
  return { requests: req, filled: Number(r.filled), noFill: Number(r.no_fill), capRejects: Number(r.cap_rejects), budgetRejects: Number(r.budget_rejects), blocked: Number(r.blocked), fillRate: req ? (Number(r.filled) / req) * 100 : null };
}

/**
 * Per-page report for a publisher. Page views come from page_views (pages
 * where the tag asked for at least one ad); earnings come from validated
 * events in page_daily_stats. Page RPM = estimated earnings / page views x 1000.
 */
export async function pageReport(db: Pool, publisherOrgId: string, f: ReportFilters, limit = 200) {
  const params = [f.from, f.to, publisherOrgId, f.siteId ?? null];
  const src = `(SELECT day, site_id, page_path, views, 0::bigint AS imps, 0::bigint AS clicks, 0::bigint AS micros FROM page_views
                UNION ALL
                SELECT day, site_id, page_path, 0, valid_impressions, valid_clicks, publisher_micros FROM page_daily_stats) p
               JOIN sites s ON s.id = p.site_id
               WHERE p.day BETWEEN $1::date AND $2::date AND s.org_id = $3 AND ($4::uuid IS NULL OR s.id = $4)`;
  const sums = `sum(p.views)::bigint AS views, sum(p.imps)::bigint AS imps, sum(p.clicks)::bigint AS clicks, sum(p.micros)::bigint AS micros`;
  const rows = (await db.query(`SELECT s.id AS site_id, s.domain, p.page_path, ${sums} FROM ${src} GROUP BY 1, 2, 3 ORDER BY micros DESC, views DESC, 3 LIMIT ${limit}`, params)).rows;
  const totals = (await db.query(`SELECT ${sums} FROM ${src}`, params)).rows[0];
  return { totals: pageShape(totals), rows: rows.map((r) => ({ siteId: r.site_id, domain: r.domain, path: r.page_path, ...pageShape(r) })) };
}

function pageShape(r: Record<string, string | null>) {
  const views = Number(r.views ?? 0);
  const imps = Number(r.imps ?? 0);
  const micros = BigInt(r.micros ?? 0);
  return {
    pageviews: views, validImpressions: imps, validClicks: Number(r.clicks ?? 0), ctr: ctr(Number(r.clicks ?? 0), imps),
    impressionsPerPageview: views ? imps / views : null,
    earningsMicros: micros.toString(), pageRpmMicros: views ? ((micros * 1000n) / BigInt(views)).toString() : null,
  };
}

/** Page views for the publisher's dashboard (all pages, optionally one site). */
export async function pageviewTotal(db: Pool, publisherOrgId: string, f: ReportFilters) {
  const r = (await db.query(
    `SELECT COALESCE(sum(v.views), 0)::bigint AS views FROM page_views v JOIN sites s ON s.id = v.site_id
     WHERE v.day BETWEEN $1::date AND $2::date AND s.org_id = $3 AND ($4::uuid IS NULL OR s.id = $4)`,
    [f.from, f.to, publisherOrgId, f.siteId ?? null])).rows[0];
  return Number(r.views);
}
