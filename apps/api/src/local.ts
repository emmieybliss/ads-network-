/**
 * Local demo in one process, for a Windows or Mac machine with only Node
 * installed (no Docker, no database server, no Redis):
 *
 *   - PostgreSQL runs from the embedded-postgres npm package, with its data in
 *     LOCAL_DATA_DIR/pg;
 *   - Redis is replaced by an in-memory stand-in (ioredis-mock), which is
 *     enough for one process: rate limits, frequency caps and spend counters
 *     reset when the demo restarts;
 *   - the worker's scheduled jobs run on timers in this same process;
 *   - emails are written to LOCAL_DATA_DIR/emails as text files.
 *
 * It refuses to run with NODE_ENV=production. `node dist/local.js stop`
 * shuts down a Postgres left running by a closed window.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

if (process.env.NODE_ENV === 'production') {
  console.error('The local demo runner is for development only and does not run with NODE_ENV=production.');
  process.exit(1);
}

const dataDir = resolve(process.env.LOCAL_DATA_DIR ?? '.local-data');
const pgDir = join(dataDir, 'pg');
const pgPort = Number(process.env.LOCAL_PG_PORT ?? 54329);
mkdirSync(dataDir, { recursive: true });

// Secrets are generated on first run and kept in the data folder, which is gitignored.
const secretsFile = join(dataDir, 'secrets.json');
interface Secrets { appSecret: string; encryptionKey: string; trackingKey: string; pgPassword: string; seedPassword: string }
const secrets: Secrets = existsSync(secretsFile)
  ? JSON.parse(readFileSync(secretsFile, 'utf8'))
  : {
      appSecret: randomBytes(48).toString('base64url'),
      encryptionKey: randomBytes(32).toString('base64'),
      trackingKey: randomBytes(32).toString('base64'),
      pgPassword: randomBytes(18).toString('base64url'),
      seedPassword: `Demo-${randomBytes(9).toString('base64url')}`,
    };
if (!existsSync(secretsFile)) writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });

async function pgBinaries(): Promise<{ pg_ctl: string }> {
  const pkg = process.platform === 'win32' ? '@embedded-postgres/windows-x64'
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? '@embedded-postgres/darwin-arm64' : '@embedded-postgres/darwin-x64')
    : process.arch === 'arm64' ? '@embedded-postgres/linux-arm64' : '@embedded-postgres/linux-x64';
  // The platform package is a dependency of embedded-postgres, so resolve it from there.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const from = createRequire(import.meta.resolve('embedded-postgres')).resolve(pkg);
  return import(pathToFileURL(from).href);
}

if (process.argv[2] === 'stop') {
  // A closed console window can leave Postgres running; stop it cleanly.
  if (existsSync(join(pgDir, 'postmaster.pid'))) {
    const { pg_ctl } = await pgBinaries();
    try {
      execFileSync(pg_ctl, ['stop', '-D', pgDir, '-m', 'fast', '-w'], { stdio: 'inherit' });
    } catch {
      console.error('Postgres was not running, or could not be stopped.');
    }
  }
  process.exit(0);
}

const { default: EmbeddedPostgres } = await import('embedded-postgres');
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'blissnova', password: secrets.pgPassword, port: pgPort, persistent: true, onLog: () => undefined });
const firstRun = !existsSync(join(pgDir, 'PG_VERSION'));
if (firstRun) {
  console.log('First start: creating the local database (this takes a few seconds)...');
  await pg.initialise();
}
if (existsSync(join(pgDir, 'postmaster.pid'))) {
  // Left over from a window that was closed without stopping: stop it before starting again.
  const { pg_ctl } = await pgBinaries();
  try { execFileSync(pg_ctl, ['stop', '-D', pgDir, '-m', 'fast', '-w'], { stdio: 'ignore' }); } catch { /* not running */ }
}
await pg.start();
if (firstRun) await pg.createDatabase('blissnova');

const site = process.env.PUBLIC_SITE_URL ?? 'http://localhost:3000';
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: `postgres://blissnova:${encodeURIComponent(secrets.pgPassword)}@127.0.0.1:${pgPort}/blissnova`,
  REDIS_URL: 'redis://in-memory',
  PUBLIC_SITE_URL: site,
  PUBLIC_API_URL: process.env.PUBLIC_API_URL ?? 'http://localhost:4000',
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? site,
  COOKIE_SECURE: 'false',
  APP_SECRET: secrets.appSecret,
  ENCRYPTION_KEY: secrets.encryptionKey,
  TRACKING_TOKEN_KEYS: `k1:${secrets.trackingKey}`,
  STORAGE_DIR: join(dataDir, 'storage'),
  EMAIL_PROVIDER: 'file',
  EMAIL_FILE_DIR: join(dataDir, 'emails'),
  EVENT_PROCESSING: 'inline',
  ENABLE_DEV_PAYMENTS: 'true',
  ENABLE_DEV_VERIFICATION_SIMULATOR: 'true',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
});

// Imported only now, so they read the environment set above.
const { default: RedisMock } = await import('ioredis-mock');
const { buildApp } = await import('./app');
const { loadConfig } = await import('./config');
const { migrateUp } = await import('@blissnova/database');
const { queueEmail } = await import('./services/notifications');
const { EMAIL_TEMPLATES } = await import('./lib/mailer');
const jobs = await import('../../worker/src/jobs');

const config = loadConfig();
const redis = new RedisMock() as unknown as import('ioredis').Redis;
const app = await buildApp({ config, overrides: { redis } });
const applied = await migrateUp(app.ctx.db);
if (applied.length) console.log(`Applied ${applied.length} database migration(s).`);

const seededMarker = join(dataDir, 'seeded');
if (!existsSync(seededMarker)) {
  console.log('Loading demo data (fictional, labelled [demo])...');
  const seedScript = resolve(import.meta.dirname, 'scripts', 'seed.js');
  try {
    execFileSync(process.execPath, [seedScript], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, SEED_PASSWORD: secrets.seedPassword } });
  } catch {
    console.error('\nLoading the demo data failed (the error is above). Stopping. Delete the data folder to start over:', dataDir);
    await app.close().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    process.exit(1);
  }
  writeFileSync(seededMarker, new Date().toISOString());
}

// The worker's scheduled jobs, on timers instead of BullMQ.
const log = { info: (o: object, m?: string) => app.log.info(o, m), warn: (o: object, m?: string) => app.log.warn(o, m), error: (o: object, m?: string) => app.log.error(o, m) };
const jobCtx: import('../../worker/src/jobs').JobCtx = {
  db: app.ctx.db, redis, settings: () => app.ctx.settings.get(), log,
  notify: async (orgId, n) => {
    const members = (await app.ctx.db.query<{ user_id: string; email: string; name: string }>(
      `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.status = 'active' AND ($2::text[] IS NULL OR m.role = ANY($2))`, [orgId, n.roles ?? null])).rows;
    for (const m of members) {
      await app.ctx.db.query('INSERT INTO notifications (user_id, org_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)', [m.user_id, orgId, n.type, n.title, n.body ?? '', n.link ?? null]);
      if (n.template && EMAIL_TEMPLATES[n.template]) await queueEmail(app.ctx, m.email, n.template, { name: m.name, ...n.vars, link: n.link ? `${config.PUBLIC_SITE_URL}${n.link}` : undefined });
    }
  },
};
let busy = false;
async function run(name: string, fn: () => Promise<unknown>) {
  if (busy) return; // one job at a time, as the worker's maintenance queue does
  busy = true;
  try {
    await redis.set('worker:heartbeat', String(Date.now()), 'EX', 600);
    await fn();
  } catch (err) {
    log.error({ job: name, err: (err as Error).message }, 'scheduled job failed');
  } finally {
    busy = false;
  }
}
const minutely = () => run('minutely', async () => { await jobs.refreshAggregates(jobCtx); await jobs.campaignLifecycle(jobCtx); await jobs.settleAll(jobCtx); await jobs.syncSpendCounters(jobCtx); });
const fiveMinutely = () => run('five-minutely', async () => { await jobs.budgetAlerts(jobCtx); await jobs.lowBalanceAlerts(jobCtx); await jobs.detectAnomalies(jobCtx); });
const daily = () => run('daily', () => jobs.dailyMaintenance(jobCtx));
const timers = [setInterval(minutely, 60_000), setInterval(fiveMinutely, 300_000), setInterval(daily, 86_400_000)];
await minutely();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearInterval(t);
  await app.close().catch(() => undefined);
  await pg.stop().catch(() => undefined);
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown());

await app.listen({ host: '127.0.0.1', port: config.PORT });
console.log(`\nBlissNova API is running at ${config.PUBLIC_API_URL}`);
console.log(`Demo logins: admin@example.com, advertiser@example.com, publisher@example.com`);
console.log(`Password: ${secrets.seedPassword}   (also in ${secretsFile})`);
console.log(`Emails the demo sends are saved in ${join(dataDir, 'emails')}`);
console.log('Keep this window open while you use the demo. Close it, or press Ctrl+C, to stop.\n');
