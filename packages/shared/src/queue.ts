import { PgBoss } from 'pg-boss';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Job names. Each pipeline stage and source becomes one queue.
 * Later phases add to this list; the dashboard reads queue depth per name.
 */
export const QUEUES = {
  heartbeat: 'system.heartbeat',
  diskUsage: 'system.disk-usage',
  lakeSelftest: 'system.lake-selftest',
} as const;

export const DEAD_LETTER = 'system.dead-letter';

/** Per-queue time limit for one job (seconds). Default 2 hours. */
const EXPIRE_SECONDS: Record<string, number> = {
  [QUEUES.heartbeat]: 60,
  [QUEUES.diskUsage]: 120,
  [QUEUES.lakeSelftest]: 600,
};

let boss: PgBoss | undefined;

/** Starts pg-boss (it creates its own "pgboss" schema in Postgres on first start). */
export async function queue(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({ connectionString: env().DATABASE_URL, max: 5 });
  b.on('error', (err) => logger.error({ err }, 'queue error'));
  await b.start();
  await b.createQueue(DEAD_LETTER).catch(() => {});
  for (const name of Object.values(QUEUES)) {
    const options = {
      deadLetter: DEAD_LETTER,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      // Upper bound for one job; long stage batches may run for a while.
      expireInSeconds: EXPIRE_SECONDS[name] ?? 2 * 60 * 60,
      // Workers refresh this automatically while a job runs. If a worker dies,
      // its job is retried after ~30-60s instead of waiting for the expiry above.
      heartbeatSeconds: 30,
    };
    if (await b.getQueue(name)) await b.updateQueue(name, options);
    else await b.createQueue(name, options);
  }
  boss = b;
  return b;
}

export async function stopQueue(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = undefined;
}
