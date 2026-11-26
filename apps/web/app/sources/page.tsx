import { q } from '@/lib/db';
import { ago, fmt } from '@/lib/format';
import { Card, Dot, Notice, PageHeader, Table, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { runSourceNow, saveSource } from './actions';

export const dynamic = 'force-dynamic';

type Run = { id: string; stage: string; status: string; started_at: Date; finished_at: Date | null; in_count: number; out_count: number;
  error_count: number; dropped: Record<string, number> | null; per_minute: number; error: string | null };

export default async function Sources({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; queued?: string }> }) {
  const sp = await searchParams;
  const [sources, health, runs, perDay, jobs] = await Promise.all([
    q<{ key: string; label: string; enabled: boolean; schedule: string; updated_at: Date }>(`SELECT key, label, enabled, schedule, updated_at FROM sources ORDER BY key`),
    q<{ value: Record<string, { ok: boolean; detail: string; checked_at: string }> }>(`SELECT value FROM system_metrics WHERE metric = 'source_health' ORDER BY id DESC LIMIT 1`),
    q<Run>(`SELECT * FROM (SELECT r.*, row_number() OVER (PARTITION BY stage ORDER BY started_at DESC) rn FROM runs r WHERE stage LIKE 'source.%') x WHERE rn <= 8 ORDER BY stage, started_at DESC`),
    q<{ source: string; candidates: number; days: number }>(`SELECT source, sum(candidates)::int candidates, count(DISTINCT day)::int days FROM funnel_daily
      WHERE source <> 'all' AND day >= current_date - 29 GROUP BY 1`),
    q<{ name: string; state: string }>(`SELECT name, state::text FROM pgboss.job WHERE name LIKE 'source.%' AND state IN ('created', 'active', 'retry')`),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="Sources" description="Where new domains come from. All keyless and free. Schedule changes reach the worker within 5 minutes." />
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.saved && <Notice tone="green">Saved.</Notice>}
      {sp.queued && <Notice tone="green">Queued: {sp.queued} runs as soon as a worker is free.</Notice>}
      {sources.map((s) => {
        const h = health[0]?.value?.[s.key];
        const mine = runs.filter((r) => r.stage === `source.${s.key}`);
        const pd = perDay.find((p) => p.source === s.key);
        const job = jobs.find((j) => j.name === `source.${s.key}`);
        return (
          <Card key={s.key} title={<>{s.label} <span className="ml-1 text-xs font-normal text-neutral-500">{s.key}</span></>}
            actions={<div className="flex items-center gap-3">
              {job && <span className="text-xs text-amber-700">{job.state === 'active' ? 'running now' : 'queued'}</span>}
              <form action={runSourceNow}><input type="hidden" name="key" value={s.key} /><Submit className={btn.secondary} pending="Queuing…">Run now</Submit></form>
            </div>}>
            <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
              <div className="space-y-3 text-sm">
                <div>{h ? <><Dot ok={h.ok} label={h.ok ? 'Reachable' : 'Problem'} /> <span className="text-xs text-neutral-500">checked {ago(h.checked_at)}</span>
                  <div className="mt-1 break-words text-xs text-neutral-500">{h.detail}</div></> : <span className="text-neutral-500">Health not checked yet (hourly).</span>}</div>
                <div className="text-xs text-neutral-600">Last 30 days: <b>{fmt(pd?.candidates)}</b> domains{pd?.days ? <> · {fmt(Math.round(pd.candidates / pd.days))} per active day</> : null}</div>
                <form action={saveSource} className="space-y-2 rounded border border-neutral-100 p-3">
                  <input type="hidden" name="key" value={s.key} />
                  <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Run on schedule</label>
                  <label className="block"><span className="mb-1 block text-xs text-neutral-600">Schedule (cron, UTC)</span><input name="schedule" defaultValue={s.schedule} className={`${input} font-mono`} /></label>
                  <Submit className={btn.primary}>Save</Submit>
                </form>
              </div>
              <Table head={['Started', 'Status', 'Read', 'New domains', 'Speed /min', 'Dropped', 'Took']} empty={!mine.length}>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs">{ago(r.started_at)}</td>
                    <td className={r.status === 'failed' ? 'text-red-700' : r.status === 'running' ? 'text-amber-700' : 'text-emerald-700'}>{r.status}
                      {r.error && <div className="max-w-xs break-words text-xs text-red-700">{r.error.slice(0, 200)}</div>}</td>
                    <td className="tabular-nums text-xs">{fmt(r.in_count)}</td><td className="tabular-nums text-xs">{fmt(r.out_count)}</td>
                    <td className="tabular-nums text-xs">{fmt(r.per_minute)}</td>
                    <td className="text-xs">{Object.entries(r.dropped ?? {}).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || '–'}</td>
                    <td className="text-xs">{r.finished_at ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)} s` : '…'}</td>
                  </tr>
                ))}
              </Table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
