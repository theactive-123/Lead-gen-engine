import pg from 'pg';

// One pool per server process. The dashboard only reads/writes the lead database (never the data lake).
const g = globalThis as unknown as { __leadPool?: pg.Pool };
export const pool = (g.__leadPool ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead',
  max: 5,
}));

export async function q<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

export async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await pool.query<T>(sql, params)).rows[0];
}

/** Run several statements as one unit: all succeed or none do. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
