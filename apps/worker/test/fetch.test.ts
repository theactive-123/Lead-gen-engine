import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../src/stages/fetch/extract.js';
import { TAG_SEP, detectPlatforms, parsePattern, primaryPlatform } from '../src/stages/fetch/platform.js';
import { tagPage, type TagRule } from '../src/stages/fetch/tags.js';
import { errorKind } from '../src/stages/fetch/stage.js';

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

describe('fingerprint pattern syntax (patterns read from the vendored data, not retyped)', () => {
  const data = JSON.parse(readFileSync(new URL('../../../packages/fingerprints/technologies/s.json', import.meta.url), 'utf8'));
  it('separates the regex from its confidence tag (Shopify link pattern, confidence 50)', () => {
    const raw: string = data.Shopify.dom["link[href*='shopify.com']"].attributes.href;
    expect(raw.includes(TAG_SEP)).toBe(true);
    const p = parsePattern(raw)!;
    expect(p.confidence).toBe(50);
    expect(p.re.test('https://cdn.shopify.com/s/files/x.css')).toBe(true);
    expect(p.re.source.endsWith(String.fromCharCode(92))).toBe(false);
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

describe('errorKind', () => {
  it('recognises timeouts even when the error code is numeric (DOMException)', () => {
    const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(errorKind(e)).toBe('timeout');
  });
  it('classifies TLS and connection errors', () => {
    expect(errorKind(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe('tls_error');
    expect(errorKind(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))).toBe('connection_error');
  });
});
