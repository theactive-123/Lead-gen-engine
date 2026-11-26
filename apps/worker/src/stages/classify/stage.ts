import { existsSync } from 'node:fs';
import { datasetExists, datasetGlob, db, lakeQuery, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { REGISTRY_FILE } from '../normalize.js';
import { currentSql, loadBatch, type StagePlan } from '../plan.js';
import { PROBE_PLATFORMS } from '../probe/stage.js';
import { Classifier, type Taxonomy } from './engine.js';

/**
 * Stage 6 — niche classification. Runs once a live page has its technologies (and, for
 * Shopify/WooCommerce/WordPress, its store probe). In-scope leads stay in Postgres with a
 * `classifications` row; out-of-scope domains are removed from Postgres (kept in the lake).
 */
const STORE_PLATFORMS = ['Shopify', 'WooCommerce', 'BigCommerce', 'Magento', 'PrestaShop'];
const STORE_TECHS = ['Squarespace Commerce', 'Wix eCommerce', 'Ecwid', 'Snipcart', 'Shopify Buy Button'];

export const classifyPlan: StagePlan = {
  key: 'classify',
  defaults: { batch: 2000, snapshot: 20000 },
  // Light: which domains need classifying (no page text). The planner picks the next snapshot from this.
  async keysSql() {
    if (!(await datasetExists('pages')) || !(await datasetExists('tech'))) return null;
    const hasProbe = await datasetExists('store_probe');
    // "Re-classify all" (dashboard → Niches) sets classify.reclassify_after: anything classified before it is done again.
    const after = new Date(String(await setting<string | null>('classify.reclassify_after', null) ?? 0));
    const since = Number.isFinite(after.getTime()) && after.getTime() > 0 ? `TIMESTAMP '${after.toISOString().replace('T', ' ').replace('Z', '')}'` : undefined;
    // Done = classified after the newest technology result, store probe and "re-classify all".
    const done = (await datasetExists('classified'))
      ? `AND p.domain NOT IN (${currentSql({ dataset: 'classified', ts: 'classified_at' }, [{ dataset: 'tech', ts: 'analyzed_at' }, ...(hasProbe ? [{ dataset: 'store_probe', ts: 'probed_at' }] : [])], since)})`
      : '';
    // Store platforms wait for their store probe first.
    const probeReady = hasProbe
      ? `AND (p.platform IS NULL OR p.platform NOT IN (${PROBE_PLATFORMS.map(sqlLiteral).join(', ')}) OR p.domain IN (SELECT domain FROM read_parquet(${datasetGlob('store_probe')})))`
      : `AND (p.platform IS NULL OR p.platform NOT IN (${PROBE_PLATFORMS.map(sqlLiteral).join(', ')}))`;
    return `
      SELECT p.domain, p.priority FROM (
        SELECT domain, max(priority) AS priority, arg_max(platform, fetched_at) AS platform
        FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass GROUP BY domain) p
      WHERE p.domain IN (SELECT domain FROM read_parquet(${datasetGlob('tech')})) ${probeReady} ${done}`;
  },
  // Heavy: page text, links, products — only for the domains the planner picked (`keys`).
  async todoSql(keys?: string) {
    if (!keys || !(await datasetExists('pages')) || !(await datasetExists('tech'))) return null;
    const hasProbe = await datasetExists('store_probe');
    const pick = `domain IN (SELECT domain FROM (${keys}))`;
    const probeJoin = hasProbe
      ? `LEFT JOIN (SELECT domain, arg_max(ok, probed_at) AS ok, arg_max(product_count, probed_at) AS product_count,
                          arg_max(count_method, probed_at) AS count_method, arg_max(sample_titles, probed_at) AS sample_titles,
                          arg_max(product_types, probed_at) AS product_types, arg_max(vendors, probed_at) AS vendors
                   FROM read_parquet(${datasetGlob('store_probe')}) WHERE ${pick} GROUP BY domain) s USING (domain)`
      : `LEFT JOIN (SELECT NULL::VARCHAR AS domain, NULL::BOOLEAN AS ok, NULL::INTEGER AS product_count, NULL::VARCHAR AS count_method,
                          NULL::VARCHAR[] AS sample_titles, NULL::VARCHAR[] AS product_types, NULL::VARCHAR[] AS vendors) s USING (domain)`;
    const reg = existsSync(REGISTRY_FILE())
      ? `LEFT JOIN (SELECT domain, cc_ecommerce, first_seen, sources FROM read_parquet(${sqlLiteral(REGISTRY_FILE())}) WHERE ${pick}) r USING (domain)`
      : `LEFT JOIN (SELECT NULL::VARCHAR AS domain, NULL::INTEGER AS cc_ecommerce, NULL::TIMESTAMP AS first_seen, NULL::VARCHAR[] AS sources) r USING (domain)`;
    return `
      WITH p AS (
        SELECT domain, max(priority) AS priority, arg_max(platform, fetched_at) AS platform, arg_max(title, fetched_at) AS title,
               arg_max(h1, fetched_at) AS h1, arg_max(meta_description, fetched_at) AS meta_description, arg_max(site_name, fetched_at) AS site_name,
               arg_max(text_sample, fetched_at) AS text_sample, arg_max(links_internal, fetched_at) AS links_internal,
               arg_max(final_url, fetched_at) AS final_url, arg_max(lang, fetched_at) AS lang, arg_max(tags, fetched_at) AS tags,
               arg_max(http_status, fetched_at) AS http_status, max(fetched_at) AS fetched_at
        FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass AND ${pick} GROUP BY domain
      ),
      t AS (SELECT domain, arg_max(names, analyzed_at) AS techs FROM read_parquet(${datasetGlob('tech')}) WHERE ${pick} GROUP BY domain)
      SELECT p.*, t.techs, s.ok AS probe_ok, s.product_count, s.count_method, s.sample_titles, s.product_types, s.vendors,
             r.cc_ecommerce, r.first_seen, r.sources
      FROM p JOIN t USING (domain) ${probeJoin} ${reg}`;
  },
};

export async function loadTaxonomy(): Promise<Taxonomy> {
  const q = async <T>(sql: string) => (await db().query(sql)).rows as T[];
  return {
    niches: await q(`SELECT id, key, name, gate, excluded FROM niches WHERE enabled`),
    subNiches: await q(`SELECT s.id, s.key, s.name, s.niche_id FROM sub_niches s JOIN niches n ON n.id = s.niche_id WHERE s.enabled AND n.enabled`),
    keywords: await q(`SELECT sub_niche_id, term, kind, weight::float AS weight FROM keywords`),
    urlPatterns: await q(`SELECT niche_id, sub_niche_id, pattern, weight::float AS weight FROM url_patterns`),
    techHints: await q(`SELECT niche_id, tech, weight::float AS weight FROM niche_tech_hints`),
    fieldWeights: await setting('classify.field_weights', { title: 3, h1: 2, meta: 2, site_name: 2, products: 2, text: 1, domain: 1 }),
    minScore: await setting('classify.min_score', 4),
    textCap: await setting('classify.text_cap', 2),
    boostMinKeywords: await setting('classify.boost_min_keywords', 2),
  };
}

interface Row {
  domain: string; priority: number; platform: string | null; title: string | null; h1: string | null; meta_description: string | null;
  site_name: string | null; text_sample: string | null; links_internal: string[] | null; final_url: string; lang: string | null;
  tags: string[] | null; http_status: number; fetched_at: Date; techs: string[] | null; probe_ok: boolean | null;
  product_count: number | null; count_method: string | null; sample_titles: string[] | null; product_types: string[] | null;
  vendors: string[] | null; cc_ecommerce: number | null; first_seen: Date | null; sources: string[] | null;
}

/** Real store evidence: a store platform/technology, a probed catalogue, or Common Crawl shop pages. */
export function hasStore(r: Pick<Row, 'platform' | 'techs' | 'probe_ok' | 'product_count' | 'count_method' | 'cc_ecommerce'>): boolean {
  if (r.probe_ok && r.count_method === 'reported' && r.product_count === 0) return false; // the store says it sells nothing
  if ((r.product_count ?? 0) > 0) return true;
  if (r.platform && STORE_PLATFORMS.includes(r.platform)) return true;
  if ((r.techs ?? []).some((t) => STORE_TECHS.includes(t))) return true;
  return (r.cc_ecommerce ?? 0) >= 3;
}

const pathOf = (u: string) => {
  try {
    return new URL(u).pathname.toLowerCase();
  } catch {
    return '';
  }
};

/** Copy technologies and store profile of recreated leads back from the lake (same data the stages wrote). */
type PgClient = import('@lead/shared').DbClient;
async function restoreFromLake(client: PgClient, domains: string[]): Promise<void> {
  const list = domains.map(sqlLiteral).join(', ');
  const techs = await lakeQuery<{ domain: string; techs: string }>(
    `SELECT domain, arg_max(techs, analyzed_at) AS techs FROM read_parquet(${datasetGlob('tech')}) WHERE domain IN (${list}) GROUP BY domain`,
  );
  const t: { d: string; n: string; c: string; v: string | null; k: number }[] = [];
  for (const row of techs) for (const x of JSON.parse(row.techs ?? '[]') as { name: string; categories: string[]; version: string | null; confidence: number }[])
    t.push({ d: row.domain, n: x.name, c: x.categories.join('\u001f'), v: x.version, k: x.confidence });
  if (t.length) {
    await client.query(
      `INSERT INTO technologies (domain_id, tech, categories, version, confidence)
       SELECT d.id, x.n, string_to_array(x.c, chr(31)), x.v, x.k
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) AS x(d, n, c, v, k) JOIN domains d ON d.domain = x.d
       ON CONFLICT (domain_id, tech) DO NOTHING`,
      [t.map((x) => x.d), t.map((x) => x.n), t.map((x) => x.c), t.map((x) => x.v), t.map((x) => x.k)],
    );
  }
  if (!(await datasetExists('store_probe'))) return;
  const stores = await lakeQuery<Record<string, any>>(
    `SELECT domain, arg_max(COLUMNS(* EXCLUDE (domain)), probed_at) FROM read_parquet(${datasetGlob('store_probe')}) WHERE domain IN (${list}) AND ok AND platform <> 'WordPress' GROUP BY domain`,
  );
  for (const o of stores) {
    await client.query(
      `INSERT INTO store_profiles (domain_id, platform, product_count, count_method, price_min, price_max, price_median, currency,
         last_product_update, newest_product_at, vendors, product_types, sample_titles, collections_count, theme, extra)
       SELECT id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb FROM domains WHERE domain = $1
       ON CONFLICT (domain_id) DO NOTHING`,
      [o.domain, o.platform, o.product_count, o.count_method, o.price_min, o.price_max, o.price_median, o.currency, o.last_published_at,
       o.newest_created_at, o.vendors ?? [], o.product_types ?? [], o.sample_titles ?? [], o.collections_count, o.theme,
       JSON.stringify({ price_sample: o.price_sample, shop_name: o.shop_name, country: o.country, province: o.province, city: o.city })],
    );
  }
}

export async function runClassifyBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Row>('classify', snapshot, batch);
  const tax = await loadTaxonomy();
  const clf = new Classifier(tax);
  const nicheId = new Map(tax.niches.map((n) => [n.key, n.id]));
  const subId = new Map(tax.subNiches.map((s) => [s.key, s.id]));

  return withRun('stage.classify', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const store = hasStore(r);
      const res = clf.classify({
        domain: r.domain, title: r.title, h1: r.h1, meta: r.meta_description, site_name: r.site_name, text: r.text_sample,
        products: [...(r.sample_titles ?? []), ...(r.product_types ?? []), ...(r.vendors ?? [])].join(' | ') || null,
        link_paths: (r.links_internal ?? []).map(pathOf), techs: r.techs ?? [], store_evidence: store,
        product_count: r.product_count, platform: r.platform,
      });
      out.push({ domain: r.domain, classified_at: new Date().toISOString(), store_evidence: store, ...res, top: JSON.stringify(res.top) });
    }
    await writeParquet('classified', out, {
      name: `classify-${snapshot}-${batch}`,
      columns: {
        domain: 'VARCHAR', classified_at: 'TIMESTAMP', niche: 'VARCHAR', sub_niche: 'VARCHAR', in_scope: 'BOOLEAN', score: 'DOUBLE',
        runner_up: 'VARCHAR', runner_score: 'DOUBLE', confidence: 'DOUBLE', reason: 'VARCHAR', top: 'VARCHAR', store_evidence: 'BOOLEAN',
      },
    });

    const inScope = out.filter((o) => o.in_scope);
    const outScope = out.filter((o) => !o.in_scope).map((o) => String(o.domain));
    const byDomain = new Map(rows.map((r) => [r.domain, r]));
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      // Re-classified domains may have been removed earlier: recreate their lead row from the lake data.
      const present = new Set((await client.query<{ domain: string }>(`SELECT domain FROM domains WHERE domain = ANY($1::text[])`, [inScope.map((o) => o.domain)])).rows.map((x) => x.domain));
      const toCreate = inScope.map((o) => byDomain.get(String(o.domain))!).filter((r) => !present.has(r.domain));
      if (toCreate.length) {
        await client.query(
          `INSERT INTO domains (domain, first_seen, sources, priority, platform, final_url, http_status, title, lang, tags, stage_status, fetched_at, updated_at)
           SELECT d, fs::date, string_to_array(src, ','), pr, pl, fu, hs, ti, la, string_to_array(tg, ','), 'classified', ft::timestamptz, now()
           FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::int[], $8::text[], $9::text[], $10::text[], $11::text[])
             AS x(d, fs, src, pr, pl, fu, hs, ti, la, tg, ft)
           ON CONFLICT (domain) DO NOTHING`,
          [
            toCreate.map((r) => r.domain), toCreate.map((r) => (r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10))),
            toCreate.map((r) => (r.sources ?? []).join(',')), toCreate.map((r) => r.priority), toCreate.map((r) => r.platform),
            toCreate.map((r) => r.final_url), toCreate.map((r) => r.http_status), toCreate.map((r) => r.title), toCreate.map((r) => r.lang),
            toCreate.map((r) => (r.tags ?? []).join(',')), toCreate.map((r) => new Date(r.fetched_at).toISOString()),
          ],
        );
      }
      if (toCreate.length) await restoreFromLake(client, toCreate.map((r) => r.domain));
      if (inScope.length) {
        await client.query(
          `INSERT INTO classifications (domain_id, niche_id, sub_niche_id, confidence, score, reason, classified_at)
           SELECT d.id, x.n, x.s, x.c, x.sc, x.re, now()
           FROM unnest($1::text[], $2::int[], $3::int[], $4::numeric[], $5::numeric[], $6::text[]) AS x(domain, n, s, c, sc, re)
           JOIN domains d ON d.domain = x.domain
           ON CONFLICT (domain_id) DO UPDATE SET niche_id = EXCLUDED.niche_id, sub_niche_id = EXCLUDED.sub_niche_id,
             confidence = EXCLUDED.confidence, score = EXCLUDED.score, reason = EXCLUDED.reason, classified_at = now()`,
          [
            inScope.map((o) => o.domain), inScope.map((o) => nicheId.get(String(o.niche))), inScope.map((o) => subId.get(String(o.sub_niche))),
            inScope.map((o) => o.confidence), inScope.map((o) => o.score), inScope.map((o) => o.reason),
          ],
        );
        await client.query(`UPDATE domains SET stage_status = 'classified', updated_at = now() WHERE domain = ANY($1::text[])`, [inScope.map((o) => o.domain)]);
      }
      // Out of scope: kept in the lake only (CLAUDE.md stage 6.4). Cascades to technologies / store profiles.
      if (outScope.length) await client.query(`DELETE FROM domains WHERE domain = ANY($1::text[])`, [outScope]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    run.inCount = rows.length;
    run.outCount = inScope.length;
    for (const o of out) if (!o.in_scope) run.drop(o.niche ? `excluded:${o.sub_niche}` : 'no_niche');
    return { pages: rows.length, in_scope: inScope.length };
  });
}
