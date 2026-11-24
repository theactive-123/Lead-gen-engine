import { rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { datasetGlob, lakeDir, lakeQuery, lakeRun, setting, sqlLiteral, withRun } from '@lead/shared';

/**
 * Stage 1 — normalise & de-duplicate.
 * Rebuilds data/lake/registry/current/registry.parquet from ALL candidates: one row per registrable
 * domain with every source that saw it, its earliest sighting, merged hints, a priority score
 * and a drop reason for junk. A full rebuild is simple and fast (DuckDB, ~seconds per 10M rows)
 * and makes the result deterministic. Rules come from the `normalize.rules` setting.
 */
export interface NormalizeRules {
  base_priority: Record<string, number>;
  cc_signal_bonus: number;
  cc_english_bonus: number;
  preferred_tlds: string[];
  preferred_tld_bonus: number;
  blocked_tlds: string[];
  tranco_top_rank: number;
  tranco_top_penalty: number;
  junk_max_label_length: number;
  junk_max_digit_ratio: number;
  junk_max_hyphens: number;
}

export const REGISTRY_FILE = () => lakeDir('registry', 'current', 'registry.parquet');

const list = (xs: string[]) => (xs.length ? `[${xs.map(sqlLiteral).join(', ')}]` : `[]::VARCHAR[]`);

export function registrySql(r: NormalizeRules): string {
  const base = Object.entries(r.base_priority)
    .map(([s, p]) => `WHEN list_contains(sources, ${sqlLiteral(s)}) THEN ${Number(p)}`)
    .join(' ');
  return `
  WITH c AS (
    SELECT domain, source, seen_at, hint FROM read_parquet(${datasetGlob('candidates')})
  ),
  agg AS (
    SELECT domain,
      min(seen_at) AS first_seen,
      list(DISTINCT source ORDER BY source) AS sources,
      max(json_extract(hint, '$.ecommerce')::INT) FILTER (WHERE source = 'commoncrawl') AS cc_ecommerce,
      max(json_extract(hint, '$.wellness')::INT)  FILTER (WHERE source = 'commoncrawl') AS cc_wellness,
      max(json_extract(hint, '$.agency')::INT)    FILTER (WHERE source = 'commoncrawl') AS cc_agency,
      max(json_extract(hint, '$.pages')::INT)     FILTER (WHERE source = 'commoncrawl') AS cc_pages,
      any_value(json_extract_string(hint, '$.lang')) FILTER (WHERE source = 'commoncrawl') AS cc_lang,
      min(json_extract(hint, '$.rank')::INT)      FILTER (WHERE source = 'tranco') AS tranco_rank,
      min(json_extract_string(hint, '$.registered')) FILTER (WHERE source = 'whoisds') AS registered,
      min(to_timestamp(json_extract(hint, '$.ts')::BIGINT / 1000)) FILTER (WHERE source = 'ct') AS ct_first_cert
    FROM c GROUP BY domain
  ),
  f AS (
    SELECT *,
      split_part(domain, '.', 1) AS label,
      regexp_extract(domain, '\\.([^.]+)$', 1) AS tld
    FROM agg
  )
  SELECT domain, first_seen, sources, cc_ecommerce, cc_wellness, cc_agency, cc_pages, cc_lang,
    tranco_rank, registered, ct_first_cert, tld,
    CASE
      WHEN list_contains(${list(r.blocked_tlds)}, tld) THEN 'blocked_tld'
      WHEN length(label) > ${Number(r.junk_max_label_length)} THEN 'junk_long_label'
      WHEN length(label) >= 6 AND length(regexp_replace(label, '[^0-9]', '', 'g')) / length(label) > ${Number(r.junk_max_digit_ratio)} THEN 'junk_digits'
      WHEN length(label) - length(replace(label, '-', '')) > ${Number(r.junk_max_hyphens)} THEN 'junk_hyphens'
      ELSE NULL
    END AS drop_reason,
    (CASE ${base} ELSE 0 END)
      + CASE WHEN coalesce(cc_ecommerce, 0) + coalesce(cc_wellness, 0) + coalesce(cc_agency, 0) > 0 THEN ${Number(r.cc_signal_bonus)} ELSE 0 END
      + CASE WHEN cc_lang = 'eng' THEN ${Number(r.cc_english_bonus)} ELSE 0 END
      + CASE WHEN list_contains(${list(r.preferred_tlds)}, tld) THEN ${Number(r.preferred_tld_bonus)} ELSE 0 END
      + CASE WHEN tranco_rank IS NOT NULL AND tranco_rank <= ${Number(r.tranco_top_rank)} THEN ${Number(r.tranco_top_penalty)} ELSE 0 END
      AS priority
  FROM f`;
}

export async function normalize(): Promise<Record<string, unknown>> {
  const rules = await setting<NormalizeRules | null>('normalize.rules', null);
  if (!rules) throw new Error('setting normalize.rules is missing');
  return withRun('stage.normalize', {}, async (run) => {
    const out = REGISTRY_FILE();
    await mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${Date.now()}.tmp`;
    await lakeRun(`COPY (${registrySql(rules)} ORDER BY priority DESC, domain) TO ${sqlLiteral(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
    await rename(tmp, out); // atomic swap: readers see the old or the new registry, never half
    const [stats] = await lakeQuery<Record<string, bigint>>(`
      SELECT count(*) AS domains, count(*) FILTER (WHERE drop_reason IS NULL) AS kept FROM read_parquet(${sqlLiteral(out)})`);
    const drops = await lakeQuery<{ drop_reason: string; n: bigint }>(`
      SELECT drop_reason, count(*) AS n FROM read_parquet(${sqlLiteral(out)}) WHERE drop_reason IS NOT NULL GROUP BY 1`);
    run.inCount = Number(stats!.domains);
    run.outCount = Number(stats!.kept);
    for (const d of drops) run.drop(d.drop_reason, Number(d.n));
    return { domains: run.inCount, kept: run.outCount };
  });
}
