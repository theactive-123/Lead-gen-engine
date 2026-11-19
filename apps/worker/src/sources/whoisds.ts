import { unzipSync } from 'fflate';
import { fetchBuffer, fetchText, withRetry } from './http.js';
import { registrableDomain } from './normalize.js';
import type { Candidate, Source } from './types.js';

/**
 * WhoisDS free daily "newly registered domains" list (https://www.whoisds.com/newly-registered-domains).
 * Terms on that page: free of charge, reusable including commercially, no licence needed.
 * The site keeps only ~10 days of files, so we fetch every day and remember which days are done.
 */
type Cursor = { done: string[] };
const PAGE = 'https://www.whoisds.com/newly-registered-domains';
// The live page links with a double slash ("whoisds.com//whois-database/..."): accept one or more.
const LINK_RE = /https:\/\/www\.whoisds\.com\/+whois-database\/newly-registered-domains\/([A-Za-z0-9+/=]+)\/nrd/g;

/** Available days on the download page: [{ day: '2026-11-18', url }], oldest first. */
export async function listDays(): Promise<{ day: string; url: string }[]> {
  const html = await withRetry(() => fetchText(PAGE));
  const out = new Map<string, string>();
  for (const m of html.matchAll(LINK_RE)) {
    const name = Buffer.from(m[1]!, 'base64').toString('utf8'); // e.g. "2026-11-18.zip"
    const day = /^(\d{4}-\d{2}-\d{2})\.zip$/.exec(name)?.[1];
    if (day) out.set(day, m[0]);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, url]) => ({ day, url }));
}

export const whoisds: Source<Cursor> = {
  key: 'whoisds',
  label: 'WhoisDS newly registered domains',

  async *run(cursor) {
    const done = new Set(cursor?.done ?? []);
    for (const { day, url } of await listDays()) {
      if (done.has(day)) continue;
      const zip = await withRetry(() => fetchBuffer(url));
      const files = unzipSync(new Uint8Array(zip));
      const text = Buffer.from(Object.values(files)[0]!).toString('utf8');
      const candidates: Candidate[] = [];
      const dropped: Record<string, number> = {};
      let raw = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        raw++;
        const r = registrableDomain(line);
        if ('drop' in r) dropped[r.drop] = (dropped[r.drop] ?? 0) + 1;
        else candidates.push({ domain: r.domain, hint: { registered: day } });
      }
      done.add(day);
      yield { partKey: day, candidates, rawCount: raw, dropped, cursor: { done: [...done].sort().slice(-60) } };
    }
  },

  async health() {
    const days = await listDays();
    return { ok: days.length > 0, detail: days.length ? `${days.length} days available, newest ${days.at(-1)!.day}` : 'no files listed' };
  },
};
