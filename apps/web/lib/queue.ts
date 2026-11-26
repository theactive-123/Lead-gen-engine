import { PgBoss } from 'pg-boss';

/**
 * "Run now" buttons put a job on the worker's queue. This client only sends jobs: it does not run
 * maintenance, schedules or migrations (the worker owns those).
 */
const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

async function boss(): Promise<PgBoss> {
  g.__boss ??= (async () => {
    const b = new PgBoss({
      connectionString: process.env.DATABASE_URL ?? 'postgres://lead:lead@localhost:5432/lead',
      max: 2, supervise: false, schedule: false, migrate: false, createSchema: false,
    });
    b.on('error', (err) => console.error('queue error', err));
    await b.start();
    return b;
  })();
  return g.__boss;
}

export async function enqueue(name: string, data: object = {}): Promise<string | null> {
  return (await boss()).send(name, data);
}
