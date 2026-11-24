import { datasetExists, datasetGlob, db, htmlFor, setting, withRun, writeParquet } from '@lead/shared';
import { loadBatch, type StagePlan } from '../plan.js';
import { TechEngine } from './engine.js';
import { TechPool } from './pool.js';

/**
 * Stage 4 — technology fingerprinting on the stored homepage HTML of every live page.
 * Output: data/lake/tech (all detections) + Postgres `technologies` (for the dashboard / segments).
 */
export const techPlan: StagePlan = {
  key: 'tech',
  defaults: { batch: 200, snapshot: 4000 },
  async todoSql() {
    if (!(await datasetExists('pages')) || !(await datasetExists('html'))) return null;
    const done = (await datasetExists('tech')) ? `AND p.domain NOT IN (SELECT domain FROM read_parquet(${datasetGlob('tech')}))` : '';
    // Only pages whose HTML is still stored (kept a few days).
    return `
      SELECT p.domain, max(p.priority) AS priority
      FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) p
      WHERE p.pass AND p.domain IN (SELECT domain FROM read_parquet(${datasetGlob('html')})) ${done}
      GROUP BY p.domain`;
  },
};

/** How many live pages still wait for technology detection (used to slow down fetching). */
export async function techBacklog(): Promise<number> {
  if (!(await datasetExists('pages'))) return 0;
  const { lakeQuery } = await import('@lead/shared');
  const done = (await datasetExists('tech')) ? `AND domain NOT IN (SELECT domain FROM read_parquet(${datasetGlob('tech')}))` : '';
  const [r] = await lakeQuery<{ n: bigint }>(`SELECT count(DISTINCT domain) AS n FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass ${done}`);
  return Number(r?.n ?? 0);
}

let engine: TechEngine | undefined;
let pool: TechPool | undefined;

export async function runTechBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<{ domain: string }>('tech', snapshot, batch);
  const threads = await setting<number>('tech.threads', 3);
  if (threads > 0) pool ??= new TechPool(threads);
  else engine ??= new TechEngine();
  // Latest stored HTML per domain (reads only the files that contain these domains).
  const pages = await htmlFor(rows.map((r) => r.domain));

  return withRun('stage.tech', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = [];
    const pg: { domain: string; tech: string; categories: string; version: string | null; confidence: number }[] = [];
    const results = await Promise.all(
      pages.map(async (p) => {
        const page = { url: p.final_url, html: p.html ?? '', headers: JSON.parse(p.headers ?? '{}'), cookies: p.cookies ?? [] };
        try {
          return { det: pool ? await pool.analyze(page) : engine!.analyze(page), error: null as string | null };
        } catch (err) {
          return { det: [] as ReturnType<TechEngine['analyze']>, error: String((err as Error).message).slice(0, 200) };
        }
      }),
    );
    for (const [i, p] of pages.entries()) {
      const { det, error } = results[i]!;
      out.push({
        domain: p.domain,
        analyzed_at: new Date().toISOString(),
        techs: JSON.stringify(det),
        names: det.map((d) => d.name),
        categories: [...new Set(det.flatMap((d) => d.categories))],
        error,
      });
      for (const d of det) pg.push({ domain: p.domain, tech: d.name, categories: d.categories.join('\u001f'), version: d.version, confidence: d.confidence });
    }
    // Domains with no stored HTML anymore still get a row, so they are not planned again.
    const seen = new Set(pages.map((p) => p.domain));
    for (const r of rows) if (!seen.has(r.domain)) out.push({ domain: r.domain, analyzed_at: new Date().toISOString(), techs: '[]', names: [], categories: [], error: 'html_expired' });

    await writeParquet('tech', out, {
      name: `tech-${snapshot}-${batch}`,
      columns: { domain: 'VARCHAR', analyzed_at: 'TIMESTAMP', techs: 'VARCHAR', names: 'VARCHAR[]', categories: 'VARCHAR[]', error: 'VARCHAR' },
    });
    // Postgres: replace this batch's technologies (idempotent re-runs).
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM technologies t USING domains d WHERE t.domain_id = d.id AND d.domain = ANY($1::text[])`, [rows.map((r) => r.domain)]);
      if (pg.length) {
        await client.query(
          `INSERT INTO technologies (domain_id, tech, categories, version, confidence)
           SELECT d.id, x.tech, string_to_array(x.cats, chr(31)), x.version, x.conf
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) AS x(domain, tech, cats, version, conf)
           JOIN domains d ON d.domain = x.domain
           ON CONFLICT (domain_id, tech) DO NOTHING`,
          [pg.map((x) => x.domain), pg.map((x) => x.tech), pg.map((x) => x.categories), pg.map((x) => x.version), pg.map((x) => x.confidence)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    run.inCount = rows.length;
    run.outCount = pages.length;
    if (rows.length > pages.length) run.drop('html_expired', rows.length - pages.length);
    return { pages: pages.length, techRows: pg.length };
  });
}
