import { db, lakeQuery, setting } from '@lead/shared';
import { auditPlan } from '../stages/audit/stage.js';
import { classifyPlan } from '../stages/classify/stage.js';
import { contactsPlan } from '../stages/contacts/stage.js';
import { dnsPlan } from '../stages/dns/stage.js';
import { fetchPlan } from '../stages/fetch/stage.js';
import { lighthousePlan } from '../stages/lighthouse/stage.js';
import { probePlan } from '../stages/probe/stage.js';
import { signalsPlan } from '../stages/signals/stage.js';
import { techPlan } from '../stages/tech/stage.js';
import { lakeFiles } from './lake-maintenance.js';

/**
 * Volume, funnel, speed and bottlenecks over the last `days` days (build spec §15: "reports real funnel numbers daily").
 * Saved every morning (system_metrics 'report'); `pnpm jobs report 7` prints the 7-day version.
 */
export async function buildReport(days: number) {
  const q = db();
  const since = `now() - interval '${Math.max(1, Math.round(days))} days'`;
  // New = first seen in this window (each domain once, from the hourly funnel count); read = rows the source delivered (incl. repeats).
  const fresh = (await q.query<{ source: string; new_domains: number }>(`
    SELECT source, sum(candidates)::int new_domains FROM funnel_daily WHERE day > current_date - $1::int GROUP BY 1`, [Math.max(1, Math.round(days))])).rows;
  const runsBySource = (await q.query<{ source: string; runs: number; read: number; failed: number }>(`
    SELECT substr(stage, 8) AS source, count(*)::int runs, coalesce(sum(out_count), 0)::int read, count(*) FILTER (WHERE status = 'failed')::int failed
    FROM runs WHERE stage LIKE 'source.%' AND started_at > ${since} GROUP BY 1`)).rows;
  const sources = [...new Set([...fresh.filter((f) => f.source !== 'all').map((f) => f.source), ...runsBySource.map((r) => r.source)])].map((source) => {
    const r = runsBySource.find((x) => x.source === source);
    return { source, new_domains: fresh.find((f) => f.source === source)?.new_domains ?? 0, read: r?.read ?? 0, runs: r?.runs ?? 0, failed: r?.failed ?? 0 };
  }).sort((a, z) => z.new_domains - a.new_domains);
  const stages = (await q.query<{ stage: string; runs: number; records: number; failed: number; per_min: number | null }>(`
    SELECT stage, count(*)::int runs, coalesce(sum(in_count), 0)::int records, count(*) FILTER (WHERE status = 'failed')::int failed,
      round(sum(in_count) FILTER (WHERE status = 'ok') / nullif(sum(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'ok') / 60, 0))::int per_min
    FROM runs WHERE stage LIKE 'stage.%' AND started_at > ${since} GROUP BY 1 ORDER BY 1`)).rows;
  const leads = (await q.query<{ in_niche: number; with_email: number; qualified: number; total_in_niche: number; total_qualified: number }>(`
    SELECT count(*) FILTER (WHERE k.classified_at > ${since})::int in_niche,
      count(*) FILTER (WHERE k.classified_at > ${since} AND ct.email IS NOT NULL)::int with_email,
      count(*) FILTER (WHERE k.classified_at > ${since} AND EXISTS (SELECT 1 FROM brand_matches m WHERE m.domain_id = k.domain_id AND m.tier IN ('A','B')))::int qualified,
      count(*)::int total_in_niche,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM brand_matches m WHERE m.domain_id = k.domain_id AND m.tier IN ('A','B')))::int total_qualified
    FROM classifications k LEFT JOIN contacts ct ON ct.domain_id = k.domain_id`)).rows[0]!;
  const failedJobs = (await q.query<{ name: string; n: number }>(`
    SELECT name, count(*)::int n FROM pgboss.job WHERE state = 'failed' AND completed_on > ${since} GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const disk = (await q.query<{ value: { disk_free_gb: number; disk_total_gb: number; lake: { dataset: string; bytes: number }[] } }>(
    `SELECT value FROM system_metrics WHERE metric = 'disk' ORDER BY id DESC LIMIT 1`)).rows[0]?.value;
  const diskThen = (await q.query<{ value: { lake: { bytes: number }[] } }>(
    `SELECT value FROM system_metrics WHERE metric = 'disk' AND measured_at > ${since} ORDER BY id LIMIT 1`)).rows[0]?.value;
  const lakeBytes = (v?: { lake: { bytes: number }[] }) => (v?.lake ?? []).reduce((n, d) => n + Number(d.bytes), 0);

  // Backlog = what each stage still has to do right now; days to clear = backlog / what it did per day in this window.
  const backlog: { stage: string; todo: number; per_day: number; days_to_clear: number | null }[] = [];
  for (const p of [dnsPlan, fetchPlan, techPlan, probePlan, classifyPlan, contactsPlan, signalsPlan, auditPlan, lighthousePlan]) {
    try {
      const sql = await p.todoSql();
      const todo = sql ? Number((await lakeQuery<{ n: bigint }>(`SELECT count(*) AS n FROM (${sql})`))[0]!.n) : 0;
      const done = stages.find((s) => s.stage === `stage.${p.key}`)?.records ?? 0;
      const perDay = done / Math.max(1, days);
      backlog.push({ stage: p.key, todo, per_day: Math.round(perDay), days_to_clear: perDay > 0 ? Math.round((todo / perDay) * 10) / 10 : todo ? null : 0 });
    } catch (err) {
      backlog.push({ stage: p.key, todo: -1, per_day: 0, days_to_clear: null });
    }
  }
  const newDomains = fresh.find((f) => f.source === 'all')?.new_domains ?? 0; // each domain once, even if several sources found it
  const perMonth = Math.round((newDomains / Math.max(1, days)) * 30);
  const target = Number(await setting('report.monthly_target', 1_000_000));
  const ranked = backlog.filter((b) => b.stage !== 'lighthouse' && b.todo > 0).sort((a, z) => (z.days_to_clear ?? Infinity) - (a.days_to_clear ?? Infinity));
  return {
    days, created_at: new Date().toISOString(),
    volume: { new_domains: newDomains, per_day: Math.round(newDomains / Math.max(1, days)), projected_per_month: perMonth, target, on_track: perMonth >= target, sources },
    leads, stages, backlog, bottleneck: ranked[0] ?? null, failed_jobs: failedJobs,
    disk: disk ? { free_gb: disk.disk_free_gb, total_gb: disk.disk_total_gb, lake_gb: +(lakeBytes(disk) / 1e9).toFixed(2),
      lake_growth_gb: diskThen ? +((lakeBytes(disk) - lakeBytes(diskThen)) / 1e9).toFixed(2) : null } : null,
    lake_files: await lakeFiles(),
  };
}
export type Report = Awaited<ReturnType<typeof buildReport>>;

export async function dailyReport(): Promise<Record<string, unknown>> {
  const r = await buildReport(1);
  await db().query(`INSERT INTO system_metrics (metric, value) VALUES ('report', $1)`, [JSON.stringify(r)]);
  return { new_domains: r.volume.new_domains, bottleneck: r.bottleneck?.stage ?? null };
}

const n = (x: number | null | undefined) => (x == null ? '–' : Number(x).toLocaleString('en-US'));

/** Plain-text version for the command line (and to paste into a message). */
export function reportText(r: Report): string {
  const L: string[] = [];
  L.push(`LeadEngine report — last ${r.days} day(s), ${r.created_at.slice(0, 16).replace('T', ' ')} UTC`, '');
  L.push(`VOLUME  ${n(r.volume.new_domains)} new domains (${n(r.volume.per_day)}/day) → ~${n(r.volume.projected_per_month)}/month`
    + ` (target ${n(r.volume.target)}: ${r.volume.on_track ? 'on track' : 'BELOW TARGET'})`);
  for (const s of r.volume.sources) L.push(`  ${s.source.padEnd(12)} ${n(s.new_domains).padStart(11)} new · ${n(s.read).padStart(11)} read  ${s.runs} runs${s.failed ? `, ${s.failed} failed` : ''}`);
  L.push('', `LEADS   in this window: ${n(r.leads.in_niche)} in niche, ${n(r.leads.with_email)} with email, ${n(r.leads.qualified)} tier A/B`
    + `   (all time: ${n(r.leads.total_in_niche)} in niche, ${n(r.leads.total_qualified)} A/B)`, '');
  L.push('STAGES  records   per min   failed runs');
  for (const s of r.stages) L.push(`  ${s.stage.padEnd(18)} ${n(s.records).padStart(10)} ${n(s.per_min).padStart(9)} ${String(s.failed).padStart(8)}`);
  L.push('', 'BACKLOG  to do now   done/day   days to clear');
  for (const b of r.backlog) L.push(`  ${b.stage.padEnd(11)} ${(b.todo < 0 ? 'error' : n(b.todo)).padStart(11)} ${n(b.per_day).padStart(10)} ${(b.days_to_clear == null ? '–' : String(b.days_to_clear)).padStart(10)}`);
  if (r.bottleneck) L.push('', `BOTTLENECK  ${r.bottleneck.stage}: ${n(r.bottleneck.todo)} waiting, ~${r.bottleneck.days_to_clear ?? '?'} days at the current speed`);
  if (r.failed_jobs.length) L.push('', `FAILED JOBS  ${r.failed_jobs.map((f) => `${f.name} ${f.n}`).join(', ')}`);
  if (r.disk) L.push('', `DISK  ${r.disk.free_gb} GB free of ${r.disk.total_gb} GB · data lake ${r.disk.lake_gb} GB${r.disk.lake_growth_gb != null ? ` (+${r.disk.lake_growth_gb} GB in this window)` : ''}`);
  L.push(`FILES ${Object.entries(r.lake_files).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  return L.join('\n');
}
