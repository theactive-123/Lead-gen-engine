import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Re-check schedule (build spec §12) on a small synthetic data lake with dates relative to "now". */
let dir: string;
let lake: typeof import('@lead/shared');
let plan: typeof import('../src/stages/plan.js');
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
const domains = async (sql: string) => (await lake.lakeQuery<{ domain: string }>(`${sql}`)).map((r) => r.domain).sort();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'recheck-'));
  process.env.LAKE_DIR = dir;
  lake = await import('@lead/shared');
  plan = await import('../src/stages/plan.js');
  const dns = { domain: 'VARCHAR', pass: 'BOOLEAN', resolved_at: 'TIMESTAMP' } as const;
  await lake.writeParquet('dns', [
    { domain: 'ok.com', pass: true, resolved_at: ago(30) },
    { domain: 'fail2d.com', pass: false, resolved_at: ago(2) },
    { domain: 'fail8d.com', pass: false, resolved_at: ago(8) },
    { domain: 'second-due.com', pass: false, resolved_at: ago(22) }, { domain: 'second-due.com', pass: false, resolved_at: ago(10) },
    { domain: 'second-wait.com', pass: false, resolved_at: ago(15) }, { domain: 'second-wait.com', pass: false, resolved_at: ago(10) },
    ...[60, 50, 30, 10].map((d) => ({ domain: 'gave-up.com', pass: false, resolved_at: ago(d) })),
    { domain: 'recovered.com', pass: false, resolved_at: ago(20) }, { domain: 'recovered.com', pass: true, resolved_at: ago(12) },
  ], { columns: dns, name: 'dns' });
  const pages = { domain: 'VARCHAR', pass: 'BOOLEAN', fetch_status: 'VARCHAR', fetched_at: 'TIMESTAMP' } as const;
  await lake.writeParquet('pages', [
    { domain: 'fresh-in.com', pass: true, fetch_status: 'ok', fetched_at: ago(10) },
    { domain: 'stale-in.com', pass: true, fetch_status: 'ok', fetched_at: ago(40) },
    { domain: 'stale-out.com', pass: true, fetch_status: 'ok', fetched_at: ago(40) },
    { domain: 'robots.com', pass: false, fetch_status: 'robots_disallowed', fetched_at: ago(30) },
    { domain: 'timeout8.com', pass: false, fetch_status: 'timeout', fetched_at: ago(8) },
    { domain: 'timeout3.com', pass: false, fetch_status: 'timeout', fetched_at: ago(3) },
    { domain: 'parked.com', pass: false, fetch_status: 'ok', fetched_at: ago(9) },
    // the tech stage below: b.com was fetched again after its analysis
    { domain: 'a.com', pass: true, fetch_status: 'ok', fetched_at: ago(5) },
    { domain: 'b.com', pass: true, fetch_status: 'ok', fetched_at: ago(5) }, { domain: 'b.com', pass: true, fetch_status: 'ok', fetched_at: ago(1) },
    // usable page, never analysed, HTML already expired → must be fetched again
    { domain: 'stranded.com', pass: true, fetch_status: 'ok', fetched_at: ago(5) },
    // usable page, not analysed yet, HTML still there → just waiting for the tech stage
    { domain: 'waiting.com', pass: true, fetch_status: 'ok', fetched_at: ago(1) },
  ], { columns: pages, name: 'pages' });
  await lake.writeParquet('html', [{ domain: 'waiting.com', html: '<html></html>' }], { columns: { domain: 'VARCHAR', html: 'VARCHAR' }, name: 'html' });
  await lake.writeParquet('classified', [
    { domain: 'fresh-in.com', in_scope: true, classified_at: ago(9) },
    { domain: 'stale-in.com', in_scope: true, classified_at: ago(39) },
    { domain: 'stale-out.com', in_scope: false, classified_at: ago(39) },
  ], { columns: { domain: 'VARCHAR', in_scope: 'BOOLEAN', classified_at: 'TIMESTAMP' }, name: 'classified' });
  await lake.writeParquet('tech', [
    { domain: 'a.com', analyzed_at: ago(4) }, { domain: 'b.com', analyzed_at: ago(4) }, { domain: 'no-page.com', analyzed_at: ago(4) },
  ], { columns: { domain: 'VARCHAR', analyzed_at: 'TIMESTAMP' }, name: 'tech' });
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe('re-check schedule', () => {
  it('DNS: failed lookups are retried 7, 21 and 45 days after the first attempt, then given up', async () => {
    const done = await domains(plan.dnsDoneSql([7, 21, 45]));
    expect(done).toEqual(['fail2d.com', 'gave-up.com', 'ok.com', 'recovered.com', 'second-wait.com']);
    // not done = due now: fail8d.com (day 8 ≥ 7) and second-due.com (2 attempts, day 22 ≥ 21)
  });
  it('homepage: in-niche sites again after 30 days; failures on the retry schedule; robots refusals never', async () => {
    const done = await domains(plan.fetchDoneSql({ days: [7, 21, 45], inNicheDays: 30, finalStatuses: ['robots_disallowed', 'offsite_redirect'], hasClassified: true }));
    expect(done).toContain('fresh-in.com');
    expect(done).toContain('stale-out.com'); // not in a niche: no monthly re-crawl
    expect(done).toContain('robots.com');
    expect(done).toContain('timeout3.com');
    expect(done).not.toContain('stale-in.com'); // in niche, 40 days old → fetch again
    expect(done).not.toContain('timeout8.com'); // first retry due at day 7
    expect(done).not.toContain('parked.com'); // no usable page yet → retried too
  });
  it('a usable page whose HTML expired before technology detection ran is fetched again', async () => {
    const done = await domains(plan.fetchDoneSql({ days: [7, 21, 45], inNicheDays: 30, finalStatuses: [], hasClassified: true, hasTech: true, hasHtml: true }));
    expect(done).not.toContain('stranded.com');
    expect(done).toContain('waiting.com');
    expect(done).toContain('a.com'); // analysed already
  });
  it('later stages redo a domain whose input is newer than their result', async () => {
    const current = await domains(plan.currentSql({ dataset: 'tech', ts: 'analyzed_at' }, [{ dataset: 'pages', ts: 'fetched_at', where: 'pass' }]));
    expect(current).toEqual(['a.com', 'no-page.com']); // b.com was fetched again after it was analysed
  });
  it('"re-classify all" style cut-off makes everything older stale', async () => {
    const cut = `TIMESTAMP '${ago(2)}'`;
    expect(await domains(plan.currentSql({ dataset: 'tech', ts: 'analyzed_at' }, [], cut))).toEqual([]);
  });
});
