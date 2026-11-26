import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Stage 13 — export rows (pure functions, no I/O). One row per lead for one brand.
 * Column order follows the build spec; every value is plain text or a number.
 */

export interface ExportLead {
  id: string; domain: string; final_url: string | null; first_seen: Date | string | null; sources: string[] | null;
  tier: string; match_score: string | number; breakdown: { need?: { problems?: { code: string; service: string }[] } } | null;
  niche: string; sub_niche: string | null; company: string | null; platform: string | null; country: string | null; region: string | null; city: string | null;
  email: string | null; email_type: string | null; phone: string | null; owner_name: string | null; owner_title: string | null;
  socials: Record<string, string> | null; product_count: number | null; price_min: string | null; price_max: string | null; currency: string | null;
  perf: number | null; key_tech: string | null; findings: { code: string; severity: string; message: string }[] | null;
  lines: string[] | null; segments: string | null;
}

export const COLUMNS = [
  'lead_id', 'brand', 'segment', 'tier', 'score', 'niche', 'sub_niche', 'domain', 'website', 'company_name', 'platform', 'key_technologies',
  'country', 'state', 'city', 'email', 'email_type', 'phone', 'owner_name', 'owner_title', 'socials', 'product_count', 'price_range',
  'lighthouse_performance', 'finding_1', 'finding_2', 'finding_3', 'services_to_pitch', 'first_line_1', 'first_line_2', 'first_line_3',
  'first_seen_date', 'sources',
] as const;

const SEVERITY = ['high', 'medium', 'low', 'info'];

/** Three findings to show: the ones this brand can fix first (biggest first), then the most severe others. */
export function topFindings(lead: ExportLead, n = 3): string[] {
  const all = lead.findings ?? [];
  const byCode = new Map(all.map((f) => [f.code, f]));
  const out: string[] = [];
  for (const p of lead.breakdown?.need?.problems ?? []) {
    const f = byCode.get(p.code);
    if (f && !out.includes(f.message)) out.push(f.message);
  }
  const rest = all.filter((f) => !out.includes(f.message)).sort((a, z) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(z.severity) || a.code.localeCompare(z.code));
  for (const f of rest) out.push(f.message);
  return out.slice(0, n);
}

export function services(lead: ExportLead): string {
  return [...new Set((lead.breakdown?.need?.problems ?? []).map((p) => p.service))].join(' | ');
}

function priceRange(l: ExportLead): string {
  if (l.price_min == null && l.price_max == null) return '';
  const a = l.price_min != null ? Number(l.price_min) : null;
  const b = l.price_max != null ? Number(l.price_max) : null;
  const r = a != null && b != null && a !== b ? `${a}–${b}` : String(a ?? b);
  return l.currency ? `${r} ${l.currency}` : r;
}

/**
 * "+18043169068" → "+1 804 316 9068". Spreadsheets turn the compact form into a number and drop the "+";
 * with spaces it stays text (and is easier to read).
 */
export function phoneText(p: string | null): string {
  if (!p) return '';
  return parsePhoneNumberFromString(p)?.formatInternational() ?? p;
}

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** One lead → one row (same order as COLUMNS). */
export function toRow(l: ExportLead, brand: string, segment: string | null): (string | number)[] {
  const f = topFindings(l);
  const lines = l.lines ?? [];
  return [
    Number(l.id), brand, segment ?? l.segments ?? '', l.tier, Number(Number(l.match_score).toFixed(1)), l.niche, l.sub_niche ?? '', l.domain,
    l.final_url ?? `https://${l.domain}/`, l.company ?? '', l.platform ?? '', l.key_tech ?? '', l.country ?? '', l.region ?? '', l.city ?? '',
    l.email ?? '', l.email_type ?? '', phoneText(l.phone), l.owner_name ?? '', l.owner_title ?? '',
    Object.entries(l.socials ?? {}).map(([k, v]) => `${k}: ${v}`).join(' | '),
    l.product_count ?? '', priceRange(l), l.perf ?? '', f[0] ?? '', f[1] ?? '', f[2] ?? '', services(l), lines[0] ?? '', lines[1] ?? '', lines[2] ?? '',
    day(l.first_seen), (l.sources ?? []).join(' | '),
  ];
}

/**
 * Text from websites must never run as a formula when the CSV is opened in Excel or Google Sheets
 * ("CSV injection"): a cell starting with = + - @ or a tab is prefixed with an apostrophe.
 * A plain phone number like "+44 20 7946 0958" is left alone (it is not a formula).
 */
export function safeCell(v: string | number): string | number {
  if (typeof v !== 'string') return v;
  if (/^\+[\d\s().-]+$/.test(v)) return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** One CSV line (RFC 4180: quote when needed, double the quotes). */
export function csvLine(values: (string | number)[]): string {
  return values.map((raw) => {
    const v = String(safeCell(raw));
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',') + '\r\n';
}

/** Excel sheet names: max 31 characters, none of : \ / ? * [ ], unique. */
export function sheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  taken.add(n.toLowerCase());
  return n;
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');

export function fileName(o: { id: number; brandKey: string; segment: string | null; tiers: string[]; format: string; at: Date }): string {
  const t = o.at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `leadengine-${slug(o.brandKey)}-${o.segment ? slug(o.segment) : 'all'}-tier-${o.tiers.join('').toLowerCase()}-${t}-${o.id}.${o.format}`;
}
