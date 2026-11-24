import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { ensureQueue, getCheckpoint, lakeDir, lakeQuery, lakeRun, logger, queue, setCheckpoint, setting, sqlLiteral } from '@lead/shared';

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
  todoSql: () => Promise<string | null>; // SELECT domain, priority, ...extra columns; null = nothing to do
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

  const todo = await plan.todoSql();
  if (!todo) return { skipped: 'input not available yet' };

  const recent = (await getCheckpoint<string[]>(`plan:${plan.key}`)) ?? [];
  const exclude = recent.length
    ? `WHERE domain NOT IN (SELECT domain FROM read_parquet([${recent.map((id) => sqlLiteral(snapshotFile(plan.key, id))).join(', ')}]))`
    : '';
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const file = snapshotFile(plan.key, id);
  await mkdir(path.dirname(file), { recursive: true });
  await lakeRun(`
    COPY (
      SELECT *, ((row_number() OVER (ORDER BY priority DESC, domain)) - 1) // ${Number(batchSize)} AS batch
      FROM (SELECT * FROM (${todo}) t ${exclude} ORDER BY priority DESC, domain LIMIT ${Number(snapshotSize)})
    ) TO ${sqlLiteral(file)} (FORMAT parquet)`);
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
