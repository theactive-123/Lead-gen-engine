import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanPersonName, decodeCfEmail, emailType, extractContacts, isJunkEmail } from '../src/stages/contacts/extract.js';

// Real contact/about pages saved 2026-11-24 from in-scope sites; expectations checked by reading the pages.
const page = (f: string, url: string, country: 'US' | 'AU' = 'US') =>
  extractContacts(readFileSync(new URL(`./fixtures/contacts/${f}`, import.meta.url), 'utf8'), url, { textPhones: true, defaultCountry: country });
const vals = (xs: { value: unknown }[]) => [...new Set(xs.map((x) => (typeof x.value === 'string' ? x.value : JSON.stringify(x.value))))];

describe('contact extraction on real pages', () => {
  it('Cloudflare-protected email and Australian 1300 number (10amdigital.com.au)', () => {
    const r = page('10amdigital_com_au.html', 'https://10amdigital.com.au/about-us/', 'AU');
    expect(vals(r.emails)).toEqual(['hello@10amdigital.com']);
    expect(vals(r.phones)).toContain('+611300368759');
  });
  it('JSON-LD email + address; placeholder mailto rejected (100000spices.com)', () => {
    const r = page('100000spices_com.html', 'https://www.100000spices.com/pages/contact');
    expect(vals(r.emails)).toEqual(['sales@100000spices.com']);
    expect(r.addresses[0]!.value).toMatchObject({ city: 'Marrakech', country: 'MA' });
  });
  it('named email and founder "founded and led by" with an inner capital (1983agency.com)', () => {
    const r = page('1983agency_com.html', 'https://www.1983agency.com/about');
    expect(vals(r.emails)).toEqual(['michael@1983agency.com']);
    expect(r.people.map((p) => p.value.name)).toContain('Michael LaSalle');
  });
  it('founder pair "by Sheng and Jeff Auksel" (10-4tackle.com)', () => {
    const r = page('10-4tackle_com.html', 'https://10-4tackle.com/about-us/');
    expect(r.people.map((p) => p.value.name)).toContain('Jeff Auksel');
  });
  it('never invents an email for form-only contact pages', () => {
    for (const f of ['0foxshop_com.html', '18east_co.html', '10xprohealth_com.html', '18myles_com.html']) {
      expect(page(f, 'https://x.com/contact').emails).toEqual([]);
    }
  });
  it('does not read ordinary sentences as obfuscated emails (1023gelato.com: "here at home. With")', () => {
    expect(page('1023gelato_com.html', 'https://1023gelato.com/pages/about-us').emails).toEqual([]);
  });
});

describe('email helpers', () => {
  it('decodes Cloudflare email protection', () => {
    expect(decodeCfEmail('9bf3fef7f7f4dbaaabfaf6fff2fcf2effaf7b5f8f4f6')).toBe('hello@10amdigital.com');
    expect(decodeCfEmail('zz')).toBeNull();
  });
  it('rejects placeholders, asset names and platform mailboxes', () => {
    for (const e of ['email@domain.com', 'logo@2x.png', 'you@example.com', 'noreply@shop.com', 'abc@sentry.io', 'x@sentry-next.wixpress.com',
      'b1f0a3c9e8d74f6a9e2b1c3d4e5f6a7b@o123.ingest.sentry.io']) expect(isJunkEmail(e), e).toBe(true);
    for (const e of ['info@116fitness.com', 'michael@1983agency.com', '16anaay@gmail.com']) expect(isJunkEmail(e), e).toBe(false);
  });
  it('types emails', () => {
    expect(emailType('info@116fitness.com')).toBe('role');
    expect(emailType('hello2@x.com')).toBe('role');
    expect(emailType('sale@021pv.com')).toBe('role');
    expect(emailType('michael@1983agency.com')).toBe('named');
    expect(emailType('16anaay@gmail.com')).toBe('freemail');
  });
});

describe('visible text keeps element boundaries (bug seen on 0000haircare.com / 000tbs.com)', () => {
  it('does not glue a label onto the next element', async () => {
    const r = extractContacts('<body><p><span>Email</span><span>info@shop.com</span></p><div>Address</div><div>info@x.co</div></body>', 'https://shop.com/contact');
    expect(r.emails.map((e) => e.value).sort()).toEqual(['info@shop.com', 'info@x.co']);
  });
});

describe('person names (cases seen in the first real batch)', () => {
  it('strips role words and rejects companies', () => {
    expect(cleanPersonName('Founders Marshall Goldsmith')).toBe('Marshall Goldsmith');
    expect(cleanPersonName('Google Ireland Limited')).toBeNull();
    expect(cleanPersonName('Apothecary Essentials Limited')).toBeNull();
    expect(cleanPersonName('Tapasya Bali')).toBe('Tapasya Bali');
    expect(cleanPersonName('Michael LaSalle')).toBe('Michael LaSalle');
  });
  it('drops heading words glued in front of names (second real batch)', () => {
    expect(cleanPersonName('Experts Curt Hargrove')).toBe('Curt Hargrove');
    expect(cleanPersonName('Leadership Michelle Carroll')).toBe('Michelle Carroll');
    expect(cleanPersonName('Now Rick Nussell')).toBe('Rick Nussell');
    expect(cleanPersonName('Submit Jarrid Mendelson')).toBe('Jarrid Mendelson');
    expect(cleanPersonName('History More John')).toBeNull();
    expect(cleanPersonName('Independent Business')).toBeNull();
    expect(cleanPersonName('Kirin Roberts-Mosley')).toBe('Kirin Roberts-Mosley');
  });
  it('ignores people on legal pages when asked', () => {
    const html = '<body><p>This site is owned by Jane Smith Ltd. Founded by Jane Smith.</p></body>';
    expect(extractContacts(html, 'https://x.com/privacy', { people: false }).people).toEqual([]);
    expect(extractContacts(html, 'https://x.com/about').people.map((p) => p.value.name)).toEqual(['Jane Smith']);
  });
});
