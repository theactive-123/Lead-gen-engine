import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../src/stages/fetch/extract.js';
import { detectPlatforms, parsePattern, primaryPlatform } from '../src/stages/fetch/platform.js';
import { tagPage, type TagRule } from '../src/stages/fetch/tags.js';

const dir = new URL('./fixtures/pages/', import.meta.url);
const pages = readdirSync(dir).map((f) => JSON.parse(gunzipSync(readFileSync(new URL(f, dir))).toString('utf8')));

describe('homepage extraction + platform detection (real pages fetched 2026-11-24)', () => {
  it('has fixtures', () => expect(pages.length).toBeGreaterThanOrEqual(4));

  it.each(pages.map((p) => [p.expected.platform, p]))('%s page: platform, title and copyright year', (_name, p) => {
    let found: ReturnType<typeof detectPlatforms> = [];
    const cookieNames = (p.cookies as string[]).map((c) => c.split('=')[0]!.trim().toLowerCase());
    const f = extractFeatures(p.html, p.final_url, ($, ev) => {
      found = detectPlatforms({ url: p.final_url, html: p.html, $, scriptSrc: ev.scriptSrc, meta: ev.meta, headers: p.headers, cookieNames });
    });
    expect(primaryPlatform(found)).toBe(p.expected.platform);
    expect(f.title).toBe(p.expected.title);
    expect(f.copyright_year).toBe(p.expected.copyright_year);
    expect(f.h1).toBe(p.expected.h1);
    expect(f.text_sample.length).toBeGreaterThan(200);
    expect(f.links_internal.length).toBeGreaterThan(0);
  });
});

describe('fingerprint pattern syntax', () => {
  it('reads confidence and ignores version tags', () => {
    const p = parsePattern('(?:cdn\\.|\\.my)shopify\\.com\;confidence:50')!;
    expect(p.confidence).toBe(50);
    expect(p.re.test('https://cdn.shopify.com/s/files/x.js')).toBe(true);
    expect(parsePattern('WooCommerce ([\\d.]+)\;version:\\1')!.confidence).toBe(100);
  });
});

describe('page tags', () => {
  const rule = (tag: string, field: TagRule['field'], re: RegExp, maxWords: number | null = null): TagRule => ({ tag, field, re, drops: true, maxWords });
  const rules = [rule('coming_soon', 'any', /\bcoming soon\b/i, 150), rule('coming_soon', 'title', /\bcoming soon\b/i)];

  it('tags a short placeholder page', () => {
    expect(tagPage(rules, { title: 'Acme', text: 'Acme is coming soon. Sign up.', url: 'https://acme.com/', words: 6 }).tags).toEqual(['coming_soon']);
  });
  it('ignores "coming soon" as a menu label on a real, long page (seen on live shops)', () => {
    expect(tagPage(rules, { title: '0530 Supply Co', text: 'Shop All Coming Soon ...', url: 'https://x.com/', words: 900 }).tags).toEqual([]);
  });
  it('still tags when the title says so, whatever the length', () => {
    expect(tagPage(rules, { title: 'Coming Soon | Acme', text: 'x', url: 'https://acme.com/', words: 900 }).drops).toBe(true);
  });
});
