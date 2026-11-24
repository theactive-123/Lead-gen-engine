import * as cheerio from 'cheerio';

/**
 * Lightweight homepage features (no browser). Everything later stages need without re-fetching:
 * title, meta, H1, language, visible text sample, links, scripts, styles, JSON-LD, copyright year...
 */
export interface PageFeatures {
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  lang: string | null;
  site_name: string | null;
  generator: string | null;
  viewport: boolean;
  canonical: string | null;
  text_sample: string;
  word_count: number;
  links_internal: string[];
  links_external: string[];
  script_src: string[];
  style_href: string[];
  meta: Record<string, string>;
  jsonld: string[];
  jsonld_types: string[];
  copyright_year: number | null;
  has_form: boolean;
  img_count: number;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Visible text with a space between elements. cheerio's .text() glues neighbours together
 * ("<span>Email</span><span>info@x.com</span>" -> "Emailinfo@x.com"), which breaks words and emails.
 */
export function visibleText($: cheerio.CheerioAPI, root = 'body'): string {
  const parts: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === 'text') parts.push(n.data);
      else if (n.type === 'tag' && !['script', 'style', 'noscript', 'svg', 'template', 'iframe'].includes(n.name)) walk(n.children ?? []);
    }
  };
  const start = $(root);
  walk(start.length ? start.toArray() : $.root().toArray());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
const cut = (s: string | undefined | null, n: number) => (s ? squash(s).slice(0, n) || null : null);

export function extractFeatures(
  html: string,
  pageUrl: string,
  onDoc?: ($: cheerio.CheerioAPI, found: { scriptSrc: string[]; meta: Record<string, string> }) => void,
): PageFeatures {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./, '');
  const abs = (href: string | undefined) => {
    if (!href) return null;
    try {
      const u = new URL(href, base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch {
      return null;
    }
  };

  const meta: Record<string, string> = {};
  $('meta').each((_, el) => {
    const k = ($(el).attr('name') ?? $(el).attr('property') ?? $(el).attr('http-equiv'))?.toLowerCase();
    const v = $(el).attr('content');
    if (k && v && Object.keys(meta).length < 80) meta[k] = v.slice(0, 500);
  });

  const internal = new Set<string>();
  const external = new Set<string>();
  $('a[href]').each((_, el) => {
    const u = abs($(el).attr('href'));
    if (!u) return;
    const h = new URL(u).hostname.replace(/^www\./, '');
    const set = h === host || h.endsWith(`.${host}`) ? internal : external;
    if (set.size < 400) set.add(u.split('#')[0]!);
  });

  const jsonld: string[] = [];
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw || jsonld.length >= 10) return;
    jsonld.push(raw.slice(0, 20_000));
    for (const m of raw.matchAll(/"@type"\s*:\s*"([^"]{1,60})"/g)) types.add(m[1]!);
  });

  const scriptSrc = [...new Set($('script[src]').map((_, el) => abs($(el).attr('src'))).get().filter(Boolean) as string[])].slice(0, 200);
  const styleHref = [...new Set($('link[rel~="stylesheet"][href]').map((_, el) => abs($(el).attr('href'))).get().filter(Boolean) as string[])].slice(0, 100);

  // Hook for detectors that need the full document (scripts/styles are stripped just below).
  onDoc?.($, { scriptSrc, meta });
  const hasForm = $('form').length > 0;
  const imgCount = $('img').length;
  const text = visibleText($);
  const footer = visibleText($, 'footer') || text.slice(-1500);
  const years = [...footer.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  const thisYear = new Date().getUTCFullYear();
  const year = years.filter((y) => y >= 1995 && y <= thisYear + 1).sort().at(-1) ?? null;

  return {
    title: cut($('title').first().text(), 300),
    meta_description: cut(meta['description'] ?? meta['og:description'], 500),
    h1: cut($('h1').first().text(), 300),
    lang: cut($('html').attr('lang'), 20),
    site_name: cut(meta['og:site_name'] ?? meta['application-name'], 200),
    generator: cut(meta['generator'], 200),
    viewport: !!meta['viewport'],
    canonical: abs($('link[rel="canonical"]').attr('href')),
    text_sample: text.slice(0, 2000),
    word_count: text ? text.split(' ').length : 0,
    links_internal: [...internal],
    links_external: [...external],
    script_src: scriptSrc,
    style_href: styleHref,
    meta,
    jsonld,
    jsonld_types: [...types],
    copyright_year: year,
    has_form: hasForm,
    img_count: imgCount,
  };
}
