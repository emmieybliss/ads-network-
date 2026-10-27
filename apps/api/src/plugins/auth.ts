import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { orgRoleHas, platformRoleHas, type OrgPermission, type OrgRole, type OrgType, type PlatformPermission, type PlatformRole } from '@blissnova/shared';
import fp from 'fastify-plugin';
import { ipHash } from '@blissnova/tracking';
import { AppError, forbidden, notFound, unauthenticated } from '../lib/errors';
import { randomToken, safeEqual, sha256, verifyPassword } from '../lib/crypto';

export interface AuthUser { id: string; email: string; name: string; platformRole: PlatformRole | null; mfaEnabled: boolean; emailVerified: boolean }
export interface AuthState {
  kind: 'session' | 'api_key';
  user: AuthUser | null;
  session: { id: string; mfaVerified: boolean; stepUpAt: Date | null } | null;
  apiKey: { id: string; orgId: string; scopes: string[] } | null;
}
export interface OrgContext { id: string; type: OrgType; status: string; role: OrgRole | null; currency: string; name: string }

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState | null;
    org: OrgContext | null;
    ipHash: string;
  }
  interface FastifyContextConfig {
    csrfExempt?: boolean;
  }
}

export const SESSION_COOKIE = 'bn_session';
export const CSRF_COOKIE = 'bn_csrf';
const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function authPluginFn(app: FastifyInstance) {
  app.decorateRequest('auth', null);
  app.decorateRequest('org', null);
  app.decorateRequest('ipHash', '');

  app.addHook('onRequest', async (req) => {
    req.ipHash = ipHash(app.ctx.config.APP_SECRET, req.ip);
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer bnk_')) {
      req.auth = await loadApiKey(app, authz.slice(7));
      return;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await loadSession(app, token);
  });

  // Double-submit CSRF protection for cookie-authenticated state changes.
  app.addHook('preHandler', async (req) => {
    if (!UNSAFE.has(req.method) || req.auth?.kind !== 'session' || req.routeOptions.config?.csrfExempt) return;
    const header = req.headers['x-csrf-token'];
    const cookie = req.cookies[CSRF_COOKIE];
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) {
      throw new AppError(403, 'forbidden', 'Missing or invalid CSRF token');
    }
  });
}

/**
 * Wrapped with fastify-plugin so the request decorators and the onRequest/CSRF
 * hooks apply to every sibling route, not only to routes registered inside this
 * plugin's own scope.
 */
export const authPlugin = fp(authPluginFn, { name: 'blissnova-auth' });

async function loadSession(app: FastifyInstance, token: string): Promise<AuthState | null> {
  const r = await app.ctx.db.query(
    `SELECT s.id AS session_id, s.mfa_verified, s.step_up_at, s.last_seen_at, u.id, u.email, u.name, u.platform_role, u.mfa_enabled, u.email_verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    void app.ctx.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => undefined);
  }
  return {
    kind: 'session',
    user: { id: row.id, email: row.email, name: row.name, platformRole: row.platform_role, mfaEnabled: row.mfa_enabled, emailVerified: Boolean(row.email_verified_at) },
    session: { id: row.session_id, mfaVerified: row.mfa_verified, stepUpAt: row.step_up_at ? new Date(row.step_up_at) : null },
    apiKey: null,
  };
}

/** API keys look like bnk_<prefix>_<secret>; only a hash of the secret is stored. */
async function loadApiKey(app: FastifyInstance, raw: string): Promise<AuthState | null> {
  const m = /^bnk_([a-z0-9]{12})_([A-Za-z0-9_-]{32,})$/.exec(raw);
  if (!m) return null;
  const r = await app.ctx.db.query(
    `SELECT k.id, k.org_id, k.scopes, k.key_hash FROM api_keys k JOIN organizations o ON o.id = k.org_id
     WHERE k.prefix = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND o.status <> 'suspended'`, [m[1]]);
  const row = r.rows[0];
  if (!row || !safeEqual(row.key_hash, sha256(m[2]!))) return null;
  void app.ctx.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
  return { kind: 'api_key', user: null, session: null, apiKey: { id: row.id, orgId: row.org_id, scopes: row.scopes } };
}

export function newApiKeySecret() {
  const prefix = randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12);
  const secret = randomToken(32);
  return { prefix, secret, full: `bnk_${prefix}_${secret}`, hash: sha256(secret) };
}

// ------------------------------------------------------------------ guards

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.auth || req.auth.kind !== 'session' || !req.auth.user) throw unauthenticated();
  return req.auth.user;
}

/** Platform staff permission check. Optionally enforces MFA for staff via settings. */
export function requirePlatform(perm: PlatformPermission) {
  return async (req: FastifyRequest) => {
    const user = requireUser(req);
    if (!platformRoleHas(user.platformRole, perm)) throw forbidden();
    const s = await req.server.ctx.settings.get();
    if (s.platform.requireMfaForStaff && (!user.mfaEnabled || !req.auth?.session?.mfaVerified)) {
      throw new AppError(403, 'mfa_required', 'Multi-factor authentication is required for staff accounts');
    }
  };
}

/**
 * Organization permission check for routes with :orgId. Non-members receive
 * 404 so the existence of other organizations is never revealed. API keys
 * may act only on their own organization and within their scopes.
 */
export function requireOrg(perm: OrgPermission, opts: { type?: OrgType; allowSuspended?: boolean } = {}) {
  return async (req: FastifyRequest) => {
    const orgId = (req.params as { orgId?: string }).orgId;
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) throw notFound();
    if (!req.auth) throw unauthenticated();
    let role: OrgRole | null = null;
    if (req.auth.kind === 'api_key') {
      if (req.auth.apiKey!.orgId !== orgId || !req.auth.apiKey!.scopes.includes(perm)) throw notFound();
    }
    const r = await req.server.ctx.db.query(
      `SELECT o.id, o.type, o.status, o.currency, o.name, m.role FROM organizations o
       LEFT JOIN memberships m ON m.org_id = o.id AND m.user_id = $2 WHERE o.id = $1`,
      [orgId, req.auth.user?.id ?? null],
    );
    const row = r.rows[0];
    if (!row) throw notFound();
    if (req.auth.kind === 'session') {
      if (!row.role) throw notFound();
      role = row.role;
      if (!orgRoleHas(row.type, row.role, perm)) throw forbidden();
      if (!perm.endsWith(':read') && !req.auth.user!.emailVerified) throw forbidden('Verify your email address before making changes');
    }
    if (opts.type && row.type !== opts.type) throw notFound();
    if (row.status === 'suspended' && !opts.allowSuspended && !perm.endsWith(':read')) {
      throw forbidden('This organization is suspended. Contact support.');
    }
    req.org = { id: row.id, type: row.type, status: row.status, role, currency: row.currency, name: row.name };
  };
}

/** Sensitive actions require a password (and TOTP, if enabled) re-check within the last 10 minutes. */
export function requireStepUp(req: FastifyRequest) {
  const at = req.auth?.session?.stepUpAt;
  if (!at || Date.now() - at.getTime() > STEP_UP_WINDOW_MS) {
    throw new AppError(403, 'step_up_required', 'Confirm your password to continue with this action');
  }
}

export async function checkPassword(app: FastifyInstance, userId: string, password: string) {
  const r = await app.ctx.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return r.rows[0] ? verifyPassword(r.rows[0].password_hash, password) : false;
}

export function setSessionCookies(reply: FastifyReply, token: string, ttlHours: number, secure: boolean) {
  const maxAge = ttlHours * 3600;
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge });
  // Readable by the dashboard so it can echo it in X-CSRF-Token.
  reply.setCookie(CSRF_COOKIE, randomToken(24), { path: '/', httpOnly: false, sameSite: 'lax', secure, maxAge });
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure });
  reply.clearCookie(CSRF_COOKIE, { path: '/', secure });
}
