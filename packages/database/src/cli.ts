import { createPool } from './pool';
import { migrateDown, migrateUp, loadMigrations } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(url, 2);
const cmd = process.argv[2] ?? 'up';
try {
  if (cmd === 'up') {
    const applied = await migrateUp(pool, console.log);
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } else if (cmd === 'down') {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_ROLLBACK !== 'yes') {
      throw new Error('Refusing to roll back in production without ALLOW_PRODUCTION_ROLLBACK=yes. Restore from backup instead; see docs/operations.md.');
    }
    await migrateDown(pool, Number(process.argv[3] ?? 1), console.log);
  } else if (cmd === 'status') {
    const done = new Set((await pool.query('SELECT id FROM schema_migrations').catch(() => ({ rows: [] }))).rows.map((r: { id: string }) => r.id));
    for (const m of loadMigrations()) console.log(`${done.has(m.id) ? '[x]' : '[ ]'} ${m.id}`);
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
