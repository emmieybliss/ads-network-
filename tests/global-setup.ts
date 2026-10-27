/**
 * Brings the test database up to the latest migration once per run, and checks
 * that Redis is reachable before any test tries to use it.
 *
 * It deliberately does not drop the schema: rolling every migration down and up
 * is itself covered by tests/integration/migrations.test.ts.
 */
import { Redis } from 'ioredis';
import { createPool, migrateUp } from '@blissnova/database';
import { testDatabaseUrl, testRedisUrl } from './helpers/env';

export default async function setup() {
  const pool = createPool(testDatabaseUrl());
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(
      `Cannot reach the test database at ${testDatabaseUrl().replace(/:[^:@/]*@/, ':***@')}. ` +
        `Start Postgres and create the database, or set TEST_DATABASE_URL. (${(err as Error).message})`,
    );
  }
  await migrateUp(pool);
  await pool.end();

  const redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`Cannot reach the test Redis at ${testRedisUrl()}. Start Redis or set TEST_REDIS_URL. (${(err as Error).message})`);
  } finally {
    redis.disconnect();
  }
}
