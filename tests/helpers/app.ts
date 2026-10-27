/**
 * Integration-test harness: a real Fastify app, a real Postgres and a real
 * Redis database, with a per-test reset.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Redis } from 'ioredis';
import { buildApp, type BuildOptions } from '@blissnova/api';
import { loadConfig, type AppConfig } from '@blissnova/api/config';
import { invalidateServingCache } from '@blissnova/api/services/serving';
import { testDatabaseUrl, testRedisUrl } from './env';

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function b64key() {
  return randomBytes(32).toString('base64');
}

export function testConfig(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    APP_SECRET: 'test-secret-value-at-least-32-characters-long',
    ENCRYPTION_KEY: b64key(),
    TRACKING_TOKEN_KEYS: `t1:${b64key()}`,
    EVENT_PROCESSING: 'inline',
    COOKIE_SECURE: 'false',
    ENABLE_DEV_PAYMENTS: 'true',
    VERIFICATION_ALLOW_HTTP: 'true',
    EMAIL_PROVIDER: 'disabled',
    STORAGE_DIR: './storage/test',
    ...extra,
  } as NodeJS.ProcessEnv);
}

/** Tables wiped between tests. Order does not matter: one TRUNCATE, CASCADE. */
const WIPE = [
  'users',
  'organizations',
  'sites',
  'campaigns',
  'ad_events',
  'ledger_accounts',
  'ledger_transactions',
  'payments',
  'payment_webhook_events',
  'refunds',
  'invoices',
  'settlements',
  'payouts',
  'disputes',
  'audit_logs',
  'security_events',
  'auth_events',
  'platform_settings',
  'content_items',
  'pricing_plans',
  'notifications',
  'email_outbox',
  'abuse_reports',
  'anomaly_alerts',
  'fraud_cases',
  'daily_stats',
  'unit_request_stats',
  'campaign_daily_spend',
  'inventory_rules',
  'provider_checks',
  'data_exports',
  'admin_notes',
];

export interface Harness {
  app: FastifyInstance;
  db: Pool;
  redis: Redis;
  config: AppConfig;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(extraEnv: Record<string, string> = {}, opts: { overrides?: BuildOptions['overrides']; config?: (c: AppConfig) => AppConfig } = {}): Promise<Harness> {
  const base = testConfig(extraEnv);
  const config = opts.config ? opts.config(base) : base;
  const app = await buildApp({ config, logger: false, overrides: opts.overrides });
  await app.ready();
  const db = app.ctx.db;
  const redis = app.ctx.redis;

  const reset = async () => {
    // audit_logs and campaign_history have triggers forbidding DELETE, so
    // TRUNCATE (which bypasses row triggers) is the only way to clear them.
    //
    // Some writes (audit entries, security events) are deliberately
    // fire-and-forget in the request path, so one can still be in flight when
    // the next test starts and deadlock against the TRUNCATE. Retry briefly
    // rather than failing an unrelated test.
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(`TRUNCATE ${WIPE.join(', ')} CASCADE`);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if ((code !== '40P01' && code !== '55P03') || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    await redis.flushdb();
    app.ctx.settings.invalidate();
    invalidateServingCache(app.ctx);
  };
  await reset();

  return {
    app,
    db,
    redis,
    config,
    reset,
    close: async () => {
      await app.close();
    },
  };
}
