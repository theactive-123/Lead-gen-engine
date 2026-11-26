import pg from 'pg';
import { env } from './env.js';

let pool: pg.Pool | undefined;

/** Shared connection pool to the lead database (PostgreSQL). */
export function db(): pg.Pool {
  // 15 per worker process: stages, scoring and the heavy-job lock run at the same time (3 workers + dashboard stay below Postgres' 100).
  pool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 15 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Run a function inside a transaction; rolls back on any error. */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A checked-out client for transactions. */
export type DbClient = pg.PoolClient;

/**
 * Run `fn` while holding a cluster-wide lock (Postgres advisory lock): only one worker process at a time.
 * Used for the heavy data-lake jobs (registry rebuild, funnel count, compaction, forgetting domains), which share
 * DuckDB's memory and spill budget and rewrite files the others read. Waits at most `waitMs` for the lock.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>, waitMs = 20 * 60_000): Promise<T> {
  const client = await db().connect();
  try {
    await client.query(`SET lock_timeout = ${Math.max(1000, Math.round(waitMs))}`);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]).catch(() => {});
    }
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
    client.release();
  }
}
