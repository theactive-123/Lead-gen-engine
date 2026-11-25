import type { Finding, Severity } from '../audit/light.js';
import type { TechEngine } from '../tech/engine.js';

/** Stage 10 — Lighthouse: pure parts (summary of a report, findings, runtime technologies). */
export interface LighthouseRules {
  performance_poor: number;
  accessibility_poor: number;
  best_practices_poor: number;
  seo_poor: number;
  lcp_poor_ms: number;
  cls_poor: number;
  tbt_poor_ms: number;
  severity: Record<string, Severity>;
  runtime_clears: Record<string, string[]>; // light finding code -> tool categories that disprove it
}

export interface LhSummary {
  performance: number | null;
  accessibility: number | null;
  best_practices: number | null;
  seo: number | null;
  lcp_ms: number | null;
  cls: number | null;
  tbt_ms: number | null;
  fcp_ms: number | null;
  speed_index_ms: number | null;
  total_kb: number | null;
  requests: number | null;
  final_url: string | null;
  lighthouse_version: string | null;
}

const pct = (s: number | null | undefined) => (s == null ? null : Math.round(s * 100));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Keep only the numbers we use from a Lighthouse result (the full report is ~1 MB). */
export function summarizeLhr(lhr: any): { summary: LhSummary; scriptUrls: string[] } {
  const a = lhr.audits ?? {};
  const items: { url: string; resourceType?: string; transferSize?: number }[] = a['network-requests']?.details?.items ?? [];
  const bytes = num(a['total-byte-weight']?.numericValue);
  return {
    summary: {
      performance: pct(lhr.categories?.performance?.score),
      accessibility: pct(lhr.categories?.accessibility?.score),
      best_practices: pct(lhr.categories?.['best-practices']?.score),
      seo: pct(lhr.categories?.seo?.score),
      lcp_ms: num(a['largest-contentful-paint']?.numericValue),
      cls: num(a['cumulative-layout-shift']?.numericValue),
      tbt_ms: num(a['total-blocking-time']?.numericValue),
      fcp_ms: num(a['first-contentful-paint']?.numericValue),
      speed_index_ms: num(a['speed-index']?.numericValue),
      total_kb: bytes == null ? null : Math.round(bytes / 1024),
      requests: items.length || null,
      final_url: lhr.finalDisplayedUrl ?? lhr.mainDocumentUrl ?? null,
      lighthouse_version: lhr.lighthouseVersion ?? null,
    },
    scriptUrls: items.filter((i) => i.resourceType === 'Script' && /^https?:/.test(i.url)).map((i) => i.url),
  };
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function lighthouseFindings(s: LhSummary, rules: LighthouseRules): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, message: string, evidence: Record<string, unknown>) =>
    out.push({ code, severity: rules.severity[code] ?? 'low', message, evidence: { ...evidence, tool: 'Google Lighthouse (mobile)' } });
  if (s.performance != null && s.performance < rules.performance_poor) add('lighthouse_performance_poor', `Mobile speed score is ${s.performance}/100 in Google Lighthouse.`, { score: s.performance });
  if (s.lcp_ms != null && s.lcp_ms > rules.lcp_poor_ms) add('lighthouse_lcp_poor', `On mobile the main content takes ${sec(s.lcp_ms)} to appear (Google calls over 4 s poor).`, { lcp_ms: Math.round(s.lcp_ms) });
  if (s.tbt_ms != null && s.tbt_ms > rules.tbt_poor_ms) add('lighthouse_tbt_poor', `Scripts block the page from responding for ${sec(s.tbt_ms)} on mobile.`, { tbt_ms: Math.round(s.tbt_ms) });
  if (s.cls != null && s.cls > rules.cls_poor) add('lighthouse_cls_poor', `The layout jumps around while loading (layout shift ${s.cls.toFixed(2)}).`, { cls: Number(s.cls.toFixed(3)) });
  if (s.accessibility != null && s.accessibility < rules.accessibility_poor) add('lighthouse_accessibility_poor', `Accessibility score is ${s.accessibility}/100 in Google Lighthouse.`, { score: s.accessibility });
  if (s.seo != null && s.seo < rules.seo_poor) add('lighthouse_seo_poor', `SEO basics score is ${s.seo}/100 in Google Lighthouse.`, { score: s.seo });
  if (s.best_practices != null && s.best_practices < rules.best_practices_poor) add('lighthouse_best_practices_poor', `Best-practices score is ${s.best_practices}/100 in Google Lighthouse.`, { score: s.best_practices });
  return out;
}

/** Technologies seen in the scripts the page actually loaded (same open fingerprints as stage 4). */
export function runtimeTechs(engine: TechEngine, url: string, scriptUrls: string[]) {
  const html = scriptUrls.map((s) => `<script src="${s.replace(/"/g, '%22')}"></script>`).join('');
  return engine.analyze({ url, html, headers: {}, cookies: [] });
}

/** Light findings that a tool seen at runtime proves wrong (e.g. Klaviyo loaded by a tag manager). */
export function clearedByRuntime(lightCodes: string[], techs: { name: string; categories: string[] }[], rules: LighthouseRules): { code: string; by: string }[] {
  const out: { code: string; by: string }[] = [];
  for (const code of lightCodes) {
    const cats = rules.runtime_clears[code];
    if (!cats) continue;
    const t = techs.find((x) => x.categories.some((c) => cats.includes(c)));
    if (t) out.push({ code, by: t.name });
  }
  return out;
}
