import { db } from './db.js';

/**
 * Checkpoints remember "where a source or stage got to" (e.g. the last CT log index,
 * the list of finished Common Crawl files). Restarting the worker resumes from here.
 */
export async function getCheckpoint<T>(key: string): Promise<T | undefined> {
  const r = await db().query<{ value: T }>('SELECT value FROM checkpoints WHERE key = $1', [key]);
  return r.rows[0]?.value;
}

export async function setCheckpoint(key: string, value: unknown): Promise<void> {
  await db().query(
    `INSERT INTO checkpoints(key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
