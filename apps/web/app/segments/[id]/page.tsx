import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q } from '@/lib/db';
import { filterToQuery } from '@/lib/filters';
import { ago, date, fmt } from '@/lib/format';
import { Card, Field, PageHeader, Pager, Table, Tier, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { deleteSegment, refreshSegment, updateSegment } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SegmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const id = Number((await params).id);
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const s = await one<{ id: number; brand_id: number; brand: string; name: string; description: string | null; filter: Record<string, unknown>;
    enabled: boolean; member_count: number | null; refreshed_at: Date | null }>(
    `SELECT s.*, b.name AS brand FROM segments s JOIN brands b ON b.id = s.brand_id WHERE s.id = $1`, [id]);
  if (!s) notFound();
  const size = 50;
  const members = await q<{ domain: string; company: string | null; tier: string; score: string; email: string | null; added_at: Date }>(`
    SELECT d.domain, c.name AS company, m.tier, m.match_score::text AS score, ct.email, sm.added_at
    FROM segment_members sm JOIN domains d ON d.id = sm.domain_id
    LEFT JOIN brand_matches m ON m.domain_id = d.id AND m.brand_id = $2 LEFT JOIN companies c ON c.domain_id = d.id LEFT JOIN contacts ct ON ct.domain_id = d.id
    WHERE sm.segment_id = $1 ORDER BY m.match_score DESC NULLS LAST, d.id LIMIT ${size} OFFSET ${(page - 1) * size}`, [id, s.brand_id]);

  return (
    <div className="space-y-6">
      <PageHeader title={s.name} description={<>{s.brand} · {fmt(s.member_count)} members · refreshed {ago(s.refreshed_at)}</>}
        actions={<>
          <Link className={btn.secondary} href={`/explorer?${filterToQuery(s.filter, { brand: String(s.brand_id) })}`}>Edit filters in explorer</Link>
          <form action={refreshSegment}><input type="hidden" name="id" value={id} /><Submit className={btn.secondary} pending="Queued…">Refresh now</Submit></form>
        </>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card title="Members (best score first)">
          <Table head={['Tier', 'Score', 'Lead', 'Email', 'Joined']} empty={!members.length}>
            {members.map((m) => (
              <tr key={m.domain}>
                <td><Tier tier={m.tier ?? 'X'} /></td><td className="tabular-nums">{m.score ? Number(m.score).toFixed(1) : '–'}</td>
                <td><Link className="font-medium hover:underline" href={`/leads/${encodeURIComponent(m.domain)}?brand=${s.brand_id}`}>{m.domain}</Link>
                  {m.company && <div className="text-xs text-neutral-500">{m.company}</div>}</td>
                <td className="text-xs">{m.email ?? '–'}</td><td className="text-xs text-neutral-500">{date(m.added_at)}</td>
              </tr>
            ))}
          </Table>
          <div className="mt-4"><Pager page={page} pages={Math.ceil((s.member_count ?? 0) / size)} href={(p) => `/segments/${id}?page=${p}`} /></div>
        </Card>
        <div className="space-y-6">
          <Card title="Settings">
            <form action={updateSegment} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Field name="Name"><input name="name" defaultValue={s.name} required className={input} /></Field>
              <Field name="Note"><input name="description" defaultValue={s.description ?? ''} className={input} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Refresh daily</label>
              <Submit className={btn.primary}>Save</Submit>
            </form>
          </Card>
          <Card title="Filter">
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-neutral-50 p-3 text-xs">{JSON.stringify(s.filter, null, 2)}</pre>
          </Card>
          <form action={deleteSegment}><input type="hidden" name="id" value={id} />
            <Submit className={btn.danger} pending="Deleting…" confirm="Delete this segment? Leads are not deleted.">Delete segment</Submit></form>
        </div>
      </div>
    </div>
  );
}
