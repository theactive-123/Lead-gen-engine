import { QUEUES, closeDb, countSegment, db, queue, refreshSegments, stopQueue } from '@lead/shared';
import { runScoring } from './stages/score/stage.js';
import { funnel } from './jobs/funnel.js';
import { SOURCES } from './sources/index.js';
import { runSource } from './sources/runner.js';
import { dnsPlan } from './stages/dns/stage.js';
import { fetchPlan } from './stages/fetch/stage.js';
import { normalize } from './stages/normalize.js';
import { planStage } from './stages/plan.js';
import { techPlan } from './stages/tech/stage.js';
import { probePlan } from './stages/probe/stage.js';
import { classifyPlan } from './stages/classify/stage.js';
import { contactsPlan } from './stages/contacts/stage.js';
import { signalsPlan } from './stages/signals/stage.js';
import { auditPlan } from './stages/audit/stage.js';
import { lighthousePlan } from './stages/lighthouse/stage.js';

/**
 * Small command line for operators:
 *   pnpm jobs list                          -> queue depth per job type
 *   pnpm jobs run system.lake-selftest '{"rows":100000}'   -> enqueue a job
 *   pnpm jobs source ct                     -> run a source right now in this process (no queue)
 *   pnpm jobs health                        -> check every source is reachable
 *   pnpm jobs normalize                     -> rebuild the domain registry now
 *   pnpm jobs plan                          -> plan batches for every pipeline stage now
 *   pnpm jobs score [full]                  -> score leads for every brand now (full = every lead)
 *   pnpm jobs funnel                        -> recount the dashboard funnel now
 *   pnpm jobs segments [id]                 -> refresh saved segment members now
 *   pnpm jobs count <brand_key> '<filter json>'  -> live count of a segment filter
 */
const [cmd, name, json] = process.argv.slice(2);
const boss = await queue();

if (cmd === 'funnel') {
  console.log(await funnel());
} else if (cmd === 'score') {
  console.log(JSON.stringify(await runScoring({ full: name === 'full' }), null, 1));
} else if (cmd === 'segments') {
  console.table(await refreshSegments(name ? Number(name) : undefined));
} else if (cmd === 'count' && name) {
  const { rows } = await db().query<{ id: number }>('SELECT id FROM brands WHERE key = $1', [name]);
  if (!rows[0]) throw new Error(`no brand ${name}`);
  console.log(await countSegment(rows[0].id, json ? JSON.parse(json) : {}));
} else if (cmd === 'normalize') {
  console.log(await normalize());
} else if (cmd === 'plan') {
  console.log({ dns: await planStage(dnsPlan), fetch: await planStage(fetchPlan), tech: await planStage(techPlan), probe: await planStage(probePlan), classify: await planStage(classifyPlan), contacts: await planStage(contactsPlan), signals: await planStage(signalsPlan), audit: await planStage(auditPlan), lighthouse: await planStage(lighthousePlan) });
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
