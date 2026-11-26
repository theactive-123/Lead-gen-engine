'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { SegmentFilter } from '@lead/shared/segment-filter';
import { one } from '@/lib/db';

/** Save the explorer's current filters as a named segment for one brand. */
export async function saveSegment(form: FormData) {
  const brandId = Number(form.get('brand_id'));
  const name = String(form.get('name') ?? '').trim();
  if (!name) throw new Error('Give the segment a name.');
  const filter = SegmentFilter.parse(JSON.parse(String(form.get('filter') ?? '{}')));
  const row = await one<{ id: number }>(
    `INSERT INTO segments (brand_id, name, description, filter) VALUES ($1, $2, $3, $4)
     ON CONFLICT (brand_id, name) DO UPDATE SET filter = EXCLUDED.filter, description = EXCLUDED.description, updated_at = now()
     RETURNING id`,
    [brandId, name, String(form.get('description') ?? '').trim() || null, JSON.stringify(filter)],
  );
  revalidatePath('/segments');
  redirect(`/segments/${row!.id}`);
}
