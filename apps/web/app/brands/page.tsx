import Link from 'next/link';
import { q } from '@/lib/db';
import { fmt } from '@/lib/format';
import { Card, Notice, PageHeader, Table, btn } from '@/components/ui';
import { Submit } from '@/components/submit';
import { rescoreNow } from './actions';
import { Templates, type TemplateRow } from './templates';

export const dynamic = 'force-dynamic';

export default async function Brands({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const sp = await searchParams;
  const [brands, shared, codes, lastScore] = await Promise.all([
    q<{ id: number; key: string; name: string; description: string | null; enabled: boolean; services: string[]; a: number; b: number; c: number; x: number; updated_at: Date }>(`
      SELECT b.id, b.key, b.name, b.description, b.enabled, b.services, b.updated_at,
        count(*) FILTER (WHERE m.tier = 'A')::int a, count(*) FILTER (WHERE m.tier = 'B')::int b, count(*) FILTER (WHERE m.tier = 'C')::int c,
        count(*) FILTER (WHERE m.tier = 'X')::int x
      FROM brands b LEFT JOIN brand_matches m ON m.brand_id = b.id GROUP BY b.id ORDER BY b.id`),
    q<TemplateRow>(`SELECT t.id, t.finding_code, t.variant, t.template, t.enabled, (SELECT count(*)::int FROM first_lines f WHERE f.template_id = t.id) uses
      FROM brand_templates t WHERE t.brand_id IS NULL ORDER BY t.finding_code, t.variant`),
    q<{ code: string }>(`SELECT DISTINCT code FROM audit_findings ORDER BY 1`),
    q<{ finished_at: Date | null; status: string }>(`SELECT finished_at, status FROM runs WHERE stage = 'stage.score' ORDER BY started_at DESC LIMIT 1`),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="Brands" description="Each brand scores every lead on its own. Changes are picked up by the next scoring run (every 15 minutes), or press Rescore now."
        actions={<form action={rescoreNow}><Submit className={btn.secondary} pending="Queued…">Rescore now</Submit></form>} />
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.saved && <Notice tone="green">Saved. Leads are rescored on the next run.</Notice>}
      <Card title="Your brands" actions={<span className="text-xs text-neutral-500">Last scoring run: {lastScore[0]?.status ?? '–'} {lastScore[0]?.finished_at ? new Date(lastScore[0].finished_at).toISOString().slice(0, 16).replace('T', ' ') : ''}</span>}>
        <Table head={['Brand', 'Services', 'Tier A', 'Tier B', 'Tier C', 'Not a fit', '']}>
          {brands.map((b) => (
            <tr key={b.id}>
              <td><Link href={`/brands/${b.id}`} className="font-medium hover:underline">{b.name}</Link>{!b.enabled && <span className="ml-2 text-xs text-neutral-500">(off)</span>}
                <div className="text-xs text-neutral-500">{b.description}</div></td>
              <td className="max-w-xs text-xs text-neutral-600">{b.services.join(' · ')}</td>
              <td className="tabular-nums">{fmt(b.a)}</td><td className="tabular-nums">{fmt(b.b)}</td><td className="tabular-nums">{fmt(b.c)}</td><td className="tabular-nums text-neutral-500">{fmt(b.x)}</td>
              <td className="text-right"><Link className={btn.secondary} href={`/brands/${b.id}`}>Edit</Link></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title={<span id="templates">Shared first-line templates (used by every brand unless a brand has its own)</span>}>
        <Templates brandId={null} rows={shared} codes={codes.map((c) => c.code)} />
      </Card>
    </div>
  );
}
