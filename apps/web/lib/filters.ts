import { SegmentFilter } from '@lead/shared/segment-filter';

/**
 * Explorer / segment filters live in the URL (shareable, back button works). Lists are comma-separated
 * or repeated params; everything is checked by the same schema the worker uses for saved segments.
 */
export type Params = Record<string, string | string[] | undefined>;

const LIST_KEYS = ['tiers', 'niches', 'sub_niches', 'platforms', 'tech_has', 'tech_any', 'tech_not', 'countries', 'exclude_countries',
  'email_types', 'findings_has', 'findings_any', 'findings_not'] as const;
const NUM_KEYS = ['min_score', 'product_count_min', 'product_count_max', 'price_median_min', 'price_median_max', 'lighthouse_perf_max', 'completeness_min'] as const;

function values(v: string | string[] | undefined): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
}

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** URL params → a checked filter, plus the problems (shown to the user, never silently ignored). */
export function parseFilter(p: Params): { filter: SegmentFilter; errors: string[] } {
  const raw: Record<string, unknown> = {};
  for (const k of LIST_KEYS) {
    const v = values(p[k]);
    if (v.length) raw[k] = k === 'countries' || k === 'exclude_countries' || k === 'tiers' ? v.map((x) => x.toUpperCase()) : v;
  }
  for (const k of NUM_KEYS) {
    const v = first(p[k]);
    if (v != null && v !== '') raw[k] = Number(v);
  }
  const he = first(p['has_email']);
  if (he === 'yes') raw['has_email'] = true;
  if (he === 'no') raw['has_email'] = false;
  const fs = first(p['first_seen_after']);
  if (fs) raw['first_seen_after'] = fs;
  const r = SegmentFilter.safeParse(raw);
  if (r.success) return { filter: r.data, errors: [] };
  return { filter: {}, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

/** A filter → URL query string (used by "open in explorer" links). */
export function filterToQuery(f: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const u = new URLSearchParams(extra);
  for (const [k, v] of Object.entries(f)) {
    if (v == null) continue;
    if (Array.isArray(v)) u.set(k, v.join(','));
    else if (typeof v === 'boolean') u.set(k, v ? 'yes' : 'no');
    else u.set(k, String(v));
  }
  return u.toString();
}
