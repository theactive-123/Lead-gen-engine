import { closeDb, datasetGlob, lakeQuery } from '@lead/shared';
import { COMPACT_DATASETS, lakeFiles } from './jobs/lake-maintenance.js';
const out: Record<string, string> = {};
for (const ds of COMPACT_DATASETS) {
  const [r] = await lakeQuery<{ n: bigint; d: bigint }>(`SELECT count(*) n, count(DISTINCT domain) d FROM read_parquet(${datasetGlob(ds)}, union_by_name = true)`);
  out[ds] = `${r!.n} rows / ${r!.d} domains`;
}
console.log(JSON.stringify({ counts: out, files: await lakeFiles() }));
await closeDb(); process.exit(0);
