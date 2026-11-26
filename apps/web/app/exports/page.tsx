import Link from 'next/link';
import { q } from '@/lib/db';
import { ago, fmt } from '@/lib/format';
import { Card, Notice, PageHeader, Table, btn, input, label } from '@/components/ui';
import { Submit } from '@/components/submit';
import { createExport, resetExported } from './actions';

export const dynamic = 'force-dynamic';

type Hist = { id: number; brand: string; segment_name: string | null; tiers: string[]; format: string; mode: string; require_email: boolean; status: string;
  candidates: number | null; suppressed: number | null; row_count: number | null; file_name: string | null; file_bytes: string | null; error: string | null;
  requested_by: string; created_at: Date; finished_at: Date | null; started_at: Date | null };

export default async function Exports({ searchParams }: { searchParams: Promise<{ error?: string; created?: string; reset?: string }> }) {
  const sp = await searchParams;
  const [brands, segments, ready, history] = await Promise.all([
    q<{ id: number; name: string }>(`SELECT id, name FROM brands WHERE enabled ORDER BY id`),
    q<{ id: number; brand_id: number; name: string; member_count: number | null }>(`SELECT id, brand_id, name, member_count FROM segments WHERE enabled ORDER BY brand_id, name`),
    q<{ id: number; name: string; ab: number; ab_email: number; ab_email_new: number; exported: number }>(`
      SELECT b.id, b.name,
        count(*) FILTER (WHERE m.tier IN ('A','B'))::int ab,
        count(*) FILTER (WHERE m.tier IN ('A','B') AND ct.email IS NOT NULL)::int ab_email,
        count(*) FILTER (WHERE m.tier IN ('A','B') AND ct.email IS NOT NULL AND e.domain_id IS NULL)::int ab_email_new,
        (SELECT count(*)::int FROM exported_leads x WHERE x.brand_id = b.id) exported
      FROM brands b LEFT JOIN brand_matches m ON m.brand_id = b.id LEFT JOIN contacts ct ON ct.domain_id = m.domain_id
      LEFT JOIN exported_leads e ON e.brand_id = b.id AND e.domain_id = m.domain_id
      WHERE b.enabled GROUP BY b.id ORDER BY b.id`),
    q<Hist>(`SELECT x.*, b.name AS brand, x.file_bytes::text FROM exports x JOIN brands b ON b.id = x.brand_id ORDER BY x.id DESC LIMIT 50`),
  ]);
  const busy = history.some((h) => h.status === 'queued' || h.status === 'running');
  return (
    <div className="space-y-6">
      {busy && <meta httpEquiv="refresh" content="5" />}
      <PageHeader title="Exports" description="CSV or Excel files per brand → segment → tier. The do-not-contact list is applied right before each file is written; exported leads are remembered per brand." />
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.created && <Notice tone="green">Export #{sp.created} is being written. This page refreshes by itself until it is ready.</Notice>}
      {sp.reset && <Notice tone="green">Done: “new since last export” will include those leads again.</Notice>}

      <div className="grid gap-6 lg:grid-cols-[24rem_1fr]">
        <Card title="New export">
          <form action={createExport} className="space-y-4 text-sm">
            <div><span className={label}>Brand</span>
              <select name="brand_id" className={input}>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
            <div><span className={label}>Segment (optional)</span>
              <select name="segment_id" className={input} defaultValue="">
                <option value="">All leads of the brand</option>
                {brands.map((b) => (
                  <optgroup key={b.id} label={b.name}>
                    {segments.filter((s) => s.brand_id === b.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <span className="mt-1 block text-xs text-neutral-500">The segment must belong to the brand chosen above.</span></div>
            <div><span className={label}>Tiers</span>
              <div className="flex gap-4">{['A', 'B', 'C'].map((t) => <label key={t} className="flex items-center gap-1.5"><input type="checkbox" name="tiers" value={t} defaultChecked={t !== 'C'} /> {t}</label>)}</div></div>
            <div><span className={label}>Which leads</span>
              <label className="flex items-center gap-2"><input type="radio" name="mode" value="new" defaultChecked /> New since last export (never exported for this brand)</label>
              <label className="mt-1 flex items-center gap-2"><input type="radio" name="mode" value="all" /> All matching leads</label></div>
            <label className="flex items-center gap-2"><input type="checkbox" name="require_email" defaultChecked /> Only leads with an email</label>
            <div><span className={label}>File</span>
              <label className="flex items-center gap-2"><input type="radio" name="format" value="xlsx" defaultChecked /> Excel (.xlsx) — one sheet per niche + summary</label>
              <label className="mt-1 flex items-center gap-2"><input type="radio" name="format" value="csv" /> CSV — one file, any size</label>
              <label className="mt-2 flex items-center gap-2 text-xs text-neutral-600"><input type="checkbox" name="sheets" value="none" /> Excel: everything on one sheet</label></div>
            <Submit className={btn.primary} pending="Creating…">Create export</Submit>
          </form>
        </Card>

        <Card title="Ready to export (tier A/B)">
          <Table head={['Brand', 'A/B leads', 'with email', 'not exported yet', 'already exported', '']}>
            {ready.map((r) => (
              <tr key={r.id}>
                <td><Link className="font-medium hover:underline" href={`/explorer?brand=${r.id}&tiers=A,B&has_email=yes`}>{r.name}</Link></td>
                <td className="tabular-nums">{fmt(r.ab)}</td><td className="tabular-nums">{fmt(r.ab_email)}</td>
                <td className="tabular-nums font-medium">{fmt(r.ab_email_new)}</td><td className="tabular-nums text-neutral-500">{fmt(r.exported)}</td>
                <td className="text-right">{r.exported > 0 && (
                  <form action={resetExported}><input type="hidden" name="brand_id" value={r.id} />
                    <Submit className="text-xs text-neutral-600 hover:underline" pending="…" confirm={`Forget which leads were exported for ${r.name}? The next “new” export will include them again.`}>Forget exported</Submit></form>)}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-neutral-500">Columns in every file: lead_id, brand, segment, tier, score, niche, sub_niche, domain, website, company_name, platform,
            key_technologies, country, state, city, email, email_type, phone, owner_name, owner_title, socials, product_count, price_range, lighthouse_performance,
            finding_1–3, services_to_pitch, first_line_1–3, first_seen_date, sources.</p>
        </Card>
      </div>

      <Card title="History">
        <Table head={['#', 'Created', 'Brand / segment', 'Tiers', 'Leads', 'Removed (do-not-contact)', 'Status', 'File']} empty={!history.length}>
          {history.map((h) => (
            <tr key={h.id}>
              <td className="tabular-nums text-xs">{h.id}</td>
              <td className="whitespace-nowrap text-xs">{ago(h.created_at)}<div className="text-neutral-400">{h.requested_by}</div></td>
              <td className="text-xs"><div className="font-medium">{h.brand}</div><div className="text-neutral-500">{h.segment_name ?? 'all leads'} · {h.mode === 'new' ? 'new only' : 'all'}{h.require_email ? ' · with email' : ''}</div></td>
              <td className="text-xs">{h.tiers.join(', ')}</td>
              <td className="tabular-nums">{fmt(h.row_count)}</td>
              <td className="tabular-nums text-xs">{fmt(h.suppressed)}</td>
              <td className="text-xs">
                <span className={h.status === 'failed' ? 'text-red-700' : h.status === 'done' ? 'text-emerald-700' : 'text-amber-700'}>{h.status}</span>
                {h.status === 'done' && h.finished_at && h.started_at && <span className="text-neutral-400"> · {Math.max(1, Math.round((new Date(h.finished_at).getTime() - new Date(h.started_at).getTime()) / 1000))} s</span>}
                {h.error && <div className="max-w-xs break-words text-red-700">{h.error}</div>}
              </td>
              <td className="text-xs">{h.status === 'done' && h.file_name ? (
                <a className={btn.secondary} href={`/exports/${h.id}/download`}>Download {h.format.toUpperCase()} · {(Number(h.file_bytes) / 1e6).toFixed(1)} MB</a>) : '–'}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
