import type { Pool } from 'pg';
import { ctr } from '@blissnova/shared';
import { requestStats, runReport, type GroupBy, type ReportFilters, type ReportScope } from './reports';

/**
 * Analytics: everything the reports pages show, plus the views top networks
 * offer on top of plain reports. All figures come from validated events and
 * the aggregates built from them (daily_stats, hourly_stats, ivt_daily_stats,
 * site_traffic_daily, conversions); nothing is estimated or modelled.
 *
 *  - totals for the period and for the same-length period just before it;
 *  - daily trend; weekday x hour heatmap (UTC);
 *  - breakdowns by device, OS, browser, country, traffic source, placement
 *    type and ad format (plus campaigns, sites, placements per audience);
 *  - delivery funnel, from ad requests to conversions;
 *  - invalid traffic by reason;
 *  - placement viewability and average time in view;
 *  - publishers: sessions, pages per session, session RPM, RPM by source;
 *  - advertisers: conversions, CPA, ROAS, and reach and frequency among
 *    visitors who allowed personalization (the only ones with an id);
 *  - plain-language insights computed from the above with fixed rules.
 */
export type Audience = 'advertiser' | 'publisher' | 'admin';

interface Scoped { sql: string; params: unknown[] }

/** WHERE clause for an aggregate table, by alias and its date expression. */
function scoped(alias: string, dateSql: string, scope: ReportScope, f: ReportFilters, opts: { unit?: boolean } = {}): Scoped {
  const clauses = [`${dateSql} BETWEEN $1::date AND $2::date`];
  const params: unknown[] = [f.from, f.to];
  const add = (col: string, v: unknown) => { params.push(v); clauses.push(`${alias}.${col} = $${params.length}`); };
  if (scope.advertiserOrgId) add('advertiser_org_id', scope.advertiserOrgId);
  if (scope.publisherOrgId) add('publisher_org_id', scope.publisherOrgId);
  if (f.campaignId) add('campaign_id', f.campaignId);
  if (f.siteId) add('site_id', f.siteId);
  if (opts.unit && f.unitId) add('unit_id', f.unitId);
  return { sql: clauses.join(' AND '), params };
}

const DAY = 86_400_000;

/** The same number of days immediately before the range. */
export function previousRange(f: { from: string; to: string }) {
  const len = Math.round((Date.parse(f.to) - Date.parse(f.from)) / DAY) + 1;
  const to = new Date(Date.parse(f.from) - DAY).toISOString().slice(0, 10);
  const from = new Date(Date.parse(f.from) - len * DAY).toISOString().slice(0, 10);
  return { from, to, days: len };
}

const BREAKDOWNS: Record<Audience, GroupBy[]> = {
  advertiser: ['campaign', 'creative', 'site', 'device', 'os', 'browser', 'country', 'source', 'display', 'format'],
  publisher: ['site', 'unit', 'device', 'os', 'browser', 'country', 'source', 'display', 'format'],
  admin: ['publisher', 'advertiser', 'site', 'campaign', 'device', 'os', 'browser', 'country', 'source', 'display', 'format'],
};

export async function analyticsOverview(db: Pool, scope: ReportScope, f: ReportFilters, audience: Audience) {
  const result = await collect(db, scope, f, audience);
  return { ...result, insights: insights(result, audience) };
}

async function collect(db: Pool, scope: ReportScope, f: ReportFilters, audience: Audience) {
  const prev = previousRange(f);
  const [trend, previous] = await Promise.all([
    runReport(db, scope, f, 'day', audience),
    runReport(db, scope, { ...f, from: prev.from, to: prev.to }, 'day', audience),
  ]);
  const current = trend;
  const groups = BREAKDOWNS[audience];
  const lists = await Promise.all(groups.map((g) => runReport(db, scope, f, g, audience, 12)));
  const breakdowns = Object.fromEntries(groups.map((g, i) => [g, lists[i]!.rows]));
  const placements = (await runReport(db, scope, f, 'unit', audience, 50)).rows;

  const [heatmap, ivt, funnelRequests, traffic, reach, conversionEvents] = await Promise.all([
    hourlyHeatmap(db, scope, f, audience),
    invalidTraffic(db, scope, f),
    audience === 'advertiser' ? Promise.resolve(null) : requestStats(db, scope.publisherOrgId ?? null, f),
    audience === 'advertiser' ? Promise.resolve(null) : sessionTraffic(db, scope, f, breakdowns.source as Array<Record<string, unknown>>),
    audience === 'publisher' ? Promise.resolve(null) : reachFrequency(db, scope, f),
    audience === 'publisher' ? Promise.resolve(null) : conversionsByEvent(db, scope, f),
  ]);

  const t = current.totals as Record<string, number | string | null>;
  const funnel = [
    // Request counters started later than event history for some installs; show them only when they cover the period.
    ...(funnelRequests && funnelRequests.requests >= Number(t.served ?? 0) ? [{ key: 'requests', label: 'Ad requests', value: funnelRequests.requests }, { key: 'filled', label: 'Filled', value: funnelRequests.filled }] : []),
    { key: 'served', label: 'Served', value: Number(t.served ?? 0) },
    { key: 'rendered', label: 'Rendered', value: Number(t.rendered ?? 0) },
    { key: 'valid', label: 'Valid impressions', value: Number(t.validImpressions ?? 0) },
    { key: 'viewable', label: 'Viewable', value: Number(t.viewableImpressions ?? 0) },
    { key: 'clicks', label: 'Valid clicks', value: Number(t.validClicks ?? 0) },
    ...(audience !== 'publisher' ? [{ key: 'conversions', label: 'Conversions', value: Number(t.conversions ?? 0) }] : []),
  ];

  return {
    range: { from: f.from, to: f.to, days: prev.days },
    previousRange: { from: prev.from, to: prev.to },
    totals: current.totals,
    previous: previous.totals,
    previousTrend: previous.rows,
    trend: trend.rows,
    breakdowns,
    placements,
    heatmap,
    funnel,
    requests: funnelRequests,
    ivt,
    traffic,
    reach,
    conversionEvents,
  };
}

/** Weekday (1 = Monday) x hour (UTC) grid of valid impressions, clicks and money. */
async function hourlyHeatmap(db: Pool, scope: ReportScope, f: ReportFilters, audience: Audience) {
  const w = scoped('h', '(h.hour AT TIME ZONE \'UTC\')::date', scope, f);
  const rows = (await db.query(
    `SELECT extract(isodow FROM h.hour AT TIME ZONE 'UTC')::int AS dow, extract(hour FROM h.hour AT TIME ZONE 'UTC')::int AS hour,
            sum(h.valid_impressions)::bigint AS imps, sum(h.valid_clicks)::bigint AS clicks, sum(h.viewable_impressions)::bigint AS viewable,
            sum(${audience === 'publisher' ? 'h.publisher_micros' : 'h.spend_micros'})::bigint AS micros
     FROM hourly_stats h WHERE ${w.sql} GROUP BY 1, 2 ORDER BY 1, 2`, w.params)).rows;
  return {
    timezone: 'UTC',
    money: audience === 'publisher' ? 'earnings' : 'spend',
    cells: rows.map((r) => ({ dow: r.dow as number, hour: r.hour as number, validImpressions: Number(r.imps), validClicks: Number(r.clicks), viewableImpressions: Number(r.viewable), micros: String(r.micros) })),
  };
}

async function invalidTraffic(db: Pool, scope: ReportScope, f: ReportFilters) {
  const w = scoped('i', 'i.day', scope, f);
  const rows = (await db.query(
    `SELECT i.type, i.reason, sum(i.events)::bigint AS events FROM ivt_daily_stats i WHERE ${w.sql} GROUP BY 1, 2 ORDER BY 3 DESC`, w.params)).rows;
  return rows.map((r) => ({ type: r.type as string, reason: r.reason as string, events: Number(r.events) }));
}

/** Page views and sessions from site_traffic_daily, with earnings by traffic source. */
async function sessionTraffic(db: Pool, scope: ReportScope, f: ReportFilters, bySourceEarnings: Array<Record<string, unknown>>) {
  const params: unknown[] = [f.from, f.to, scope.publisherOrgId ?? null, f.siteId ?? null];
  const from = `site_traffic_daily t JOIN sites s ON s.id = t.site_id WHERE t.day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR s.org_id = $3) AND ($4::uuid IS NULL OR t.site_id = $4)`;
  const [tot, bySource, byDevice, daily] = await Promise.all([
    db.query(`SELECT COALESCE(sum(t.pageviews), 0)::bigint AS pageviews, COALESCE(sum(t.sessions), 0)::bigint AS sessions FROM ${from}`, params),
    db.query(`SELECT t.source, sum(t.pageviews)::bigint AS pageviews, sum(t.sessions)::bigint AS sessions FROM ${from} GROUP BY 1 ORDER BY 2 DESC`, params),
    db.query(`SELECT t.device, sum(t.pageviews)::bigint AS pageviews, sum(t.sessions)::bigint AS sessions FROM ${from} GROUP BY 1 ORDER BY 2 DESC`, params),
    db.query(`SELECT to_char(t.day, 'YYYY-MM-DD') AS day, sum(t.pageviews)::bigint AS pageviews, sum(t.sessions)::bigint AS sessions FROM ${from} GROUP BY 1 ORDER BY 1`, params),
  ]);
  const pageviews = Number(tot.rows[0].pageviews);
  const sessions = Number(tot.rows[0].sessions);
  const earningsBySource = new Map(bySourceEarnings.map((r) => [String(r.key), BigInt(String(r.earningsMicros ?? '0'))]));
  const totalEarnings = [...earningsBySource.values()].reduce((a, b) => a + b, 0n);
  const rpm = (micros: bigint, n: number) => (n ? ((micros * 1000n) / BigInt(n)).toString() : null);
  const byDay = new Map(daily.rows.map((r) => [r.day as string, r]));
  const trend: Array<{ key: string; label: string; pageviews: number; sessions: number }> = [];
  for (let d = Date.parse(f.from); d <= Date.parse(f.to); d += DAY) {
    const day = new Date(d).toISOString().slice(0, 10);
    const r = byDay.get(day);
    trend.push({ key: day, label: day, pageviews: Number(r?.pageviews ?? 0), sessions: Number(r?.sessions ?? 0) });
  }
  return {
    pageviews, sessions,
    pagesPerSession: sessions ? pageviews / sessions : null,
    sessionRpmMicros: rpm(totalEarnings, sessions),
    pageRpmMicros: rpm(totalEarnings, pageviews),
    bySource: bySource.rows.map((r) => {
      const earned = earningsBySource.get(r.source) ?? 0n;
      return { source: r.source as string, pageviews: Number(r.pageviews), sessions: Number(r.sessions), earningsMicros: earned.toString(), pageRpmMicros: rpm(earned, Number(r.pageviews)), sessionRpmMicros: rpm(earned, Number(r.sessions)) };
    }),
    byDevice: byDevice.rows.map((r) => ({ device: r.device as string, pageviews: Number(r.pageviews), sessions: Number(r.sessions) })),
    trend,
  };
}

const REACH_MAX_DAYS = 92;

/** Unique consenting visitors reached and how often they saw the ads. Raw events, so limited to 92 days. */
async function reachFrequency(db: Pool, scope: ReportScope, f: ReportFilters) {
  if ((Date.parse(f.to) - Date.parse(f.from)) / DAY + 1 > REACH_MAX_DAYS) return { available: false as const, maxDays: REACH_MAX_DAYS };
  const w = scoped('e', '(e.occurred_at AT TIME ZONE \'UTC\')::date', scope, f, { unit: true });
  const r = (await db.query(
    `SELECT count(DISTINCT e.visitor_hash)::bigint AS reach, count(*) FILTER (WHERE e.visitor_hash IS NOT NULL)::bigint AS identified, count(*)::bigint AS imps
     FROM ad_events e WHERE ${w.sql} AND e.type = 'render' AND e.status = 'valid'
       AND e.occurred_at >= $1::date AND e.occurred_at < $2::date + 1`, w.params)).rows[0];
  const reach = Number(r.reach);
  const identified = Number(r.identified);
  const imps = Number(r.imps);
  return {
    available: true as const, maxDays: REACH_MAX_DAYS,
    reach, identifiedImpressions: identified,
    frequency: reach ? identified / reach : null,
    identifiedShare: imps ? (identified / imps) * 100 : null,
  };
}

async function conversionsByEvent(db: Pool, scope: ReportScope, f: ReportFilters) {
  const w = scoped('c', '(c.occurred_at AT TIME ZONE \'UTC\')::date', scope, f, { unit: true });
  const rows = (await db.query(
    `SELECT c.event_name AS event, count(*)::bigint AS n, COALESCE(sum(c.value_micros), 0)::bigint AS value,
            avg(extract(epoch FROM c.occurred_at - c.click_at))::float AS lag
     FROM conversions c WHERE ${w.sql} AND c.occurred_at >= $1::date AND c.occurred_at < $2::date + 1 GROUP BY 1 ORDER BY 2 DESC`, w.params)).rows;
  return rows.map((r) => ({ event: r.event as string, conversions: Number(r.n), valueMicros: String(r.value), avgHoursToConvert: r.lag === null ? null : Number(r.lag) / 3600 }));
}

const SOURCE_LABEL: Record<string, string> = { search: 'search', social: 'social', direct: 'direct', referral: 'referral', internal: 'internal navigation', unknown: 'unknown' };
const WEEKDAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type Overview = Awaited<ReturnType<typeof collect>>;

/** A few fixed, explainable observations. Each names the numbers it is based on. */
export function insights(a: Overview, audience: Audience): Array<{ tone: 'good' | 'warn' | 'info'; title: string; detail: string }> {
  const out: Array<{ tone: 'good' | 'warn' | 'info'; title: string; detail: string }> = [];
  const t = a.totals as Record<string, any>;
  const p = a.previous as Record<string, any>;
  const money = audience === 'publisher' ? 'earningsMicros' : 'spendMicros';
  const cur = BigInt(t[money] ?? '0');
  const before = BigInt(p[money] ?? '0');
  if (before > 0n) {
    const pct = Number(((cur - before) * 10000n) / before) / 100;
    if (Math.abs(pct) >= 10) {
      out.push({ tone: pct > 0 ? 'good' : 'warn', title: `${audience === 'publisher' ? 'Earnings' : 'Spend'} ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}%`, detail: `Compared with the previous ${a.range.days} days.` });
    }
  }
  const weak = a.placements.filter((u: Record<string, any>) => (u.validImpressions ?? 0) >= 100 && u.viewabilityRate !== null && u.viewabilityRate < 50)
    .sort((x: Record<string, any>, y: Record<string, any>) => x.viewabilityRate - y.viewabilityRate)[0] as Record<string, any> | undefined;
  if (weak) out.push({ tone: 'warn', title: `Low viewability on ${weak.label}`, detail: `${weak.viewabilityRate.toFixed(1)}% of its valid impressions were viewable. Moving it higher on the page or nearer the content usually helps.` });
  if (t.invalidRate !== null && t.invalidRate >= 5) {
    const top = a.ivt.find((r) => r.type === 'render');
    out.push({ tone: 'warn', title: `${t.invalidRate.toFixed(1)}% of rendered impressions were invalid`, detail: top ? `Most common reason: ${top.reason.replace(/_/g, ' ')}. Invalid impressions are never billed or paid.` : 'Invalid impressions are never billed or paid.' });
  }
  const cells = a.heatmap.cells.filter((c) => c.validImpressions > 0);
  if (cells.length >= 12) {
    const best = cells.reduce((x, y) => (y.validImpressions > x.validImpressions ? y : x));
    out.push({ tone: 'info', title: `Busiest hour: ${WEEKDAY[best.dow]} ${String(best.hour).padStart(2, '0')}:00 UTC`, detail: `${best.validImpressions.toLocaleString('en-US')} valid impressions in that hour across the period.` });
  }
  if (a.traffic && a.traffic.bySource.length > 1) {
    const ranked = a.traffic.bySource.filter((s) => s.source !== 'internal' && s.source !== 'unknown' && s.pageviews >= 50 && s.pageRpmMicros !== null).sort((x, y) => Number(BigInt(y.pageRpmMicros!) - BigInt(x.pageRpmMicros!)));
    if (ranked.length >= 2) out.push({ tone: 'info', title: `Visitors from ${SOURCE_LABEL[ranked[0]!.source] ?? ranked[0]!.source} earn the most per page`, detail: `Page RPM by traffic source, from estimated earnings and page views in this period.` });
  }
  if (audience !== 'publisher' && t.validClicks > 0 && t.conversions === 0) {
    out.push({ tone: 'info', title: 'No conversions recorded', detail: 'Turn on conversion tracking on a campaign and add the pixel or postback to see conversions, CPA and ROAS.' });
  }
  if (audience !== 'publisher' && t.roas !== null && t.roas !== undefined && t.conversions > 0) {
    out.push({ tone: t.roas >= 1 ? 'good' : 'warn', title: `Return on ad spend: ${t.roas.toFixed(2)}x`, detail: 'Reported conversion value divided by spend in this period.' });
  }
  const devices = (a.breakdowns.device ?? []) as Array<Record<string, any>>;
  const mobile = devices.find((d) => d.key === 'mobile');
  const desktop = devices.find((d) => d.key === 'desktop');
  if (mobile && desktop && mobile.validImpressions >= 100 && desktop.validImpressions >= 100) {
    const m = ctr(mobile.validClicks, mobile.validImpressions) ?? 0;
    const d = ctr(desktop.validClicks, desktop.validImpressions) ?? 0;
    if (d > 0 && Math.abs(m - d) / d >= 0.25) out.push({ tone: 'info', title: `Mobile CTR is ${m > d ? 'higher' : 'lower'} than desktop`, detail: `${m.toFixed(2)}% on mobile against ${d.toFixed(2)}% on desktop.` });
  }
  return out.slice(0, 6);
}

/** Last 30 minutes, minute by minute, straight from the event log. */
export async function realtime(db: Pool, scope: ReportScope, audience: Audience, filters: { siteId?: string; campaignId?: string } = {}) {
  const clauses = [`e.occurred_at > now() - interval '30 minutes'`];
  const params: unknown[] = [];
  const add = (col: string, v: unknown) => { params.push(v); clauses.push(`e.${col} = $${params.length}`); };
  if (scope.advertiserOrgId) add('advertiser_org_id', scope.advertiserOrgId);
  if (scope.publisherOrgId) add('publisher_org_id', scope.publisherOrgId);
  if (filters.siteId) add('site_id', filters.siteId);
  if (filters.campaignId) add('campaign_id', filters.campaignId);
  const where = clauses.join(' AND ');
  const moneyCol = audience === 'publisher' ? 'publisher_micros' : 'cost_micros';
  const sums = `count(*) FILTER (WHERE e.type = 'served')::int AS served, count(*) FILTER (WHERE e.type = 'render' AND e.status = 'valid')::int AS imps,
    count(*) FILTER (WHERE e.type = 'viewable' AND e.status = 'valid')::int AS viewable, count(*) FILTER (WHERE e.type = 'click' AND e.status = 'valid')::int AS clicks,
    count(*) FILTER (WHERE e.status = 'invalid')::int AS invalid, COALESCE(sum(e.${moneyCol}) FILTER (WHERE e.billable), 0)::text AS micros`;
  const [perMinute, totals, active, top] = await Promise.all([
    db.query(`SELECT to_char(date_trunc('minute', e.occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS minute, ${sums} FROM ad_events e WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
    db.query(`SELECT ${sums} FROM ad_events e WHERE ${where}`, params),
    db.query(`SELECT count(DISTINCT (e.site_id, e.page_path))::int AS pages FROM ad_events e WHERE ${where} AND e.occurred_at > now() - interval '5 minutes' AND e.type = 'served'`, params),
    audience === 'advertiser'
      ? db.query(`SELECT c.name AS label, ${sums} FROM ad_events e JOIN campaigns c ON c.id = e.campaign_id WHERE ${where} GROUP BY 1 ORDER BY imps DESC LIMIT 8`, params)
      : db.query(`SELECT s.domain || COALESCE(e.page_path, '') AS label, ${sums} FROM ad_events e JOIN sites s ON s.id = e.site_id WHERE ${where} GROUP BY 1 ORDER BY imps DESC LIMIT 8`, params),
  ]);
  const shapeRow = (r: Record<string, any>) => ({ served: r.served, validImpressions: r.imps, viewableImpressions: r.viewable, validClicks: r.clicks, invalidEvents: r.invalid, micros: r.micros });
  const byMinute = new Map(perMinute.rows.map((r) => [r.minute as string, r]));
  const minutes: Array<Record<string, unknown>> = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    const m = new Date(Math.floor((now - i * 60_000) / 60_000) * 60_000).toISOString().slice(0, 16);
    const r = byMinute.get(m);
    minutes.push({ key: m, label: m.slice(11), ...shapeRow(r ?? { served: 0, imps: 0, viewable: 0, clicks: 0, invalid: 0, micros: '0' }) });
  }
  return { at: new Date(now).toISOString(), money: audience === 'publisher' ? 'earnings' : 'spend', totals: shapeRow(totals.rows[0]), activePages: active.rows[0].pages as number, minutes, top: top.rows.map((r) => ({ label: r.label as string, ...shapeRow(r) })) };
}
