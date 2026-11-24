/**
 * Parsers for public store endpoints (verified live 2026-11-24 on real stores from our data):
 *  - Shopify  /meta.json                 -> exact product count, currency, location, collections
 *  - Shopify  /products.json?limit=30    -> newest-published products (sorted by published_at desc)
 *  - Woo      /wp-json/wc/store/v1/products -> products (prices in minor units) + X-WP-Total header
 *  - WordPress /wp-json/?_fields=name,description,namespaces -> site name + REST namespaces (plugins)
 */
export interface StoreSummary {
  product_count: number | null;
  count_method: 'reported' | 'counted' | null;
  price_min: number | null;
  price_max: number | null;
  price_median: number | null;
  price_sample: number;
  currency: string | null;
  newest_created_at: string | null;
  last_published_at: string | null;
  vendors: string[];
  product_types: string[];
  sample_titles: string[];
  collections_count: number | null;
  shop_name: string | null;
  country: string | null;
  province: string | null;
  city: string | null;
}

export const emptySummary = (): StoreSummary => ({
  product_count: null, count_method: null, price_min: null, price_max: null, price_median: null, price_sample: 0,
  currency: null, newest_created_at: null, last_published_at: null, vendors: [], product_types: [], sample_titles: [],
  collections_count: null, shop_name: null, country: null, province: null, city: null,
});

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const top = (xs: string[], n: number) => {
  const c = new Map<string, number>();
  for (const x of xs.map((v) => v.trim()).filter(Boolean)) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
};
const decode = (s: string) => s.replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’');

export function applyShopifyMeta(out: StoreSummary, meta: any): void {
  if (!meta || typeof meta !== 'object') return;
  if (Number.isFinite(meta.published_products_count)) {
    out.product_count = Number(meta.published_products_count);
    out.count_method = 'reported';
  }
  if (Number.isFinite(meta.published_collections_count)) out.collections_count = Number(meta.published_collections_count);
  out.currency = typeof meta.currency === 'string' ? meta.currency : out.currency;
  out.shop_name = typeof meta.name === 'string' ? meta.name.slice(0, 200) : null;
  out.country = typeof meta.country === 'string' ? meta.country : null;
  out.province = typeof meta.province === 'string' ? meta.province : null;
  out.city = typeof meta.city === 'string' ? meta.city : null;
}

export function applyShopifyProducts(out: StoreSummary, body: any): void {
  const products: any[] = Array.isArray(body?.products) ? body.products : [];
  const prices: number[] = [];
  for (const p of products) {
    const vp = (Array.isArray(p.variants) ? p.variants : []).map((v: any) => Number(v.price)).filter((n: number) => Number.isFinite(n) && n > 0);
    if (vp.length) prices.push(Math.min(...vp)); // a product's entry price
  }
  setPrices(out, prices);
  const created = products.map((p) => p.created_at).filter((d) => typeof d === 'string').sort();
  const published = products.map((p) => p.published_at).filter((d) => typeof d === 'string').sort();
  out.newest_created_at = created.at(-1) ?? null;
  out.last_published_at = published.at(-1) ?? null; // note: updated_at is NOT used (it changes with stock levels)
  out.vendors = top(products.map((p) => String(p.vendor ?? '')), 10);
  out.product_types = top(products.map((p) => String(p.product_type ?? '')), 10);
  out.sample_titles = products.map((p) => String(p.title ?? '').slice(0, 120)).filter(Boolean).slice(0, 30);
  if (out.product_count === null && products.length > 0 && products.length < 10) {
    out.product_count = products.length; // the whole catalogue fitted in one page
    out.count_method = 'counted';
  }
}

export function applyWooProducts(out: StoreSummary, body: any, totalHeader: string | undefined): void {
  const products: any[] = Array.isArray(body) ? body : [];
  const total = Number(totalHeader);
  if (totalHeader !== undefined && Number.isFinite(total)) {
    out.product_count = total;
    out.count_method = 'reported';
  } else if (products.length < 30) {
    out.product_count = products.length;
    out.count_method = 'counted';
  }
  const prices: number[] = [];
  for (const p of products) {
    const pr = p?.prices;
    if (!pr) continue;
    const unit = 10 ** Number(pr.currency_minor_unit ?? 2);
    const raw = Number(pr.price_range?.min_amount ?? pr.price); // prices are integers in minor units (cents)
    if (Number.isFinite(raw) && raw > 0) prices.push(raw / unit);
    if (!out.currency && typeof pr.currency_code === 'string') out.currency = pr.currency_code;
  }
  setPrices(out, prices);
  out.product_types = top(products.flatMap((p) => (Array.isArray(p.categories) ? p.categories.map((c: any) => decode(String(c.name ?? ''))) : [])), 10);
  out.vendors = top(products.flatMap((p) => (Array.isArray(p.brands) ? p.brands.map((b: any) => decode(String(b.name ?? ''))) : [])), 10);
  out.sample_titles = products.map((p) => decode(String(p.name ?? '')).slice(0, 120)).filter(Boolean).slice(0, 30);
}

function setPrices(out: StoreSummary, prices: number[]) {
  out.price_sample = prices.length;
  if (!prices.length) return;
  out.price_min = Math.min(...prices);
  out.price_max = Math.max(...prices);
  out.price_median = median(prices);
}

export function parseWpIndex(body: any): { wp_name: string | null; wp_description: string | null; wp_namespaces: string[] } {
  const ns: string[] = Array.isArray(body?.namespaces) ? body.namespaces.map(String) : [];
  return {
    wp_name: typeof body?.name === 'string' ? decode(body.name).slice(0, 200) : null,
    wp_description: typeof body?.description === 'string' ? decode(body.description).slice(0, 300) : null,
    wp_namespaces: ns.slice(0, 100),
  };
}

/** Theme from the stored homepage: Shopify's `Shopify.theme = {...}` script or a /wp-content/themes/<name>/ path. */
export function detectTheme(html: string | null, styleHrefs: string[]): string | null {
  if (html) {
    const m = /Shopify\.theme\s*=\s*(\{[^;]{0,2000}?\})\s*;/.exec(html);
    if (m) {
      try {
        const t = JSON.parse(m[1]!);
        return String(t.schema_name ?? t.name ?? '').slice(0, 80) || null;
      } catch {
        /* not valid JSON: ignore */
      }
    }
  }
  for (const h of styleHrefs) {
    const w = /\/wp-content\/themes\/([^/?#]+)\//.exec(h);
    if (w) return decodeURIComponent(w[1]!).slice(0, 80);
  }
  return null;
}
