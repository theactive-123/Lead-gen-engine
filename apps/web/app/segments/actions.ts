'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { q } from '@/lib/db';
import { enqueue } from '@/lib/queue';

export async function refreshSegment(form: FormData) {
  const id = form.get('id') ? Number(form.get('id')) : undefined;
  await enqueue('segments.refresh', id ? { id } : {});
  revalidatePath('/segments');
}

export async function updateSegment(form: FormData) {
  const id = Number(form.get('id'));
  await q(`UPDATE segments SET name = $2, description = $3, enabled = $4, updated_at = now() WHERE id = $1`,
    [id, String(form.get('name')).trim(), String(form.get('description') ?? '').trim() || null, form.get('enabled') === 'on']);
  revalidatePath(`/segments/${id}`);
  revalidatePath('/segments');
}

export async function deleteSegment(form: FormData) {
  await q(`DELETE FROM segments WHERE id = $1`, [Number(form.get('id'))]);
  revalidatePath('/segments');
  redirect('/segments');
}
