import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import { z, ZodType } from 'zod';
import { Redis } from 'ioredis';
import { createPool } from '@blissnova/database';
import { parseKeyring } from '@blissnova/tracking';
import { DEFAULT_BRAND } from '@blissnova/shared';
import { loadConfig, type AppConfig } from './config';
import type { AppContext } from './lib/context';
import { AppError, errorHandler } from './lib/errors';
import { SettingsService } from './lib/settings';
import { createMailer } from './lib/mailer';
import { LocalStorage } from './lib/storage';
import { createQueues } from './lib/queue';
import { openGeoDb } from './lib/geo';
import { hit } from './lib/ratelimit';
import { authPlugin } from './plugins/auth';
import { PaymentProviderRegistry } from './services/payments/registry';
import { registerRoutes } from './routes';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    reportError?: (err: unknown, req?: FastifyRequest) => void;
  }
  interface FastifyContextConfig {
    rateLimit?: { bucket: 'auth' | 'management' | 'public' | 'serve' | 'events' | 'webhook'; limit?: number; windowSec?: number };
    allowDuringMaintenance?: boolean;
  }
}

export interface BuildOptions {
  config?: AppConfig;
  /** Override pieces of the context in tests. */
  overrides?: Partial<Pick<AppContext, 'db' | 'redis' | 'mailer' | 'verifier'>>;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.LOG_LEVEL,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]', '*.password', '*.token'], censor: '[redacted]' },
    },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1_000_000,
  });

  const db = opts.overrides?.db ?? createPool(config.DATABASE_URL);
  const redis = opts.overrides?.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  const queues = createQueues(redis, config.EVENT_PROCESSING === 'queue');
  const ctx: AppContext = {
    config, db, redis, queues,
    settings: new SettingsService(db),
    mailer: opts.overrides?.mailer ?? createMailer(config, (o, m) => app.log.info(o, m)),
    storage: new LocalStorage(config.STORAGE_DIR, config.PUBLIC_API_URL),
    tokens: parseKeyring(config.TRACKING_TOKEN_KEYS),
    payments: new PaymentProviderRegistry(config),
    verifier: opts.overrides?.verifier ?? {},
    geo: openGeoDb(config.GEOIP_DB_PATH, (m) => app.log.warn(m)),
    log: app.log,
  };
  app.decorate('ctx', ctx);
  app.decorate('reportError', (err: unknown, req?: FastifyRequest) => {
    // Error-reporting hook: forwards a minimal, credential-free summary to a configured webhook (e.g. an incident channel or Sentry relay).
    if (!config.ERROR_REPORT_WEBHOOK_URL) return;
    const body = JSON.stringify({ message: (err as Error)?.message, name: (err as Error)?.name, requestId: req?.id, route: req?.routeOptions?.url, at: new Date().toISOString() });
    void fetch(config.ERROR_REPORT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => undefined);
  });

  // zod schemas drive both request validation and the generated OpenAPI document.
  app.setValidatorCompiler(({ schema }) => (data) => {
    if (!(schema instanceof ZodType)) return { value: data };
    const r = schema.safeParse(data);
    return r.success ? { value: r.data } : { error: r.error as unknown as Error };
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id } }));

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false, // API responses are JSON; the dashboard sets its own CSP at the reverse proxy.
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // ad tag, creatives and pixels are embedded on publisher sites
  });
  const publicPrefixes = ['/api/v1/serve', '/api/v1/events', '/api/v1/click', '/api/v1/public', '/sdk/', '/assets/', '/health', '/ready'];
  await app.register(cors, {
    delegator: (req, cb) => {
      const url = req.url ?? '';
      if (publicPrefixes.some((p) => url.startsWith(p))) return cb(null, { origin: '*', credentials: false, methods: ['GET', 'POST'] });
      cb(null, { origin: config.corsOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id', 'authorization', 'idempotency-key'] });
    },
  });
  await app.register(multipart, { limits: { fileSize: 5_000_000, files: 1, fields: 10 } });
  // Accept sendBeacon payloads (text/plain) for event ingestion.
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 256_000 }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'bad_request', 'Body must be JSON'), undefined);
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: `${DEFAULT_BRAND.productName} API`, version: '1.0.0', description: 'Versioned REST API. Management endpoints use session cookies (with CSRF header) or organization API keys; public ad-serving endpoints are unauthenticated and keyed by public site keys.' },
      servers: [{ url: config.PUBLIC_API_URL }],
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'bn_session' }, apiKey: { type: 'http', scheme: 'bearer' } } },
    },
    transform: ({ schema, url }) => {
      if (!schema) return { schema, url };
      const out: Record<string, unknown> = { ...schema };
      for (const k of ['body', 'querystring', 'params', 'headers'] as const) {
        const s = (schema as Record<string, unknown>)[k];
        if (s instanceof ZodType) {
          try {
            out[k] = z.toJSONSchema(s, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' });
          } catch {
            out[k] = { type: 'object' };
          }
        }
      }
      return { schema: out as typeof schema, url };
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(authPlugin);

  // Rate limiting (Redis fixed windows) and maintenance mode.
  app.addHook('preHandler', async (req, reply) => {
    const cfg = req.routeOptions.config;
    const settings = await ctx.settings.get();
    if (cfg?.rateLimit) {
      const { bucket } = cfg.rateLimit;
      const limit = cfg.rateLimit.limit ?? (bucket === 'auth' ? settings.api.authRateLimitPerMinute : bucket === 'serve' || bucket === 'events' ? settings.api.serveRateLimitPerMinutePerIp : settings.api.managementRateLimitPerMinute);
      const who = bucket === 'management' && req.auth?.user ? `u:${req.auth.user.id}` : req.auth?.apiKey ? `k:${req.auth.apiKey.id}` : `ip:${req.ipHash}`;
      const r = await hit(ctx.redis, `${bucket}:${who}`, limit, cfg.rateLimit.windowSec ?? 60);
      reply.header('x-ratelimit-limit', limit).header('x-ratelimit-remaining', r.remaining);
      if (!r.allowed) {
        if (r.count === limit + 1) {
          void ctx.db.query(`INSERT INTO security_events (type, severity, subject, detail, ip_hash) VALUES ('rate_limited', 'warning', $1, $2, $3)`, [bucket, JSON.stringify({ route: req.routeOptions.url, who: who.slice(0, 2) }), req.ipHash]).catch(() => undefined);
        }
        reply.header('retry-after', r.retryAfterSec);
        throw new AppError(429, 'rate_limited', 'Too many requests. Please slow down.');
      }
    }
    if (settings.platform.maintenanceMode && !cfg?.allowDuringMaintenance && req.method !== 'GET' && !req.auth?.user?.platformRole) {
      throw new AppError(503, 'maintenance', settings.platform.maintenanceMessage || 'The platform is in maintenance mode. Please try again shortly.');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    return payload;
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, string> = {};
    try { await db.query('SELECT 1'); checks.database = 'ok'; } catch { checks.database = 'error'; }
    try { checks.redis = (await redis.ping()) === 'PONG' ? 'ok' : 'error'; } catch { checks.redis = 'error'; }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });

  await registerRoutes(app);

  app.addHook('onClose', async () => {
    await queues.close().catch(() => undefined);
    if (!opts.overrides?.redis) await redis.quit().catch(() => undefined);
    if (!opts.overrides?.db) await db.end().catch(() => undefined);
  });
  return app;
}
