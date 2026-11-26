import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q } from '@/lib/db';
import { fmt } from '@/lib/format';
import { Card, Field, Notice, PageHeader, Table, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { saveNiches, saveProblems, saveProfile, saveScoring, saveTargeting } from '../actions';
import { Templates, type TemplateRow } from '../templates';

export const dynamic = 'force-dynamic';

type Brand = {
  id: number; key: string; name: string; website: string | null; description: string | null; services: string[]; price_min: string | null; price_max: string | null;
  currency: string | null; platform_weights: Record<string, number>; platform_default: string; platform_null: string; target_countries: string[];
  excluded_countries: string[]; country_other: string; country_unknown: string; size: { product_min?: number; product_max?: number };
  need_full_at: string; need_floor: string; weights: { fit: number; need: number; reach: number; fresh: number }; tiers: { A: number; B: number };
  case_studies: { title: string; url: string | null; result: string | null }[]; enabled: boolean; lead_with_niche: boolean;
};

const SECTIONS = [['profile', 'Profile'], ['targeting', 'Who to target'], ['niches', 'Niches'], ['problems', 'Problems → services'], ['scoring', 'Scoring'], ['templates', 'First lines']] as const;

export default async function BrandPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const id = Number((await params).id);
  const sp = await searchParams;
  const b = await one<Brand>(`SELECT * FROM brands WHERE id = $1`, [id]);
  if (!b) notFound();
  const [platforms, niches, weights, findingCodes, problems, templates, codes] = await Promise.all([
    q<{ platform: string; n: number }>(`SELECT coalesce(c.platform, d.platform) AS platform, count(*)::int n FROM classifications k JOIN domains d ON d.id = k.domain_id
      LEFT JOIN companies c ON c.domain_id = d.id WHERE coalesce(c.platform, d.platform) IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    q<{ niche_id: number; niche: string; sub_id: number | null; sub: string | null; n: number }>(`
      SELECT n.id AS niche_id, n.name AS niche, NULL::int AS sub_id, NULL AS sub, (SELECT count(*)::int FROM classifications k WHERE k.niche_id = n.id) n
      FROM niches n WHERE n.enabled AND NOT n.excluded
      UNION ALL
      SELECT n.id, n.name, s.id, s.name, (SELECT count(*)::int FROM classifications k WHERE k.sub_niche_id = s.id)
      FROM sub_niches s JOIN niches n ON n.id = s.niche_id WHERE n.enabled AND NOT n.excluded AND s.enabled
      ORDER BY 2, 3 NULLS FIRST, 4`),
    q<{ niche_id: number; sub_niche_id: number | null; weight: string }>(`SELECT niche_id, sub_niche_id, weight::text FROM brand_niche_weights WHERE brand_id = $1`, [id]),
    q<{ code: string; severity: string; n: number; message: string }>(`SELECT code, min(severity) severity, count(*)::int n, min(message) message FROM audit_findings GROUP BY 1 ORDER BY 1`),
    q<{ finding_code: string; service: string; weight: string; leads: number }>(`
      SELECT p.finding_code, p.service, p.weight::text, (SELECT count(*)::int FROM audit_findings f WHERE f.code = p.finding_code) leads
      FROM brand_problem_map p WHERE p.brand_id = $1`, [id]),
    q<TemplateRow>(`SELECT t.id, t.finding_code, t.variant, t.template, t.enabled, (SELECT count(*)::int FROM first_lines f WHERE f.template_id = t.id) uses
      FROM brand_templates t WHERE t.brand_id = $1 ORDER BY t.finding_code, t.variant`, [id]),
    q<{ key: string }>(`SELECT 'niche:' || key AS key FROM sub_niches ORDER BY 1`),
  ]);
  const wKey = (n: number, s: number | null) => `${n}:${s ?? ''}`;
  const wMap = new Map(weights.map((w) => [wKey(w.niche_id, w.sub_niche_id), w.weight]));
  const pMap = new Map(problems.map((p) => [p.finding_code, p]));
  const allCodes = [...new Set([...findingCodes.map((f) => f.code), ...problems.map((p) => p.finding_code)])].sort();

  return (
    <div className="space-y-6">
      <PageHeader title={b.name} description={<>Key <code>{b.key}</code> · changes are scored on the next run (every 15 minutes).</>}
        actions={<Link className={btn.secondary} href="/brands">All brands</Link>} />
      <nav className="flex flex-wrap gap-2 text-sm">{SECTIONS.map(([k, n]) => <a key={k} href={`#${k}`} className="rounded border border-neutral-200 bg-white px-2.5 py-1 hover:bg-neutral-50">{n}</a>)}</nav>
      {sp.error && <Notice tone="red">{sp.error}</Notice>}
      {sp.saved && <Notice tone="green">Saved ({sp.saved}).</Notice>}

      <Card title={<span id="profile">Profile</span>}>
        <form action={saveProfile} className="grid gap-4 md:grid-cols-2">
          <input type="hidden" name="id" value={b.id} />
          <Field name="Name"><input name="name" defaultValue={b.name} required className={input} /></Field>
          <Field name="Website"><input name="website" defaultValue={b.website ?? ''} placeholder="https://" className={input} /></Field>
          <div className="md:col-span-2"><Field name="Short description"><input name="description" defaultValue={b.description ?? ''} className={input} /></Field></div>
          <Field name="Services offered" hint="One per line."><textarea name="services" rows={5} defaultValue={b.services.join('\n')} className={input} /></Field>
          <Field name="Case studies" hint="One per line: title | link | result (e.g. “Shop X | https://… | +38% conversion”)">
            <textarea name="case_studies" rows={5} defaultValue={b.case_studies.map((c) => [c.title, c.url ?? '', c.result ?? ''].join(' | ')).join('\n')} className={input} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field name="Price from"><input name="price_min" type="number" min="0" defaultValue={b.price_min ?? ''} className={input} /></Field>
            <Field name="Price to"><input name="price_max" type="number" min="0" defaultValue={b.price_max ?? ''} className={input} /></Field>
            <Field name="Currency"><input name="currency" defaultValue={b.currency ?? ''} className={input} /></Field>
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={b.enabled} /> Brand is active (scored)</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="lead_with_niche" defaultChecked={b.lead_with_niche} /> First line about the lead’s business comes first (white-label style)</label>
          </div>
          <div className="md:col-span-2"><Submit className={btn.primary}>Save profile</Submit></div>
        </form>
      </Card>

      <Card title={<span id="targeting">Who to target</span>}>
        <form action={saveTargeting} className="space-y-5">
          <input type="hidden" name="id" value={b.id} />
          <div>
            <h3 className="mb-2 text-sm font-medium">Platforms</h3>
            <p className="mb-3 text-xs text-neutral-500">How well each platform fits, 0 to 1 (1 = ideal, 0 = never). Empty = use the default below.</p>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {platforms.map((p) => (
                <label key={p.platform} className="flex items-center justify-between gap-2 rounded border border-neutral-100 px-2 py-1.5 text-sm">
                  <span>{p.platform} <span className="text-xs text-neutral-400">{fmt(p.n)}</span></span>
                  <input name={`pw:${p.platform}`} type="number" step="0.05" min="0" max="1" defaultValue={b.platform_weights[p.platform] ?? ''} className={`${input} w-20`} />
                </label>
              ))}
            </div>
            <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
              <Field name="Any other platform"><input name="platform_default" type="number" step="0.05" min="0" max="1" defaultValue={b.platform_default} className={input} /></Field>
              <Field name="Platform unknown"><input name="platform_null" type="number" step="0.05" min="0" max="1" defaultValue={b.platform_null} className={input} /></Field>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field name="Target countries" hint="ISO codes, e.g. US, GB, CA. Empty = every country."><input name="target_countries" defaultValue={b.target_countries.join(', ')} className={input} /></Field>
            <Field name="Never these countries" hint="Score 0, e.g. EU countries if you do not cold-email there."><input name="excluded_countries" defaultValue={b.excluded_countries.join(', ')} className={input} /></Field>
            <Field name="Other known country (0–1)"><input name="country_other" type="number" step="0.05" min="0" max="1" defaultValue={b.country_other} className={input} /></Field>
            <Field name="Country unknown (0–1)"><input name="country_unknown" type="number" step="0.05" min="0" max="1" defaultValue={b.country_unknown} className={input} /></Field>
            <Field name="Store size: products from" hint="Only for store niches. Empty = any size."><input name="product_min" type="number" min="0" defaultValue={b.size.product_min ?? ''} className={input} /></Field>
            <Field name="Store size: products to"><input name="product_max" type="number" min="0" defaultValue={b.size.product_max ?? ''} className={input} /></Field>
          </div>
          <Submit className={btn.primary}>Save targeting</Submit>
        </form>
      </Card>

      <Card title={<span id="niches">Niches</span>}>
        <form action={saveNiches} className="space-y-3">
          <input type="hidden" name="id" value={b.id} />
          <p className="text-xs text-neutral-500">Weight 0–1 per niche. A sub-niche weight overrides its niche. Empty = not targeted (score 0). 0 = explicitly excluded.</p>
          <Table head={['Niche / sub-niche', 'Leads', 'Weight']}>
            {niches.map((n) => (
              <tr key={wKey(n.niche_id, n.sub_id)}>
                <td className={n.sub_id ? 'pl-6 text-neutral-600' : 'font-medium'}>{n.sub ?? n.niche}</td>
                <td className="tabular-nums text-xs">{fmt(n.n)}</td>
                <td><input name={`nw:${n.niche_id}:${n.sub_id ?? ''}`} type="number" step="0.05" min="0" max="1" defaultValue={wMap.get(wKey(n.niche_id, n.sub_id)) ?? ''} className={`${input} w-24`} /></td>
              </tr>
            ))}
          </Table>
          <Submit className={btn.primary}>Save niches</Submit>
        </form>
      </Card>

      <Card title={<span id="problems">Problems → services</span>}>
        <form action={saveProblems} className="space-y-3">
          <input type="hidden" name="id" value={b.id} />
          <p className="text-xs text-neutral-500">Write the service you sell next to each website problem this brand can fix. Weight (0–1) = how strongly it signals a need. Empty service = not your problem.</p>
          <Table head={['Finding', 'Example', 'Sites', 'Your service', 'Weight']}>
            {allCodes.map((code) => {
              const f = findingCodes.find((x) => x.code === code);
              const p = pMap.get(code);
              return (
                <tr key={code}>
                  <td className="text-xs font-medium">{code}</td>
                  <td className="max-w-xs text-xs text-neutral-500">{f?.message ?? ''}</td>
                  <td className="tabular-nums text-xs">{fmt(f?.n ?? 0)}</td>
                  <td><input name={`svc:${code}`} defaultValue={p?.service ?? ''} className={`${input} min-w-[14rem]`} /></td>
                  <td><input name={`wt:${code}`} type="number" step="0.05" min="0" max="1" defaultValue={p?.weight ?? '1'} className={`${input} w-20`} /></td>
                </tr>
              );
            })}
          </Table>
          <Submit className={btn.primary}>Save problem map</Submit>
        </form>
      </Card>

      <Card title={<span id="scoring">Scoring</span>}>
        <form action={saveScoring} className="space-y-4">
          <input type="hidden" name="id" value={b.id} />
          <p className="text-sm text-neutral-600">score = 100 × fit<sup>a</sup> × need<sup>b</sup> × reach<sup>c</sup> × freshness<sup>d</sup>. A higher power makes that part matter more; 0 ignores it.</p>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field name="a · fit"><input name="w_fit" type="number" step="0.1" min="0" max="5" defaultValue={b.weights.fit} className={input} /></Field>
            <Field name="b · need"><input name="w_need" type="number" step="0.1" min="0" max="5" defaultValue={b.weights.need} className={input} /></Field>
            <Field name="c · reach"><input name="w_reach" type="number" step="0.1" min="0" max="5" defaultValue={b.weights.reach} className={input} /></Field>
            <Field name="d · freshness"><input name="w_fresh" type="number" step="0.1" min="0" max="5" defaultValue={b.weights.fresh} className={input} /></Field>
            <Field name="Tier A from"><input name="tier_a" type="number" min="0" max="100" defaultValue={b.tiers.A} className={input} /></Field>
            <Field name="Tier B from"><input name="tier_b" type="number" min="0" max="100" defaultValue={b.tiers.B} className={input} /></Field>
            <Field name="Full need at (points)" hint="One strong problem = 1 point."><input name="need_full_at" type="number" step="0.1" min="0.1" defaultValue={b.need_full_at} className={input} /></Field>
            <Field name="Need with no problem (0–1)"><input name="need_floor" type="number" step="0.05" min="0" max="1" defaultValue={b.need_floor} className={input} /></Field>
          </div>
          <Submit className={btn.primary}>Save scoring</Submit>
        </form>
      </Card>

      <Card title={<span id="templates">First-line templates for this brand</span>}>
        <p className="mb-3 text-xs text-neutral-500">These replace the <Link className="underline" href="/brands#templates">shared templates</Link> for the same finding and variant.</p>
        <Templates brandId={b.id} rows={templates} codes={[...allCodes, ...codes.map((c) => c.key)]} />
      </Card>
    </div>
  );
}
