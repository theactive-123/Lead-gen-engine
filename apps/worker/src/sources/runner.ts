import { db, getCheckpoint, logger, setCheckpoint, withRun, writeParquet } from '@lead/shared';
import { SOURCES } from './index.js';

/**
 * Runs one source: resume from its checkpoint, store each batch as a Parquet part in
 * data/lake/candidates/dt=<today>/, then save the batch's cursor. Order matters:
 * file first, checkpoint second -> a crash in between only re-writes the same file.
 */
export async function runSource(key: string): Promise<Record<string, unknown>> {
  const source = SOURCES[key];
  if (!source) throw new Error(`unknown source ${key}`);
  const cfg = (await db().query<{ enabled: boolean; options: Record<string, unknown> }>(
    'SELECT enabled, options FROM sources WHERE key = $1', [key],
  )).rows[0];
  if (cfg && !cfg.enabled) return { skipped: 'disabled' };

  // Circuit breaker (build spec §10): after N failed runs in a row, wait before trying again —
  // 30 min, doubling with every further failure, at most 24 h. One success closes it again.
  const breaker = await breakerOpen(key);
  if (breaker) {
    logger.warn({ source: key, ...breaker }, 'source paused after repeated failures');
    return { skipped: `paused after ${breaker.failures} failed runs in a row, next try after ${breaker.until}` };
  }

  const cpKey = `source:${key}`;
  const controller = new AbortController();
  return withRun(`source.${key}`, { source: key }, async (run) => {
    let cursor = await getCheckpoint(cpKey);
    let batches = 0;
    for await (const batch of source.run(cursor, { options: cfg?.options ?? {}, signal: controller.signal })) {
      // De-duplicate inside the batch (cross-batch/source de-dup happens in stage 1).
      const unique = new Map(batch.candidates.map((c) => [c.domain, c]));
      const now = new Date().toISOString();
      await writeParquet(
        'candidates',
        [...unique.values()].map((c) => ({ domain: c.domain, source: key, seen_at: now, hint: c.hint ? JSON.stringify(c.hint) : null })),
        { name: `${key}-${batch.partKey}`, columns: { domain: 'VARCHAR', source: 'VARCHAR', seen_at: 'TIMESTAMP', hint: 'VARCHAR' } },
      );
      await setCheckpoint(cpKey, batch.cursor);
      cursor = batch.cursor;
      run.inCount += batch.rawCount;
      run.outCount += unique.size;
      for (const [reason, n] of Object.entries(batch.dropped ?? {})) run.drop(reason, n);
      if (++batches % 5 === 0) await run.flush();
    }
    logger.info({ source: key, batches, in: run.inCount, out: run.outCount }, 'source finished');
    return { batches, in: run.inCount, out: run.outCount };
  });
}

/** Open breaker = the source failed its last N runs and the pause since the last failure is not over. */
export async function breakerOpen(key: string): Promise<{ failures: number; until: string } | null> {
  const n = Number((await db().query<{ value: number }>(`SELECT value FROM settings WHERE key = 'sources.breaker_failures'`)).rows[0]?.value ?? 3);
  const runs = (await db().query<{ status: string; error: string | null; started_at: Date }>(
    `SELECT status, error, started_at FROM runs WHERE stage = $1 AND status <> 'running' ORDER BY started_at DESC LIMIT 20`, [`source.${key}`])).rows;
  let failures = 0;
  for (const r of runs) {
    // A run cut off by a worker restart says nothing about the source itself.
    if (r.status === 'failed' && r.error !== 'worker stopped before the run finished') failures++;
    else if (r.status === 'failed') continue;
    else break;
  }
  if (failures < n) return null;
  const last = runs.find((r) => r.status === 'failed' && r.error !== 'worker stopped before the run finished')!;
  const pauseMin = Math.min(24 * 60, 30 * 2 ** (failures - n));
  const until = new Date(new Date(last.started_at).getTime() + pauseMin * 60_000);
  return until > new Date() ? { failures, until: until.toISOString() } : null;
}
