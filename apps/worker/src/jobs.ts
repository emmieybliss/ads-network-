import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { applyGuarantee, finalizeEarnings, issueInvoice, releaseCampaignReserve, settleCampaign } from '@blissnova/billing';
import { withTransaction } from '@blissnova/database';
import { formatMoney, type PlatformSettings } from '@blissnova/shared';
import { aggregateDay, allocateFlatRate } from '@blissnova/api/services/events';
import { dayInZone, invalidateServingCache } from '@blissnova/api/services/serving';
import { sendDueReports } from '@blissnova/api/services/report-emails';
import { syncPartnerCampaigns, type PartnerRegistry } from '@blissnova/api/services/partners';

export interface JobCtx { db: Pool; redis: Redis; settings: () => Promise<PlatformSettings>; partners: PartnerRegistry; publicUrl: (storageKey: string) => string; log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void }; notify: (orgId: string, n: { type: string; title: string; body?: string; link?: string; template?: string; vars?: Record<string, string | number | undefined>; roles?: string[] }) => Promise<void>;
  /** Queue one templated email to one address. */
  email: (to: string, template: string, vars: Record<string, string | number | undefined>) => Promise<void>;
  /** Public dashboard URL, for links in emails. */
  siteUrl: string;
}

interface StatementAccum { currency: string; lines: Array<{ description: string; amountMicros: string }>; total: bigint }

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Near-real-time reporting: recompute today's aggregate (and yesterday's shortly after midnight UTC). */
export async function refreshAggregates(ctx: JobCtx) {
  await aggregateDay(ctx.db, today());
  if (new Date().getUTCHours() < 1) await aggregateDay(ctx.db, yesterday());
}

/** Scheduled -> active at start time; active -> completed at end time or when the budget is exhausted. */
export async function campaignLifecycle(ctx: JobCtx) {
  const s = await ctx.settings();
  const started = await ctx.db.query(`UPDATE campaigns SET status = 'active', updated_at = now() WHERE status = 'scheduled' AND start_at <= now() RETURNING id`);
  for (const r of started.rows) await ctx.db.query(`INSERT INTO campaign_history (campaign_id, action, before, after) VALUES ($1, 'started', '{"status":"scheduled"}', '{"status":"active"}')`, [r.id]);
  const done = (await ctx.db.query(`SELECT id, org_id, name, CASE WHEN end_at IS NOT NULL AND end_at <= now() THEN 'end_date' ELSE 'budget' END AS why FROM campaigns
    WHERE status IN ('active', 'paused', 'scheduled') AND ((end_at IS NOT NULL AND end_at <= now()) OR (pricing_model <> 'flat' AND lifetime_budget_micros - spent_micros < GREATEST(rate_micros / 1000, 1)))`)).rows;
  for (const c of done) {
    await withTransaction(ctx.db, async (cl) => {
      const row = (await cl.query(`UPDATE campaigns SET status = 'completed', status_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('active', 'paused', 'scheduled') RETURNING id`, [c.id, c.why === 'end_date' ? 'Reached end date' : 'Budget exhausted'])).rows[0];
      if (!row) return;
      await cl.query(`INSERT INTO campaign_history (campaign_id, action, after, reason) VALUES ($1, 'completed', '{"status":"completed"}', $2)`, [c.id, c.why]);
      await releaseCampaignReserve(cl, c.id, { type: 'system' }, `Campaign completed (${c.why === 'end_date' ? 'end date' : 'budget exhausted'})`, s.publishers.earningsHoldDays);
    });
    await ctx.notify(c.org_id, { type: 'campaign_completed', title: `Campaign completed: ${c.name}`, link: `/advertiser/campaigns/${c.id}` }).catch(() => undefined);
  }
  if (started.rowCount || done.length) invalidateServingCache({ redis: ctx.redis });
  return { started: started.rowCount, completed: done.length };
}

/** Turn billable events into ledger charges, then finalize publisher earnings past their hold period. */
export async function settleAll(ctx: JobCtx) {
  const s = await ctx.settings();
  const camps = (await ctx.db.query(`SELECT DISTINCT campaign_id FROM ad_events WHERE billable AND settlement_id IS NULL`)).rows;
  let n = 0;
  for (const c of camps) n += (await withTransaction(ctx.db, (cl) => settleCampaign(cl, c.campaign_id, s.publishers.earningsHoldDays))).length;
  const finalized = await withTransaction(ctx.db, (cl) => finalizeEarnings(cl));
  return { settlements: n, finalized };
}

/** Push live campaigns to partner networks and bring their delivery and cost back. */
export async function syncPartners(ctx: JobCtx) {
  return syncPartnerCampaigns({ db: ctx.db, partners: ctx.partners, publicUrl: ctx.publicUrl, log: ctx.log });
}

/** Keep the serve-time spend estimates aligned with actual billed spend. */
export async function syncSpendCounters(ctx: JobCtx) {
  const rows = (await ctx.db.query(`SELECT c.id, c.timezone, COALESCE(d.spent_micros, 0)::text AS spent FROM campaigns c LEFT JOIN campaign_daily_spend d ON d.campaign_id = c.id AND d.day = (now() AT TIME ZONE c.timezone)::date WHERE c.status IN ('active', 'paused')`)).rows;
  for (const r of rows) {
    const key = `spend:${r.id}:${dayInZone(Date.now(), r.timezone)}`;
    const cur = BigInt((await ctx.redis.get(key)) ?? '0');
    // Serve-time estimates include ads that never rendered; never lower below billed spend.
    if (cur > BigInt(r.spent)) await ctx.redis.set(key, r.spent, 'EX', 3 * 86400);
  }
}

/** Budget alerts at 80% and 100%, sent once per campaign and threshold. */
export async function budgetAlerts(ctx: JobCtx) {
  const rows = (await ctx.db.query(`SELECT id, org_id, name, spent_micros, lifetime_budget_micros FROM campaigns WHERE status IN ('active', 'paused', 'completed') AND spent_micros * 100 >= lifetime_budget_micros * 80`)).rows;
  for (const r of rows) {
    const pct = Number((BigInt(r.spent_micros) * 100n) / BigInt(r.lifetime_budget_micros));
    const threshold = pct >= 100 ? 100 : 80;
    if ((await ctx.redis.set(`alert:budget:${r.id}:${threshold}`, '1', 'NX')) !== 'OK') continue;
    await ctx.notify(r.org_id, { type: 'budget_alert', title: `${r.name} has used ${threshold}% of its budget`, link: `/advertiser/campaigns/${r.id}`, template: 'budget_alert', vars: { campaignName: r.name, percent: threshold }, roles: ['owner', 'manager'] });
  }
}

/** Low unreserved balance alerts for advertisers with live campaigns. */
export async function lowBalanceAlerts(ctx: JobCtx) {
  const rows = (await ctx.db.query(
    `SELECT a.org_id, a.currency, (-COALESCE(sum(e.amount_micros), 0))::text AS bal FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
     WHERE a.kind = 'advertiser_wallet' AND EXISTS (SELECT 1 FROM campaigns c WHERE c.org_id = a.org_id AND c.status IN ('active', 'scheduled')) GROUP BY a.org_id, a.currency`)).rows;
  for (const r of rows) {
    if (BigInt(r.bal) >= 10_000_000n) continue; // below 10 currency units
    if ((await ctx.redis.set(`alert:lowbal:${r.org_id}:${today()}`, '1', 'EX', 86400 * 2, 'NX')) !== 'OK') continue;
    await ctx.notify(r.org_id, { type: 'low_balance', title: 'Low account balance', link: '/advertiser/billing', template: 'low_balance', vars: { balance: formatMoney(r.bal, r.currency) }, roles: ['owner'] });
  }
}

/**
 * Anomaly detection over today's aggregates. Alerts open review items; they
 * never invalidate traffic automatically. A high CTR alone is a prompt to look,
 * not proof of fraud.
 */
export async function detectAnomalies(ctx: JobCtx) {
  const s = await ctx.settings();
  const day = today();
  const rows = (await ctx.db.query(
    `SELECT site_id, sum(valid_impressions)::bigint AS imps, sum(valid_clicks)::bigint AS clicks, sum(rendered)::bigint AS rendered, sum(invalid_impressions)::bigint AS invalid
     FROM daily_stats WHERE day = $1 GROUP BY site_id`, [day])).rows;
  let created = 0;
  for (const r of rows) {
    const imps = Number(r.imps);
    const ctrPct = imps ? (Number(r.clicks) / imps) * 100 : 0;
    if (imps >= s.ivt.ctrAlertMinImpressions && ctrPct >= s.ivt.ctrAlertPercent) {
      const ins = await ctx.db.query(`INSERT INTO anomaly_alerts (kind, subject_type, subject_id, detail, day) VALUES ('ctr_spike', 'site', $1, $2, $3) ON CONFLICT DO NOTHING`, [r.site_id, JSON.stringify({ ctr: ctrPct, impressions: imps, clicks: Number(r.clicks) }), day]);
      created += ins.rowCount ?? 0;
    }
    const rendered = Number(r.rendered);
    if (rendered >= 200 && Number(r.invalid) / rendered > 0.3) {
      const ins = await ctx.db.query(`INSERT INTO anomaly_alerts (kind, subject_type, subject_id, detail, day) VALUES ('invalid_rate', 'site', $1, $2, $3) ON CONFLICT DO NOTHING`, [r.site_id, JSON.stringify({ invalidRate: (Number(r.invalid) / rendered) * 100, rendered }), day]);
      created += ins.rowCount ?? 0;
    }
  }
  const domainMismatch = (await ctx.db.query(`SELECT site_id, count(*)::int AS n FROM ad_events WHERE invalid_reason = 'domain_mismatch' AND occurred_at > now() - interval '1 hour' GROUP BY site_id HAVING count(*) >= 50`)).rows;
  for (const r of domainMismatch) {
    const ins = await ctx.db.query(`INSERT INTO anomaly_alerts (kind, subject_type, subject_id, detail, day) VALUES ('invalid_domain', 'site', $1, $2, $3) ON CONFLICT DO NOTHING`, [r.site_id, JSON.stringify({ lastHour: r.n }), day]);
    created += ins.rowCount ?? 0;
  }
  return created;
}

/** Guaranteed minimum earnings for premium publishers, for one finished UTC day. Idempotent per organization and day. */
export async function applyGuarantees(ctx: JobCtx, day = yesterday()) {
  const s = await ctx.settings();
  const orgs = (await ctx.db.query<{ id: string }>(`SELECT id FROM organizations WHERE type = 'publisher' AND tier = 'premium' AND earnings_mode = 'guarantee'`)).rows;
  let topups = 0;
  for (const o of orgs) {
    const r = await withTransaction(ctx.db, (cl) => applyGuarantee(cl, o.id, day, s.publishers.earningsHoldDays));
    if (r?.created && r.topup > 0n) {
      topups++;
      await ctx.notify(o.id, { type: 'guarantee_topup', title: 'Guaranteed minimum applied', body: `Your earnings for ${day} were topped up to your guaranteed minimum${r.capped ? ' (limited by the monthly cap)' : ''}.`, link: '/publisher/earnings', roles: ['owner', 'manager'] }).catch(() => undefined);
    }
  }
  return topups;
}

/** Flat-rate allocation for the previous day, monthly statements, payment expiry and retention purge. */
export async function dailyMaintenance(ctx: JobCtx) {
  const s = await ctx.settings();
  const flat = await allocateFlatRate(ctx.db, yesterday());
  if (flat) await aggregateDay(ctx.db, yesterday());
  const guaranteeTopups = await applyGuarantees(ctx);
  await ctx.db.query(`UPDATE payments SET status = 'cancelled', failure_reason = 'Expired without confirmation', updated_at = now() WHERE status = 'pending' AND created_at < now() - interval '14 days'`);
  // Raw events past retention are removed only once settled or non-billable; aggregates and settlements keep long-term history.
  const purged = await ctx.db.query(`DELETE FROM ad_events WHERE occurred_at < now() - make_interval(days => $1) AND (settlement_id IS NOT NULL OR NOT billable)`, [s.tracking.rawEventRetentionDays]);
  await ctx.db.query(`DELETE FROM daily_stats WHERE day < CURRENT_DATE - $1::int`, [s.tracking.aggregateRetentionDays]);
  await ctx.db.query(`DELETE FROM hourly_stats WHERE hour < CURRENT_DATE - $1::int`, [s.tracking.aggregateRetentionDays]);
  await ctx.db.query(`DELETE FROM ivt_daily_stats WHERE day < CURRENT_DATE - $1::int`, [s.tracking.aggregateRetentionDays]);
  await ctx.db.query(`DELETE FROM site_traffic_daily WHERE day < CURRENT_DATE - $1::int`, [s.tracking.aggregateRetentionDays]);
  await ctx.db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`);
  await ctx.db.query(`DELETE FROM user_tokens WHERE expires_at < now() - interval '7 days'`);
  let statements = 0;
  const now = new Date();
  if (now.getUTCDate() === 1) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const orgs = (await ctx.db.query(
      `SELECT c.org_id, c.currency, c.name, sum(s.charge_micros - s.reversed_micros)::text AS total FROM settlements s JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.created_at::date BETWEEN $1 AND $2 GROUP BY c.org_id, c.currency, c.name`, [start, end])).rows;
    const byOrg = new Map<string, StatementAccum>();
    for (const o of orgs) {
      const e: StatementAccum = byOrg.get(o.org_id) ?? { currency: o.currency, lines: [], total: 0n };
      e.lines.push({ description: `Advertising charges: ${o.name}`, amountMicros: o.total });
      e.total += BigInt(o.total);
      byOrg.set(o.org_id, e);
    }
    for (const [orgId, e] of byOrg) {
      const inv = await withTransaction(ctx.db, (cl) => issueInvoice(cl, { orgId, kind: 'statement', currency: e.currency, total: e.total, lines: e.lines, periodStart: start, periodEnd: end, prefix: s.pricing.invoicePrefix }));
      if (inv) statements++;
    }
  }
  return { flat, guaranteeTopups, purged: purged.rowCount, statements };
}

/** Scheduled performance report emails whose latest complete period has not gone out yet. */
export async function reportEmails(ctx: JobCtx, now = new Date()) {
  const sent = await sendDueReports(ctx.db, (to, vars) => ctx.email(to, 'performance_report', vars), ctx.siteUrl, now);
  if (sent) ctx.log.info({ sent }, 'performance report emails queued');
  return sent;
}
