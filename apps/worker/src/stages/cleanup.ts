import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { lakeDir, setting, withRun } from '@lead/shared';

/**
 * Daily housekeeping: delete compressed homepage HTML older than `html.retention_days`
 * and work-plan snapshot files older than 7 days. Features in `pages` are kept forever.
 */
export async function cleanup(): Promise<Record<string, unknown>> {
  const keepDays = await setting<number>('html.retention_days', 7);
  return withRun('system.cleanup', { keepDays }, async (run) => {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    const htmlDir = lakeDir('html');
    for (const d of await readdir(htmlDir).catch(() => [] as string[])) {
      const day = /^dt=(\d{4}-\d{2}-\d{2})$/.exec(d)?.[1];
      if (day && day < cutoff) {
        await rm(path.join(htmlDir, d), { recursive: true, force: true });
        removed++;
      }
    }
    const qDir = lakeDir('queue');
    for (const stage of await readdir(qDir).catch(() => [] as string[])) {
      for (const f of await readdir(path.join(qDir, stage)).catch(() => [] as string[])) {
        const p = path.join(qDir, stage, f);
        if ((await stat(p)).mtimeMs < Date.now() - 7 * 86_400_000) {
          await rm(p, { force: true });
          removed++;
        }
      }
    }
    run.inCount = run.outCount = removed;
    return { removed };
  });
}
