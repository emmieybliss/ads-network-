import type { PoolClient } from 'pg';
import { withTransaction } from '@blissnova/database';
import type { AppContext } from './context';

export function tx<T>(ctx: Pick<AppContext, 'db'>, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(ctx.db, fn);
}
