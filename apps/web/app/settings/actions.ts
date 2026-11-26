'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { one, q } from '@/lib/db';

function back(msg: { error?: string; saved?: string }, anchor: string): never {
  const p = new URLSearchParams(msg as Record<string, string>).toString();
  revalidatePath('/settings');
  redirect(`/settings?${p}#${anchor}`);
}

/** Change one setting. The new value must be valid JSON of the same kind as before (number stays number, etc.). */
export async function saveSetting(f: FormData) {
  const key = String(f.get('key'));
  let value: unknown;
  try {
    value = JSON.parse(String(f.get('value')));
  } catch {
    back({ error: `${key}: not valid JSON` }, 'settings');
  }
  const old = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (old && old.value !== null && kind(old.value) !== kind(value)) back({ error: `${key}: must stay a ${kind(old.value)}` }, 'settings');
  await q(`UPDATE settings SET value = $2, updated_at = now() WHERE key = $1`, [key, JSON.stringify(value)]);
  back({ saved: key }, 'settings');
}

function normalise(raw: string): { kind: 'email' | 'domain'; value: string } | null {
  let v = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!v) return null;
  if (v.includes('@')) return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v) ? { kind: 'email', value: v } : null;
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? { kind: 'domain', value: v } : null;
}

async function addMany(items: { kind: string; value: string }[], reason: string): Promise<number> {
  if (!items.length) return 0;
  const r = await q<{ id: number }>(`INSERT INTO suppression (kind, value, reason) SELECT k, v, $3 FROM unnest($1::text[], $2::text[]) AS x(k, v)
    ON CONFLICT (kind, value) DO NOTHING RETURNING id`, [items.map((i) => i.kind), items.map((i) => i.value), reason]);
  return r.length;
}

export async function addSuppression(f: FormData) {
  const item = normalise(String(f.get('value') ?? ''));
  if (!item) back({ error: 'Enter an email address or a domain (e.g. name@shop.com or shop.com)' }, 'suppression');
  const n = await addMany([item!], String(f.get('reason') ?? '').trim() || 'added by hand');
  back({ saved: n ? `${item!.value} added` : `${item!.value} was already on the list` }, 'suppression');
}

/** CSV/TXT import: every cell that looks like an email or a domain is added (header rows and other columns are skipped). */
export async function importSuppression(f: FormData) {
  const file = f.get('file');
  if (!(file instanceof File) || file.size === 0) back({ error: 'Choose a CSV file first' }, 'suppression');
  const text = await (file as File).text();
  const seen = new Set<string>();
  const items: { kind: string; value: string }[] = [];
  let skipped = 0;
  for (const cell of text.split(/[\r\n,;\t]+/)) {
    if (!cell.trim()) continue;
    const it = normalise(cell);
    if (!it) { skipped++; continue; }
    const k = `${it.kind}:${it.value}`;
    if (!seen.has(k)) { seen.add(k); items.push(it); }
  }
  let added = 0;
  for (let i = 0; i < items.length; i += 5000) added += await addMany(items.slice(i, i + 5000), `import ${(file as File).name}`);
  back({ saved: `Imported ${(file as File).name}: ${added} added, ${items.length - added} already listed, ${skipped} cells skipped (not an email or domain)` }, 'suppression');
}

export async function deleteSuppression(f: FormData) {
  await q(`DELETE FROM suppression WHERE id = $1`, [Number(f.get('id'))]);
  back({ saved: 'Removed from the list' }, 'suppression');
}
