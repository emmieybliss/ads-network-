import { defineConfig } from 'vitest/config';

/**
 * Integration and security tests talk to a real Postgres and Redis, because the
 * things worth testing here (deferred constraint triggers, conditional budget
 * updates, Redis Lua frequency caps) do not exist in a mock.
 *
 * Expected locally and in CI:
 *   TEST_DATABASE_URL=postgres://.../blissnova_test
 *   TEST_REDIS_URL=redis://localhost:6379/1
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Integration tests share one database; running files in parallel would
    // interleave their transactions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      EVENT_PROCESSING: 'inline',
      LOG_LEVEL: 'silent',
      COOKIE_SECURE: 'false',
      ENABLE_DEV_PAYMENTS: 'true',
      VERIFICATION_ALLOW_HTTP: 'true',
      EMAIL_PROVIDER: 'disabled',
    },
    reporters: ['default'],
  },
});
