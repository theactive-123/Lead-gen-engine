import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { closeDb, datasetExists, datasetGlob, lakeQuery, sqlLiteral } from '@lead/shared';
import { REGISTRY_FILE } from '../stages/normalize.js';
import { Classifier } from '../stages/classify/engine.js';
import { hasStore, loadTaxonomy } from '../stages/classify/stage.js';

/**
 * Evaluates the CURRENT taxonomy on all live pages (using whatever tech/probe data exists) without writing
 * anything to the pipeline. Prints counts per niche and writes N samples per sub-niche for review.
 * Usage: tsx src/reports/classify-eval.ts [samplesPerSubNiche=50] [outDir]
 */
const N = Number(process.argv[2] ?? 50);
const outDir = process.argv[3] ?? '/tmp/classify-eval';
const tech = (await datasetExists('tech')) ? `LEFT JOIN (SELECT domain, arg_max(names, analyzed_at) AS techs FROM read_parquet(${datasetGlob('tech')}) GROUP BY domain) t USING (domain)` : `LEFT JOIN (SELECT NULL::VARCHAR domain, NULL::VARCHAR[] techs) t USING (domain)`;
const probe = (await datasetExists('store_probe')) ? `LEFT JOIN (SELECT domain, arg_max(ok, probed_at) ok, arg_max(product_count, probed_at) product_count, arg_max(count_method, probed_at) count_method, arg_max(sample_titles, probed_at) sample_titles, arg_max(product_types, probed_at) product_types, arg_max(vendors, probed_at) vendors FROM read_parquet(${datasetGlob('store_probe')}) GROUP BY domain) s USING (domain)` : '';
const rows = await lakeQuery<any>(`
  WITH p AS (SELECT domain, arg_max(platform, fetched_at) platform, arg_max(title, fetched_at) title, arg_max(h1, fetched_at) h1,
                    arg_max(meta_description, fetched_at) meta_description, arg_max(site_name, fetched_at) site_name,
                    arg_max(text_sample, fetched_at) text_sample, arg_max(links_internal, fetched_at) links_internal, arg_max(lang, fetched_at) lang
             FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass GROUP BY domain)
  SELECT p.*, t.techs, ${probe ? 's.ok probe_ok, s.product_count, s.count_method, s.sample_titles, s.product_types, s.vendors' : 'NULL probe_ok, NULL product_count, NULL count_method, NULL sample_titles, NULL product_types, NULL vendors'},
         r.cc_ecommerce
  FROM p ${tech} ${probe} LEFT JOIN (SELECT domain, cc_ecommerce FROM read_parquet(${sqlLiteral(REGISTRY_FILE())})) r USING (domain)`);
const tax = await loadTaxonomy();
const clf = new Classifier(tax);
const pathOf = (u: string) => { try { return new URL(u).pathname.toLowerCase(); } catch { return ''; } };
const results = rows.map((r) => {
  const store = hasStore(r);
  const res = clf.classify({
    domain: r.domain, title: r.title, h1: r.h1, meta: r.meta_description, site_name: r.site_name, text: r.text_sample,
    products: [...(r.sample_titles ?? []), ...(r.product_types ?? []), ...(r.vendors ?? [])].join(' | ') || null,
    link_paths: (r.links_internal ?? []).map(pathOf), techs: r.techs ?? [], store_evidence: store, product_count: r.product_count, platform: r.platform,
  });
  return { r, res, store };
});
const by = new Map<string, typeof results>();
for (const x of results) { const k = x.res.sub_niche ?? '(out of scope)'; by.set(k, [...(by.get(k) ?? []), x]); }
const subName = new Map(tax.subNiches.map((s) => [s.key, s]));
const nicheKey = new Map(tax.niches.map((n) => [n.id, n.key]));
console.log(`pages: ${rows.length}, with tech data: ${rows.filter((r) => r.techs).length}, in scope: ${results.filter((x) => x.res.in_scope).length}`);
const table = [...by].map(([k, xs]) => ({ niche: k === '(out of scope)' ? '' : nicheKey.get(subName.get(k)!.niche_id), sub_niche: k, n: xs.length, median_conf: xs.map((x) => x.res.confidence).sort()[Math.floor(xs.length / 2)] }))
  .sort((a, b) => (a.niche ?? '').localeCompare(b.niche ?? '') || b.n - a.n);
console.table(table);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
for (const [k, xs] of by) {
  const sample = [...xs].sort(() => Math.random() - 0.5).slice(0, N);
  writeFileSync(`${outDir}/${k.replace(/[^a-z_]/gi, '_')}.tsv`, ['domain\tconfidence\ttitle\treason\trunner_up', ...sample.map((x) =>
    [x.r.domain, x.res.confidence, (x.r.title ?? '').replace(/\s+/g, ' ').slice(0, 90), x.res.reason.slice(0, 220), `${x.res.runner_up ?? ''} ${x.res.runner_score || ''}`].join('\t'))].join('\n'));
}
console.log(`samples written to ${outDir}`);
await closeDb();
