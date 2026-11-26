'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { q, tx } from '@/lib/db';
import { enqueue } from '@/lib/queue';
import { templateProblem } from '@/lib/templates';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const numOrNull = (f: FormData, k: string) => { const v = str(f, k); return v === '' ? null : Number(v); };
function unit(f: FormData, k: string, fallback: number): number {
  const v = numOrNull(f, k);
  if (v == null) return fallback;
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${k} must be between 0 and 1`);
  return v;
}
const codes = (s: string) => s.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
/**
 * Run a change, then go back to the same section of the page with either "Saved" or the reason it failed
 * (never a crash page). `fn` must not redirect itself.
 */
async function attempt(back: string, tab: string, fn: () => Promise<void>): Promise<never> {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = (e as Error).message;
  }
  revalidatePath(back);
  revalidatePath('/brands');
  redirect(error ? `${back}?error=${encodeURIComponent(error)}#${tab}` : `${back}?saved=${tab}#${tab}`);
}

export async function saveProfile(f: FormData) {
  const id = Number(f.get('id'));
  return attempt(`/brands/${id}`, 'profile', async () => {
    const services = str(f, 'services').split('\n').map((s) => s.trim()).filter(Boolean);
    const cases = str(f, 'case_studies').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [title, url, result] = l.split('|').map((x) => x.trim());
      return { title, url: url || null, result: result || null };
    });
    await q(`UPDATE brands SET name = $2, website = $3, description = $4, services = $5, price_min = $6, price_max = $7, currency = $8,
        case_studies = $9, enabled = $10, lead_with_niche = $11, updated_at = now() WHERE id = $1`,
      [id, str(f, 'name'), str(f, 'website') || null, str(f, 'description') || null, services, numOrNull(f, 'price_min'), numOrNull(f, 'price_max'),
        str(f, 'currency') || null, JSON.stringify(cases), f.get('enabled') === 'on', f.get('lead_with_niche') === 'on']);
  });
}

export async function saveTargeting(f: FormData) {
  const id = Number(f.get('id'));
  return attempt(`/brands/${id}`, 'targeting', async () => {
    const weights: Record<string, number> = {};
    for (const [k, v] of f.entries()) {
      if (!k.startsWith('pw:') || String(v).trim() === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Platform weight for ${k.slice(3)} must be between 0 and 1`);
      weights[k.slice(3)] = n;
    }
    const size: Record<string, number> = {};
    const lo = numOrNull(f, 'product_min'); const hi = numOrNull(f, 'product_max');
    if (lo != null) size.product_min = lo;
    if (hi != null) size.product_max = hi;
    await q(`UPDATE brands SET platform_weights = $2, platform_default = $3, platform_null = $4, target_countries = $5, excluded_countries = $6,
        country_other = $7, country_unknown = $8, size = $9, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(weights), unit(f, 'platform_default', 1), unit(f, 'platform_null', 0.5), codes(str(f, 'target_countries')),
        codes(str(f, 'excluded_countries')), unit(f, 'country_other', 0.3), unit(f, 'country_unknown', 0.7), JSON.stringify(size)]);
  });
}

export async function saveScoring(f: FormData) {
  const id = Number(f.get('id'));
  return attempt(`/brands/${id}`, 'scoring', async () => {
    const w = (k: string) => { const v = Number(str(f, k)); if (!Number.isFinite(v) || v < 0 || v > 5) throw new Error(`${k} weight must be 0–5`); return v; };
    const a = Number(str(f, 'tier_a')); const b = Number(str(f, 'tier_b'));
    if (!(a > b && b >= 0 && a <= 100)) throw new Error('Tier A cut-off must be above tier B, both between 0 and 100');
    const full = Number(str(f, 'need_full_at'));
    if (!(full > 0)) throw new Error('need_full_at must be above 0');
    await q(`UPDATE brands SET weights = $2, tiers = $3, need_full_at = $4, need_floor = $5, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify({ fit: w('w_fit'), need: w('w_need'), reach: w('w_reach'), fresh: w('w_fresh') }), JSON.stringify({ A: a, B: b }), full, unit(f, 'need_floor', 0.15)]);
  });
}

export async function saveNiches(f: FormData) {
  const id = Number(f.get('id'));
  return attempt(`/brands/${id}`, 'niches', async () => {
    const rows: { niche: number; sub: number | null; w: number }[] = [];
    for (const [k, v] of f.entries()) {
      if (!k.startsWith('nw:') || String(v).trim() === '') continue;
      const [, niche, sub] = k.split(':');
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('Niche weights must be between 0 and 1');
      rows.push({ niche: Number(niche), sub: sub ? Number(sub) : null, w: n });
    }
    await tx(async (c) => {
      await c.query(`DELETE FROM brand_niche_weights WHERE brand_id = $1`, [id]);
      await c.query(`INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight) SELECT $1, * FROM unnest($2::int[], $3::int[], $4::numeric[])`,
        [id, rows.map((r) => r.niche), rows.map((r) => r.sub), rows.map((r) => r.w)]);
      await c.query(`UPDATE brands SET updated_at = now() WHERE id = $1`, [id]);
    });
  });
}

export async function saveProblems(f: FormData) {
  const id = Number(f.get('id'));
  return attempt(`/brands/${id}`, 'problems', async () => {
    const rows: { code: string; service: string; w: number }[] = [];
    for (const [k, v] of f.entries()) {
      if (!k.startsWith('svc:')) continue;
      const code = k.slice(4);
      const service = String(v).trim();
      if (!service) continue;
      const w = Number(f.get(`wt:${code}`) || 1);
      if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error(`Weight for ${code} must be between 0 and 1`);
      rows.push({ code, service, w });
    }
    await tx(async (c) => {
      await c.query(`DELETE FROM brand_problem_map WHERE brand_id = $1`, [id]);
      await c.query(`INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT $1, * FROM unnest($2::text[], $3::text[], $4::numeric[])`,
        [id, rows.map((r) => r.code), rows.map((r) => r.service), rows.map((r) => r.w)]);
      await c.query(`UPDATE brands SET updated_at = now() WHERE id = $1`, [id]);
    });
  });
}

/** Add or change one template (brand_id empty = shared by all brands). */
export async function saveTemplate(f: FormData) {
  const brandId = str(f, 'brand_id') ? Number(f.get('brand_id')) : null;
  return attempt(brandId ? `/brands/${brandId}` : '/brands', 'templates', async () => {
    const text = str(f, 'template').replace(/\s+/g, ' ');
    const problem = await templateProblem(text);
    if (problem) throw new Error(`Template not saved: ${problem}`);
    const code = str(f, 'finding_code');
    if (!/^(niche:)?[a-z0-9_]+$/.test(code)) throw new Error('Template not saved: finding code missing or invalid');
    const variant = Number(f.get('variant') || 1);
    if (!Number.isInteger(variant) || variant < 1 || variant > 9) throw new Error('Variant must be a number from 1 to 9');
    const tid = str(f, 'template_id');
    if (tid) {
      await q(`UPDATE brand_templates SET template = $2, finding_code = $3, variant = $4, enabled = $5 WHERE id = $1`,
        [Number(tid), text, code, variant, f.get('enabled') === 'on']);
    } else {
      await q(`INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ($1, $2, $3, $4)
        ON CONFLICT (coalesce(brand_id, 0), coalesce(niche_id, 0), finding_code, variant) DO UPDATE SET template = EXCLUDED.template, enabled = true`,
        [brandId, code, variant, text]);
    }
  });
}

export async function deleteTemplate(f: FormData) {
  const brandId = str(f, 'brand_id');
  return attempt(brandId ? `/brands/${brandId}` : '/brands', 'templates', async () => {
    await q(`DELETE FROM brand_templates WHERE id = $1`, [Number(f.get('template_id'))]);
  });
}

export async function rescoreNow() {
  await enqueue('stage.score', { full: true });
  revalidatePath('/brands');
}
