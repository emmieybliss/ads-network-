import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { excludeEvents } from '@blissnova/billing';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { bodyOf, dateRange, idParams, paramsOf, queryOf, resolveRange } from '../../lib/http';
import { tx } from '../../lib/tx';
import { requireUser } from '../../plugins/auth';
import { aggregateDay } from '../../services/events';
import { notifyOrg } from '../../services/notifications';
import { adminList, guard, meta, mgmt, sortSql, Where } from './common';

const caseBody = z.object({ subjectType: z.enum(['site', 'campaign', 'organization', 'unit']), subjectId: z.uuid(), title: z.string().trim().min(3).max(200), severity: z.enum(['low', 'medium', 'high']).default('medium'), signals: z.record(z.string(), z.unknown()).default({}) });
const casePatch = z.object({ status: z.enum(['open', 'investigating', 'confirmed', 'dismissed']).optional(), outcome: z.string().trim().max(2000).optional(), assignedTo: z.uuid().nullable().optional(), severity: z.enum(['low', 'medium', 'high']).optional() });
const excludeBody = z.object({
  criteria: z.object({
    eventIds: z.array(z.uuid()).max(5000).optional(),
    siteId: z.uuid().optional(), campaignId: z.uuid().optional(), unitId: z.uuid().optional(), ipHash: z.string().max(40).optional(), visitorHash: z.string().max(40).optional(),
    from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
    types: z.array(z.enum(['render', 'viewable', 'click'])).optional(),
  }),
  reason: z.string().trim().min(10).max(1000),
  dryRun: z.boolean().default(false),
});
const appealDecision = z.object({ decision: z.enum(['upheld', 'rejected']), outcome: z.string().trim().min(10).max(2000) });
const eventsQuery = adminList.extend({ campaignId: z.uuid().optional(), siteId: z.uuid().optional(), reason: z.string().max(40).optional(), eventType: z.enum(['served', 'render', 'viewable', 'click']).optional(), from: z.iso.date().optional(), to: z.iso.date().optional() });

export async function adminFraudRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/admin/fraud/summary', { preHandler: guard('admin:fraud:read'), schema: { tags: ['admin: invalid traffic'], querystring: dateRange } }, async (req) => {
    const r = resolveRange(queryOf(req, dateRange), 7);
    const reasons = (await db.query(`SELECT invalid_reason AS reason, type, count(*)::int AS n FROM ad_events WHERE status = 'invalid' AND occurred_at::date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY n DESC`, [r.from, r.to])).rows;
    const sites = (await db.query(
      `SELECT s.id, s.domain, sum(d.rendered)::bigint AS rendered, sum(d.invalid_impressions)::bigint AS invalid, sum(d.valid_impressions)::bigint AS valid, sum(d.valid_clicks)::bigint AS clicks
       FROM daily_stats d JOIN sites s ON s.id = d.site_id WHERE d.day BETWEEN $1 AND $2 GROUP BY s.id, s.domain HAVING sum(d.rendered) > 0
       ORDER BY sum(d.invalid_impressions)::float / NULLIF(sum(d.rendered), 0) DESC NULLS LAST LIMIT 20`, [r.from, r.to])).rows;
    const tokenInvalid = await ctx.redis.get(`ivt:token_invalid:${new Date().toISOString().slice(0, 10)}`);
    const openCases = (await db.query(`SELECT status, count(*)::int AS n FROM fraud_cases GROUP BY status`)).rows;
    const alerts = (await db.query(`SELECT count(*)::int AS n FROM anomaly_alerts WHERE acknowledged_at IS NULL`)).rows[0].n;
    return { data: { range: r, reasons, sites: sites.map((s) => ({ ...s, invalidRate: Number(s.rendered) ? (Number(s.invalid) / Number(s.rendered)) * 100 : null, ctr: Number(s.valid) ? (Number(s.clicks) / Number(s.valid)) * 100 : null })), unattributableTokensToday: Number(tokenInvalid ?? 0), cases: openCases, unacknowledgedAlerts: alerts } };
  });

  app.get('/admin/fraud/events', { preHandler: guard('admin:fraud:read'), schema: { tags: ['admin: invalid traffic'], querystring: eventsQuery, description: 'Event-level investigation. Raw events are retained only for the configured retention period.' } }, async (req) => {
    const q = queryOf(req, eventsQuery);
    const w = new Where();
    if (q.campaignId) w.add('e.campaign_id = ?', q.campaignId);
    if (q.siteId) w.add('e.site_id = ?', q.siteId);
    if (q.status) w.add('e.status = ?', q.status);
    if (q.reason) w.add('e.invalid_reason = ?', q.reason);
    if (q.eventType) w.add('e.type = ?', q.eventType);
    if (q.from) w.add('e.occurred_at >= ?::date', q.from);
    if (q.to) w.add('e.occurred_at < ?::date + 1', q.to);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM ad_events e ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT e.id, e.delivery_id, e.type, e.status, e.invalid_reason, e.ivt_score, e.billable, e.cost_micros, e.excluded_at, e.ip_hash, e.visitor_hash, e.country, e.device, e.page_host, e.occurred_at, e.campaign_id, e.site_id, s.domain FROM ad_events e JOIN sites s ON s.id = e.site_id ${w.sql} ${sortSql(q, { occurred: 'e.occurred_at', score: 'e.ivt_score' }, 'occurred')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.get('/admin/fraud/alerts', { preHandler: guard('admin:fraud:read'), schema: { tags: ['admin: invalid traffic'] } }, async () => {
    const rows = (await db.query(`SELECT * FROM anomaly_alerts ORDER BY acknowledged_at NULLS FIRST, created_at DESC LIMIT 200`)).rows;
    return { data: rows };
  });

  app.post('/admin/fraud/alerts/:id/ack', { config: mgmt, preHandler: guard('admin:fraud:manage'), schema: { tags: ['admin: invalid traffic'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    await db.query('UPDATE anomaly_alerts SET acknowledged_at = now() WHERE id = $1', [id]);
    await audit(db, req, { action: 'anomaly_alert.ack', resourceType: 'anomaly_alert', resourceId: id });
    return { ok: true };
  });

  app.get('/admin/fraud/cases', { preHandler: guard('admin:fraud:read'), schema: { tags: ['admin: invalid traffic'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('f.status = ?', q.status);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM fraud_cases f ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT f.*, u.name AS assignee FROM fraud_cases f LEFT JOIN users u ON u.id = f.assigned_to ${w.sql} ${sortSql(q, { created: 'f.created_at', updated: 'f.updated_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.post('/admin/fraud/cases', { config: mgmt, preHandler: guard('admin:fraud:manage'), schema: { tags: ['admin: invalid traffic'], body: caseBody } }, async (req, reply) => {
    const actor = requireUser(req);
    const b = bodyOf(req, caseBody);
    const row = (await db.query(`INSERT INTO fraud_cases (subject_type, subject_id, title, severity, signals, opened_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [b.subjectType, b.subjectId, b.title, b.severity, JSON.stringify(b.signals), actor.id])).rows[0];
    await audit(db, req, { action: 'fraud_case.open', resourceType: 'fraud_case', resourceId: row.id, after: b });
    return reply.status(201).send({ data: row });
  });

  app.get('/admin/fraud/cases/:id', { preHandler: guard('admin:fraud:read'), schema: { tags: ['admin: invalid traffic'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const f = (await db.query('SELECT * FROM fraud_cases WHERE id = $1', [id])).rows[0];
    if (!f) throw notFound();
    const [notes, exclusions, history] = await Promise.all([
      db.query(`SELECT n.id, n.body, n.created_at, a.name AS author FROM admin_notes n JOIN users a ON a.id = n.author_id WHERE n.subject_type = 'fraud_case' AND n.subject_id = $1 ORDER BY n.created_at DESC`, [id]),
      db.query(`SELECT x.*, u.name AS actor FROM event_exclusions x JOIN users u ON u.id = x.actor_id WHERE x.case_id = $1 ORDER BY x.created_at DESC`, [id]),
      db.query(`SELECT a.action, a.reason, a.after, a.created_at, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.resource_type = 'fraud_case' AND a.resource_id = $1 ORDER BY a.created_at DESC`, [id]),
    ]);
    return { data: { ...f, notes: notes.rows, exclusions: exclusions.rows, history: history.rows } };
  });

  app.patch('/admin/fraud/cases/:id', { config: mgmt, preHandler: guard('admin:fraud:manage'), schema: { tags: ['admin: invalid traffic'], params: idParams, body: casePatch } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, casePatch);
    const before = (await db.query('SELECT * FROM fraud_cases WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    if (['appealed'].includes(before.status) && b.status) throw conflict('Use the appeal decision action for appealed cases');
    if ((b.status === 'confirmed' || b.status === 'dismissed') && !b.outcome && !before.outcome) throw badRequest('Record the investigation outcome');
    const closing = b.status === 'confirmed' || b.status === 'dismissed';
    const after = (await db.query(
      `UPDATE fraud_cases SET status = COALESCE($2, status), outcome = COALESCE($3, outcome), assigned_to = CASE WHEN $4::boolean THEN $5 ELSE assigned_to END, severity = COALESCE($6, severity),
         resolved_at = CASE WHEN $7::boolean THEN now() ELSE resolved_at END, resolved_by = CASE WHEN $7::boolean THEN $8::uuid ELSE resolved_by END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.status ?? null, b.outcome ?? null, b.assignedTo !== undefined, b.assignedTo ?? null, b.severity ?? null, closing, actor.id])).rows[0];
    await audit(db, req, { action: 'fraud_case.update', resourceType: 'fraud_case', resourceId: id, before: { status: before.status }, after: { status: after.status, outcome: after.outcome } });
    return { data: after };
  });

  app.post('/admin/fraud/cases/:id/exclude', { config: mgmt, preHandler: guard('admin:fraud:manage', { stepUp: true }), schema: { tags: ['admin: invalid traffic'], params: idParams, body: excludeBody, description: 'Exclude matching events from billable totals. Settled charges are reversed with new ledger entries.' } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, excludeBody);
    const f = (await db.query('SELECT * FROM fraud_cases WHERE id = $1', [id])).rows[0];
    if (!f) throw notFound();
    const c = b.criteria;
    const w = new Where().raw('e.excluded_at IS NULL').raw(`e.type <> 'served'`);
    if (c.eventIds?.length) w.add('e.id = ANY(?::uuid[])', c.eventIds);
    if (c.siteId) w.add('e.site_id = ?', c.siteId);
    if (c.campaignId) w.add('e.campaign_id = ?', c.campaignId);
    if (c.unitId) w.add('e.unit_id = ?', c.unitId);
    if (c.ipHash) w.add('e.ip_hash = ?', c.ipHash);
    if (c.visitorHash) w.add('e.visitor_hash = ?', c.visitorHash);
    if (c.from) w.add('e.occurred_at >= ?', c.from);
    if (c.to) w.add('e.occurred_at < ?', c.to);
    if (c.types?.length) w.add('e.type = ANY(?)', c.types);
    if (w.clauses.length <= 2) throw badRequest('Provide at least one criterion');
    if (!c.eventIds?.length && !(c.from && c.to)) throw badRequest('Bulk exclusions need a time window (from and to)');
    const matched = (await db.query<{ id: string; occurred_at: string; billable: boolean; cost_micros: string }>(`SELECT e.id, e.occurred_at, e.billable, e.cost_micros FROM ad_events e ${w.sql} LIMIT 50001`, w.params)).rows;
    if (matched.length > 50000) throw badRequest('More than 50,000 events match; narrow the criteria');
    const billableTotal = matched.filter((m) => m.billable).reduce((a, m) => a + BigInt(m.cost_micros), 0n);
    if (b.dryRun) return { data: { matched: matched.length, billable: matched.filter((m) => m.billable).length, billableMicros: billableTotal.toString() } };
    const result = await tx(ctx, async (cl) => {
      const r = await excludeEvents(cl, { eventIds: matched.map((m) => m.id), actor: { type: 'user', userId: actor.id }, reason: b.reason, caseId: id });
      await cl.query('INSERT INTO event_exclusions (case_id, criteria, excluded_events, reversed_micros, reason, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [id, JSON.stringify(c), r.excluded, r.reversed.toString(), b.reason, actor.id]);
      await audit(cl, req, { action: 'events.exclude', resourceType: 'fraud_case', resourceId: id, after: { criteria: c, excluded: r.excluded, reversedMicros: r.reversed.toString() }, reason: b.reason });
      return r;
    });
    const days = [...new Set(matched.map((m) => new Date(m.occurred_at).toISOString().slice(0, 10)))];
    for (const d of days) await aggregateDay(db, d);
    return { data: { excluded: result.excluded, reversedMicros: result.reversed.toString(), reaggregatedDays: days } };
  });

  app.post('/admin/fraud/cases/:id/appeal-decision', { config: mgmt, preHandler: guard('admin:fraud:manage'), schema: { tags: ['admin: invalid traffic'], params: idParams, body: appealDecision } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, appealDecision);
    const f = (await db.query(`UPDATE fraud_cases SET status = $2, outcome = $3, resolved_at = now(), resolved_by = $4, updated_at = now() WHERE id = $1 AND status = 'appealed' RETURNING *`, [id, b.decision === 'upheld' ? 'appeal_upheld' : 'appeal_rejected', b.outcome, actor.id])).rows[0];
    if (!f) throw conflict('This case has no pending appeal');
    await audit(db, req, { action: 'fraud_case.appeal_decision', resourceType: 'fraud_case', resourceId: id, after: b });
    if (f.appealed_by) {
      const org = (await db.query(`SELECT org_id FROM memberships WHERE user_id = $1 LIMIT 1`, [f.appealed_by])).rows[0];
      if (org) await notifyOrg(ctx, org.org_id, { type: 'appeal_decision', title: `Appeal ${b.decision}`, body: b.outcome, roles: ['owner'] }).catch(() => undefined);
    }
    return { data: f };
  });
}
