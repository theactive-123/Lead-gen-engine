import { describe, expect, it } from 'vitest';
import { Classifier, termSource, type PageInput, type Taxonomy } from '../src/stages/classify/engine.js';

const re = (t: string) => new RegExp(termSource(t), 'i');

describe('termSource (whole words, plurals, punctuation)', () => {
  it('matches whole words and simple plurals only', () => {
    expect(re('candle').test('Soy Candles for every room')).toBe(true);
    expect(re('candle').test('candlestick holders')).toBe(false);
    expect(re('tent').test('content marketing')).toBe(false);
    expect(re('inn').test('dinner')).toBe(false);
  });
  it('handles spaces, hyphens and apostrophes flexibly', () => {
    expect(re('pre-workout').test('best preworkout')).toBe(true);
    expect(re('pre-workout').test('pre workout blend')).toBe(true);
    expect(re("men's grooming").test('Mens Grooming kits')).toBe(true);
    expect(re('b&b').test('Cosy B&B by the sea')).toBe(true);
    expect(re('omega-3').test('omega 3 capsules')).toBe(true);
  });
});

const tax: Taxonomy = {
  niches: [
    { id: 1, key: 'dtc', name: 'DTC', gate: 'store', excluded: false },
    { id: 2, key: 'white_label', name: 'WL', gate: 'services', excluded: false },
    { id: 3, key: 'wellness', name: 'Wellness', gate: 'booking', excluded: false },
    { id: 4, key: 'saturated', name: 'Sat', gate: 'none', excluded: true },
  ],
  subNiches: [
    { id: 10, key: 'coffee_tea', name: 'Coffee', niche_id: 1 },
    { id: 20, key: 'seo_agency', name: 'SEO', niche_id: 2 },
    { id: 30, key: 'boutique_fitness', name: 'Fitness', niche_id: 3 },
    { id: 40, key: 'restaurant', name: 'Restaurants', niche_id: 4 },
  ],
  keywords: [
    { sub_niche_id: 10, term: 'coffee beans', kind: 'positive', weight: 1 },
    { sub_niche_id: 10, term: 'roaster', kind: 'positive', weight: 1 },
    { sub_niche_id: 10, term: 'our menu', kind: 'negative', weight: 3 },
    { sub_niche_id: 20, term: 'seo services', kind: 'positive', weight: 1 },
    { sub_niche_id: 30, term: 'pilates', kind: 'positive', weight: 1 },
    { sub_niche_id: 40, term: 'restaurant', kind: 'positive', weight: 1 },
    { sub_niche_id: 40, term: 'our menu', kind: 'positive', weight: 1 },
  ],
  urlPatterns: [{ niche_id: 2, sub_niche_id: null, pattern: '^/services(/|$)', weight: 1.5 }],
  techHints: [{ niche_id: 3, tech: 'MindBody', weight: 3 }],
  fieldWeights: { title: 3, h1: 2, meta: 2, site_name: 2, products: 2, text: 1, domain: 1 },
  minScore: 4,
};
const page = (o: Partial<PageInput>): PageInput => ({
  domain: 'example.com', title: null, h1: null, meta: null, site_name: null, text: null, products: null,
  link_paths: [], techs: [], store_evidence: false, product_count: null, platform: null, ...o,
});
const c = new Classifier(tax);

describe('Classifier', () => {
  it('DTC needs a real store: coffee words without a store are not a coffee brand', () => {
    const noStore = c.classify(page({ title: 'Small batch coffee roaster', text: 'fresh coffee beans' }));
    expect(noStore.sub_niche).toBeNull();
    expect(noStore.reason).toBe('looks like coffee_tea (4) but no store evidence found');
    const r = c.classify(page({ title: 'Small batch coffee roaster', text: 'fresh coffee beans', store_evidence: true }));
    expect(r).toMatchObject({ niche: 'dtc', sub_niche: 'coffee_tea', in_scope: true });
    expect(r.reason).toContain('roaster');
  });
  it('negative terms push a café towards "restaurant" (excluded)', () => {
    const r = c.classify(page({ title: 'Roaster Café & Restaurant', text: 'see our menu, coffee beans to go', store_evidence: true }));
    expect(r.sub_niche).toBe('restaurant');
    expect(r.in_scope).toBe(false);
  });
  it('booking software boosts wellness studios that already have keyword evidence', () => {
    expect(c.classify(page({ h1: 'pilates' })).in_scope).toBe(false); // 2 points: too weak alone
    const r = c.classify(page({ h1: 'pilates', techs: ['MindBody'] }));
    expect(r).toMatchObject({ sub_niche: 'boutique_fitness', in_scope: true });
    expect(r.reason).toContain('MindBody');
  });
  it('boosts never stand in for keywords (seen: study-abroad site scored as an agency)', () => {
    expect(c.classify(page({ text: 'pilates', techs: ['MindBody'] })).in_scope).toBe(false); // 1 keyword point < 2
  });
  it('body text alone cannot carry a match (cap 2 points)', () => {
    const r = c.classify(page({ text: 'coffee beans roaster espresso coffee beans', store_evidence: true }));
    expect(r.in_scope).toBe(false);
  });
  it('services pages boost agencies, but a big shop is not an agency', () => {
    expect(c.classify(page({ title: 'SEO services', link_paths: ['/services/seo'] })).sub_niche).toBe('seo_agency');
    expect(c.classify(page({ title: 'SEO services', store_evidence: true, platform: 'Shopify', product_count: 300 })).in_scope).toBe(false);
  });
  it('domain names count for long single words ("10-4coffee" contains coffee)', () => {
    const t2: Taxonomy = { ...tax, keywords: [...tax.keywords, { sub_niche_id: 10, term: 'coffee', kind: 'positive', weight: 1 }] };
    const r = new Classifier(t2).classify(page({ domain: '10-4coffee.com', title: 'Coffee', store_evidence: true }));
    expect(r.reason).toContain('domain');
  });
});
