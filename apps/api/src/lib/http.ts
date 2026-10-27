import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

/** Typed access to a body/query/params value already validated by the route's zod schema. */
export const bodyOf = <T extends ZodType>(req: FastifyRequest, _s: T) => req.body as z.infer<T>;
export const queryOf = <T extends ZodType>(req: FastifyRequest, _s: T) => req.query as z.infer<T>;
export const paramsOf = <T extends ZodType>(req: FastifyRequest, _s: T) => req.params as z.infer<T>;

export const uuid = z.uuid();
export const orgParams = z.object({ orgId: z.uuid() });
export const idParams = z.object({ id: z.uuid() });
export const orgIdParams = z.object({ orgId: z.uuid(), id: z.uuid() });
export const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) });
export const optionalReasonBody = z.object({ reason: z.string().trim().max(1000).optional() });
export const moneyString = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use a decimal amount such as 125.50');
export const dateRange = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export function resolveRange(q: { from?: string; to?: string }, defaultDays = 30) {
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  const from = q.from ?? new Date(Date.parse(to) - (defaultDays - 1) * 86_400_000).toISOString().slice(0, 10);
  if (from > to) return { from: to, to: from };
  return { from, to };
}

/** RFC 4180 CSV with formula-injection protection for spreadsheet apps. */
export function toCsv(rows: Array<Record<string, unknown>>, columns: Array<{ key: string; label: string }>): string {
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\r\n') + '\r\n';
}
