import type { Finding, Lead, Problem } from './engine.js';

/**
 * Stage 12 — personalised first lines from templates (no AI, no key).
 * A template is filled only with values measured on the lead's own site ({score}, {lcp_s}, {year}…).
 * If a value is missing, that template is skipped: a line is never filled with a guess.
 */

export interface Template { id: number; brand_id: number | null; niche_id: number | null; finding_code: string; variant: number; template: string }
export interface LineRules { max_words: number; variants: number; banned: string[] }
export interface Line { variant: number; text: string; finding_code: string; template_id: number }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const seconds = (ms: unknown) => { const n = num(ms); return n == null ? null : (n / 1000).toFixed(1); };

/** Template values for one finding, taken only from its stored evidence (plus the lead itself). */
export function variables(lead: Lead, f: Finding | null): Record<string, string> {
  const v: Record<string, string> = { domain: lead.domain };
  if (lead.company) v['company'] = lead.company;
  if (lead.platform) v['platform'] = lead.platform;
  if (lead.product_count != null) v['product_count'] = String(lead.product_count);
  const e = (f?.evidence ?? {}) as Record<string, unknown>;
  const score = num(e['score']); if (score != null) v['score'] = String(Math.round(score));
  const lcp = seconds(e['lcp_ms']); if (lcp) v['lcp_s'] = lcp;
  const tbt = seconds(e['tbt_ms']); if (tbt) v['tbt_s'] = tbt;
  const ttfb = seconds(e['ttfb_ms']); if (ttfb) v['ttfb_s'] = ttfb;
  const cls = num(e['cls']); if (cls != null) v['cls'] = cls.toFixed(2);
  const year = num(e['year']); if (year != null) v['year'] = String(year);
  if (typeof e['version'] === 'string' && /^[\d.]+$/.test(e['version'])) v['version'] = e['version'];
  const scripts = num(e['scripts']); if (scripts != null) v['scripts'] = String(scripts);
  const count = num(e['count']); if (count != null) v['count'] = String(count);
  const broken = Array.isArray(e['broken']) ? e['broken'][0] : null;
  if (typeof broken === 'string') {
    try {
      const p = decodeURI(new URL(broken).pathname);
      if (p.length > 1 && p.length <= 40) v['broken_path'] = p;
    } catch { /* not a URL */ }
  }
  return v;
}

/** Fill {name} placeholders; null when any placeholder has no value. */
export function render(template: string, vars: Record<string, string>): string | null {
  let missing = false;
  const text = template.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    const val = vars[k];
    if (val == null || val === '') missing = true;
    return val ?? '';
  });
  return missing ? null : text.replace(/\s+/g, ' ').trim();
}

/** Why a line breaks the house rules (word limit, banned phrases), or null when it is fine. */
export function lineProblem(text: string, rules: LineRules): string | null {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > rules.max_words) return `${words} words (max ${rules.max_words})`;
  const low = text.toLowerCase();
  for (const b of rules.banned) if (b && low.includes(b.toLowerCase())) return `contains "${b}"`;
  return null;
}

/**
 * Up to `rules.variants` lines for one lead and brand. Order: the brand's biggest problems first (one line per
 * finding), then the line about the lead's business (`niche:<sub-niche>`; first when the brand sets
 * `lead_with_niche`), then extra variants.
 * Brand templates win over shared ones; templates for the lead's niche win over "any niche".
 */
export function firstLines(lead: Lead, brandId: number, problems: Problem[], templates: Template[], rules: LineRules, nicheFirst = false): Line[] {
  const byCode = new Map<string, Template[]>();
  for (const t of templates) {
    if (t.brand_id != null && t.brand_id !== brandId) continue;
    if (t.niche_id != null && t.niche_id !== lead.niche_id) continue;
    const list = byCode.get(t.finding_code) ?? [];
    list.push(t);
    byCode.set(t.finding_code, list);
  }
  // Per variant number keep the most specific template (brand + niche > brand > niche > shared).
  const rank = (t: Template) => (t.brand_id != null ? 2 : 0) + (t.niche_id != null ? 1 : 0);
  for (const [code, list] of byCode) {
    const best = new Map<number, Template>();
    for (const t of list) {
      const cur = best.get(t.variant);
      if (!cur || rank(t) > rank(cur)) best.set(t.variant, t);
    }
    byCode.set(code, [...best.values()].sort((a, z) => a.variant - z.variant));
  }
  const findings = new Map(lead.findings.map((f) => [f.code, f]));
  const candidates: { code: string; finding: Finding | null }[] = problems.map((p) => ({ code: p.code, finding: findings.get(p.code) ?? null }));
  if (lead.sub_niche_key) {
    const niche = { code: `niche:${lead.sub_niche_key}`, finding: null };
    if (nicheFirst) candidates.unshift(niche); else candidates.push(niche);
  }

  const options = candidates.map((c) => {
    const vars = variables(lead, c.finding);
    return (byCode.get(c.code) ?? []).flatMap((t) => {
      const text = render(t.template, vars);
      return text && !lineProblem(text, rules) ? [{ text, finding_code: c.code, template_id: t.id }] : [];
    });
  });
  const out: Omit<Line, 'variant'>[] = [];
  for (let round = 0; out.length < rules.variants && options.some((o) => o.length > round); round++) {
    for (const o of options) {
      if (out.length >= rules.variants) break;
      const pick = o[round];
      if (pick && !out.some((x) => x.text === pick.text)) out.push(pick);
    }
  }
  return out.map((l, i) => ({ variant: i + 1, ...l }));
}
