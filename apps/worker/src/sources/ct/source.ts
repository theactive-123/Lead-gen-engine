import { logger } from '@lead/shared';
import { fetchBuffer, fetchJson, fetchText, withRetry } from '../http.js';
import { registrableDomain } from '../normalize.js';
import type { Candidate, Source, SourceBatch } from '../types.js';
import { decodeDataTile, decodeRfc6962Entry, tilePath, type CtCert } from './leaves.js';
import { activeShards, usableLogs, type CtLog } from './logs.js';

/**
 * Certificate Transparency: every public HTTPS certificate is published in these logs within
 * minutes of issue, so tailing them reveals websites as they go live. We read the logs directly
 * (no crt.sh), keep only registrable domains, and remember the next index per log.
 */
type Cursor = Record<string, number>; // log id -> next entry index to read

const ENTRIES_PER_BATCH = 25_600; // 100 tiles; one Parquet part per batch
const TILE = 256;

async function treeSize(log: CtLog): Promise<number> {
  if (log.kind === 'tiled') {
    const cp = await withRetry(() => fetchText(`${log.url}/checkpoint`, { timeoutMs: 20_000 }));
    return Number(cp.split('\n')[1]);
  }
  const sth = await withRetry(() => fetchJson<{ tree_size: number }>(`${log.url}/ct/v1/get-sth`, { timeoutMs: 20_000 }));
  return sth.tree_size;
}

/** Read entries [start, end) from a tiled log. Only full tiles are read (partial tiles are skipped). */
async function readTiled(log: CtLog, start: number, end: number, parallel: number): Promise<CtCert[]> {
  const first = Math.floor(start / TILE);
  const last = Math.floor(end / TILE); // exclusive
  const tiles = Array.from({ length: last - first }, (_, i) => first + i);
  const results: CtCert[][] = new Array(tiles.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < tiles.length) {
        const i = next++;
        const buf = await withRetry(() => fetchBuffer(`${log.url}/tile/data/${tilePath(tiles[i]!)}`));
        results[i] = decodeDataTile(buf);
      }
    }),
  );
  return results.flat();
}

/** Read entries [start, end) from an RFC 6962 log with parallel get-entries calls. */
async function readRfc6962(log: CtLog, start: number, end: number, parallel: number): Promise<{ certs: CtCert[]; next: number }> {
  const out: CtCert[] = [];
  let pos = start;
  while (pos < end) {
    const before = pos;
    // Logs cap the page size (often 256 or 1024); ask for 256 per call, `parallel` calls at a time.
    const windows: [number, number][] = [];
    for (let s = pos; s < end && windows.length < parallel; s += 256) windows.push([s, Math.min(s + 255, end - 1)]);
    const pages = await Promise.all(
      windows.map(([s, e]) =>
        withRetry(() => fetchJson<{ entries: { leaf_input: string; extra_data: string }[] }>(`${log.url}/ct/v1/get-entries?start=${s}&end=${e}`)),
      ),
    );
    // Logs may return fewer entries than asked: continue from what we actually got, in order.
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!.entries;
      for (const e of page) {
        const c = decodeRfc6962Entry(e.leaf_input, e.extra_data);
        if (c) out.push(c);
      }
      pos = windows[i]![0] + page.length;
      if (page.length < windows[i]![1] - windows[i]![0] + 1) break; // short page: re-request from pos
    }
    if (pos === before) break; // log returned nothing: try again next run
  }
  return { certs: out, next: pos };
}

export const ct: Source<Cursor> = {
  key: 'ct',
  label: 'Certificate Transparency logs',

  /**
   * All selected logs are read IN PARALLEL (each log is a different server, so this is polite),
   * and their batches are merged into one stream. `committed` only advances a log's position
   * when that log's batch is handed out for storage, so a crash never skips unstored entries.
   */
  async *run(cursor, { options }) {
    const committed: Cursor = { ...(cursor ?? {}) };
    const all = await usableLogs(options.logs ?? []);
    const logs = options.active_shards_only === false ? all : activeShards(all, options.shard_days_ahead ?? 60);
    const maxPerLog: number = options.max_entries_per_log_per_run ?? 200_000;
    const startBack: number = options.start_back_entries ?? 50_000;
    const parallel: number = options.parallel_requests ?? 8;

    type Item = { batch: SourceBatch<Cursor>; logId: string; next: number } | { init: string; pos: number };
    const ready: Item[] = [];
    let wake: (() => void) | undefined;
    let running = logs.length;
    const push = async (item: Item) => {
      // Back-pressure: a log waits while too many batches are queued for storage.
      while (ready.length >= 2 * logs.length) await new Promise((r) => setTimeout(r, 50));
      ready.push(item);
      wake?.();
    };

    const readLog = async (log: CtLog) => {
      let pos = committed[log.id];
      try {
        const size = await treeSize(log);
        if (pos === undefined) {
          pos = Math.max(0, size - startBack);
          if (log.kind === 'tiled') pos = Math.floor(pos / TILE) * TILE; // tiled reads are whole tiles
          if (startBack === 0) {
            // "Tail from now": remember the current end of the log, read from there next run.
            await push({ init: log.id, pos });
            return;
          }
        }
        // Tiled logs: stop at the last full tile; the partial tail is read next run.
        const limit = Math.min(log.kind === 'tiled' ? Math.floor(size / TILE) * TILE : size, pos + maxPerLog);
        while (pos < limit) {
          const end = Math.min(pos + ENTRIES_PER_BATCH, limit);
          let certs: CtCert[];
          let next: number;
          if (log.kind === 'tiled') {
            certs = await readTiled(log, pos, end, parallel);
            next = end;
          } else {
            ({ certs, next } = await readRfc6962(log, pos, end, Math.min(parallel, 2)));
          }
          if (next === pos) break;

          const seen = new Map<string, Candidate>();
          const dropped: Record<string, number> = {};
          for (const c of certs) {
            for (const n of c.names) {
              const r = registrableDomain(n);
              if ('drop' in r) dropped[r.drop] = (dropped[r.drop] ?? 0) + 1;
              else if (!seen.has(r.domain)) seen.set(r.domain, { domain: r.domain, hint: { ts: c.timestamp, log: log.name } });
            }
          }
          await push({
            logId: log.id,
            next,
            batch: {
              partKey: `${log.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}-${pos}`,
              candidates: [...seen.values()],
              rawCount: certs.length,
              dropped,
              cursor: {}, // filled in when handed out (see below)
            },
          });
          pos = next;
        }
      } catch (err) {
        // One misbehaving log (rate limit, outage) must not stop the others.
        // Everything up to its last stored batch is kept; this log resumes next run.
        logger.warn({ log: log.name, pos, err: (err as Error).message }, 'CT log failed this run, continuing with other logs');
      }
    };

    const workers = logs.map((log) => readLog(log).finally(() => { running--; wake?.(); }));

    while (running > 0 || ready.length > 0) {
      const item = ready.shift();
      if (!item) {
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
        continue;
      }
      if ('init' in item) {
        committed[item.init] = item.pos;
        yield { partKey: `init-${item.init.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`, candidates: [], rawCount: 0, cursor: { ...committed } };
        continue;
      }
      committed[item.logId] = item.next;
      yield { ...item.batch, cursor: { ...committed } };
    }
    await Promise.all(workers);
  },

  async health() {
    const logs = await usableLogs();
    return { ok: logs.length > 0, detail: `${logs.length} usable logs (${logs.filter((l) => l.kind === 'tiled').length} tiled)` };
  },
};
