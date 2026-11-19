import { unzipSync } from 'fflate';
import { fetchBuffer, fetchText, withRetry } from './http.js';
import { registrableDomain } from './normalize.js';
import type { Candidate, Source, SourceBatch } from './types.js';

/**
 * Tranco top-1M ranking (https://tranco-list.eu). Free download, no key.
 * Used as a source and later as a size signal (rank). Only re-downloaded when the list ID changes.
 */
type Cursor = { listId: string };
const BATCH = 100_000;

export const tranco: Source<Cursor> = {
  key: 'tranco',
  label: 'Tranco top 1M list',

  async *run(cursor) {
    const listId = (await withRetry(() => fetchText('https://tranco-list.eu/top-1m-id'))).trim();
    if (!/^[A-Z0-9]{4,8}$/.test(listId)) throw new Error(`unexpected Tranco list id: ${listId}`);
    if (cursor?.listId === listId) return; // already have this list

    const zip = await withRetry(() => fetchBuffer('https://tranco-list.eu/top-1m.csv.zip'));
    const files = unzipSync(new Uint8Array(zip));
    const csv = Buffer.from(Object.values(files)[0]!).toString('utf8');
    const lines = csv.split('\n');

    for (let start = 0, part = 0; start < lines.length; start += BATCH, part++) {
      const candidates: Candidate[] = [];
      const dropped: Record<string, number> = {};
      let raw = 0;
      for (const line of lines.slice(start, start + BATCH)) {
        if (!line) continue;
        raw++;
        const [rank, host] = line.trim().split(',');
        const r = registrableDomain(host ?? '');
        if ('drop' in r) dropped[r.drop] = (dropped[r.drop] ?? 0) + 1;
        else candidates.push({ domain: r.domain, hint: { rank: Number(rank), list: listId } });
      }
      const last = start + BATCH >= lines.length;
      const batch: SourceBatch<Cursor> = {
        partKey: `${listId}-${part}`,
        candidates,
        rawCount: raw,
        dropped,
        // Only advance the cursor after the final batch: a crash mid-list re-runs it (same file names).
        cursor: last ? { listId } : (cursor ?? { listId: '' }),
      };
      yield batch;
    }
  },

  async health() {
    const id = (await fetchText('https://tranco-list.eu/top-1m-id')).trim();
    return { ok: /^[A-Z0-9]{4,8}$/.test(id), detail: `current list ${id}` };
  },
};
