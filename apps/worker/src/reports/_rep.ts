import { lakeQuery, lakeRun } from '@lead/shared';
import { rename } from 'node:fs/promises';
const D = '/tmp/claude-0/-home-user/f7509be1-bedf-5ca9-ba98-c5fb8b21c29f/scratchpad/';
console.log(await lakeQuery(`SELECT current_setting('enable_external_file_cache') efc, current_setting('parquet_metadata_cache') pmc`));
const write = async (n: number, seed: number) => {
  await lakeRun(`COPY (SELECT md5((i*${seed})::VARCHAR) || 'x' AS domain, (i % 97)::INT AS priority FROM range(${n}) t(i)) TO '${D}reg.tmp' (FORMAT parquet, COMPRESSION zstd)`);
  await rename(`${D}reg.tmp`, `${D}reg.parquet`);
};
for (let k = 0; k < 6; k++) {
  await write(3_000_000 + k * 777_777, k + 1);
  try { console.log(k, await lakeQuery(`SELECT count(*) n, max(domain) m FROM '${D}reg.parquet' WHERE priority > 50`)); }
  catch (e) { console.log(k, 'ERR', (e as Error).message.slice(0, 80)); }
}
process.exit(0);
