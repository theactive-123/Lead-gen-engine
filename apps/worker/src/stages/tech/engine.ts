import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';

/** Fingerprint tag separator: a backslash followed by a semicolon (built from char codes to avoid escaping mistakes). */
export const TAG_SEP = String.fromCharCode(92) + ';';

/**
 * Wappalyzer-compatible technology detection over a stored homepage (no browser).
 * Data: vendored enthec/webappanalyzer fingerprints (GPL-3.0, packages/fingerprints).
 *
 * Evaluated pattern types: headers, cookies, meta, scriptSrc, scripts (inline script text), html,
 * dom, url, text (visible text), css (inline styles). Relations: implies, excludes, requires,
 * requiresCategory. Versions from "\;version:\1" templates.
 * Not evaluated: js (needs a browser), xhr, dns, certIssuer, robots, probe.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/fingerprints');

interface Pat { re: RegExp; confidence: number; version?: string; reM?: RegExp }
interface DomPat { selector: string; token: string | null; kind: 'exists' | 'attrs' | 'text' | 'props'; exists?: Pat; attrs?: [string, Pat][]; text?: Pat }
interface Tech {
  name: string;
  cats: number[];
  headers: [string, Pat[]][];
  cookies: [string, Pat[]][];
  meta: [string, Pat[]][];
  scriptSrc: Pat[];
  scripts: Pat[];
  html: Pat[];
  url: Pat[];
  text: Pat[];
  css: Pat[];
  dom: DomPat[];
  implies: Pat[]; // re unused; `version` field reused for the implied name
  excludes: string[];
  requires: string[];
  requiresCategory: number[];
}

export interface Detection { name: string; confidence: number; version: string | null; categories: string[] }

export function parsePat(raw: string): Pat | null {
  const [src, ...tags] = String(raw).split(TAG_SEP);
  let confidence = 100;
  let version: string | undefined;
  for (const t of tags) {
    if (t.startsWith('confidence:')) confidence = Number(t.slice(11)) || 0;
    else if (t.startsWith('version:')) version = t.slice(8);
  }
  try {
    // Fingerprints use JavaScript regex syntax; case-insensitive like Wappalyzer.
    // reM: same pattern with "m" so ^/$ match at line starts/ends (used to pre-test joined lists).
    return { re: new RegExp(src ?? '', 'i'), reM: new RegExp(src ?? '', 'im'), confidence, version };
  } catch {
    return null;
  }
}
const asArr = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const pats = (v: unknown) => asArr(v).map(parsePat).filter((p): p is Pat => !!p);
const dict = (v: unknown): [string, Pat[]][] =>
  Object.entries((v ?? {}) as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), pats(x)]);

/** Longest literal-looking token in a CSS selector; if absent from the HTML the selector cannot match. */
export function selectorToken(sel: string): string | null {
  const tokens = sel
    .replace(/\\./g, '')
    .split(/[^a-zA-Z0-9_-]+/)
    .filter((t) => t.length >= 4 && !/^(div|span|link|meta|script|body|head|html|href|class|rel|name|content|data|type|src|style|exists|nth|child|not|first|last|input|form|button|img|iframe|section|footer|header|stylesheet|text|javascript)$/i.test(t));
  return tokens.sort((a, b) => b.length - a.length)[0]?.toLowerCase() ?? null;
}

function parseDom(v: unknown): DomPat[] {
  const out: DomPat[] = [];
  const add = (selector: string, spec?: Record<string, any>) => {
    // The rule's kind is fixed by what the fingerprint asks for; if its patterns fail to compile
    // the rule simply never matches (it must not fall back to "element exists").
    const d: DomPat = { selector, token: selectorToken(selector), kind: 'exists' };
    if (spec?.attributes) {
      d.kind = 'attrs';
      d.attrs = Object.entries(spec.attributes).map(([a, p]) => [a.toLowerCase(), parsePat(String(p))] as [string, Pat | null]).filter((x): x is [string, Pat] => !!x[1]);
    } else if (spec?.text !== undefined) {
      d.kind = 'text';
      d.text = parsePat(String(spec.text)) ?? undefined;
    } else if (spec?.exists !== undefined) {
      d.exists = parsePat(String(spec.exists)) ?? undefined;
    } else if (spec?.properties) {
      d.kind = 'props'; // JavaScript properties need a browser: never evaluated here
    }
    out.push(d);
  };
  if (typeof v === 'string' || Array.isArray(v)) for (const s of asArr(v)) for (const part of s.split(/,(?![^[]*\])/)) add(part.trim());
  else if (v && typeof v === 'object') for (const [sel, spec] of Object.entries(v)) add(sel, spec as Record<string, any>);
  return out;
}

/**
 * Script URLs a page loads without a plain <script src>: Shopify's app loader lists app scripts in an
 * inline `var urls = [...]` array (asyncLoad), and speed plugins rename src to data-src /
 * data-rocket-src / data-lazy-src. Verified on real stores 2026-11-25 (e.g. Mailchimp via chimpstatic.com).
 */
export function deferredScriptUrls($: cheerio.CheerioAPI, html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/var urls = (\[[^\]]*\]);/g)) {
    try {
      for (const u of JSON.parse(m[1]!) as unknown[]) if (typeof u === 'string') out.push(u.startsWith('//') ? `https:${u}` : u);
    } catch {
      /* not the Shopify loader */
    }
  }
  $('script[data-src], script[data-rocket-src], script[data-lazy-src]').each((_, el) => {
    const u = $(el).attr('data-rocket-src') ?? $(el).attr('data-lazy-src') ?? $(el).attr('data-src');
    if (u) out.push(u);
  });
  return out;
}

export class TechEngine {
  readonly techs: Tech[];
  readonly categories: Map<number, string>;
  private byName = new Map<string, Tech>();

  constructor(dir = ROOT) {
    const cats = JSON.parse(readFileSync(path.join(dir, 'categories.json'), 'utf8')) as Record<string, { name: string }>;
    this.categories = new Map(Object.entries(cats).map(([id, c]) => [Number(id), c.name]));
    const raw: Record<string, any> = {};
    for (const f of readdirSync(path.join(dir, 'technologies'))) if (f.endsWith('.json')) Object.assign(raw, JSON.parse(readFileSync(path.join(dir, 'technologies', f), 'utf8')));
    this.techs = Object.entries(raw).map(([name, t]) => ({
      name,
      cats: (t.cats ?? []) as number[],
      headers: dict(t.headers),
      cookies: dict(t.cookies),
      meta: dict(t.meta),
      scriptSrc: pats(t.scriptSrc),
      scripts: pats(t.scripts),
      html: pats(t.html),
      url: pats(t.url),
      text: pats(t.text),
      css: pats(t.css),
      dom: parseDom(t.dom),
      implies: asArr(t.implies).map((s) => {
        const [n, ...tags] = s.split(TAG_SEP);
        const c = tags.find((x) => x.startsWith('confidence:'));
        return { re: /$^/, confidence: c ? Number(c.slice(11)) : 100, version: n!.trim() };
      }),
      excludes: asArr(t.excludes),
      requires: asArr(t.requires),
      requiresCategory: asArr(t.requiresCategory).map(Number),
    }));
    for (const t of this.techs) this.byName.set(t.name, t);
  }

  analyze(page: { url: string; html: string; headers: Record<string, string>; cookies: string[] }): Detection[] {
    const html = page.html.slice(0, 1_500_000);
    const lower = html.toLowerCase();
    const $ = cheerio.load(html);
    const meta = new Map<string, string[]>();
    $('meta').each((_, el) => {
      const k = ($(el).attr('name') ?? $(el).attr('property') ?? $(el).attr('http-equiv'))?.toLowerCase();
      const v = $(el).attr('content');
      if (k && v !== undefined) meta.set(k, [...(meta.get(k) ?? []), v]);
    });
    const scriptSrc = [...$('script[src]').map((_, el) => $(el).attr('src') ?? '').get(), ...deferredScriptUrls($, html)]
      .filter(Boolean).map((x) => x.replace(/[\r\n]/g, ''));
    // Any match inside one URL is also a match in the newline-joined list (with the "m" flag),
    // so a pattern that fails on the joined list cannot match any single URL: skip it.
    const scriptSrcJoined = scriptSrc.join('\n');
    const scripts = $('script:not([src])').map((_, el) => $(el).text().slice(0, 50_000)).get().join('\n').slice(0, 600_000);
    const css = $('style').map((_, el) => $(el).text()).get().join('\n').slice(0, 300_000);
    const headers = new Map(Object.entries(page.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const cookies = new Map(page.cookies.map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i < 0 ? undefined : i).trim().toLowerCase(), i < 0 ? '' : c.slice(i + 1)] as [string, string];
    }));
    let text: string | null = null;
    const visibleText = () => (text ??= $('body').clone().find('script,style,noscript').remove().end().text().replace(/\s+/g, ' ').slice(0, 100_000));

    const selCache = new Map<string, ReturnType<typeof $> | null>();
    const select = (sel: string) => {
      if (!selCache.has(sel)) {
        try {
          selCache.set(sel, $(sel));
        } catch {
          selCache.set(sel, null); // selector syntax cheerio cannot parse
        }
      }
      return selCache.get(sel)!;
    };
    const cssEscape = (a: string) => a.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const found = new Map<string, { confidence: number; version: string | null }>();
    const hit = (t: Tech, p: Pat, m: RegExpExecArray | null) => {
      const cur = found.get(t.name) ?? { confidence: 0, version: null };
      cur.confidence = Math.min(100, cur.confidence + p.confidence);
      if (p.version && m) {
        const v = resolveVersion(p.version, m);
        if (v && (!cur.version || v.length > cur.version.length)) cur.version = v;
      }
      found.set(t.name, cur);
    };
    const test = (t: Tech, ps: Pat[], s: string) => {
      for (const p of ps) {
        const m = p.re.exec(s);
        if (m) hit(t, p, m);
      }
    };

    for (const t of this.techs) {
      for (const [k, ps] of t.headers) { const v = headers.get(k); if (v !== undefined) test(t, ps, v); }
      for (const [k, ps] of t.cookies) { const v = cookies.get(k); if (v !== undefined) test(t, ps, v); }
      for (const [k, ps] of t.meta) for (const v of meta.get(k) ?? []) test(t, ps, v);
      for (const p of t.scriptSrc) {
        if (!p.reM!.test(scriptSrcJoined)) continue;
        for (const src of scriptSrc) {
          const m = p.re.exec(src);
          if (m) hit(t, p, m);
        }
      }
      if (t.scripts.length && scripts) test(t, t.scripts, scripts);
      if (t.html.length) test(t, t.html, html);
      if (t.url.length) test(t, t.url, page.url);
      if (t.css.length && css) test(t, t.css, css);
      if (t.text.length) test(t, t.text, visibleText());
      for (const d of t.dom) {
        if (d.kind === 'props' || (d.kind === 'attrs' && !d.attrs?.length) || (d.kind === 'text' && !d.text)) continue;
        if (d.token && !lower.includes(d.token)) continue; // cheap pre-check: the selector cannot match
        if (d.kind === 'attrs') {
          for (const [attr, p] of d.attrs ?? []) {
            if (!lower.includes(attr)) continue; // attribute name absent from the page: cannot match
            // Only elements that HAVE the attribute can match its pattern; let the selector engine filter.
            const els = select(`${d.selector}[${cssEscape(attr)}]`);
            if (!els?.length) continue;
            for (const el of els.toArray().slice(0, 500)) {
              const v = $(el).attr(attr);
              if (v === undefined) continue;
              const m = p.re.exec(v);
              if (m) { hit(t, p, m); break; }
            }
          }
          continue;
        }
        const els = select(d.selector);
        if (!els?.length) continue;
        if (d.kind === 'text') {
          const m = d.text!.re.exec(els.first().text());
          if (m) hit(t, d.text!, m);
        } else hit(t, d.exists ?? { re: /x/, confidence: 100 }, null);
      }
    }

    // implies (transitively), then excludes / requires / requiresCategory
    const queue = [...found.keys()];
    while (queue.length) {
      const name = queue.pop()!;
      const t = this.byName.get(name);
      if (!t) continue;
      const parent = found.get(name)!;
      for (const imp of t.implies) {
        const target = imp.version!;
        if (!this.byName.has(target)) continue;
        const conf = Math.min(parent.confidence, imp.confidence);
        const cur = found.get(target);
        if (!cur) { found.set(target, { confidence: conf, version: null }); queue.push(target); }
        else if (cur.confidence < conf) cur.confidence = conf;
      }
    }
    for (const name of [...found.keys()]) for (const ex of this.byName.get(name)?.excludes ?? []) found.delete(ex);
    let changed = true;
    while (changed) {
      changed = false;
      const presentCats = new Set([...found.keys()].flatMap((n) => this.byName.get(n)?.cats ?? []));
      for (const name of [...found.keys()]) {
        const t = this.byName.get(name)!;
        const missingReq = t.requires.some((r) => !found.has(r));
        const missingCat = t.requiresCategory.length > 0 && !t.requiresCategory.some((c) => presentCats.has(c));
        if (missingReq || missingCat) { found.delete(name); changed = true; }
      }
    }
    return [...found.entries()]
      .map(([name, f]) => ({ name, confidence: f.confidence, version: f.version, categories: (this.byName.get(name)?.cats ?? []).map((c) => this.categories.get(c) ?? String(c)) }))
      .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  }
}

/** "\1" -> group 1; "\1?yes:no" ternary as in the Wappalyzer spec. */
export function resolveVersion(tpl: string, m: RegExpExecArray): string | null {
  const v = tpl.replace(/\\(\d)(?:\?([^:]*):(.*))?/g, (_, n: string, yes?: string, no?: string) => {
    const g = m[Number(n)];
    if (yes !== undefined) return g ? yes : (no ?? '');
    return g ?? '';
  }).trim();
  return v && v.length <= 20 ? v : null;
}
