import { closeDb, datasetGlob, lakeQuery } from '@lead/shared';

/**
 * Phase 2 volume report: unique domains per source, overlaps, CT per-log contribution, samples.
 * Run: pnpm --filter @lead/worker exec tsx src/reports/phase2.ts
 */
const C = `read_parquet(${datasetGlob('candidates')}, hive_partitioning = true)`;
const show = (title: string, rows: unknown[]) => {
  console.log(`\n## ${title}`);
  console.table(rows);
};
const num = (rows: Record<string, unknown>[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));

show('Per source: rows and unique registrable domains', num(await lakeQuery(`
  SELECT source, count(*) AS rows, count(DISTINCT domain) AS unique_domains,
         min(seen_at)::VARCHAR AS first_seen, max(seen_at)::VARCHAR AS last_seen
  FROM ${C} GROUP BY 1 ORDER BY 1`)));

show('All sources combined', num(await lakeQuery(`SELECT count(DISTINCT domain) AS unique_domains_all_sources FROM ${C}`)));

show('WhoisDS per registration day', num(await lakeQuery(`
  SELECT json_extract_string(hint, '$.registered') AS day, count(DISTINCT domain) AS domains
  FROM ${C} WHERE source = 'whoisds' GROUP BY 1 ORDER BY 1`)));

show('Overlap: how many of each source are also in another', num(await lakeQuery(`
  WITH d AS (SELECT DISTINCT domain, source FROM ${C})
  SELECT a.source, count(DISTINCT a.domain) AS domains,
    count(DISTINCT a.domain) FILTER (WHERE EXISTS (SELECT 1 FROM d b WHERE b.domain = a.domain AND b.source = 'tranco')) AS in_tranco,
    count(DISTINCT a.domain) FILTER (WHERE EXISTS (SELECT 1 FROM d b WHERE b.domain = a.domain AND b.source = 'commoncrawl')) AS in_commoncrawl,
    count(DISTINCT a.domain) FILTER (WHERE EXISTS (SELECT 1 FROM d b WHERE b.domain = a.domain AND b.source = 'ct')) AS in_ct,
    count(DISTINCT a.domain) FILTER (WHERE EXISTS (SELECT 1 FROM d b WHERE b.domain = a.domain AND b.source = 'whoisds')) AS in_whoisds
  FROM d a GROUP BY 1 ORDER BY 1`)));

show('Common Crawl: domains per signal category (a domain can be in several)', num(await lakeQuery(`
  SELECT count(*) AS domains,
    count(*) FILTER (WHERE json_extract(hint,'$.ecommerce')::INT > 0) AS ecommerce,
    count(*) FILTER (WHERE json_extract(hint,'$.wellness')::INT > 0) AS wellness,
    count(*) FILTER (WHERE json_extract(hint,'$.agency')::INT > 0) AS agency,
    count(*) FILTER (WHERE json_extract_string(hint,'$.lang') = 'eng') AS english
  FROM ${C} WHERE source = 'commoncrawl'`)));

show('Common Crawl: top languages', num(await lakeQuery(`
  SELECT coalesce(json_extract_string(hint,'$.lang'), '?') AS lang, count(*) AS domains
  FROM ${C} WHERE source = 'commoncrawl' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`)));

show('Common Crawl: top TLDs', num(await lakeQuery(`
  SELECT split_part(domain, '.', -1) AS tld, count(*) AS domains
  FROM ${C} WHERE source = 'commoncrawl' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)));

const ctWindow = (await lakeQuery<{ h: number }>(`
  SELECT (epoch(max(to_timestamp(json_extract(hint,'$.ts')::BIGINT / 1000))) - epoch(min(to_timestamp(json_extract(hint,'$.ts')::BIGINT / 1000)))) / 3600.0 AS h
  FROM ${C} WHERE source = 'ct'`))[0]?.h ?? 0;
console.log(`\nCT window covered by certificate timestamps: ${Number(ctWindow).toFixed(2)} hours`);

show('CT per log: unique domains, and domains ONLY this log produced', num(await lakeQuery(`
  WITH x AS (SELECT DISTINCT domain, json_extract_string(hint,'$.log') AS log FROM ${C} WHERE source = 'ct'),
       n AS (SELECT domain, count(*) AS logs FROM x GROUP BY 1)
  SELECT x.log, count(*) AS domains, count(*) FILTER (WHERE n.logs = 1) AS only_here
  FROM x JOIN n USING (domain) GROUP BY 1 ORDER BY 2 DESC LIMIT 25`)));

show('CT: unique domains across all logs', num(await lakeQuery(`
  SELECT count(DISTINCT domain) AS domains,
         count(DISTINCT domain) FILTER (WHERE domain NOT IN (SELECT domain FROM ${C} WHERE source IN ('tranco','commoncrawl'))) AS not_in_tranco_or_cc
  FROM ${C} WHERE source = 'ct'`)));

show('New AND live: WhoisDS domains that already have an HTTPS certificate in CT', num(await lakeQuery(`
  SELECT count(DISTINCT w.domain) AS nrd_with_cert
  FROM ${C} w JOIN ${C} c ON c.domain = w.domain AND c.source = 'ct' WHERE w.source = 'whoisds'`)));

for (const src of ['tranco', 'whoisds', 'ct', 'commoncrawl']) {
  // Filter first, then sample (USING SAMPLE on the scan would sample before the WHERE).
  show(`Sample: ${src}`, num(await lakeQuery(`SELECT * FROM (SELECT domain, left(hint, 110) AS hint FROM ${C} WHERE source = '${src}') USING SAMPLE 12 ROWS`)));
}
await closeDb();
