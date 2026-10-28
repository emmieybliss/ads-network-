import type { PoolClient } from 'pg';
import { recordCharge } from '@blissnova/billing';
import { applyBps, type PlatformSettings } from '@blissnova/shared';
import { assessEvent, hostAuthorized, isKnownCrawler, normalizeHost, verifyDeliveryToken, type DeliveryClaims } from '@blissnova/tracking';
import type { AppContext } from '../lib/context';
import { withTransaction } from '@blissnova/database';
import { dayInZone } from './serving';

/**
 * Event ingestion happens in two phases:
 *  1. admitEvent (in the API request): verify the encrypted token, drop
 *     retries, mark duplicates and record render receipts in Redis. Cheap.
 *  2. processAdmittedEvent (worker, or inline): invalid-traffic scoring,
 *     persistence and, for billable events, a concurrency-safe budget charge
 *     inside one Postgres transaction.
 */
export type TrackedType = 'render' | 'viewable' | 'click' | 'inview';
export interface AdmittedEvent {
  clientEventId: string;
  type: TrackedType;
  claims: DeliveryClaims;
  receivedAt: number;
  ipHash: string;
  ua: string;
  originHost: string | null;
  referrerHost: string | null;
  flags: { tokenExpired?: boolean; duplicate?: boolean; noRenderReceipt?: boolean };
  renderAt: number | null;
  /** inview only: milliseconds the creative was in view. */
  inViewMs?: number;
}
export type AdmitResult = { accepted: true; event: AdmittedEvent } | { accepted: false; reason: 'token_invalid' | 'disabled' | 'retry' };

export class RetryLaterError extends Error {}

const CLICK_GRACE_MS = 24 * 3600 * 1000;
// Time in view is reported when the visitor leaves, which can be long after the token expired.
const INVIEW_GRACE_MS = 4 * 3600 * 1000;

export async function admitEvent(ctx: AppContext, input: { clientEventId: string; type: TrackedType; token: string; inViewMs?: number }, meta: { ipHash: string; ua: string; origin: string | null; referrer: string | null }, s: PlatformSettings): Promise<AdmitResult> {
  if (!s.tracking.enabled) return { accepted: false, reason: 'disabled' };
  if (input.type === 'render' && !s.tracking.impressions) return { accepted: false, reason: 'disabled' };
  if (input.type === 'click' && !s.tracking.clicks) return { accepted: false, reason: 'disabled' };
  if ((input.type === 'viewable' || input.type === 'inview') && !s.tracking.viewability) return { accepted: false, reason: 'disabled' };
  const v = verifyDeliveryToken(ctx.tokens, input.token, Date.now(), input.type === 'click' ? CLICK_GRACE_MS : input.type === 'inview' ? INVIEW_GRACE_MS : 0);
  if (!v.ok && !v.claims) {
    await ctx.redis.incr(`ivt:token_invalid:${new Date().toISOString().slice(0, 10)}`);
    return { accepted: false, reason: 'token_invalid' };
  }
  const claims = v.ok ? v.claims : v.claims!;
  const window = s.tracking.dedupWindowSeconds;
  // Retries of the same client submission are acknowledged and ignored.
  const fresh = await ctx.redis.set(`evc:${input.clientEventId.slice(0, 64)}`, '1', 'EX', window, 'NX');
  if (fresh !== 'OK') return { accepted: false, reason: 'retry' };
  const first = await ctx.redis.set(`evd:${claims.d}:${input.type}`, '1', 'EX', window, 'NX');
  const now = Date.now();
  let renderAt: number | null = null;
  if (input.type === 'render' && first === 'OK') await ctx.redis.set(`evr:${claims.d}`, String(now), 'EX', window);
  if (input.type !== 'render') {
    const r = await ctx.redis.get(`evr:${claims.d}`);
    renderAt = r ? Number(r) : null;
  }
  const host = (h: string | null) => {
    if (!h) return null;
    try { return normalizeHost(new URL(h).hostname); } catch { return ''; }
  };
  return {
    accepted: true,
    event: {
      clientEventId: input.clientEventId.slice(0, 64), type: input.type, claims, receivedAt: now, ipHash: meta.ipHash, ua: meta.ua.slice(0, 400),
      originHost: host(meta.origin), referrerHost: host(meta.referrer),
      flags: { tokenExpired: !v.ok && v.reason === 'token_expired', duplicate: first !== 'OK', noRenderReceipt: input.type !== 'render' && renderAt === null },
      renderAt,
      ...(input.type === 'inview' ? { inViewMs: Math.max(0, Math.min(3_600_000, Math.round(input.inViewMs ?? 0))) } : {}),
    },
  };
}

export interface ProcessResult { status: 'valid' | 'invalid' | 'ignored'; reason?: string | null; billable?: boolean }

export async function processAdmittedEvent(ctx: Pick<AppContext, 'db' | 'redis'>, e: AdmittedEvent, s: PlatformSettings, opts: { inline: boolean }): Promise<ProcessResult> {
  const c = e.claims;
  const site = (await ctx.db.query(`SELECT s.domain, s.allowed_domains, s.verification_scope, s.status, o.status AS org_status FROM sites s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`, [c.s])).rows[0];
  if (!site) return { status: 'ignored' };
  const minute = Math.floor(e.receivedAt / 60_000);
  const rate = await ctx.redis.multi().incr(`evrate:${e.ipHash}:${minute}`).expire(`evrate:${e.ipHash}:${minute}`, 120).exec();
  const ipPerMinute = Number(rate?.[0]?.[1] ?? 0);

  let renderStatus: string | null = null;
  if (e.type !== 'render') {
    const r = (await ctx.db.query<{ status: string }>(`SELECT status FROM ad_events WHERE event_key = $1`, [`${c.d}:render`])).rows[0];
    if (!r && !e.flags.noRenderReceipt && !opts.inline) throw new RetryLaterError('render not yet processed');
    renderStatus = r?.status ?? null;
  }
  let clicksLastHour: number | undefined;
  if (e.type === 'click') {
    const hour = Math.floor(e.receivedAt / 3_600_000);
    const k = `clk:${c.v ?? e.ipHash}:${hour}`;
    const res = await ctx.redis.multi().incr(k).expire(k, 3700).exec();
    clicksLastHour = Number(res?.[0]?.[1] ?? 0);
  }
  const hostOk = (h: string) => hostAuthorized(h, site.domain, site.allowed_domains, site.verification_scope === 'zone');
  const domainMismatch = (e.originHost !== null && e.originHost !== '' && !hostOk(e.originHost)) || (e.type === 'click' && e.referrerHost !== null && e.referrerHost !== '' && !hostOk(e.referrerHost)) || !hostOk(c.ph);
  const result = assessEvent({
    tokenExpired: e.flags.tokenExpired,
    duplicate: e.flags.duplicate,
    siteInactive: site.status !== 'approved' || site.org_status !== 'approved',
    domainMismatch,
    crawler: isKnownCrawler(e.ua),
    sequenceViolation: e.type !== 'render' && renderStatus !== 'valid',
    ipRequestsPerMinute: ipPerMinute,
    maxRequestsPerMinute: s.ivt.maxRequestsPerMinutePerIp,
    renderToClickMs: e.type === 'click' && e.renderAt ? e.receivedAt - e.renderAt : null,
    minRenderToClickMs: s.ivt.minRenderToClickMs,
    visitorClicksLastHour: clicksLastHour,
    maxClicksPerVisitorPerHour: s.ivt.maxClicksPerVisitorPerHour,
    missingReferrer: e.type === 'click' && !e.referrerHost,
    tokenAgeMs: e.type === 'render' ? e.receivedAt - c.iat : undefined,
  }, s.ivt.scoreThreshold);

  const billableType = (c.pm === 'cpm' && e.type === 'render') || (c.pm === 'cpc' && e.type === 'click');
  return withTransaction(ctx.db as never, async (client: PoolClient) => {
    const base = [c.d, e.type, result.valid ? 'valid' : 'invalid', result.reason, result.score, c.c, c.cr, c.ao, c.s, c.u, c.po, c.v ?? null, e.ipHash, c.co, c.dv, c.ct, c.ph, c.cur, e.receivedAt, e.clientEventId, c.pp ?? null,
      c.os ?? 'other', c.br ?? 'other', c.src ?? 'unknown', e.type === 'inview' ? (e.inViewMs ?? 0) : null];
    const ins = await client.query<{ id: string }>(
      `INSERT INTO ad_events (event_key, delivery_id, type, status, invalid_reason, ivt_score, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, visitor_hash, ip_hash, country, device, contextual, page_host, currency, occurred_at, client_event_id, page_path, os, browser, source, in_view_ms)
       VALUES ($26, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, to_timestamp($19 / 1000.0), $20, $21, $22, $23, $24, $25)
       ON CONFLICT DO NOTHING RETURNING id`,
      [...base, e.flags.duplicate ? null : `${c.d}:${e.type}`]);
    if (!ins.rows[0]) {
      const retry = await client.query('SELECT 1 FROM ad_events WHERE client_event_id = $1', [e.clientEventId]);
      if (retry.rowCount) return { status: 'ignored' as const };
      // Lost a race with another first event for this delivery: record as duplicate.
      base[2] = 'invalid';
      base[3] = 'duplicate';
      await client.query(
        `INSERT INTO ad_events (delivery_id, type, status, invalid_reason, ivt_score, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, visitor_hash, ip_hash, country, device, contextual, page_host, currency, occurred_at, client_event_id, page_path, os, browser, source, in_view_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, to_timestamp($19 / 1000.0), $20, $21, $22, $23, $24, $25) ON CONFLICT DO NOTHING`, base);
      return { status: 'invalid' as const, reason: 'duplicate' };
    }
    let billable = false;
    if (result.valid && billableType) {
      const rate = BigInt(c.r);
      const cost = c.pm === 'cpm' ? rate / 1000n : rate;
      const tz = (await client.query<{ timezone: string }>('SELECT timezone FROM campaigns WHERE id = $1', [c.c])).rows[0]?.timezone ?? 'UTC';
      billable = await recordCharge(client, { campaignId: c.c, costMicros: cost, kind: e.type === 'click' ? 'click' : 'impression', day: dayInZone(e.receivedAt, tz) });
      if (billable) {
        const pub = applyBps(cost, Math.max(0, Math.min(10000, c.sh)));
        await client.query('UPDATE ad_events SET billable = true, cost_micros = $2, publisher_micros = $3 WHERE id = $1', [ins.rows[0].id, cost.toString(), pub.toString()]);
      }
    }
    return { status: result.valid ? 'valid' as const : 'invalid' as const, reason: result.reason, billable };
  });
}

/** Recompute the reporting aggregates for one UTC day from event rows. Safe to run repeatedly. */
export async function aggregateDay(db: AppContext['db'], day: string) {
  await withTransaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agg:${day}`]);
    await c.query('DELETE FROM daily_stats WHERE day = $1', [day]);
    // Conversions count on the day they happen, attributed to the click's campaign, placement and audience.
    await c.query(
      `INSERT INTO daily_stats (day, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, os, browser, source, served, rendered, valid_impressions, invalid_impressions,
         viewable_impressions, valid_clicks, invalid_clicks, billable_impressions, billable_clicks, spend_micros, publisher_micros, in_view_ms, in_view_samples, conversions, conversion_value_micros)
       SELECT $1::date, campaign_id, creative_id, min(advertiser_org_id::text)::uuid, site_id, unit_id, min(publisher_org_id::text)::uuid, country, device, os, browser, source,
         sum(served), sum(rendered), sum(valid_impressions), sum(invalid_impressions), sum(viewable_impressions), sum(valid_clicks), sum(invalid_clicks),
         sum(billable_impressions), sum(billable_clicks), sum(spend_micros), sum(publisher_micros), sum(in_view_ms), sum(in_view_samples), sum(conversions), sum(conversion_value_micros)
       FROM (
         SELECT campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, os, browser, source,
           count(*) FILTER (WHERE type = 'served') AS served,
           count(*) FILTER (WHERE type = 'render') AS rendered,
           count(*) FILTER (WHERE type = 'render' AND status = 'valid') AS valid_impressions,
           count(*) FILTER (WHERE type = 'render' AND status = 'invalid') AS invalid_impressions,
           count(*) FILTER (WHERE type = 'viewable' AND status = 'valid') AS viewable_impressions,
           count(*) FILTER (WHERE type = 'click' AND status = 'valid') AS valid_clicks,
           count(*) FILTER (WHERE type = 'click' AND status = 'invalid') AS invalid_clicks,
           count(*) FILTER (WHERE type = 'render' AND billable) AS billable_impressions,
           count(*) FILTER (WHERE type = 'click' AND billable) AS billable_clicks,
           COALESCE(sum(cost_micros) FILTER (WHERE billable), 0) AS spend_micros,
           COALESCE(sum(publisher_micros) FILTER (WHERE billable), 0) AS publisher_micros,
           COALESCE(sum(in_view_ms) FILTER (WHERE type = 'inview' AND status = 'valid'), 0) AS in_view_ms,
           count(*) FILTER (WHERE type = 'inview' AND status = 'valid') AS in_view_samples,
           0::bigint AS conversions, 0::bigint AS conversion_value_micros
         FROM ad_events WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1
         GROUP BY campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, os, browser, source
         UNION ALL
         SELECT campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, os, browser, source,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, count(*), COALESCE(sum(value_micros), 0)
         FROM conversions WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1
         GROUP BY campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, os, browser, source
       ) x
       GROUP BY campaign_id, creative_id, site_id, unit_id, country, device, os, browser, source`, [day]);
    await c.query('DELETE FROM page_daily_stats WHERE day = $1', [day]);
    await c.query(
      `INSERT INTO page_daily_stats (day, site_id, publisher_org_id, page_path, valid_impressions, valid_clicks, publisher_micros)
       SELECT $1::date, site_id, publisher_org_id, page_path,
         count(*) FILTER (WHERE type = 'render' AND status = 'valid'),
         count(*) FILTER (WHERE type = 'click' AND status = 'valid'),
         COALESCE(sum(publisher_micros) FILTER (WHERE billable), 0)
       FROM ad_events WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1 AND page_path IS NOT NULL
       GROUP BY site_id, publisher_org_id, page_path`, [day]);
    await c.query(`DELETE FROM hourly_stats WHERE hour >= $1::date AND hour < $1::date + 1`, [day]);
    await c.query(
      `INSERT INTO hourly_stats (hour, campaign_id, advertiser_org_id, site_id, publisher_org_id, valid_impressions, viewable_impressions, valid_clicks, spend_micros, publisher_micros)
       SELECT date_trunc('hour', occurred_at), campaign_id, min(advertiser_org_id::text)::uuid, site_id, min(publisher_org_id::text)::uuid,
         count(*) FILTER (WHERE type = 'render' AND status = 'valid'),
         count(*) FILTER (WHERE type = 'viewable' AND status = 'valid'),
         count(*) FILTER (WHERE type = 'click' AND status = 'valid'),
         COALESCE(sum(cost_micros) FILTER (WHERE billable), 0),
         COALESCE(sum(publisher_micros) FILTER (WHERE billable), 0)
       FROM ad_events WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1 AND type IN ('render', 'viewable', 'click')
       GROUP BY 1, campaign_id, site_id`, [day]);
    await c.query('DELETE FROM ivt_daily_stats WHERE day = $1', [day]);
    await c.query(
      `INSERT INTO ivt_daily_stats (day, campaign_id, advertiser_org_id, site_id, publisher_org_id, type, reason, events)
       SELECT $1::date, campaign_id, min(advertiser_org_id::text)::uuid, site_id, min(publisher_org_id::text)::uuid, type, COALESCE(invalid_reason, 'unknown'), count(*)
       FROM ad_events WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1 AND status = 'invalid'
       GROUP BY campaign_id, site_id, type, COALESCE(invalid_reason, 'unknown')`, [day]);
  });
}

/**
 * Flat-rate sponsorships: each day's share of the sponsorship price is
 * allocated across that day's valid rendered impressions, making them
 * billable so they flow through the same settlement and ledger path.
 */
export async function allocateFlatRate(db: AppContext['db'], day: string) {
  const camps = (await db.query(
    `SELECT id, rate_micros, lifetime_budget_micros, spent_micros, start_at, end_at FROM campaigns WHERE pricing_model = 'flat' AND status IN ('active', 'paused', 'completed')
     AND start_at < $1::date + 1 AND end_at > $1::date`, [day])).rows;
  let allocated = 0;
  for (const c of camps) {
    await withTransaction(db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`flat:${c.id}`]);
      const done = await client.query(`SELECT 1 FROM ad_events WHERE campaign_id = $1 AND type = 'render' AND billable AND occurred_at >= $2::date AND occurred_at < $2::date + 1 LIMIT 1`, [c.id, day]);
      if (done.rowCount) return;
      const events = (await client.query<{ id: string; publisher_share: number }>(
        `SELECT e.id, COALESCE(s.revenue_share_bps, o.revenue_share_bps, 7000) AS publisher_share FROM ad_events e JOIN sites s ON s.id = e.site_id JOIN organizations o ON o.id = s.org_id
         WHERE e.campaign_id = $1 AND e.type = 'render' AND e.status = 'valid' AND NOT e.billable AND e.occurred_at >= $2::date AND e.occurred_at < $2::date + 1 ORDER BY e.occurred_at`, [c.id, day])).rows;
      if (events.length === 0) return;
      const days = BigInt(Math.max(1, Math.ceil((new Date(c.end_at).getTime() - new Date(c.start_at).getTime()) / 86_400_000)));
      const remaining = BigInt(c.lifetime_budget_micros) - BigInt(c.spent_micros);
      let total = BigInt(c.rate_micros) / days;
      if (total > remaining) total = remaining;
      if (total <= 0n) return;
      const ok = await recordCharge(client, { campaignId: c.id, costMicros: total, kind: 'impression', day });
      if (!ok) return;
      const n = BigInt(events.length);
      const each = total / n;
      let rest = total - each * n;
      for (const ev of events) {
        const cost = each + (rest > 0n ? 1n : 0n);
        if (rest > 0n) rest -= 1n;
        await client.query('UPDATE ad_events SET billable = true, cost_micros = $2, publisher_micros = $3 WHERE id = $1', [ev.id, cost.toString(), applyBps(cost, ev.publisher_share).toString()]);
      }
      // recordCharge counted one impression; correct the counter to the real number.
      await client.query('UPDATE campaigns SET billable_impressions = billable_impressions + $2 WHERE id = $1', [c.id, events.length - 1]);
      allocated++;
    });
  }
  return allocated;
}
