import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q } from '@/lib/db';
import { date, fmt } from '@/lib/format';
import { Badge, Card, Notice, PageHeader, SEVERITY_TONE, Table, Tier, btn } from '@/components/ui';
import { CopyButton } from '@/components/copy';
import { Submit } from '@/components/submit';
import { deleteLead } from './actions';

export const dynamic = 'force-dynamic';

type Lead = {
  id: string; domain: string; final_url: string | null; first_seen: Date; sources: string[]; title: string | null; mx_provider: string | null;
  company: string | null; country: string | null; country_source: string | null; region: string | null; city: string | null; address: string | null;
  platform: string | null; size_signals: Record<string, unknown> | null; freshness: Record<string, unknown> | null; marketing: Record<string, unknown> | null;
  niche: string; sub_niche: string | null; confidence: string; reason: string | null;
};
type Breakdown = {
  fit: { value: number; niche: number; platform: number; country: number; size: number; confidence: number; excluded?: string };
  need: { value: number; problems: { code: string; service: string; severity: string; points: number }[] };
  reach: { value: number; via: string }; fresh: { value: number; via: string };
};

export default async function LeadPage({ params, searchParams }: { params: Promise<{ domain: string }>; searchParams: Promise<{ brand?: string }> }) {
  const domain = decodeURIComponent((await params).domain);
  const back = (await searchParams).brand;
  const lead = await one<Lead>(`
    SELECT d.id, d.domain, d.final_url, d.first_seen, d.sources, d.title, d.mx_provider, c.name AS company, c.country, c.country_source, c.region,
      c.city, c.address, coalesce(c.platform, d.platform) AS platform, c.size_signals, c.freshness, c.marketing,
      n.name AS niche, s.name AS sub_niche, k.confidence::text, k.reason
    FROM domains d JOIN classifications k ON k.domain_id = d.id JOIN niches n ON n.id = k.niche_id
    LEFT JOIN sub_niches s ON s.id = k.sub_niche_id LEFT JOIN companies c ON c.domain_id = d.id WHERE d.domain = $1`, [domain]);
  if (!lead) notFound();
  const id = lead.id;
  const [matches, lines, contact, store, techs, findings, audit, suppressed] = await Promise.all([
    q<{ brand_id: number; name: string; tier: string; match_score: string; breakdown: Breakdown }>(
      `SELECT m.brand_id, b.name, m.tier, m.match_score::text, m.breakdown FROM brand_matches m JOIN brands b ON b.id = m.brand_id WHERE m.domain_id = $1 ORDER BY m.match_score DESC`, [id]),
    q<{ brand_id: number; variant: number; text: string; finding_code: string }>(`SELECT brand_id, variant, text, finding_code FROM first_lines WHERE domain_id = $1 ORDER BY brand_id, variant`, [id]),
    one<{ email: string | null; email_type: string | null; email_confidence: string | null; email_source_url: string | null; mx_ok: boolean | null; all_emails: unknown;
      phone: string | null; phone_source: string | null; owner_name: string | null; owner_title: string | null; owner_source: string | null; socials: Record<string, string> | null; completeness: string | null }>(
      `SELECT email, email_type, email_confidence::text, email_source_url, mx_ok, all_emails, phone, phone_source, owner_name, owner_title, owner_source, socials, completeness::text FROM contacts WHERE domain_id = $1`, [id]),
    one<{ platform: string; product_count: number | null; price_min: string | null; price_max: string | null; price_median: string | null; currency: string | null;
      last_product_update: Date | null; theme: string | null; vendors: string[] | null; sample_titles: string[] | null }>(
      `SELECT platform, product_count, price_min::text, price_max::text, price_median::text, currency, last_product_update, theme, vendors, sample_titles FROM store_profiles WHERE domain_id = $1`, [id]),
    q<{ tech: string; categories: string[]; version: string | null; source: string }>(`SELECT tech, categories, version, source FROM technologies WHERE domain_id = $1 ORDER BY categories[1] NULLS LAST, tech`, [id]),
    q<{ code: string; severity: string; message: string; source: string }>(
      `SELECT code, severity, message, source FROM audit_findings WHERE domain_id = $1 ORDER BY array_position(ARRAY['high','medium','low','info'], severity), code`, [id]),
    one<{ lighthouse: Record<string, number | string> | null; audited_at: Date | null; lighthouse_at: Date | null }>(`SELECT lighthouse, audited_at, lighthouse_at FROM audits WHERE domain_id = $1`, [id]),
    one<{ n: string }>(`SELECT count(*)::text n FROM suppression WHERE (kind = 'domain' AND value = $1)
      OR (kind = 'email' AND value = (SELECT lower(email) FROM contacts WHERE domain_id = $2))`, [domain, id]),
  ]);
  const byCategory = new Map<string, typeof techs>();
  for (const t of techs) { const c = t.categories?.[0] ?? 'Other'; byCategory.set(c, [...(byCategory.get(c) ?? []), t]); }
  const lh = audit?.lighthouse;

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.domain}
        description={<>{lead.company ?? lead.title ?? ''} {lead.final_url && <a className="ml-2 underline" href={lead.final_url} target="_blank" rel="noreferrer">Open site</a>}</>}
        actions={<Link className={btn.secondary} href={`/explorer${back ? `?brand=${back}` : ''}`}>Back to explorer</Link>}
      />
      {Number(suppressed?.n) > 0 && <Notice tone="amber">This domain is on the do-not-contact list.</Notice>}

      <div className="grid gap-4 md:grid-cols-4">
        <Fact k="Niche" v={<>{lead.niche}{lead.sub_niche && <> · {lead.sub_niche}</>} <span className="text-xs text-neutral-500">({Math.round(Number(lead.confidence) * 100)}% sure)</span></>} />
        <Fact k="Platform" v={lead.platform ?? '–'} />
        <Fact k="Location" v={[lead.city, lead.region, lead.country].filter(Boolean).join(', ') || '–'} sub={lead.country_source ? `country from ${lead.country_source}` : undefined} />
        <Fact k="First seen" v={date(lead.first_seen)} sub={`sources: ${lead.sources.join(', ')}`} />
      </div>

      <Card title="Score per brand">
        <Table head={['Brand', 'Tier', 'Score', 'Fit', 'Need', 'Reach', 'Fresh', 'Why']} empty={!matches.length}>
          {matches.map((m) => {
            const b = m.breakdown;
            return (
              <tr key={m.brand_id}>
                <td className="font-medium">{m.name}</td><td><Tier tier={m.tier} /></td><td className="tabular-nums">{Number(m.match_score).toFixed(1)}</td>
                <td className="tabular-nums text-xs" title={`niche ${b.fit.niche} × platform ${b.fit.platform} × country ${b.fit.country} × size ${b.fit.size} × confidence ${b.fit.confidence}`}>{b.fit.value}</td>
                <td className="tabular-nums text-xs">{b.need.value}</td>
                <td className="tabular-nums text-xs" title={b.reach.via}>{b.reach.value}</td>
                <td className="tabular-nums text-xs" title={b.fresh.via}>{b.fresh.value}</td>
                <td className="text-xs text-neutral-600">
                  {b.fit.excluded ? <span>Not a fit: {b.fit.excluded}</span> : (
                    <>
                      <div>fit: niche {b.fit.niche} × platform {b.fit.platform} × country {b.fit.country} × size {b.fit.size} × confidence {b.fit.confidence}</div>
                      <div>reach: {b.reach.via} · fresh: {b.fresh.via}</div>
                      {b.need.problems.length > 0 && <div>sells: {[...new Set(b.need.problems.map((p) => p.service))].join(', ')}</div>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card title="First lines">
        {!lines.length && <p className="text-sm text-neutral-500">No first lines (no brand-relevant finding with a template).</p>}
        <div className="space-y-4">
          {matches.filter((m) => lines.some((l) => l.brand_id === m.brand_id)).map((m) => (
            <div key={m.brand_id}>
              <div className="mb-1 text-xs font-medium text-neutral-500">{m.name}</div>
              <ul className="space-y-1.5">
                {lines.filter((l) => l.brand_id === m.brand_id).map((l) => (
                  <li key={l.variant} className="flex items-start justify-between gap-3 rounded border border-neutral-100 px-3 py-2 text-sm">
                    <span>{l.text} <span className="ml-1 text-xs text-neutral-400">{l.finding_code}</span></span><CopyButton text={l.text} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Contact">
          {!contact ? <p className="text-sm text-neutral-500">Contacts not extracted yet.</p> : (
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-neutral-500">Email</dt>
              <dd>{contact.email ?? '–'} {contact.email_type && <Badge>{contact.email_type}</Badge>} {contact.mx_ok === false && <Badge tone="red">no mail server</Badge>}
                {contact.email_source_url && <div className="truncate text-xs text-neutral-500">from {contact.email_source_url}</div>}</dd>
              <dt className="text-neutral-500">Phone</dt><dd>{contact.phone ?? '–'} {contact.phone_source && <span className="text-xs text-neutral-500">({contact.phone_source})</span>}</dd>
              <dt className="text-neutral-500">Owner</dt><dd>{contact.owner_name ?? '–'} {contact.owner_title && <span className="text-neutral-500">· {contact.owner_title}</span>}</dd>
              <dt className="text-neutral-500">Address</dt><dd>{lead.address ?? '–'}</dd>
              <dt className="text-neutral-500">Social</dt>
              <dd className="space-x-2">{Object.entries(contact.socials ?? {}).map(([k, v]) => <a key={k} href={String(v)} className="underline" target="_blank" rel="noreferrer">{k}</a>)}{!Object.keys(contact.socials ?? {}).length && '–'}</dd>
              <dt className="text-neutral-500">Completeness</dt><dd>{contact.completeness != null ? `${Math.round(Number(contact.completeness) * 100)}%` : '–'}</dd>
              <dt className="text-neutral-500">Mail provider</dt><dd>{lead.mx_provider ?? '–'}</dd>
            </dl>
          )}
        </Card>
        <Card title="Store">
          {!store ? <p className="text-sm text-neutral-500">No public store data.</p> : (
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-neutral-500">Products</dt><dd>{fmt(store.product_count)}</dd>
              <dt className="text-neutral-500">Prices</dt><dd>{store.price_min ? `${store.price_min}–${store.price_max} ${store.currency ?? ''} (median ${store.price_median})` : '–'}</dd>
              <dt className="text-neutral-500">Last new product</dt><dd>{date(store.last_product_update)}</dd>
              <dt className="text-neutral-500">Theme</dt><dd>{store.theme ?? '–'}</dd>
              <dt className="text-neutral-500">Examples</dt><dd className="text-xs">{store.sample_titles?.slice(0, 5).join(' · ') || '–'}</dd>
            </dl>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`Website findings (${findings.length})`}>
          <ul className="space-y-2 text-sm">
            {findings.map((f) => (
              <li key={f.code} className="flex gap-2"><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge><span>{f.message} <span className="text-xs text-neutral-400">{f.code}{f.source === 'lighthouse' && ' · Lighthouse'}</span></span></li>
            ))}
            {!findings.length && <li className="text-neutral-500">No problems found (or not audited yet).</li>}
          </ul>
          {lh && (
            <div className="mt-4 grid grid-cols-4 gap-2 border-t border-neutral-100 pt-4 text-center text-sm">
              {(['performance', 'accessibility', 'best_practices', 'seo'] as const).map((k) => (
                <div key={k}><div className="text-lg font-semibold tabular-nums">{lh[k] ?? '–'}</div><div className="text-xs text-neutral-500">{k.replace('_', ' ')}</div></div>
              ))}
              <div className="col-span-4 text-xs text-neutral-500">Google Lighthouse, mobile · LCP {lh.lcp_ms ? (Number(lh.lcp_ms) / 1000).toFixed(1) : '–'} s · {date(audit?.lighthouse_at)}</div>
            </div>
          )}
        </Card>
        <Card title={`Technologies (${techs.length})`}>
          <div className="space-y-2 text-sm">
            {[...byCategory.entries()].map(([cat, list]) => (
              <div key={cat} className="grid grid-cols-[9rem_1fr] gap-3">
                <div className="text-xs text-neutral-500">{cat}</div>
                <div className="flex flex-wrap gap-1">{list.map((t) => <Badge key={t.tech} tone={t.source === 'runtime' ? 'blue' : 'neutral'}>{t.tech}{t.version ? ` ${t.version}` : ''}</Badge>)}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">Blue = seen only when the page ran in a browser (Lighthouse).</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Signals"><Json value={{ size: lead.size_signals, freshness: lead.freshness, marketing: lead.marketing }} /></Card>
        <Card title="Why this niche"><p className="text-sm text-neutral-700">{lead.reason ?? '–'}</p></Card>
      </div>

      <Card title="Delete this lead">
        <form action={deleteLead} className="flex items-center justify-between gap-4">
          <input type="hidden" name="domain" value={lead.domain} />
          <p className="text-sm text-neutral-600">Removes this lead everywhere (lead database and raw data), and adds the domain and its email to the do-not-contact list so it is never crawled or contacted again.</p>
          <Submit className={btn.danger} pending="Deleting…" confirm={`Delete ${lead.domain} and never contact it?`}>Delete and suppress</Submit>
        </form>
      </Card>
    </div>
  );
}

function Fact({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xs text-neutral-500">{k}</div><div className="mt-1 text-sm font-medium">{v}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function Json({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="space-y-3 text-sm">
      {Object.entries(value).map(([group, obj]) => (
        <div key={group}>
          <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">{group}</dt>
          <dd className="grid grid-cols-[11rem_1fr] gap-x-3 gap-y-1 text-xs">
            {Object.entries((obj as Record<string, unknown>) ?? {}).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => (
              <div key={k} className="contents"><span className="text-neutral-500">{k.replaceAll('_', ' ')}</span><span>{Array.isArray(v) ? v.join(', ') : String(v)}</span></div>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
