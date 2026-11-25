import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cmpVersion, hasContactForm, hasReviews, lightAudit, summarize, vendorHosts, type AuditRules, type PageInfo, type Tech } from '../src/stages/audit/light.js';
import { deferredTechs, sampleLinks } from '../src/stages/audit/stage.js';
import { extractFeatures } from '../src/stages/fetch/extract.js';
import { TechEngine } from '../src/stages/tech/engine.js';

// The real default rules, read from the migration that seeds them.
const sql = readFileSync(new URL('../../../packages/shared/migrations/016_audits.sql', import.meta.url), 'utf8');
const rules = JSON.parse(sql.slice(sql.indexOf("('audit.rules', '") + 17, sql.indexOf("}', 'Light audit") + 1)) as AuditRules;
const hosts = { booking: vendorHosts(rules.booking_categories), forms: vendorHosts(rules.form_categories), reviews: vendorHosts(rules.review_categories) };
const now = new Date('2026-11-25T00:00:00Z');

const dir = new URL('./fixtures/pages/', import.meta.url);
const engine = new TechEngine();
const fixtures = readdirSync(dir).map((f) => JSON.parse(gunzipSync(readFileSync(new URL(f, dir))).toString('utf8')));

function pageOf(html: string, url: string, platform: string | null, extra: Partial<PageInfo> = {}): PageInfo {
  const f = extractFeatures(html, url);
  return {
    final_url: url, title: f.title, meta_description: f.meta_description, h1: f.h1, viewport: f.viewport, ttfb_ms: 200,
    html_bytes: Buffer.byteLength(html), script_src: f.script_src, links_internal: f.links_internal, links_external: f.links_external,
    copyright_year: f.copyright_year, platform, ...extra,
  };
}
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe('light audit: helpers', () => {
  it('compares versions numerically', () => {
    expect(cmpVersion('1.12.4', '3.5.0')).toBe(-1);
    expect(cmpVersion('3.5.1', '3.5.0')).toBe(1);
    expect(cmpVersion('3.5', '3.5.0')).toBe(0);
    expect(cmpVersion('5.9.10', '6.0')).toBe(-1);
  });
  it('vendor host lists are strict (no shared big-platform domains)', () => {
    for (const h of ['mindbodyonline.com', 'calendly.com', 'acuityscheduling.com', 'momence.com', 'vagaro.com']) expect(hosts.booking.has(h)).toBe(true);
    for (const h of ['typeform.com', 'jotform.com', 'wpforms.com']) expect(hosts.forms.has(h)).toBe(true);
    for (const h of ['google.com', 'shopify.com', 'facebook.com']) {
      expect(hosts.booking.has(h)).toBe(false);
      expect(hosts.forms.has(h)).toBe(false);
    }
  });
  it('contact form detection: own form, embedded tool, and a map is not a form', () => {
    expect(hasContactForm('<form><input type="email"><textarea></textarea></form>', hosts.forms)).toBe(true);
    expect(hasContactForm('<iframe src="https://docs.google.com/forms/d/e/x/viewform"></iframe>', hosts.forms)).toBe(true);
    expect(hasContactForm('<script src="//js.hsforms.net/forms/embed/v2.js"></script>', hosts.forms)).toBe(true);
    expect(hasContactForm('<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>', hosts.forms)).toBe(false);
    expect(hasContactForm('<form action="/search"><input name="q"></form>', hosts.forms)).toBe(false);
    // Real cases from the browser check (2026-11-25): a POST form without "email" field names, and a
    // HubSpot form whose script a speed plugin renamed to data-rocket-src.
    expect(hasContactForm('<form action="/contact/contact.php" name="form_query" method="post"><input type="text" name="q_name"><input type="text" name="q_mail"><textarea name="msg"></textarea></form>', hosts.forms)).toBe(true);
    expect(hasContactForm('<form action="/contact/contact.php" method="post"><input type="text" name="a"><input type="text" name="b"></form>', hosts.forms)).toBe(true);
    expect(hasContactForm('<script type="rocketlazyloadscript" data-rocket-src="//js.hsforms.net/forms/v2.js"></script>', hosts.forms)).toBe(true);
    expect(hasContactForm('<form role="search" method="post"><input type="text"><input type="text"></form>', hosts.forms)).toBe(false);
  });
  it('reviews: star ratings or a review tool on the page', () => {
    expect(hasReviews('<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":"4.9"}}</script>', hosts.reviews)).toBe(true);
    expect(hasReviews('<script src="https://cdn.judge.me/widget_preloader.js"></script>', hosts.reviews)).toBe(true);
    expect(hasReviews('<p>Great product</p>', hosts.reviews)).toBe(false);
  });
  it('Shopify app loader scripts are detected (real asyncLoad list, Mailchimp)', () => {
    const html = '<script>(function() { function asyncLoad() { var urls = ["https:\\/\\/chimpstatic.com\\/mcjs-connected\\/js\\/users\\/0715a97a9aba0b570bee25777\\/df115dceb974d42617369ed36.js?shop=a68a68-72.myshopify.com"]; } })();</script>';
    const t = deferredTechs(engine, 'https://123kidstalk.com/', html);
    expect(t.map((x) => x.name)).toContain('MailChimp');
    expect(engine.analyze({ url: 'https://123kidstalk.com/', html, headers: {}, cookies: [] }).map((x) => x.name)).toContain('MailChimp');
  });
  it('samples internal links spread over the page, skipping cart/login/files', () => {
    const links = ['https://a.com/', 'https://a.com/cart', 'https://a.com/x.pdf', 'https://b.com/about',
      ...Array.from({ length: 30 }, (_, i) => `https://a.com/p${i}`)];
    const s = sampleLinks(links, 'https://a.com/', 3);
    expect(s).toEqual(['https://a.com/p0', 'https://a.com/p10', 'https://a.com/p20']);
  });
});

describe('light audit on real homepages (fixtures 2026-11-24)', () => {
  for (const fx of fixtures) {
    const platform = fx.expected.platform as string;
    it(`${platform}: findings are well-formed and true to the page`, () => {
      const techs: Tech[] = engine.analyze({ url: fx.final_url, html: fx.html, headers: fx.headers, cookies: fx.cookies });
      const r = lightAudit({ page: pageOf(fx.html, fx.final_url, platform), html: fx.html, techs, gate: 'store', probes: {}, hosts, now }, rules);
      for (const f of r.findings) {
        expect(rules.severity[f.code], `severity for ${f.code}`).toBeDefined();
        expect(f.message.length).toBeGreaterThan(10);
        expect(f.evidence).toBeTypeOf('object');
      }
      // Platforms whose CDN converts images automatically must never get the old-image-format finding.
      if (['Shopify', 'Squarespace', 'Wix'].includes(platform)) expect(codes(r)).not.toContain('legacy_image_formats');
      if (platform === 'Wix') expect(codes(r)).toContain('wix_site');
      if (platform === 'Squarespace') expect(codes(r)).toContain('squarespace_site');
      // Webflow fixture runs jQuery 3.5.1 and has Klaviyo: neither outdated jQuery nor "no email tool".
      if (platform === 'Webflow') {
        expect(r.metrics.jquery_version).toBe('3.5.1');
        expect(codes(r)).not.toContain('outdated_jquery');
        expect(codes(r)).not.toContain('no_email_marketing_tool');
      }
      expect(r.checks.html).toBe('ran');
      expect(Object.values(summarize(r.findings)).reduce((a, b) => a + b, 0)).toBe(r.findings.length);
    });
  }
});

describe('light audit rules', () => {
  const base = (html: string, extra: Partial<PageInfo> = {}) => pageOf(html, 'https://shop.example/', null, extra);
  const run = (html: string, opts: { techs?: Tech[]; gate?: string | null; probes?: object; page?: Partial<PageInfo> } = {}) =>
    lightAudit({ page: base(html, opts.page), html, techs: opts.techs ?? [], gate: opts.gate ?? null, probes: opts.probes ?? {}, hosts, now }, rules);
  const good = '<html><head><title>Shop</title><meta name="description" content="d"><meta name="viewport" content="width=device-width"><link rel="icon" href="/f.png"></head><body><h1>Hi</h1>';

  it('missing basics are reported with evidence', () => {
    const r = run('<html><head></head><body><p>x</p></body></html>');
    expect(codes(r)).toEqual(expect.arrayContaining(['missing_title', 'missing_meta_description', 'missing_h1', 'no_viewport']));
    expect(codes(run(`${good}</body></html>`))).not.toContain('missing_title');
  });
  it('render-blocking scripts: only classic head scripts without async/defer', () => {
    const head = (s: string) => `<html><head>${s}</head><body></body></html>`;
    const blocking = '<script src="/1.js"></script><script src="/2.js"></script><script src="/3.js"></script><script src="/4.js"></script>';
    expect(codes(run(head(blocking)))).toContain('render_blocking_scripts');
    expect(codes(run(head(blocking.replaceAll('<script ', '<script defer '))))).not.toContain('render_blocking_scripts');
  });
  it('legacy images: flagged on plain hosting, not on auto-converting CDNs', () => {
    const imgs = (src: string) => `${good}${Array.from({ length: 6 }, (_, i) => `<img alt="" src="${src}${i}.jpg">`).join('')}</body></html>`;
    expect(codes(run(imgs('https://shop.example/wp-content/uploads/a')))).toContain('legacy_image_formats');
    expect(codes(run(imgs('https://shop.example/cdn/shop/files/a')))).not.toContain('legacy_image_formats');
    expect(codes(run(imgs('https://images.squarespace-cdn.com/content/v1/a')))).not.toContain('legacy_image_formats');
  });
  it('mixed content: active vs passive', () => {
    expect(codes(run(`${good}<script src="http://x.com/a.js"></script></body></html>`))).toContain('mixed_content_active');
    expect(codes(run(`${good}<img alt="" src="http://x.com/a.png"></body></html>`))).toContain('mixed_content_passive');
  });
  it('outdated jQuery / WordPress only below the configured versions', () => {
    const t = (name: string, version: string): Tech => ({ name, version, categories: ['JavaScript libraries'] });
    expect(codes(run(good, { techs: [t('jQuery', '1.12.4')] }))).toContain('outdated_jquery');
    expect(codes(run(good, { techs: [t('jQuery', '3.7.1')] }))).not.toContain('outdated_jquery');
    expect(codes(run(good, { techs: [t('WordPress', '5.8.3')] }))).toContain('outdated_wordpress');
    expect(codes(run(good, { techs: [t('WordPress', '6.4')] }))).not.toContain('outdated_wordpress');
  });
  it('outdated copyright: two or more years old', () => {
    expect(codes(run(good, { page: { copyright_year: 2024 } }))).toContain('outdated_copyright');
    expect(codes(run(good, { page: { copyright_year: 2025 } }))).not.toContain('outdated_copyright');
  });
  it('no analytics: never on platforms with built-in analytics', () => {
    expect(codes(run(good))).toContain('no_analytics');
    const shop = run(good, { page: { platform: 'Shopify' } });
    expect(codes(shop)).not.toContain('no_analytics');
    expect(shop.checks.analytics).toMatch(/^skipped/);
  });
  it('no reviews: needs a product page that was read', () => {
    const product = (hasRev: boolean | null, url: string | null = 'https://shop.example/products/a') => ({ product: { url, hasReviews: hasRev } });
    expect(codes(run(`${good}</body></html>`, { gate: 'store' }))).not.toContain('no_reviews');
    expect(codes(run(`${good}</body></html>`, { gate: 'store', probes: product(false) }))).toContain('no_reviews');
    expect(codes(run(`${good}</body></html>`, { gate: 'store', probes: product(true) }))).not.toContain('no_reviews');
    expect(codes(run(`${good}</body></html>`, { gate: 'store', probes: product(null) }))).not.toContain('no_reviews');
    expect(codes(run(`${good}</body></html>`, { gate: 'store', probes: product(null, null) }))).not.toContain('no_reviews');
  });
  it('Weebly: signup and contact forms are drawn by JavaScript, so those checks are skipped', () => {
    const r = run(`${good}</body></html>`, { gate: 'store', page: { platform: 'Weebly' }, probes: { contact: { url: null, hasForm: false } } });
    expect(codes(r)).not.toContain('no_email_capture');
    expect(codes(r)).not.toContain('no_contact_form');
  });
  it('store gaps only for store niches; a signup form or tool prevents them', () => {
    const store = run(`${good}</body></html>`, { gate: 'store', probes: { product: { url: 'https://shop.example/products/a', hasReviews: false } } });
    expect(codes(store)).toEqual(expect.arrayContaining(['no_email_marketing_tool', 'no_email_capture', 'no_reviews']));
    expect(codes(run(`${good}</body></html>`, { gate: 'services' }))).not.toContain('no_email_marketing_tool');
    const withForm = run(`${good}<form><input type="email" name="contact[email]"></form></body></html>`, { gate: 'store' });
    expect(codes(withForm)).toContain('no_email_marketing_tool');
    expect(codes(withForm)).not.toContain('no_email_capture');
    const klaviyo = run(`${good}</body></html>`, { gate: 'store', techs: [{ name: 'Klaviyo', version: null, categories: ['Marketing automation'] }] });
    expect(codes(klaviyo)).not.toContain('no_email_marketing_tool');
    expect(codes(run(`${good}<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":4.8}}</script></body></html>`, { gate: 'store', probes: { product: { url: 'https://shop.example/products/a', hasReviews: false } } }))).not.toContain('no_reviews');
  });
  it('booking: tool, booking page, booking-tool link or booking-like external path all count', () => {
    const page = (internal: string[], external: string[]) => ({ links_internal: internal, links_external: external });
    expect(codes(run(good, { gate: 'booking', page: page(['https://shop.example/about'], []) }))).toContain('no_online_booking');
    expect(codes(run(good, { gate: 'booking', page: page(['https://shop.example/class-schedule'], []) }))).not.toContain('no_online_booking');
    expect(codes(run(good, { gate: 'booking', page: page([], ['https://clients.mindbodyonline.com/classic/ws?studioid=1']) }))).not.toContain('no_online_booking');
    expect(codes(run(good, { gate: 'booking', page: page([], ['https://squareup.com/appointments/book/abc']) }))).not.toContain('no_online_booking');
  });
  it('broken links: only 404/410; bot blocks and errors are not broken', () => {
    const links = [{ url: 'https://shop.example/a', status: 404 }, { url: 'https://shop.example/b', status: 403 }, { url: 'https://shop.example/c', status: 503 }];
    const r = run(good, { probes: { links } });
    expect(r.findings.find((f) => f.code === 'broken_links')?.evidence).toEqual({ broken: ['https://shop.example/a'] });
    expect(codes(run(good, { probes: { links: links.slice(1) } }))).not.toContain('broken_links');
  });
  it('http → https: 200 is a finding, 301 is fine, a proxy 405 is not a result', () => {
    expect(codes(run(good, { probes: { http: { status: 200, location: null } } }))).toContain('no_https_redirect');
    expect(codes(run(good, { probes: { http: { status: 301, location: 'https://shop.example/' } } }))).not.toContain('no_https_redirect');
    const proxy = run(good, { probes: { http: { status: 405, location: null } } });
    expect(codes(proxy)).not.toContain('no_https_redirect');
    expect(proxy.checks.https_redirect).toBe('skipped: http answered 405');
  });
  it('contact form: decided by the contact page; unreadable page = no finding', () => {
    expect(codes(run(good, { probes: { contact: { url: 'https://shop.example/contact', hasForm: false } } }))).toContain('no_contact_form');
    expect(codes(run(good, { probes: { contact: { url: 'https://shop.example/contact', hasForm: true } } }))).not.toContain('no_contact_form');
    expect(codes(run(good, { probes: { contact: null } }))).not.toContain('no_contact_form');
    expect(codes(run(`${good}<form><input type="email"><textarea></textarea></form></body></html>`, { probes: { contact: { url: null, hasForm: false } } }))).not.toContain('no_contact_form');
  });
  it('favicon: only a 4xx on /favicon.ico when no icon is declared', () => {
    const noIcon = good.replace('<link rel="icon" href="/f.png">', '');
    expect(codes(run(`${noIcon}</body></html>`, { probes: { favicon: { url: 'https://shop.example/favicon.ico', status: 404 } } }))).toContain('missing_favicon');
    expect(codes(run(`${noIcon}</body></html>`, { probes: { favicon: { url: 'https://shop.example/favicon.ico', status: 200 } } }))).not.toContain('missing_favicon');
    expect(codes(run(`${good}</body></html>`, { probes: { favicon: { url: 'x', status: 404 } } }))).not.toContain('missing_favicon');
  });
  it('without stored HTML the HTML checks are skipped, not guessed', () => {
    const r = lightAudit({ page: base(good), html: null, techs: [], gate: 'store', probes: {}, hosts, now }, rules);
    expect(r.checks.html).toMatch(/^skipped/);
    expect(codes(r)).not.toContain('no_email_capture');
    expect(codes(r)).not.toContain('no_reviews');
  });
});
