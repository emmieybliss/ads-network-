import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const QUEUE_NAMES = { events: 'bn-events', serveLog: 'bn-serve-log', email: 'bn-email', maintenance: 'bn-maintenance' } as const;

export interface Queues {
  events: Queue | null;
  serveLog: Queue | null;
  email: Queue | null;
  maintenance: Queue | null;
  close(): Promise<void>;
}

const JOB_DEFAULTS = { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 } as const;

export function createQueues(connection: Redis, enabled: boolean): Queues {
  if (!enabled) return { events: null, serveLog: null, email: null, maintenance: null, close: async () => undefined };
  const mk = (name: string) => new Queue(name, { connection, defaultJobOptions: JOB_DEFAULTS });
  const q = { events: mk(QUEUE_NAMES.events), serveLog: mk(QUEUE_NAMES.serveLog), email: mk(QUEUE_NAMES.email), maintenance: mk(QUEUE_NAMES.maintenance) };
  return { ...q, close: async () => { await Promise.all(Object.values(q).map((x) => x.close())); } };
}
