import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { TokenKeyring } from '@blissnova/tracking';
import type { AppConfig } from '../config';
import type { SettingsService } from './settings';
import type { Mailer } from './mailer';
import type { Storage } from './storage';
import type { Queues } from './queue';
import type { PaymentProviderRegistry } from '../services/payments/registry';
import type { PartnerRegistry } from '../services/partners';
import type { CheckDeps } from '../services/verification';
import type { GeoLookup } from './geo';

export interface AppContext {
  config: AppConfig;
  db: Pool;
  redis: Redis;
  settings: SettingsService;
  mailer: Mailer;
  storage: Storage;
  queues: Queues;
  tokens: TokenKeyring;
  payments: PaymentProviderRegistry;
  partners: PartnerRegistry;
  /** DNS resolver and HTTP fetcher used by domain verification. Empty means the real ones; tests substitute fakes. */
  verifier: CheckDeps;
  /** Country lookup from GEOIP_DB_PATH, or null when none is configured. */
  geo: GeoLookup | null;
  log: FastifyBaseLogger;
}
