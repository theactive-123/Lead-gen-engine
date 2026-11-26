import { datasetExists, datasetGlob, db, lakeQuery, setting, sqlLiteral, withRun } from '@lead/shared';
import { REGISTRY_FILE } from '../stages/normalize.js';
import { SOURCES } from '../sources/index.js';

/**
 * Hourly: count the funnel per first-seen day and source, so the dashboard never has to scan the data lake.
 * Early stages (candidates → DNS → fetched) come from the lake (DuckDB); later ones (in niche → contact →
 * qualified) from Postgres. Source 'all' counts each domain once (a domain can come from several sources).
 */
interface Row { day: string; source: string; [k: string]: number | string }

export async function funnel(): Promise<Record<string, unknown>> {
  return withRun('system.funnel', {}, async (run) => {
    const days = Math.max(1, Number(await setting('funnel.days', 45)));
    const rows = new Map<string, Row>();
    const put = (r: Row) => {
      const k = `${r.day}|${r.source}`;
      rows.set(k, { ...(rows.get(k) ?? { day: r.day, source: r.source }), ...r });
    };

    const dns = (await datasetExists('dns'))
      ? `LEFT JOIN (SELECT domain, arg_max(pass, resolved_at) AS ok FROM read_parquet(${datasetGlob('dns')}, union_by_name = true) GROUP BY 1) dn USING (domain)`
      : 'LEFT JOIN (SELECT NULL::VARCHAR domain, NULL::BOOLEAN ok) dn USING (domain)';
    const pages = (await datasetExists('pages'))
      ? `LEFT JOIN (SELECT domain, bool_or(pass) AS ok FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) GROUP BY 1) pg USING (domain)`
      : 'LEFT JOIN (SELECT NULL::VARCHAR domain, NULL::BOOLEAN ok) pg USING (domain)';
    const lake = await lakeQuery<Record<string, unknown>>(`
      WITH r AS (
        SELECT domain, CAST(first_seen AS DATE) AS day, sources, drop_reason
        FROM read_parquet(${sqlLiteral(REGISTRY_FILE())})
        WHERE first_seen >= current_date - INTERVAL ${days} DAY),
      x AS (SELECT r.*, dn.ok AS dns_ok, pg.ok AS page_ok FROM r ${dns} ${pages}),
      s AS (SELECT day, unnest(sources) AS source, drop_reason, dns_ok, page_ok FROM x
            UNION ALL SELECT day, 'all', drop_reason, dns_ok, page_ok FROM x)
      SELECT CAST(day AS VARCHAR) AS day, source, count(*) AS candidates, count(*) FILTER (WHERE drop_reason IS NULL) AS kept,
        count(dns_ok) AS dns_checked, count(*) FILTER (WHERE dns_ok) AS resolved, count(*) FILTER (WHERE page_ok) AS fetched
      FROM s GROUP BY 1, 2`);
    for (const r of lake) put({ day: String(r.day), source: String(r.source), candidates: Number(r.candidates), kept: Number(r.kept),
      dns_checked: Number(r.dns_checked), resolved: Number(r.resolved), fetched: Number(r.fetched) });

    const pgRows = (await db().query<{ day: string; source: string; in_niche: string; with_contact: string; qualified: string }>(`
      WITH x AS (
        SELECT d.first_seen AS day, d.sources, ct.email IS NOT NULL AS has_email,
          EXISTS (SELECT 1 FROM brand_matches m WHERE m.domain_id = d.id AND m.tier IN ('A', 'B')) AS qualified
        FROM classifications k JOIN domains d ON d.id = k.domain_id LEFT JOIN contacts ct ON ct.domain_id = d.id
        WHERE d.first_seen >= current_date - $1::int),
      s AS (SELECT day, unnest(sources) AS source, has_email, qualified FROM x UNION ALL SELECT day, 'all', has_email, qualified FROM x)
      SELECT to_char(day, 'YYYY-MM-DD') AS day, source, count(*) AS in_niche, count(*) FILTER (WHERE has_email) AS with_contact,
        count(*) FILTER (WHERE qualified) AS qualified FROM s GROUP BY 1, 2`, [days])).rows;
    for (const r of pgRows) put({ day: r.day, source: r.source, in_niche: Number(r.in_niche), with_contact: Number(r.with_contact), qualified: Number(r.qualified) });

    const list = [...rows.values()];
    const col = (k: string) => list.map((r) => Number(r[k] ?? 0));
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM funnel_daily WHERE day >= current_date - $1::int`, [days]);
      await client.query(
        `INSERT INTO funnel_daily (day, source, candidates, kept, dns_checked, resolved, fetched, in_niche, with_contact, qualified)
         SELECT * FROM unnest($1::date[], $2::text[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::int[])`,
        [list.map((r) => r.day), list.map((r) => r.source), col('candidates'), col('kept'), col('dns_checked'), col('resolved'),
          col('fetched'), col('in_niche'), col('with_contact'), col('qualified')],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    run.inCount = list.length;
    run.outCount = list.length;
    return { rows: list.length, days };
  });
}

/** Hourly: ask every source if its upstream is reachable; the dashboard shows the latest answer. */
export async function sourceHealth(): Promise<Record<string, unknown>> {
  const out: Record<string, { ok: boolean; detail: string; checked_at: string }> = {};
  for (const s of Object.values(SOURCES)) {
    try {
      const h = await s.health();
      out[s.key] = { ...h, checked_at: new Date().toISOString() };
    } catch (err) {
      out[s.key] = { ok: false, detail: (err as Error).message.slice(0, 300), checked_at: new Date().toISOString() };
    }
  }
  await db().query(`INSERT INTO system_metrics (metric, value) VALUES ('source_health', $1)`, [JSON.stringify(out)]);
  return out;
}
