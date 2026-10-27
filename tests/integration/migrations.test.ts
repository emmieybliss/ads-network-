/**
 * Every migration must be reversible. A deploy that cannot be rolled back is a
 * deploy that cannot be undone at three in the morning.
 *
 * This runs against a scratch database of its own so it never disturbs the one
 * the other tests use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, loadMigrations, migrateDown, migrateUp } from '@blissnova/database';
import type { Pool } from 'pg';
import { testDatabaseUrl } from '../helpers/env';

const SCRATCH = 'blissnova_migration_test';
let admin: Pool;
let pool: Pool;

function urlFor(db: string) {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${db}`;
  return u.toString();
}

beforeAll(async () => {
  admin = createPool(urlFor('postgres'));
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  pool = createPool(urlFor(SCRATCH));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.end();
});

const tables = async () =>
  (await pool.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map((r) => r.t);

describe('migrations', () => {
  it('has a down file for every up file', async () => {
    const list = await loadMigrations();
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      expect(m.down, `${m.id} has no down migration`).toBeTruthy();
      expect(String(m.down).trim().length, `${m.id} down migration is empty`).toBeGreaterThan(0);
    }
  });

  it('numbers migrations uniquely and in order', async () => {
    const list = await loadMigrations();
    const ids = list.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('applies cleanly to an empty database', async () => {
    const applied = await migrateUp(pool);
    expect(applied.length).toBeGreaterThan(0);
    const t = await tables();
    for (const expected of ['users', 'organizations', 'campaigns', 'ad_events', 'ledger_entries', 'settlements', 'payouts']) {
      expect(t, expected).toContain(expected);
    }
  }, 120_000);

  it('is idempotent: applying again changes nothing', async () => {
    const again = await migrateUp(pool);
    expect(again).toEqual([]);
  });

  it('rolls all the way back and forward again', async () => {
    const before = await tables();
    const count = (await loadMigrations()).length;

    await migrateDown(pool, count);
    const after = await tables();
    // Only the migration bookkeeping table survives a full rollback.
    expect(after.filter((t) => t !== 'schema_migrations')).toEqual([]);

    await migrateUp(pool);
    expect(await tables()).toEqual(before);
  }, 180_000);

  it('records what it applied, so a deployment can be audited', async () => {
    const rows = await pool.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    const list = await loadMigrations();
    expect(rows.rows.map((r) => r.id)).toEqual(list.map((m) => m.id));
  });

  it('keeps the money columns as exact integers, never floating point', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND (column_name LIKE '%_micros' OR column_name LIKE '%micros')`,
    );
    expect(cols.rowCount).toBeGreaterThan(10);
    for (const c of cols.rows) {
      expect(['bigint', 'numeric'], `${c.table_name}.${c.column_name} is ${c.data_type}`).toContain(c.data_type);
    }
  });

  it('protects the audit log and ledger from being rewritten', async () => {
    const triggers = await pool.query<{ event_object_table: string }>(
      `SELECT DISTINCT event_object_table FROM information_schema.triggers WHERE trigger_schema = 'public'`,
    );
    const guarded = triggers.rows.map((r) => r.event_object_table);
    for (const t of ['audit_logs', 'ledger_entries']) {
      expect(guarded, `${t} has no immutability trigger`).toContain(t);
    }
  });
});
