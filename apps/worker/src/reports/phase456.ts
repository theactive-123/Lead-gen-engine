import { writeFileSync } from 'node:fs';
import { closeDb, datasetGlob, lakeQuery } from '@lead/shared';

/**
 * Phases 4-6 report: technologies, store probes, niches, contact completeness, business signals.
 * Usage: tsx src/reports/phase456.ts [samples-csv-path]
 */
const out = process.argv[2];
const P = `read_parquet(${datasetGlob('pages')}, union_by_name = true)`;
const T = `(SELECT domain, arg_max(techs, analyzed_at) AS techs, arg_max(names, analyzed_at) AS names FROM read_parquet(${datasetGlob('tech')}) GROUP BY domain)`;
const S = `(SELECT domain, arg_max(COLUMNS(* EXCLUDE (domain)), probed_at) FROM read_parquet(${datasetGlob('store_probe')}) GROUP BY domain)`;
const K = `(SELECT domain, arg_max(COLUMNS(* EXCLUDE (domain)), classified_at) FROM read_parquet(${datasetGlob('classified')}) GROUP BY domain)`;
const C = `(SELECT domain, arg_max(COLUMNS(* EXCLUDE (domain)), extracted_at) FROM read_parquet(${datasetGlob('contacts')}) GROUP BY domain)`;
const G = `(SELECT domain, arg_max(COLUMNS(* EXCLUDE (domain)), computed_at) FROM read_parquet(${datasetGlob('signals')}) GROUP BY domain)`;
const n = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
const show = async (title: string, sql: string) => {
  console.log(`\n## ${title}`);
  console.table(n(await lakeQuery(sql)));
};

await show('Phase 4 — technology detection coverage', `SELECT count(*) AS pages_analysed, round(avg(len(names)), 1) AS avg_techs_per_site FROM ${T}`);
await show('Top 25 technologies on live sites', `SELECT name, count(*) AS sites FROM (SELECT unnest(names) AS name FROM ${T}) GROUP BY 1 ORDER BY 2 DESC LIMIT 25`);
await show('Segmentation-relevant technologies (HTML-only detection)', `
  SELECT name, count(*) AS sites FROM (SELECT unnest(names) AS name FROM ${T})
  WHERE name IN ('Shopify','WooCommerce','WordPress','Elementor','Divi','Webflow','Wix','Squarespace','Klaviyo','MailChimp','Omnisend','Facebook Pixel',
                 'TikTok Pixel','Google Tag Manager','Google Analytics','Judge.me','Yotpo Reviews','Trustpilot','Calendly','Acuity Scheduling','MindBody',
                 'jQuery','Hotjar','Microsoft Clarity','HubSpot','Intercom','Tidio','Gorgias','Recharge','Afterpay','Klarna Checkout','Yoast SEO')
  GROUP BY 1 ORDER BY 2 DESC`);
await show('Example segment: Shopify stores without Klaviyo (from HTML)', `
  SELECT count(*) FILTER (WHERE list_contains(names, 'Shopify')) AS shopify, count(*) FILTER (WHERE list_contains(names, 'Shopify') AND NOT list_contains(names, 'Klaviyo')) AS shopify_no_klaviyo FROM ${T}`);
await show('Phase 4 — store probes', `
  SELECT platform, count(*) AS sites, count(*) FILTER (WHERE ok) AS answered, count(product_count) AS with_count, round(median(product_count)) AS median_products,
         round(median(price_median), 2) AS median_price, mode(currency) AS top_currency,
         count(*) FILTER (WHERE last_published_at >= now() - INTERVAL 30 DAY) AS published_last_30d
  FROM ${S} GROUP BY 1 ORDER BY 2 DESC`);
await show('Phase 5 — classified pages', `SELECT count(*) AS classified, count(*) FILTER (WHERE in_scope) AS in_scope, round(100.0 * count(*) FILTER (WHERE in_scope) / count(*), 1) AS pct_in_scope FROM ${K}`);
await show('Phase 5 — leads per niche (in scope)', `SELECT niche, sub_niche, count(*) AS leads, round(median(confidence), 2) AS median_confidence FROM ${K} WHERE in_scope GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
await show('Phase 5 — recognised but excluded (saturated / non-commercial)', `SELECT sub_niche, count(*) AS sites FROM ${K} WHERE niche = 'saturated' GROUP BY 1 ORDER BY 2 DESC`);
await show('Phase 6 — contact completeness per niche', `
  SELECT k.niche, count(*) AS leads, round(100.0 * count(c.email) / count(*), 1) AS pct_email, round(100.0 * count(*) FILTER (WHERE c.email_type = 'named') / count(*), 1) AS pct_named_email,
         round(100.0 * count(c.phone) / count(*), 1) AS pct_phone, round(100.0 * count(c.owner_name) / count(*), 1) AS pct_owner,
         round(100.0 * count(c.address) / count(*), 1) AS pct_address, round(100.0 * count(*) FILTER (WHERE c.socials <> '{}') / count(*), 1) AS pct_socials,
         round(avg(c.completeness), 2) AS avg_completeness
  FROM ${C} c JOIN ${K} k USING (domain) GROUP BY 1 ORDER BY 2 DESC`);
await show('Phase 6 — email types', `SELECT coalesce(email_type, '(none)') AS email_type, count(*) AS leads FROM ${C} GROUP BY 1 ORDER BY 2 DESC`);
await show('Phase 6 — country (with source)', `SELECT coalesce(country, '(unknown)') AS country, count(*) AS leads FROM ${G} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
await show('Phase 6 — how the country was found', `SELECT coalesce(country_source, '(not found)') AS source, count(*) AS leads FROM ${G} GROUP BY 1 ORDER BY 2 DESC`);
await show('Phase 6 — domain age (RDAP)', `
  SELECT CASE WHEN reg IS NULL THEN '(no RDAP)' WHEN reg >= current_date - INTERVAL 1 YEAR THEN '< 1 year' WHEN reg >= current_date - INTERVAL 3 YEAR THEN '1-3 years'
              WHEN reg >= current_date - INTERVAL 10 YEAR THEN '3-10 years' ELSE '10+ years' END age, count(*) AS leads
  FROM (SELECT TRY_CAST(json_extract_string(freshness, '$.domain_registered') AS DATE) AS reg FROM ${G}) GROUP BY 1 ORDER BY 2 DESC`);

if (out) {
  const rows = n(await lakeQuery(`
    SELECT k.niche, k.sub_niche, k.domain, p.title, k.confidence, k.reason
    FROM ${K} k JOIN (SELECT domain, arg_max(title, fetched_at) AS title FROM ${P} WHERE pass GROUP BY domain) p USING (domain)
    WHERE k.niche IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY k.sub_niche ORDER BY hash(k.domain)) <= 50
    ORDER BY k.niche, k.sub_niche, k.domain`));
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ')}"`;
  writeFileSync(out, ['niche,sub_niche,domain,title,confidence,reason', ...rows.map((r) => [r.niche, r.sub_niche, r.domain, r.title, r.confidence, r.reason].map(esc).join(','))].join('\n'));
  console.log(`\nwrote ${rows.length} sample rows to ${out}`);
}
await closeDb();
