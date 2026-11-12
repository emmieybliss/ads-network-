import { excludeEvents } from '@blissnova/billing';
import { withTransaction } from '@blissnova/database';
import type { PlatformSettings } from '@blissnova/shared';
import type { AppContext } from '../lib/context';
import { aggregateDay } from './events';

/**
 * Invalid-traffic follow-up that needs more than one event to see:
 *  - publisher IVT rates over a period,
 *  - excluding events by criteria (staff exclusions and clawbacks share it),
 *  - the sweep that runs on a timer: it reverses earnings still on hold for
 *    traffic proven invalid after the fact, and opens review cases for staff.
 */
type Db = AppContext['db'];

export interface ExclusionCriteria {
  eventIds?: string[];
  siteId?: string; campaignId?: string; unitId?: string; publisherOrgId?: string;
  ipHash?: string; visitorHash?: string;
  from?: string; to?: string;
  types?: Array<'render' | 'viewable' | 'click'>;
  /** Only events that passed but scored at least this much (suspicious, under the threshold). */
  minScore?: number;
}

export class CriteriaError extends Error {}

function whereFor(c: ExclusionCriteria, opts: { pendingOnly?: boolean } = {}) {
  const clauses = ['e.excluded_at IS NULL', `e.type <> 'served'`];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); clauses.push(sql.replaceAll('?', `$${params.length}`)); };
  const base = clauses.length;
  if (c.eventIds?.length) add('e.id = ANY(?::uuid[])', c.eventIds);
  if (c.siteId) add('e.site_id = ?', c.siteId);
  if (c.campaignId) add('e.campaign_id = ?', c.campaignId);
  if (c.unitId) add('e.unit_id = ?', c.unitId);
  if (c.publisherOrgId) add('e.publisher_org_id = ?', c.publisherOrgId);
  if (c.ipHash) add('e.ip_hash = ?', c.ipHash);
  if (c.visitorHash) add('e.visitor_hash = ?', c.visitorHash);
  if (c.from) add('e.occurred_at >= ?', c.from);
  if (c.to) add('e.occurred_at < ?', c.to);
  if (c.types?.length) add('e.type = ANY(?)', c.types);
  if (c.minScore !== undefined) { add('e.ivt_score >= ?', c.minScore); clauses.push(`e.status = 'valid'`); }
  if (clauses.length === base) throw new CriteriaError('Provide at least one criterion');
  if (!c.eventIds?.length && !(c.from && c.to)) throw new CriteriaError('Bulk exclusions need a time window (from and to)');
  // Automatic clawbacks never touch earnings that already became available.
  if (opts.pendingOnly) clauses.push('(e.settlement_id IS NULL OR NOT EXISTS (SELECT 1 FROM settlements st WHERE st.id = e.settlement_id AND st.finalized_at IS NOT NULL))');
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

export interface ExclusionPreview { matched: number; billable: number; billableMicros: string; publisherMicros: string }

export async function previewExclusion(db: Db, c: ExclusionCriteria, opts: { pendingOnly?: boolean } = {}) {
  const w = whereFor(c, opts);
  const rows = (await db.query<{ id: string; occurred_at: string; billable: boolean; cost_micros: string; publisher_micros: string; publisher_org_id: string }>(
    `SELECT e.id, e.occurred_at, e.billable, e.cost_micros, e.publisher_micros, e.publisher_org_id FROM ad_events e ${w.sql} LIMIT 50001`, w.params)).rows;
  if (rows.length > 50000) throw new CriteriaError('More than 50,000 events match; narrow the criteria');
  const bill = rows.filter((m) => m.billable);
  const preview: ExclusionPreview = {
    matched: rows.length, billable: bill.length,
    billableMicros: bill.reduce((a, m) => a + BigInt(m.cost_micros), 0n).toString(),
    publisherMicros: bill.reduce((a, m) => a + BigInt(m.publisher_micros), 0n).toString(),
  };
  return { rows, preview };
}

/** Exclude matching events, record the exclusion against the case and refresh reports for the days touched. */
export async function excludeByCriteria(db: Db, a: {
  criteria: ExclusionCriteria; caseId: string; reason: string;
  actor: { type: 'user'; userId: string } | { type: 'system' };
  pendingOnly?: boolean;
  onCommit?: (cl: import('pg').PoolClient, r: { excluded: number; reversed: bigint; publisherReversed: bigint }) => Promise<void>;
}) {
  const { rows } = await previewExclusion(db, a.criteria, { pendingOnly: a.pendingOnly });
  const automatic = a.actor.type === 'system';
  const byOrg = new Map<string, string[]>();
  for (const r of rows) byOrg.set(r.publisher_org_id, [...(byOrg.get(r.publisher_org_id) ?? []), r.id]);
  const total = { excluded: 0, reversed: 0n, publisherReversed: 0n };
  await withTransaction(db, async (cl) => {
    for (const [orgId, ids] of byOrg) {
      const r = await excludeEvents(cl, { eventIds: ids, actor: a.actor, reason: a.reason, caseId: a.caseId, invalidReason: automatic ? 'ivt_clawback' : 'manual_exclusion' });
      if (!r.excluded) continue;
      await cl.query(
        'INSERT INTO event_exclusions (case_id, criteria, excluded_events, reversed_micros, reason, actor_id, automatic, publisher_org_id, publisher_micros) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [a.caseId, JSON.stringify(a.criteria.eventIds ? { ...a.criteria, eventIds: `${a.criteria.eventIds.length} events` } : a.criteria), r.excluded, r.reversed.toString(), a.reason, a.actor.type === 'user' ? a.actor.userId : null, automatic, orgId, r.publisherReversed.toString()]);
      total.excluded += r.excluded;
      total.reversed += r.reversed;
      total.publisherReversed += r.publisherReversed;
    }
    if (a.onCommit) await a.onCommit(cl, total);
  });
  const days = [...new Set(rows.map((m) => new Date(m.occurred_at).toISOString().slice(0, 10)))];
  for (const d of days) await aggregateDay(db, d);
  return { ...total, days };
}

// ---------------------------------------------------------------- publisher rates

export type QualityStatus = 'healthy' | 'watch' | 'review' | 'low_volume';

export function qualityStatus(rate: number | null, rendered: number, s: PlatformSettings['ivt']): QualityStatus {
  if (rate === null || rendered < s.publisherReviewMinImpressions) return 'low_volume';
  if (rate >= s.publisherReviewIvtPercent) return 'review';
  if (rate >= s.publisherReviewIvtPercent / 2) return 'watch';
  return 'healthy';
}

const pct = (part: number, whole: number) => (whole ? (part / whole) * 100 : null);

/** IVT rates per publisher for [from, to] (inclusive days), with the previous period of the same length for the trend. */
export async function publisherIvtRates(db: Db, from: string, to: string, opts: { orgId?: string } = {}) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const prevFrom = new Date(Date.parse(from) - days * 86_400_000).toISOString().slice(0, 10);
  const prevTo = new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10);
  const rows = (await db.query(
    `WITH cur AS (
       SELECT publisher_org_id AS org_id, sum(rendered)::bigint AS rendered, sum(invalid_impressions)::bigint AS invalid_imps,
         sum(valid_clicks)::bigint AS clicks, sum(invalid_clicks)::bigint AS invalid_clicks, sum(publisher_micros)::bigint AS earnings
       FROM daily_stats WHERE day BETWEEN $1 AND $2 AND ($5::uuid IS NULL OR publisher_org_id = $5) GROUP BY 1),
     prev AS (
       SELECT publisher_org_id AS org_id, sum(rendered)::bigint AS rendered, sum(invalid_impressions)::bigint AS invalid_imps
       FROM daily_stats WHERE day BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR publisher_org_id = $5) GROUP BY 1),
     top AS (
       SELECT DISTINCT ON (publisher_org_id) publisher_org_id AS org_id, reason FROM (
         SELECT publisher_org_id, reason, sum(events) AS n FROM ivt_daily_stats WHERE day BETWEEN $1 AND $2 AND reason <> 'duplicate' AND ($5::uuid IS NULL OR publisher_org_id = $5) GROUP BY 1, 2) x
       ORDER BY publisher_org_id, n DESC),
     claw AS (
       SELECT publisher_org_id AS org_id, sum(publisher_micros)::bigint AS clawed, sum(excluded_events)::bigint AS excluded
       FROM event_exclusions WHERE created_at >= $1::date AND created_at < $2::date + 1 AND publisher_org_id IS NOT NULL AND ($5::uuid IS NULL OR publisher_org_id = $5) GROUP BY 1)
     SELECT o.id, o.name, cur.rendered, cur.invalid_imps, cur.clicks, cur.invalid_clicks, cur.earnings, prev.rendered AS prev_rendered, prev.invalid_imps AS prev_invalid,
       top.reason AS top_reason, COALESCE(claw.clawed, 0)::bigint AS clawed_micros, COALESCE(claw.excluded, 0)::bigint AS clawed_events,
       (SELECT count(*)::int FROM fraud_cases f WHERE f.publisher_org_id = o.id AND f.status IN ('open', 'investigating', 'appealed')) AS open_cases
     FROM cur JOIN organizations o ON o.id = cur.org_id LEFT JOIN prev ON prev.org_id = cur.org_id LEFT JOIN top ON top.org_id = cur.org_id LEFT JOIN claw ON claw.org_id = cur.org_id`,
    [from, to, prevFrom, prevTo, opts.orgId ?? null])).rows;
  return rows.map((r) => {
    const rendered = Number(r.rendered);
    const clicksAll = Number(r.clicks) + Number(r.invalid_clicks);
    return {
      orgId: r.id as string, name: r.name as string, rendered, invalidImpressions: Number(r.invalid_imps), clicks: Number(r.clicks), invalidClicks: Number(r.invalid_clicks),
      ivtRate: pct(Number(r.invalid_imps), rendered), invalidClickRate: pct(Number(r.invalid_clicks), clicksAll),
      previousRate: r.prev_rendered ? pct(Number(r.prev_invalid), Number(r.prev_rendered)) : null,
      topReason: (r.top_reason as string | null) ?? null, earningsMicros: String(r.earnings ?? 0), clawedMicros: String(r.clawed_micros), clawedEvents: Number(r.clawed_events), openCases: r.open_cases as number,
    };
  });
}

// ---------------------------------------------------------------- the sweep

export interface SweepCtx {
  db: Db;
  settings: () => Promise<PlatformSettings>;
  notify: (orgId: string, n: { type: string; title: string; body?: string; link?: string; roles?: string[] }) => Promise<void>;
  log?: { info: (o: object, m?: string) => void };
}

interface Finding { rule: 'proven_bot' | 'click_farm'; orgId: string; eventIds: string[]; visitors: number; detail: Record<string, unknown> }

const RULE_TEXT: Record<Finding['rule'], { title: string; outcome: string; severity: 'high' | 'medium' }> = {
  proven_bot: { title: 'Automated visitors found after the fact', outcome: 'Visitors later proven automated (browser automation, data-center network or scripted click timing). Their other events from the same day were removed from billing.', severity: 'high' },
  click_farm: { title: 'Excessive clicks from the same visitors', outcome: 'Visitors clicked far more ads in one day than people do. Those clicks were removed from billing.', severity: 'medium' },
};

/** Valid events from the last 24 hours that later evidence shows are not human. */
async function findInvalidAfterTheFact(db: Db, s: PlatformSettings['ivt'], now: Date): Promise<Finding[]> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const out: Finding[] = [];
  // 1. A visitor (or a data-center IP) that tripped a definite bot check taints its other events.
  const bots = (await db.query<{ id: string; publisher_org_id: string; who: string }>(
    `WITH bad AS (
       SELECT DISTINCT visitor_hash AS v, NULL::text AS ip FROM ad_events WHERE occurred_at >= $1 AND status = 'invalid' AND invalid_reason IN ('automation', 'click_pattern', 'datacenter') AND visitor_hash IS NOT NULL
       UNION SELECT DISTINCT NULL, ip_hash FROM ad_events WHERE occurred_at >= $1 AND status = 'invalid' AND invalid_reason = 'datacenter' AND ip_hash IS NOT NULL)
     SELECT e.id, e.publisher_org_id, COALESCE(e.visitor_hash, e.ip_hash) AS who FROM ad_events e
     WHERE e.occurred_at >= $1 AND e.status = 'valid' AND e.excluded_at IS NULL AND e.type IN ('render', 'viewable', 'click')
       AND (e.visitor_hash IN (SELECT v FROM bad WHERE v IS NOT NULL) OR e.ip_hash IN (SELECT ip FROM bad WHERE ip IS NOT NULL))
     LIMIT 20000`, [since])).rows;
  out.push(...group('proven_bot', bots));
  // 2. Visitors with an implausible number of valid clicks in a day.
  const farm = (await db.query<{ id: string; publisher_org_id: string; who: string }>(
    `WITH heavy AS (
       SELECT visitor_hash FROM ad_events WHERE occurred_at >= $1 AND type = 'click' AND status = 'valid' AND excluded_at IS NULL AND visitor_hash IS NOT NULL
       GROUP BY visitor_hash HAVING count(*) > $2)
     SELECT e.id, e.publisher_org_id, e.visitor_hash AS who FROM ad_events e JOIN heavy h ON h.visitor_hash = e.visitor_hash
     WHERE e.occurred_at >= $1 AND e.type = 'click' AND e.status = 'valid' AND e.excluded_at IS NULL LIMIT 20000`, [since, s.clawbackClicksPerVisitorPerDay])).rows;
  out.push(...group('click_farm', farm, { clicksPerDayLimit: s.clawbackClicksPerVisitorPerDay }));
  return out;
}

function group(rule: Finding['rule'], rows: Array<{ id: string; publisher_org_id: string; who: string }>, detail: Record<string, unknown> = {}): Finding[] {
  const m = new Map<string, { ids: string[]; who: Set<string> }>();
  for (const r of rows) {
    const g = m.get(r.publisher_org_id) ?? { ids: [], who: new Set<string>() };
    g.ids.push(r.id);
    g.who.add(r.who);
    m.set(r.publisher_org_id, g);
  }
  return [...m].map(([orgId, g]) => ({ rule, orgId, eventIds: g.ids.slice(0, 5000), visitors: g.who.size, detail }));
}

/**
 * One case per publisher, rule and day: later sweeps the same day update it.
 * A clawback case adds up what each sweep reversed; a review case keeps the
 * latest proposal.
 */
async function caseFor(db: Db, a: { key: string; orgId: string; kind: string; title: string; severity: string; status: 'open' | 'confirmed'; outcome: string | null; signals: object; criteria: object | null; estimated: bigint }) {
  const accumulate = a.status === 'confirmed';
  const r = await db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO fraud_cases (subject_type, subject_id, title, severity, status, outcome, signals, source, kind, publisher_org_id, criteria, estimated_micros, dedup_key, resolved_at)
     VALUES ('organization', $1, $2, $3, $4, $5, $6, 'auto', $7, $1, $8, $9, $10, CASE WHEN $4 = 'confirmed' THEN now() END)
     ON CONFLICT (dedup_key) DO UPDATE SET signals = fraud_cases.signals || EXCLUDED.signals, criteria = COALESCE(EXCLUDED.criteria, fraud_cases.criteria),
       estimated_micros = CASE WHEN $11::boolean THEN fraud_cases.estimated_micros + EXCLUDED.estimated_micros ELSE EXCLUDED.estimated_micros END, updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [a.orgId, a.title, a.severity, a.status, a.outcome, JSON.stringify(a.signals), a.kind, a.criteria ? JSON.stringify(a.criteria) : null, a.estimated.toString(), a.key, accumulate]);
  return r.rows[0]!;
}

export interface SweepResult { clawbacks: number; reversedMicros: string; publisherMicros: string; reviewCases: number }

/**
 * The invalid-traffic sweep. With automatic clawback on, events proven
 * invalid after the fact are excluded at once, but only while the
 * publisher's earnings for them are still on hold; anything older goes to
 * the review queue. Publishers whose IVT rate is too high get a review case.
 */
export async function runIvtSweep(ctx: SweepCtx, now = new Date()): Promise<SweepResult> {
  const s = await ctx.settings();
  const day = now.toISOString().slice(0, 10);
  const res = { clawbacks: 0, reversed: 0n, publisher: 0n, reviewCases: 0 };
  for (const f of await findInvalidAfterTheFact(ctx.db, s.ivt, now)) {
    const text = RULE_TEXT[f.rule];
    const criteria: ExclusionCriteria = { eventIds: f.eventIds };
    const held = (await previewExclusion(ctx.db, criteria, { pendingOnly: true })).preview;
    const auto = s.ivt.autoClawback && held.matched > 0;
    const preview = auto ? held : (await previewExclusion(ctx.db, criteria)).preview;
    const c = await caseFor(ctx.db, {
      key: `auto:${f.rule}:${f.orgId}:${day}:${auto ? 'claw' : 'review'}`, orgId: f.orgId, kind: f.rule, title: text.title, severity: text.severity,
      status: auto ? 'confirmed' : 'open', outcome: auto ? text.outcome : null,
      signals: { rule: f.rule, visitors: f.visitors, events: f.eventIds.length, ...f.detail }, criteria: auto ? null : criteria, estimated: BigInt(preview.publisherMicros),
    });
    if (auto) {
      const r = await excludeByCriteria(ctx.db, { criteria, caseId: c.id, reason: `Automatic clawback: ${text.title.toLowerCase()}`, actor: { type: 'system' }, pendingOnly: true });
      if (!r.excluded) continue;
      res.clawbacks++;
      res.reversed += r.reversed;
      res.publisher += r.publisherReversed;
      if (c.inserted) {
        await ctx.notify(f.orgId, { type: 'ivt_clawback', title: 'Invalid traffic removed from your earnings', body: `${text.outcome} You can see the details and appeal on the traffic quality page.`, link: '/publisher/policy', roles: ['owner', 'manager'] }).catch(() => undefined);
      }
      // Events whose earnings were already released stay in billing; staff decide on them.
      const rest = await previewExclusion(ctx.db, criteria);
      if (rest.preview.matched) {
        await caseFor(ctx.db, { key: `auto:${f.rule}:${f.orgId}:${day}:review`, orgId: f.orgId, kind: f.rule, title: `${text.title} (earnings already released)`, severity: text.severity, status: 'open', outcome: null,
          signals: { rule: f.rule, events: rest.preview.matched }, criteria, estimated: BigInt(rest.preview.publisherMicros) });
        res.reviewCases++;
      }
    } else if (c.inserted) res.reviewCases++;
  }
  res.reviewCases += await openRateReviews(ctx, s, now);
  if (res.clawbacks || res.reviewCases) ctx.log?.info({ ...res, reversed: res.reversed.toString(), publisher: res.publisher.toString() }, 'invalid-traffic sweep');
  return { clawbacks: res.clawbacks, reversedMicros: res.reversed.toString(), publisherMicros: res.publisher.toString(), reviewCases: res.reviewCases };
}

/** A review case for each publisher whose 7-day IVT rate is over the limit (one per publisher per week). */
async function openRateReviews(ctx: SweepCtx, s: PlatformSettings, now: Date) {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const week = Math.floor(now.getTime() / (7 * 86_400_000));
  let opened = 0;
  for (const p of await publisherIvtRates(ctx.db, from, to)) {
    if (qualityStatus(p.ivtRate, p.rendered, s.ivt) !== 'review') continue;
    // Suggested action: the traffic that passed but looked doubtful.
    const criteria: ExclusionCriteria = { publisherOrgId: p.orgId, from: `${from}T00:00:00Z`, to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(), minScore: 30, types: ['render', 'click'] };
    const { preview } = await previewExclusion(ctx.db, criteria);
    const c = await caseFor(ctx.db, {
      key: `auto:rate:${p.orgId}:${week}`, orgId: p.orgId, kind: 'publisher_ivt_rate', title: `High invalid-traffic rate: ${p.ivtRate!.toFixed(1)}% over 7 days`,
      severity: p.ivtRate! >= Math.min(100, s.ivt.publisherReviewIvtPercent * 2) ? 'high' : 'medium', status: 'open', outcome: null,
      signals: { ivtRate: Number(p.ivtRate!.toFixed(1)), rendered: p.rendered, invalidImpressions: p.invalidImpressions, topReason: p.topReason, suspiciousEvents: preview.matched }, criteria, estimated: BigInt(preview.publisherMicros),
    });
    if (c.inserted) opened++;
  }
  return opened;
}
