import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { registrableDomain } from '../../sources/normalize.js';
import { deferredScriptUrls } from '../tech/engine.js';

/**
 * Stage 9 — light website audit (no browser). A pure function over data we already have
 * (page features, stored homepage HTML, detected technologies) plus the results of a few small
 * polite probes done by the stage (broken-link sample, favicon, http→https, contact page).
 * Every finding carries `evidence`: the measured value or URL that makes it true. First lines
 * (Phase 8) may only quote findings, so a finding we cannot prove is not emitted.
 */
export type Severity = 'high' | 'medium' | 'low' | 'info';
export interface Finding { code: string; severity: Severity; message: string; evidence: Record<string, unknown> }

export interface AuditRules {
  ttfb_ms: { medium: number; high: number };
  html_kb_max: number;
  max_external_scripts: number;
  max_render_blocking: number;
  legacy_images_min: number;
  legacy_images_share: number;
  auto_format_image_hosts: string[];
  images_missing_alt_min: number;
  jquery_min_version: string;
  wordpress_min_version: string;
  copyright_stale_years: number;
  broken_link_sample: number;
  check_favicon: boolean;
  check_http_redirect: boolean;
  check_contact_page: boolean;
  analytics_categories: string[];
  email_capture_categories: string[];
  review_categories: string[];
  booking_categories: string[];
  form_categories: string[];
  booking_path_pattern: string;
  store_gates: string[];
  booking_gates: string[];
  builder_platforms: Record<string, string>;
  contact_form_skip_platforms?: string[];
  analytics_builtin_platforms?: string[];
  product_path_pattern?: string;
  email_input_skip_platforms?: string[];
  severity: Record<string, Severity>;
}

export interface Tech { name: string; version: string | null; categories: string[] }

export interface PageInfo {
  final_url: string;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  viewport: boolean;
  ttfb_ms: number | null;
  html_bytes: number | null;
  script_src: string[];
  links_internal: string[];
  links_external: string[];
  copyright_year: number | null;
  platform: string | null;
}

/** Results of the network probes (undefined = probe not run, null = could not tell). */
export interface Probes {
  links?: { url: string; status: number | null }[];
  favicon?: { url: string; status: number | null } | null;
  http?: { status: number | null; location: string | null } | null;
  contact?: { url: string | null; hasForm: boolean | null } | null;
  product?: { url: string | null; hasReviews: boolean | null } | null;
}

export interface VendorHosts { booking: Set<string>; forms: Set<string>; reviews: Set<string> }

export interface AuditInput {
  page: PageInfo;
  html: string | null;
  techs: Tech[];
  gate: string | null;
  probes: Probes;
  hosts: VendorHosts;
  now?: Date;
}

export interface AuditResult {
  findings: Finding[];
  metrics: Record<string, unknown>;
  checks: Record<string, string>; // check -> 'ran' | reason it was skipped
}

/** Compare dotted versions numerically: -1, 0, 1. Non-numeric parts count as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const host = (u: string): string | null => {
  try {
    const r = registrableDomain(new URL(u).hostname);
    return 'domain' in r ? r.domain : null;
  } catch {
    return null;
  }
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/fingerprints');
let hostCache: Map<string, Set<string>> | undefined;
/**
 * Registrable domains of the vendors in the given fingerprint categories (from each tool's `website`).
 * Strict: a domain is kept only if EVERY tool using it is in those categories, so shared domains of
 * big platforms (google.com, shopify.com…) never count as "a booking tool" or "a form tool".
 */
export function vendorHosts(categories: string[], dir = ROOT): Set<string> {
  const key = [dir, ...categories].join('|');
  hostCache ??= new Map();
  const hit = hostCache.get(key);
  if (hit) return hit;
  const cats = JSON.parse(readFileSync(path.join(dir, 'categories.json'), 'utf8')) as Record<string, { name: string }>;
  const ids = new Set(Object.entries(cats).filter(([, c]) => categories.includes(c.name)).map(([id]) => Number(id)));
  const inCat = new Map<string, boolean>(); // host -> all its tools are in the categories
  for (const f of readdirSync(path.join(dir, 'technologies'))) {
    if (!f.endsWith('.json')) continue;
    const techs = JSON.parse(readFileSync(path.join(dir, 'technologies', f), 'utf8')) as Record<string, { cats?: number[]; website?: string }>;
    for (const t of Object.values(techs)) {
      const h = t.website ? host(t.website) : null;
      if (!h) continue;
      const ok = (t.cats ?? []).some((c) => ids.has(c));
      inCat.set(h, (inCat.get(h) ?? true) && ok);
    }
  }
  const out = new Set([...inCat].filter(([, ok]) => ok).map(([h]) => h));
  hostCache.set(key, out);
  return out;
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif)(?:$|[?#])/i;

/** Does this HTML contain a form a visitor can send (own form, or an embedded form-builder)? */
export function hasContactForm(html: string, formHosts: Set<string>): boolean {
  const $ = cheerio.load(html);
  const own = $('form').filter((_, el) => {
    const f = $(el);
    const action = (f.attr('action') ?? '').toLowerCase();
    if (f.attr('role') === 'search' || /search|cart|login|account/.test(`${action} ${f.attr('class') ?? ''}`)) return false;
    if (f.find('textarea, input[type="email"], input[name*="email" i]').length) return true;
    // A POST form with several fields is a contact form even when its fields are not named "email".
    const fields = f.find('input[type="text"], input[type="tel"], input:not([type]), textarea, select').length;
    return (f.attr('method') ?? '').toLowerCase() === 'post' && fields >= 2;
  }).length > 0;
  if (own) return true;
  // Embedded form tools, also when a speed plugin renamed src (data-src, data-rocket-src, data-lazy-src).
  // An address that mentions "form" counts (Google Forms, HubSpot forms…): when unsure we assume a
  // form exists rather than report a false problem.
  const srcs = $('iframe, script').map((_, el) => ['src', 'data-src', 'data-rocket-src', 'data-lazy-src'].map((a) => $(el).attr(a)).filter(Boolean)).get() as string[];
  return srcs.some((s) => {
    if (/form/i.test(s)) return true;
    const h = host(s.startsWith('//') ? `https:${s}` : s);
    return !!h && formHosts.has(h);
  });
}

/** Does a (product) page show reviews: a review tool's script/frame, or star ratings in structured data? */
export function hasReviews(html: string, reviewHosts: Set<string>): boolean {
  if (/"aggregateRating"|"@type"\s*:\s*"(AggregateRating|Review)"/i.test(html)) return true;
  const $ = cheerio.load(html);
  const srcs = [...$('iframe, script, link').map((_, el) => ['src', 'href', 'data-src', 'data-rocket-src', 'data-lazy-src'].map((a) => $(el).attr(a)).filter(Boolean)).get() as string[],
    ...deferredScriptUrls($, html)];
  return srcs.some((s) => {
    const h = host(s.startsWith('//') ? `https:${s}` : s);
    return !!h && reviewHosts.has(h);
  });
}

export function lightAudit(input: AuditInput, rules: AuditRules): AuditResult {
  const { page, html, techs, gate, probes, hosts } = input;
  const now = input.now ?? new Date();
  const findings: Finding[] = [];
  const checks: Record<string, string> = {};
  const metrics: Record<string, unknown> = {};
  const add = (code: string, message: string, evidence: Record<string, unknown>) => {
    findings.push({ code, severity: rules.severity[code] ?? 'low', message, evidence });
  };
  const hasCat = (cats: string[]) => techs.filter((t) => t.categories.some((c) => cats.includes(c))).map((t) => t.name);
  const techNames = new Set(techs.map((t) => t.name));
  const isStore = !!gate && rules.store_gates.includes(gate);
  const isBooking = !!gate && rules.booking_gates.includes(gate);
  const https = page.final_url.startsWith('https://');

  // --- Basics from page features (always available) ---
  if (!page.title?.trim()) add('missing_title', 'The homepage has no page title.', { url: page.final_url });
  if (!page.meta_description?.trim()) add('missing_meta_description', 'The homepage has no meta description, so search results show random text.', { url: page.final_url });
  if (!page.h1?.trim()) add('missing_h1', 'The homepage has no H1 heading.', { url: page.final_url });
  if (!page.viewport) add('no_viewport', 'The site is not set up for mobile screens (no viewport tag).', { url: page.final_url });
  checks.basics = 'ran';

  if (page.ttfb_ms != null) {
    metrics.ttfb_ms = page.ttfb_ms;
    if (page.ttfb_ms >= rules.ttfb_ms.high) add('slow_server_high', `The server took ${(page.ttfb_ms / 1000).toFixed(1)} s to start answering.`, { ttfb_ms: page.ttfb_ms });
    else if (page.ttfb_ms >= rules.ttfb_ms.medium) add('slow_server', `The server took ${(page.ttfb_ms / 1000).toFixed(1)} s to start answering.`, { ttfb_ms: page.ttfb_ms });
  }
  if (page.html_bytes != null) {
    const kb = Math.round(page.html_bytes / 1024);
    metrics.html_kb = kb;
    if (kb > rules.html_kb_max) add('heavy_html', `The homepage HTML alone is ${kb} KB.`, { html_kb: kb });
  }
  metrics.external_scripts = page.script_src.length;
  if (page.script_src.length > rules.max_external_scripts) {
    add('too_many_scripts', `The homepage loads ${page.script_src.length} separate script files.`, { scripts: page.script_src.length });
  }

  // --- Outdated software (versions from fingerprints) ---
  const jq = techs.find((t) => t.name === 'jQuery' && t.version);
  if (jq?.version) {
    metrics.jquery_version = jq.version;
    if (cmpVersion(jq.version, rules.jquery_min_version) < 0) {
      add('outdated_jquery', `The site runs jQuery ${jq.version}, older than ${rules.jquery_min_version} (known security fixes).`, { version: jq.version, min: rules.jquery_min_version });
    }
  }
  const wp = techs.find((t) => t.name === 'WordPress' && t.version);
  if (wp?.version) {
    metrics.wordpress_version = wp.version;
    if (cmpVersion(wp.version, rules.wordpress_min_version) < 0) {
      add('outdated_wordpress', `The site runs WordPress ${wp.version}, which is several major versions old.`, { version: wp.version, min: rules.wordpress_min_version });
    }
  }
  if (page.copyright_year != null && page.copyright_year <= now.getUTCFullYear() - rules.copyright_stale_years) {
    add('outdated_copyright', `The footer still says © ${page.copyright_year}.`, { year: page.copyright_year });
  }

  // --- Marketing gaps (HTML detection: tools loaded later by a tag manager can be missed) ---
  // Platforms with built-in visitor statistics always "have analytics", and their pixels often load
  // through the platform's own loader, so the finding is never made there.
  if ((rules.analytics_builtin_platforms ?? []).includes(page.platform ?? '')) checks.analytics = 'skipped: platform has built-in analytics';
  else {
    checks.analytics = 'ran';
    if (!hasCat(rules.analytics_categories).length) add('no_analytics', 'No analytics or tag manager found on the homepage.', { detection: 'html' });
  }
  for (const [name, code] of Object.entries(rules.builder_platforms)) {
    if (techNames.has(name) || page.platform === name) add(code, `The site is built on ${name}.`, { platform: name });
  }

  // --- Checks that read the stored HTML ---
  let emailInput = false;
  let homeContactForm = false;
  let aggregateRating = false;
  if (html) {
    const $ = cheerio.load(html);
    // Render-blocking: classic scripts in <head> without async/defer.
    const blocking = $('head script[src]').filter((_, el) => {
      const s = $(el);
      return s.attr('async') === undefined && s.attr('defer') === undefined && (s.attr('type') ?? '').toLowerCase() !== 'module';
    }).map((_, el) => $(el).attr('src')).get();
    metrics.render_blocking = blocking.length;
    if (blocking.length > rules.max_render_blocking) {
      add('render_blocking_scripts', `${blocking.length} scripts block the page from showing until they load.`, { count: blocking.length, examples: blocking.slice(0, 3) });
    }

    // Images: legacy formats, unless served from a CDN that converts automatically (verified hosts in rules).
    let legacy = 0, modern = 0, auto = 0;
    const legacyEx: string[] = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src || src.startsWith('data:')) return;
      const m = IMG_EXT.exec(src);
      if (!m) return;
      if (rules.auto_format_image_hosts.some((h) => src.includes(h))) { auto++; return; }
      if (/webp|avif/i.test(m[1]!)) modern++;
      else if (!/gif/i.test(m[1]!)) {
        legacy++;
        if (legacyEx.length < 3) legacyEx.push(src);
      }
    });
    metrics.images = { legacy, modern, auto_converted: auto };
    if (legacy >= rules.legacy_images_min && legacy / Math.max(1, legacy + modern) >= rules.legacy_images_share) {
      add('legacy_image_formats', `${legacy} images are served as JPG/PNG instead of WebP or AVIF.`, { legacy, modern, examples: legacyEx });
    }
    const noAlt = $('img:not([alt])').length;
    metrics.images_missing_alt = noAlt;
    if (noAlt >= rules.images_missing_alt_min) add('images_missing_alt', `${noAlt} images have no alt text.`, { count: noAlt });

    if (https) {
      const active = $('script[src^="http:"], link[rel~="stylesheet"][href^="http:"], iframe[src^="http:"]')
        .map((_, el) => $(el).attr('src') ?? $(el).attr('href')).get();
      const passive = $('img[src^="http:"], source[src^="http:"], video[src^="http:"], audio[src^="http:"]').map((_, el) => $(el).attr('src')).get();
      if (active.length) add('mixed_content_active', `The secure page loads ${active.length} scripts or styles over insecure http, which browsers block.`, { examples: active.slice(0, 3) });
      else if (passive.length) add('mixed_content_passive', `${passive.length} images load over insecure http.`, { examples: passive.slice(0, 3) });
    }

    const icon = $('link[rel~="icon"]').length > 0;
    metrics.favicon_link = icon;
    if (!icon && probes.favicon && probes.favicon.status != null && probes.favicon.status >= 400 && probes.favicon.status < 500) {
      add('missing_favicon', 'The site has no favicon (browser tab icon).', { url: probes.favicon.url, status: probes.favicon.status });
    }
    checks.favicon = icon ? 'ran' : probes.favicon === undefined ? 'skipped: not probed' : 'ran';

    emailInput = $('input[type="email"], input[name*="email" i]').length > 0;
    homeContactForm = hasContactForm(html, hosts.forms);
    aggregateRating = /"aggregateRating"|"@type"\s*:\s*"(AggregateRating|Review)"/i.test(html);
    checks.html = 'ran';
  } else {
    checks.html = 'skipped: homepage HTML not available';
  }

  // Store: email capture and reviews.
  if (isStore) {
    const emailTools = hasCat(rules.email_capture_categories);
    metrics.email_tools = emailTools;
    if (!emailTools.length) {
      add('no_email_marketing_tool', 'No email marketing tool (Klaviyo, Mailchimp, Omnisend…) found on the store.', { detection: 'html' });
      const skip = (rules.email_input_skip_platforms ?? []).includes(page.platform ?? '');
      if (html && !emailInput && !skip) add('no_email_capture', 'The homepage has no email signup at all.', { detection: 'html' });
    }
    // Reviews usually show on product pages, so the finding needs a product page that we read.
    const reviewTools = hasCat(rules.review_categories);
    if (reviewTools.length || aggregateRating) checks.reviews = 'ran';
    else if (!probes.product?.url || probes.product.hasReviews === null) checks.reviews = 'skipped: no product page read';
    else {
      checks.reviews = 'ran';
      if (!probes.product.hasReviews) add('no_reviews', 'No product reviews found (no reviews app, no star ratings on a product page).', { product_page: probes.product.url, detection: 'html' });
    }
  }

  // Booking businesses: online booking.
  if (isBooking) {
    const bookingTools = hasCat(rules.booking_categories);
    const re = new RegExp(rules.booking_path_pattern, 'i');
    const bookingLink = page.links_internal.find((u) => {
      try {
        return re.test(new URL(u).pathname);
      } catch {
        return false;
      }
    });
    // A booking tool's domain, or any external link whose path looks like booking (e.g. a scheduler
    // on a shared domain such as squareup.com/appointments): when unsure, assume booking exists.
    const bookingHost = page.links_external.find((u) => {
      const h = host(u);
      if (h && hosts.booking.has(h)) return true;
      try {
        return re.test(new URL(u).pathname);
      } catch {
        return false;
      }
    });
    metrics.booking = { tools: bookingTools, link: bookingLink ?? null, external: bookingHost ?? null };
    if (!bookingTools.length && !bookingLink && !bookingHost) {
      add('no_online_booking', 'No online booking found (no booking tool, no booking page or link).', { detection: 'html' });
    }
  }

  // Contact form: homepage form or a form tool counts; otherwise the contact page decides.
  const skipContact = (rules.contact_form_skip_platforms ?? []).includes(page.platform ?? '');
  if (skipContact) checks.contact_form = 'skipped: forms on this platform are drawn by JavaScript';
  else if (homeContactForm || hasCat(rules.form_categories).length) checks.contact_form = 'ran';
  else if (probes.contact === undefined) checks.contact_form = 'skipped: not probed';
  else if (probes.contact === null || probes.contact.hasForm === null) checks.contact_form = 'skipped: contact page not readable';
  else {
    checks.contact_form = 'ran';
    if (!probes.contact.hasForm) {
      add('no_contact_form', probes.contact.url ? 'The contact page has no contact form.' : 'No contact page or contact form found.',
        { contact_page: probes.contact.url });
    }
  }

  // Broken links: only 404 / 410 count (403 / 5xx usually mean a bot block, not a broken page).
  if (probes.links) {
    const broken = probes.links.filter((l) => l.status === 404 || l.status === 410);
    metrics.links_checked = probes.links.length;
    if (broken.length) add('broken_links', `${broken.length} of ${probes.links.length} sampled links lead to a "page not found" error.`, { broken: broken.map((b) => b.url) });
    checks.broken_links = 'ran';
  } else checks.broken_links = 'skipped: not probed';

  // http → https.
  if (probes.http === undefined) checks.https_redirect = 'skipped: not probed';
  else if (probes.http === null || probes.http.status == null) checks.https_redirect = 'skipped: http not reachable';
  else {
    const s = probes.http.status;
    if (s >= 200 && s < 300) {
      checks.https_redirect = 'ran';
      add('no_https_redirect', 'The site still opens on insecure http:// without moving visitors to https.', { status: s });
    } else if (s >= 300 && s < 400) checks.https_redirect = 'ran';
    else checks.https_redirect = `skipped: http answered ${s}`; // e.g. a proxy or firewall, not the site's choice
  }

  return { findings, metrics, checks };
}

/** Counts per severity, for the summary column. */
export function summarize(findings: Finding[]): Record<Severity, number> {
  const s: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}
