import { z } from 'zod';

const bool = (def: boolean) => z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PUBLIC_SITE_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  /** Comma-separated origins allowed to call management APIs with credentials (the dashboard). */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: bool(false),
  /** Header set by a trusted CDN/proxy carrying the visitor's ISO country code, e.g. cf-ipcountry. Empty = country unknown. */
  GEO_COUNTRY_HEADER: z.string().default(''),
  COOKIE_SECURE: bool(true),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 14),
  /** HMAC secret for pseudonymous identifiers (IP/visitor hashes) and email tokens. */
  APP_SECRET: z.string().min(32),
  /** base64 32-byte key used to encrypt MFA secrets at rest. */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes base64'),
  TRACKING_TOKEN_KEYS: z.string().min(10),
  STORAGE_DIR: z.string().default('./storage'),
  EMAIL_PROVIDER: z.enum(['smtp', 'log', 'disabled']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool(false),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Enables the development-only simulated payment provider. Never enable in production. */
  ENABLE_DEV_PAYMENTS: bool(false),
  /** inline: process tracking events in the request (tests/small installs); queue: hand off to the worker. */
  EVENT_PROCESSING: z.enum(['inline', 'queue']).default('queue'),
  /** Allow http:// (not just https://) when fetching verification files. Development only. */
  VERIFICATION_ALLOW_HTTP: bool(false),
  /** Comma-separated hosts that may be fetched for verification even if they resolve to private addresses (development only). */
  VERIFICATION_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  ERROR_REPORT_WEBHOOK_URL: z.string().url().optional(),
  SEED_DEMO_DATA: bool(false),
});

export type AppConfig = z.infer<typeof envSchema> & { corsOrigins: string[]; isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  if (isProd) {
    if (c.ENABLE_DEV_PAYMENTS) throw new Error('ENABLE_DEV_PAYMENTS must not be enabled in production');
    if (c.VERIFICATION_ALLOW_HTTP || c.VERIFICATION_PRIVATE_HOST_ALLOWLIST) throw new Error('Verification development overrides must not be set in production');
    if (!c.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (/change-me|example|placeholder/i.test(c.APP_SECRET)) throw new Error('APP_SECRET still has a placeholder value');
  }
  return { ...c, corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean), isProd };
}
