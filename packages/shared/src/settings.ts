import { db } from './db.js';

/**
 * Editable settings live in the `settings` table (dashboard Settings page).
 * Cached for 60 s so jobs pick up changes without hammering the database.
 */
let cache: { at: number; values: Map<string, unknown> } | undefined;

export async function settings(): Promise<Map<string, unknown>> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const rows = (await db().query<{ key: string; value: unknown }>('SELECT key, value FROM settings')).rows;
    cache = { at: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])) };
  }
  return cache.values;
}

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const v = (await settings()).get(key);
  return v === undefined || v === null ? fallback : (v as T);
}
