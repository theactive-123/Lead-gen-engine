import { existsSync } from 'node:fs';
import { datasetExists, datasetGlob, db, lakeQuery, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { REGISTRY_FILE } from '../normalize.js';
import { HostLimiter } from '../fetch/client.js';
import { currentSql, loadBatch, type StagePlan } from '../plan.js';
import { cleanCompanyName, computeSignals } from './compute.js';
import { registrationDate } from './rdap.js';

/** Stage 8 — business signals into Postgres `companies` (runs after contacts). */
export const signalsPlan: StagePlan = {
  key: 'signals',
  defaults: { batch: 500, snapshot: 5000 },
  async todoSql() {
    if (!(await datasetExists('contacts')) || !existsSync(REGISTRY_FILE())) return null;
    const done = (await datasetExists('signals')) ? `AND c.domain NOT IN (${currentSql({ dataset: 'signals', ts: 'computed_at' }, [{ dataset: 'contacts', ts: 'extracted_at' }])})` : '';
    const probe = (await datasetExists('store_probe'))
      ? `LEFT JOIN (SELECT domain, arg_max(product_count, probed_at) product_count, arg_max(last_published_at, probed_at) last_pub,
                          arg_max(newest_created_at, probed_at) newest_created, arg_max(country, probed_at) store_country,
                          arg_max(province, probed_at) store_province, arg_max(city, probed_at) store_city, arg_max(currency, probed_at) currency,
                          arg_max(shop_name, probed_at) shop_name FROM read_parquet(${datasetGlob('store_probe')}) GROUP BY domain) s USING (domain)`
      : `LEFT JOIN (SELECT NULL::VARCHAR domain, NULL::INT product_count, NULL::TIMESTAMP last_pub, NULL::TIMESTAMP newest_created, NULL::VARCHAR store_country,
                          NULL::VARCHAR store_province, NULL::VARCHAR store_city, NULL::VARCHAR currency, NULL::VARCHAR shop_name) s USING (domain)`;
    return `
      -- Every other input is read only for the domains that have contacts (memory stays small at millions of domains).
      WITH c AS (SELECT domain, arg_max(COLUMNS(* EXCLUDE (domain)), extracted_at) FROM read_parquet(${datasetGlob('contacts')}) GROUP BY domain),
           p AS (SELECT domain, max(priority) priority, arg_max(links_internal, fetched_at) links_internal, arg_max(copyright_year, fetched_at) copyright_year,
                        arg_max(site_name, fetched_at) site_name, arg_max(title, fetched_at) title, arg_max(platform, fetched_at) platform
                 FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass AND domain IN (SELECT domain FROM c) GROUP BY domain),
           t AS (SELECT domain, arg_max(techs, analyzed_at) techs FROM read_parquet(${datasetGlob('tech')}) WHERE domain IN (SELECT domain FROM c) GROUP BY domain),
           d AS (SELECT domain, arg_max(mx, resolved_at) mx FROM read_parquet(${datasetGlob('dns')}) WHERE domain IN (SELECT domain FROM c) GROUP BY domain),
           r AS (SELECT domain, tranco_rank, cc_pages, first_seen, ct_first_cert, registered FROM read_parquet(${sqlLiteral(REGISTRY_FILE())}) WHERE domain IN (SELECT domain FROM c))
      SELECT c.domain, p.priority, p.links_internal, p.copyright_year, p.site_name, p.title, p.platform, t.techs, d.mx,
             r.tranco_rank, r.cc_pages, r.first_seen, r.ct_first_cert, r.registered,
             c.sitemap_count, c.sitemap_kind, c.address, c.phone, c.org_name,
             s.product_count, s.last_pub, s.newest_created, s.store_country, s.store_province, s.store_city, s.currency, s.shop_name
      FROM c JOIN p USING (domain) LEFT JOIN t USING (domain) LEFT JOIN d USING (domain) LEFT JOIN r USING (domain) ${probe}
      WHERE true ${done}`;
  },
};

const iso = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : null);

export async function runSignalsBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Record<string, any>>('signals', snapshot, batch);
  const rps = await setting<number>('rdap.per_registry_rps', 4);
  const limiter = new HostLimiter(Math.ceil(1000 / rps));
  const { loadSignatures, matchSignatures } = await import('../dns/stage.js');
  const sigs = await loadSignatures();

  return withRun('stage.signals', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, rows.length || 1) }, async () => {
      while (next < rows.length) {
        const r = rows[next++]!;
        const registered = await registrationDate(r.domain, limiter);
        const mx: string[] = r.mx ?? [];
        const mxProvider = mx.length ? (matchSignatures({ domain: r.domain, a: [], www_cname: [], www_a: [], mx, ns: [] }, sigs).mx_provider ?? 'other') : null;
        const s = computeSignals({
          domain: r.domain, techs: JSON.parse(r.techs ?? '[]'), tranco_rank: r.tranco_rank, cc_pages: r.cc_pages,
          sitemap_count: r.sitemap_count, sitemap_kind: r.sitemap_kind, product_count: r.product_count, mx_provider: mxProvider,
          links_internal: r.links_internal ?? [], first_seen: iso(r.first_seen), ct_first_cert: iso(r.ct_first_cert), registered_nrd: r.registered ?? null,
          domain_registered: registered, copyright_year: r.copyright_year, last_product_published: iso(r.last_pub),
          newest_product_created: iso(r.newest_created), address: r.address ? JSON.parse(r.address) : null, store_country: r.store_country,
          store_province: r.store_province, store_city: r.store_city, phone: r.phone, currency: r.currency,
        });
        const name = [r.org_name, r.shop_name, r.site_name, r.title].map((n) => cleanCompanyName(n, r.domain)).find(Boolean) ?? null;
        out.push({ domain: r.domain, computed_at: new Date().toISOString(), name, platform: r.platform, ...s,
          size_signals: JSON.stringify(s.size_signals), freshness: JSON.stringify(s.freshness), marketing: JSON.stringify(s.marketing) });
      }
    }));
    await writeParquet('signals', out, {
      name: `signals-${snapshot}-${batch}`,
      columns: { domain: 'VARCHAR', computed_at: 'TIMESTAMP', name: 'VARCHAR', platform: 'VARCHAR', country: 'VARCHAR', country_source: 'VARCHAR',
        region: 'VARCHAR', city: 'VARCHAR', address: 'VARCHAR', size_signals: 'VARCHAR', freshness: 'VARCHAR', marketing: 'VARCHAR', currency: 'VARCHAR' },
    });
    const col = (f: (o: Record<string, any>) => unknown) => out.map(f);
    await db().query(
      `INSERT INTO companies (domain_id, name, country, country_source, region, city, address, platform, size_signals, freshness, marketing, updated_at)
       SELECT d.id, x.n, x.c, x.cs, x.r, x.ci, x.a, x.p, x.ss::jsonb, x.f::jsonb, x.m::jsonb, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
         AS x(domain, n, c, cs, r, ci, a, p, ss, f, m)
       JOIN domains d ON d.domain = x.domain
       ON CONFLICT (domain_id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country, country_source = EXCLUDED.country_source,
         region = EXCLUDED.region, city = EXCLUDED.city, address = EXCLUDED.address, platform = EXCLUDED.platform,
         size_signals = EXCLUDED.size_signals, freshness = EXCLUDED.freshness, marketing = EXCLUDED.marketing, updated_at = now()`,
      [col((o) => o.domain), col((o) => o.name), col((o) => o.country), col((o) => o.country_source), col((o) => o.region), col((o) => o.city),
       col((o) => o.address), col((o) => o.platform), col((o) => o.size_signals), col((o) => o.freshness), col((o) => o.marketing)],
    );
    run.inCount = rows.length;
    run.outCount = out.length;
    return { leads: out.length, with_country: out.filter((o) => o.country).length };
  });
}
