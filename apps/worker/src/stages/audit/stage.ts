import { datasetExists, datasetGlob, db, env, htmlFor, lakeQuery, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { registrableDomain } from '../../sources/normalize.js';
import { pickPages } from '../contacts/stage.js';
import { CrawlClient, HostLimiter, makeDispatcher } from '../fetch/client.js';
import { firstH1 } from '../fetch/extract.js';
import { RobotsCache } from '../fetch/robots.js';
import { loadBatch, type StagePlan } from '../plan.js';
import { TechEngine, deferredScriptUrls } from '../tech/engine.js';
import * as cheerio from 'cheerio';
import { hasContactForm, hasReviews, lightAudit, summarize, vendorHosts, type AuditRules, type PageInfo, type Probes, type Tech } from './light.js';

/**
 * Stage 9 — light audit for every in-scope lead. Reads the stored homepage features, HTML and
 * technologies, then makes a few small polite requests (robots.txt obeyed, per-site rate limit):
 * a sample of internal links, /favicon.ico when no icon is declared, http:// → https, and the
 * contact page when the homepage shows no form.
 */
export const auditPlan: StagePlan = {
  key: 'audit',
  defaults: { batch: 100, snapshot: 2000 },
  async todoSql() {
    if (!(await datasetExists('classified')) || !(await datasetExists('tech'))) return null;
    const done = (await datasetExists('audits')) ? `AND k.domain NOT IN (SELECT domain FROM read_parquet(${datasetGlob('audits')}))` : '';
    return `
      WITH k AS (SELECT domain, arg_max(in_scope, classified_at) AS in_scope, arg_max(niche, classified_at) AS niche
                 FROM read_parquet(${datasetGlob('classified')}) GROUP BY domain),
           t AS (SELECT DISTINCT domain FROM read_parquet(${datasetGlob('tech')})),
           p AS (SELECT domain, max(priority) AS priority FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass GROUP BY domain)
      SELECT k.domain, p.priority, k.niche FROM k JOIN p USING (domain) JOIN t USING (domain)
      WHERE k.in_scope ${done}`;
  },
};

interface Row { domain: string; priority: number; niche: string }

let engine: TechEngine | undefined;

/**
 * Technologies in script URLs that the tech stage could not see before 2026-11-25 (Shopify app loader,
 * lazy-loaded scripts). Leads analysed earlier get them here, so the audit does not report a missing tool
 * that is actually installed.
 */
export function deferredTechs(e: TechEngine, url: string, html: string): Tech[] {
  const urls = deferredScriptUrls(cheerio.load(html), html);
  if (!urls.length) return [];
  return e.analyze({ url, html: urls.map((u) => `<script src="${u.replace(/"/g, '%22')}"></script>`).join(''), headers: {}, cookies: [] });
}

const sameSite = (a: string, b: string) => {
  const ra = registrableDomain(new URL(a).hostname);
  const rb = registrableDomain(new URL(b).hostname);
  return 'domain' in ra && 'domain' in rb && ra.domain === rb.domain;
};

/** Up to n internal links spread over the list (not just the first n, which are usually the menu). */
export function sampleLinks(links: string[], finalUrl: string, n: number): string[] {
  const home = new URL(finalUrl);
  const seen = new Set<string>([`${home.origin}${home.pathname}`]);
  const pool: string[] = [];
  for (const raw of links) {
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol) || !sameSite(finalUrl, u.href)) continue;
      if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) continue;
      if (/\/(cart|checkout|account|login|wp-admin|wp-login|logout|search)(\/|$|\?)/i.test(u.pathname)) continue;
      const key = `${u.origin}${u.pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(`${u.origin}${u.pathname}${u.search}`);
    } catch {
      /* skip malformed */
    }
  }
  if (pool.length <= n) return pool;
  return Array.from({ length: n }, (_, i) => pool[Math.floor((i * pool.length) / n)]!);
}

export async function runAuditBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Row>('audit', snapshot, batch);
  const rules = await setting<AuditRules | null>('audit.rules', null);
  if (!rules) throw new Error('setting audit.rules is missing');
  const perHostRps = await setting<number>('http.per_host_rps', 1);
  const limiter = new HostLimiter(Math.ceil(1000 / perHostRps));
  const timeoutMs = await setting<number>('http.timeout_ms', 10_000);
  // Probes only need the status line and a small page; cap downloads at 256 KB.
  const client = new CrawlClient(makeDispatcher(), limiter, { timeoutMs, maxBytes: 256_000, maxRedirects: 3 });
  const contactClient = new CrawlClient(makeDispatcher(), limiter, { timeoutMs, maxBytes: await setting<number>('fetch.max_body_bytes', 2_000_000), maxRedirects: 3 });
  const robots = new RobotsCache(client, env().CRAWLER_NAME);
  const hosts = { booking: vendorHosts(rules.booking_categories), forms: vendorHosts(rules.form_categories), reviews: vendorHosts(rules.review_categories) };
  engine ??= new TechEngine();
  const gates = new Map((await db().query<{ key: string; gate: string }>('SELECT key, gate FROM niches')).rows.map((r) => [r.key, r.gate]));

  const list = rows.map((r) => sqlLiteral(r.domain)).join(', ');
  const pages = new Map<string, PageInfo & { start_url: string }>();
  const techs = new Map<string, Tech[]>();
  if (rows.length) {
    for (const p of await lakeQuery<any>(`
      SELECT domain, arg_max(start_url, fetched_at) start_url, arg_max(final_url, fetched_at) final_url, arg_max(title, fetched_at) title,
             arg_max(meta_description, fetched_at) meta_description, arg_max(h1, fetched_at) h1, arg_max(viewport, fetched_at) viewport,
             arg_max(ttfb_ms, fetched_at) ttfb_ms, arg_max(html_bytes, fetched_at) html_bytes, arg_max(script_src, fetched_at) script_src,
             arg_max(links_internal, fetched_at) links_internal, arg_max(links_external, fetched_at) links_external,
             arg_max(copyright_year, fetched_at) copyright_year, arg_max(platform, fetched_at) platform
      FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass AND domain IN (${list}) GROUP BY domain`)) {
      pages.set(p.domain, { ...p, script_src: p.script_src ?? [], links_internal: p.links_internal ?? [], links_external: p.links_external ?? [] });
    }
    for (const t of await lakeQuery<{ domain: string; techs: string }>(
      `SELECT domain, arg_max(techs, analyzed_at) techs FROM read_parquet(${datasetGlob('tech')}) WHERE domain IN (${list}) GROUP BY domain`)) {
      techs.set(t.domain, JSON.parse(t.techs ?? '[]'));
    }
  }
  const html = new Map<string, string>();
  for (const h of await htmlFor(rows.map((r) => r.domain))) {
    html.set(h.domain, h.html);
    const start = pages.get(h.domain)?.start_url;
    if (h.robots_txt && start) robots.prime(new URL(start).origin, h.robots_txt);
  }

  return withRun('stage.audit', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = [];
    const get = async (c: CrawlClient, url: string, origin: string) => {
      if (!(await robots.check(url)).allowed) return null;
      return c.get(url, 'html', async (next) => new URL(next).origin === origin || sameSite(url, next));
    };

    const one = async (row: Row) => {
      const page = pages.get(row.domain);
      if (!page) {
        run.drop('no_page_features');
        return;
      }
      const origin = new URL(page.final_url).origin;
      const homeHtml = html.get(row.domain) ?? null;
      // Pages fetched before 2026-11-25 saved only the first H1 (often an image-only logo): read it again.
      if (homeHtml && !page.h1?.trim()) page.h1 = firstH1(cheerio.load(homeHtml));
      const ts = [...(techs.get(row.domain) ?? [])];
      const added: Tech[] = [];
      if (homeHtml) {
        for (const t of deferredTechs(engine!, page.final_url, homeHtml)) {
          if (ts.some((x) => x.name === t.name)) continue;
          ts.push(t);
          added.push(t);
        }
      }
      const probes: Probes = {};

      // Broken-link sample.
      const sample = sampleLinks(page.links_internal, page.final_url, rules.broken_link_sample);
      if (sample.length) {
        probes.links = [];
        for (const url of sample) {
          try {
            const r = await get(client, url, origin);
            if (r) probes.links.push({ url, status: r.status });
          } catch {
            /* timeouts are not broken links */
          }
        }
      }
      // Favicon: only when the page declares none.
      if (rules.check_favicon && homeHtml && !/<link[^>]+rel=["'][^"']*\bicon\b/i.test(homeHtml)) {
        const url = `${origin}/favicon.ico`;
        try {
          const r = await get(client, url, origin);
          probes.favicon = r ? { url, status: r.status } : null;
        } catch {
          probes.favicon = null;
        }
      }
      // http:// → https (one request, redirect not followed).
      if (rules.check_http_redirect && page.final_url.startsWith('https://')) {
        try {
          const httpUrl = `http://${new URL(page.final_url).host}/`;
          const r = await client.get(httpUrl, 'html', async () => false);
          probes.http = { status: r.status, location: r.status >= 300 && r.status < 400 ? r.url : null };
        } catch {
          probes.http = null;
        }
      }
      // Contact page, only when the homepage has no form and no form tool.
      const formTool = ts.some((t) => t.categories.some((c) => rules.form_categories.includes(c)));
      if (rules.check_contact_page && homeHtml && !formTool && !hasContactForm(homeHtml, hosts.forms)
          && !(rules.contact_form_skip_platforms ?? []).includes(page.platform ?? '')) {
        const contact = pickPages(page.links_internal, page.final_url, 7).find((p) => p.kind === 'contact');
        if (!contact) probes.contact = { url: null, hasForm: false };
        else {
          try {
            const r = await get(contactClient, contact.url, origin);
            probes.contact = r && r.status === 200 && r.body.length
              ? { url: contact.url, hasForm: hasContactForm(r.body.toString('utf8'), hosts.forms) }
              : null;
          } catch {
            probes.contact = null;
          }
        }
      }

      // Store: one product page, only when the homepage shows no reviews (reviews live on product pages).
      const gate = gates.get(row.niche) ?? null;
      if (gate && rules.store_gates.includes(gate) && homeHtml
          && !ts.some((t) => t.categories.some((c) => rules.review_categories.includes(c))) && !hasReviews(homeHtml, hosts.reviews)) {
        const re = new RegExp(rules.product_path_pattern ?? '^/(products|product)/[^/?#]+/?$', 'i');
        const productUrl = page.links_internal.find((u) => {
          try {
            const x = new URL(u);
            return sameSite(page.final_url, u) && re.test(x.pathname);
          } catch {
            return false;
          }
        });
        if (!productUrl) probes.product = { url: null, hasReviews: null };
        else {
          try {
            const r = await get(contactClient, productUrl, origin);
            probes.product = r && r.status === 200 && r.body.length
              ? { url: productUrl, hasReviews: hasReviews(r.body.toString('utf8'), hosts.reviews) }
              : { url: productUrl, hasReviews: null };
          } catch {
            probes.product = { url: productUrl, hasReviews: null };
          }
        }
      }

      const res = lightAudit({ page, html: homeHtml, techs: ts, gate, probes, hosts }, rules);
      out.push({
        domain: row.domain, audited_at: new Date().toISOString(), niche: row.niche, platform: page.platform,
        findings: JSON.stringify(res.findings), codes: res.findings.map((f) => f.code),
        summary: JSON.stringify(summarize(res.findings)), metrics: JSON.stringify(res.metrics), checks: JSON.stringify(res.checks),
        added_techs: JSON.stringify(added),
      });
    };

    let next = 0;
    await Promise.all(Array.from({ length: Math.min(50, rows.length || 1) }, async () => {
      while (next < rows.length) await one(rows[next++]!);
    }));

    await writeParquet('audits', out, {
      name: `audit-${snapshot}-${batch}`,
      columns: { domain: 'VARCHAR', audited_at: 'TIMESTAMP', niche: 'VARCHAR', platform: 'VARCHAR', findings: 'VARCHAR', codes: 'VARCHAR[]',
        summary: 'VARCHAR', metrics: 'VARCHAR', checks: 'VARCHAR', added_techs: 'VARCHAR' },
    });

    // Postgres: replace this batch's light findings (idempotent re-runs); Lighthouse findings are kept.
    const domains = out.map((o) => o.domain as string);
    const client2 = await db().connect();
    try {
      await client2.query('BEGIN');
      await client2.query(
        `INSERT INTO audits (domain_id, light_audit, audited_at)
         SELECT d.id, jsonb_build_object('summary', x.s::jsonb, 'metrics', x.m::jsonb, 'checks', x.c::jsonb), now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(domain, s, m, c) JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id) DO UPDATE SET light_audit = EXCLUDED.light_audit, audited_at = now()`,
        [domains, out.map((o) => o.summary), out.map((o) => o.metrics), out.map((o) => o.checks)],
      );
      await client2.query(`DELETE FROM audit_findings f USING domains d WHERE f.domain_id = d.id AND d.domain = ANY($1::text[]) AND f.source = 'light'`, [domains]);
      const fd: string[] = [], code: string[] = [], sev: string[] = [], msg: string[] = [], ev: string[] = [];
      for (const o of out) {
        for (const f of JSON.parse(o.findings as string) as { code: string; severity: string; message: string; evidence: unknown }[]) {
          fd.push(o.domain as string); code.push(f.code); sev.push(f.severity); msg.push(f.message); ev.push(JSON.stringify(f.evidence));
        }
      }
      await client2.query(
        `INSERT INTO audit_findings (domain_id, code, severity, message, evidence, source)
         SELECT d.id, x.code, x.sev, x.msg, x.ev::jsonb, 'light'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(domain, code, sev, msg, ev) JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id, code) DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, evidence = EXCLUDED.evidence, source = 'light'`,
        [fd, code, sev, msg, ev],
      );
      // Technologies found in deferred script URLs (see deferredTechs) are added to the lead's stack.
      const td: string[] = [], tn: string[] = [], tc: string[] = [], tv: (string | null)[] = [];
      for (const o of out) for (const t of JSON.parse(o.added_techs as string) as Tech[]) {
        td.push(o.domain as string); tn.push(t.name); tc.push(t.categories.join(String.fromCharCode(31))); tv.push(t.version);
      }
      await client2.query(
        `INSERT INTO technologies (domain_id, tech, categories, version, confidence, source)
         SELECT d.id, x.tech, string_to_array(x.cats, chr(31)), x.version, 100, 'html'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(domain, tech, cats, version) JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id, tech) DO NOTHING`,
        [td, tn, tc, tv],
      );
      await client2.query('COMMIT');
    } catch (e) {
      await client2.query('ROLLBACK');
      throw e;
    } finally {
      client2.release();
    }
    run.inCount = rows.length;
    run.outCount = out.length;
    return { audited: out.length, findings: out.reduce((n, o) => n + (o.codes as string[]).length, 0) };
  });
}
