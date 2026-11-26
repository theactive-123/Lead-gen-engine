import type { SegmentFilter } from '@lead/shared/segment-filter';
import type { FilterOptions } from '@/lib/options';
import { btn, input, label } from '@/components/ui';

/** Plain GET form: filters go into the URL, so any view can be bookmarked or shared. */
export function FilterForm({ o, brandId, f, sort }: { o: FilterOptions; brandId: number; f: SegmentFilter; sort: string }) {
  const has = (list: string[] | undefined, v: string) => !!list?.includes(v);
  const csv = (v: string[] | undefined) => v?.join(', ') ?? '';
  return (
    <form method="get" action="/explorer" className="space-y-4 text-sm">
      <div>
        <span className={label}>Brand</span>
        <select name="brand" defaultValue={brandId} className={input}>
          {o.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      <div>
        <span className={label}>Tier</span>
        <div className="flex gap-3">
          {['A', 'B', 'C'].map((t) => (
            <label key={t} className="flex items-center gap-1.5"><input type="checkbox" name="tiers" value={t} defaultChecked={has(f.tiers, t)} /> {t}</label>
          ))}
        </div>
      </div>
      <div>
        <span className={label}>Niche</span>
        <select name="niches" multiple defaultValue={f.niches} className={`${input} h-24`}>
          {o.niches.map((n) => <option key={n.key} value={n.key}>{n.name}</option>)}
        </select>
      </div>
      <div>
        <span className={label}>Sub-niche</span>
        <select name="sub_niches" multiple defaultValue={f.sub_niches} className={`${input} h-32`}>
          {[...new Set(o.subNiches.map((s) => s.niche))].map((niche) => (
            <optgroup key={niche} label={niche}>
              {o.subNiches.filter((s) => s.niche === niche).map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div>
        <span className={label}>Platform</span>
        <select name="platforms" multiple defaultValue={f.platforms} className={`${input} h-28`}>
          {o.platforms.map((p) => <option key={p.platform} value={p.platform}>{p.platform} ({p.n.toLocaleString('en-US')})</option>)}
        </select>
      </div>
      <TextList name="countries" title="Countries (ISO codes)" value={csv(f.countries)} placeholder="US, GB, CA" list="countries" />
      <TextList name="exclude_countries" title="Exclude countries" value={csv(f.exclude_countries)} placeholder="e.g. DE, FR" list="countries" />
      <TextList name="tech_has" title="Has all of these technologies" value={csv(f.tech_has)} placeholder="Facebook Pixel" list="techs" />
      <TextList name="tech_any" title="Has at least one of" value={csv(f.tech_any)} list="techs" />
      <TextList name="tech_not" title="Has none of" value={csv(f.tech_not)} placeholder="Klaviyo" list="techs" />
      <div className="grid grid-cols-2 gap-2">
        <Num name="product_count_min" title="Products from" value={f.product_count_min} />
        <Num name="product_count_max" title="Products to" value={f.product_count_max} />
        <Num name="price_median_min" title="Median price from" value={f.price_median_min} />
        <Num name="price_median_max" title="Median price to" value={f.price_median_max} />
        <Num name="lighthouse_perf_max" title="Lighthouse speed ≤" value={f.lighthouse_perf_max} />
        <Num name="min_score" title="Score ≥" value={f.min_score} />
        <Num name="completeness_min" title="Completeness ≥ (0–1)" value={f.completeness_min} step="0.05" />
        <div>
          <span className={label}>Email</span>
          <select name="has_email" defaultValue={f.has_email === true ? 'yes' : f.has_email === false ? 'no' : ''} className={input}>
            <option value="">Any</option><option value="yes">Has email</option><option value="no">No email</option>
          </select>
        </div>
      </div>
      <div>
        <span className={label}>Email type</span>
        <div className="flex gap-3">
          {['named', 'role', 'freemail'].map((t) => (
            <label key={t} className="flex items-center gap-1.5"><input type="checkbox" name="email_types" value={t} defaultChecked={has(f.email_types, t)} /> {t}</label>
          ))}
        </div>
      </div>
      <TextList name="findings_has" title="Has all of these findings" value={csv(f.findings_has)} placeholder="no_email_marketing_tool" list="findings" />
      <TextList name="findings_any" title="Has at least one finding of" value={csv(f.findings_any)} list="findings" />
      <TextList name="findings_not" title="Has none of these findings" value={csv(f.findings_not)} list="findings" />
      <div>
        <span className={label}>First seen on or after</span>
        <input type="date" name="first_seen_after" defaultValue={f.first_seen_after} className={input} />
      </div>
      <div>
        <span className={label}>Sort by</span>
        <select name="sort" defaultValue={sort} className={input}>
          <option value="score">Score (high first)</option><option value="new">Newest first</option><option value="products">Most products</option>
          <option value="speed">Slowest Lighthouse first</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button className={btn.primary} type="submit">Apply filters</button>
        <a className={btn.secondary} href={`/explorer?brand=${brandId}`}>Clear</a>
      </div>
      <datalist id="countries">{o.countries.map((c) => <option key={c.country} value={c.country}>{c.n}</option>)}</datalist>
      <datalist id="techs">{o.techs.map((t) => <option key={t.tech} value={t.tech} />)}</datalist>
      <datalist id="findings">{o.findings.map((t) => <option key={t.code} value={t.code} />)}</datalist>
    </form>
  );
}

function TextList({ name, title, value, placeholder, list }: { name: string; title: string; value: string; placeholder?: string; list: string }) {
  return (
    <div>
      <span className={label}>{title}</span>
      <input name={name} defaultValue={value} placeholder={placeholder} list={list} className={input} />
    </div>
  );
}

function Num({ name, title, value, step }: { name: string; title: string; value: number | undefined; step?: string }) {
  return (
    <div>
      <span className={label}>{title}</span>
      <input type="number" name={name} defaultValue={value} step={step ?? '1'} min="0" className={input} />
    </div>
  );
}
