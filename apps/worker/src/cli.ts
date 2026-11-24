import { QUEUES, closeDb, queue, stopQueue } from '@lead/shared';
import { SOURCES } from './sources/index.js';
import { runSource } from './sources/runner.js';
import { dnsPlan } from './stages/dns/stage.js';
import { fetchPlan } from './stages/fetch/stage.js';
import { normalize } from './stages/normalize.js';
import { planStage } from './stages/plan.js';

/**
 * Small command line for operators:
 *   pnpm jobs list                          -> queue depth per job type
 *   pnpm jobs run system.lake-selftest '{"rows":100000}'   -> enqueue a job
 *   pnpm jobs source ct                     -> run a source right now in this process (no queue)
 *   pnpm jobs health                        -> check every source is reachable
 *   pnpm jobs normalize                     -> rebuild the domain registry now
 *   pnpm jobs plan                          -> plan DNS + fetch batches now
 */
const [cmd, name, json] = process.argv.slice(2);
const boss = await queue();

if (cmd === 'normalize') {
  console.log(await normalize());
} else if (cmd === 'plan') {
  console.log({ dns: await planStage(dnsPlan), fetch: await planStage(fetchPlan) });
} else if (cmd === 'source' && name) {
  console.log(await runSource(name));
} else if (cmd === 'health') {
  for (const s of Object.values(SOURCES)) {
    try {
      console.log(s.key.padEnd(12), JSON.stringify(await s.health()));
    } catch (err) {
      console.log(s.key.padEnd(12), 'ERROR', (err as Error).message);
    }
  }
} else if (cmd === 'run' && name) {
  const id = await boss.send(name, json ? JSON.parse(json) : {});
  console.log(`queued ${name} -> job ${id}`);
} else if (cmd === 'list' || !cmd) {
  const queues = await boss.getQueues();
  console.table(queues.map((q) => ({ queue: q.name, ready: q.readyCount, active: q.activeCount, total: q.totalCount })));
  console.log('Known job types:', Object.values(QUEUES).join(', '), '+ source.<key> per source');
} else {
  console.log('usage: jobs list | jobs run <queue> [json]');
}
await stopQueue();
await closeDb();
