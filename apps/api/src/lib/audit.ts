import type { FastifyRequest } from 'fastify';

type Q = { query: (text: string, params?: unknown[]) => Promise<unknown> };

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  orgId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  actorType?: 'user' | 'system' | 'api_key' | 'provider';
  actorUserId?: string | null;
}

const REDACT = /password|secret|token|hash|key_hash|mfa/i;

/** Remove credential-like fields from before/after snapshots. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

export async function audit(db: Q, req: FastifyRequest | null, e: AuditEntry) {
  const actorUserId = e.actorUserId !== undefined ? e.actorUserId : req?.auth?.user?.id ?? null;
  const actorType = e.actorType ?? (req?.auth?.kind === 'api_key' ? 'api_key' : actorUserId ? 'user' : 'system');
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_type, org_id, action, resource_type, resource_id, before, after, reason, ip_hash, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [actorUserId, actorType, e.orgId ?? null, e.action, e.resourceType, e.resourceId ?? null,
      e.before === undefined ? null : JSON.stringify(redact(e.before)), e.after === undefined ? null : JSON.stringify(redact(e.after)),
      e.reason ?? null, req?.ipHash ?? null, req?.id ?? null],
  );
}
