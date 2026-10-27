import { z } from 'zod';

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PageQuery = z.infer<typeof pageQuery>;

/** Resolve a user-supplied sort key against an allowlist of SQL expressions; never interpolate user input directly. */
export function orderBy(q: PageQuery, allowed: Record<string, string>, fallback: string): string {
  const col = (q.sort && allowed[q.sort]) || allowed[fallback] || fallback;
  return `${col} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
}

export function pageMeta(q: PageQuery, total: number) {
  return { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export const offset = (q: PageQuery) => (q.page - 1) * q.pageSize;
