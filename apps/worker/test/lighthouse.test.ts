import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { clearedByRuntime, lighthouseFindings, runtimeTechs, summarizeLhr, type LhSummary, type LighthouseRules } from '../src/stages/lighthouse/core.js';
import { TechEngine } from '../src/stages/tech/engine.js';

const sql = readFileSync(new URL('../../../packages/shared/migrations/017_lighthouse.sql', import.meta.url), 'utf8');
const rules = JSON.parse(sql.slice(sql.indexOf("('lighthouse.rules', '") + 22, sql.indexOf("}', 'Lighthouse finding") + 1)) as LighthouseRules;
// Real Lighthouse 13.6 mobile report (slimmed to the fields we read), 716fitnessapparel.com, 2026-11-25.
const lhr = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/lighthouse/716fitnessapparel.json.gz', import.meta.url))).toString('utf8'));
const engine = new TechEngine();

const base: LhSummary = { performance: 90, accessibility: 95, best_practices: 95, seo: 95, lcp_ms: 2000, cls: 0.01, tbt_ms: 100,
  fcp_ms: 1000, speed_index_ms: 2000, total_kb: 900, requests: 40, final_url: 'https://x.com/', lighthouse_version: '13.6.0' };
const codes = (s: LhSummary) => lighthouseFindings(s, rules).map((f) => f.code);

describe('Lighthouse (pure parts)', () => {
  it('summarises a real report into 0-100 scores and metrics', () => {
    const { summary, scriptUrls } = summarizeLhr(lhr);
    expect(summary.performance).toBe(70);
    expect(summary.accessibility).toBe(93);
    expect(summary.seo).toBe(92);
    expect(summary.lcp_ms).toBeGreaterThan(0);
    expect(summary.requests).toBe(146);
    expect(summary.lighthouse_version).toMatch(/^13\./);
    expect(scriptUrls.length).toBeGreaterThan(5);
    expect(scriptUrls.every((u) => /^https?:/.test(u))).toBe(true);
  });
  it('finds technologies in the scripts the browser loaded (Shopify store)', () => {
    const { scriptUrls } = summarizeLhr(lhr);
    const names = runtimeTechs(engine, 'https://716fitnessapparel.com/', scriptUrls).map((t) => t.name);
    expect(names).toContain('Shopify');
  });
  it('a healthy site has no findings', () => expect(codes(base)).toEqual([]));
  it('uses Google\'s "poor" thresholds', () => {
    expect(codes({ ...base, performance: 49 })).toContain('lighthouse_performance_poor');
    expect(codes({ ...base, performance: 50 })).not.toContain('lighthouse_performance_poor');
    expect(codes({ ...base, lcp_ms: 4001 })).toContain('lighthouse_lcp_poor');
    expect(codes({ ...base, lcp_ms: 4000 })).not.toContain('lighthouse_lcp_poor');
    expect(codes({ ...base, cls: 0.26 })).toContain('lighthouse_cls_poor');
    expect(codes({ ...base, tbt_ms: 601 })).toContain('lighthouse_tbt_poor');
    expect(codes({ ...base, accessibility: 69, seo: 79, best_practices: 69 })).toEqual(
      expect.arrayContaining(['lighthouse_accessibility_poor', 'lighthouse_seo_poor', 'lighthouse_best_practices_poor']));
  });
  it('findings quote the measured value and name the tool', () => {
    const [f] = lighthouseFindings({ ...base, performance: 33 }, rules);
    expect(f!.message).toContain('33/100');
    expect(f!.evidence).toMatchObject({ score: 33, tool: 'Google Lighthouse (mobile)' });
    expect(f!.severity).toBe('high');
  });
  it('a tool seen at runtime clears the matching light finding only', () => {
    const techs = [{ name: 'Klaviyo', categories: ['Marketing automation'] }, { name: 'Google Analytics', categories: ['Analytics'] }];
    const cleared = clearedByRuntime(['no_email_marketing_tool', 'no_analytics', 'no_reviews', 'missing_h1'], techs, rules);
    expect(cleared).toEqual([{ code: 'no_email_marketing_tool', by: 'Klaviyo' }, { code: 'no_analytics', by: 'Google Analytics' }]);
  });
});
