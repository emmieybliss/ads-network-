import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { grantablePlatformRoles, PLATFORM_ROLES } from '@blissnova/shared';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { bodyOf, idParams, paramsOf, queryOf } from '../../lib/http';
import { tx } from '../../lib/tx';
import { requireUser } from '../../plugins/auth';
import { adminList, guard, meta, mgmt, reasonRequired, sortSql, Where } from './common';

const roleBody = z.object({ platformRole: z.enum(PLATFORM_ROLES).nullable(), reason: z.string().trim().min(3).max(1000) });
const noteBody = z.object({ subjectType: z.enum(['user', 'organization', 'site', 'campaign', 'creative', 'fraud_case', 'payout', 'payment', 'dispute', 'abuse_report']), subjectId: z.uuid(), body: z.string().trim().min(1).max(5000) });
const abusePatch = z.object({ status: z.enum(['open', 'investigating', 'resolved', 'dismissed']), resolution: z.string().trim().max(2000).optional() });

export async function adminUserRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/admin/users', { preHandler: guard('admin:users:read'), schema: { tags: ['admin: users'], querystring: adminList.extend({ role: z.string().max(40).optional() }) } }, async (req) => {
    const q = queryOf(req, adminList.extend({ role: z.string().max(40).optional() }));
    const w = new Where();
    if (q.q) w.add('(u.email ILIKE ? OR u.name ILIKE ?)', `%${q.q}%`);
    if (q.status) w.add('u.status = ?', q.status);
    if (q.role === 'none') w.raw('u.platform_role IS NULL');
    else if (q.role) w.add('u.platform_role = ?', q.role);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM users u ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(
      `SELECT u.id, u.email, u.name, u.status, u.platform_role, u.mfa_enabled, u.email_verified_at, u.last_login_at, u.created_at,
         (SELECT count(*) FROM memberships m WHERE m.user_id = u.id)::int AS org_count
       FROM users u ${w.sql} ${sortSql(q, { email: 'u.email', name: 'u.name', created: 'u.created_at', lastLogin: 'u.last_login_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.get('/admin/users/:id', { preHandler: guard('admin:users:read'), schema: { tags: ['admin: users'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const u = (await db.query(`SELECT id, email, name, status, platform_role, mfa_enabled, email_verified_at, suspended_reason, last_login_at, created_at FROM users WHERE id = $1`, [id])).rows[0];
    if (!u) throw notFound();
    const [orgs, sessions, events, notes, activity] = await Promise.all([
      db.query(`SELECT o.id, o.name, o.type, o.status, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1`, [id]),
      db.query(`SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [id]),
      db.query(`SELECT type, user_agent, detail, created_at FROM auth_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      db.query(`SELECT n.id, n.body, n.created_at, a.name AS author FROM admin_notes n JOIN users a ON a.id = n.author_id WHERE n.subject_type = 'user' AND n.subject_id = $1 ORDER BY n.created_at DESC`, [id]),
      db.query(`SELECT action, resource_type, resource_id, reason, created_at FROM audit_logs WHERE actor_user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    return { data: { ...u, organizations: orgs.rows, sessions: sessions.rows, authEvents: events.rows, notes: notes.rows, activity: activity.rows } };
  });

  async function superAdminCount() {
    return Number((await db.query(`SELECT count(*)::int AS n FROM users WHERE platform_role = 'super_admin' AND status = 'active'`)).rows[0].n);
  }

  app.post('/admin/users/:id/suspend', { config: mgmt, preHandler: guard('admin:users:manage', { stepUp: true }), schema: { tags: ['admin: users'], params: idParams, body: reasonRequired } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    if (id === actor.id) throw conflict('You cannot suspend your own account');
    await tx(app.ctx, async (c) => {
      const u = (await c.query('SELECT id, status, platform_role FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!u) throw notFound();
      if (u.platform_role === 'super_admin' && actor.platformRole !== 'super_admin') throw forbidden('Only a super administrator can suspend another super administrator');
      if (u.platform_role === 'super_admin' && (await superAdminCount()) <= 1) throw conflict('The last active super administrator cannot be suspended');
      await c.query(`UPDATE users SET status = 'suspended', suspended_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'suspended' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(c, req, { action: 'user.suspend', resourceType: 'user', resourceId: id, before: { status: u.status }, after: { status: 'suspended' }, reason });
    });
    return { ok: true };
  });

  app.post('/admin/users/:id/reactivate', { config: mgmt, preHandler: guard('admin:users:manage', { stepUp: true }), schema: { tags: ['admin: users'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const r = await db.query(`UPDATE users SET status = 'active', suspended_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'suspended' RETURNING id`, [id]);
    if (!r.rowCount) throw notFound('No suspended user found');
    await audit(db, req, { action: 'user.reactivate', resourceType: 'user', resourceId: id, before: { status: 'suspended' }, after: { status: 'active' }, reason });
    return { ok: true };
  });

  app.post('/admin/users/:id/revoke-sessions', { config: mgmt, preHandler: guard('admin:users:manage'), schema: { tags: ['admin: users'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const r = await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin_revoked' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(db, req, { action: 'user.sessions_revoked', resourceType: 'user', resourceId: id, after: { count: r.rowCount }, reason });
    return { revoked: r.rowCount };
  });

  app.put('/admin/users/:id/role', { config: mgmt, preHandler: guard('admin:roles:manage', { stepUp: true }), schema: { tags: ['admin: users'], params: idParams, body: roleBody } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, roleBody);
    const grantable = grantablePlatformRoles(actor.platformRole);
    await tx(app.ctx, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('platform-roles'))`);
      const u = (await c.query('SELECT id, platform_role FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!u) throw notFound();
      if (u.platform_role && !grantable.includes(u.platform_role)) throw forbidden('You cannot change this user\'s current role');
      if (b.platformRole && !grantable.includes(b.platformRole)) throw forbidden('You cannot grant this role');
      if (id === actor.id && b.platformRole !== actor.platformRole) throw conflict('Ask another administrator to change your own role');
      if (u.platform_role === 'super_admin' && b.platformRole !== 'super_admin') {
        const n = Number((await c.query(`SELECT count(*)::int AS n FROM users WHERE platform_role = 'super_admin' AND status = 'active'`)).rows[0].n);
        if (n <= 1) throw conflict('The final super administrator cannot be removed');
      }
      await c.query('UPDATE users SET platform_role = $2, updated_at = now() WHERE id = $1', [id, b.platformRole]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'role_changed' WHERE user_id = $1 AND revoked_at IS NULL AND $1 <> $2`, [id, actor.id]);
      await audit(c, req, { action: 'user.platform_role', resourceType: 'user', resourceId: id, before: { platformRole: u.platform_role }, after: { platformRole: b.platformRole }, reason: b.reason });
    });
    return { ok: true };
  });

  // Internal notes on any subject.
  app.get('/admin/notes', { preHandler: guard('admin:users:read'), schema: { tags: ['admin: users'], querystring: z.object({ subjectType: z.string().max(40), subjectId: z.uuid() }) } }, async (req) => {
    const q = req.query as { subjectType: string; subjectId: string };
    const rows = (await db.query(`SELECT n.id, n.body, n.created_at, a.name AS author FROM admin_notes n JOIN users a ON a.id = n.author_id WHERE n.subject_type = $1 AND n.subject_id = $2 ORDER BY n.created_at DESC`, [q.subjectType, q.subjectId])).rows;
    return { data: rows };
  });

  app.post('/admin/notes', { config: mgmt, preHandler: guard('admin:notes:write'), schema: { tags: ['admin: users'], body: noteBody } }, async (req, reply) => {
    const actor = requireUser(req);
    const b = bodyOf(req, noteBody);
    const row = (await db.query('INSERT INTO admin_notes (subject_type, subject_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING id, created_at', [b.subjectType, b.subjectId, actor.id, b.body])).rows[0];
    await audit(db, req, { action: 'note.create', resourceType: b.subjectType, resourceId: b.subjectId });
    return reply.status(201).send({ data: row });
  });

  app.get('/admin/abuse-reports', { preHandler: guard('admin:users:read'), schema: { tags: ['admin: users'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('status = ?', q.status);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM abuse_reports ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT * FROM abuse_reports ${w.sql} ${sortSql(q, { created: 'created_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.patch('/admin/abuse-reports/:id', { config: mgmt, preHandler: guard('admin:notes:write'), schema: { tags: ['admin: users'], params: idParams, body: abusePatch } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, abusePatch);
    if ((b.status === 'resolved' || b.status === 'dismissed') && !b.resolution) throw badRequest('Record a resolution when closing a report');
    const r = await db.query(`UPDATE abuse_reports SET status = $2, resolution = COALESCE($3, resolution), resolved_by = CASE WHEN $2 IN ('resolved', 'dismissed') THEN $4::uuid ELSE resolved_by END, updated_at = now() WHERE id = $1 RETURNING id`, [id, b.status, b.resolution ?? null, actor.id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'abuse_report.update', resourceType: 'abuse_report', resourceId: id, after: b });
    return { ok: true };
  });
}
