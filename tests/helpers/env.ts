/** Test-time connection strings, kept in one place so every helper agrees. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://bn:bn@localhost:5432/blissnova_test';
}

/** Database 1, so a developer's local cache in database 0 is never flushed. */
export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
}
