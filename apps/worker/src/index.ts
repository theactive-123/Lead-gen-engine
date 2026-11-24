import { QUEUES, closeDb, db, ensureQueue, env, logger, migrate, queue, stopQueue } from '@lead/shared';
import { SOURCES } from './sources/index.js';
import { runSource } from './sources/runner.js';
import { cleanup } from './stages/cleanup.js';
import { dnsPlan, runDnsBatch } from './stages/dns/stage.js';
import { fetchPlan, runFetchBatch } from './stages/fetch/stage.js';
import { normalize } from './stages/normalize.js';
import { planStage } from './stages/plan.js';
import { beat, diskUsage, heartbeat, lakeSelftest } from './jobs/system.js';

/**
 * Worker process: applies migrations, connects to the queue, registers job handlers
 * and the recurring schedules. You can run several worker processes; they share the queue.
 */
await migrate();
const boss = await queue();

// Liveness: beat now and every 30s, independent of the queue.
await beat();
const beatTimer = setInterval(() => void beat().catch((err) => logger.warn({ err }, 'beat failed')), 30_000);
const concurrency = env().WORKER_CONCURRENCY;

/** Wraps a handler so every failure is logged (pg-boss then retries, then dead-letters). */
function logged<T>(name: string, fn: (data: T) => Promise<unknown>) {
  return async ([job]: { id: string; data: T }[]) => {
    try {
      return await fn(job!.data);
    } catch (err) {
      logger.error({ queue: name, job: job!.id, err }, 'job failed');
      throw err;
    }
  };
}

await boss.work(QUEUES.heartbeat, logged(QUEUES.heartbeat, () => heartbeat()));
await boss.work(QUEUES.diskUsage, logged(QUEUES.diskUsage, () => diskUsage()));
await boss.work<{ rows?: number }>(
  QUEUES.lakeSelftest,
  { localConcurrency: Math.min(concurrency, 2) },
  logged<{ rows?: number }>(QUEUES.lakeSelftest, (d) => lakeSelftest(d ?? {})),
);

// Sources: one queue per source ("source.<key>"), scheduled from the `sources` table.
const sourceRows = (await db().query<{ key: string; schedule: string; enabled: boolean }>('SELECT key, schedule, enabled FROM sources')).rows;
for (const row of sourceRows) {
  if (!SOURCES[row.key]) continue;
  const name = `source.${row.key}`;
  await ensureQueue(boss, name, { exclusive: true, expireInSeconds: 6 * 60 * 60 });
  await boss.work(name, logged(name, () => runSource(row.key)));
  if (row.enabled) await boss.schedule(name, row.schedule);
  else await boss.unschedule(name).catch(() => {});
}

// Pipeline stages. Normalise rebuilds the registry; the planner tops up the DNS and fetch queues;
// batch jobs do the work. Several workers can share these queues.
type Batch = { snapshot: string; batch: number };
await ensureQueue(boss, 'stage.normalize', { exclusive: true, expireInSeconds: 3600 });
await ensureQueue(boss, 'stage.plan', { exclusive: true, expireInSeconds: 600 });
await ensureQueue(boss, 'stage.dns', { expireInSeconds: 1800 });
await ensureQueue(boss, 'stage.fetch', { expireInSeconds: 1800 });
await ensureQueue(boss, 'system.cleanup', { exclusive: true, expireInSeconds: 3600 });
await boss.work('stage.normalize', logged('stage.normalize', () => normalize()));
await boss.work('stage.plan', logged('stage.plan', async () => ({ dns: await planStage(dnsPlan), fetch: await planStage(fetchPlan) })));
await boss.work<Batch>('stage.dns', { localConcurrency: 2 }, logged<Batch>('stage.dns', (d) => runDnsBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.fetch', { localConcurrency: 2 }, logged<Batch>('stage.fetch', (d) => runFetchBatch(d.snapshot, d.batch)));
await boss.work('system.cleanup', logged('system.cleanup', () => cleanup()));
await boss.schedule('stage.normalize', '*/15 * * * *');
await boss.schedule('stage.plan', '* * * * *');
await boss.schedule('system.cleanup', '37 2 * * *');

// Recurring jobs (cron, UTC). pg-boss makes sure only one worker runs each tick.
await boss.schedule(QUEUES.heartbeat, '* * * * *');
await boss.schedule(QUEUES.diskUsage, '*/15 * * * *');

// Run the cheap system jobs once right away so the dashboard has data immediately.
await boss.send(QUEUES.heartbeat, {});
await boss.send(QUEUES.diskUsage, {});

logger.info({ concurrency, queues: Object.values(QUEUES) }, 'worker started');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'worker stopping (finishing active jobs)');
  clearInterval(beatTimer);
  await stopQueue();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
