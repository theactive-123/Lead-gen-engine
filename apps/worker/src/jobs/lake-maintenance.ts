import { readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { datasetExists, datasetGlob, db, lakeDir, lakeQuery, lakeRun, logger, setting, sqlLiteral, today, withLock, withRun } from '@lead/shared';

/** Datasets that hold per-domain rows (queue snapshots expire by themselves; the registry keeps only the "suppressed" marker). */
export const DOMAIN_DATASETS = ['candidates', 'dns', 'pages', 'html', 'tech', 'store_probe', 'classified', 'contacts', 'signals', 'audits', 'lighthouse'];
/** Datasets merged by the daily compaction (HTML is large and expires after a few days; queue files are job inputs). */
export const COMPACT_DATASETS = ['candidates', 'dns', 'pages', 'tech', 'store_probe', 'classified', 'contacts', 'signals', 'audits', 'lighthouse'];

export const HEAVY_LOCK = 'lake-heavy';

const list = (xs: string[]) => `[${xs.map(sqlLiteral).join(', ')}]`;
// hive_partitioning = false: read one file exactly as it is (no extra "dt" column from the folder name).
const one = (f: string) => `read_parquet(${sqlLiteral(f)}, hive_partitioning = false)`;

/**
 * "Delete and suppress" in the dashboard: remove every row about those domains from the data lake as well.
 * Each affected file is rewritten without them (new file under a temporary name, then renamed over the old one).
 */
export async function forgetDomains(): Promise<Record<string, unknown>> {
  const domains = (await db().query<{ value: string }>(
    `SELECT value FROM suppression WHERE kind = 'domain' AND forget AND purged_at IS NULL ORDER BY id LIMIT 1000`)).rows.map((r) => r.value);
  if (!domains.length) return { domains: 0 };
  return withLock(HEAVY_LOCK, () => withRun('system.forget', { domains: domains.length }, async (run) => {
    let files = 0;
    let rows = 0;
    for (const ds of DOMAIN_DATASETS) {
      if (!(await datasetExists(ds))) continue;
      const hits = await lakeQuery<{ f: string; n: bigint }>(`
        SELECT filename AS f, count(*) AS n FROM read_parquet(${datasetGlob(ds)}, filename = true, union_by_name = true)
        WHERE domain IN (SELECT unnest(${list(domains)})) GROUP BY 1`);
      for (const h of hits) {
        const tmp = `${h.f}.forget.tmp`;
        await lakeRun(`COPY (SELECT * FROM ${one(h.f)} WHERE domain NOT IN (SELECT unnest(${list(domains)}))) TO ${sqlLiteral(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
        await rename(tmp, h.f);
        files++;
        rows += Number(h.n);
      }
    }
    await db().query(`UPDATE suppression SET purged_at = now() WHERE kind = 'domain' AND value = ANY($1::text[])`, [domains]);
    run.inCount = domains.length;
    run.outCount = rows;
    logger.info({ domains: domains.length, files, rows }, 'forgot domains in the data lake');
    return { domains: domains.length, files, rows };
  }));
}

/**
 * Daily: merge the many small files of each finished day (sources and stages write one file per batch) into one.
 * Fewer files keep every scan fast as the lake grows to millions of rows. Today's folder is never touched (still
 * being written). The merged file is written first, then the originals are removed; readers already take the
 * newest row per domain, so seeing both for a moment changes no result.
 */
export async function compactLake(): Promise<Record<string, unknown>> {
  const minFiles = Math.max(2, Number(await setting('lake.compact_min_files', 4)));
  return withLock(HEAVY_LOCK, () => withRun('system.compact', {}, async (run) => {
    const done: Record<string, { days: number; before: number }> = {};
    for (const ds of COMPACT_DATASETS) {
      const root = lakeDir(ds);
      for (const d of await readdir(root).catch(() => [] as string[])) {
        const day = /^dt=(\d{4}-\d{2}-\d{2})$/.exec(d)?.[1];
        if (!day || day >= today()) continue;
        const dir = path.join(root, d);
        const parts = (await readdir(dir)).filter((f) => f.endsWith('.parquet')).sort();
        if (parts.length < minFiles) continue;
        const full = parts.map((f) => path.join(dir, f));
        const merged = path.join(dir, `part-compacted-${Date.now()}.parquet`);
        const tmp = `${merged}.tmp`;
        await lakeRun(`COPY (SELECT * FROM read_parquet(${list(full)}, union_by_name = true, hive_partitioning = false))
          TO ${sqlLiteral(tmp)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)`);
        await rename(tmp, merged);
        if (ds === 'candidates') await markMergedCandidates(parts.map((f) => `${d}/${f}`), `${d}/${path.basename(merged)}`);
        for (const f of full) await rm(f, { force: true });
        done[ds] ??= { days: 0, before: 0 };
        done[ds].days++;
        done[ds].before += parts.length;
        run.inCount += parts.length;
        run.outCount += 1;
      }
    }
    return done;
  }));
}

/**
 * The registry build remembers which candidate files it already merged (registry/current/files.json). A compacted
 * file that only contains already-merged files is marked as merged too, so it is not read again for nothing.
 * (Reading it again would be harmless — merging is idempotent — just slower.)
 */
async function markMergedCandidates(sources: string[], merged: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const listFile = lakeDir('registry', 'current', 'files.json');
  const doneList = new Set(JSON.parse(await readFile(listFile, 'utf8').catch(() => '[]')) as string[]);
  if (!sources.every((s) => doneList.has(s))) return;
  for (const s of sources) doneList.delete(s);
  doneList.add(merged);
  const tmp = `${listFile}.compact.tmp`;
  await writeFile(tmp, JSON.stringify([...doneList].sort()));
  await rename(tmp, listFile);
}

/** Size of the lake per dataset, for the report. */
export async function lakeFiles(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const ds of COMPACT_DATASETS) {
    let n = 0;
    for (const d of await readdir(lakeDir(ds)).catch(() => [] as string[])) {
      const s = await stat(path.join(lakeDir(ds), d)).catch(() => null);
      if (s?.isDirectory()) n += (await readdir(path.join(lakeDir(ds), d))).filter((f) => f.endsWith('.parquet')).length;
    }
    out[ds] = n;
  }
  return out;
}
