import type { Queryable } from '@blissnova/database';
import { LEGACY_SEED_BODIES, STARTER_CONTENT } from '@blissnova/shared';

export interface StarterInstallResult { added: number; replaced: number; skipped: number }

/**
 * Add the starter legal pages, policies and FAQs (packages/shared/src/starter-content.ts).
 * Items that already exist are left alone, except ones still holding text
 * written by an older seed script that nobody has edited; those get the new
 * draft. Safe to run any number of times.
 */
export async function installStarterContent(db: Queryable, opts: { publish: boolean; userId?: string | null }): Promise<StarterInstallResult> {
  const result: StarterInstallResult = { added: 0, replaced: 0, skipped: 0 };
  for (const item of STARTER_CONTENT) {
    const inserted = await db.query(
      `INSERT INTO content_items (kind, slug, title, body, sort_order, published, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (kind, slug) DO NOTHING RETURNING id`,
      [item.kind, item.slug, item.title, item.body, item.sortOrder, opts.publish, opts.userId ?? null],
    );
    if (inserted.rowCount) { result.added++; continue; }
    const replaced = await db.query(
      `UPDATE content_items SET title = $3, body = $4, sort_order = $5, published = published OR $6, updated_by = $7, updated_at = now()
        WHERE kind = $1 AND slug = $2 AND body = ANY($8::text[])`,
      [item.kind, item.slug, item.title, item.body, item.sortOrder, opts.publish, opts.userId ?? null, LEGACY_SEED_BODIES],
    );
    if (replaced.rowCount) result.replaced++;
    else result.skipped++;
  }
  return result;
}
