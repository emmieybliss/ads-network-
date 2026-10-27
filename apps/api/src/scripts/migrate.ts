/** Apply pending database migrations (used by container images, where the TypeScript CLI is not available). */
import { createPool, migrateUp } from '@blissnova/database';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  const applied = await migrateUp(pool, console.log);
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
