import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Business signals (stage 8): size, freshness, marketing maturity and location, from data already
 * collected. Every location value records where it came from.
 */
// Ad pixels are filed under "Analytics" in the fingerprint data, so they are listed by name (verified 2026-11-24).
export const AD_PIXELS = ['Facebook Pixel', 'TikTok Pixel', 'Pinterest Conversion Tag', 'Linkedin Insight Tag', 'Google Ads Conversion Tracking',
  'Microsoft Advertising', 'Snap Pixel', 'Reddit Ads'];

export interface SignalInput {
  domain: string;
  techs: { name: string; categories: string[] }[];
  tranco_rank: number | null;
  cc_pages: number | null;
  sitemap_count: number | null;
  sitemap_kind: string | null;
  product_count: number | null;
  mx_provider: string | null;
  links_internal: string[];
  first_seen: string | null;
  ct_first_cert: string | null;
  registered_nrd: string | null;
  domain_registered: string | null; // RDAP
  copyright_year: number | null;
  last_product_published: string | null;
  newest_product_created: string | null;
  address: { street?: string | null; city?: string | null; region?: string | null; postal?: string | null; country?: string | null } | null;
  store_country: string | null;
  store_province: string | null;
  store_city: string | null;
  phone: string | null;
  currency: string | null;
}

const GENERIC_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'shop', 'store', 'info', 'biz', 'app', 'dev', 'online', 'site', 'xyz', 'me', 'tv', 'ai', 'agency', 'studio', 'design', 'digital']);
const COUNTRY_NAMES: Record<string, string> = {
  'united states': 'US', usa: 'US', 'united states of america': 'US', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB',
  scotland: 'GB', wales: 'GB', canada: 'CA', australia: 'AU', 'new zealand': 'NZ', ireland: 'IE', germany: 'DE', france: 'FR', india: 'IN',
  netherlands: 'NL', spain: 'ES', italy: 'IT', 'south africa': 'ZA', singapore: 'SG', 'united arab emirates': 'AE', uae: 'AE',
};

export function normaliseCountry(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase() === 'UK' ? 'GB' : t.toUpperCase();
  return COUNTRY_NAMES[t.toLowerCase()] ?? null;
}

const has = (paths: string[], re: RegExp) => paths.some((u) => {
  try {
    return re.test(new URL(u).pathname);
  } catch {
    return false;
  }
});

export function computeSignals(x: SignalInput) {
  const names = new Set(x.techs.map((t) => t.name));
  const inCat = (cat: string) => x.techs.filter((t) => t.categories.includes(cat)).map((t) => t.name);
  const marketing = {
    // Detected from the stored HTML only. Many sites load pixels later (tag managers, Shopify pixel manager),
    // so an empty list means "not seen in HTML", not "not used" — the browser check in Phase 7 confirms.
    detection: 'html_only',
    analytics: inCat('Analytics').filter((n) => !AD_PIXELS.includes(n)),
    tag_managers: inCat('Tag managers'),
    ad_pixels: [...new Set([...AD_PIXELS.filter((n) => names.has(n)), ...inCat('Advertising'), ...inCat('Retargeting')])],
    email_marketing: [...new Set([...inCat('Marketing automation'), ...inCat('Email')])],
    reviews: inCat('Reviews'),
    live_chat: inCat('Live chat'),
    booking: [...new Set([...inCat('Appointment scheduling'), ...inCat('Ticket booking')])],
    loyalty: inCat('Loyalty & rewards'),
    bnpl: inCat('Buy now pay later'),
  };

  // Location: business address > store settings > phone number country > country-code domain ending.
  let country: string | null = null;
  let source: string | null = null;
  const a = normaliseCountry(x.address?.country);
  if (a) [country, source] = [a, 'address'];
  else if (normaliseCountry(x.store_country)) [country, source] = [normaliseCountry(x.store_country), 'store'];
  else if (x.phone) {
    const p = parsePhoneNumberFromString(x.phone);
    if (p?.country) [country, source] = [p.country, 'phone'];
  }
  if (!country) {
    const tld = x.domain.split('.').pop()!.toLowerCase();
    if (tld.length === 2 && !GENERIC_TLDS.has(tld)) [country, source] = [tld === 'uk' ? 'GB' : tld.toUpperCase(), 'tld'];
  }
  const fromAddress = source === 'address';
  return {
    country,
    country_source: source,
    region: (fromAddress ? x.address?.region : null) ?? (source === 'store' ? x.store_province : null) ?? null,
    city: (fromAddress ? x.address?.city : null) ?? (source === 'store' ? x.store_city : null) ?? null,
    address: fromAddress ? [x.address?.street, x.address?.city, x.address?.region, x.address?.postal].filter(Boolean).join(', ') || null : null,
    size_signals: {
      tranco_rank: x.tranco_rank,
      cc_pages: x.cc_pages,
      sitemap_urls: x.sitemap_kind === 'urlset' ? x.sitemap_count : null,
      sitemap_files: x.sitemap_kind === 'index' ? x.sitemap_count : null,
      product_count: x.product_count,
      mx_provider: x.mx_provider,
      has_careers_page: has(x.links_internal, /\/(careers|jobs|join-us|work-with-us)(\/|$)/i),
      has_locations_page: has(x.links_internal, /\/(locations|stores|store-locator|find-a-store|our-locations)(\/|$)/i),
    },
    freshness: {
      domain_registered: x.domain_registered,
      first_seen: x.first_seen,
      first_certificate: x.ct_first_cert,
      newly_registered: x.registered_nrd,
      copyright_year: x.copyright_year,
      last_product_published: x.last_product_published,
      newest_product_created: x.newest_product_created,
    },
    marketing,
    currency: x.currency,
  };
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', bull: '•', hellip: '…' };

/** Decode the HTML entities that turn up in page titles and shop names (&amp; &#039; &#8217; …). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const letters = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/**
 * A company name fit for an export column, or null (the export then shows the domain).
 * Titles often carry a tagline ("Men's Suits | Shirts | 6E Design"): keep the part that matches the domain,
 * else the first part. Names with no letters ("1550", "-") or longer than 60 characters are dropped.
 */
export function cleanCompanyName(raw: string | null | undefined, domain: string): string | null {
  if (!raw) return null;
  const label = letters(domain.split('.')[0] ?? '');
  const s = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  // Unfilled theme placeholders (#site_title, {{ shop.name }}, %%sitename%%) are not names.
  if (/^#[a-z_]+$/i.test(s) || /\{\{|\}\}|%%/.test(s)) return null;
  const parts = s.split(/\s+[|–—•:-]\s+|\s*[|_]\s*/).map((p) => p.trim().replace(/^[\s\-–—|:•]+|[\s\-–—|:•!]+$/g, '')).filter(Boolean);
  if (!parts.length) return null;
  const match = parts.find((p) => { const l = letters(p); return l.length >= 3 && (label.includes(l) || l.includes(label)); });
  const name = match ?? parts[0]!;
  if (!/\p{L}/u.test(name) || name.length > 60) return null;
  return name;
}
