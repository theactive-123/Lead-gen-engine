import pg from 'pg';
import { env } from './env.js';

let pool: pg.Pool | undefined;

/** Shared connection pool to the lead database (PostgreSQL). */
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 10 });
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
