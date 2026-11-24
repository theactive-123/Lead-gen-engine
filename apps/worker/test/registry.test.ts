import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let lake: typeof import('@lead/shared');
let n: typeof import('../src/stages/normalize.js');

const rules = {
  base_priority: { ct: 10, tranco: 0, whoisds: 5, commoncrawl: 40 },
  cc_signal_bonus: 20, cc_english_bonus: 10, preferred_tlds: ['com'], preferred_tld_bonus: 5,
  blocked_tlds: ['xyz'], tranco_top_rank: 10000, tranco_top_penalty: -50,
  junk_max_label_length: 30, junk_max_digit_ratio: 0.5, junk_max_hyphens: 2,
};
const cols = { domain: 'VARCHAR', source: 'VARCHAR', seen_at: 'TIMESTAMP', hint: 'VARCHAR' } as const;
const files: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'reg-'));
  process.env.LAKE_DIR = dir;
  lake = await import('@lead/shared');
  n = await import('../src/stages/normalize.js');
  const batches = [
    [
      { domain: 'shop.com', source: 'ct', seen_at: '2026-11-20 10:00:00', hint: '{"ts":1795600000000}' },
      { domain: 'shop.com', source: 'commoncrawl', seen_at: '2026-11-19 00:00:00', hint: '{"ecommerce":3,"pages":40,"lang":"eng"}' },
      { domain: 'big.com', source: 'tranco', seen_at: '2026-11-19 00:00:00', hint: '{"rank":50}' },
    ],
    [
      { domain: 'shop.com', source: 'ct', seen_at: '2026-11-21 10:00:00', hint: '{"ts":1795500000000}' },
      { domain: 'big.com', source: 'tranco', seen_at: '2026-11-21 00:00:00', hint: '{"rank":20}' },
      { domain: 'new-site.xyz', source: 'whoisds', seen_at: '2026-11-21 00:00:00', hint: '{"registered":"2026-11-20"}' },
    ],
    [
      { domain: 'shop.com', source: 'commoncrawl', seen_at: '2026-11-22 00:00:00', hint: '{"ecommerce":1,"wellness":2,"pages":90,"lang":"eng"}' },
      { domain: '1234567890ab.com', source: 'ct', seen_at: '2026-11-22 00:00:00', hint: '{"ts":1795700000000}' },
    ],
  ];
  for (const [i, rows] of batches.entries()) {
    const out = await lake.writeParquet('candidates', rows, { dt: `2026-11-2${i}`, name: `b${i}`, columns: cols });
    files.push(out.file);
  }
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

const q = (sql: string) => lake.lakeQuery(`${sql} ORDER BY domain`);
const read = (fs: string[]) => `SELECT domain, source, seen_at, hint FROM read_parquet([${fs.map(lake.sqlLiteral).join(',')}])`;
const base = 'domain, first_seen, sources, cc_ecommerce, cc_wellness, cc_agency, cc_pages, cc_lang, tranco_rank, registered, ct_first_cert';

describe('registry (normalize)', () => {
  it('incremental merge in chunks equals a full rebuild', async () => {
    const full = await q(n.registrySql(rules));
    // file 1 alone, then merge 2, then merge 3 (and file 2 a second time: re-reading must change nothing)
    let cur = n.aggregateSql(read([files[0]!]));
    cur = n.mergeSql(`SELECT ${base} FROM (${cur}) UNION ALL BY NAME ${n.aggregateSql(read([files[1]!]))}`);
    cur = n.mergeSql(`SELECT ${base} FROM (${cur}) UNION ALL BY NAME ${n.aggregateSql(read([files[2]!, files[1]!]))}`);
    const inc = await q(n.deriveSql(cur, rules));
    expect(inc).toEqual(full);
    expect(full).toHaveLength(4);
  });

  it('merges values correctly', async () => {
    const rows = await q(n.registrySql(rules));
    const shop = rows.find((r) => r.domain === 'shop.com')!;
    expect(shop.sources).toEqual(['commoncrawl', 'ct']);
    expect(shop.cc_ecommerce).toBe(3);
    expect(shop.cc_wellness).toBe(2);
    expect(shop.cc_pages).toBe(90);
    expect(rows.find((r) => r.domain === 'big.com')!.tranco_rank).toBe(20);
    // best source score wins: commoncrawl 40 (not ct 10, listed first) + cc signal 20 + english 10 + .com 5
    expect(shop.priority).toBe(75);
    expect(rows.find((r) => r.domain === 'new-site.xyz')!.drop_reason).toBe('blocked_tld');
    expect(rows.find((r) => r.domain === '1234567890ab.com')!.drop_reason).toBe('junk_digits');
  });
});
