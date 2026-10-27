import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ORG_ROLE_PERMISSIONS, ORG_ROLES, type OrgType } from '@blissnova/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { bodyOf, orgParams, paramsOf } from '../lib/http';
import { newApiKeySecret, requireOrg, requireUser } from '../plugins/auth';
import { createOrganization, serializeOrg } from '../services/orgs';
import { queueEmail } from '../services/notifications';

const createOrgBody = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['advertiser', 'publisher']),
  website: z.url().max(300).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});
const updateOrgBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  website: z.url().max(300).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  billingEmail: z.email().nullable().optional(),
});
const memberParams = z.object({ orgId: z.uuid(), userId: z.uuid() });
const roleBody = z.object({ role: z.enum(ORG_ROLES) });
const inviteBody = z.object({ email: z.email().transform((v) => v.toLowerCase()), role: z.enum(ORG_ROLES) });
const inviteParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const apiKeyBody = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(z.string()).min(1).max(20), expiresInDays: z.number().int().min(1).max(730).optional() });

export async function orgRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const mgmt = { rateLimit: { bucket: 'management' as const } };

  app.post('/orgs', { config: mgmt, schema: { tags: ['organizations'], body: createOrgBody } }, async (req, reply) => {
    const user = requireUser(req);
    if (!user.emailVerified) throw forbidden('Verify your email address before creating an organization');
    const org = await createOrganization(app.ctx, req, user.id, bodyOf(req, createOrgBody));
    return reply.status(201).send({ data: serializeOrg(org) });
  });

  app.get('/orgs', { schema: { tags: ['organizations'] } }, async (req) => {
    const user = requireUser(req);
    const rows = (await db.query(`SELECT o.*, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.created_at`, [user.id])).rows;
    return { data: rows.map((r) => ({ ...serializeOrg(r), role: r.role })) };
  });

  app.get('/orgs/:orgId', { preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['organizations'], params: orgParams } }, async (req) => {
    const o = (await db.query('SELECT * FROM organizations WHERE id = $1', [req.org!.id])).rows[0];
    return { data: { ...serializeOrg(o), role: req.org!.role, permissions: req.org!.role ? ORG_ROLE_PERMISSIONS[req.org!.type][req.org!.role] : [] } };
  });

  app.patch('/orgs/:orgId', { config: mgmt, preHandler: requireOrg('org:update'), schema: { tags: ['organizations'], params: orgParams, body: updateOrgBody } }, async (req) => {
    const b = bodyOf(req, updateOrgBody);
    const before = (await db.query('SELECT * FROM organizations WHERE id = $1', [req.org!.id])).rows[0];
    const after = (await db.query(
      `UPDATE organizations SET name = COALESCE($2, name), website = CASE WHEN $3::boolean THEN $4 ELSE website END,
         country = CASE WHEN $5::boolean THEN $6 ELSE country END, billing_email = CASE WHEN $7::boolean THEN $8 ELSE billing_email END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.org!.id, b.name ?? null, b.website !== undefined, b.website ?? null, b.country !== undefined, b.country ?? null, b.billingEmail !== undefined, b.billingEmail ?? null])).rows[0];
    await audit(db, req, { action: 'organization.update', resourceType: 'organization', resourceId: req.org!.id, orgId: req.org!.id, before: serializeOrg(before), after: serializeOrg(after) });
    return { data: serializeOrg(after) };
  });

  // ---------------------------------------------------------------- members
  app.get('/orgs/:orgId/members', { preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['organizations'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`, [req.org!.id])).rows;
    return { data: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role, joinedAt: r.created_at })) };
  });

  async function ownerCount(orgId: string) {
    return Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`, [orgId])).rows[0]!.n);
  }

  app.patch('/orgs/:orgId/members/:userId', { config: mgmt, preHandler: requireOrg('org:members:manage'), schema: { tags: ['organizations'], params: memberParams, body: roleBody } }, async (req) => {
    const { userId } = paramsOf(req, memberParams);
    const { role } = bodyOf(req, roleBody);
    const m = (await db.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [req.org!.id, userId])).rows[0];
    if (!m) throw notFound();
    if (m.role === 'owner' && role !== 'owner' && (await ownerCount(req.org!.id)) <= 1) throw conflict('An organization must keep at least one owner');
    await db.query('UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2', [req.org!.id, userId, role]);
    await audit(db, req, { action: 'membership.role_change', resourceType: 'membership', resourceId: userId, orgId: req.org!.id, before: { role: m.role }, after: { role } });
    return { ok: true };
  });

  app.delete('/orgs/:orgId/members/:userId', { config: mgmt, preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['organizations'], params: memberParams } }, async (req) => {
    const user = requireUser(req);
    const { userId } = paramsOf(req, memberParams);
    const self = userId === user.id;
    if (!self && !ORG_ROLE_PERMISSIONS[req.org!.type][req.org!.role!].includes('org:members:manage')) throw forbidden();
    const m = (await db.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [req.org!.id, userId])).rows[0];
    if (!m) throw notFound();
    if (m.role === 'owner' && (await ownerCount(req.org!.id)) <= 1) throw conflict('Transfer ownership before removing the last owner');
    await db.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [req.org!.id, userId]);
    await audit(db, req, { action: self ? 'membership.leave' : 'membership.remove', resourceType: 'membership', resourceId: userId, orgId: req.org!.id, before: { role: m.role } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- invitations
  app.get('/orgs/:orgId/invitations', { preHandler: requireOrg('org:members:manage', { allowSuspended: true }), schema: { tags: ['organizations'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, email, role, expires_at, created_at FROM invitations WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [req.org!.id])).rows;
    return { data: rows };
  });

  app.post('/orgs/:orgId/invitations', { config: mgmt, preHandler: requireOrg('org:members:manage'), schema: { tags: ['organizations'], params: orgParams, body: inviteBody } }, async (req, reply) => {
    const user = requireUser(req);
    const b = bodyOf(req, inviteBody);
    const member = await db.query('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2', [req.org!.id, b.email]);
    if (member.rowCount) throw conflict('That person is already a member');
    const token = randomToken(32);
    const inv = (await db.query(`INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days') RETURNING id, email, role, expires_at`,
      [req.org!.id, b.email, b.role, sha256(token), user.id])).rows[0];
    await queueEmail(app.ctx, b.email, 'invitation', { inviterName: user.name, orgName: req.org!.name, role: b.role, link: `${app.ctx.config.PUBLIC_SITE_URL}/invitations/accept?token=${token}` });
    await audit(db, req, { action: 'invitation.create', resourceType: 'invitation', resourceId: inv.id, orgId: req.org!.id, after: { email: b.email, role: b.role } });
    return reply.status(201).send({ data: inv });
  });

  app.delete('/orgs/:orgId/invitations/:id', { config: mgmt, preHandler: requireOrg('org:members:manage'), schema: { tags: ['organizations'], params: inviteParams } }, async (req) => {
    const { id } = paramsOf(req, inviteParams);
    const r = await db.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL', [id, req.org!.id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'invitation.revoke', resourceType: 'invitation', resourceId: id, orgId: req.org!.id });
    return { ok: true };
  });

  app.post('/invitations/accept', { config: mgmt, schema: { tags: ['organizations'], body: z.object({ token: z.string().min(20).max(200) }) } }, async (req) => {
    const user = requireUser(req);
    const { token } = req.body as { token: string };
    const inv = (await db.query(`SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [sha256(token)])).rows[0];
    if (!inv) throw badRequest('This invitation is invalid or has expired');
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden('This invitation was sent to a different email address');
    await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING`, [inv.org_id, user.id, inv.role]);
    await db.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [inv.id]);
    // The invited address is proven by receiving the token.
    await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [user.id]);
    await audit(db, req, { action: 'invitation.accept', resourceType: 'invitation', resourceId: inv.id, orgId: inv.org_id, after: { role: inv.role } });
    return { ok: true, orgId: inv.org_id };
  });

  // ---------------------------------------------------------------- API keys
  app.get('/orgs/:orgId/api-keys', { preHandler: requireOrg('org:apikeys:manage', { allowSuspended: true }), schema: { tags: ['api keys'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`, [req.org!.id])).rows;
    return { data: rows };
  });

  async function insertKey(orgId: string, userId: string, name: string, scopes: string[], expiresInDays: number | undefined, rotatedFrom: string | null) {
    const k = newApiKeySecret();
    const row = (await db.query(
      `INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, created_by, expires_at, rotated_from) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END, $8)
       RETURNING id, name, prefix, scopes, expires_at, created_at`,
      [orgId, name, k.prefix, k.hash, scopes, userId, expiresInDays ?? null, rotatedFrom])).rows[0];
    return { ...row, key: k.full };
  }

  app.post('/orgs/:orgId/api-keys', { config: mgmt, preHandler: requireOrg('org:apikeys:manage'), schema: { tags: ['api keys'], params: orgParams, body: apiKeyBody } }, async (req, reply) => {
    const user = requireUser(req);
    const b = bodyOf(req, apiKeyBody);
    const allowed = ORG_ROLE_PERMISSIONS[req.org!.type as OrgType].owner as readonly string[];
    const bad = b.scopes.filter((s) => !allowed.includes(s) || s.startsWith('org:members') || s === 'org:apikeys:manage');
    if (bad.length) throw badRequest(`Scopes not allowed for API keys: ${bad.join(', ')}`);
    const key = await insertKey(req.org!.id, user.id, b.name, b.scopes, b.expiresInDays, null);
    await audit(db, req, { action: 'api_key.create', resourceType: 'api_key', resourceId: key.id, orgId: req.org!.id, after: { name: b.name, scopes: b.scopes } });
    return reply.status(201).send({ data: key, notice: 'Store this key now. It will not be shown again.' });
  });

  app.post('/orgs/:orgId/api-keys/:id/rotate', { config: mgmt, preHandler: requireOrg('org:apikeys:manage'), schema: { tags: ['api keys'], params: inviteParams } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, inviteParams);
    const old = (await db.query('SELECT * FROM api_keys WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL', [id, req.org!.id])).rows[0];
    if (!old) throw notFound();
    const key = await insertKey(req.org!.id, user.id, old.name, old.scopes, undefined, old.id);
    await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [old.id, user.id]);
    await audit(db, req, { action: 'api_key.rotate', resourceType: 'api_key', resourceId: old.id, orgId: req.org!.id, after: { newKeyId: key.id } });
    return { data: key, notice: 'Store this key now. The previous key has been revoked.' };
  });

  app.delete('/orgs/:orgId/api-keys/:id', { config: mgmt, preHandler: requireOrg('org:apikeys:manage', { allowSuspended: true }), schema: { tags: ['api keys'], params: inviteParams } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, inviteParams);
    const r = await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $3 WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL', [id, req.org!.id, user.id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'api_key.revoke', resourceType: 'api_key', resourceId: id, orgId: req.org!.id });
    return { ok: true };
  });
}
