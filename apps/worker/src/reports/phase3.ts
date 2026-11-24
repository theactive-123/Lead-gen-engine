import { closeDb, datasetGlob, db, lakeQuery, sqlLiteral } from '@lead/shared';
import { REGISTRY_FILE } from '../stages/normalize.js';

/**
 * Phase 3 report: stage throughput, funnel, platforms, and DNS evidence for platform rules.
 * Usage: tsx src/reports/phase3.ts [since-ISO-timestamp]
 */
const since = process.argv[2] ?? new Date(Date.now() - 3600_000).toISOString();
const D = `read_parquet(${datasetGlob('dns')}, union_by_name = true)`;
const P = `read_parquet(${datasetGlob('pages')}, union_by_name = true)`;
const R = `read_parquet(${sqlLiteral(REGISTRY_FILE())})`;
const show = (t: string, rows: unknown[]) => {
  console.log(`\n## ${t}`);
  console.table(rows.map((r) => Object.fromEntries(Object.entries(r as object).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
};

show('Throughput per stage (Postgres runs table)', (await db().query(`
  SELECT stage, count(*) FILTER (WHERE status = 'ok') AS ok_runs, count(*) FILTER (WHERE status = 'failed') AS failed_runs,
         sum(in_count) AS records, round(extract(epoch FROM max(finished_at) - min(started_at)) / 60, 1) AS minutes,
         round(sum(in_count) / nullif(extract(epoch FROM max(finished_at) - min(started_at)) / 3600, 0)) AS per_hour
  FROM runs WHERE started_at >= $1 AND stage LIKE 'stage.%' GROUP BY 1 ORDER BY 1`, [since])).rows);

show('Funnel', await lakeQuery(`
  SELECT (SELECT count(*) FROM ${R}) AS registry,
         (SELECT count(*) FROM ${R} WHERE drop_reason IS NULL) AS kept,
         (SELECT count(*) FROM ${D}) AS dns_checked,
         (SELECT count(*) FROM ${D} WHERE pass) AS dns_pass,
         (SELECT count(*) FROM ${P}) AS fetched,
         (SELECT count(*) FROM ${P} WHERE pass) AS live_pages`));

show('DNS status', await lakeQuery(`SELECT status, count(*) AS n FROM ${D} GROUP BY 1 ORDER BY 2 DESC`));
show('Fetch status', await lakeQuery(`SELECT fetch_status, coalesce(https_error, '') AS https_error, count(*) AS n FROM ${P} GROUP BY ALL ORDER BY n DESC LIMIT 15`));
show('Page tags (live + dropped)', await lakeQuery(`SELECT tag, count(*) AS n FROM (SELECT unnest(tags) AS tag FROM ${P}) GROUP BY 1 ORDER BY 2 DESC`));
show('Platform (from page fingerprints), live pages', await lakeQuery(`
  SELECT coalesce(platform, '(none found)') AS platform, count(*) AS n, round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
  FROM ${P} WHERE pass GROUP BY 1 ORDER BY 2 DESC`));
show('Mail provider (MX host suffix), domains that pass DNS', await lakeQuery(`
  SELECT regexp_extract(mx[1], '([^.]+\\.[^.]+)$', 1) AS mx_suffix, count(*) AS n FROM ${D} WHERE pass AND len(mx) > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 12`));
show('Live pages: speed and age', await lakeQuery(`
  SELECT round(median(ttfb_ms)) AS median_ttfb_ms, round(quantile_cont(ttfb_ms, 0.9)) AS p90_ttfb_ms,
         round(median(html_bytes) / 1024) AS median_html_kb,
         count(*) FILTER (WHERE NOT https) AS http_only, count(*) FILTER (WHERE NOT viewport) AS no_viewport,
         count(*) FILTER (WHERE copyright_year IS NOT NULL AND copyright_year <= 2023) AS copyright_2023_or_older
  FROM ${P} WHERE pass`));

// DNS evidence: for each frequent DNS value, which page platform do those sites run?
const evidence = (label: string, valueSql: string) => lakeQuery(`
  WITH x AS (SELECT ${valueSql} AS v, coalesce(p.platform, '(none)') AS platform FROM ${D} d JOIN ${P} p USING (domain) WHERE p.fetch_status = 'ok'),
  t AS (SELECT v, count(*) AS sites FROM x WHERE v IS NOT NULL AND v <> '' GROUP BY 1 HAVING count(*) >= 15),
  b AS (SELECT v, platform, count(*) AS n, row_number() OVER (PARTITION BY v ORDER BY count(*) DESC) AS r FROM x GROUP BY 1, 2)
  SELECT '${label}' AS record, t.v AS value, t.sites, b.platform AS top_platform, round(100.0 * b.n / t.sites, 1) AS precision_pct
  FROM t JOIN b ON b.v = t.v AND b.r = 1 ORDER BY t.sites DESC LIMIT 25`);
show('DNS evidence: www CNAME target (last 3 labels)', await evidence('www_cname', `regexp_extract(d.www_cname[1], '([^.]+\\.[^.]+\\.[^.]+)$', 1)`));
show('DNS evidence: apex A address', await evidence('a', `d.a[1]`));
show('DNS evidence: nameserver (last 2 labels)', await evidence('ns', `regexp_extract(d.ns[1], '([^.]+\\.[^.]+)$', 1)`));

show('Sample live pages', await lakeQuery(`
  SELECT domain, left(title, 45) AS title, platform, copyright_year AS yr, ttfb_ms FROM (SELECT * FROM ${P} WHERE pass) USING SAMPLE 12 ROWS`));
show('Sample dropped pages', await lakeQuery(`
  SELECT domain, fetch_status, tags, left(coalesce(title, error, ''), 50) AS info FROM (SELECT * FROM ${P} WHERE NOT pass) USING SAMPLE 12 ROWS`));
await closeDb();
