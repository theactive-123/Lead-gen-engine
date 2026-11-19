import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from './db.js';
import { logger } from './logger.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Applies every *.sql file in packages/shared/migrations once, in name order.
 * Safe to run on every start: applied files are recorded in schema_migrations.
 * An advisory lock stops two workers from migrating at the same time.
 */
export async function migrate(): Promise<string[]> {
  const client = await db().connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(err as Error).message}`);
      }
      applied.push(f);
      logger.info({ migration: f }, 'migration applied');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
