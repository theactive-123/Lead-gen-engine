import { datasetExists, datasetGlob, db, env, htmlFor, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { CrawlClient, HostLimiter, makeDispatcher, type FetchResult } from '../fetch/client.js';
import { RobotsCache } from '../fetch/robots.js';
import { errorKind } from '../fetch/stage.js';
import { currentSql, loadBatch, type StagePlan } from '../plan.js';
import { applyShopifyMeta, applyShopifyProducts, applyWooProducts, detectTheme, emptySummary, parseWpIndex } from './parse.js';

/**
 * Stage 5 — platform deep probe on live Shopify / WooCommerce / WordPress sites (public endpoints only,
 * same robots.txt + 1 request/second/site rules as the homepage fetch). Max 2 requests per site.
 */
export const PROBE_PLATFORMS = ['Shopify', 'WooCommerce', 'WordPress'];

export const probePlan: StagePlan = {
  key: 'probe',
  defaults: { batch: 200, snapshot: 2000 },
  async todoSql() {
    if (!(await datasetExists('pages'))) return null;
    const done = (await datasetExists('store_probe')) ? `AND domain NOT IN (${currentSql({ dataset: 'store_probe', ts: 'probed_at' }, [{ dataset: 'pages', ts: 'fetched_at', where: 'pass' }])})` : '';
    return `
      SELECT domain, max(priority) AS priority, arg_max(platform, fetched_at) AS platform,
             arg_max(final_url, fetched_at) AS final_url, arg_max(style_href, fetched_at) AS style_href
      FROM read_parquet(${datasetGlob('pages')}, union_by_name = true)
      WHERE pass AND platform IN (${PROBE_PLATFORMS.map(sqlLiteral).join(', ')}) ${done}
      GROUP BY domain`;
  },
};

interface Row { domain: string; priority: number; platform: string; final_url: string; style_href: string[] | null }

export async function runProbeBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Row>('probe', snapshot, batch);
  const perHostRps = await setting<number>('http.per_host_rps', 1);
  const client = new CrawlClient(makeDispatcher(), new HostLimiter(Math.ceil(1000 / perHostRps)), {
    timeoutMs: await setting<number>('http.timeout_ms', 10_000),
    maxBytes: await setting<number>('fetch.max_body_bytes', 2_000_000),
    maxRedirects: 2,
  });
  const robots = new RobotsCache(client, env().CRAWLER_NAME);
  const concurrency = Math.min(await setting<number>('http.global_concurrency', 200), rows.length || 1);

  // Stored homepage HTML (if still kept) is only used to read the Shopify theme name.
  const htmlByDomain = new Map<string, string>();
  for (const h of await htmlFor(rows.filter((r) => r.platform === 'Shopify').map((r) => r.domain))) htmlByDomain.set(h.domain, h.html);

  return withRun('stage.probe', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = [];

    /** Polite JSON GET: robots.txt first; never follows a redirect to another site. */
    const getJson = async (url: string): Promise<{ status: string; res?: FetchResult; body?: any }> => {
      try {
        const r = await robots.check(url);
        // Two different "no"s: the rules forbid it, or robots.txt could not be read (cautious default).
        if (!r.allowed) return { status: r.reason === 'rules' ? 'robots_disallowed' : 'robots_unavailable' };
        const origin = new URL(url).origin;
        const res = await client.get(url, 'json', async (next) => new URL(next).origin === origin);
        if (res.status !== 200) return { status: `http_${res.status}`, res };
        try {
          return { status: 'ok', res, body: JSON.parse(res.body.toString('utf8')) };
        } catch {
          return { status: res.truncated ? 'too_large' : 'not_json', res };
        }
      } catch (err) {
        return { status: errorKind(err) };
      }
    };

    const one = async (row: Row) => {
      const origin = new URL(row.final_url).origin;
      const s = emptySummary();
      const rec: Record<string, unknown> = { domain: row.domain, platform: row.platform, probed_at: new Date().toISOString() };
      const calls: string[] = [];
      if (row.platform === 'Shopify') {
        const meta = await getJson(`${origin}/meta.json`);
        calls.push(`meta:${meta.status}`);
        if (meta.body) applyShopifyMeta(s, meta.body);
        let prods = await getJson(`${origin}/products.json?limit=30`);
        calls.push(`products:${prods.status}`);
        if (prods.status === 'too_large') {
          // Long product descriptions can push 30 products past the size cap (seen: 2.29 MB): ask for 10.
          prods = await getJson(`${origin}/products.json?limit=10`);
          calls.push(`products10:${prods.status}`);
        }
        if (prods.body) applyShopifyProducts(s, prods.body);
      } else {
        if (row.platform === 'WooCommerce') {
          const prods = await getJson(`${origin}/wp-json/wc/store/v1/products?per_page=30&orderby=date&order=desc`);
          calls.push(`store_api:${prods.status}`);
          const total = prods.res?.headers['x-wp-total']; // undici lowercases header names
          if (prods.body) applyWooProducts(s, prods.body, total);
        }
        const idx = await getJson(`${origin}/wp-json/?_fields=name,description,namespaces`);
        calls.push(`wp_index:${idx.status}`);
        if (idx.body) Object.assign(rec, parseWpIndex(idx.body));
      }
      Object.assign(rec, s, {
        theme: detectTheme(htmlByDomain.get(row.domain) ?? null, row.style_href ?? []),
        calls,
        ok: calls.some((c) => c.endsWith(':ok')),
      });
      out.push(rec);
    };

    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < rows.length) await one(rows[next++]!);
      }),
    );

    await writeParquet('store_probe', out, {
      name: `probe-${snapshot}-${batch}`,
      columns: {
        domain: 'VARCHAR', platform: 'VARCHAR', probed_at: 'TIMESTAMP', ok: 'BOOLEAN', calls: 'VARCHAR[]',
        product_count: 'INTEGER', count_method: 'VARCHAR', price_min: 'DOUBLE', price_max: 'DOUBLE', price_median: 'DOUBLE',
        price_sample: 'INTEGER', currency: 'VARCHAR', newest_created_at: 'TIMESTAMP', last_published_at: 'TIMESTAMP',
        vendors: 'VARCHAR[]', product_types: 'VARCHAR[]', sample_titles: 'VARCHAR[]', collections_count: 'INTEGER',
        shop_name: 'VARCHAR', country: 'VARCHAR', province: 'VARCHAR', city: 'VARCHAR', theme: 'VARCHAR',
        wp_name: 'VARCHAR', wp_description: 'VARCHAR', wp_namespaces: 'VARCHAR[]',
      },
    });

    // Postgres store_profiles for stores that answered (WordPress-only sites have no catalogue).
    const stores = out.filter((o) => o.ok && o.platform !== 'WordPress');
    if (stores.length) {
      const col = (f: (o: Record<string, any>) => unknown) => stores.map(f);
      const arr = (v: unknown) => ((v as string[] | undefined) ?? []).join('\u001f');
      await db().query(
        `INSERT INTO store_profiles (domain_id, platform, product_count, count_method, price_min, price_max, price_median, currency,
           last_product_update, newest_product_at, vendors, product_types, sample_titles, collections_count, theme, extra, probed_at)
         SELECT d.id, x.platform, x.pc, x.cm, x.pmin, x.pmax, x.pmed, x.cur, x.lpu, x.npa,
                string_to_array(x.vendors, chr(31)), string_to_array(x.types, chr(31)), string_to_array(x.titles, chr(31)),
                x.cc, x.theme, x.extra::jsonb, now()
         FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[],
                     $9::timestamptz[], $10::timestamptz[], $11::text[], $12::text[], $13::text[], $14::int[], $15::text[], $16::text[])
           AS x(domain, platform, pc, cm, pmin, pmax, pmed, cur, lpu, npa, vendors, types, titles, cc, theme, extra)
         JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id) DO UPDATE SET platform = EXCLUDED.platform, product_count = EXCLUDED.product_count,
           count_method = EXCLUDED.count_method, price_min = EXCLUDED.price_min, price_max = EXCLUDED.price_max,
           price_median = EXCLUDED.price_median, currency = EXCLUDED.currency, last_product_update = EXCLUDED.last_product_update,
           newest_product_at = EXCLUDED.newest_product_at, vendors = EXCLUDED.vendors, product_types = EXCLUDED.product_types,
           sample_titles = EXCLUDED.sample_titles, collections_count = EXCLUDED.collections_count, theme = EXCLUDED.theme,
           extra = EXCLUDED.extra, probed_at = now()`,
        [
          col((o) => o.domain), col((o) => o.platform), col((o) => o.product_count), col((o) => o.count_method),
          col((o) => o.price_min), col((o) => o.price_max), col((o) => o.price_median), col((o) => o.currency),
          col((o) => o.last_published_at), col((o) => o.newest_created_at), col((o) => arr(o.vendors)), col((o) => arr(o.product_types)),
          col((o) => arr(o.sample_titles)), col((o) => o.collections_count), col((o) => o.theme),
          col((o) => JSON.stringify({ price_sample: o.price_sample, shop_name: o.shop_name, country: o.country, province: o.province, city: o.city })),
        ],
      );
    }
    run.inCount = rows.length;
    run.outCount = out.filter((o) => o.ok).length;
    for (const o of out) if (!o.ok) run.drop(String((o.calls as string[])[0] ?? 'no_call').split(':')[1] ?? 'failed');
    return { sites: rows.length, answered: run.outCount, stores: stores.length };
  });
}
