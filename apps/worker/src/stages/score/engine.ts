/**
 * Stage 11 — brand matching and scoring (pure functions, no I/O).
 *
 *   score = 100 × fit^w1 × need^w2 × reach^w3 × fresh^w4      (each part 0–1, weights per brand)
 *
 * Multiplying (not averaging) means one weak part pulls the whole score down: a lead in a niche the brand
 * does not serve scores 0, however good its contact data is. Every part is stored in the breakdown, so the
 * dashboard can show *why* a lead scored what it did.
 */

export interface Finding { code: string; severity: string; evidence: Record<string, unknown> | null }

export interface Lead {
  domain_id: string;
  domain: string;
  niche_id: number;
  niche_key: string;
  niche_gate: string | null;
  sub_niche_id: number | null;
  sub_niche_key: string | null;
  confidence: number | null;
  platform: string | null;
  country: string | null;
  company: string | null;
  product_count: number | null;
  email: string | null;
  email_type: string | null;
  phone: string | null;
  completeness: number | null;
  freshness: { copyright_year?: number | null; domain_registered?: string | null; last_product_published?: string | null } | null;
  findings: Finding[];
}

export interface Brand {
  id: number;
  key: string;
  platform_weights: Record<string, number>;
  platform_default: number;
  platform_null: number;
  target_countries: string[];
  excluded_countries: string[];
  country_other: number;
  country_unknown: number;
  size: { product_min?: number; product_max?: number };
  need_full_at: number;
  need_floor: number;
  weights: { fit: number; need: number; reach: number; fresh: number };
  tiers: { A: number; B: number };
  /** First line about the lead's business (niche:<sub-niche>) before its site problems. */
  lead_with_niche?: boolean;
  /** niche_id → weight (whole niche) */
  niches: Map<number, number>;
  /** sub_niche_id → weight (overrides the niche weight) */
  subNiches: Map<number, number>;
  /** finding code → service + weight */
  problems: Map<string, { service: string; weight: number }>;
}

export interface ScoringSettings {
  reach: { email: Record<string, number>; phone_only: number; nothing: number; completeness_share: number };
  freshness: { active_days: number; active: number; copyright_current: number; new_domain_days: number; new_domain: number; unknown: number; stale_years: number; stale: number };
  severity: Record<string, number>;
  confidence_share: number;
  size_outside: number;
  size_unknown: number;
}

export interface Problem { code: string; service: string; weight: number; severity: string; points: number }

export interface Breakdown {
  fit: { value: number; niche: number; niche_from: 'sub_niche' | 'niche' | 'none'; platform: number; country: number; size: number; confidence: number; excluded?: string };
  need: { value: number; points: number; problems: Problem[] };
  reach: { value: number; base: number; via: string; completeness: number };
  fresh: { value: number; via: string };
  weights: Brand['weights'];
}

export interface Match { brand_id: number; score: number; tier: 'A' | 'B' | 'C' | 'X'; breakdown: Breakdown }

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const DAY = 86_400_000;

export function fitOf(lead: Lead, b: Brand, s: ScoringSettings): Breakdown['fit'] {
  const sub = lead.sub_niche_id != null ? b.subNiches.get(lead.sub_niche_id) : undefined;
  const whole = b.niches.get(lead.niche_id);
  const niche = sub ?? whole ?? 0;
  const niche_from = sub != null ? 'sub_niche' : whole != null ? 'niche' : 'none';
  const platform = lead.platform == null ? b.platform_null : (b.platform_weights[lead.platform] ?? b.platform_default);
  let country = 1;
  let excluded: string | undefined;
  if (lead.country && b.excluded_countries.includes(lead.country)) {
    country = 0;
    excluded = `country ${lead.country} is excluded`;
  } else if (b.target_countries.length) {
    country = lead.country == null ? b.country_unknown : b.target_countries.includes(lead.country) ? 1 : b.country_other;
  }
  let size = 1;
  const { product_min: lo, product_max: hi } = b.size ?? {};
  if ((lo != null || hi != null) && lead.niche_gate === 'store') {
    if (lead.product_count == null) size = s.size_unknown;
    else if ((lo != null && lead.product_count < lo) || (hi != null && lead.product_count > hi)) size = s.size_outside;
  }
  const confidence = 1 - s.confidence_share + s.confidence_share * clamp(Number(lead.confidence ?? 0));
  if (niche === 0 && !excluded) excluded = niche_from === 'none' ? 'niche not targeted by this brand' : 'niche excluded (weight 0)';
  return { value: r3(clamp(niche * platform * country * size * confidence)), niche, niche_from, platform, country, size, confidence: r3(confidence), excluded };
}

export function needOf(lead: Lead, b: Brand, s: ScoringSettings): Breakdown['need'] {
  const problems: Problem[] = [];
  for (const f of lead.findings) {
    const m = b.problems.get(f.code);
    if (!m || m.weight <= 0) continue;
    const sev = s.severity[f.severity] ?? 0.5;
    problems.push({ code: f.code, service: m.service, weight: m.weight, severity: f.severity, points: r3(m.weight * sev) });
  }
  problems.sort((a, z) => z.points - a.points || a.code.localeCompare(z.code));
  const points = problems.reduce((n, p) => n + p.points, 0);
  const value = Math.max(b.need_floor, Math.min(1, points / Math.max(0.001, b.need_full_at)));
  return { value: r3(value), points: r3(points), problems };
}

export function reachOf(lead: Lead, s: ScoringSettings): Breakdown['reach'] {
  let base: number;
  let via: string;
  if (lead.email) {
    base = s.reach.email[lead.email_type ?? ''] ?? s.reach.email['role'] ?? 0.8;
    via = `email (${lead.email_type ?? 'unknown type'})`;
  } else if (lead.phone) {
    base = s.reach.phone_only;
    via = 'phone only';
  } else {
    base = s.reach.nothing;
    via = 'no email or phone';
  }
  const completeness = clamp(Number(lead.completeness ?? 0));
  const value = base * (1 - s.reach.completeness_share + s.reach.completeness_share * completeness);
  return { value: r3(value), base, via, completeness: r3(completeness) };
}

export function freshOf(lead: Lead, s: ScoringSettings, now: Date): Breakdown['fresh'] {
  const f = lead.freshness ?? {};
  const c = s.freshness;
  const year = now.getUTCFullYear();
  const lastProduct = f.last_product_published ? Date.parse(f.last_product_published) : NaN;
  if (Number.isFinite(lastProduct) && now.getTime() - lastProduct <= c.active_days * DAY) {
    return { value: c.active, via: `product published in the last ${c.active_days} days` };
  }
  if (f.copyright_year != null && f.copyright_year >= year - 1) return { value: c.copyright_current, via: `copyright ${f.copyright_year}` };
  const reg = f.domain_registered ? Date.parse(f.domain_registered) : NaN;
  if (Number.isFinite(reg) && now.getTime() - reg <= c.new_domain_days * DAY) return { value: c.new_domain, via: 'domain registered within a year' };
  if (f.copyright_year != null && f.copyright_year <= year - c.stale_years) return { value: c.stale, via: `copyright ${f.copyright_year} (stale)` };
  return { value: c.unknown, via: 'no activity signal' };
}

export function scoreLead(lead: Lead, b: Brand, s: ScoringSettings, now = new Date()): Match {
  const fit = fitOf(lead, b, s);
  const need = needOf(lead, b, s);
  const reach = reachOf(lead, s);
  const fresh = freshOf(lead, s, now);
  const w = b.weights;
  const breakdown: Breakdown = { fit, need, reach, fresh, weights: w };
  if (fit.value <= 0) return { brand_id: b.id, score: 0, tier: 'X', breakdown };
  const pow = (x: number, e: number) => Math.pow(Math.max(x, 0.01), Math.max(0, e));
  const score = Math.round(1000 * pow(fit.value, w.fit) * pow(need.value, w.need) * pow(reach.value, w.reach) * pow(fresh.value, w.fresh)) / 10;
  const tier = score >= b.tiers.A ? 'A' : score >= b.tiers.B ? 'B' : 'C';
  return { brand_id: b.id, score, tier, breakdown };
}
