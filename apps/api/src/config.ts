import { z } from 'zod';

const bool = (def: boolean) => z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  /**
   * The network's domain as publishers write it in ads.txt and as buyers see
   * it in sellers.json. Empty = the host of PUBLIC_SITE_URL.
   */
  ADS_TXT_DOMAIN: z.string().trim().toLowerCase().regex(/^$|^[a-z0-9.-]+$/, 'ADS_TXT_DOMAIN must be a bare host name such as example.com').default(''),
  // IAB Global Vendor List id, once the network is registered with IAB Europe. Empty: ads under GDPR stay contextual.
  TCF_VENDOR_ID: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).optional()),
  /** Comma-separated origins allowed to call management APIs with credentials (the dashboard). */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
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
  EMAIL_PROVIDER: z.enum(['smtp', 'log', 'file', 'disabled']).default('log'),
  /** EMAIL_PROVIDER=file: folder where each email is written as a .txt file (local demo only). */
  EMAIL_FILE_DIR: z.string().default('./outbox'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool(false),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** PayPal REST app (developer.paypal.com). Used for PayPal deposits by advertisers and PayPal payouts to publishers. */
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  /** Webhook id shown by PayPal when you add the webhook URL; required to verify PayPal webhooks. */
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  /** Enables the development-only simulated payment provider (deposits and payouts). Never enable in production. */
  ENABLE_DEV_PAYMENTS: bool(false),
  /** inline: process tracking events in the request (tests/small installs); queue: hand off to the worker. */
  EVENT_PROCESSING: z.enum(['inline', 'queue']).default('queue'),
  /** Allow http:// (not just https://) when fetching verification files. Development only. */
  VERIFICATION_ALLOW_HTTP: bool(false),
  /** Comma-separated hosts that may be fetched for verification even if they resolve to private addresses (development only). */
  VERIFICATION_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  /**
   * Development-only domain-verification simulator. It can only mark reserved,
   * non-public hostnames (localhost, *.test, *.example, ...) as verified, and
   * startup refuses it in production.
   */
  ENABLE_DEV_VERIFICATION_SIMULATOR: bool(false),
  /** Comma-separated DNS servers used for TXT verification lookups. Empty = the system resolver. */
  VERIFICATION_DNS_SERVERS: z.string().default(''),
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
  const corsOrigins = c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (isProd) {
    const problems = productionProblems(c, corsOrigins);
    if (problems.length) throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
  return { ...c, corsOrigins, isProd };
}

const PLACEHOLDER = /change-?me|example|placeholder|replace|your[-_]|xxxx|dev-only|test-secret/i;
const LOCAL_URL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

/**
 * Every reason the configuration is unsafe for production. Startup fails on
 * any of them rather than running half-protected.
 */
export function productionProblems(c: z.infer<typeof envSchema>, corsOrigins: string[]): string[] {
  const p: string[] = [];
  if (c.ENABLE_DEV_PAYMENTS) p.push('ENABLE_DEV_PAYMENTS must be false: the simulated payment provider is for local development only');
  if (Boolean(c.STRIPE_SECRET_KEY) !== Boolean(c.STRIPE_WEBHOOK_SECRET)) p.push('Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither');
  if (c.STRIPE_SECRET_KEY && !/^(sk|rk)_live_/.test(c.STRIPE_SECRET_KEY)) p.push('STRIPE_SECRET_KEY must be a live key (sk_live_ or rk_live_); test keys take no real payments');
  const paypal = [c.PAYPAL_CLIENT_ID, c.PAYPAL_CLIENT_SECRET, c.PAYPAL_WEBHOOK_ID].filter(Boolean).length;
  if (paypal > 0 && paypal < 3) p.push('Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID together, or none of them');
  if (paypal === 3 && c.PAYPAL_ENV !== 'live') p.push('PAYPAL_ENV must be live in production; sandbox moves no real money');
  if (c.ENABLE_DEV_VERIFICATION_SIMULATOR) p.push('ENABLE_DEV_VERIFICATION_SIMULATOR must be false: simulated domain verification is for local development only');
  if (c.VERIFICATION_ALLOW_HTTP || c.VERIFICATION_PRIVATE_HOST_ALLOWLIST) p.push('VERIFICATION_ALLOW_HTTP and VERIFICATION_PRIVATE_HOST_ALLOWLIST are development overrides and must be unset');
  if (c.SEED_DEMO_DATA) p.push('SEED_DEMO_DATA must be false');
  if (!c.COOKIE_SECURE) p.push('COOKIE_SECURE must be true (sessions need HTTPS)');
  if (PLACEHOLDER.test(c.APP_SECRET) || new Set(c.APP_SECRET).size < 10) p.push('APP_SECRET looks like a placeholder; generate a random value');
  if (PLACEHOLDER.test(c.TRACKING_TOKEN_KEYS)) p.push('TRACKING_TOKEN_KEYS looks like a placeholder; generate real keys');
  if (/^A+=*$/.test(c.ENCRYPTION_KEY)) p.push('ENCRYPTION_KEY is all zeros; generate a random key');
  if (LOCAL_URL.test(c.PUBLIC_SITE_URL) || LOCAL_URL.test(c.PUBLIC_API_URL)) p.push('PUBLIC_SITE_URL and PUBLIC_API_URL must be your public HTTPS addresses, not localhost');
  if (!c.PUBLIC_SITE_URL.startsWith('https://') || !c.PUBLIC_API_URL.startsWith('https://')) p.push('PUBLIC_SITE_URL and PUBLIC_API_URL must use https://');
  if (corsOrigins.some((o) => LOCAL_URL.test(o) || o === '*')) p.push('CORS_ORIGINS must list your production dashboard origin only');
  if (c.EMAIL_PROVIDER === 'file') p.push('EMAIL_PROVIDER=file only writes emails to a local folder; configure smtp (or disabled)');
  if (c.EMAIL_PROVIDER === 'log') p.push('EMAIL_PROVIDER=log writes verification and reset links to the log; configure smtp (or disabled)');
  if (c.EMAIL_PROVIDER === 'smtp' && !c.SMTP_HOST) p.push('EMAIL_PROVIDER=smtp needs SMTP_HOST');
  return p;
}
