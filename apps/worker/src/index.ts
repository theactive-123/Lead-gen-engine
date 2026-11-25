import { QUEUES, closeDb, db, ensureQueue, env, logger, migrate, queue, stopQueue } from '@lead/shared';
import { SOURCES } from './sources/index.js';
import { runSource } from './sources/runner.js';
import { cleanup } from './stages/cleanup.js';
import { dnsPlan, runDnsBatch } from './stages/dns/stage.js';
import { fetchPlan, runFetchBatch } from './stages/fetch/stage.js';
import { normalize } from './stages/normalize.js';
import { planStage } from './stages/plan.js';
import { runTechBatch, techPlan } from './stages/tech/stage.js';
import { probePlan, runProbeBatch } from './stages/probe/stage.js';
import { classifyPlan, runClassifyBatch } from './stages/classify/stage.js';
import { contactsPlan, runContactsBatch } from './stages/contacts/stage.js';
import { runSignalsBatch, signalsPlan } from './stages/signals/stage.js';
import { auditPlan, runAuditBatch } from './stages/audit/stage.js';
import { lighthousePlan, runLighthouseBatch } from './stages/lighthouse/stage.js';
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
await ensureQueue(boss, 'stage.tech', { expireInSeconds: 1800 });
await ensureQueue(boss, 'stage.probe', { expireInSeconds: 1800 });
await ensureQueue(boss, 'stage.classify', { expireInSeconds: 1800 });
await ensureQueue(boss, 'stage.contacts', { expireInSeconds: 3600 });
await ensureQueue(boss, 'stage.signals', { expireInSeconds: 3600 });
await ensureQueue(boss, 'stage.audit', { expireInSeconds: 3600 });
await ensureQueue(boss, 'stage.lighthouse', { expireInSeconds: 3600 });
await ensureQueue(boss, 'system.cleanup', { exclusive: true, expireInSeconds: 3600 });
await boss.work('stage.normalize', logged('stage.normalize', () => normalize()));
// Each stage is planned on its own: one failing stage (logged with its name) must not block the others.
const plans = [dnsPlan, fetchPlan, techPlan, probePlan, classifyPlan, contactsPlan, signalsPlan, auditPlan, lighthousePlan];
await boss.work('stage.plan', logged('stage.plan', async () => {
  const out: Record<string, unknown> = {};
  for (const p of plans) {
    try {
      out[p.key] = await planStage(p);
    } catch (err) {
      logger.error({ stage: p.key, err }, 'planning failed');
      out[p.key] = { error: (err as Error).message.slice(0, 200) };
    }
  }
  return out;
}));
await boss.work<Batch>('stage.dns', { localConcurrency: 2 }, logged<Batch>('stage.dns', (d) => runDnsBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.fetch', { localConcurrency: 2 }, logged<Batch>('stage.fetch', (d) => runFetchBatch(d.snapshot, d.batch)));
// One tech batch at a time per worker: the batch itself spreads pages over `tech.threads` CPU threads.
await boss.work<Batch>('stage.tech', { localConcurrency: 1 }, logged<Batch>('stage.tech', (d) => runTechBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.probe', { localConcurrency: 2 }, logged<Batch>('stage.probe', (d) => runProbeBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.classify', { localConcurrency: 1 }, logged<Batch>('stage.classify', (d) => runClassifyBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.contacts', { localConcurrency: 2 }, logged<Batch>('stage.contacts', (d) => runContactsBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.signals', { localConcurrency: 1 }, logged<Batch>('stage.signals', (d) => runSignalsBatch(d.snapshot, d.batch)));
await boss.work<Batch>('stage.audit', { localConcurrency: 2 }, logged<Batch>('stage.audit', (d) => runAuditBatch(d.snapshot, d.batch)));
// One Lighthouse batch at a time per worker: the batch itself runs `lighthouse.parallel` Chrome instances.
await boss.work<Batch>('stage.lighthouse', { localConcurrency: 1 }, logged<Batch>('stage.lighthouse', (d) => runLighthouseBatch(d.snapshot, d.batch)));
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
