import { one } from './db';

/** Placeholders the worker can fill (apps/worker/src/stages/score/lines.ts → variables()). */
export const PLACEHOLDERS = ['domain', 'company', 'platform', 'product_count', 'score', 'lcp_s', 'tbt_s', 'ttfb_s', 'cls', 'year', 'version', 'scripts', 'count', 'broken_path'];

/** Same rules the worker applies to every line; checked here before a template is saved. */
export async function templateProblem(text: string): Promise<string | null> {
  const rules = (await one<{ value: { max_words: number; banned: string[] } }>(`SELECT value FROM settings WHERE key = 'first_lines.rules'`))?.value
    ?? { max_words: 25, banned: ['!'] };
  const unknown = [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!).filter((p) => !PLACEHOLDERS.includes(p));
  if (unknown.length) return `unknown placeholder {${unknown[0]}}`;
  if (/[{}]/.test(text.replace(/\{[a-z_]+\}/g, ''))) return 'a { or } that is not a placeholder';
  // A filled-in value counts as one word.
  const words = text.replace(/\{[a-z_]+\}/g, 'X').split(/\s+/).filter(Boolean).length;
  if (words > rules.max_words) return `${words} words (max ${rules.max_words})`;
  const low = text.toLowerCase();
  for (const b of rules.banned) if (b && low.includes(b.toLowerCase())) return `contains "${b}"`;
  return null;
}
