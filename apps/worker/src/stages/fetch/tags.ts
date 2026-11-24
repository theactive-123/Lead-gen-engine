import { db } from '@lead/shared';

/** Page tags from the editable `page_tag_rules` table (parked, coming soon, default page...). */
export interface TagRule { tag: string; field: 'title' | 'text' | 'url' | 'any'; re: RegExp; drops: boolean; maxWords: number | null }

export async function loadTagRules(): Promise<TagRule[]> {
  const rows = (await db().query<{ tag: string; field: TagRule['field']; pattern: string; drops: boolean; max_words: number | null }>(
    'SELECT tag, field, pattern, drops, max_words FROM page_tag_rules WHERE enabled ORDER BY id',
  )).rows;
  // Rules use a leading (?i) for readability; JavaScript expresses that as the "i" flag.
  return rows.map((r) => ({ tag: r.tag, field: r.field, drops: r.drops, maxWords: r.max_words, re: new RegExp(r.pattern.replace(/^\(\?i\)/, ''), /^\(\?i\)/.test(r.pattern) ? 'i' : '') }));
}

export function tagPage(rules: TagRule[], p: { title: string | null; text: string; url: string; words: number }): { tags: string[]; drops: boolean } {
  const tags = new Set<string>();
  let drops = false;
  for (const r of rules) {
    if (r.maxWords !== null && r.field !== 'title' && p.words > r.maxWords) continue;
    const hay = r.field === 'title' ? p.title ?? '' : r.field === 'text' ? p.text : r.field === 'url' ? p.url : `${p.title ?? ''}\n${p.text.slice(0, 2000)}`;
    if (r.re.test(hay)) {
      tags.add(r.tag);
      drops ||= r.drops;
    }
  }
  return { tags: [...tags], drops };
}
