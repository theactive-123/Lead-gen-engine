import Link from 'next/link';
import { segmentWhere } from '@lead/shared/segment-filter';
import { q } from '@/lib/db';
import { filterToQuery } from '@/lib/filters';
import { ago, fmt } from '@/lib/format';
import { Card, Notice, PageHeader, Table, btn } from '@/components/ui';
import { Submit } from '@/components/submit';
import { refreshSegment } from './actions';

export const dynamic = 'force-dynamic';

type Seg = { id: number; brand_id: number; brand: string; name: string; description: string | null; filter: Record<string, unknown>;
  enabled: boolean; member_count: number | null; refreshed_at: Date | null };

export default async function Segments() {
  const segs = await q<Seg>(`SELECT s.id, s.brand_id, b.name AS brand, s.name, s.description, s.filter, s.enabled, s.member_count, s.refreshed_at
    FROM segments s JOIN brands b ON b.id = s.brand_id ORDER BY b.id, s.name`);
  // Live count = how many leads match right now (saved members are refreshed daily).
  const live = await Promise.all(segs.map(async (s) => {
    try {
      const { from, where, params } = segmentWhere(s.brand_id, s.filter);
      return Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${from} WHERE ${where}`, params))[0]?.n ?? 0);
    } catch {
      return null;
    }
  }));
  const brands = [...new Set(segs.map((s) => s.brand))];
  return (
    <div className="space-y-6">
      <PageHeader title="Segments" description="Saved filters per brand. Build a new one in the explorer: set filters, then “Save as segment”."
        actions={<>
          <Link className={btn.primary} href="/explorer">New segment</Link>
          <form action={refreshSegment}><Submit className={btn.secondary} pending="Queued…">Refresh all now</Submit></form>
        </>} />
      {!segs.length && <Notice>No segments yet.</Notice>}
      {brands.map((brand) => (
        <Card key={brand} title={brand}>
          <Table head={['Segment', 'Saved members', 'Matching now', 'Refreshed', '']}>
            {segs.map((s, i) => s.brand !== brand ? null : (
              <tr key={s.id}>
                <td><Link href={`/segments/${s.id}`} className="font-medium hover:underline">{s.name}</Link>{!s.enabled && <span className="ml-2 text-xs text-neutral-500">(off)</span>}
                  {s.description && <div className="text-xs text-neutral-500">{s.description}</div>}</td>
                <td className="tabular-nums">{fmt(s.member_count)}</td>
                <td className="tabular-nums">{live[i] == null ? <span className="text-red-700">invalid filter</span> : fmt(live[i])}</td>
                <td className="text-neutral-500">{ago(s.refreshed_at)}</td>
                <td className="text-right"><Link className={btn.link} href={`/explorer?${filterToQuery(s.filter, { brand: String(s.brand_id) })}`}>Open in explorer</Link></td>
              </tr>
            ))}
          </Table>
        </Card>
      ))}
    </div>
  );
}
