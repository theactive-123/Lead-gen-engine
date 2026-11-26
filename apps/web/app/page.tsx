import Link from 'next/link';
import { q } from '@/lib/db';
import { ago, fmt, pct } from '@/lib/format';
import { Bar, Card, Dot, Notice, PageHeader, Stat, Table, cx } from '@/components/ui';

export const dynamic = 'force-dynamic';

type Funnel = { source: string; candidates: number; kept: number; dns_checked: number; resolved: number; fetched: number; in_niche: number; with_contact: number; qualified: number };
const STEPS: [keyof Funnel, string, string][] = [
  ['candidates', 'Candidates', 'New domains from all sources'],
  ['kept', 'Kept', 'Not junk (TLD / random-name rules)'],
  ['resolved', 'Resolved', 'DNS works, not parked'],
  ['fetched', 'Fetched', 'Homepage loaded and usable'],
  ['in_niche', 'In niche', 'Matches one of your niches'],
  ['with_contact', 'With email', 'In niche and an email was found'],
  ['qualified', 'Qualified', 'Tier A or B for at least one brand'],
];
const WINDOWS = [[1, 'Today'], [7, '7 days'], [30, '30 days']] as const;

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const days = [1, 7, 30].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const since = `current_date - ${days - 1}`;

  const [bySource, updated, niches, brands, throughput, queues, health, sourceRuns] = await Promise.all([
    q<Funnel>(`SELECT source, sum(candidates)::int candidates, sum(kept)::int kept, sum(dns_checked)::int dns_checked, sum(resolved)::int resolved,
                 sum(fetched)::int fetched, sum(in_niche)::int in_niche, sum(with_contact)::int with_contact, sum(qualified)::int qualified
               FROM funnel_daily WHERE day >= ${since} GROUP BY source ORDER BY (source = 'all') DESC, sum(candidates) DESC`),
    q<{ at: Date | null }>(`SELECT max(updated_at) AS at FROM funnel_daily`),
    q<{ name: string; key: string; n: number; with_email: number; qualified: number }>(`
      SELECT n.name, n.key, count(*)::int n, count(ct.email)::int with_email,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM brand_matches m WHERE m.domain_id = d.id AND m.tier IN ('A','B')))::int qualified
      FROM classifications k JOIN niches n ON n.id = k.niche_id JOIN domains d ON d.id = k.domain_id LEFT JOIN contacts ct ON ct.domain_id = d.id
      WHERE d.first_seen >= ${since} GROUP BY 1, 2 ORDER BY 3 DESC`),
    q<{ id: number; name: string; a: number; b: number; c: number }>(`
      SELECT b.id, b.name, count(*) FILTER (WHERE m.tier = 'A')::int a, count(*) FILTER (WHERE m.tier = 'B')::int b, count(*) FILTER (WHERE m.tier = 'C')::int c
      FROM brands b LEFT JOIN brand_matches m ON m.brand_id = b.id AND m.domain_id IN (SELECT id FROM domains WHERE first_seen >= ${since})
      WHERE b.enabled GROUP BY 1, 2 ORDER BY 1`),
    q<{ stage: string; runs: number; records: number; ok_records: number; minutes: number | null; failed: number; last: Date }>(`
      SELECT stage, count(*)::int runs, sum(in_count)::int records,
        -- speed only from runs that finished normally (a run cut off by a restart has no real duration)
        sum(in_count) FILTER (WHERE status = 'ok')::int ok_records,
        round(sum(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'ok') / 60.0, 2)::float minutes,
        count(*) FILTER (WHERE status = 'failed')::int failed, max(started_at) last
      FROM runs WHERE started_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`),
    q<{ name: string; waiting: number; active: number; retry: number; failed: number }>(`
      SELECT name, count(*) FILTER (WHERE state = 'created')::int waiting, count(*) FILTER (WHERE state = 'active')::int active,
        count(*) FILTER (WHERE state = 'retry')::int retry, count(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '24 hours')::int failed
      FROM pgboss.job WHERE name NOT LIKE '\\_\\_%' AND state IN ('created', 'active', 'retry', 'failed') GROUP BY 1 ORDER BY 1`),
    q<{ value: Record<string, { ok: boolean; detail: string; checked_at: string }>; measured_at: Date }>(
      `SELECT value, measured_at FROM system_metrics WHERE metric = 'source_health' ORDER BY id DESC LIMIT 1`),
    q<{ key: string; label: string; enabled: boolean; status: string | null; started_at: Date | null; out_count: number | null }>(`
      SELECT s.key, s.label, s.enabled, r.status, r.started_at, r.out_count FROM sources s
      LEFT JOIN LATERAL (SELECT status, started_at, out_count FROM runs WHERE stage = 'source.' || s.key ORDER BY started_at DESC LIMIT 1) r ON true ORDER BY s.key`),
  ]);
  const [report] = await q<{ value: { volume: { per_day: number; projected_per_month: number; target: number; on_track: boolean };
    bottleneck: { stage: string; todo: number; days_to_clear: number | null } | null; failed_jobs: { name: string; n: number }[] }; measured_at: Date }>(
    `SELECT value, measured_at FROM system_metrics WHERE metric = 'report' ORDER BY id DESC LIMIT 1`);
  const all = bySource.find((r) => r.source === 'all');
  const perSource = bySource.filter((r) => r.source !== 'all');
  const backlog = all && all.kept > 0 && all.dns_checked < all.kept * 0.5;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={<>How many domains reached each step, counted by the day they were first seen. Recounted every hour (last: {ago(updated[0]?.at)}).</>}
        actions={WINDOWS.map(([d, name]) => (
          <Link key={d} href={`/?days=${d}`} className={cx('rounded-md border px-3 py-1.5 text-sm', d === days ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white')}>{name}</Link>
        ))}
      />

      {report && (
        <Card title={<>Daily report <span className="ml-1 text-xs font-normal text-neutral-500">{ago(report.measured_at)} · last 24 hours</span></>}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="New domains per day" value={fmt(report.value.volume.per_day)}
              sub={<>≈ {fmt(report.value.volume.projected_per_month)} per month · target {fmt(report.value.volume.target)} {report.value.volume.on_track ? '✓' : '— below target'}</>} />
            <Stat label="Bottleneck" value={report.value.bottleneck?.stage ?? 'none'}
              sub={report.value.bottleneck ? <>{fmt(report.value.bottleneck.todo)} waiting · {report.value.bottleneck.days_to_clear != null ? `~${report.value.bottleneck.days_to_clear} days at the last 24 h speed` : 'did not run in the last 24 h'}</> : 'every stage keeps up'} />
            <Stat label="Failed jobs (24 h)" value={fmt(report.value.failed_jobs.reduce((n, f) => n + f.n, 0))}
              sub={report.value.failed_jobs.map((f) => `${f.name} ${f.n}`).join(', ') || 'none'} />
          </div>
        </Card>
      )}
      {!all && <Notice tone="amber">No funnel numbers for this period yet. The worker counts them every hour (job <code>system.funnel</code>).</Notice>}
      {all && (
        <Card title="Funnel">
          <div className="space-y-3">
            {STEPS.map(([k, name, hint], i) => {
              const v = Number(all[k]);
              const prev = i > 0 ? Number(all[STEPS[i - 1]![0]]) : v;
              return (
                <div key={k} className="grid grid-cols-[10rem_1fr_7rem_5rem] items-center gap-4 text-sm">
                  <div><div className="font-medium">{name}</div><div className="text-xs text-neutral-500">{hint}</div></div>
                  <Bar value={Math.log10(v + 1)} max={Math.log10(Number(all.candidates) + 1)} />
                  <div className="text-right font-semibold tabular-nums">{fmt(v)}</div>
                  <div className="text-right text-xs text-neutral-500">{i > 0 ? `${pct(v, prev)} of prev.` : ''}</div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-neutral-500">Bars use a log scale so millions and hundreds fit on one chart.</p>
          {backlog && (
            <div className="mt-4"><Notice tone="amber">Only {fmt(all.dns_checked)} of {fmt(all.kept)} kept domains have been DNS-checked so far: the
              pipeline is still working through this period (highest-priority domains first).</Notice></div>
          )}
        </Card>
      )}

      <Card title="By source">
        <Table head={['Source', ...STEPS.map((s) => s[1])]} empty={!perSource.length}>
          {perSource.map((r) => (
            <tr key={r.source}>
              <td className="font-medium">{r.source}</td>
              {STEPS.map(([k]) => <td key={k} className="tabular-nums">{fmt(r[k])}</td>)}
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-neutral-500">A domain found by several sources is counted under each of them; the funnel above counts it once.</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By niche">
          <Table head={['Niche', 'Leads', 'With email', 'Qualified (A/B)']} empty={!niches.length}>
            {niches.map((r) => (
              <tr key={r.key}>
                <td><Link className="hover:underline" href={`/explorer?niches=${r.key}`}>{r.name}</Link></td>
                <td className="tabular-nums">{fmt(r.n)}</td>
                <td className="tabular-nums">{fmt(r.with_email)} <span className="text-xs text-neutral-500">{pct(r.with_email, r.n)}</span></td>
                <td className="tabular-nums">{fmt(r.qualified)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="By brand">
          <Table head={['Brand', 'Tier A', 'Tier B', 'Tier C']} empty={!brands.length}>
            {brands.map((r) => (
              <tr key={r.id}>
                <td><Link className="hover:underline" href={`/explorer?brand=${r.id}&tiers=A,B`}>{r.name}</Link></td>
                <td className="tabular-nums">{fmt(r.a)}</td><td className="tabular-nums">{fmt(r.b)}</td><td className="tabular-nums">{fmt(r.c)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Throughput (last 24 hours)">
          <Table head={['Stage', 'Runs', 'Records', 'Per minute', 'Failed', 'Last run']} empty={!throughput.length}>
            {throughput.map((r) => (
              <tr key={r.stage}>
                <td>{r.stage}</td><td className="tabular-nums">{fmt(r.runs)}</td><td className="tabular-nums">{fmt(r.records)}</td>
                <td className="tabular-nums">{r.minutes && r.minutes > 0 ? fmt(Math.round(r.ok_records / r.minutes)) : '–'}</td>
                <td className={cx('tabular-nums', r.failed > 0 && 'text-red-700')}>{fmt(r.failed)}</td><td className="text-neutral-500">{ago(r.last)}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-neutral-500">Per minute = records ÷ time spent working (not wall-clock), i.e. the speed of the stage while it runs.</p>
        </Card>
        <Card title="Queue depth">
          <Table head={['Queue', 'Waiting', 'Running', 'Retrying', 'Failed (24 h)']} empty={!queues.length}>
            {queues.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td><td className="tabular-nums">{fmt(r.waiting)}</td><td className="tabular-nums">{fmt(r.active)}</td>
                <td className="tabular-nums">{fmt(r.retry)}</td><td className={cx('tabular-nums', r.failed > 0 && 'text-red-700')}>{fmt(r.failed)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Source health" actions={<Link className="text-sm text-neutral-600 hover:underline" href="/sources">Manage sources</Link>}>
        <Table head={['Source', 'Enabled', 'Reachable', 'Last run', 'Domains in last run']}>
          {sourceRuns.map((s) => {
            const h = health[0]?.value?.[s.key];
            return (
              <tr key={s.key}>
                <td className="font-medium">{s.label}</td>
                <td>{s.enabled ? 'Yes' : 'No'}</td>
                <td>{h ? <span title={h.detail}><Dot ok={h.ok} label={h.ok ? 'OK' : 'Problem'} /> <span className="text-xs text-neutral-500">{ago(h.checked_at)}</span></span> : <span className="text-neutral-500">not checked yet</span>}</td>
                <td>{s.status ? <><span className={s.status === 'failed' ? 'text-red-700' : ''}>{s.status}</span> <span className="text-xs text-neutral-500">{ago(s.started_at)}</span></> : '–'}</td>
                <td className="tabular-nums">{fmt(s.out_count)}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Candidates in period" value={fmt(all?.candidates)} />
        <Stat label="Leads in niche" value={fmt(all?.in_niche)} />
        <Stat label="With email" value={fmt(all?.with_contact)} sub={all ? pct(all.with_contact, all.in_niche) : undefined} />
        <Stat label="Qualified (A/B)" value={fmt(all?.qualified)} />
      </div>
    </div>
  );
}
