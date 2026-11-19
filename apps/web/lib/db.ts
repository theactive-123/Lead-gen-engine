import pg from 'pg';

// One pool per server process. The dashboard only reads/writes the lead database.
const g = globalThis as unknown as { __leadPool?: pg.Pool };
export const pool = (g.__leadPool ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead',
  max: 5,
}));

export async function q<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}
