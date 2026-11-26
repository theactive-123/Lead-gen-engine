import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshOf, reachOf, scoreLead, type Brand, type Lead, type ScoringSettings } from '../src/stages/score/engine.js';
import { firstLines, lineProblem, render, variables, type LineRules, type Template } from '../src/stages/score/lines.js';

const sql = readFileSync(new URL('../../../packages/shared/migrations/019_brands_scoring.sql', import.meta.url), 'utf8');
const settingOf = (key: string) => JSON.parse(sql.match(new RegExp(`\\('${key.replace('.', '\\.')}', '(.+?)'::jsonb`))![1]!.replaceAll("''", "'"));
const settings: ScoringSettings = {
  reach: settingOf('scoring.reach'), freshness: settingOf('scoring.freshness'), severity: settingOf('scoring.severity'),
  confidence_share: settingOf('scoring.confidence_share'), size_outside: settingOf('scoring.size_outside'), size_unknown: settingOf('scoring.size_unknown'),
};
const rules: LineRules = settingOf('first_lines.rules');
// Every default template in the migration, as it is stored.
const templates: Template[] = [...sql.matchAll(/INSERT INTO brand_templates \(brand_id, finding_code, variant, template\) VALUES \((NULL|\(SELECT id FROM brands WHERE key = '(\w+)'\)), '([\w:]+)', (\d+), '((?:[^']|'')+)'\)/g)]
  .map((m, i) => ({ id: i + 1, brand_id: m[2] ? Number(m[2].split('_')[1]) : null, niche_id: null, finding_code: m[3]!, variant: Number(m[4]), template: m[5]!.replaceAll("''", "'") }));

const now = new Date('2026-11-26T12:00:00Z');
const brand: Brand = {
  id: 1, key: 'brand_1', platform_weights: { Shopify: 1, WooCommerce: 0.6 }, platform_default: 0.15, platform_null: 0.5,
  target_countries: ['US', 'GB'], excluded_countries: ['DE'], country_other: 0.3, country_unknown: 0.7, size: { product_min: 20, product_max: 2000 },
  need_full_at: 2, need_floor: 0.15, weights: { fit: 1, need: 1, reach: 1, fresh: 0.5 }, tiers: { A: 60, B: 40 }, // test brand: own numbers
  niches: new Map([[1, 1], [3, 0.2]]), subNiches: new Map([[11, 0.5]]),
  problems: new Map([['no_email_marketing_tool', { service: 'Klaviyo email setup', weight: 1 }], ['lighthouse_performance_poor', { service: 'Speed optimisation', weight: 1 }],
    ['no_reviews', { service: 'Reviews app setup', weight: 0.7 }], ['wix_site', { service: 'Migration to Shopify', weight: 0.8 }]]),
};
const lead: Lead = {
  domain_id: '7', domain: 'acme.com', niche_id: 1, niche_key: 'dtc', niche_gate: 'store', sub_niche_id: 10, sub_niche_key: 'apparel', confidence: 1,
  platform: 'Shopify', country: 'US', company: 'Acme', product_count: 120, email: 'jo@acme.com', email_type: 'named', phone: '+1 555', completeness: 1,
  freshness: { copyright_year: 2026, last_product_published: '2026-11-01T00:00:00Z' },
  findings: [
    { code: 'no_email_marketing_tool', severity: 'medium', evidence: { detection: 'html' } },
    { code: 'lighthouse_performance_poor', severity: 'high', evidence: { score: 29, tool: 'Google Lighthouse (mobile)' } },
    { code: 'missing_h1', severity: 'low', evidence: {} },
  ],
};

describe('scoring: fit × need × reach × fresh', () => {
  it('a strong lead: right niche, platform, country, size, two mapped problems, named email, active store', () => {
    const m = scoreLead(lead, brand, settings, now);
    expect(m.breakdown.fit.value).toBe(1);
    expect(m.breakdown.need.problems.map((p) => p.code)).toEqual(['lighthouse_performance_poor', 'no_email_marketing_tool']); // biggest first
    expect(m.breakdown.need.value).toBe(0.9); // (1×1 + 1×0.8) / 2
    expect(m.breakdown.reach.value).toBe(1);
    expect(m.breakdown.fresh.value).toBe(1);
    expect(m.score).toBe(90);
    expect(m.tier).toBe('A');
  });
  it('multiplies: a wrong platform pulls the score down hard (not averaged away)', () => {
    const m = scoreLead({ ...lead, platform: 'WordPress' }, brand, settings, now);
    expect(m.breakdown.fit.platform).toBe(0.15);
    expect(m.score).toBe(13.5);
    expect(m.tier).toBe('C');
  });
  it('a niche the brand does not target scores 0 (tier X) with the reason', () => {
    const m = scoreLead({ ...lead, niche_id: 2 }, brand, settings, now);
    expect(m).toMatchObject({ score: 0, tier: 'X' });
    expect(m.breakdown.fit.excluded).toBe('niche not targeted by this brand');
  });
  it('a sub-niche weight overrides the niche weight', () => {
    expect(scoreLead({ ...lead, sub_niche_id: 11 }, brand, settings, now).breakdown.fit).toMatchObject({ niche: 0.5, niche_from: 'sub_niche' });
  });
  it('excluded country is a hard 0; unknown and other countries are discounted', () => {
    expect(scoreLead({ ...lead, country: 'DE' }, brand, settings, now).tier).toBe('X');
    expect(scoreLead({ ...lead, country: null }, brand, settings, now).breakdown.fit.country).toBe(0.7);
    expect(scoreLead({ ...lead, country: 'FR' }, brand, settings, now).breakdown.fit.country).toBe(0.3);
  });
  it('catalog size only matters for stores', () => {
    expect(scoreLead({ ...lead, product_count: 5000 }, brand, settings, now).breakdown.fit.size).toBe(0.5);
    expect(scoreLead({ ...lead, product_count: null }, brand, settings, now).breakdown.fit.size).toBe(0.8);
    expect(scoreLead({ ...lead, product_count: 5000, niche_gate: null }, brand, settings, now).breakdown.fit.size).toBe(1);
  });
  it('no mapped problem → need falls to the floor, not zero', () => {
    const m = scoreLead({ ...lead, findings: [{ code: 'missing_h1', severity: 'low', evidence: {} }] }, brand, settings, now);
    expect(m.breakdown.need).toMatchObject({ value: 0.15, problems: [] });
  });
  it('reachability by email type and completeness', () => {
    expect(reachOf({ ...lead, email_type: 'role', completeness: 0.5 }, settings).value).toBe(0.68); // 0.8 × (0.7 + 0.3×0.5)
    expect(reachOf({ ...lead, email: null, completeness: 0.25 }, settings)).toMatchObject({ base: 0.3, via: 'phone only' });
    expect(reachOf({ ...lead, email: null, phone: null }, settings).base).toBe(0.05);
  });
  it('freshness: recent product > current copyright > young domain > unknown > stale', () => {
    expect(freshOf(lead, settings, now).value).toBe(1);
    expect(freshOf({ ...lead, freshness: { copyright_year: 2025 } }, settings, now).value).toBe(0.9);
    expect(freshOf({ ...lead, freshness: { domain_registered: '2026-03-01' } }, settings, now).value).toBe(0.9);
    expect(freshOf({ ...lead, freshness: {} }, settings, now).value).toBe(0.6);
    expect(freshOf({ ...lead, freshness: { copyright_year: 2021 } }, settings, now)).toMatchObject({ value: 0.35, via: 'copyright 2021 (stale)' });
  });
});

describe('first lines', () => {
  it('the default templates load from the migration', () => expect(templates.length).toBeGreaterThan(30));

  it('every default template, filled with typical real values, follows the rules (≤25 words, no banned phrases)', () => {
    const vars = { domain: 'smallbatchroasters.com', company: 'Small Batch Roasters', platform: 'Shopify', product_count: '84', score: '29', lcp_s: '7.2',
      tbt_s: '6.3', ttfb_s: '3.0', cls: '0.37', year: '2023', version: '5.3.17', scripts: '58', count: '16', broken_path: '/about-us/our-story' };
    for (const t of templates) {
      const text = render(t.template, vars);
      expect(text, t.template).not.toBeNull();
      expect(lineProblem(text!, rules), text!).toBeNull();
      expect(text).not.toMatch(/\{|\}/);
    }
  });

  it('values come from the finding evidence; a missing value skips the template', () => {
    const v = variables(lead, { code: 'lighthouse_lcp_poor', severity: 'high', evidence: { lcp_ms: 7224 } });
    expect(v['lcp_s']).toBe('7.2');
    expect(render('takes {lcp_s} seconds', v)).toBe('takes 7.2 seconds');
    expect(render('scores {score}/100', v)).toBeNull();
  });

  it('rules: word limit and banned phrases (case-insensitive)', () => {
    expect(lineProblem('Quick question about your store!', rules)).toBe('contains "!"');
    expect(lineProblem('I hope this finds you well and so on', rules)).toBe('contains "i hope this finds you well"');
    expect(lineProblem(Array(26).fill('word').join(' '), rules)).toBe('26 words (max 25)');
  });

  it('one line per real finding first, biggest problem first, each quoting the measured value', () => {
    const m = scoreLead(lead, brand, settings, now);
    const lines = firstLines(lead, 1, m.breakdown.need.problems, templates, rules);
    expect(lines.map((l) => l.finding_code)).toEqual(['lighthouse_performance_poor', 'no_email_marketing_tool', 'lighthouse_performance_poor']);
    expect(lines[0]!.text).toContain('29/100');
    expect(lines.map((l) => l.variant)).toEqual([1, 2, 3]);
    expect(new Set(lines.map((l) => l.text)).size).toBe(3);
  });

  it('never quotes a finding the lead does not have, nor one the brand does not solve', () => {
    const m = scoreLead(lead, brand, settings, now);
    const lines = firstLines(lead, 1, m.breakdown.need.problems, templates, rules);
    expect(lines.some((l) => l.finding_code === 'missing_h1')).toBe(false); // the lead has it, but brand 1 does not map it
    expect(lines.every((l) => lead.findings.some((f) => f.code === l.finding_code))).toBe(true);
  });

  it('a brand template beats the shared one; the niche line is used for the white-label brand', () => {
    const wix = { ...lead, findings: [{ code: 'wix_site', severity: 'info', evidence: { platform: 'Wix' } }] };
    const [l1] = firstLines(wix, 1, scoreLead(wix, brand, settings, now).breakdown.need.problems, templates, rules);
    expect(l1!.text).toBe('Noticed acme.com runs on Wix and wanted to ask whether a move to Shopify has come up.');
    const agency = { ...lead, sub_niche_key: 'web_agency', findings: [] };
    const [l4] = firstLines(agency, 4, [], templates, rules);
    expect(l4!.finding_code).toBe('niche:web_agency');
    expect(l4!.text).toContain('acme.com builds websites for clients');
  });
});

describe('first lines: lead_with_niche', () => {
  it('puts the business line first when the brand asks for it', () => {
    const agency: Lead = { ...lead, sub_niche_key: 'web_agency', findings: [{ code: 'outdated_copyright', severity: 'low', evidence: { year: 2023 } }] };
    const problems = [{ code: 'outdated_copyright', service: 'Overflow development capacity', weight: 0.5, severity: 'low', points: 0.25 }];
    expect(firstLines(agency, 4, problems, templates, rules).map((l) => l.finding_code)).toEqual(['outdated_copyright', 'niche:web_agency']);
    expect(firstLines(agency, 4, problems, templates, rules, true).map((l) => l.finding_code)).toEqual(['niche:web_agency', 'outdated_copyright']);
  });
});
