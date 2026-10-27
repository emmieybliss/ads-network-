import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { ADMIN_SITE_TRANSITIONS, SITE_STATUS_LABELS, type SiteStatus } from '@blissnova/shared';
import { bodyOf, idParams, paramsOf, queryOf } from '../../lib/http';
import { tx } from '../../lib/tx';
import { notifyOrg } from '../../services/notifications';
import { invalidateServingCache } from '../../services/serving';
import { serializeSite, serializeUnit } from '../publisher';
import { adminList, guard, meta, mgmt, reasonRequired, sortSql, Where } from './common';

const sitePatch = z.object({
  allowedFormats: z.array(z.enum(['image', 'text', 'native'])).min(1).optional(),
  revenueShareBps: z.number().int().min(0).max(10000).nullable().optional(),
  blockedCategories: z.array(z.string().max(40)).max(50).optional(),
  category: z.string().max(40).optional(),
  reason: z.string().trim().min(3).max(1000),
});
const unitAdminBody = z.object({ adminBlocked: z.boolean(), reason: z.string().trim().min(3).max(1000) });
const ruleBody = z.object({ kind: z.enum(['blocked_destination_domain', 'blocked_keyword', 'blocked_site_category', 'blocked_country']), value: z.string().trim().min(1).max(253).transform((v) => v.toLowerCase()), reason: z.string().trim().max(500).optional() });

export async function adminInventoryRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/admin/sites', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: inventory'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('s.status = ?', q.status);
    if (q.q) w.add('(s.domain ILIKE ? OR s.name ILIKE ?)', `%${q.q}%`);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM sites s ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(
      `SELECT s.*, o.name AS org_name, o.status AS org_status, (SELECT count(*) FROM ad_units u WHERE u.site_id = s.id AND u.status = 'active')::int AS active_units
       FROM sites s JOIN organizations o ON o.id = s.org_id ${w.sql} ${sortSql(q, { domain: 's.domain', created: 's.created_at', status: 's.status' }, 'created')}`, w.params)).rows;
    return { data: rows.map((r) => ({ ...serializeSite(r), orgId: r.org_id, orgName: r.org_name, orgStatus: r.org_status, activeUnits: r.active_units })), meta: meta(q, total) };
  });

  app.get('/admin/sites/:id', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: inventory'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const s = (await db.query('SELECT s.*, o.name AS org_name, o.status AS org_status FROM sites s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1', [id])).rows[0];
    if (!s) throw notFound();
    const [units, challenges, attempts, reviews, stats, cases] = await Promise.all([
      db.query('SELECT * FROM ad_units WHERE site_id = $1 ORDER BY created_at', [id]),
      // The token itself is not needed to review evidence, so it is not returned.
      db.query('SELECT id, method, hostname, record_name, status, attempts, simulated, last_checked_at, last_error, verified_at, expires_at, created_at FROM site_verifications WHERE site_id = $1 ORDER BY created_at DESC', [id]),
      db.query('SELECT a.method, a.outcome, a.detail, a.evidence, a.simulated, a.created_at, u.email AS actor_email FROM site_verification_attempts a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.site_id = $1 ORDER BY a.created_at DESC LIMIT 100', [id]),
      db.query('SELECT r.action, r.from_status, r.to_status, r.checklist, r.reason, r.created_at, u.email AS reviewer_email FROM site_reviews r LEFT JOIN users u ON u.id = r.reviewer_id WHERE r.site_id = $1 ORDER BY r.created_at DESC', [id]),
      db.query(`SELECT COALESCE(sum(valid_impressions), 0)::bigint AS valid, COALESCE(sum(invalid_impressions), 0)::bigint AS invalid, COALESCE(sum(valid_clicks), 0)::bigint AS clicks, COALESCE(sum(publisher_micros), 0)::text AS earnings FROM daily_stats WHERE site_id = $1 AND day > CURRENT_DATE - 30`, [id]),
      db.query(`SELECT id, title, status, severity, created_at FROM fraud_cases WHERE subject_type = 'site' AND subject_id = $1 ORDER BY created_at DESC`, [id]),
    ]);
    const settings = await ctx.settings.get();
    return {
      data: {
        ...serializeSite(s), orgId: s.org_id, orgName: s.org_name, orgStatus: s.org_status, policyVersion: s.policy_version, policyAcceptedAt: s.policy_accepted_at,
        units: units.rows.map(serializeUnit), challenges: challenges.rows, attempts: attempts.rows, reviews: reviews.rows,
        eligibility: settings.eligibility, last30Days: stats.rows[0], fraudCases: cases.rows,
      },
    };
  });

  /** Domain registry: every hostname, its proof and its history, for investigation. */
  app.get('/admin/domains', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: inventory'], querystring: adminList.extend({ verified: z.enum(['yes', 'no']).optional(), method: z.string().max(20).optional() }) } }, async (req) => {
    const q = queryOf(req, adminList.extend({ verified: z.enum(['yes', 'no']).optional(), method: z.string().max(20).optional() }));
    const w = new Where();
    if (q.q) w.add('s.domain ILIKE ?', `%${q.q}%`);
    if (q.status) w.add('s.status = ?', q.status);
    if (q.verified === 'yes') w.raw('s.verified_at IS NOT NULL');
    if (q.verified === 'no') w.raw('s.verified_at IS NULL');
    if (q.method) w.add('s.verification_method = ?', q.method);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM sites s ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(
      `SELECT s.id, s.domain, s.status, s.verified_at, s.verification_method, s.verification_scope, s.verification_simulated, s.allowed_domains, s.created_at, o.name AS org_name,
         (SELECT count(*) FROM site_verification_attempts a WHERE a.site_id = s.id)::int AS attempts,
         (SELECT count(*) FROM site_verification_attempts a WHERE a.site_id = s.id AND a.outcome NOT IN ('success'))::int AS failed_attempts,
         (SELECT max(created_at) FROM site_verification_attempts a WHERE a.site_id = s.id) AS last_attempt_at
       FROM sites s JOIN organizations o ON o.id = s.org_id ${w.sql} ${sortSql(q, { domain: 's.domain', created: 's.created_at', status: 's.status' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  const reviewBody = z.object({ reason: z.string().trim().max(1000).optional(), checklist: z.record(z.string().max(60), z.boolean()).optional() });
  const siteAction = (action: string, to: SiteStatus, needReason: boolean) =>
    app.post(`/admin/sites/:id/${action}`, { config: mgmt, preHandler: guard('admin:sites:review'), schema: { tags: ['admin: inventory'], params: idParams, body: reviewBody } }, async (req) => {
      const { id } = paramsOf(req, idParams);
      const b = bodyOf(req, reviewBody);
      const reason = b.reason?.trim() || null;
      if (needReason && (!reason || reason.length < 3)) throw badRequest('A reason is required for this action');
      const from = ADMIN_SITE_TRANSITIONS[action]!;
      const s = await tx(ctx, async (c) => {
        const site = (await c.query('SELECT * FROM sites WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!site) throw notFound();
        if (!from.includes(site.status)) throw conflict(`Cannot ${action.replace('-', ' ')} a site that is ${site.status.replace('_', ' ')}`);
        if ((action === 'approve' || action === 'reinstate') && !site.verified_at) throw conflict('Domain control has not been verified');
        if (action === 'approve' && !site.policy_accepted_at) throw conflict('The publisher has not accepted the publisher policies');
        if ((action === 'approve' || action === 'reinstate') && site.verification_simulated && ctx.config.isProd) throw conflict('This site was verified by the development simulator and must be verified for real');
        await c.query(
          `UPDATE sites SET status = $2, status_reason = $3, reviewed_by = $4,
             review_started_at = CASE WHEN $2 = 'under_review' THEN now() ELSE review_started_at END,
             approved_at = CASE WHEN $2 = 'approved' THEN COALESCE(approved_at, now()) ELSE approved_at END, updated_at = now() WHERE id = $1`,
          [id, to, reason, req.auth!.user!.id]);
        await c.query(`INSERT INTO site_reviews (site_id, reviewer_id, action, from_status, to_status, checklist, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, req.auth!.user!.id, action, site.status, to, JSON.stringify(b.checklist ?? {}), reason]);
        await audit(c, req, { action: `site.${action}`, resourceType: 'site', resourceId: id, orgId: site.org_id, before: { status: site.status }, after: { status: to }, reason });
        return site;
      });
      invalidateServingCache(ctx);
      if (action !== 'start-review') await notifyOrg(ctx, s.org_id, { type: 'site_reviewed', title: `${s.domain}: ${SITE_STATUS_LABELS[to]}`, body: reason ?? '', link: `/publisher/sites/${id}`, template: 'site_reviewed', vars: { domain: s.domain, decision: SITE_STATUS_LABELS[to].toLowerCase(), reason: reason ? `Reason: ${reason}` : '' }, roles: ['owner', 'manager'] }).catch(() => undefined);
      return { ok: true, status: to };
    });
  siteAction('start-review', 'under_review', false);
  siteAction('approve', 'approved', false);
  siteAction('reject', 'rejected', true);
  siteAction('suspend', 'suspended', true);
  siteAction('reinstate', 'approved', true);

  /** Records out-of-band evidence of control (for example a support ticket with registrar proof). Step-up required. */
  app.post('/admin/sites/:id/mark-verified', { config: mgmt, preHandler: guard('admin:sites:review', { stepUp: true }), schema: { tags: ['admin: inventory'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = req.body as { reason: string };
    await tx(ctx, async (c) => {
      const site = (await c.query('SELECT * FROM sites WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!site) throw notFound();
      if (site.verified_at) throw conflict('This site is already verified');
      if (!['draft', 'verification_pending', 'rejected'].includes(site.status)) throw conflict(`A ${site.status.replace('_', ' ')} site cannot be verified`);
      await c.query(`UPDATE site_verifications SET status = 'superseded' WHERE site_id = $1 AND status IN ('pending', 'failed')`, [id]);
      await c.query(`UPDATE sites SET verified_at = now(), verification_method = 'manual', verification_scope = 'host', verification_simulated = false,
                       status = CASE WHEN status IN ('draft', 'verification_pending') THEN 'verified' ELSE status END, updated_at = now() WHERE id = $1`, [id]);
      await c.query(`INSERT INTO site_verification_attempts (site_id, hostname, method, outcome, detail, actor_user_id) VALUES ($1, $2, 'manual', 'success', $3, $4)`, [id, site.domain, reason.slice(0, 500), req.auth!.user!.id]);
      await audit(c, req, { action: 'site.mark_verified', resourceType: 'site', resourceId: id, orgId: site.org_id, before: { status: site.status }, reason });
    });
    invalidateServingCache(ctx);
    return { ok: true };
  });

  /** Withdraws a verification (for example after a domain changes hands). The site stops serving until verified again. */
  app.post('/admin/sites/:id/revoke-verification', { config: mgmt, preHandler: guard('admin:sites:review', { stepUp: true }), schema: { tags: ['admin: inventory'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = req.body as { reason: string };
    const site = await tx(ctx, async (c) => {
      const site = (await c.query('SELECT * FROM sites WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!site) throw notFound();
      if (!site.verified_at) throw conflict('This site is not verified');
      await c.query(`UPDATE site_verifications SET status = 'revoked' WHERE site_id = $1 AND status IN ('pending', 'failed', 'verified')`, [id]);
      await c.query(`UPDATE sites SET verified_at = NULL, verification_method = NULL, verification_scope = NULL, verification_simulated = false,
                       status = CASE WHEN status IN ('rejected', 'suspended') THEN status ELSE 'verification_pending' END, status_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
      await c.query(`INSERT INTO site_verification_attempts (site_id, hostname, method, outcome, detail, actor_user_id) VALUES ($1, $2, 'revoke', 'revoked', $3, $4)`, [id, site.domain, reason.slice(0, 500), req.auth!.user!.id]);
      await c.query(`INSERT INTO site_reviews (site_id, reviewer_id, action, from_status, to_status, reason) VALUES ($1, $2, 'revoke-verification', $3, $4, $5)`,
        [id, req.auth!.user!.id, site.status, ['rejected', 'suspended'].includes(site.status) ? site.status : 'verification_pending', reason]);
      await audit(c, req, { action: 'site.revoke_verification', resourceType: 'site', resourceId: id, orgId: site.org_id, before: { status: site.status, method: site.verification_method }, reason });
      return site;
    });
    invalidateServingCache(ctx);
    await notifyOrg(ctx, site.org_id, { type: 'site_reviewed', title: `${site.domain}: verification withdrawn`, body: reason, link: `/publisher/sites/${id}`, template: 'site_reviewed', vars: { domain: site.domain, decision: 'verification withdrawn', reason: `Reason: ${reason}` }, roles: ['owner', 'manager'] }).catch(() => undefined);
    return { ok: true };
  });

  app.patch('/admin/sites/:id', { config: mgmt, preHandler: guard('admin:inventory:manage'), schema: { tags: ['admin: inventory'], params: idParams, body: sitePatch } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, sitePatch);
    const before = (await db.query('SELECT * FROM sites WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    if (b.revenueShareBps !== undefined) await guard('admin:pricing:manage', { stepUp: true })(req);
    const after = (await db.query(
      `UPDATE sites SET allowed_formats = COALESCE($2, allowed_formats), revenue_share_bps = CASE WHEN $3::boolean THEN $4 ELSE revenue_share_bps END,
         blocked_categories = COALESCE($5, blocked_categories), category = COALESCE($6, category), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.allowedFormats ?? null, b.revenueShareBps !== undefined, b.revenueShareBps ?? null, b.blockedCategories ?? null, b.category ?? null])).rows[0];
    await audit(db, req, { action: 'site.admin_update', resourceType: 'site', resourceId: id, orgId: before.org_id, before: serializeSite(before), after: serializeSite(after), reason: b.reason });
    invalidateServingCache(ctx);
    return { data: serializeSite(after) };
  });

  app.patch('/admin/units/:id', { config: mgmt, preHandler: guard('admin:inventory:manage'), schema: { tags: ['admin: inventory'], params: idParams, body: unitAdminBody } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, unitAdminBody);
    const u = (await db.query('SELECT u.*, s.org_id FROM ad_units u JOIN sites s ON s.id = u.site_id WHERE u.id = $1', [id])).rows[0];
    if (!u) throw notFound();
    await db.query('UPDATE ad_units SET admin_blocked = $2, updated_at = now() WHERE id = $1', [id, b.adminBlocked]);
    await audit(db, req, { action: b.adminBlocked ? 'unit.admin_block' : 'unit.admin_unblock', resourceType: 'ad_unit', resourceId: id, orgId: u.org_id, reason: b.reason });
    invalidateServingCache(ctx);
    return { ok: true };
  });

  app.get('/admin/inventory-rules', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: inventory'] } }, async () => {
    const rows = (await db.query(`SELECT r.*, u.name AS created_by_name FROM inventory_rules r LEFT JOIN users u ON u.id = r.created_by ORDER BY kind, value`)).rows;
    return { data: rows };
  });

  app.post('/admin/inventory-rules', { config: mgmt, preHandler: guard('admin:inventory:manage'), schema: { tags: ['admin: inventory'], body: ruleBody } }, async (req, reply) => {
    const b = bodyOf(req, ruleBody);
    const value = b.kind === 'blocked_country' ? b.value.toUpperCase() : b.value;
    const row = (await db.query('INSERT INTO inventory_rules (kind, value, reason, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, value) DO NOTHING RETURNING *', [b.kind, value, b.reason ?? null, req.auth!.user!.id])).rows[0];
    if (!row) throw conflict('That rule already exists');
    await audit(db, req, { action: 'inventory_rule.create', resourceType: 'inventory_rule', resourceId: row.id, after: b });
    invalidateServingCache(ctx);
    return reply.status(201).send({ data: row });
  });

  app.delete('/admin/inventory-rules/:id', { config: mgmt, preHandler: guard('admin:inventory:manage'), schema: { tags: ['admin: inventory'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const r = (await db.query('DELETE FROM inventory_rules WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!r) throw notFound();
    await audit(db, req, { action: 'inventory_rule.delete', resourceType: 'inventory_rule', resourceId: id, before: r });
    invalidateServingCache(ctx);
    return { ok: true };
  });
}
