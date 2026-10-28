import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createPool } from '@blissnova/database';
import { loadConfig } from '@blissnova/api/config';
import { SettingsService } from '@blissnova/api/lib/settings';
import { createMailer } from '@blissnova/api/lib/mailer';
import { QUEUE_NAMES } from '@blissnova/api/lib/queue';
import { processAdmittedEvent, RetryLaterError, type AdmittedEvent } from '@blissnova/api/services/events';
import { writeServeLog, type ServeLog } from '@blissnova/api/services/serving';
import { deliverOutbox, queueEmail } from '@blissnova/api/services/notifications';
import { EMAIL_TEMPLATES } from '@blissnova/api/lib/mailer';
import { PaymentProviderRegistry, paypalClientFor } from '@blissnova/api/services/payments/registry';
import { PayoutProviderRegistry } from '@blissnova/api/services/payouts/registry';
import { budgetAlerts, campaignLifecycle, dailyMaintenance, detectAnomalies, lowBalanceAlerts, refreshAggregates, settleAll, syncProviders, syncSpendCounters, type JobCtx } from './jobs';

/**
 * Background worker: event processing, serve logs, email delivery and
 * scheduled maintenance. Jobs are idempotent and retried with exponential
 * backoff; jobs that exhaust their attempts stay in the failed set
 * (dead-letter) for inspection from the admin System page.
 */
const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const db = createPool(config.DATABASE_URL, 10);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const settings = new SettingsService(db);
const mailer = createMailer(config, (o, m) => log.info(o, m));

const notify: JobCtx['notify'] = async (orgId, n) => {
  const members = (await db.query<{ user_id: string; email: string; name: string }>(
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.status = 'active' AND ($2::text[] IS NULL OR m.role = ANY($2))`, [orgId, n.roles ?? null])).rows;
  for (const m of members) {
    await db.query('INSERT INTO notifications (user_id, org_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)', [m.user_id, orgId, n.type, n.title, n.body ?? '', n.link ?? null]);
    if (n.template && EMAIL_TEMPLATES[n.template]) {
      await queueEmail({ config, db, redis: connection, settings, mailer, queues: { email: emailQueue } } as never, m.email, n.template, { name: m.name, ...n.vars, link: n.link ? `${config.PUBLIC_SITE_URL}${n.link}` : undefined });
    }
  }
};

const emailQueue = new Queue(QUEUE_NAMES.email, { connection });
const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, { connection });
const paypal = paypalClientFor(config);
// The subset of the API context that provider sync jobs use.
const app = { config, db, redis: connection, settings, mailer, queues: { email: emailQueue }, payments: new PaymentProviderRegistry(config, paypal), payouts: new PayoutProviderRegistry(config, paypal), log } as never;
const jobCtx: JobCtx = { db, redis: connection, settings: () => settings.get(), log, notify, app };

const workers = [
  new Worker(QUEUE_NAMES.events, async (job: Job<AdmittedEvent>) => {
    try {
      return await processAdmittedEvent({ db, redis: connection }, job.data, await settings.get(), { inline: false });
    } catch (err) {
      // A click or viewable event that arrives before its render has been persisted is retried; after the final attempt it is classified as a sequence violation.
      if (err instanceof RetryLaterError && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        return processAdmittedEvent({ db, redis: connection }, { ...job.data, flags: { ...job.data.flags, noRenderReceipt: true } }, await settings.get(), { inline: true });
      }
      throw err;
    }
  }, { connection, concurrency: 16 }),
  new Worker(QUEUE_NAMES.serveLog, async (job: Job<ServeLog>) => writeServeLog(db, job.data), { connection, concurrency: 8 }),
  new Worker(QUEUE_NAMES.email, async (job: Job<{ id: string }>) => deliverOutbox({ db, mailer, settings }, job.data.id), { connection, concurrency: 4 }),
  new Worker(QUEUE_NAMES.maintenance, async (job: Job) => {
    await connection.set('worker:heartbeat', String(Date.now()), 'EX', 600);
    switch (job.name) {
      case 'minutely': {
        await refreshAggregates(jobCtx);
        const lifecycle = await campaignLifecycle(jobCtx);
        const settled = await settleAll(jobCtx);
        await syncSpendCounters(jobCtx);
        return { lifecycle, settled };
      }
      case 'five-minutely':
        await budgetAlerts(jobCtx);
        await lowBalanceAlerts(jobCtx);
        return { anomalies: await detectAnomalies(jobCtx), providers: await syncProviders(jobCtx) };
      case 'daily':
        return dailyMaintenance(jobCtx);
      default:
        return null;
    }
  }, { connection, concurrency: 1 }),
];

for (const w of workers) {
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  w.on('error', (err) => log.error({ queue: w.name, err: err.message }, 'worker error'));
}

await maintenanceQueue.upsertJobScheduler('minutely', { every: 60_000 }, { name: 'minutely', opts: { removeOnComplete: 100, removeOnFail: 500 } });
await maintenanceQueue.upsertJobScheduler('five-minutely', { every: 300_000 }, { name: 'five-minutely', opts: { removeOnComplete: 100, removeOnFail: 500 } });
await maintenanceQueue.upsertJobScheduler('daily', { pattern: '15 0 * * *', tz: 'UTC' }, { name: 'daily', opts: { removeOnComplete: 30, removeOnFail: 100 } });
await connection.set('worker:heartbeat', String(Date.now()), 'EX', 600);
log.info('worker started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'worker shutting down; finishing active jobs');
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([emailQueue.close(), maintenanceQueue.close()]);
  await connection.quit();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
