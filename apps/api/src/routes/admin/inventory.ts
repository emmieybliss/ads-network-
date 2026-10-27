import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { bodyOf, idParams, paramsOf, queryOf } from '../../lib/http';
import { tx } from '../../lib/tx';
import { notifyOrg } from '../../services/notifications';
import { invalidateServingCache } from '../../services/serving';
import { verificationInstructions } from '../../services/verification';
import { serializeSite, serializeUnit } from '../publisher';
import { adminList, guard, meta, mgmt, reasonOptional, reasonRequired, sortSql, Where } from './common';

const sitePatch = z.object({
  allowedFormats: z.array(z.enum(['image', 'text'])).min(1).optional(),
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
    const [units, verifs, stats, cases] = await Promise.all([
      db.query('SELECT * FROM ad_units WHERE site_id = $1 ORDER BY created_at', [id]),
      db.query('SELECT method, token, status, attempts, last_checked_at, last_error, verified_at, created_at FROM site_verifications WHERE site_id = $1 ORDER BY created_at DESC', [id]),
      db.query(`SELECT COALESCE(sum(valid_impressions), 0)::bigint AS valid, COALESCE(sum(invalid_impressions), 0)::bigint AS invalid, COALESCE(sum(valid_clicks), 0)::bigint AS clicks, COALESCE(sum(publisher_micros), 0)::text AS earnings FROM daily_stats WHERE site_id = $1 AND day > CURRENT_DATE - 30`, [id]),
      db.query(`SELECT id, title, status, severity, created_at FROM fraud_cases WHERE subject_type = 'site' AND subject_id = $1 ORDER BY created_at DESC`, [id]),
    ]);
    const token = verifs.rows[0]?.token;
    return { data: { ...serializeSite(s), orgId: s.org_id, orgName: s.org_name, orgStatus: s.org_status, units: units.rows.map(serializeUnit), verifications: verifs.rows, instructions: token ? verificationInstructions(s.domain, token) : null, last30Days: stats.rows[0], fraudCases: cases.rows } };
  });

  const siteAction = (action: string, from: string[], to: string, needReason: boolean, perm: 'admin:sites:review' = 'admin:sites:review') =>
    app.post(`/admin/sites/:id/${action}`, { config: mgmt, preHandler: guard(perm, { stepUp: action === 'mark-verified' }), schema: { tags: ['admin: inventory'], params: idParams, body: needReason ? reasonRequired : reasonOptional } }, async (req) => {
      const { id } = paramsOf(req, idParams);
      const reason = (req.body as { reason?: string }).reason ?? null;
      const s = await tx(ctx, async (c) => {
        const site = (await c.query('SELECT * FROM sites WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!site) throw notFound();
        if (!from.includes(site.status)) throw conflict(`Cannot ${action} a site that is ${site.status.replace('_', ' ')}`);
        if (action === 'approve' && !site.verified_at && (await ctx.settings.get()).publishers.requireDomainVerification) throw conflict('Domain ownership has not been verified');
        if (action === 'mark-verified') {
          await c.query(`UPDATE sites SET verified_at = now(), status = 'pending_review', updated_at = now() WHERE id = $1`, [id]);
        } else {
          await c.query(`UPDATE sites SET status = $2, status_reason = $3, approved_at = CASE WHEN $2 = 'approved' THEN COALESCE(approved_at, now()) ELSE approved_at END, updated_at = now() WHERE id = $1`, [id, to, reason]);
        }
        await audit(c, req, { action: `site.${action}`, resourceType: 'site', resourceId: id, orgId: site.org_id, before: { status: site.status }, after: { status: to }, reason });
        return site;
      });
      invalidateServingCache(ctx);
      if (action !== 'mark-verified') await notifyOrg(ctx, s.org_id, { type: 'site_reviewed', title: `${s.domain} ${to}`, body: reason ?? '', link: `/publisher/sites/${id}`, template: 'site_reviewed', vars: { domain: s.domain, decision: to, reason: reason ? `Reason: ${reason}` : '' }, roles: ['owner', 'manager'] }).catch(() => undefined);
      return { ok: true };
    });
  siteAction('approve', ['pending_review', 'rejected'], 'approved', false);
  siteAction('reject', ['pending_review', 'pending_verification'], 'rejected', true);
  siteAction('suspend', ['approved', 'pending_review'], 'suspended', true);
  siteAction('reinstate', ['suspended'], 'approved', true);
  siteAction('mark-verified', ['pending_verification'], 'pending_review', true);

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
