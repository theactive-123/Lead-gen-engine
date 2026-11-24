import { existsSync } from 'node:fs';
import { datasetExists, datasetGlob, db, env, logger, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { registrableDomain } from '../../sources/normalize.js';
import { REGISTRY_FILE } from '../normalize.js';
import { loadBatch, type StagePlan } from '../plan.js';
import { loadSignatures, matchSignatures } from '../dns/stage.js';
import { CrawlClient, HostLimiter, makeDispatcher } from './client.js';
import { extractFeatures, type PageFeatures } from './extract.js';
import { detectPlatforms, primaryPlatform } from './platform.js';
import { RobotsCache } from './robots.js';
import { loadTagRules, tagPage } from './tags.js';

/**
 * Stage 3 — homepage fetch for every domain whose DNS resolves.
 * Writes features to data/lake/pages, compressed HTML to data/lake/html (kept N days),
 * and upserts passing domains (live, not parked/placeholder) into the Postgres `domains` table.
 */
export const fetchPlan: StagePlan = {
  key: 'fetch',
  defaults: { batch: 400, snapshot: 4000 },
  // Backpressure: HTML is kept only a few days, so don't fetch faster than fingerprinting keeps up.
  async hold() {
    const { techBacklog } = await import('../tech/stage.js');
    const max = await setting<number>('stage.fetch.max_tech_backlog', 20_000);
    const backlog = await techBacklog();
    return backlog > max ? `technology detection backlog ${backlog} > ${max}` : null;
  },
  async todoSql() {
    if (!(await datasetExists('dns')) || !existsSync(REGISTRY_FILE())) return null;
    const done = (await datasetExists('pages')) ? `AND d.domain NOT IN (SELECT domain FROM read_parquet(${datasetGlob('pages')}))` : '';
    return `
      SELECT d.domain, r.priority, len(d.a) > 0 AS apex_ok, d.a, d.www_cname, d.www_a, d.mx, d.ns,
             r.first_seen, r.sources
      FROM read_parquet(${datasetGlob('dns')}) d JOIN read_parquet(${sqlLiteral(REGISTRY_FILE())}) r USING (domain)
      WHERE d.pass ${done}`;
  },
};

interface Row {
  domain: string; priority: number; apex_ok: boolean; first_seen: string; sources: string[];
  a: string[]; www_cname: string[]; www_a: string[]; mx: string[]; ns: string[];
  dns?: Record<string, string | null>; // signature matches, computed with the CURRENT rules
}

const sameSite = (a: string, b: string) => {
  const x = registrableDomain(new URL(a).hostname);
  const y = registrableDomain(new URL(b).hostname);
  return 'domain' in x && 'domain' in y && x.domain === y.domain;
};

export function errorKind(err: unknown): string {
  const e = err as { name?: string; code?: unknown; message?: string; cause?: { code?: string } };
  // Timeouts arrive as DOMException "TimeoutError"/"AbortError" (numeric code) or undici *_TIMEOUT codes.
  const code = [e.name, typeof e.code === 'string' ? e.code : '', e.cause?.code, e.message].filter(Boolean).join(' ');
  if (/timeout|aborted/i.test(code)) return 'timeout';
  if (/CERT|SSL|TLS|SELF_SIGNED|ERR_TLS/i.test(code)) return 'tls_error';
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return 'dns_error';
  if (/ECONNREFUSED|ECONNRESET|EPIPE|SOCKET|UND_ERR/i.test(code)) return 'connection_error';
  return 'network_error';
}

export async function runFetchBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Row>('fetch', snapshot, batch);
  // DNS platform / mail provider from the stored records with today's rules (no re-lookup needed).
  const sigs = await loadSignatures();
  for (const r of rows) r.dns = matchSignatures({ ...r, a: r.a ?? [], www_cname: r.www_cname ?? [], www_a: r.www_a ?? [], mx: r.mx ?? [], ns: r.ns ?? [] }, sigs);
  const maxConcurrency = await setting<number>('http.global_concurrency', 200);
  const perHostRps = await setting<number>('http.per_host_rps', 1);
  const timeoutMs = await setting<number>('http.timeout_ms', 10_000);
  const client = new CrawlClient(makeDispatcher(), new HostLimiter(Math.ceil(1000 / perHostRps)), {
    timeoutMs,
    maxBytes: await setting<number>('fetch.max_body_bytes', 2_000_000),
    maxRedirects: await setting<number>('fetch.max_redirects', 3),
  });
  const robots = new RobotsCache(client, env().CRAWLER_NAME);
  const rules = await loadTagRules();

  return withRun('stage.fetch', { snapshot, batch }, async (run) => {
    const pages: Record<string, unknown>[] = [];
    const htmls: Record<string, unknown>[] = [];

    const one = async (row: Row) => {
      const out: Record<string, unknown> = { domain: row.domain, fetched_at: new Date().toISOString() };
      const starts = row.apex_ok
        ? [`https://${row.domain}/`, `http://${row.domain}/`]
        : [`https://www.${row.domain}/`, `http://www.${row.domain}/`];
      let lastErr = '';
      for (const start of starts) {
        try {
          const r0 = await robots.check(start);
          out.robots = r0.reason;
          if (!r0.allowed) {
            out.fetch_status = r0.reason === 'rules' ? 'robots_disallowed' : 'robots_unavailable';
            if (r0.reason === 'robots_unavailable') {
              // Site unreachable on this scheme. Remember why (e.g. broken HTTPS certificate), then try http://.
              lastErr = r0.error ? errorKind(r0.error) : 'robots_unavailable';
              if (start.startsWith('https://')) out.https_error = lastErr;
              continue;
            }
            break;
          }
          let offsite: string | null = null;
          const res = await client.get(start, 'html', async (next) => {
            if (!sameSite(start, next)) { offsite = next; return false; }
            return (await robots.check(next)).allowed;
          });
          out.start_url = start;
          out.final_url = res.url;
          out.http_status = res.status;
          out.ttfb_ms = res.ttfbMs;
          out.total_ms = res.totalMs;
          out.redirects = res.redirects.length;
          out.content_type = res.contentType;
          out.server = res.headers.server ?? null;
          out.https = res.url.startsWith('https://');
          out.html_bytes = res.body.length;
          out.truncated = res.truncated;
          if (offsite) {
            const t = registrableDomain(new URL(offsite).hostname);
            out.fetch_status = 'offsite_redirect';
            out.redirect_domain = 'domain' in t ? t.domain : null;
          } else if (res.status >= 300 && res.status < 400) out.fetch_status = 'redirect_blocked';
          else if (res.status >= 400) out.fetch_status = 'http_error';
          else if (!res.body.length) out.fetch_status = res.contentType && !res.contentType.includes('html') ? 'non_html' : 'empty';
          else {
            const html = res.body.toString('utf8');
            const cookieNames = res.setCookies.map((c) => c.split('=')[0]!.trim().toLowerCase());
            let found: ReturnType<typeof detectPlatforms> = [];
            const f: PageFeatures = extractFeatures(html, res.url, ($, ev) => {
              found = detectPlatforms({ url: res.url, html, $, scriptSrc: ev.scriptSrc, meta: ev.meta, headers: res.headers, cookieNames });
            });
            const tag = tagPage(rules, { title: f.title, text: f.text_sample, url: res.url, words: f.word_count });
            if (f.word_count < 20) tag.tags.push(f.script_src.length > 3 ? 'js_only' : 'thin');
            Object.assign(out, {
              fetch_status: 'ok',
              title: f.title, meta_description: f.meta_description, h1: f.h1, lang: f.lang, site_name: f.site_name,
              generator: f.generator, viewport: f.viewport, canonical: f.canonical, text_sample: f.text_sample,
              word_count: f.word_count, links_internal: f.links_internal, links_external: f.links_external,
              script_src: f.script_src, style_href: f.style_href, meta: JSON.stringify(f.meta), jsonld: f.jsonld,
              jsonld_types: f.jsonld_types, copyright_year: f.copyright_year, has_form: f.has_form, img_count: f.img_count,
              platform: primaryPlatform(found), platforms: JSON.stringify(found), dns_platform: row.dns?.platform ?? null, tags: tag.tags, tag_drop: tag.drops,
            });
            htmls.push({
              domain: row.domain, final_url: res.url, fetched_at: out.fetched_at, headers: JSON.stringify(res.headers),
              cookies: res.setCookies.map((c) => c.split(';')[0]!.slice(0, 300)), html, robots_txt: r0.text ?? null,
            });
          }
          lastErr = '';
          break;
        } catch (err) {
          lastErr = errorKind(err);
          if (start.startsWith('https://')) out.https_error = lastErr;
          out.error = String((err as Error).message ?? err).slice(0, 200);
        }
      }
      if (lastErr && !out.fetch_status) out.fetch_status = lastErr;
      if (lastErr && out.fetch_status === 'robots_unavailable') out.fetch_status = lastErr;
      // This cloud sandbox's proxy refuses plain-http requests with a bare 405 (not a real site answer).
      if (process.env.HTTPS_PROXY && String(out.start_url ?? '').startsWith('http://') && out.http_status === 405 && !out.server) {
        out.fetch_status = 'sandbox_http_blocked';
      }
      out.pass = out.fetch_status === 'ok' && Number(out.http_status) < 300 && !out.tag_drop;
      out.priority = row.priority;
      pages.push(out);
      return out;
    };

    // Adaptive concurrency: halve when >40% of recent requests time out, else creep back up.
    let limit = Math.min(maxConcurrency, rows.length);
    let active = 0;
    let next = 0;
    const recent: boolean[] = [];
    await new Promise<void>((resolve) => {
      const pump = () => {
        if (next >= rows.length && active === 0) return resolve();
        while (active < limit && next < rows.length) {
          const row = rows[next++]!;
          active++;
          one(row)
            .then((o) => {
              recent.push(o.fetch_status === 'timeout');
              if (recent.length >= 50) {
                const rate = recent.filter(Boolean).length / recent.length;
                const before = limit;
                limit = rate > 0.4 ? Math.max(10, Math.floor(limit / 2)) : Math.min(maxConcurrency, limit + 10);
                if (limit < before) logger.warn({ timeoutRate: rate, concurrency: limit }, 'fetch backing off');
                recent.length = 0;
              }
            })
            .catch((err) => logger.error({ err, domain: row.domain }, 'fetch task crashed'))
            .finally(() => {
              active--;
              pump();
            });
        }
      };
      pump();
    });

    // Store: features + HTML to the lake (idempotent names), passing domains to Postgres.
    await writeParquet('pages', pages, {
      name: `fetch-${snapshot}-${batch}`,
      columns: {
        domain: 'VARCHAR', fetched_at: 'TIMESTAMP', robots: 'VARCHAR', start_url: 'VARCHAR', final_url: 'VARCHAR', http_status: 'INTEGER',
        ttfb_ms: 'INTEGER', total_ms: 'INTEGER', redirects: 'INTEGER', content_type: 'VARCHAR', server: 'VARCHAR', https: 'BOOLEAN',
        html_bytes: 'INTEGER', truncated: 'BOOLEAN', fetch_status: 'VARCHAR', https_error: 'VARCHAR', redirect_domain: 'VARCHAR', error: 'VARCHAR',
        title: 'VARCHAR', meta_description: 'VARCHAR', h1: 'VARCHAR', lang: 'VARCHAR', site_name: 'VARCHAR', generator: 'VARCHAR',
        viewport: 'BOOLEAN', canonical: 'VARCHAR', text_sample: 'VARCHAR', word_count: 'INTEGER', links_internal: 'VARCHAR[]',
        links_external: 'VARCHAR[]', script_src: 'VARCHAR[]', style_href: 'VARCHAR[]', meta: 'VARCHAR', jsonld: 'VARCHAR[]',
        jsonld_types: 'VARCHAR[]', copyright_year: 'INTEGER', has_form: 'BOOLEAN', img_count: 'INTEGER', platform: 'VARCHAR',
        platforms: 'VARCHAR', dns_platform: 'VARCHAR', tags: 'VARCHAR[]', tag_drop: 'BOOLEAN', pass: 'BOOLEAN', priority: 'INTEGER',
      },
    });
    await writeParquet('html', htmls, {
      name: `fetch-${snapshot}-${batch}`,
      columns: { domain: 'VARCHAR', final_url: 'VARCHAR', fetched_at: 'TIMESTAMP', headers: 'VARCHAR', cookies: 'VARCHAR[]', html: 'VARCHAR', robots_txt: 'VARCHAR' },
    });

    const byDomain = new Map(rows.map((r) => [r.domain, r]));
    const pass = pages.filter((p) => p.pass);
    if (pass.length) {
      const col = <T>(fn: (p: Record<string, unknown>, r: Row) => T) => pass.map((p) => fn(p, byDomain.get(String(p.domain))!));
      await db().query(
        `INSERT INTO domains (domain, first_seen, sources, priority, platform, has_mx, mx_provider, final_url, http_status, title, lang, tags, stage_status, fetched_at, updated_at)
         SELECT d, fs::date, string_to_array(src, ','), pr, pl, mx IS NOT NULL, mx, fu, hs, ti, la, string_to_array(tg, ','), 'fetched', now(), now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[], $10::text[], $11::text[])
           AS t(d, fs, src, pr, pl, mx, fu, hs, ti, la, tg)
         ON CONFLICT (domain) DO UPDATE SET
           sources = EXCLUDED.sources, priority = EXCLUDED.priority, platform = EXCLUDED.platform, has_mx = EXCLUDED.has_mx,
           mx_provider = EXCLUDED.mx_provider, final_url = EXCLUDED.final_url, http_status = EXCLUDED.http_status, title = EXCLUDED.title,
           lang = EXCLUDED.lang, tags = EXCLUDED.tags, stage_status = 'fetched', drop_reason = NULL, fetched_at = now(), updated_at = now()`,
        [
          col((p) => String(p.domain)),
          col((_, r) => new Date(r.first_seen as unknown as string).toISOString().slice(0, 10)),
          col((_, r) => (r.sources ?? []).join(',')),
          col((_, r) => r.priority),
          col((p, r) => (p.platform as string | null) ?? r.dns?.platform ?? null),
          col((_, r) => ((r.mx ?? []).length ? (r.dns?.mx_provider ?? 'other') : null)),
          col((p) => (p.final_url as string) ?? null),
          col((p) => Number(p.http_status)),
          col((p) => (p.title as string | null) ?? null),
          col((p) => (p.lang as string | null) ?? null),
          col((p) => ((p.tags as string[]) ?? []).join(',')),
        ],
      );
    }

    run.inCount = rows.length;
    run.outCount = pass.length;
    for (const p of pages) if (!p.pass) run.drop(p.fetch_status === 'ok' ? `tag:${(p.tags as string[]).join('+') || 'non_2xx'}` : String(p.fetch_status));
    return { domains: rows.length, pass: pass.length };
  });
}
