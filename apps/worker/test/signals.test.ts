import { describe, expect, it } from 'vitest';
import { computeSignals, normaliseCountry, type SignalInput } from '../src/stages/signals/compute.js';

const base = (o: Partial<SignalInput>): SignalInput => ({
  domain: 'shop.com', techs: [], tranco_rank: null, cc_pages: null, sitemap_count: null, sitemap_kind: null, product_count: null,
  mx_provider: null, links_internal: [], first_seen: null, ct_first_cert: null, registered_nrd: null, domain_registered: null,
  copyright_year: null, last_product_published: null, newest_product_created: null, address: null, store_country: null,
  store_province: null, store_city: null, phone: null, currency: null, ...o,
});

describe('computeSignals', () => {
  it('location priority: address > store > phone > country domain ending, with the source recorded', () => {
    expect(computeSignals(base({ address: { city: 'Marrakech', country: 'MA' }, store_country: 'US', phone: '+441787373311' })))
      .toMatchObject({ country: 'MA', country_source: 'address', city: 'Marrakech' });
    expect(computeSignals(base({ store_country: 'AU', store_city: 'Blackmans Bay', phone: '+441787373311' })))
      .toMatchObject({ country: 'AU', country_source: 'store', city: 'Blackmans Bay' });
    expect(computeSignals(base({ phone: '+441787373311' }))).toMatchObject({ country: 'GB', country_source: 'phone', city: null });
    expect(computeSignals(base({ domain: 'shop.co.uk' }))).toMatchObject({ country: 'GB', country_source: 'tld' });
    expect(computeSignals(base({ domain: 'shop.com' })).country).toBeNull();
  });
  it('ad pixels count as advertising even though the fingerprint data files them under Analytics', () => {
    const s = computeSignals(base({ techs: [
      { name: 'Facebook Pixel', categories: ['Analytics'] }, { name: 'Google Analytics', categories: ['Analytics'] },
      { name: 'Klaviyo', categories: ['Marketing automation'] }, { name: 'Judge.me', categories: ['Reviews'] },
    ] }));
    expect(s.marketing.ad_pixels).toEqual(['Facebook Pixel']);
    expect(s.marketing.analytics).toEqual(['Google Analytics']);
    expect(s.marketing.email_marketing).toEqual(['Klaviyo']);
    expect(s.marketing.reviews).toEqual(['Judge.me']);
  });
  it('size signals from pages and sitemap', () => {
    const s = computeSignals(base({ links_internal: ['https://shop.com/careers', 'https://shop.com/stores/'], sitemap_count: 340, sitemap_kind: 'urlset' }));
    expect(s.size_signals).toMatchObject({ has_careers_page: true, has_locations_page: true, sitemap_urls: 340, sitemap_files: null });
  });
  it('normalises country names and codes', () => {
    expect(normaliseCountry('United Kingdom')).toBe('GB');
    expect(normaliseCountry('uk')).toBe('GB');
    expect(normaliseCountry('us')).toBe('US');
    expect(normaliseCountry('Atlantis')).toBeNull();
  });
});
