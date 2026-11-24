import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyShopifyMeta, applyShopifyProducts, applyWooProducts, detectTheme, emptySummary, parseWpIndex } from '../src/stages/probe/parse.js';

const fx = (f: string) => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/stores/${f}`, import.meta.url))).toString('utf8'));

// Values cross-checked by hand against the live stores on 2026-11-24.
describe('Shopify endpoints (10-4coffee.com)', () => {
  it('meta.json gives the exact catalogue size and location', () => {
    const s = emptySummary();
    applyShopifyMeta(s, fx('shopify-meta-10-4coffee.json.gz'));
    expect(s).toMatchObject({ product_count: 91, count_method: 'reported', currency: 'USD', country: 'US' });
  });
  it('products.json gives the entry-price level and activity dates (not updated_at)', () => {
    const s = emptySummary();
    applyShopifyMeta(s, fx('shopify-meta-10-4coffee.json.gz'));
    applyShopifyProducts(s, fx('shopify-products-10-4coffee.json.gz'));
    expect(s.price_min).toBe(13.23);
    expect(s.price_median).toBe(23.99);
    expect(s.price_sample).toBe(30);
    expect(s.last_published_at?.slice(0, 10)).toBe('2026-06-09');
    expect(s.product_count).toBe(91); // the reported count is not overwritten by the sample size
    expect(s.sample_titles).toHaveLength(30);
  });
});

describe('WooCommerce Store API (1000remedies.com)', () => {
  it('reads the total header and converts minor-unit prices', () => {
    const s = emptySummary();
    applyWooProducts(s, fx('woo-products-1000remedies.json.gz'), '18');
    expect(s).toMatchObject({ product_count: 18, count_method: 'reported', currency: 'USD', price_min: 20, price_median: 45 });
  });
});

describe('WordPress index (1010artistry.com, _fields)', () => {
  it('lists REST namespaces (installed plugins)', () => {
    const w = parseWpIndex(fx('wp-index-1010artistry.json.gz'));
    expect(w.wp_namespaces).toContain('rankmath/v1');
    expect(w.wp_name).toBeTruthy();
  });
});

describe('theme detection', () => {
  it('reads the Shopify theme object and WordPress theme folder', () => {
    expect(detectTheme('<script>Shopify.theme = {"name":"My copy","id":1,"schema_name":"Dawn","schema_version":"15.0.0"};</script>', [])).toBe('Dawn');
    expect(detectTheme(null, ['https://x.com/wp-content/themes/astra/style.css?ver=4'])).toBe('astra');
    expect(detectTheme(null, [])).toBeNull();
  });
});
