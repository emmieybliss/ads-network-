import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PlatformPermission } from '@blissnova/shared';
import { requirePlatform, requireStepUp } from '../../plugins/auth';

export const mgmt = { rateLimit: { bucket: 'management' as const }, allowDuringMaintenance: true };

/** preHandler chain for admin routes: permission check, then optional step-up confirmation. */
export function guard(perm: PlatformPermission, opts: { stepUp?: boolean } = {}) {
  const check = requirePlatform(perm);
  return async (req: FastifyRequest) => {
    await check(req);
    if (opts.stepUp) requireStepUp(req);
  };
}

export const reasonRequired = z.object({ reason: z.string().trim().min(3, 'A reason is required').max(1000) });
export const reasonOptional = z.object({ reason: z.string().trim().max(1000).optional() });
export const adminList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  status: z.string().max(40).optional(),
  type: z.string().max(40).optional(),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type AdminList = z.infer<typeof adminList>;

/** Build WHERE clauses with positional parameters. */
export class Where {
  clauses: string[] = [];
  params: unknown[] = [];
  add(sql: string, value: unknown) {
    this.params.push(value);
    this.clauses.push(sql.replaceAll('?', `$${this.params.length}`));
    return this;
  }
  raw(sql: string) {
    this.clauses.push(sql);
    return this;
  }
  get sql() {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

export function sortSql(q: AdminList, allowed: Record<string, string>, fallback: string) {
  const col = (q.sort && allowed[q.sort]) || allowed[fallback]!;
  return `ORDER BY ${col} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
}

export const meta = (q: AdminList, total: number) => ({ page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) });
