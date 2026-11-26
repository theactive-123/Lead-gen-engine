import { closeDb, lakeQuery } from '@lead/shared';
import { dnsPlan } from './stages/dns/stage.js';
import { fetchPlan } from './stages/fetch/stage.js';
import { techPlan } from './stages/tech/stage.js';
import { probePlan } from './stages/probe/stage.js';
import { classifyPlan } from './stages/classify/stage.js';
import { contactsPlan } from './stages/contacts/stage.js';
import { signalsPlan } from './stages/signals/stage.js';
import { auditPlan } from './stages/audit/stage.js';
for (const p of [dnsPlan, fetchPlan, techPlan, probePlan, classifyPlan, contactsPlan, signalsPlan, auditPlan]) {
  const t = Date.now(); const sql = p.keysSql ? await p.keysSql() : await p.todoSql();
  const n = sql ? Number((await lakeQuery<{ n: bigint }>(`SELECT count(*) n FROM (${sql})`))[0]!.n) : 'null';
  console.log(p.key.padEnd(9), String(n).padStart(9), `${Date.now() - t} ms`);
}
await closeDb(); process.exit(0);
