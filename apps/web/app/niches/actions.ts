'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { q } from '@/lib/db';

const SAT = ['low', 'medium', 'high'];

async function attempt(back: string, fn: () => Promise<void>): Promise<never> {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = (e as Error).message;
  }
  revalidatePath(back);
  redirect(error ? `${back}?error=${encodeURIComponent(error)}` : `${back}?saved=1`);
}

export async function saveNiche(f: FormData) {
  const id = Number(f.get('id'));
  return attempt(String(f.get('back') || '/niches'), async () => {
    const sat = String(f.get('saturation_level'));
    if (!SAT.includes(sat)) throw new Error('Saturation must be low, medium or high');
    await q(`UPDATE niches SET saturation_level = $2, enabled = $3, excluded = $4, description = coalesce($5, description) WHERE id = $1`,
      [id, sat, f.get('enabled') === 'on', f.get('excluded') === 'on', f.get('description') == null ? null : String(f.get('description'))]);
  });
}

export async function toggleSubNiche(f: FormData) {
  return attempt(`/niches/${Number(f.get('niche_id'))}`, async () => {
    await q(`UPDATE sub_niches SET enabled = NOT enabled WHERE id = $1`, [Number(f.get('id'))]);
  });
}

export async function addKeyword(f: FormData) {
  return attempt(`/niches/${Number(f.get('niche_id'))}`, async () => {
    const term = String(f.get('term') ?? '').trim().toLowerCase();
    const kind = String(f.get('kind'));
    if (term.length < 2) throw new Error('Keyword is too short');
    if (!['positive', 'negative'].includes(kind)) throw new Error('Kind must be positive or negative');
    const weight = Number(f.get('weight') || 1);
    if (!(weight > 0 && weight <= 5)) throw new Error('Weight must be between 0 and 5');
    const dup = await q(`SELECT 1 FROM keywords WHERE sub_niche_id = $1 AND term = $2 AND kind = $3`, [Number(f.get('sub_niche_id')), term, kind]);
    if (dup.length) throw new Error(`"${term}" is already there`);
    await q(`INSERT INTO keywords (sub_niche_id, term, kind, weight) VALUES ($1, $2, $3, $4)`, [Number(f.get('sub_niche_id')), term, kind, weight]);
  });
}

export async function deleteKeyword(f: FormData) {
  return attempt(`/niches/${Number(f.get('niche_id'))}`, async () => {
    await q(`DELETE FROM keywords WHERE id = $1`, [Number(f.get('id'))]);
  });
}

export async function addPattern(f: FormData) {
  const nicheId = Number(f.get('niche_id'));
  return attempt(`/niches/${nicheId}`, async () => {
    const pattern = String(f.get('pattern') ?? '').trim();
    try { new RegExp(pattern); } catch { throw new Error('That URL pattern is not a valid regular expression'); }
    if (!pattern) throw new Error('Pattern is empty');
    const sub = String(f.get('sub_niche_id') ?? '');
    await q(`INSERT INTO url_patterns (niche_id, sub_niche_id, pattern, weight, note) VALUES ($1, $2, $3, $4, $5)`,
      [nicheId, sub ? Number(sub) : null, pattern, Number(f.get('weight') || 1), String(f.get('note') ?? '').trim() || null]);
  });
}

export async function deletePattern(f: FormData) {
  return attempt(`/niches/${Number(f.get('niche_id'))}`, async () => {
    await q(`DELETE FROM url_patterns WHERE id = $1`, [Number(f.get('id'))]);
  });
}

/** Classify every fetched site again with the current niches and keywords (the worker does it in the background). */
export async function reclassifyAll() {
  await q(`INSERT INTO settings (key, value, description) VALUES ('classify.reclassify_after', to_jsonb(now()::text),
      'Sites classified before this time are classified again (set by "Re-classify all")')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
  revalidatePath('/niches');
  redirect('/niches?reclassify=1');
}
