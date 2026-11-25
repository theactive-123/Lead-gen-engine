import { existsSync, readFileSync } from 'node:fs';
import { glob, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { datasetGlob, lakeDir, lakeQuery, lakeRun, setting, sqlLiteral, withRun } from '@lead/shared';

/**
 * Stage 1 — normalise & de-duplicate.
 * Maintains the domain registry (data/lake/registry/current/, see REGISTRY_FILE): one row per registrable domain with every
 * source that saw it, its earliest sighting, merged hints, a priority score and a drop reason for junk.
 * Built incrementally (see normalize()). Rules come from the `normalize.rules` setting and are
 * re-applied to every row on each run, so rule edits take effect everywhere.
 */
export interface NormalizeRules {
  base_priority: Record<string, number>;
  cc_signal_bonus: number;
  cc_english_bonus: number;
  preferred_tlds: string[];
  preferred_tld_bonus: number;
  blocked_tlds: string[];
  tranco_top_rank: number;
  tranco_top_penalty: number;
  junk_max_label_length: number;
  junk_max_digit_ratio: number;
  junk_max_hyphens: number;
}

const REGISTRY_DIR = () => lakeDir('registry', 'current');
const POINTER = () => path.join(REGISTRY_DIR(), 'CURRENT');
const KEEP_VERSIONS = 3;

/**
 * Path of the current registry. Every run writes a NEW file (registry-<time>.parquet) and then
 * switches the small CURRENT pointer to it; a file is never overwritten under the same name, so
 * a reader can never mix blocks of an old and a new registry. Older versions are kept for a few
 * runs so long queries that already started keep their file.
 */
export function REGISTRY_FILE(): string {
  try {
    return path.join(REGISTRY_DIR(), readFileSync(POINTER(), 'utf8').trim());
  } catch {
    return path.join(REGISTRY_DIR(), 'registry.parquet'); // before the first versioned run
  }
}

const list = (xs: string[]) => (xs.length ? `[${xs.map(sqlLiteral).join(', ')}]` : `[]::VARCHAR[]`);

/** Columns that are merged across runs; everything else is derived from them by the current rules. */
const BASE_COLS = 'domain, first_seen, sources, cc_ecommerce, cc_wellness, cc_agency, cc_pages, cc_lang, tranco_rank, registered, ct_first_cert';

/** Aggregate raw candidate rows (from `from`) to one base row per domain. */
export function aggregateSql(from: string): string {
  return `
    SELECT domain,
      min(seen_at) AS first_seen,
      list(DISTINCT source ORDER BY source) AS sources,
      max(json_extract(hint, '$.ecommerce')::INT) FILTER (WHERE source = 'commoncrawl') AS cc_ecommerce,
      max(json_extract(hint, '$.wellness')::INT)  FILTER (WHERE source = 'commoncrawl') AS cc_wellness,
      max(json_extract(hint, '$.agency')::INT)    FILTER (WHERE source = 'commoncrawl') AS cc_agency,
      max(json_extract(hint, '$.pages')::INT)     FILTER (WHERE source = 'commoncrawl') AS cc_pages,
      min(json_extract_string(hint, '$.lang')) FILTER (WHERE source = 'commoncrawl') AS cc_lang,
      min(json_extract(hint, '$.rank')::INT)      FILTER (WHERE source = 'tranco') AS tranco_rank,
      min(json_extract_string(hint, '$.registered')) FILTER (WHERE source = 'whoisds') AS registered,
      min(to_timestamp(json_extract(hint, '$.ts')::BIGINT / 1000)) FILTER (WHERE source = 'ct') AS ct_first_cert
    FROM (${from}) GROUP BY domain`;
}

/**
 * Merge base rows (same domain may appear several times) into one row per domain.
 * Every column is a min / max / set-union, so merging is order-independent and re-reading a file twice
 * changes nothing — that is what makes the incremental build give the same result as a full rebuild.
 */
export function mergeSql(from: string): string {
  return `
    SELECT domain,
      min(first_seen) AS first_seen,
      list_sort(list_distinct(flatten(list(sources)))) AS sources,
      max(cc_ecommerce) AS cc_ecommerce, max(cc_wellness) AS cc_wellness, max(cc_agency) AS cc_agency,
      max(cc_pages) AS cc_pages, min(cc_lang) AS cc_lang, min(tranco_rank) AS tranco_rank,
      min(registered) AS registered, min(ct_first_cert) AS ct_first_cert
    FROM (${from}) GROUP BY domain`;
}

/**
 * Merge new rows into the registry without regrouping all of it. Only domains that appear in `fresh`
 * can change, so those are merged with mergeSql; every other registry row is copied as it is.
 * Why: grouping the whole registry (10.8M domains with list columns) spilled more than DuckDB's 4 GB
 * temp cap and every normalize run failed. This needs a hash table of the new domains only.
 */
export function mergeIntoSql(base: string, fresh: string): string {
  return `
    WITH f AS (SELECT ${BASE_COLS} FROM (${fresh})), b AS (SELECT ${BASE_COLS} FROM (${base}))
    SELECT ${BASE_COLS} FROM b ANTI JOIN f USING (domain)
    UNION ALL BY NAME
    ${mergeSql(`SELECT ${BASE_COLS} FROM b SEMI JOIN f USING (domain) UNION ALL BY NAME SELECT ${BASE_COLS} FROM f`)}`;
}

/** Add tld, drop_reason and priority to base rows using the editable rules. */
export function deriveSql(base: string, r: NormalizeRules): string {
  // Best source wins (not the first listed): a Common Crawl shop that also gets a new certificate
  // must not fall to the CT score. Key order in the jsonb setting is not the order it was written in.
  const priorityBySource = ['0', ...Object.entries(r.base_priority)
    .map(([s, p]) => `CASE WHEN list_contains(sources, ${sqlLiteral(s)}) THEN ${Number(p)} ELSE 0 END`)].join(', ');
  return `
  WITH f AS (
    SELECT *,
      split_part(domain, '.', 1) AS label,
      regexp_extract(domain, '\\.([^.]+)$', 1) AS tld
    FROM (${base})
  )
  SELECT domain, first_seen, sources, cc_ecommerce, cc_wellness, cc_agency, cc_pages, cc_lang,
    tranco_rank, registered, ct_first_cert, tld,
    CASE
      WHEN list_contains(${list(r.blocked_tlds)}, tld) THEN 'blocked_tld'
      WHEN length(label) > ${Number(r.junk_max_label_length)} THEN 'junk_long_label'
      WHEN length(label) >= 6 AND length(regexp_replace(label, '[^0-9]', '', 'g')) / length(label) > ${Number(r.junk_max_digit_ratio)} THEN 'junk_digits'
      WHEN length(label) - length(replace(label, '-', '')) > ${Number(r.junk_max_hyphens)} THEN 'junk_hyphens'
      ELSE NULL
    END AS drop_reason,
    greatest(${priorityBySource})
      + CASE WHEN coalesce(cc_ecommerce, 0) + coalesce(cc_wellness, 0) + coalesce(cc_agency, 0) > 0 THEN ${Number(r.cc_signal_bonus)} ELSE 0 END
      + CASE WHEN cc_lang = 'eng' THEN ${Number(r.cc_english_bonus)} ELSE 0 END
      + CASE WHEN list_contains(${list(r.preferred_tlds)}, tld) THEN ${Number(r.preferred_tld_bonus)} ELSE 0 END
      + CASE WHEN tranco_rank IS NOT NULL AND tranco_rank <= ${Number(r.tranco_top_rank)} THEN ${Number(r.tranco_top_penalty)} ELSE 0 END
      AS priority
  FROM f`;
}

/** Full-rebuild SQL over every candidate file (used by tests and as the reference result). */
export function registrySql(r: NormalizeRules): string {
  return deriveSql(aggregateSql(`SELECT domain, source, seen_at, hint FROM read_parquet(${datasetGlob('candidates')})`), r);
}

const FILES_LIST = () => lakeDir('registry', 'current', 'files.json');

async function candidateFiles(): Promise<string[]> {
  const root = lakeDir('candidates');
  const out: string[] = [];
  for await (const f of glob(path.join(root, '*', '*.parquet'))) out.push(path.relative(root, f));
  return out.sort();
}

async function doneFiles(): Promise<Set<string> | null> {
  if (!existsSync(REGISTRY_FILE()) || !existsSync(FILES_LIST())) return null;
  return new Set(JSON.parse(await readFile(FILES_LIST(), 'utf8')) as string[]);
}

const readFiles = (files: string[]) =>
  `SELECT domain, source, seen_at, hint FROM read_parquet([${files.map((f) => sqlLiteral(lakeDir('candidates', f))).join(', ')}])`;

/**
 * Stage 1 run. Incremental: only candidate files not merged before are read (tracked in
 * registry/current/files.json), in chunks, and merged into the previous registry. The first run
 * (or a missing file list) starts from nothing and merges every file chunk by chunk.
 * Why: CT re-sees the same domains constantly (17M rows for 3.5M domains after 5 days), so a full
 * rebuild every 15 minutes grows without limit and overflowed DuckDB's temp-disk cap.
 */
export async function normalize(): Promise<Record<string, unknown>> {
  const rules = await setting<NormalizeRules | null>('normalize.rules', null);
  if (!rules) throw new Error('setting normalize.rules is missing');
  const chunk = Math.max(1, await setting<number>('normalize.chunk_files', 300));
  return withRun('stage.normalize', {}, async (run) => {
    const prev = REGISTRY_FILE();
    const dir = REGISTRY_DIR();
    await mkdir(dir, { recursive: true });
    await removeTemp(dir);
    const all = await candidateFiles();
    const done = await doneFiles();
    const todo = done ? all.filter((f) => !done.has(f)) : all;
    const stamp = Date.now();
    const temps: string[] = [];
    try {
      let base: string | null = done ? `SELECT ${BASE_COLS} FROM read_parquet(${sqlLiteral(prev)})` : null;
      for (let i = 0; i < todo.length; i += chunk) {
        // Two separate queries on purpose: aggregating the new files and merging into the base in one
        // query keeps two large hash tables alive at once and overflowed DuckDB's memory + temp cap.
        const fresh = path.join(dir, `fresh.${stamp}.${i}.tmp`);
        await lakeRun(`COPY (${aggregateSql(readFiles(todo.slice(i, i + chunk)))}) TO ${sqlLiteral(fresh)} (FORMAT parquet, COMPRESSION zstd)`);
        temps.push(fresh);
        const freshRows = `SELECT ${BASE_COLS} FROM read_parquet(${sqlLiteral(fresh)})`;
        if (!base) { base = freshRows; continue; }
        const merged = path.join(dir, `base.${stamp}.${i}.tmp`);
        await lakeRun(`COPY (${mergeIntoSql(base, freshRows)}) TO ${sqlLiteral(merged)} (FORMAT parquet, COMPRESSION zstd)`);
        temps.push(merged);
        base = `SELECT ${BASE_COLS} FROM read_parquet(${sqlLiteral(merged)})`;
      }
      if (!base) return { domains: 0, kept: 0, new_files: 0 };
      const name = `registry-${stamp}.parquet`;
      const tmp = path.join(dir, `${name}.tmp`);
      temps.push(tmp);
      await lakeRun(`COPY (${deriveSql(base, rules)} ORDER BY priority DESC, domain) TO ${sqlLiteral(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
      await rename(tmp, path.join(dir, name));
      // Switch the pointer atomically. If we crash before the file list is saved, those files are
      // merged again next run (harmless, see mergeSql).
      await writeFile(`${POINTER()}.tmp`, name);
      await rename(`${POINTER()}.tmp`, POINTER());
      const listTmp = `${FILES_LIST()}.${stamp}.tmp`;
      await writeFile(listTmp, JSON.stringify(done ? [...done, ...todo].sort() : all));
      await rename(listTmp, FILES_LIST());
    } finally {
      await Promise.all(temps.map((t) => rm(t, { force: true })));
    }
    await pruneVersions(dir);
    const out = REGISTRY_FILE();
    const [stats] = await lakeQuery<Record<string, bigint>>(`
      SELECT count(*) AS domains, count(*) FILTER (WHERE drop_reason IS NULL) AS kept FROM read_parquet(${sqlLiteral(out)})`);
    const drops = await lakeQuery<{ drop_reason: string; n: bigint }>(`
      SELECT drop_reason, count(*) AS n FROM read_parquet(${sqlLiteral(out)}) WHERE drop_reason IS NOT NULL GROUP BY 1`);
    run.inCount = Number(stats!.domains);
    run.outCount = Number(stats!.kept);
    for (const d of drops) run.drop(d.drop_reason, Number(d.n));
    return { domains: run.inCount, kept: run.outCount, new_files: todo.length, full_rebuild: !done };
  });
}

/** Remove temp files left by a crashed or failed earlier run. */
async function removeTemp(dir: string): Promise<void> {
  for (const f of await readdir(dir)) if (f.endsWith('.tmp')) await rm(path.join(dir, f), { force: true });
}

/** Keep the newest KEEP_VERSIONS registry files (and drop the pre-versioning registry.parquet). */
async function pruneVersions(dir: string): Promise<void> {
  const current = path.basename(REGISTRY_FILE());
  const versions = (await readdir(dir)).filter((f) => /^registry-\d+\.parquet$/.test(f)).sort().reverse();
  const old = [...versions.slice(KEEP_VERSIONS), 'registry.parquet'].filter((f) => f !== current);
  await Promise.all(old.map((f) => rm(path.join(dir, f), { force: true })));
}
