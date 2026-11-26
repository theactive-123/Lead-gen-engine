'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { q } from '@/lib/db';
import { enqueue } from '@/lib/queue';

/** 5-field cron: minute hour day-of-month month day-of-week (UTC). Rough check; pg-boss validates fully. */
const CRON_FIELD = /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/\d+)?$/;

export async function saveSource(f: FormData) {
  const key = String(f.get('key'));
  const schedule = String(f.get('schedule') ?? '').trim().replace(/\s+/g, ' ');
  if (schedule.split(' ').length !== 5 || !schedule.split(' ').every((x) => CRON_FIELD.test(x))) {
    redirect(`/sources?error=${encodeURIComponent(`"${schedule}" is not a valid schedule (5 fields, e.g. "*/10 * * * *")`)}`);
  }
  await q(`UPDATE sources SET enabled = $2, schedule = $3, updated_at = now() WHERE key = $1`, [key, f.get('enabled') === 'on', schedule]);
  revalidatePath('/sources');
  redirect('/sources?saved=1');
}

export async function runSourceNow(f: FormData) {
  const key = String(f.get('key'));
  const id = await enqueue(`source.${key}`, {});
  revalidatePath('/sources');
  redirect(id ? `/sources?queued=${key}` : `/sources?error=${encodeURIComponent(`${key} is already queued or running`)}`);
}
