import Link from 'next/link';
import { one, q } from '@/lib/db';
import { ago, fmt, pct } from '@/lib/format';
import { Card, Notice, PageHeader, Table, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { reclassifyAll, saveNiche } from './actions';

export const dynamic = 'force-dynamic';

export default async function Niches({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; reclassify?: string }> }) {
  const sp = await searchParams;
  const [niches, re] = await Promise.all([
    q<{ id: number; key: string; name: string; gate: string | null; saturation_level: string; excluded: boolean; enabled: boolean; description: string | null;
      subs: number; keywords: number; leads: number; with_email: number; qualified: number }>(`
      SELECT n.*, (SELECT count(*)::int FROM sub_niches s WHERE s.niche_id = n.id) subs,
        (SELECT count(*)::int FROM keywords k JOIN sub_niches s ON s.id = k.sub_niche_id WHERE s.niche_id = n.id) keywords,
        count(c.domain_id)::int leads, count(ct.email)::int with_email,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM brand_matches m WHERE m.domain_id = c.domain_id AND m.tier IN ('A','B')))::int qualified
      FROM niches n LEFT JOIN classifications c ON c.niche_id = n.id LEFT JOIN contacts ct ON ct.domain_id = c.domain_id
      GROUP BY n.id ORDER BY n.excluded, leads DESC, n.name`),
    one<{ value: string; updated_at: Date }>(`SELECT value, updated_at FROM settings WHERE key = 'classify.reclassify_after'`),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="Niches" description="Your niche list (taxonomy). Keywords and rules decide which niche a website belongs to. Excluded niches (e.g. heavily pitched ones) are recognised and left out."
        actions={<form action={reclassifyAll}><Submit className={btn.secondary} pending="Starting…" confirm="Classify every fetched site again with the current niches and keywords? Runs in the background.">Re-classify all</Submit></form>} />
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.saved && <Notice tone="green">Saved. New and re-classified sites use it.</Notice>}
      {(sp.reclassify || re) && <Notice>Changes to keywords apply to newly classified sites. {re ? <>Last “re-classify all”: {ago(re.updated_at)} — the worker works through it in the background.</> : null}</Notice>}
      <Card>
        <Table head={['Niche', 'Leads', 'With email', 'Qualified', 'Sub-niches', 'Keywords', 'Saturation', 'Status', '']}>
          {niches.map((n) => (
            <tr key={n.id} className={n.excluded ? 'text-neutral-500' : ''}>
              <td><Link href={`/niches/${n.id}`} className="font-medium hover:underline">{n.name}</Link><div className="text-xs text-neutral-500">{n.description}</div></td>
              <td className="tabular-nums">{fmt(n.leads)}</td>
              <td className="tabular-nums">{fmt(n.with_email)} <span className="text-xs text-neutral-500">{pct(n.with_email, n.leads)}</span></td>
              <td className="tabular-nums">{fmt(n.qualified)}</td>
              <td className="tabular-nums">{n.subs}</td><td className="tabular-nums">{n.keywords}</td>
              <td colSpan={2}>
                <form action={saveNiche} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={n.id} />
                  <select name="saturation_level" defaultValue={n.saturation_level} className={`${input} w-24`}>
                    <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="enabled" defaultChecked={n.enabled} /> on</label>
                  <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="excluded" defaultChecked={n.excluded} /> excluded</label>
                  <Submit className={btn.secondary}>Save</Submit>
                </form>
              </td>
              <td className="text-right"><Link className={btn.link} href={`/niches/${n.id}`}>Keywords</Link></td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-neutral-500">Excluded = recognised but never a lead (e.g. dentists, restaurants, real estate). Saturation is your own note on how heavily a niche is already pitched.</p>
      </Card>
    </div>
  );
}
