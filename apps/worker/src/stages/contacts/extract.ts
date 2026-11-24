import * as cheerio from 'cheerio';
import { visibleText } from '../fetch/extract.js';
import { findPhoneNumbersInText, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Contact extraction from a business's own pages. Every value keeps the URL it came from.
 * Nothing is guessed: no pattern-generated emails, no SMTP probing.
 */
export interface Found<T> { value: T; source: string; via: string }
export interface PageContacts {
  emails: Found<string>[];
  phones: Found<string>[];
  addresses: Found<Address>[];
  people: Found<{ name: string; title: string | null; confidence: number }>[];
  socials: Found<string>[];
  orgNames: Found<string>[];
}
export interface Address { street: string | null; city: string | null; region: string | null; postal: string | null; country: string | null }

const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
// Only bracketed forms: plain " at " matches ordinary sentences (seen: "here at home. With" -> here@home.with).
const OBFUSCATED_RE = /([a-z0-9._%+-]{1,64})\s*(?:\[at\]|\(at\)|\{at\})\s*([a-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\.)\s*[a-z0-9-]+)+)/gi;

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

const JUNK_LOCAL = /^(email|e-mail|name|your|youremail|yourname|you|user|username|test|example|sample|someone|first\.?last|john\.?doe|jane\.?doe|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster)$/i;
const JUNK_DOMAIN = /(^|\.)(example\.(com|org|net)|domain\.(com|net)|email\.com|yourdomain\.com|yoursite\.com|website\.com|mysite\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|shopify\.com|myshopify\.com|squarespace\.com|godaddy\.com|wordpress\.(com|org)|cloudflare\.com|w3\.org|schema\.org|sentry\.wixpress\.com)$/i;
const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|mp4|webm|pdf)$/i;

/** True when an address is a placeholder, an asset file name, or a platform/system mailbox. */
export function isJunkEmail(email: string): boolean {
  const e = email.toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain || e.length > 254) return true;
  if (ASSET_SUFFIX.test(e) || /@\dx\./.test(e)) return true; // logo@2x.png
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain)) return true;
  if (/^[0-9a-f]{20,}$/.test(local)) return true; // tracking ids (e.g. Sentry DSNs)
  return false;
}

const ROLE_LOCAL = /^(info|hello|hi|contact|contactus|sales|sale|support|help|admin|office|enquiries|enquiry|inquiries|inquiry|team|orders|order|mail|marketing|accounts|accounting|billing|careers|jobs|press|media|studio|shop|store|service|services|customerservice|customercare|care|cs|wholesale|partners|bookings|booking|reception|general|feedback|social|events|hr|webmaster|privacy|legal)$/i;
const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|protonmail|proton|gmx|mail|yandex|zoho|qq|163|126|comcast|btinternet|sky|bigpond|optusnet|shaw|rogers|sbcglobal|att|verizon)\.[a-z.]+$/i;

export type EmailType = 'named' | 'role' | 'freemail';
export function emailType(email: string): EmailType {
  const [local, domain] = email.toLowerCase().split('@') as [string, string];
  if (FREEMAIL.test(domain)) return 'freemail';
  return ROLE_LOCAL.test(local.replace(/[._-]?\d+$/, '')) ? 'role' : 'named';
}

const SOCIAL = [
  { net: 'facebook', re: /^https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b|login|groups\/?$)[^/?#]+/i },
  { net: 'instagram', re: /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|explore|accounts|reel)[^/?#]+/i },
  { net: 'linkedin', re: /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school)\/[^/?#]+/i },
  { net: 'tiktok', re: /^https?:\/\/(www\.)?tiktok\.com\/@[^/?#]+/i },
  { net: 'youtube', re: /^https?:\/\/(www\.)?youtube\.com\/(channel\/|c\/|user\/|@)[^/?#]+/i },
  { net: 'pinterest', re: /^https?:\/\/([a-z]{2,3}\.)?pinterest\.[a-z.]+\/(?!pin\/)[^/?#]+/i },
  { net: 'x', re: /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share|home)[^/?#]+/i },
];

// One name word: Capitalised, allowing inner capitals (LaSalle, McDonald) and hyphen/apostrophe parts (O'Neil).
const WORD = "[A-Z][a-z]+(?:[A-Z][a-z]+)?(?:[-'’][A-Z]?[a-z]+)?";
const NAME = `${WORD}(?:\\s+${WORD}){1,2}(?![A-Za-z])`;
const PERSON_PATTERNS: { re: RegExp; title: string | null; confidence: number }[] = [
  // "founded (and led) (in 2019) by (Sheng and) Jeff Auksel"
  { re: new RegExp(`\\b(?:[Ff]ounded|[Ss]tarted|[Ee]stablished|[Cc]reated|[Oo]wned)(?:\\s+and\\s+(?:led|run|owned|operated))?(?:\\s+in\\s+\\d{4})?\\s+by\\s+(?:${WORD}\\s+(?:and|&)\\s+)?(${NAME})`, 'g'), title: 'Founder', confidence: 0.8 },
  { re: new RegExp(`\\b(${NAME}),?\\s+(?:is\\s+)?(?:the\\s+|our\\s+)?([Cc]o-?[Ff]ounder|[Ff]ounder|[Oo]wner|CEO|[Mm]anaging [Dd]irector)\\b`, 'g'), title: null, confidence: 0.6 },
  { re: new RegExp(`\\b([Cc]o-?[Ff]ounder|[Ff]ounder|[Oo]wner|CEO)\\s*(?:&\\s*[A-Za-z ]{2,20})?\\s*[:–—-]\\s*(${NAME})`, 'g'), title: null, confidence: 0.7 },
];
const NOT_NAMES = /^(Our|The|We|Us|Home|About|Contact|Shop|Team|Store|Meet|Welcome|Founded|Learn|Read|More|Click|Hello|Thank|Thanks|New|Best|Free|All|Get|Join|Follow|Copyright|Privacy|Terms|Customer|Service|Brand|Company|Family|Business|Small|Local|United|North|South|East|West|Saint|Mount|Lake|New York|Los Angeles|San)\b/;

function walkJsonLd(node: unknown, visit: (o: Record<string, any>) => void, depth = 0): void {
  if (depth > 8 || !node) return;
  if (Array.isArray(node)) return node.forEach((n) => walkJsonLd(n, visit, depth + 1));
  if (typeof node !== 'object') return;
  const o = node as Record<string, any>;
  visit(o);
  for (const v of Object.values(o)) if (v && typeof v === 'object') walkJsonLd(v, visit, depth + 1);
}
const typeOf = (o: Record<string, any>) => (Array.isArray(o['@type']) ? o['@type'].map(String) : [String(o['@type'] ?? '')]);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() || null : null);

/** Extract everything from one page. `defaultCountry` helps read local phone numbers. */
const COMPANY_WORDS = /\b(Business|Limited|Ltd|LLC|L\.L\.C|Inc|Incorporated|Corp|Corporation|Company|Co|Group|Holdings|GmbH|AG|Pty|PLC|LLP|SAS|BV|Studio|Studios|Agency|Media|Labs|Essentials|Enterprises|Industries|Solutions|Services|Store|Shop|Brands?)\b/;
const LEADING_ROLE = /^(?:(?:Co-?)?[Ff]ounders?|[Oo]wners?|CEO|Directors?)\s+/;

// Capitalised heading / button / label words that precede names on real pages
// (seen: "Experts Curt Hargrove", "Leadership Michelle Carroll", "Submit Jarrid Mendelson", "History More John").
const HEADING_WORDS = new Set(('Experts Expert History More Leadership Now Submit Independent Business Read Learn Message Note Bio Biography Profile ' +
  'Director Directors Management Board Staff Partner Partners Executive Executives Team Meet Story Mission Vision Values Testimonial Testimonials ' +
  'Review Reviews Quote Award Awards Winner Founder Founders Owner Owners Our The About Contact Home Welcome Hello Hi Dear Behind Leader Leaders ' +
  'Visionary Principal Head Chief Senior Lead Manager Consultant Coach Trainer Designer Developer Photographer Artist Author Speaker Chef ' +
  'Meet-the-team Introducing Featuring Presenting Questions Call Email Phone Address Hours Location Locations Services Products Shop Book Today')
  .split(/\s+/));

/** A person's name, or null when it is a role/heading word or a company name (seen: "Google Ireland Limited" on a privacy page). */
export function cleanPersonName(raw: string): string | null {
  const words = raw.replace(LEADING_ROLE, '').trim().split(/\s+/);
  while (words.length && HEADING_WORDS.has(words[0]!)) words.shift(); // drop heading words glued in front
  if (words.length < 2 || words.length > 3 || words.some((w) => HEADING_WORDS.has(w))) return null;
  const name = words.join(' ');
  if (NOT_NAMES.test(name) || COMPANY_WORDS.test(name)) return null;
  return name;
}

export function extractContacts(
  html: string,
  pageUrl: string,
  opts: { defaultCountry?: CountryCode; textPhones?: boolean; people?: boolean } = {},
): PageContacts {
  const $ = cheerio.load(html);
  const out: PageContacts = { emails: [], phones: [], addresses: [], people: [], socials: [], orgNames: [] };
  const addEmail = (raw: string, via: string) => {
    let e = raw.trim().replace(/^mailto:/i, '');
    try {
      e = decodeURIComponent(e);
    } catch {
      /* keep as is */
    }
    e = e.split('?')[0]!.trim().replace(/[.,;:)\]]+$/, '').toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(e) && !isJunkEmail(e)) out.emails.push({ value: e, source: pageUrl, via });
  };
  const addPhone = (raw: string, via: string) => {
    const p = parsePhoneNumberFromString(raw.replace(/^tel:/i, '').replace(/%20/g, ' '), opts.defaultCountry);
    if (p?.isValid()) out.phones.push({ value: p.number, source: pageUrl, via });
  };

  // 1) Links: mailto, tel, Cloudflare-protected, social profiles.
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (/^mailto:/i.test(href)) addEmail(href, 'mailto');
    else if (/^tel:/i.test(href)) addPhone(href, 'tel');
    else if (/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i.test(href)) {
      const d = decodeCfEmail(/#([0-9a-f]+)/i.exec(href)![1]!);
      if (d) addEmail(d, 'cloudflare');
    } else {
      for (const s of SOCIAL) if (s.re.test(href)) out.socials.push({ value: href.split(/[?#]/)[0]!.replace(/\/$/, ''), source: pageUrl, via: s.net });
    }
  });
  $('[data-cfemail]').each((_, el) => {
    const d = decodeCfEmail($(el).attr('data-cfemail') ?? '');
    if (d) addEmail(d, 'cloudflare');
  });

  // 2) JSON-LD: Organization / LocalBusiness / Person.
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      return;
    }
    walkJsonLd(data, (o) => {
      const types = typeOf(o);
      if (str(o.email)) addEmail(String(o.email), 'jsonld');
      if (str(o.telephone)) addPhone(String(o.telephone), 'jsonld');
      if (types.some((t) => t === 'PostalAddress') || (o.streetAddress || o.addressLocality)) {
        const a: Address = {
          street: str(o.streetAddress), city: str(o.addressLocality), region: str(o.addressRegion), postal: str(o.postalCode),
          country: str(typeof o.addressCountry === 'object' ? o.addressCountry?.name : o.addressCountry),
        };
        if (a.street || a.city || a.postal) out.addresses.push({ value: a, source: pageUrl, via: 'jsonld' });
      }
      if (types.some((t) => /Organization|LocalBusiness|Store|Corporation/.test(t)) && str(o.name)) out.orgNames.push({ value: String(o.name).slice(0, 200), source: pageUrl, via: 'jsonld' });
      const founders = Array.isArray(o.founder) ? o.founder : o.founder ? [o.founder] : [];
      for (const f of founders) {
        const n = cleanPersonName(typeof f === 'string' ? f : (str(f?.name) ?? ''));
        if (n && opts.people !== false) out.people.push({ value: { name: n, title: 'Founder', confidence: 0.9 }, source: pageUrl, via: 'jsonld' });
      }
    });
  });

  // 3) Visible text: plain and lightly obfuscated emails, people, (optionally) phone numbers.
  const text = visibleText($).slice(0, 200_000);
  for (const m of text.matchAll(EMAIL_RE)) addEmail(m[0], 'text');
  for (const m of text.matchAll(OBFUSCATED_RE)) addEmail(`${m[1]}@${m[2]!.replace(/\s*(\[dot\]|\(dot\)|\{dot\}|\s+dot\s+)\s*/gi, '.').replace(/\s+/g, '')}`, 'text_obfuscated');
  if (opts.textPhones) {
    for (const f of findPhoneNumbersInText(text.slice(0, 20_000), opts.defaultCountry)) {
      if (f.number.isValid()) out.phones.push({ value: f.number.number, source: pageUrl, via: 'text' });
    }
  }
  // People only from pages that describe the business itself (legal pages name other companies).
  if (opts.people !== false) {
    for (const p of PERSON_PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        const isNameFirst = /^[A-Z]/.test(m[1]!) && !/^(Co-?[Ff]ounder|[Ff]ounder|[Oo]wner|CEO)$/.test(m[1]!);
        const name = cleanPersonName((isNameFirst ? m[1] : m[2])!.trim());
        const title = p.title ?? (isNameFirst ? m[2] : m[1])!.replace(/^./, (c) => c.toUpperCase());
        if (name) out.people.push({ value: { name, title, confidence: p.confidence }, source: pageUrl, via: 'text' });
      }
    }
  }
  return out;
}
