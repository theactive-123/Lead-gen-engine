import { lakeQuery, sqlLiteral } from '@lead/shared';
import { glob, stat } from 'node:fs/promises';
const bad: string[] = []; let n = 0, empty = 0;
for await (const f of glob('/home/user/lead-gen-engine/data/lake/**/*.parquet')) {
  if (f.includes('/queue/')) { if ((await stat(f)).size === 0) empty++; continue; }
  n++;
  try { await lakeQuery(`SELECT count(*) FROM read_parquet(${sqlLiteral(f)})`); }
  catch (e) { bad.push(`${f} (${(await stat(f)).size} B, ${(await stat(f)).mtime.toISOString()}) :: ${(e as Error).message.slice(0, 70)}`); }
}
console.log('checked', n, 'bad', bad.length, 'empty queue snapshots', empty); for (const b of bad) console.log(b);
process.exit(0);
