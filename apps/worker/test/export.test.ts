import { describe, expect, it } from 'vitest';
import { COLUMNS, csvLine, fileName, phoneText, safeCell, services, sheetName, toRow, topFindings, type ExportLead } from '../src/stages/export/format.js';

const lead: ExportLead = {
  id: '42', domain: 'acme.com', final_url: 'https://www.acme.com/', first_seen: '2026-11-19', sources: ['commoncrawl', 'ct'], tier: 'A', match_score: '72.46',
  breakdown: { need: { problems: [{ code: 'no_email_marketing_tool', service: 'Klaviyo email setup' }, { code: 'no_reviews', service: 'Reviews app setup' }] } },
  niche: 'DTC ecommerce brands', sub_niche: 'Coffee & tea', company: 'Acme, "the" roasters', platform: 'Shopify', country: 'US', region: 'Oregon', city: 'Portland',
  email: 'jo@acme.com', email_type: 'named', phone: '+1 503 555 0100', owner_name: 'Jo Smith', owner_title: 'Founder', socials: { instagram: 'https://instagram.com/acme' },
  product_count: 84, price_min: '12', price_max: '48.5', currency: 'USD', perf: 37, key_tech: 'Google Analytics | Shopify',
  findings: [
    { code: 'missing_h1', severity: 'low', message: 'The homepage has no H1 heading.' },
    { code: 'no_reviews', severity: 'medium', message: 'No product reviews found.' },
    { code: 'lighthouse_lcp_poor', severity: 'high', message: 'On mobile the main content takes 7.2 s to appear.' },
    { code: 'no_email_marketing_tool', severity: 'medium', message: 'No email marketing tool found on the store.' },
  ],
  lines: ['Line one.', 'Line two.'], segments: null,
};

describe('export rows', () => {
  it('one value per column, in the spec order', () => {
    const r = toRow(lead, 'Brand 1', 'My segment');
    expect(r).toHaveLength(COLUMNS.length);
    const row = Object.fromEntries(COLUMNS.map((c, i) => [c, r[i]]));
    expect(row).toMatchObject({ lead_id: 42, brand: 'Brand 1', segment: 'My segment', tier: 'A', score: 72.5, domain: 'acme.com', price_range: '12–48.5 USD',
      state: 'Oregon', phone: '+1 503 555 0100', socials: 'instagram: https://instagram.com/acme', first_line_1: 'Line one.', first_line_3: '', first_seen_date: '2026-11-19', sources: 'commoncrawl | ct' });
  });
  it('top findings: what the brand can fix first, then the most severe', () => {
    expect(topFindings(lead)).toEqual(['No email marketing tool found on the store.', 'No product reviews found.', 'On mobile the main content takes 7.2 s to appear.']);
    expect(services(lead)).toBe('Klaviyo email setup | Reviews app setup');
  });
});

describe('CSV safety', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvLine(['a,b', 'say "hi"', 'two\nlines', 7])).toBe('"a,b","say ""hi""","two\nlines",7\r\n');
  });
  it('website text can never run as a formula in Excel / Google Sheets', () => {
    expect(safeCell('=HYPERLINK("http://evil","x")')).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(safeCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(safeCell('-2+3')).toBe("'-2+3");
    expect(safeCell('+cmd|')).toBe("'+cmd|");
    expect(safeCell('+44 20 7946 0958')).toBe('+44 20 7946 0958'); // a phone number stays as it is
    expect(safeCell('Normal text')).toBe('Normal text');
    expect(csvLine(['=1+1'])).toBe("'=1+1\r\n");
  });
});

describe('phones stay text in spreadsheets', () => {
  it('international format with spaces (LibreOffice turned "+18043169068" into the number 18043169068)', () => {
    expect(phoneText('+18043169068')).toBe('+1 804 316 9068');
    expect(phoneText('+447855751591')).toBe('+44 7855 751591');
    expect(phoneText(null)).toBe('');
  });
});

describe('names', () => {
  it('Excel sheet names: allowed characters, 31 max, unique', () => {
    const taken = new Set<string>();
    expect(sheetName('Food: snacks / drinks [new]?', taken)).toBe('Food snacks drinks new');
    expect(sheetName('White-label service buyers and more words here', taken)).toHaveLength(31);
    expect(sheetName('Leads', taken)).toBe('Leads');
    expect(sheetName('leads', taken)).toBe('leads 2');
  });
  it('file names are safe and tell what is inside', () => {
    expect(fileName({ id: 7, brandKey: 'brand_1', segment: 'Shopify US, no Klaviyo!', tiers: ['A', 'B'], format: 'xlsx', at: new Date('2026-11-26T15:04:00Z') }))
      .toBe('leadengine-brand-1-shopify-us-no-klaviyo-tier-ab-20261126-1504-7.xlsx');
    // a name cut at 40 characters never leaves a dangling dash
    expect(fileName({ id: 8, brandKey: 'brand_4', segment: 'Web, marketing, SEO and ads agencies, tier A/B', tiers: ['A', 'B'], format: 'csv', at: new Date('2026-11-26T15:52:00Z') }))
      .toBe('leadengine-brand-4-web-marketing-seo-and-ads-agencies-tier-tier-ab-20261126-1552-8.csv');
  });
});
