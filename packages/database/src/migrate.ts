import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Where the SQL files live: MIGRATIONS_DIR if set, the package's own folder when
 * run from source, or a copy placed next to a bundled build.
 */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ?? [join(here, '..', 'migrations'), join(here, 'migrations')].find((d) => existsSync(d))
  ?? join(here, '..', 'migrations');

interface Migration { id: string; up: string; down: string }

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort();
  return files.map((f) => {
    const id = f.replace('.up.sql', '');
    return { id, up: readFileSync(join(dir, f), 'utf8'), down: readFileSync(join(dir, `${id}.down.sql`), 'utf8') };
  });
}

async function ensureTable(pool: pg.Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
}

/** Apply pending migrations, each in its own transaction, under an advisory lock so concurrent deploys cannot race. */
export async function migrateUp(pool: pg.Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  await ensureTable(pool);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of loadMigrations()) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
        log(`applied ${m.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Roll back the most recent `steps` migrations. Intended for development; see docs/operations.md before using in production. */
export async function migrateDown(pool: pg.Pool, steps = 1, log: (m: string) => void = () => undefined): Promise<string[]> {
  await ensureTable(pool);
  const all = new Map(loadMigrations().map((m) => [m.id, m]));
  const rows = (await pool.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT $1', [steps])).rows;
  const rolled: string[] = [];
  for (const { id } of rows) {
    const m = all.get(id);
    if (!m) throw new Error(`No down migration found for ${id}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.down);
      await client.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
      await client.query('COMMIT');
      rolled.push(id);
      log(`rolled back ${id}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return rolled;
}
