import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { bodyOf, idParams, orgIdParams, orgParams, paramsOf, queryOf } from '../lib/http';
import { tx } from '../lib/tx';
import { requireOrg, requireUser } from '../plugins/auth';
import { notifyOrg, notifyStaff } from '../services/notifications';
import { adminList, guard, meta, mgmt, sortSql, Where } from './admin/common';

const CATEGORIES = ['general', 'billing', 'payouts', 'verification', 'policy', 'technical', 'account'] as const;
const caseBody = z.object({
  subject: z.string().trim().min(3).max(200),
  category: z.enum(CATEGORIES).default('general'),
  body: z.string().trim().min(10).max(10000),
});
const messageBody = z.object({ body: z.string().trim().min(1).max(10000) });
const staffMessageBody = messageBody.extend({ internal: z.boolean().default(false) });
const casePatch = z.object({
  status: z.enum(['open', 'waiting_on_customer', 'waiting_on_staff', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignedTo: z.uuid().nullable().optional(),
});

function serializeCase(c: Record<string, any>) {
  return { id: c.id, orgId: c.org_id, subject: c.subject, category: c.category, status: c.status, priority: c.priority, assignedTo: c.assigned_to, createdAt: c.created_at, updatedAt: c.updated_at };
}

/** Support requests from advertiser and publisher teams, and the staff side of them. */
export async function supportRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const ctx = app.ctx;

  // ---------------------------------------------------------------- customers
  app.get('/orgs/:orgId/support-cases', { preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['support'], params: orgParams } }, async (req) => {
    const rows = (await db.query('SELECT * FROM support_cases WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 200', [req.org!.id])).rows;
    return { data: rows.map(serializeCase) };
  });

  app.post('/orgs/:orgId/support-cases', { config: mgmt, preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['support'], params: orgParams, body: caseBody } }, async (req, reply) => {
    const user = requireUser(req);
    const b = bodyOf(req, caseBody);
    const row = await tx(ctx, async (c) => {
      const sc = (await c.query(`INSERT INTO support_cases (org_id, opened_by, subject, category) VALUES ($1, $2, $3, $4) RETURNING *`, [req.org!.id, user.id, b.subject, b.category])).rows[0];
      await c.query(`INSERT INTO support_messages (case_id, author_id, body) VALUES ($1, $2, $3)`, [sc.id, user.id, b.body]);
      await audit(c, req, { action: 'support_case.open', resourceType: 'support_case', resourceId: sc.id, orgId: req.org!.id, after: { subject: b.subject, category: b.category } });
      return sc;
    });
    await notifyStaff(ctx, ['super_admin', 'admin', 'support'], 'New support request', `${req.org!.name}: ${b.subject}`, `/admin/support/${row.id}`).catch(() => undefined);
    return reply.status(201).send({ data: serializeCase(row) });
  });

  async function ownCase(orgId: string, id: string) {
    const c = (await db.query('SELECT * FROM support_cases WHERE id = $1 AND org_id = $2', [id, orgId])).rows[0];
    if (!c) throw notFound();
    return c;
  }

  app.get('/orgs/:orgId/support-cases/:id', { preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['support'], params: orgIdParams } }, async (req) => {
    const sc = await ownCase(req.org!.id, paramsOf(req, orgIdParams).id);
    // Internal staff notes never leave the staff side.
    const msgs = (await db.query(`SELECT m.id, m.body, m.from_staff, m.created_at, CASE WHEN m.from_staff THEN 'Support team' ELSE u.name END AS author FROM support_messages m JOIN users u ON u.id = m.author_id WHERE m.case_id = $1 AND NOT m.internal ORDER BY m.created_at`, [sc.id])).rows;
    return { data: { ...serializeCase(sc), messages: msgs.map((m) => ({ id: m.id, body: m.body, fromStaff: m.from_staff, author: m.author, createdAt: m.created_at })) } };
  });

  app.post('/orgs/:orgId/support-cases/:id/messages', { config: mgmt, preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['support'], params: orgIdParams, body: messageBody } }, async (req, reply) => {
    const user = requireUser(req);
    const sc = await ownCase(req.org!.id, paramsOf(req, orgIdParams).id);
    if (sc.status === 'closed') throw conflict('This request is closed. Open a new one if you need more help.');
    const b = bodyOf(req, messageBody);
    await db.query(`INSERT INTO support_messages (case_id, author_id, body) VALUES ($1, $2, $3)`, [sc.id, user.id, b.body]);
    await db.query(`UPDATE support_cases SET status = 'waiting_on_staff', updated_at = now() WHERE id = $1`, [sc.id]);
    return reply.status(201).send({ ok: true });
  });

  app.post('/orgs/:orgId/support-cases/:id/close', { config: mgmt, preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['support'], params: orgIdParams } }, async (req) => {
    const sc = await ownCase(req.org!.id, paramsOf(req, orgIdParams).id);
    await db.query(`UPDATE support_cases SET status = 'closed', updated_at = now() WHERE id = $1`, [sc.id]);
    await audit(db, req, { action: 'support_case.close', resourceType: 'support_case', resourceId: sc.id, orgId: req.org!.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- staff
  app.get('/admin/support-cases', { preHandler: guard('admin:users:read'), schema: { tags: ['admin: support'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('sc.status = ?', q.status);
    if (q.type) w.add('sc.category = ?', q.type);
    if (q.q) w.add('sc.subject ILIKE ?', `%${q.q}%`);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM support_cases sc ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(
      `SELECT sc.*, o.name AS org_name, u.email AS opened_by_email, a.name AS assigned_name FROM support_cases sc LEFT JOIN organizations o ON o.id = sc.org_id
       JOIN users u ON u.id = sc.opened_by LEFT JOIN users a ON a.id = sc.assigned_to ${w.sql} ${sortSql(q, { created: 'sc.created_at', updated: 'sc.updated_at', status: 'sc.status' }, 'updated')}`, w.params)).rows;
    return { data: rows.map((r) => ({ ...serializeCase(r), orgName: r.org_name, openedBy: r.opened_by_email, assignedName: r.assigned_name })), meta: meta(q, total) };
  });

  app.get('/admin/support-cases/:id', { preHandler: guard('admin:users:read'), schema: { tags: ['admin: support'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const sc = (await db.query(`SELECT sc.*, o.name AS org_name, u.email AS opened_by_email FROM support_cases sc LEFT JOIN organizations o ON o.id = sc.org_id JOIN users u ON u.id = sc.opened_by WHERE sc.id = $1`, [id])).rows[0];
    if (!sc) throw notFound();
    const msgs = (await db.query(`SELECT m.id, m.body, m.from_staff, m.internal, m.created_at, u.name AS author, u.email FROM support_messages m JOIN users u ON u.id = m.author_id WHERE m.case_id = $1 ORDER BY m.created_at`, [id])).rows;
    return { data: { ...serializeCase(sc), orgName: sc.org_name, openedBy: sc.opened_by_email, messages: msgs.map((m) => ({ id: m.id, body: m.body, fromStaff: m.from_staff, internal: m.internal, author: m.author, email: m.email, createdAt: m.created_at })) } };
  });

  app.post('/admin/support-cases/:id/messages', { config: mgmt, preHandler: guard('admin:notes:write'), schema: { tags: ['admin: support'], params: idParams, body: staffMessageBody } }, async (req, reply) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, staffMessageBody);
    const sc = (await db.query('SELECT * FROM support_cases WHERE id = $1', [id])).rows[0];
    if (!sc) throw notFound();
    await db.query(`INSERT INTO support_messages (case_id, author_id, from_staff, internal, body) VALUES ($1, $2, true, $3, $4)`, [id, req.auth!.user!.id, b.internal, b.body]);
    if (!b.internal) {
      await db.query(`UPDATE support_cases SET status = CASE WHEN status IN ('resolved', 'closed') THEN status ELSE 'waiting_on_customer' END, updated_at = now() WHERE id = $1`, [id]);
      if (sc.org_id) await notifyOrg(ctx, sc.org_id, { type: 'support_reply', title: `Reply on: ${sc.subject}`, link: `/support/${id}` }).catch(() => undefined);
    }
    return reply.status(201).send({ ok: true });
  });

  app.patch('/admin/support-cases/:id', { config: mgmt, preHandler: guard('admin:notes:write'), schema: { tags: ['admin: support'], params: idParams, body: casePatch } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, casePatch);
    const before = (await db.query('SELECT * FROM support_cases WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    const after = (await db.query(
      `UPDATE support_cases SET status = COALESCE($2, status), priority = COALESCE($3, priority), assigned_to = CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_to END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.status ?? null, b.priority ?? null, b.assignedTo !== undefined, b.assignedTo ?? null])).rows[0];
    await audit(db, req, { action: 'support_case.update', resourceType: 'support_case', resourceId: id, orgId: before.org_id, before: serializeCase(before), after: serializeCase(after) });
    return { data: serializeCase(after) };
  });
}
