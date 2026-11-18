import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PlatformSettings } from '@blissnova/shared';
import type { AppContext } from '../lib/context';
import { decryptSecret, newBackupCodes, normalizeBackupCode, randomToken, sha256, totpStep } from '../lib/crypto';

/** Cookie that lets a browser skip the code for TRUST_DAYS after the person ticks "Don't ask again on this device". */
export const TRUST_COOKIE = 'bn_mfa_trust';
export const TRUST_DAYS = 30;

type Db = Pick<AppContext['db'], 'query'>;

function backupHash(ctx: Pick<AppContext, 'config'>, code: string) {
  return createHmac('sha256', ctx.config.APP_SECRET).update(`mfa-backup:${normalizeBackupCode(code)}`).digest('hex');
}

/**
 * Check an authenticator code. A code is accepted once: the step it belongs
 * to is recorded, and the same or an earlier step is refused afterwards, so a
 * code seen over someone's shoulder cannot be replayed.
 */
export async function useTotp(ctx: Pick<AppContext, 'config' | 'db'>, userId: string, secretEnc: string | null, code: string): Promise<boolean> {
  if (!secretEnc) return false;
  const step = totpStep(decryptSecret(ctx.config.ENCRYPTION_KEY, secretEnc), code);
  if (step === null) return false;
  const r = await ctx.db.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2) RETURNING id', [userId, step]);
  return Boolean(r.rowCount);
}

/** Spend a backup code. Returns the codes left, or null when the code is not valid (or already used). */
export async function useBackupCode(ctx: Pick<AppContext, 'config' | 'db'>, userId: string, code: string): Promise<number | null> {
  if (normalizeBackupCode(code).length !== 8) return null;
  const r = await ctx.db.query('UPDATE mfa_backup_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id', [userId, backupHash(ctx, code)]);
  if (!r.rowCount) return null;
  return backupCodesLeft(ctx.db, userId);
}

export async function backupCodesLeft(db: Db, userId: string) {
  return Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL', [userId])).rows[0]!.n);
}

/** Replace a person's backup codes with ten new ones; returns them in the clear, once. */
export async function issueBackupCodes(ctx: Pick<AppContext, 'config'>, db: Db, userId: string): Promise<string[]> {
  const codes = newBackupCodes();
  await db.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
  for (const c of codes) await db.query('INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)', [userId, backupHash(ctx, c)]);
  return codes;
}

/** Whether this browser is trusted for the person (and refresh its last use). */
export async function trustedDevice(ctx: Pick<AppContext, 'db'>, req: FastifyRequest, userId: string): Promise<boolean> {
  const token = req.cookies?.[TRUST_COOKIE];
  if (!token || token.length < 20 || token.length > 100) return false;
  const r = await ctx.db.query(`UPDATE mfa_trusted_devices SET last_used_at = now() WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING id`, [sha256(token), userId]);
  return Boolean(r.rowCount);
}

export async function trustThisDevice(ctx: Pick<AppContext, 'db' | 'config'>, req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken(32);
  await ctx.db.query(`INSERT INTO mfa_trusted_devices (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, sha256(token), (req.headers['user-agent'] ?? '').slice(0, 300), TRUST_DAYS]);
  reply.setCookie(TRUST_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.COOKIE_SECURE, maxAge: TRUST_DAYS * 86_400 });
}

/** Forget every trusted browser, e.g. after a password change or when two-step verification is turned off. */
export async function revokeTrustedDevices(db: Db, userId: string) {
  return (await db.query(`UPDATE mfa_trusted_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).rowCount ?? 0;
}

/** Turn two-step verification off and remove everything that goes with it. */
export async function clearMfa(db: Db, userId: string) {
  await db.query('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, mfa_enabled_at = NULL, updated_at = now() WHERE id = $1', [userId]);
  await db.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
  await revokeTrustedDevices(db, userId);
}

/** Whether the platform requires two-step verification of this person (everyone, or staff only). */
export function mfaRequiredFor(s: PlatformSettings, user: { platformRole: string | null }): boolean {
  return s.platform.requireMfaForAllUsers || (s.platform.requireMfaForStaff && Boolean(user.platformRole));
}
