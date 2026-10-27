import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ORG_ROLE_PERMISSIONS, PLATFORM_ROLE_PERMISSIONS, type OrgType, type OrgRole } from '@blissnova/shared';
import { AppError, badRequest, notFound } from '../lib/errors';
import { decryptSecret, dummyVerify, encryptSecret, hashPassword, newTotpSecret, randomToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto';
import { hit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { bodyOf, idParams, paramsOf } from '../lib/http';
import { checkPassword, clearSessionCookies, requireStepUp, requireUser, setSessionCookies } from '../plugins/auth';
import { queueEmail } from '../services/notifications';
import { createOrganization } from '../services/orgs';

const password = z.string().min(12, 'Use at least 12 characters').max(256);
const email = z.email().max(254).transform((v) => v.toLowerCase());

const registerBody = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(120),
  accountType: z.enum(['advertiser', 'publisher']).optional(),
  organizationName: z.string().trim().min(1).max(160).optional(),
});
const loginBody = z.object({ email, password: z.string().min(1).max(256), totp: z.string().regex(/^\d{6}$/).optional() });
const tokenBody = z.object({ token: z.string().min(20).max(200) });
const resetBody = z.object({ token: z.string().min(20).max(200), password });
const changePwBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: password });
const stepUpBody = z.object({ password: z.string().min(1).max(256), totp: z.string().regex(/^\d{6}$/).optional() });
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) });

async function createSession(app: FastifyInstance, req: FastifyRequest, userId: string, mfaVerified: boolean) {
  const token = randomToken(32);
  const ttl = app.ctx.config.SESSION_TTL_HOURS;
  await app.ctx.db.query(
    `INSERT INTO sessions (user_id, token_hash, ip_hash, user_agent, mfa_verified, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [userId, sha256(token), req.ipHash, (req.headers['user-agent'] ?? '').slice(0, 300), mfaVerified, ttl],
  );
  return token;
}

async function issueUserToken(app: FastifyInstance, userId: string, purpose: 'verify_email' | 'reset_password', hours: number) {
  const token = randomToken(32);
  await app.ctx.db.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await app.ctx.db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`, [userId, purpose, sha256(token), hours]);
  return token;
}

async function consumeUserToken(app: FastifyInstance, token: string, purpose: 'verify_email' | 'reset_password') {
  const r = await app.ctx.db.query<{ user_id: string }>(
    `UPDATE user_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), purpose],
  );
  if (!r.rows[0]) throw badRequest('This link is invalid or has expired');
  return r.rows[0].user_id;
}

async function authEvent(app: FastifyInstance, req: FastifyRequest, type: string, userId: string | null, emailAddr?: string, detail?: string) {
  await app.ctx.db.query(
    'INSERT INTO auth_events (user_id, email_hash, type, ip_hash, user_agent, detail) VALUES ($1, $2, $3, $4, $5, $6)',
    [userId, emailAddr ? sha256(`${app.ctx.config.APP_SECRET}:${emailAddr}`).slice(0, 32) : null, type, req.ipHash, (req.headers['user-agent'] ?? '').slice(0, 300), detail ?? null],
  );
}

export async function profile(app: FastifyInstance, userId: string) {
  const u = (await app.ctx.db.query(`SELECT id, email, name, platform_role, mfa_enabled, email_verified_at, created_at FROM users WHERE id = $1`, [userId])).rows[0];
  const orgs = (await app.ctx.db.query(
    `SELECT o.id, o.name, o.type, o.status, o.currency, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.created_at`, [userId])).rows;
  return {
    id: u.id, email: u.email, name: u.name, platformRole: u.platform_role, mfaEnabled: u.mfa_enabled, emailVerified: Boolean(u.email_verified_at), createdAt: u.created_at,
    platformPermissions: u.platform_role ? PLATFORM_ROLE_PERMISSIONS[u.platform_role as keyof typeof PLATFORM_ROLE_PERMISSIONS] : [],
    organizations: orgs.map((o) => ({ id: o.id, name: o.name, type: o.type, status: o.status, currency: o.currency, role: o.role, permissions: ORG_ROLE_PERMISSIONS[o.type as OrgType][o.role as OrgRole] })),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx;
  const rl = { rateLimit: { bucket: 'auth' as const }, allowDuringMaintenance: true };

  app.post('/auth/register', { config: rl, schema: { tags: ['auth'], body: registerBody } }, async (req, reply) => {
    const b = bodyOf(req, registerBody);
    const s = await app.ctx.settings.get();
    if (!s.platform.registrationOpen) throw new AppError(403, 'forbidden', 'Registration is currently closed');
    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [b.email]);
    if (existing.rowCount) {
      // Do not reveal whether the address is registered; tell the owner instead.
      await queueEmail(app.ctx, b.email, 'suspicious_activity', { detail: 'Someone tried to create a new account with your email address. If this was you, sign in or reset your password instead.' });
      return reply.status(202).send({ status: 'pending_verification', message: 'Check your email to continue.' });
    }
    const hash = await hashPassword(b.password);
    const user = (await db.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [b.email, b.name, hash])).rows[0]!;
    if (b.accountType) await createOrganization(app.ctx, req, user.id, { name: b.organizationName ?? `${b.name}'s ${b.accountType === 'advertiser' ? 'Advertising' : 'Publishing'}`, type: b.accountType });
    const token = await issueUserToken(app, user.id, 'verify_email', 24);
    await queueEmail(app.ctx, b.email, 'verify_email', { name: b.name, link: `${config.PUBLIC_SITE_URL}/verify-email?token=${token}` });
    await audit(db, req, { action: 'user.register', resourceType: 'user', resourceId: user.id, actorUserId: user.id });
    const session = await createSession(app, req, user.id, false);
    setSessionCookies(reply, session, config.SESSION_TTL_HOURS, config.COOKIE_SECURE);
    return reply.status(201).send({ user: await profile(app, user.id) });
  });

  app.post('/auth/login', { config: rl, schema: { tags: ['auth'], body: loginBody } }, async (req, reply) => {
    const b = bodyOf(req, loginBody);
    const lockKey = `login:${sha256(b.email).slice(0, 24)}`;
    const failures = Number((await app.ctx.redis.get(`rl:${lockKey}:fail`)) ?? 0);
    if (failures >= 5) {
      await authEvent(app, req, 'locked_out', null, b.email);
      throw new AppError(429, 'rate_limited', 'Too many failed attempts. Try again in 15 minutes or reset your password.');
    }
    const u = (await db.query('SELECT id, password_hash, status, mfa_enabled, mfa_secret_enc FROM users WHERE email = $1', [b.email])).rows[0];
    const fail = async (userId: string | null, detail: string) => {
      await hit(app.ctx.redis, `${lockKey}:fail`, 5, 900);
      await authEvent(app, req, 'login_failure', userId, b.email, detail);
      throw new AppError(401, 'unauthenticated', 'Incorrect email or password');
    };
    if (!u) {
      await dummyVerify(b.password);
      return fail(null, 'unknown_email');
    }
    if (!(await verifyPassword(u.password_hash, b.password))) return fail(u.id, 'bad_password');
    if (u.status !== 'active') {
      await authEvent(app, req, 'login_failure', u.id, b.email, 'suspended');
      throw new AppError(403, 'forbidden', 'This account is suspended. Contact support.');
    }
    let mfaVerified = false;
    if (u.mfa_enabled) {
      if (!b.totp) return reply.status(200).send({ mfaRequired: true });
      if (!verifyTotp(decryptSecret(config.ENCRYPTION_KEY, u.mfa_secret_enc), b.totp)) {
        await authEvent(app, req, 'mfa_failure', u.id, b.email);
        return fail(u.id, 'bad_totp');
      }
      mfaVerified = true;
    }
    await app.ctx.redis.del(`rl:${lockKey}:fail`);
    const token = await createSession(app, req, u.id, mfaVerified);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await authEvent(app, req, 'login_success', u.id, b.email);
    setSessionCookies(reply, token, config.SESSION_TTL_HOURS, config.COOKIE_SECURE);
    return { user: await profile(app, u.id) };
  });

  app.post('/auth/logout', { config: { allowDuringMaintenance: true }, schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.auth?.session) {
      await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [req.auth.session.id]);
      await authEvent(app, req, 'logout', req.auth.user!.id);
    }
    clearSessionCookies(reply, config.COOKIE_SECURE);
    return { ok: true };
  });

  app.get('/auth/me', { schema: { tags: ['auth'] } }, async (req) => {
    const user = requireUser(req);
    return { user: await profile(app, user.id) };
  });

  app.post('/auth/verify-email', { config: rl, schema: { tags: ['auth'], body: tokenBody } }, async (req) => {
    const userId = await consumeUserToken(app, bodyOf(req, tokenBody).token, 'verify_email');
    await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [userId]);
    await audit(db, req, { action: 'user.email_verified', resourceType: 'user', resourceId: userId, actorUserId: userId });
    return { ok: true };
  });

  app.post('/auth/resend-verification', { config: rl, schema: { tags: ['auth'] } }, async (req) => {
    const user = requireUser(req);
    if (user.emailVerified) return { ok: true };
    const token = await issueUserToken(app, user.id, 'verify_email', 24);
    await queueEmail(app.ctx, user.email, 'verify_email', { name: user.name, link: `${config.PUBLIC_SITE_URL}/verify-email?token=${token}` });
    return { ok: true };
  });

  app.post('/auth/password-reset/request', { config: rl, schema: { tags: ['auth'], body: z.object({ email }) } }, async (req) => {
    const { email: addr } = req.body as { email: string };
    const u = (await db.query(`SELECT id, name FROM users WHERE email = $1 AND status = 'active'`, [addr])).rows[0];
    if (u) {
      const token = await issueUserToken(app, u.id, 'reset_password', 1);
      await queueEmail(app.ctx, addr, 'reset_password', { name: u.name, link: `${config.PUBLIC_SITE_URL}/reset-password?token=${token}` });
    }
    return { ok: true, message: 'If an account exists for that address, a reset link is on its way.' };
  });

  app.post('/auth/password-reset/confirm', { config: rl, schema: { tags: ['auth'], body: resetBody } }, async (req) => {
    const b = bodyOf(req, resetBody);
    const userId = await consumeUserToken(app, b.token, 'reset_password');
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await hashPassword(b.password)]);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await authEvent(app, req, 'password_reset', userId);
    await audit(db, req, { action: 'user.password_reset', resourceType: 'user', resourceId: userId, actorUserId: userId });
    return { ok: true };
  });

  app.post('/auth/password', { config: rl, schema: { tags: ['auth'], body: changePwBody } }, async (req) => {
    const user = requireUser(req);
    const b = bodyOf(req, changePwBody);
    if (!(await checkPassword(app, user.id, b.currentPassword))) throw new AppError(401, 'unauthenticated', 'Current password is incorrect');
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, await hashPassword(b.newPassword)]);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, req.auth!.session!.id]);
    await authEvent(app, req, 'password_changed', user.id);
    await audit(db, req, { action: 'user.password_changed', resourceType: 'user', resourceId: user.id });
    return { ok: true };
  });

  app.post('/auth/step-up', { config: rl, schema: { tags: ['auth'], body: stepUpBody } }, async (req) => {
    const user = requireUser(req);
    const b = bodyOf(req, stepUpBody);
    const u = (await db.query('SELECT password_hash, mfa_enabled, mfa_secret_enc FROM users WHERE id = $1', [user.id])).rows[0];
    const okPw = await verifyPassword(u.password_hash, b.password);
    const okMfa = !u.mfa_enabled || (b.totp !== undefined && verifyTotp(decryptSecret(config.ENCRYPTION_KEY, u.mfa_secret_enc), b.totp));
    if (!okPw || !okMfa) {
      await authEvent(app, req, 'step_up_failure', user.id);
      throw new AppError(401, 'unauthenticated', u.mfa_enabled && !b.totp ? 'Enter your authenticator code' : 'Confirmation failed');
    }
    await db.query('UPDATE sessions SET step_up_at = now(), mfa_verified = mfa_verified OR $2 WHERE id = $1', [req.auth!.session!.id, u.mfa_enabled]);
    await authEvent(app, req, 'step_up', user.id);
    return { ok: true, validForSeconds: 600 };
  });

  app.post('/auth/mfa/setup', { config: rl, schema: { tags: ['auth'] } }, async (req) => {
    const user = requireUser(req);
    if (user.mfaEnabled) throw badRequest('MFA is already enabled');
    const secret = newTotpSecret();
    await db.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [user.id, encryptSecret(config.ENCRYPTION_KEY, secret)]);
    const s = await app.ctx.settings.get();
    const label = encodeURIComponent(`${s.branding.productName}:${user.email}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(s.branding.productName)}&algorithm=SHA1&digits=6&period=30` };
  });

  app.post('/auth/mfa/enable', { config: rl, schema: { tags: ['auth'], body: codeBody } }, async (req) => {
    const user = requireUser(req);
    const u = (await db.query('SELECT mfa_secret_enc FROM users WHERE id = $1', [user.id])).rows[0];
    if (!u?.mfa_secret_enc || !verifyTotp(decryptSecret(config.ENCRYPTION_KEY, u.mfa_secret_enc), bodyOf(req, codeBody).code)) throw badRequest('The code is not valid. Check your authenticator app and try again.');
    await db.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [user.id]);
    await db.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [req.auth!.session!.id]);
    await audit(db, req, { action: 'user.mfa_enabled', resourceType: 'user', resourceId: user.id });
    return { ok: true };
  });

  app.post('/auth/mfa/disable', { config: rl, schema: { tags: ['auth'], body: codeBody } }, async (req) => {
    const user = requireUser(req);
    requireStepUp(req);
    const u = (await db.query('SELECT mfa_secret_enc FROM users WHERE id = $1', [user.id])).rows[0];
    if (!u?.mfa_secret_enc || !verifyTotp(decryptSecret(config.ENCRYPTION_KEY, u.mfa_secret_enc), bodyOf(req, codeBody).code)) throw badRequest('The code is not valid');
    await db.query('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1', [user.id]);
    await audit(db, req, { action: 'user.mfa_disabled', resourceType: 'user', resourceId: user.id });
    return { ok: true };
  });

  app.get('/auth/sessions', { schema: { tags: ['auth'] } }, async (req) => {
    const user = requireUser(req);
    const rows = (await db.query(`SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [user.id])).rows;
    return { data: rows.map((r) => ({ id: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, current: r.id === req.auth!.session!.id })) };
  });

  app.delete('/auth/sessions/:id', { schema: { tags: ['auth'], params: idParams } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const r = await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [id, user.id]);
    if (!r.rowCount) throw notFound();
    await authEvent(app, req, 'session_revoked', user.id);
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-others', { schema: { tags: ['auth'] } }, async (req) => {
    const user = requireUser(req);
    const r = await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoked_all' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, req.auth!.session!.id]);
    await authEvent(app, req, 'session_revoked', user.id, undefined, `count=${r.rowCount}`);
    return { revoked: r.rowCount };
  });

  app.get('/notifications', { schema: { tags: ['notifications'] } }, async (req) => {
    const user = requireUser(req);
    const rows = (await db.query(`SELECT id, org_id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.id])).rows;
    const unread = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [user.id])).rows[0]!.n;
    return { data: rows, unread: Number(unread) };
  });

  app.post('/notifications/read-all', { schema: { tags: ['notifications'] } }, async (req) => {
    const user = requireUser(req);
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    return { ok: true };
  });
}
