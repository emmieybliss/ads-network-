import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SETTINGS_GROUPS, ctr, type SettingsGroup } from '@blissnova/shared';
import { loadMigrations } from '@blissnova/database';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { bodyOf, dateRange, idParams, paramsOf, queryOf, resolveRange, toCsv } from '../../lib/http';
import { requireUser } from '../../plugins/auth';
import { invalidateServingCache } from '../../services/serving';
import { adminList, guard, meta, mgmt, reasonRequired, sortSql, Where } from './common';

const SENSITIVE_GROUPS: SettingsGroup[] = ['pricing', 'publishers', 'platform', 'tracking', 'api'];
const contentBody = z.object({
  kind: z.enum(['faq', 'advertiser_policy', 'publisher_policy', 'creative_rules', 'announcement', 'maintenance_notice', 'support_contact', 'doc_link', 'legal']),
  slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000).default(''),
  url: z.string().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  published: z.boolean().default(false),
});
const planBody = z.object({
  audience: z.enum(['advertiser', 'publisher']),
  name: z.string().trim().min(1).max(80),
  summary: z.string().max(300).default(''),
  priceLabel: z.string().max(80).default(''),
  features: z.array(z.string().max(160)).max(20).default([]),
  ctaLabel: z.string().max(40).default('Get started'),
  highlighted: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  published: z.boolean().default(false),
});
const auditQuery = adminList.extend({ action: z.string().max(80).optional(), resourceType: z.string().max(40).optional(), resourceId: z.string().max(80).optional(), actorId: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional() });

export async function adminPlatformRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db, config } = ctx;

  // ---------------------------------------------------------------- overview
  app.get('/admin/overview', { preHandler: guard('admin:overview'), schema: { tags: ['admin: overview'], querystring: dateRange } }, async (req) => {
    const r = resolveRange(queryOf(req, dateRange));
    const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
    const [users, adv, pubs, sites, camps, pending, stats, payments, payouts, ivt, trend] = await Promise.all([
      one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30 FROM users`),
      one(`SELECT count(DISTINCT o.id)::int AS n FROM organizations o JOIN campaigns c ON c.org_id = o.id WHERE o.type = 'advertiser' AND o.status = 'approved' AND c.status IN ('active', 'scheduled')`),
      one(`SELECT count(*)::int AS n FROM organizations WHERE type = 'publisher' AND status = 'approved'`),
      one(`SELECT count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified, count(*) FILTER (WHERE status = 'approved')::int AS approved FROM sites`),
      one(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'pending_approval')::int AS pending FROM campaigns`),
      one(`SELECT (SELECT count(*) FROM creatives WHERE status = 'pending_review')::int AS creatives, (SELECT count(*) FROM sites WHERE status IN ('submitted', 'under_review'))::int AS sites, (SELECT count(*) FROM organizations WHERE status = 'pending')::int AS orgs`),
      one(`SELECT COALESCE(sum(valid_impressions), 0)::bigint AS imps, COALESCE(sum(valid_clicks), 0)::bigint AS clicks, COALESCE(sum(invalid_impressions), 0)::bigint AS invalid, COALESCE(sum(rendered), 0)::bigint AS rendered, COALESCE(sum(spend_micros), 0)::text AS spend, COALESCE(sum(publisher_micros), 0)::text AS earnings FROM daily_stats WHERE day BETWEEN $1 AND $2`, [r.from, r.to]),
      one(`SELECT count(*)::int AS n, COALESCE(sum(amount_micros), 0)::text AS total FROM payments WHERE status = 'pending'`),
      one(`SELECT count(*)::int AS n, COALESCE(sum(amount_micros), 0)::text AS total FROM payouts WHERE status IN ('requested', 'approved', 'processing')`),
      one(`SELECT (SELECT count(*) FROM fraud_cases WHERE status IN ('open', 'investigating', 'appealed'))::int AS open_cases, (SELECT count(*) FROM anomaly_alerts WHERE acknowledged_at IS NULL)::int AS alerts`),
      db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(valid_impressions)::bigint AS imps, sum(valid_clicks)::bigint AS clicks, sum(spend_micros)::text AS spend, sum(publisher_micros)::text AS earnings FROM daily_stats WHERE day BETWEEN $1 AND $2 GROUP BY day ORDER BY day`, [r.from, r.to]),
    ]);
    const health = await systemHealth();
    return {
      data: {
        range: r,
        users, activeAdvertisers: adv.n, approvedPublishers: pubs.n, sites, campaigns: camps, pendingReviews: pending,
        validImpressions: Number(stats.imps), validClicks: Number(stats.clicks), ctr: ctr(Number(stats.clicks), Number(stats.imps)),
        invalidRate: Number(stats.rendered) ? (Number(stats.invalid) / Number(stats.rendered)) * 100 : null,
        advertiserSpendMicros: stats.spend, publisherEarningsMicros: stats.earnings, networkRevenueMicros: (BigInt(stats.spend) - BigInt(stats.earnings)).toString(),
        pendingPayments: payments, pendingPayouts: payouts, ivt, trend: trend.rows, health,
      },
    };
  });

  async function systemHealth() {
    const out: Record<string, unknown> = {};
    try { await db.query('SELECT 1'); out.database = 'ok'; } catch { out.database = 'error'; }
    try { out.redis = (await ctx.redis.ping()) === 'PONG' ? 'ok' : 'error'; } catch { out.redis = 'error'; }
    const queues: Record<string, unknown> = {};
    for (const [name, q] of Object.entries({ events: ctx.queues.events, serveLog: ctx.queues.serveLog, email: ctx.queues.email, maintenance: ctx.queues.maintenance })) {
      if (!q) { queues[name] = 'inline'; continue; }
      try { queues[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'); } catch { queues[name] = 'error'; }
    }
    out.queues = queues;
    const hb = await ctx.redis.get('worker:heartbeat').catch(() => null);
    out.worker = hb ? { lastHeartbeat: new Date(Number(hb)).toISOString(), healthy: Date.now() - Number(hb) < 120_000 } : { lastHeartbeat: null, healthy: config.EVENT_PROCESSING === 'inline' };
    return out;
  }

  app.get('/admin/system', { preHandler: guard('admin:settings:read'), schema: { tags: ['admin: settings'] } }, async () => {
    const applied = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    const email = (await db.query(`SELECT status, count(*)::int AS n FROM email_outbox WHERE created_at > now() - interval '7 days' GROUP BY status`)).rows;
    return {
      data: {
        health: await systemHealth(),
        migrations: loadMigrations().map((m) => ({ id: m.id, applied: applied.has(m.id) })),
        environment: config.NODE_ENV,
        eventProcessing: config.EVENT_PROCESSING,
        email: { provider: ctx.mailer.name, configured: ctx.mailer.configured, last7Days: email },
        payments: ctx.payments.list().map((p) => p.status()),
        geoHeader: config.GEO_COUNTRY_HEADER || null,
        geoDatabase: ctx.geo?.description ?? null,
        publicUrls: { site: config.PUBLIC_SITE_URL, api: config.PUBLIC_API_URL },
      },
    };
  });

  // ---------------------------------------------------------------- settings
  app.get('/admin/settings', { preHandler: guard('admin:settings:read'), schema: { tags: ['admin: settings'] } }, async () => {
    const s = await ctx.settings.get();
    const updated = (await db.query(`SELECT p.key, p.updated_at, u.name AS updated_by FROM platform_settings p LEFT JOIN users u ON u.id = p.updated_by`)).rows;
    // Secrets are never returned; only whether they are configured.
    const secrets = { smtpConfigured: Boolean(config.SMTP_HOST), stripeConfigured: Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET), paypalConfigured: Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET && config.PAYPAL_WEBHOOK_ID), errorReportingConfigured: Boolean(config.ERROR_REPORT_WEBHOOK_URL) };
    return { data: { settings: s, updated, secrets, groups: SETTINGS_GROUPS } };
  });

  app.patch('/admin/settings/:group', { config: mgmt, preHandler: guard('admin:settings:manage'), schema: { tags: ['admin: settings'], params: z.object({ group: z.enum(SETTINGS_GROUPS) }), body: z.object({ values: z.record(z.string(), z.unknown()), reason: z.string().trim().min(3).max(1000) }) } }, async (req) => {
    const actor = requireUser(req);
    const { group } = req.params as { group: SettingsGroup };
    if (SENSITIVE_GROUPS.includes(group)) await guard('admin:settings:manage', { stepUp: true })(req);
    if (group === 'pricing') await guard('admin:pricing:manage')(req);
    const { values, reason } = req.body as { values: Record<string, unknown>; reason: string };
    let res;
    try {
      res = await ctx.settings.update(group, values, actor.id);
    } catch (err) {
      throw badRequest('Invalid settings', (err as { issues?: unknown }).issues);
    }
    await audit(db, req, { action: `settings.${group}`, resourceType: 'platform_settings', resourceId: group, before: res.before, after: res.after, reason });
    invalidateServingCache(ctx);
    return { data: res.after };
  });

  // ---------------------------------------------------------------- content
  app.get('/admin/content', { preHandler: guard('admin:overview'), schema: { tags: ['admin: content'] } }, async () => {
    const rows = (await db.query(`SELECT * FROM content_items ORDER BY kind, sort_order, title`)).rows;
    return { data: rows };
  });

  app.post('/admin/content', { config: mgmt, preHandler: guard('admin:content:manage'), schema: { tags: ['admin: content'], body: contentBody } }, async (req, reply) => {
    const b = bodyOf(req, contentBody);
    const row = (await db.query(`INSERT INTO content_items (kind, slug, title, body, url, sort_order, published, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [b.kind, b.slug, b.title, b.body, b.url ?? null, b.sortOrder, b.published, req.auth!.user!.id])).rows[0];
    await audit(db, req, { action: 'content.create', resourceType: 'content_item', resourceId: row.id, after: b });
    return reply.status(201).send({ data: row });
  });

  app.put('/admin/content/:id', { config: mgmt, preHandler: guard('admin:content:manage'), schema: { tags: ['admin: content'], params: idParams, body: contentBody } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, contentBody);
    const before = (await db.query('SELECT * FROM content_items WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    const row = (await db.query(`UPDATE content_items SET kind = $2, slug = $3, title = $4, body = $5, url = $6, sort_order = $7, published = $8, updated_by = $9, updated_at = now() WHERE id = $1 RETURNING *`, [id, b.kind, b.slug, b.title, b.body, b.url ?? null, b.sortOrder, b.published, req.auth!.user!.id])).rows[0];
    await audit(db, req, { action: 'content.update', resourceType: 'content_item', resourceId: id, before, after: row });
    return { data: row };
  });

  app.delete('/admin/content/:id', { config: mgmt, preHandler: guard('admin:content:manage'), schema: { tags: ['admin: content'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const before = (await db.query('DELETE FROM content_items WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!before) throw notFound();
    await audit(db, req, { action: 'content.delete', resourceType: 'content_item', resourceId: id, before });
    return { ok: true };
  });

  app.get('/admin/pricing-plans', { preHandler: guard('admin:overview'), schema: { tags: ['admin: content'] } }, async () => ({ data: (await db.query(`SELECT * FROM pricing_plans ORDER BY audience, sort_order`)).rows }));

  app.post('/admin/pricing-plans', { config: mgmt, preHandler: guard('admin:pricing:manage'), schema: { tags: ['admin: content'], body: planBody } }, async (req, reply) => {
    const b = bodyOf(req, planBody);
    const row = (await db.query(`INSERT INTO pricing_plans (audience, name, summary, price_label, features, cta_label, highlighted, sort_order, published, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [b.audience, b.name, b.summary, b.priceLabel, b.features, b.ctaLabel, b.highlighted, b.sortOrder, b.published, req.auth!.user!.id])).rows[0];
    await audit(db, req, { action: 'pricing_plan.create', resourceType: 'pricing_plan', resourceId: row.id, after: b });
    return reply.status(201).send({ data: row });
  });

  app.put('/admin/pricing-plans/:id', { config: mgmt, preHandler: guard('admin:pricing:manage'), schema: { tags: ['admin: content'], params: idParams, body: planBody } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, planBody);
    const before = (await db.query('SELECT * FROM pricing_plans WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    const row = (await db.query(`UPDATE pricing_plans SET audience = $2, name = $3, summary = $4, price_label = $5, features = $6, cta_label = $7, highlighted = $8, sort_order = $9, published = $10, updated_by = $11, updated_at = now() WHERE id = $1 RETURNING *`, [id, b.audience, b.name, b.summary, b.priceLabel, b.features, b.ctaLabel, b.highlighted, b.sortOrder, b.published, req.auth!.user!.id])).rows[0];
    await audit(db, req, { action: 'pricing_plan.update', resourceType: 'pricing_plan', resourceId: id, before, after: row });
    return { data: row };
  });

  app.delete('/admin/pricing-plans/:id', { config: mgmt, preHandler: guard('admin:pricing:manage'), schema: { tags: ['admin: content'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const before = (await db.query('DELETE FROM pricing_plans WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!before) throw notFound();
    await audit(db, req, { action: 'pricing_plan.delete', resourceType: 'pricing_plan', resourceId: id, before });
    return { ok: true };
  });

  // ---------------------------------------------------------------- security & audit
  function auditWhere(q: z.infer<typeof auditQuery>) {
    const w = new Where();
    if (q.action) w.add('a.action ILIKE ?', `${q.action}%`);
    if (q.resourceType) w.add('a.resource_type = ?', q.resourceType);
    if (q.resourceId) w.add('a.resource_id = ?', q.resourceId);
    if (q.actorId) w.add('a.actor_user_id = ?', q.actorId);
    if (q.from) w.add('a.created_at >= ?::date', q.from);
    if (q.to) w.add('a.created_at < ?::date + 1', q.to);
    return w;
  }

  app.get('/admin/audit', { preHandler: guard('admin:audit:read'), schema: { tags: ['admin: security'], querystring: auditQuery } }, async (req) => {
    const q = queryOf(req, auditQuery);
    const w = auditWhere(q);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM audit_logs a ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${w.sql} ${sortSql(q, { created: 'a.created_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.get('/admin/audit/export', { preHandler: guard('admin:audit:read', { stepUp: true }), schema: { tags: ['admin: security'], querystring: auditQuery } }, async (req, reply) => {
    const q = queryOf(req, auditQuery);
    const w = auditWhere(q);
    const rows = (await db.query(`SELECT a.created_at, u.email AS actor, a.actor_type, a.action, a.resource_type, a.resource_id, a.org_id, a.reason, a.request_id FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${w.sql} ORDER BY a.created_at DESC LIMIT 100000`, w.params)).rows;
    await db.query('INSERT INTO data_exports (kind, requested_by, params, row_count) VALUES ($1, $2, $3, $4)', ['audit', req.auth!.user!.id, JSON.stringify(q), rows.length]);
    await audit(db, req, { action: 'data.export', resourceType: 'audit_logs', after: { rows: rows.length, filters: q } });
    const cols = ['created_at', 'actor', 'actor_type', 'action', 'resource_type', 'resource_id', 'org_id', 'reason', 'request_id'].map((k) => ({ key: k, label: k }));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="audit-log.csv"').send(toCsv(rows, cols));
  });

  app.get('/admin/security/summary', { preHandler: guard('admin:security:read'), schema: { tags: ['admin: security'] } }, async () => {
    const r = (await db.query(`SELECT type, count(*)::int AS n FROM auth_events WHERE created_at > now() - interval '24 hours' GROUP BY type`)).rows;
    const s = (await db.query(`SELECT type, severity, count(*)::int AS n FROM security_events WHERE created_at > now() - interval '24 hours' GROUP BY type, severity`)).rows;
    const sessions = (await db.query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`)).rows[0].n;
    const staffWithoutMfa = (await db.query(`SELECT count(*)::int AS n FROM users WHERE platform_role IS NOT NULL AND NOT mfa_enabled AND status = 'active'`)).rows[0].n;
    return { data: { authEvents24h: r, securityEvents24h: s, activeSessions: sessions, staffWithoutMfa } };
  });

  app.get('/admin/security/auth-events', { preHandler: guard('admin:security:read'), schema: { tags: ['admin: security'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.type) w.add('e.type = ?', q.type);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM auth_events e ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT e.id, e.type, e.user_agent, e.detail, e.created_at, u.email FROM auth_events e LEFT JOIN users u ON u.id = e.user_id ${w.sql} ${sortSql(q, { created: 'e.created_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.get('/admin/security/events', { preHandler: guard('admin:security:read'), schema: { tags: ['admin: security'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM security_events`)).rows[0].n);
    const rows = (await db.query(`SELECT * FROM security_events ${sortSql(q, { created: 'created_at' }, 'created')}`)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.post('/admin/security/events/:id/ack', { config: mgmt, preHandler: guard('admin:security:manage'), schema: { tags: ['admin: security'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    await db.query('UPDATE security_events SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1', [id, req.auth!.user!.id]);
    return { ok: true };
  });

  app.get('/admin/security/sessions', { preHandler: guard('admin:security:read'), schema: { tags: ['admin: security'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`)).rows[0].n);
    const rows = (await db.query(`SELECT s.id, s.user_agent, s.created_at, s.last_seen_at, s.expires_at, s.mfa_verified, u.email, u.platform_role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.revoked_at IS NULL AND s.expires_at > now() ${sortSql(q, { lastSeen: 's.last_seen_at' }, 'lastSeen')}`)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.post('/admin/security/sessions/:id/revoke', { config: mgmt, preHandler: guard('admin:security:manage'), schema: { tags: ['admin: security'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const r = await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin_revoked' WHERE id = $1 AND revoked_at IS NULL RETURNING user_id`, [id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'session.revoke', resourceType: 'session', resourceId: id, reason, after: { userId: r.rows[0].user_id } });
    return { ok: true };
  });

  app.get('/admin/security/api-keys', { preHandler: guard('admin:security:read'), schema: { tags: ['admin: security'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM api_keys`)).rows[0].n);
    const rows = (await db.query(`SELECT k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.expires_at, k.revoked_at, k.created_at, o.name AS org_name FROM api_keys k JOIN organizations o ON o.id = k.org_id ${sortSql(q, { created: 'k.created_at', used: 'k.last_used_at' }, 'created')}`)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.post('/admin/security/api-keys/:id/revoke', { config: mgmt, preHandler: guard('admin:security:manage'), schema: { tags: ['admin: security'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const r = await db.query(`UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING org_id`, [id, req.auth!.user!.id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'api_key.admin_revoke', resourceType: 'api_key', resourceId: id, orgId: r.rows[0].org_id, reason });
    return { ok: true };
  });

  app.get('/admin/security/exports', { preHandler: guard('admin:security:read'), schema: { tags: ['admin: security'] } }, async () => {
    const rows = (await db.query(`SELECT x.*, u.email FROM data_exports x JOIN users u ON u.id = x.requested_by ORDER BY x.created_at DESC LIMIT 200`)).rows;
    return { data: rows };
  });

  app.get('/admin/email-outbox', { preHandler: guard('admin:settings:read'), schema: { tags: ['admin: settings'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('status = ?', q.status);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM email_outbox ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT id, to_address, template, subject, status, provider, attempts, last_error, created_at, sent_at FROM email_outbox ${w.sql} ${sortSql(q, { created: 'created_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });
}
