import { QUEUES, closeDb, env, logger, migrate, queue, stopQueue } from '@lead/shared';
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
