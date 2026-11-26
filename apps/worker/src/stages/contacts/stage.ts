import type { CountryCode } from 'libphonenumber-js';
import { datasetExists, datasetGlob, db, env, htmlFor, setting, withRun, writeParquet } from '@lead/shared';
import { registrableDomain } from '../../sources/normalize.js';
import { dohClient, udpClient } from '../dns/resolver.js';
import { CrawlClient, HostLimiter, makeDispatcher } from '../fetch/client.js';
import { RobotsCache } from '../fetch/robots.js';
import { currentSql, loadBatch, type StagePlan } from '../plan.js';
import { emailType, extractContacts, type EmailType, type PageContacts } from './extract.js';

/**
 * Stage 7 — contacts for in-scope leads: homepage (stored) + up to N pages chosen from its links
 * (contact, about, team, privacy, terms, impressum, wholesale) + sitemap.xml (page count = size signal).
 * Same politeness as the homepage fetch. Email validation = syntax + the email domain has MX records.
 */
export const contactsPlan: StagePlan = {
  key: 'contacts',
  defaults: { batch: 100, snapshot: 2000 },
  async todoSql() {
    if (!(await datasetExists('classified'))) return null;
    const done = (await datasetExists('contacts')) ? `AND k.domain NOT IN (${currentSql({ dataset: 'contacts', ts: 'extracted_at' }, [{ dataset: 'classified', ts: 'classified_at' }])})` : '';
    const probe = (await datasetExists('store_probe'))
      ? `LEFT JOIN (SELECT domain, arg_max(country, probed_at) AS store_country FROM read_parquet(${datasetGlob('store_probe')}) GROUP BY domain) s USING (domain)`
      : `LEFT JOIN (SELECT NULL::VARCHAR AS domain, NULL::VARCHAR AS store_country) s USING (domain)`;
    return `
      WITH k AS (SELECT domain, arg_max(in_scope, classified_at) AS in_scope FROM read_parquet(${datasetGlob('classified')}) GROUP BY domain),
           p AS (SELECT domain, max(priority) AS priority, arg_max(final_url, fetched_at) AS final_url, arg_max(links_internal, fetched_at) AS links_internal
                 FROM read_parquet(${datasetGlob('pages')}, union_by_name = true)
                 WHERE pass AND domain IN (SELECT domain FROM k WHERE in_scope) GROUP BY domain) -- link lists only for in-niche sites
      SELECT k.domain, p.priority, p.final_url, p.links_internal, s.store_country
      FROM k JOIN p USING (domain) ${probe}
      WHERE k.in_scope ${done}`;
  },
};

const PAGE_KINDS: [string, RegExp][] = [
  ['contact', /\/(contact|contact-us|contactus|get-in-touch|kontakt|contacto)(\/|$|\.)/i],
  ['about', /\/(about|about-us|our-story|who-we-are|our-team-and-story)(\/|$|\.)/i],
  ['team', /\/(team|our-team|meet-the-team|staff|people)(\/|$|\.)/i],
  ['privacy', /\/(privacy|privacy-policy|policies\/privacy-policy)(\/|$|\.)/i],
  ['impressum', /\/(impressum|imprint|legal-notice|mentions-legales)(\/|$|\.)/i],
  ['terms', /\/(terms|terms-of-service|terms-and-conditions|tos|policies\/terms-of-service)(\/|$|\.)/i],
  ['wholesale', /\/(wholesale|stockists|partners|trade)(\/|$|\.)/i],
];

/** Up to `max` same-site pages, one per kind, in priority order. */
export function pickPages(links: string[], finalUrl: string, max: number): { kind: string; url: string }[] {
  const site = registrableDomain(new URL(finalUrl).hostname);
  const out: { kind: string; url: string }[] = [];
  for (const [kind, re] of PAGE_KINDS) {
    if (out.length >= max) break;
    const hit = links.find((u) => {
      try {
        const x = new URL(u);
        const r = registrableDomain(x.hostname);
        return 'domain' in r && 'domain' in site && r.domain === site.domain && re.test(x.pathname);
      } catch {
        return false;
      }
    });
    if (hit && !out.some((o) => o.url === hit)) out.push({ kind, url: hit.split('#')[0]! });
  }
  return out;
}

const GENERIC_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'shop', 'store', 'info', 'biz', 'app', 'dev', 'online', 'site', 'xyz', 'me', 'tv', 'ai']);
/** Country hint for reading local phone numbers: store country, else a country-code TLD. */
export function countryHint(domain: string, storeCountry: string | null): CountryCode | undefined {
  if (storeCountry && /^[A-Z]{2}$/.test(storeCountry)) return storeCountry as CountryCode;
  const tld = domain.split('.').pop()!.toLowerCase();
  if (tld === 'uk') return 'GB';
  if (tld.length === 2 && !GENERIC_TLDS.has(tld)) return tld.toUpperCase() as CountryCode;
  return undefined;
}

interface Row { domain: string; priority: number; final_url: string; links_internal: string[] | null; store_country: string | null }

export async function runContactsBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Row>('contacts', snapshot, batch);
  const maxPages = await setting<number>('contacts.max_pages', 5);
  const perHostRps = await setting<number>('http.per_host_rps', 1);
  const client = new CrawlClient(makeDispatcher(), new HostLimiter(Math.ceil(1000 / perHostRps)), {
    timeoutMs: await setting<number>('http.timeout_ms', 10_000),
    maxBytes: await setting<number>('fetch.max_body_bytes', 2_000_000),
    maxRedirects: 3,
  });
  const robots = new RobotsCache(client, env().CRAWLER_NAME);
  const dnsTimeout = await setting<number>('dns.timeout_ms', 4000);
  const dns = (process.env.DNS_MODE ?? (await setting<string>('dns.mode', 'udp'))) === 'doh'
    ? dohClient(await setting<string[]>('dns.doh_endpoints', ['https://cloudflare-dns.com/dns-query']), dnsTimeout)
    : udpClient(await setting<string[]>('dns.servers', ['1.1.1.1', '8.8.8.8']), dnsTimeout);

  // Stored homepages (kept a few days) save one request per lead.
  const home = new Map<string, string>();
  for (const h of await htmlFor(rows.map((r) => r.domain))) home.set(h.domain, h.html);

  return withRun('stage.contacts', { snapshot, batch }, async (run) => {
    const results: Record<string, unknown>[] = [];

    const one = async (row: Row) => {
      const country = countryHint(row.domain, row.store_country);
      const found: PageContacts[] = [];
      const fetched: string[] = [];
      const fetchPage = async (url: string): Promise<string | null> => {
        try {
          if (!(await robots.check(url)).allowed) return null;
          const origin = new URL(url).origin;
          const r = await client.get(url, 'html', async (next) => new URL(next).origin === origin || sameSite(url, next));
          return r.status === 200 && r.body.length ? r.body.toString('utf8') : null;
        } catch {
          return null;
        }
      };
      const homeHtml = home.get(row.domain) ?? (await fetchPage(row.final_url));
      if (homeHtml) found.push(extractContacts(homeHtml, row.final_url, { defaultCountry: country, textPhones: false }));
      for (const p of pickPages(row.links_internal ?? [], row.final_url, maxPages)) {
        const html = await fetchPage(p.url);
        if (!html) continue;
        fetched.push(p.kind);
        // Phone numbers in running text are only trusted on contact / about / legal pages.
        found.push(extractContacts(html, p.url, {
          defaultCountry: country,
          textPhones: ['contact', 'about', 'impressum'].includes(p.kind),
          people: !['privacy', 'terms'].includes(p.kind), // legal pages name other companies (e.g. Google Ireland Limited)
        }));
      }
      // sitemap.xml: number of URLs (size signal). Not followed into child sitemaps.
      let sitemap: { kind: string; count: number } | null = null;
      try {
        const url = `${new URL(row.final_url).origin}/sitemap.xml`;
        if ((await robots.check(url)).allowed) {
          const r = await client.get(url, 'text');
          if (r.status === 200) {
            const x = r.body.toString('utf8');
            sitemap = { kind: /<sitemapindex/i.test(x) ? 'index' : 'urlset', count: (x.match(/<loc>/gi) ?? []).length };
          }
        }
      } catch {
        /* no sitemap */
      }
      results.push(merge(row, found, fetched, sitemap));
    };

    let next = 0;
    await Promise.all(Array.from({ length: Math.min(50, rows.length || 1) }, async () => {
      while (next < rows.length) await one(rows[next++]!);
    }));

    // Validate email domains once each: syntax already checked, now "does the domain accept mail" (MX).
    const domains = [...new Set(results.flatMap((r) => (r.all_emails as { email: string }[]).map((e) => e.email.split('@')[1]!)))];
    const mx = new Map<string, boolean>();
    await Promise.all(domains.map(async (d) => mx.set(d, (await dns.query(d, 'MX')).values.length > 0)));
    for (const r of results) {
      const emails = r.all_emails as { email: string; mx_ok?: boolean }[];
      for (const e of emails) e.mx_ok = mx.get(e.email.split('@')[1]!) ?? false;
      const best = emails.find((e) => e.mx_ok) ?? null; // best = highest confidence that can receive mail
      Object.assign(r, best
        ? { email: best.email, email_type: (best as any).type, email_confidence: (best as any).confidence, email_source_url: (best as any).source, mx_ok: true }
        : { email: null, email_type: null, email_confidence: null, email_source_url: null, mx_ok: emails.length ? false : null });
      r.completeness = [r.email, r.phone, r.owner_name, r.address].filter(Boolean).length / 4;
      r.all_emails = JSON.stringify(emails);
    }

    await writeParquet('contacts', results, {
      name: `contacts-${snapshot}-${batch}`,
      columns: {
        domain: 'VARCHAR', extracted_at: 'TIMESTAMP', email: 'VARCHAR', email_type: 'VARCHAR', email_confidence: 'DOUBLE',
        email_source_url: 'VARCHAR', mx_ok: 'BOOLEAN', all_emails: 'VARCHAR', phone: 'VARCHAR', phone_source: 'VARCHAR',
        all_phones: 'VARCHAR[]', owner_name: 'VARCHAR', owner_title: 'VARCHAR', owner_source: 'VARCHAR', owner_confidence: 'DOUBLE',
        address: 'VARCHAR', socials: 'VARCHAR', org_name: 'VARCHAR', pages_fetched: 'VARCHAR[]', sitemap_kind: 'VARCHAR',
        sitemap_count: 'INTEGER', completeness: 'DOUBLE',
      },
    });

    const col = (f: (r: Record<string, any>) => unknown) => results.map(f);
    await db().query(
      `INSERT INTO contacts (domain_id, email, email_type, email_confidence, email_source_url, mx_ok, all_emails, phone, phone_source,
         owner_name, owner_title, owner_source, address, socials, completeness, extracted_at)
       SELECT d.id, x.email, x.et, x.ec, x.es, x.mx, x.ae::jsonb, x.ph, x.ps, x.own, x.ot, x.os, x.ad::jsonb, x.so::jsonb, x.cp, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::text[], $6::boolean[], $7::text[], $8::text[], $9::text[],
                   $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::numeric[])
         AS x(domain, email, et, ec, es, mx, ae, ph, ps, own, ot, os, ad, so, cp)
       JOIN domains d ON d.domain = x.domain
       ON CONFLICT (domain_id) DO UPDATE SET email = EXCLUDED.email, email_type = EXCLUDED.email_type, email_confidence = EXCLUDED.email_confidence,
         email_source_url = EXCLUDED.email_source_url, mx_ok = EXCLUDED.mx_ok, all_emails = EXCLUDED.all_emails, phone = EXCLUDED.phone,
         phone_source = EXCLUDED.phone_source, owner_name = EXCLUDED.owner_name, owner_title = EXCLUDED.owner_title, owner_source = EXCLUDED.owner_source,
         address = EXCLUDED.address, socials = EXCLUDED.socials, completeness = EXCLUDED.completeness, extracted_at = now()`,
      [col((r) => r.domain), col((r) => r.email), col((r) => r.email_type), col((r) => r.email_confidence), col((r) => r.email_source_url),
       col((r) => r.mx_ok), col((r) => r.all_emails), col((r) => r.phone), col((r) => r.phone_source), col((r) => r.owner_name),
       col((r) => r.owner_title), col((r) => r.owner_source), col((r) => r.address), col((r) => r.socials), col((r) => r.completeness)],
    );
    run.inCount = rows.length;
    run.outCount = results.filter((r) => r.email).length;
    run.drop('no_email', rows.length - run.outCount);
    return { leads: rows.length, with_email: run.outCount };
  });
}

const sameSite = (a: string, b: string) => {
  const x = registrableDomain(new URL(a).hostname);
  const y = registrableDomain(new URL(b).hostname);
  return 'domain' in x && 'domain' in y && x.domain === y.domain;
};

const TYPE_SCORE: Record<EmailType, number> = { named: 0.9, role: 0.8, freemail: 0.6 };

/** Merge findings from all pages of one lead into the best values, keeping every source. */
export function merge(row: { domain: string }, found: PageContacts[], fetched: string[], sitemap: { kind: string; count: number } | null): Record<string, unknown> {
  const emails = new Map<string, { email: string; type: EmailType; confidence: number; source: string; via: string }>();
  for (const f of found) for (const e of f.emails) {
    if (emails.has(e.value)) continue;
    const domain = e.value.split('@')[1]!;
    const own = domain === row.domain || domain.endsWith(`.${row.domain}`);
    const type = emailType(e.value);
    // Emails on another business's domain (e.g. the web agency in the footer) are kept but rank low.
    const base = type === 'freemail' ? TYPE_SCORE.freemail : own ? TYPE_SCORE[type] : 0.3;
    const bonus = e.via === 'mailto' || e.via === 'jsonld' || e.via === 'cloudflare' ? 0.05 : 0;
    emails.set(e.value, { email: e.value, type, confidence: Math.round(Math.min(1, base + bonus) * 100) / 100, source: e.source, via: e.via });
  }
  const sortedEmails = [...emails.values()].sort((a, b) => b.confidence - a.confidence);
  const phones = [...new Map(found.flatMap((f) => f.phones).map((p) => [p.value, p])).values()];
  const bestPhone = phones.find((p) => p.via !== 'text') ?? phones[0];
  const people = found.flatMap((f) => f.people).sort((a, b) => b.value.confidence - a.value.confidence);
  const addr = found.flatMap((f) => f.addresses).sort((a, b) => Number(!!b.value.street) - Number(!!a.value.street))[0];
  const socials: Record<string, string> = {};
  for (const s of found.flatMap((f) => f.socials)) socials[s.via] ??= s.value;
  const org = found.flatMap((f) => f.orgNames)[0];
  return {
    domain: row.domain,
    extracted_at: new Date().toISOString(),
    all_emails: sortedEmails,
    phone: bestPhone?.value ?? null,
    phone_source: bestPhone?.source ?? null,
    all_phones: phones.map((p) => p.value).slice(0, 10),
    owner_name: people[0]?.value.name ?? null,
    owner_title: people[0]?.value.title ?? null,
    owner_source: people[0]?.source ?? null,
    owner_confidence: people[0]?.value.confidence ?? null,
    address: addr ? JSON.stringify({ ...addr.value, source: addr.source }) : null,
    socials: JSON.stringify(socials),
    org_name: org?.value ?? null,
    pages_fetched: fetched,
    sitemap_kind: sitemap?.kind ?? null,
    sitemap_count: sitemap?.count ?? null,
  };
}
