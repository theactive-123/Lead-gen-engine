import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Run = { id: string; stage: string; status: string; started_at: Date; in_count: string; out_count: string; per_minute: number; seconds: number | null };
type QueueRow = { name: string; state: string; n: string };
type Metric = { value: Record<string, any>; measured_at: Date };
type Worker = { id: string; last_beat: Date; info: { rss_mb: number; uptime_s: number } };

function fmt(n: number | string) {
  return Number(n).toLocaleString('en-US');
}
function ago(d: Date) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-medium text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${ok ? 'text-emerald-700' : 'text-red-700'}`}>
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
      {label}
    </span>
  );
}

export default async function SystemPage() {
  let dbOk = true;
  let runs: Run[] = [];
  let queues: QueueRow[] = [];
  let workers: Worker[] = [];
  let disk: Metric | undefined;
  try {
    runs = await q<Run>(
      `SELECT id, stage, status, started_at, in_count, out_count, per_minute,
              extract(epoch FROM (coalesce(finished_at, now()) - started_at))::float AS seconds
       FROM runs ORDER BY started_at DESC LIMIT 20`,
    );
    queues = await q<QueueRow>(
      `SELECT name, state::text AS state, count(*)::text AS n FROM pgboss.job
       WHERE name NOT LIKE '\\_\\_%' GROUP BY 1, 2 ORDER BY 1`,
    );
    workers = await q<Worker>(`SELECT id, last_beat, info FROM workers WHERE last_beat > now() - interval '2 minutes' ORDER BY id`);
    [disk] = await q<Metric>(`SELECT value, measured_at FROM system_metrics WHERE metric='disk' ORDER BY id DESC LIMIT 1`);
  } catch {
    dbOk = false;
  }

  const workerOk = workers.length > 0;
  const byQueue = new Map<string, Record<string, number>>();
  for (const r of queues) {
    const m = byQueue.get(r.name) ?? {};
    m[r.state] = Number(r.n);
    byQueue.set(r.name, m);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">System status</h1>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Database">
          <Status ok={dbOk} label={dbOk ? 'Connected' : 'Not reachable'} />
        </Card>
        <Card title="Worker">
          <Status ok={workerOk} label={workerOk ? `${workers.length} running` : 'No worker alive (2 min)'} />
          {workers.map((w) => (
            <p key={w.id} className="mt-2 text-xs text-neutral-500">
              {w.id} · beat {ago(w.last_beat)} · {w.info.rss_mb} MB · up {Math.round(w.info.uptime_s / 60)} min
            </p>
          ))}
        </Card>
        <Card title="Disk">
          {disk ? (
            <>
              <p className="text-sm">{disk.value.disk_free_gb} GB free of {disk.value.disk_total_gb} GB</p>
              <p className="mt-2 text-xs text-neutral-500">Checked {ago(disk.measured_at)}</p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">No measurement yet</p>
          )}
        </Card>
      </div>

      <Card title="Data lake (Parquet)">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr><th className="py-1 font-normal">Dataset</th><th className="font-normal">Files</th><th className="font-normal">Size</th></tr>
          </thead>
          <tbody>
            {(disk?.value.lake ?? []).map((d: { dataset: string; files: number; bytes: number }) => (
              <tr key={d.dataset} className="border-t border-neutral-100">
                <td className="py-1.5">{d.dataset}</td><td>{fmt(d.files)}</td><td>{(d.bytes / 1e6).toFixed(1)} MB</td>
              </tr>
            ))}
            {!disk?.value.lake?.length && <tr><td className="py-1.5 text-neutral-500" colSpan={3}>Empty</td></tr>}
          </tbody>
        </table>
      </Card>

      <Card title="Queues (jobs by state)">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr>{['Queue', 'Waiting', 'Active', 'Retry', 'Done', 'Failed'].map((h) => <th key={h} className="py-1 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            {[...byQueue.entries()].map(([name, s]) => (
              <tr key={name} className="border-t border-neutral-100">
                <td className="py-1.5">{name}</td>
                <td>{fmt(s.created ?? 0)}</td><td>{fmt(s.active ?? 0)}</td><td>{fmt(s.retry ?? 0)}</td>
                <td>{fmt(s.completed ?? 0)}</td><td className={s.failed ? 'text-red-700' : ''}>{fmt(s.failed ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Recent runs">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500">
            <tr>{['Stage', 'Status', 'In', 'Out', 'Per minute', 'Took', 'Started'].map((h) => <th key={h} className="py-1 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-neutral-100">
                <td className="py-1.5">{r.stage}</td>
                <td className={r.status === 'failed' ? 'text-red-700' : r.status === 'running' ? 'text-amber-700' : 'text-emerald-700'}>{r.status}</td>
                <td>{fmt(r.in_count)}</td><td>{fmt(r.out_count)}</td><td>{fmt(r.per_minute)}</td>
                <td>{r.seconds != null ? `${r.seconds.toFixed(1)}s` : ''}</td><td>{ago(r.started_at)}</td>
              </tr>
            ))}
            {!runs.length && <tr><td className="py-1.5 text-neutral-500" colSpan={7}>No runs yet</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
