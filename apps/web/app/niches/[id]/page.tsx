import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q } from '@/lib/db';
import { fmt } from '@/lib/format';
import { Badge, Card, Notice, PageHeader, Table, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { addKeyword, addPattern, deleteKeyword, deletePattern, saveNiche, toggleSubNiche } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NichePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const id = Number((await params).id);
  const sp = await searchParams;
  const n = await one<{ id: number; key: string; name: string; gate: string | null; saturation_level: string; excluded: boolean; enabled: boolean; description: string | null }>(
    `SELECT * FROM niches WHERE id = $1`, [id]);
  if (!n) notFound();
  const [subs, keywords, patterns, hints] = await Promise.all([
    q<{ id: number; key: string; name: string; enabled: boolean; leads: number }>(`SELECT s.*, (SELECT count(*)::int FROM classifications c WHERE c.sub_niche_id = s.id) leads
      FROM sub_niches s WHERE s.niche_id = $1 ORDER BY s.name`, [id]),
    q<{ id: number; sub_niche_id: number; term: string; kind: string; weight: string }>(`SELECT k.id, k.sub_niche_id, k.term, k.kind, k.weight::text FROM keywords k
      JOIN sub_niches s ON s.id = k.sub_niche_id WHERE s.niche_id = $1 ORDER BY k.kind DESC, k.term`, [id]),
    q<{ id: number; sub_niche_id: number | null; pattern: string; weight: string; note: string | null }>(`SELECT id, sub_niche_id, pattern, weight::text, note FROM url_patterns WHERE niche_id = $1 ORDER BY id`, [id]),
    q<{ tech: string; weight: string }>(`SELECT tech, weight::text FROM niche_tech_hints WHERE niche_id = $1 ORDER BY tech`, [id]),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title={n.name} description={<>Key <code>{n.key}</code>{n.gate && <> · needs <b>{n.gate}</b> evidence</>}</>} actions={<Link className={btn.secondary} href="/niches">All niches</Link>} />
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.saved && <Notice tone="green">Saved. Applies to newly classified sites (or press “Re-classify all” on the Niches page).</Notice>}
      <Card title="Settings">
        <form action={saveNiche} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={n.id} /><input type="hidden" name="back" value={`/niches/${n.id}`} />
          <label className="min-w-[20rem] flex-1"><span className="mb-1 block text-xs font-medium text-neutral-600">Description</span><input name="description" defaultValue={n.description ?? ''} className={input} /></label>
          <select name="saturation_level" defaultValue={n.saturation_level} className={`${input} w-28`}><option>low</option><option>medium</option><option>high</option></select>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="enabled" defaultChecked={n.enabled} /> on</label>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="excluded" defaultChecked={n.excluded} /> excluded</label>
          <Submit className={btn.primary}>Save</Submit>
        </form>
      </Card>
      {subs.map((s) => {
        const kw = keywords.filter((k) => k.sub_niche_id === s.id);
        return (
          <Card key={s.id} title={<>{s.name} <span className="ml-1 text-xs font-normal text-neutral-500">{s.key} · {fmt(s.leads)} leads</span></>}
            actions={<form action={toggleSubNiche}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="niche_id" value={id} />
              <Submit className={btn.secondary}>{s.enabled ? 'Turn off' : 'Turn on'}</Submit></form>}>
            <div className="flex flex-wrap gap-1.5">
              {kw.map((k) => (
                <form key={k.id} action={deleteKeyword} className="inline-flex">
                  <input type="hidden" name="id" value={k.id} /><input type="hidden" name="niche_id" value={id} />
                  <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${k.kind === 'negative' ? 'bg-red-50 text-red-800' : 'bg-neutral-100 text-neutral-800'}`}>
                    {k.kind === 'negative' && '− '}{k.term}{Number(k.weight) !== 1 && <span className="text-neutral-400">×{k.weight}</span>}
                    <button className="ml-0.5 text-neutral-400 hover:text-red-700" title="Remove">×</button>
                  </span>
                </form>
              ))}
              {!kw.length && <span className="text-sm text-neutral-500">No keywords.</span>}
            </div>
            <form action={addKeyword} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="sub_niche_id" value={s.id} /><input type="hidden" name="niche_id" value={id} />
              <input name="term" placeholder="new keyword or phrase" required className={`${input} w-64`} />
              <select name="kind" className={`${input} w-32`}><option value="positive">positive</option><option value="negative">negative</option></select>
              <input name="weight" type="number" step="0.5" min="0.5" max="5" defaultValue={1} className={`${input} w-20`} title="Weight" />
              <Submit className={btn.secondary}>Add</Submit>
            </form>
          </Card>
        );
      })}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="URL patterns (pages on the site that point to this niche)">
          <Table head={['Pattern', 'Sub-niche', 'Weight', '']} empty={!patterns.length}>
            {patterns.map((p) => (
              <tr key={p.id}><td className="font-mono text-xs">{p.pattern}</td><td className="text-xs">{subs.find((s) => s.id === p.sub_niche_id)?.name ?? 'any'}</td><td className="text-xs">{p.weight}</td>
                <td><form action={deletePattern}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="niche_id" value={id} /><button className="text-xs text-red-700 hover:underline">Delete</button></form></td></tr>
            ))}
          </Table>
          <form action={addPattern} className="mt-3 flex flex-wrap gap-2">
            <input type="hidden" name="niche_id" value={id} />
            <input name="pattern" required placeholder="/(book|schedule)(/|$)" className={`${input} w-56 font-mono`} />
            <select name="sub_niche_id" className={`${input} w-44`}><option value="">any sub-niche</option>{subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <input name="weight" type="number" step="0.5" min="0.5" max="5" defaultValue={1} className={`${input} w-20`} />
            <Submit className={btn.secondary}>Add</Submit>
          </form>
        </Card>
        <Card title="Technology hints">
          <div className="flex flex-wrap gap-1.5">{hints.map((h) => <Badge key={h.tech}>{h.tech} ×{h.weight}</Badge>)}{!hints.length && <span className="text-sm text-neutral-500">None.</span>}</div>
          <p className="mt-3 text-xs text-neutral-500">Technologies that add evidence for this niche (e.g. booking software for studios).</p>
        </Card>
      </div>
    </div>
  );
}
