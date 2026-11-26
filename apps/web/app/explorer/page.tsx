import Link from 'next/link';
import { segmentWhere } from '@lead/shared/segment-filter';
import { one, q } from '@/lib/db';
import { first, filterToQuery, parseFilter, type Params } from '@/lib/filters';
import { fmt } from '@/lib/format';
import { filterOptions } from '@/lib/options';
import { Card, Notice, PageHeader, Pager, Table, Tier, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { FilterForm } from './filter-form';
import { saveSegment } from './actions';

export const dynamic = 'force-dynamic';

const SORTS: Record<string, string> = {
  score: 'm.match_score DESC, d.id',
  new: 'd.first_seen DESC, m.match_score DESC, d.id',
  products: 'sp.product_count DESC NULLS LAST, d.id',
  speed: "(a.lighthouse->>'performance')::int ASC NULLS LAST, d.id",
};

type Row = {
  domain: string; company: string | null; tier: string; score: string; niche: string; sub_niche: string | null; platform: string | null;
  country: string | null; email: string | null; email_type: string | null; product_count: number | null; perf: number | null; need: string | null;
};

export default async function Explorer({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const o = await filterOptions();
  const brandId = Number(first(sp.brand)) || o.brands[0]?.id || 0;
  const brand = o.brands.find((b) => b.id === brandId);
  const { filter, errors } = parseFilter(sp);
  const sort = SORTS[first(sp.sort) ?? ''] ? first(sp.sort)! : 'score';
  const size = Number((await one<{ value: number }>(`SELECT value FROM settings WHERE key = 'dashboard.page_size'`))?.value ?? 50);
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const { from, where, params } = segmentWhere(brandId, filter);
  const [count] = await q<{ n: string }>(`SELECT count(*) AS n FROM ${from} WHERE ${where}`, params);
  const total = Number(count?.n ?? 0);
  const rows = await q<Row>(`
    SELECT d.domain, c.name AS company, m.tier, m.match_score::text AS score, n.name AS niche, s.name AS sub_niche,
      coalesce(c.platform, d.platform) AS platform, c.country, ct.email, ct.email_type, sp.product_count,
      (a.lighthouse->>'performance')::int AS perf, m.breakdown->'need'->'problems'->0->>'service' AS need
    FROM ${from} WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  const query = (p: number) => `/explorer?${filterToQuery(filter, { brand: String(brandId), sort, page: String(p) })}`;

  return (
    <div>
      <PageHeader title="Lead explorer" description="Filter every scored lead for one brand. The filters are in the address bar, so you can bookmark or share a view." />
      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <aside className="h-fit rounded-lg border border-neutral-200 bg-white p-4"><FilterForm o={o} brandId={brandId} f={filter} sort={sort} /></aside>
        <div className="min-w-0 space-y-4">
          {errors.length > 0 && <Notice tone="red">Some filters were not valid and were ignored: {errors.join('; ')}</Notice>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm"><span className="text-2xl font-semibold tabular-nums">{fmt(total)}</span> <span className="text-neutral-500">leads for {brand?.name ?? 'no brand'}</span></div>
            <Pager page={page} pages={Math.ceil(total / size)} href={query} />
          </div>
          <Card>
            <Table head={['Tier', 'Score', 'Lead', 'Niche · top need', 'Platform · country', 'Email', 'Products', 'Speed']} empty={!rows.length}>
              {rows.map((r) => (
                <tr key={r.domain}>
                  <td><Tier tier={r.tier} /></td>
                  <td className="tabular-nums">{Number(r.score).toFixed(1)}</td>
                  <td className="max-w-[13rem]">
                    <Link href={`/leads/${encodeURIComponent(r.domain)}?brand=${brandId}`} className="block truncate font-medium hover:underline">{r.domain}</Link>
                    {r.company && <div className="truncate text-xs text-neutral-500" title={r.company}>{r.company}</div>}
                  </td>
                  <td className="max-w-[12rem] text-xs" title={`${r.niche}${r.sub_niche ? ` · ${r.sub_niche}` : ''}`}>
                    <div className="truncate">{r.sub_niche ?? r.niche}</div>{r.need && <div className="truncate text-neutral-500">needs: {r.need}</div>}</td>
                  <td className="whitespace-nowrap text-xs">{r.platform ?? '–'}<span className="text-neutral-400"> · {r.country ?? '?'}</span></td>
                  <td className="max-w-[13rem] text-xs" title={r.email ?? ''}>{r.email ? <><div className="truncate">{r.email}</div><div className="text-neutral-400">{r.email_type}</div></> : '–'}</td>
                  <td className="tabular-nums text-xs">{fmt(r.product_count)}</td>
                  <td className="tabular-nums text-xs">{r.perf ?? '–'}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Save these filters as a segment">
            <form action={saveSegment} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="brand_id" value={brandId} />
              <input type="hidden" name="filter" value={JSON.stringify(filter)} />
              <label className="min-w-[16rem] flex-1"><span className="mb-1 block text-xs font-medium text-neutral-600">Segment name</span>
                <input name="name" required className={input} placeholder="e.g. Shopify US, no Klaviyo, tier A/B" /></label>
              <label className="min-w-[16rem] flex-1"><span className="mb-1 block text-xs font-medium text-neutral-600">Note (optional)</span>
                <input name="description" className={input} /></label>
              <Submit className={btn.primary}>Save segment</Submit>
            </form>
            <p className="mt-2 text-xs text-neutral-500">Saved for {brand?.name}. Members are refreshed every day; saving with an existing name updates that segment.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
