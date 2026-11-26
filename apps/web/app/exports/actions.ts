'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { one } from '@/lib/db';
import { enqueue } from '@/lib/queue';

/** Record the request, then let the worker write the file (big files never block the dashboard). */
export async function createExport(f: FormData) {
  const brandId = Number(f.get('brand_id'));
  const segmentId = f.get('segment_id') ? Number(f.get('segment_id')) : null;
  const tiers = f.getAll('tiers').map(String).filter((t) => ['A', 'B', 'C'].includes(t));
  const format = String(f.get('format')) === 'csv' ? 'csv' : 'xlsx';
  const mode = String(f.get('mode')) === 'all' ? 'all' : 'new';
  if (!tiers.length) redirect('/exports?error=' + encodeURIComponent('Pick at least one tier'));
  const seg = segmentId ? await one<{ brand_id: number; name: string }>(`SELECT brand_id, name FROM segments WHERE id = $1`, [segmentId]) : null;
  if (segmentId && (!seg || seg.brand_id !== brandId)) redirect('/exports?error=' + encodeURIComponent('That segment belongs to another brand'));
  const row = await one<{ id: number }>(`INSERT INTO exports (brand_id, segment_id, segment_name, tiers, format, mode, require_email, sheets)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [brandId, segmentId, seg?.name ?? null, tiers, format, mode, f.get('require_email') === 'on', f.get('sheets') === 'none' ? 'none' : 'niche']);
  await enqueue('exports.build', { id: row!.id });
  revalidatePath('/exports');
  redirect(`/exports?created=${row!.id}`);
}

/** Forget that leads were exported for a brand, so "new since last export" includes them again. */
export async function resetExported(f: FormData) {
  const brandId = Number(f.get('brand_id'));
  await one(`DELETE FROM exported_leads WHERE brand_id = $1`, [brandId]);
  revalidatePath('/exports');
  redirect('/exports?reset=1');
}
