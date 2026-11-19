import { fetchJson } from '../http.js';

/** One CT log we can read: classic RFC 6962 (`get-entries`) or static/tiled (c2sp static-ct-api). */
export interface CtLog {
  id: string;          // stable key for checkpoints (log_id from the log list)
  name: string;        // operator + description
  kind: 'rfc6962' | 'tiled';
  url: string;         // RFC 6962 base URL, or the tiled monitoring prefix
  startInclusive?: string;
  endExclusive?: string;
}

interface LogListJson {
  operators: {
    name: string;
    logs?: { description: string; log_id: string; url: string; state?: Record<string, unknown>; temporal_interval?: { start_inclusive: string; end_exclusive: string } }[];
    tiled_logs?: { description: string; log_id: string; monitoring_url: string; state?: Record<string, unknown>; temporal_interval?: { start_inclusive: string; end_exclusive: string } }[];
  }[];
}

export const LOG_LIST_URL = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';

/**
 * Logs that are "usable" in Chrome's list and still accepting certificates (shard end in the future).
 * `filters`: substrings matched against the URL; empty = all.
 */
export async function usableLogs(filters: string[] = []): Promise<CtLog[]> {
  const list = await fetchJson<LogListJson>(LOG_LIST_URL);
  const now = Date.now();
  const out: CtLog[] = [];
  const live = (l: { state?: Record<string, unknown>; temporal_interval?: { end_exclusive: string } }) =>
    !!l.state && 'usable' in l.state && (!l.temporal_interval || Date.parse(l.temporal_interval.end_exclusive) > now);
  for (const op of list.operators) {
    for (const l of op.logs ?? []) {
      if (live(l)) out.push({ id: l.log_id, name: `${op.name} ${l.description}`, kind: 'rfc6962', url: l.url.replace(/\/$/, ''), startInclusive: l.temporal_interval?.start_inclusive, endExclusive: l.temporal_interval?.end_exclusive });
    }
    for (const l of op.tiled_logs ?? []) {
      if (live(l)) out.push({ id: l.log_id, name: `${op.name} ${l.description}`, kind: 'tiled', url: l.monitoring_url.replace(/\/$/, ''), startInclusive: l.temporal_interval?.start_inclusive, endExclusive: l.temporal_interval?.end_exclusive });
    }
  }
  return filters.length ? out.filter((l) => filters.some((f) => l.url.includes(f))) : out;
}

/**
 * Logs are sharded by certificate EXPIRY date. Certificates issued today expire ~45-90 days from now,
 * so almost all new entries land in the shard covering "today + N days" (measured 2026-11-19:
 * the 2027h1 shards held ~97% of entries; 2026h2 and 2027h2 shards were nearly empty).
 */
export function activeShards(logs: CtLog[], daysAhead = 60): CtLog[] {
  const t = Date.now() + daysAhead * 86_400_000;
  return logs.filter((l) => (!l.startInclusive || Date.parse(l.startInclusive) <= t) && (!l.endExclusive || Date.parse(l.endExclusive) > t));
}
