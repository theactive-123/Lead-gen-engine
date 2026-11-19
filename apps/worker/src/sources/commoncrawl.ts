import { gunzipSync } from 'node:zlib';
import { db, duck, logger } from '@lead/shared';
import { fetchBuffer, fetchText, withRetry } from './http.js';
import type { Source, SourceBatch } from './types.js';

/**
 * Common Crawl columnar URL index (Parquet, one crawl ≈ 300 files ≈ 2B URLs).
 * Per file we group pages by registered domain and count URL-path signal matches
 * (patterns from the source_url_signals table). Domains with ≥1 signal become candidates.
 * Only the needed columns are fetched over HTTPS, so each file costs a few seconds.
 */
type Cursor = { crawl: string; done: number[] };
const BASE = 'https://data.commoncrawl.org';

export async function latestCrawl(): Promise<string> {
  const html = await withRetry(() => fetchText(`${BASE}/crawl-data/index.html`));
  const ids = [...html.matchAll(/CC-MAIN-(\d{4})-(\d{2})/g)].map((m) => m[0]);
  if (!ids.length) throw new Error('no crawl ids found on crawl-data/index.html');
  return ids.sort().at(-1)!;
}

export async function indexFiles(crawl: string): Promise<string[]> {
  const gz = await withRetry(() => fetchBuffer(`${BASE}/crawl-data/${crawl}/cc-index-table.paths.gz`));
  return gunzipSync(gz).toString('utf8').split('\n').filter((p) => p.includes('/subset=warc/'));
}

async function loadSignals(): Promise<Map<string, string>> {
  const rows = (await db().query<{ category: string; pattern: string }>(
    'SELECT category, pattern FROM source_url_signals WHERE enabled ORDER BY id',
  )).rows;
  const byCat = new Map<string, string[]>();
  for (const r of rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), `(${r.pattern})`]);
  return new Map([...byCat].map(([c, ps]) => [c, ps.join('|')]));
}

const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string) => `"${s.replaceAll('"', '')}"`;

async function scanFile(url: string, signals: Map<string, string>) {
  const cats = [...signals.keys()];
  const counts = cats.map((c) => `count_if(regexp_matches(url_path, ${sqlStr(signals.get(c)!)})) AS ${ident(c)}`).join(',\n    ');
  const sql = `
    SELECT url_host_registered_domain AS domain,
      count(*) AS pages,
      ${counts},
      mode(split_part(content_languages, ',', 1)) AS lang
    FROM read_parquet(${sqlStr(url)})
    WHERE fetch_status = 200
      AND url_host_registered_domain IS NOT NULL
      -- skip hosts under private suffixes (e.g. store.myshopify.com, x.github.io)
      AND coalesce(url_host_private_suffix, url_host_registry_suffix) = url_host_registry_suffix
    GROUP BY 1`;
  const con = await duck();
  try {
    const rows = (await con.runAndReadAll(sql)).getRowObjectsJS() as Record<string, any>[];
    return rows;
  } finally {
    con.closeSync();
  }
}

export const commoncrawl: Source<Cursor> = {
  key: 'commoncrawl',
  label: 'Common Crawl URL index',

  async *run(cursor, { options }) {
    const crawl: string = options.crawl ?? (await latestCrawl());
    const done = new Set(cursor?.crawl === crawl ? cursor.done : []);
    const files = await indexFiles(crawl);
    const signals = await loadSignals();
    const cats = [...signals.keys()];
    const parallel: number = options.parallel_files ?? 4;
    const maxFiles: number = options.max_files_per_run ?? files.length;
    const todo = files.map((f, i) => ({ f, i })).filter(({ i }) => !done.has(i)).slice(0, maxFiles);
    logger.info({ crawl, files: files.length, done: done.size, todo: todo.length, categories: cats }, 'common crawl scan');

    // Scan `parallel` files at a time; yield results in completion order.
    const queue = [...todo];
    const inflight = new Map<number, Promise<{ i: number; rows: Record<string, any>[] }>>();
    const startNext = () => {
      const job = queue.shift();
      if (!job) return;
      const url = `${BASE}/${job.f}`;
      inflight.set(job.i, withRetry(() => scanFile(url, signals), 3, 5000).then((rows) => ({ i: job.i, rows })));
    };
    for (let k = 0; k < parallel; k++) startNext();

    while (inflight.size) {
      const { i, rows } = await Promise.race(inflight.values());
      inflight.delete(i);
      startNext();
      const keep = rows.filter((r) => cats.some((c) => Number(r[c]) > 0));
      done.add(i);
      const batch: SourceBatch<Cursor> = {
        partKey: `${crawl}-${String(i).padStart(5, '0')}`,
        rawCount: rows.length,
        dropped: { no_signal: rows.length - keep.length },
        candidates: keep.map((r) => ({
          domain: String(r.domain).toLowerCase(),
          hint: { crawl, pages: Number(r.pages), lang: r.lang ?? null, ...Object.fromEntries(cats.map((c) => [c, Number(r[c])])) },
        })),
        cursor: { crawl, done: [...done].sort((a, b) => a - b) },
      };
      yield batch;
    }
  },

  async health() {
    const crawl = await latestCrawl();
    const files = await indexFiles(crawl);
    return { ok: files.length > 0, detail: `${crawl}: ${files.length} index files` };
  },
};
