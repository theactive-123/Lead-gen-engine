import { describe, expect, it } from 'vitest';
import { cleanCompanyName, computeSignals, decodeEntities, normaliseCountry, type SignalInput } from '../src/stages/signals/compute.js';

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

describe('company name cleaning (real names from the 2026-11-25 run)', () => {
  it('decodes HTML entities', () => {
    expect(decodeEntities('1234 Apparel &amp; Wood')).toBe('1234 Apparel & Wood');
    expect(cleanCompanyName('A&#039;cappella Chocolate', 'acappellachocolate.com')).toBe("A'cappella Chocolate");
    expect(cleanCompanyName('18 Summers Children&#39;s Boutique (and more)', '18summers.com')).toBe("18 Summers Children's Boutique (and more)");
  });
  it('keeps the part of a title that matches the domain', () => {
    expect(cleanCompanyName('Men&#039;s Custom Made Suit | Men&#039;s Custom Made Shirt | 6E Design', '6edesign.com')).toBe('6E Design');
    expect(cleanCompanyName('Solar PV DC Isolator Manufacturer_Wholesale Energy Storage Switch_EV Charger Supplier_Aswich', 'aswich.com')).toBe('Aswich');
    expect(cleanCompanyName('ACME Sign Corporation – Leaders in Sign manufacturing!', 'acmesign.com')).toBe('ACME Sign Corporation');
    expect(cleanCompanyName('Arise and Shine - Natural Haircare for a Radiant You', 'ariseandshinehair.com')).toBe('Arise and Shine');
  });
  it('drops names with no letters, separators only, or keyword lists', () => {
    expect(cleanCompanyName('1550', '1550.com')).toBeNull();
    expect(cleanCompanyName('-', 'ambientes.co')).toBeNull();
    expect(cleanCompanyName('#site_title', 'x.com')).toBeNull();
    expect(cleanCompanyName('{{ shop.name }}', 'x.com')).toBeNull();
    expect(cleanCompanyName('#1 Pet Store', '1petstore.com')).toBe('#1 Pet Store');
    expect(cleanCompanyName('industrial panel pc,rugged mini PC,fanless box computer,Monitor manufacturers', 'x.com')).toBeNull();
    expect(cleanCompanyName('Coca-Cola Store', 'cocacola.com')).toBe('Coca-Cola Store');
  });
});
