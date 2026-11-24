import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CheerioAPI } from 'cheerio';

/**
 * Website-platform detection from the vendored open fingerprints (enthec/webappanalyzer, GPL-3.0).
 * Phase 3 only evaluates the site-builder / ecommerce platforms below; Phase 4 runs the full set.
 * Supported pattern types: scriptSrc, meta, headers, cookies, html, dom, url. (JS-variable checks
 * need a browser and are skipped.)
 */
export const PLATFORMS = [
  'Shopify', 'WooCommerce', 'BigCommerce', 'Magento', 'PrestaShop', 'Squarespace', 'Wix', 'Webflow',
  'Framer Sites', 'Duda', 'Weebly', 'GoDaddy Website Builder', 'Ghost', 'Drupal', 'Joomla', 'WordPress',
] as const;

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/fingerprints/technologies');

interface Pattern { re: RegExp; confidence: number }
interface Tech {
  name: string;
  scriptSrc: Pattern[];
  html: Pattern[];
  url: Pattern[];
  meta: Record<string, Pattern[]>;
  headers: Record<string, Pattern[]>;
  cookies: Record<string, Pattern[]>;
  dom: { selector: string; attr?: [string, Pattern]; text?: Pattern }[];
}

/** "regex\;confidence:50\;version:\1" -> { re, confidence } */
export function parsePattern(p: string): Pattern | null {
  const [src, ...tags] = p.split('\;');
  let confidence = 100;
  for (const t of tags) if (t.startsWith('confidence:')) confidence = Number(t.slice(11)) || 0;
  try {
    return { re: new RegExp(src ?? '', 'i'), confidence };
  } catch {
    return null;
  }
}
const arr = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const pats = (v: unknown) => arr(v).map(parsePattern).filter((x): x is Pattern => !!x);
const dict = (v: unknown) =>
  Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), pats(x)]));

let techs: Tech[] | undefined;
export function loadPlatformTechs(names: readonly string[] = PLATFORMS): Tech[] {
  if (techs) return techs;
  const all: Record<string, any> = {};
  for (const f of readdirSync(DIR)) if (f.endsWith('.json')) Object.assign(all, JSON.parse(readFileSync(path.join(DIR, f), 'utf8')));
  techs = names.map((name) => {
    const t = all[name];
    if (!t) throw new Error(`fingerprint "${name}" not found in vendored data`);
    const dom: Tech['dom'] = [];
    if (typeof t.dom === 'string' || Array.isArray(t.dom)) for (const s of arr(t.dom)) dom.push({ selector: s });
    else if (t.dom && typeof t.dom === 'object')
      for (const [selector, spec] of Object.entries(t.dom as Record<string, any>)) {
        const attr = spec?.attributes ? Object.entries(spec.attributes)[0] : undefined;
        const ap = attr ? parsePattern(String(attr[1])) : null;
        const tp = spec?.text !== undefined ? parsePattern(String(spec.text)) : null;
        dom.push({ selector, attr: attr && ap ? [attr[0], ap] : undefined, text: tp ?? undefined });
      }
    return { name, scriptSrc: pats(t.scriptSrc), html: pats(t.html), url: pats(t.url), meta: dict(t.meta), headers: dict(t.headers), cookies: dict(t.cookies), dom };
  });
  return techs;
}

export interface PageEvidence {
  url: string;
  html: string;
  scriptSrc: string[];
  meta: Record<string, string>;
  headers: Record<string, string>;
  cookieNames: string[];
  $: CheerioAPI;
}

/** All matching platforms with confidence (0-100), best first. */
export function detectPlatforms(e: PageEvidence): { name: string; confidence: number; via: string }[] {
  const out: { name: string; confidence: number; via: string }[] = [];
  const htmlHead = e.html.slice(0, 300_000);
  for (const t of loadPlatformTechs()) {
    let conf = 0;
    const via: string[] = [];
    const hit = (c: number, what: string) => {
      conf += c;
      via.push(what);
    };
    for (const p of t.scriptSrc) if (e.scriptSrc.some((s) => p.re.test(s))) hit(p.confidence, 'scriptSrc');
    for (const p of t.html) if (p.re.test(htmlHead)) hit(p.confidence, 'html');
    for (const p of t.url) if (p.re.test(e.url)) hit(p.confidence, 'url');
    for (const [k, ps] of Object.entries(t.meta)) if (e.meta[k] !== undefined) for (const p of ps) if (p.re.test(e.meta[k]!)) hit(p.confidence, `meta:${k}`);
    for (const [k, ps] of Object.entries(t.headers)) if (e.headers[k] !== undefined) for (const p of ps) if (p.re.test(e.headers[k]!)) hit(p.confidence, `header:${k}`);
    for (const k of Object.keys(t.cookies)) if (e.cookieNames.includes(k)) hit(100, `cookie:${k}`);
    for (const d of t.dom) {
      let els;
      try {
        els = e.$(d.selector);
      } catch {
        continue;
      }
      if (!els.length) continue;
      if (d.attr) {
        if (els.toArray().some((el) => d.attr![1].re.test(e.$(el).attr(d.attr![0]) ?? ''))) hit(d.attr[1].confidence, 'dom');
      } else if (d.text) {
        if (d.text.re.test(els.first().text())) hit(d.text.confidence, 'dom');
      } else hit(100, 'dom');
    }
    if (conf > 0) out.push({ name: t.name, confidence: Math.min(conf, 100), via: [...new Set(via)].join(',') });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** One "main" platform: hosted builders/stores beat WordPress (e.g. WooCommerce runs on WordPress). */
export function primaryPlatform(found: { name: string; confidence: number }[]): string | null {
  const ok = found.filter((f) => f.confidence >= 50).map((f) => f.name);
  for (const name of PLATFORMS) if (ok.includes(name)) return name;
  return null;
}
