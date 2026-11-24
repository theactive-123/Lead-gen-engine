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
    expect(await lake.writeParquet('candidates', [], { columns: { domain: 'VARCHAR' } })).toEqual({ file: '', rows: 0 });
  });

  it('stores any text found on real web pages (NUL, lone surrogates, U+2028, emoji, lists, nulls)', async () => {
    const nasty = 'a\u0000b \ud800 c \u2028 d \u2029 e 🙂 "quotes" \\ back\nnew line';
    await lake.writeParquet('weird', [
      { domain: 'x.com', html: nasty, links: ['https://x.com/a', nasty], n: 5, ok: true, at: new Date('2026-11-24T10:00:00Z') },
      { domain: 'y.com', html: null, links: [], n: Number.NaN, ok: false, at: '2026-11-24T11:00:00Z' },
    ], { columns: { domain: 'VARCHAR', html: 'VARCHAR', links: 'VARCHAR[]', n: 'INTEGER', ok: 'BOOLEAN', at: 'TIMESTAMP' } });
    const rows = await lake.lakeQuery<{ domain: string; html: string | null; links: string[]; n: number | null; ok: boolean }>(
      `SELECT domain, html, links, n, ok FROM read_parquet(${lake.datasetGlob('weird')}) ORDER BY domain`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.html).toContain('🙂');
    expect(rows[0]!.html).not.toContain('\u0000');
    expect(rows[0]!.links).toHaveLength(2);
    expect(rows[1]!.html).toBeNull();
    expect(rows[1]!.n).toBeNull();
  });

  it('reports usage per dataset', async () => {
    const usage = await lake.lakeUsage();
    expect(usage.find((u) => u.dataset === 'candidates')?.files).toBe(1);
  });
});
