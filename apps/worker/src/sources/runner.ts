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
