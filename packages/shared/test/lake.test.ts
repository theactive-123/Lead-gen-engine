import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let lake: typeof import('../src/lake.js');

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lake-'));
  process.env.LAKE_DIR = dir;
  lake = await import('../src/lake.js');
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe('data lake', () => {
  it('writes a day partition and reads it back with DuckDB', async () => {
    const rows = [
      { domain: 'alpha.com', source: 'test', first_seen: '2026-11-19' },
      { domain: 'beta.co.uk', source: 'test', first_seen: '2026-11-19' },
      { domain: "o'reilly.com", source: 'test', first_seen: '2026-11-19' },
    ];
    const out = await lake.writeParquet('candidates', rows, {
      dt: '2026-11-19',
      columns: { domain: 'VARCHAR', source: 'VARCHAR', first_seen: 'DATE' },
    });
    expect(out.rows).toBe(3);
    expect(out.file).toContain(path.join('candidates', 'dt=2026-11-19'));

    const files = await readdir(path.join(dir, 'candidates', 'dt=2026-11-19'));
    expect(files.filter((f) => f.endsWith('.parquet'))).toHaveLength(1);
    expect(files.some((f) => f.startsWith('.staging') || f.endsWith('.tmp'))).toBe(false);

    const res = await lake.lakeQuery<{ domain: string }>(
      `SELECT domain FROM read_parquet(${lake.datasetGlob('candidates')}) ORDER BY domain`,
    );
    expect(res.map((r) => r.domain)).toEqual(['alpha.com', 'beta.co.uk', "o'reilly.com"]);
  });

  it('ignores empty batches', async () => {
    expect(await lake.writeParquet('candidates', [])).toEqual({ file: '', rows: 0 });
  });

  it('reports usage per dataset', async () => {
    const usage = await lake.lakeUsage();
    expect(usage.find((u) => u.dataset === 'candidates')?.files).toBe(1);
  });
});
