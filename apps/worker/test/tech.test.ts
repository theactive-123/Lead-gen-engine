import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { TechEngine, resolveVersion, selectorToken } from '../src/stages/tech/engine.js';

const dir = new URL('./fixtures/pages/', import.meta.url);
const pages = Object.fromEntries(
  readdirSync(dir).map((f) => {
    const p = JSON.parse(gunzipSync(readFileSync(new URL(f, dir))).toString('utf8'));
    return [p.expected.platform, { url: p.final_url, html: p.html, headers: p.headers, cookies: p.cookies }];
  }),
);
const engine = new TechEngine();
const names = (platform: string) => engine.analyze(pages[platform]).map((d) => d.name);

describe('technology detection on real homepages (fixtures 2026-11-24)', () => {
  it('loads the whole vendored dataset', () => expect(engine.techs.length).toBeGreaterThan(7000));

  it('Shopify store: platform + Shop Pay, and no PHP/WordPress', () => {
    const n = names('Shopify');
    expect(n).toEqual(expect.arrayContaining(['Shopify', 'Shop Pay']));
    expect(n).not.toContain('PHP');
    expect(n).not.toContain('WordPress');
  });
  it('WooCommerce store: WooCommerce implies WordPress; versions are read', () => {
    const d = engine.analyze(pages.WooCommerce);
    const n = d.map((x) => x.name);
    expect(n).toEqual(expect.arrayContaining(['WooCommerce', 'WordPress', 'Yoast SEO', 'Google Tag Manager']));
    expect(d.find((x) => x.name === 'Yoast SEO')?.version).toMatch(/^\d+\.\d+/);
  });
  it('Webflow site: Klaviyo and jQuery with version', () => {
    const d = engine.analyze(pages.Webflow);
    expect(d.map((x) => x.name)).toEqual(expect.arrayContaining(['Webflow', 'Klaviyo', 'jQuery']));
    expect(d.find((x) => x.name === 'jQuery')?.version).toBe('3.5.1');
  });
  it.each(['Shopify', 'Squarespace', 'Wix', 'Webflow'])('%s page: no false PHP / Qwik / SummerCart / Tailwind (regression)', (pf) => {
    const n = names(pf);
    for (const bad of ['PHP', 'Qwik', 'SummerCart']) expect(n).not.toContain(bad);
  });
  it('every detection has categories', () => {
    for (const p of Object.values(pages)) for (const d of engine.analyze(p)) expect(d.categories.length).toBeGreaterThan(0);
  });
});

describe('engine helpers', () => {
  it('versions: group reference and ternary', () => {
    const m = /v(\d+)\.(\d+)(-beta)?/.exec('v3.5')!;
    expect(resolveVersion('\\1.\\2', m)).toBe('3.5');
    expect(resolveVersion('\\3?beta:stable', m)).toBe('stable');
  });
  it('selector pre-check token never comes from generic words', () => {
    expect(selectorToken("link[rel='stylesheet'][href*='tailwind']")).toBe('tailwind');
    expect(selectorToken('link')).toBeNull();
  });
});

describe('worker-thread pool gives identical results', () => {
  let pool: import('../src/stages/tech/pool.js').TechPool | undefined;
  afterAll(async () => pool?.close());
  it('matches the single-thread engine on every fixture', async () => {
    const { TechPool } = await import('../src/stages/tech/pool.js');
    pool = new TechPool(2);
    for (const p of Object.values(pages)) expect(await pool.analyze(p)).toEqual(engine.analyze(p));
  }, 60_000);
});

describe('local fingerprint overrides (packages/fingerprints/overrides.json)', () => {
  const names = (src: string) => engine.analyze({ url: 'https://x.com/', html: `<script src="${src}"></script>`, headers: {}, cookies: [] }).map((t) => t.name);
  it('cookie-consent scripts are not Onsen UI (real URLs seen on lead sites, 2026-11-25)', () => {
    expect(names('https://cdnjs.cloudflare.com/ajax/libs/cookieconsent2/3.1.0/cookieconsent.min.js')).not.toContain('Onsen UI');
    expect(names('https://static.parastorage.com/services/site-consent-policy/1.10.0/site-consent-policy.umd.min.js')).not.toContain('Onsen UI');
  });
  it('real Onsen UI files are still detected', () => {
    expect(names('https://unpkg.com/onsenui/js/onsenui.min.js')).toContain('Onsen UI');
    expect(names('/lib/angular-onsenui.min.js')).toContain('Onsen UI');
  });
});
