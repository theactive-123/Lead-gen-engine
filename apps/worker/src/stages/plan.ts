import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { datasetGlob as datasetGlobFor, ensureQueue, getCheckpoint, lakeDir, lakeQuery, lakeRun, logger, queue, setCheckpoint, setting, sqlLiteral } from '@lead/shared';

/**
 * Work planner shared by the batch stages (dns, fetch, ...).
 *
 * Each stage defines a DuckDB query returning the domains still to do, best first. The planner
 * freezes the next N of them into a "snapshot" Parquet file (data/lake/queue/<stage>/<id>.parquet)
 * numbered into batches, and enqueues one job per batch. Jobs only carry {snapshot, batch}.
 *
 * Why: the outputs themselves are the record of what is done (a domain is done when it has an
 * output row), so nothing is lost or repeated on restarts. Domains in the most recent snapshots
 * are excluded from planning, so in-flight work is never planned twice; if a batch is lost for
 * good, its domains become eligible again once their snapshot ages out of that window.
 */
export interface StagePlan {
  key: string;                 // stage key; queue is `stage.<key>`
  /**
   * SELECT domain, priority, ...extra columns; null = nothing to do. When the stage also has `keysSql`, it receives
   * `keys` (a query of the domains picked for this snapshot) and must only read heavy columns for those domains.
   */
  todoSql: (keys?: string) => Promise<string | null>;
  /**
   * Optional, for stages with heavy inputs (page text, link lists): SELECT domain, priority of everything still to do,
   * using light columns only. The planner picks the next snapshot from it first, so memory stays small at millions of pages.
   */
  keysSql?: () => Promise<string | null>;
  /** Optional: a reason to hold planning (e.g. the next stage has a big backlog), else null. */
  hold?: () => Promise<string | null>;
  defaults: { batch: number; snapshot: number };
}

const RECENT_SNAPSHOTS = 6;

export const snapshotFile = (stage: string, id: string) => lakeDir('queue', stage, `${id}.parquet`);

export async function planStage(plan: StagePlan): Promise<{ planned: number; batches: number } | { skipped: string }> {
  // Disk guard: never let the engine fill the disk (HTML alone is ~2 GB/hour at full speed).
  const minFreeGb = await setting<number>('disk.min_free_gb', 20);
  await mkdir(lakeDir(), { recursive: true });
  const fs = await statfs(lakeDir());
  const freeGb = (fs.bavail * fs.bsize) / 1e9;
  if (freeGb < minFreeGb) {
    logger.warn({ stage: plan.key, freeGb: +freeGb.toFixed(1), minFreeGb }, 'low disk space: not planning new work');
    return { skipped: `low disk: ${freeGb.toFixed(1)} GB free < ${minFreeGb} GB` };
  }

  const boss = await queue();
  const name = `stage.${plan.key}`;
  await ensureQueue(boss, name);
  const q = await boss.getQueue(name);
  const batchSize = await setting<number>(`stage.${plan.key}.batch_size`, plan.defaults.batch);
  const snapshotSize = await setting<number>(`stage.${plan.key}.snapshot_size`, plan.defaults.snapshot);
  // Keep a modest backlog: plan again only when less than one snapshot's worth of batches is waiting.
  const waiting = (q?.queuedCount ?? 0) + (q?.activeCount ?? 0);
  if (waiting >= Math.ceil(snapshotSize / batchSize)) return { skipped: `${waiting} batches already waiting` };

  const held = await plan.hold?.();
  if (held) return { skipped: held };

  const recent = (await getCheckpoint<string[]>(`plan:${plan.key}`)) ?? [];
  const exclude = recent.length
    ? `WHERE domain NOT IN (SELECT domain FROM read_parquet([${recent.map((id) => sqlLiteral(snapshotFile(plan.key, id))).join(', ')}]))`
    : '';
  let todo: string | null;
  if (plan.keysSql) {
    const keys = await plan.keysSql();
    if (!keys) return { skipped: 'input not available yet' };
    todo = await plan.todoSql(`SELECT domain FROM (${keys}) k ${exclude} ORDER BY priority DESC, domain LIMIT ${Number(snapshotSize)}`);
  } else {
    todo = await plan.todoSql();
  }
  if (!todo) return { skipped: 'input not available yet' };
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const file = snapshotFile(plan.key, id);
  await mkdir(path.dirname(file), { recursive: true });
  // Write to a temp name and rename: a query that fails half-way (e.g. out of memory) must not leave
  // a broken snapshot under the real name.
  const tmp = `${file}.tmp`;
  try {
    await lakeRun(`
      COPY (
        SELECT *, ((row_number() OVER (ORDER BY priority DESC, domain)) - 1) // ${Number(batchSize)} AS batch
        FROM (SELECT * FROM (${todo}) t ${exclude} ORDER BY priority DESC, domain LIMIT ${Number(snapshotSize)})
      ) TO ${sqlLiteral(tmp)} (FORMAT parquet)`);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  const [{ n, b }] = (await lakeQuery<{ n: bigint; b: bigint }>(
    `SELECT count(*) AS n, count(DISTINCT batch) AS b FROM read_parquet(${sqlLiteral(file)})`,
  )) as [{ n: bigint; b: bigint }];
  if (Number(n) === 0) return { skipped: 'nothing to do' };

  await boss.insert(name, Array.from({ length: Number(b) }, (_, batch) => ({ data: { snapshot: id, batch } })));
  await setCheckpoint(`plan:${plan.key}`, [...recent, id].slice(-RECENT_SNAPSHOTS));
  logger.info({ stage: plan.key, snapshot: id, domains: Number(n), batches: Number(b) }, 'stage planned');
  return { planned: Number(n), batches: Number(b) };
}

/** Rows of one batch of a snapshot. */
export async function loadBatch<T = Record<string, unknown>>(stage: string, snapshot: string, batch: number): Promise<T[]> {
  return lakeQuery<T>(`SELECT * FROM read_parquet(${sqlLiteral(snapshotFile(stage, snapshot))}) WHERE batch = ${Number(batch)}`);
}

const EPOCH = `TIMESTAMP '1970-01-01'`;

/**
 * Domains whose result in `out` is still current: produced after the newest of its inputs.
 * Used by every stage instead of "has a result": when a page is fetched again (monthly re-crawl,
 * retry), each later stage redoes that domain in order (tech after the new page, niche after the new tech…).
 * An input a domain does not have (e.g. no store probe) never makes it stale.
 */
export function currentSql(out: { dataset: string; ts: string }, inputs: { dataset: string; ts: string; where?: string }[], extraSince?: string): string {
  const joins = inputs.map((i, n) =>
    `LEFT JOIN (SELECT domain, max(${i.ts}) AS t FROM read_parquet(${datasetGlobFor(i.dataset)}, union_by_name = true) ${i.where ? `WHERE ${i.where}` : ''} GROUP BY 1) i${n} USING (domain)`).join('\n      ');
  const newest = [...inputs.map((_, n) => `coalesce(i${n}.t, ${EPOCH})`), ...(extraSince ? [extraSince] : []), EPOCH].join(', ');
  return `
    SELECT o.domain FROM (SELECT domain, max(${out.ts}) AS t FROM read_parquet(${datasetGlobFor(out.dataset)}, union_by_name = true) GROUP BY 1) o
      ${joins}
    WHERE o.t >= greatest(${newest})`;
}

/** Re-check schedule (days after the first attempt) for domains with no usable site yet: setting recheck.retry_days. */
export async function retryDays(): Promise<number[]> {
  const d = await setting<number[]>('recheck.retry_days', [7, 21, 45]);
  return Array.isArray(d) ? d.map(Number).filter((x) => x > 0) : [7, 21, 45];
}

/** SQL CASE: the day offset of the next retry after `n` attempts (NULL = no more retries). */
export function nextRetrySql(n: string, days: number[]): string {
  return days.length ? `CASE ${days.map((d, i) => `WHEN ${n} = ${i + 1} THEN ${Number(d)}`).join(' ')} ELSE NULL END` : 'NULL';
}

const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;

/** DNS: done = resolved, or failed and not due for a retry yet (or out of retries). */
export function dnsDoneSql(days: number[]): string {
  const next = nextRetrySql('n', days);
  return `SELECT domain FROM (SELECT domain, min(resolved_at) AS first, count(*) AS n, arg_max(pass, resolved_at) AS ok
                               FROM read_parquet(${datasetGlobFor('dns')}) GROUP BY 1)
          WHERE ok OR ${next} IS NULL OR ${NOW_UTC} < first + to_days(CAST(${next} AS INTEGER))`;
}

/**
 * Homepage fetch: done = a usable page that is fresh enough, or a failure that is final / not due for a retry.
 *  - in-niche sites are fetched again after `inNicheDays` (monthly re-crawl);
 *  - no usable page (timeout, error, parked, coming soon…): retried on the `days` schedule;
 *  - `finalStatuses` (robots.txt refusal, redirect to another domain) are never retried.
 */
export function fetchDoneSql(o: { days: number[]; inNicheDays: number; finalStatuses: string[]; hasClassified: boolean; hasTech?: boolean; hasHtml?: boolean }): string {
  const next = nextRetrySql('n', o.days);
  const finals = o.finalStatuses.length ? o.finalStatuses.map(sqlLiteral).join(', ') : `''`;
  const inScope = o.hasClassified
    ? `SELECT domain FROM read_parquet(${datasetGlobFor('classified')}) GROUP BY 1 HAVING arg_max(in_scope, classified_at)`
    : `SELECT NULL::VARCHAR AS domain WHERE false`;
  // A usable page whose stored HTML expired before technology detection reached it can never be analysed:
  // fetch it again instead of leaving it stuck.
  const stranded = o.hasTech && o.hasHtml
    ? `SELECT domain FROM read_parquet(${datasetGlobFor('pages')}, union_by_name = true) WHERE pass
         AND domain NOT IN (SELECT domain FROM read_parquet(${datasetGlobFor('tech')}))
         AND domain NOT IN (SELECT domain FROM read_parquet(${datasetGlobFor('html')}))`
    : `SELECT NULL::VARCHAR AS domain WHERE false`;
  return `SELECT domain FROM (SELECT domain, min(fetched_at) AS first, max(fetched_at) AS last, count(*) AS n,
                                     arg_max(pass, fetched_at) AS ok, arg_max(fetch_status, fetched_at) AS status
                              FROM read_parquet(${datasetGlobFor('pages')}, union_by_name = true) GROUP BY 1)
          WHERE (ok AND domain NOT IN (${stranded}) AND (domain NOT IN (${inScope}) OR last >= ${NOW_UTC} - to_days(${Number(o.inNicheDays)})))
             OR (NOT coalesce(ok, false) AND (status IN (${finals}) OR ${next} IS NULL OR ${NOW_UTC} < first + to_days(CAST(${next} AS INTEGER))))`;
}
