'use server';
import { redirect } from 'next/navigation';
import { tx } from '@/lib/db';

/**
 * "Delete this lead": removes every row about the domain from the lead database (all tables cascade from
 * `domains`) and puts the domain on the do-not-contact list, so it can never be exported or segmented again.
 */
export async function deleteLead(form: FormData) {
  const domain = String(form.get('domain') ?? '').trim().toLowerCase();
  if (!domain) return;
  await tx(async (c) => {
    await c.query(`INSERT INTO suppression (kind, value, reason) VALUES ('domain', $1, 'deleted from the dashboard') ON CONFLICT (kind, value) DO NOTHING`, [domain]);
    await c.query(`INSERT INTO suppression (kind, value, reason)
      SELECT 'email', lower(ct.email), 'deleted from the dashboard' FROM contacts ct JOIN domains d ON d.id = ct.domain_id
      WHERE d.domain = $1 AND ct.email IS NOT NULL ON CONFLICT (kind, value) DO NOTHING`, [domain]);
    await c.query(`DELETE FROM domains WHERE domain = $1`, [domain]);
  });
  redirect('/explorer');
}
