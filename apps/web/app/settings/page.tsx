import { q } from '@/lib/db';
import { ago, date, fmt } from '@/lib/format';
import { Card, Notice, PageHeader, Pager, Table, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { addSuppression, deleteSuppression, importSuppression, saveSetting } from './actions';

export const dynamic = 'force-dynamic';

const GROUP_NAMES: Record<string, string> = {
  stage: 'Batch sizes and pipeline limits', fetch: 'Crawling (speed and politeness)', dns: 'DNS', tech: 'Technology detection', probe: 'Store probes',
  classify: 'Niche classification', contacts: 'Contact extraction', signals: 'Business signals', audit: 'Website audit', lighthouse: 'Lighthouse',
  scoring: 'Scoring', first_lines: 'First lines', normalize: 'Domain registry rules', disk: 'Disk', funnel: 'Dashboard', dashboard: 'Dashboard',
};

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; s?: string; find?: string; page?: string }> }) {
  const sp = await searchParams;
  const find = (sp.find ?? '').trim().toLowerCase();
  const page = Math.max(1, Number(sp.page) || 1);
  const [settings, supp, suppCount, fp, dead] = await Promise.all([
    q<{ key: string; value: unknown; description: string | null; updated_at: Date }>(`SELECT key, value, description, updated_at FROM settings
      WHERE ($1 = '' OR key ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%') ORDER BY key`, [sp.s ?? '']),
    q<{ id: number; kind: string; value: string; reason: string | null; created_at: Date }>(`SELECT * FROM suppression WHERE ($1 = '' OR value LIKE '%' || $1 || '%')
      ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET $2`, [find, (page - 1) * 100]),
    q<{ n: number; emails: number; domains: number }>(`SELECT count(*) FILTER (WHERE ($1 = '' OR value LIKE '%' || $1 || '%'))::int n,
      count(*) FILTER (WHERE kind = 'email')::int emails, count(*) FILTER (WHERE kind = 'domain')::int domains FROM suppression`, [find]),
    q<{ value: { technologies: number; commit: string | null; source: string | null; overrides: { name: string; note: string | null }[] }; measured_at: Date }>(
      `SELECT value, measured_at FROM system_metrics WHERE metric = 'fingerprints' ORDER BY id DESC LIMIT 1`),
    q<{ id: string; name: string; data: Record<string, unknown> | null; completed_on: Date; output: { message?: string } | null }>(`SELECT id, name, data, completed_on, output
      FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '7 days' ORDER BY completed_on DESC LIMIT 30`),
  ]);
  const groups = new Map<string, typeof settings>();
  for (const s of settings) { const g = s.key.split('.')[0]!; groups.set(g, [...(groups.get(g) ?? []), s]); }
  const c = suppCount[0]!;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Everything the engine does is driven by these values. Changes are used by the next batch; no restart needed." />
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.saved && <Notice tone="green">Saved: {sp.saved}</Notice>}

      <Card title={<span id="suppression">Do-not-contact list ({fmt(c.emails)} emails, {fmt(c.domains)} domains)</span>}>
        <p className="mb-4 text-sm text-neutral-600">Anything here never appears in a segment and is removed again before every export. Add unsubscribes, bounces and anyone who asked not to be contacted.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <form action={addSuppression} className="flex flex-wrap items-end gap-2">
            <label className="min-w-[14rem] flex-1"><span className="mb-1 block text-xs font-medium text-neutral-600">Email or domain</span><input name="value" required className={input} placeholder="name@shop.com or shop.com" /></label>
            <label className="w-40"><span className="mb-1 block text-xs font-medium text-neutral-600">Reason</span><input name="reason" className={input} placeholder="unsubscribed" /></label>
            <Submit className={btn.primary}>Add</Submit>
          </form>
          <form action={importSuppression} className="flex flex-wrap items-end gap-2">
            <label className="min-w-[14rem] flex-1"><span className="mb-1 block text-xs font-medium text-neutral-600">Import a CSV (any column with emails or domains)</span>
              <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" required className="block w-full text-sm" /></label>
            <Submit className={btn.secondary} pending="Importing…">Import</Submit>
          </form>
        </div>
        <form method="get" action="/settings#suppression" className="mt-5 flex gap-2">
          <input name="find" defaultValue={find} placeholder="Search the list" className={`${input} max-w-xs`} /><button className={btn.secondary}>Search</button>
        </form>
        <div className="mt-3">
          <Table head={['Email / domain', 'Type', 'Reason', 'Added', '']} empty={!supp.length}>
            {supp.map((s) => (
              <tr key={s.id}>
                <td className="font-mono text-xs">{s.value}</td><td className="text-xs">{s.kind}</td><td className="text-xs text-neutral-600">{s.reason ?? '–'}</td>
                <td className="text-xs text-neutral-500">{date(s.created_at)}</td>
                <td className="text-right"><form action={deleteSuppression}><input type="hidden" name="id" value={s.id} />
                  <Submit className="text-xs text-red-700 hover:underline" pending="…" confirm={`Remove ${s.value} from the do-not-contact list?`}>Remove</Submit></form></td>
              </tr>
            ))}
          </Table>
          <div className="mt-3"><Pager page={page} pages={Math.ceil(c.n / 100)} href={(p) => `/settings?find=${encodeURIComponent(find)}&page=${p}#suppression`} /></div>
        </div>
      </Card>

      <Card title={<span id="settings">Engine settings</span>} actions={
        <form method="get" action="/settings#settings" className="flex gap-2"><input name="s" defaultValue={sp.s ?? ''} placeholder="Find a setting" className={`${input} w-56`} /><button className={btn.secondary}>Find</button></form>}>
        <p className="mb-4 text-sm text-neutral-600">Values are JSON. A number must stay a number, a list a list. Concurrency and rate limits are under “Crawling”.</p>
        <div className="space-y-6">
          {[...groups.entries()].map(([g, list]) => (
            <div key={g}>
              <h3 className="mb-2 text-sm font-semibold">{GROUP_NAMES[g] ?? g}</h3>
              <div className="space-y-2">
                {list.map((s) => {
                  const json = JSON.stringify(s.value, null, 2);
                  return (
                    <form key={s.key} action={saveSetting} className="grid gap-2 rounded border border-neutral-100 p-3 md:grid-cols-[16rem_1fr_auto]">
                      <input type="hidden" name="key" value={s.key} />
                      <div><div className="font-mono text-xs font-medium">{s.key}</div><div className="mt-1 text-xs text-neutral-500">{s.description}</div>
                        <div className="mt-1 text-xs text-neutral-400">changed {ago(s.updated_at)}</div></div>
                      <textarea name="value" defaultValue={json} rows={Math.min(14, json.split('\n').length)} spellCheck={false} className={`${input} font-mono text-xs`} />
                      <div><Submit className={btn.secondary}>Save</Submit></div>
                    </form>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Technology fingerprints">
          {!fp[0] ? <p className="text-sm text-neutral-500">Shown after the worker starts.</p> : (
            <div className="space-y-2 text-sm">
              <p><b>{fmt(fp[0].value.technologies)}</b> technologies from <a className="underline" href={fp[0].value.source ?? '#'}>{fp[0].value.source}</a></p>
              <p className="text-xs text-neutral-600">Version: {fp[0].value.commit}</p>
              {fp[0].value.overrides.length > 0 && <div className="text-xs text-neutral-600">Local fixes: {fp[0].value.overrides.map((o) => <div key={o.name} className="mt-1"><b>{o.name}</b> — {o.note}</div>)}</div>}
              <p className="text-xs text-neutral-500">To update (on the server, then restart the worker):</p>
              <pre className="rounded bg-neutral-50 p-2 text-xs">bash packages/fingerprints/update.sh{'\n'}docker compose up -d --build worker</pre>
            </div>
          )}
        </Card>
        <Card title="Failed jobs (last 7 days)">
          <p className="mb-3 text-xs text-neutral-500">Jobs that failed after 3 tries (they are also copied to the dead-letter queue). Most fix themselves on the next scheduled run; the same job failing again and again needs a look.</p>
          <Table head={['When', 'Job', 'Error']} empty={!dead.length}>
            {dead.map((d) => (
              <tr key={d.id}><td className="whitespace-nowrap text-xs">{ago(d.completed_on)}</td>
                <td className="text-xs">{d.name}{d.data && Object.keys(d.data).length > 0 && <div className="font-mono text-[11px] text-neutral-500">{JSON.stringify(d.data).slice(0, 80)}</div>}</td>
                <td className="max-w-md break-words text-xs text-red-800">{(d.output?.message ?? JSON.stringify(d.output) ?? '').slice(0, 300)}</td></tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
