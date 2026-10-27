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
  log: FastifyBaseLogger;
}
