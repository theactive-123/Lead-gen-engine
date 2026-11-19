import { QUEUES, closeDb, queue, stopQueue } from '@lead/shared';

/**
 * Small command line for operators:
 *   pnpm jobs list                          -> queue depth per job type
 *   pnpm jobs run system.lake-selftest '{"rows":100000}'   -> enqueue a job
 */
const [cmd, name, json] = process.argv.slice(2);
const boss = await queue();

if (cmd === 'run' && name) {
  const id = await boss.send(name, json ? JSON.parse(json) : {});
  console.log(`queued ${name} -> job ${id}`);
} else if (cmd === 'list' || !cmd) {
  const queues = await boss.getQueues();
  console.table(queues.map((q) => ({ queue: q.name, ready: q.readyCount, active: q.activeCount, total: q.totalCount })));
  console.log('Known job types:', Object.values(QUEUES).join(', '));
} else {
  console.log('usage: jobs list | jobs run <queue> [json]');
}
await stopQueue();
await closeDb();
