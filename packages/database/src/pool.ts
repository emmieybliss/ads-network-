import pg from 'pg';

// Return BIGINT/NUMERIC as strings (never JS floats). Callers convert to bigint where arithmetic is needed.
pg.types.setTypeParser(20, (v) => v); // int8
pg.types.setTypeParser(1700, (v) => v); // numeric
// DATE as plain 'YYYY-MM-DD' strings to avoid time zone shifts.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, max = 20): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, statement_timeout: 30_000 } as pg.PoolConfig);
  pool.on('error', (err) => {
    // Idle client errors (e.g. server restart) must not crash the process.
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: err.message }));
  });
  return pool;
}

/** Run fn inside a transaction. Rolls back on any thrown error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>, isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED'): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
