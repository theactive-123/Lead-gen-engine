'use server';
import { redirect } from 'next/navigation';
import { tx } from '@/lib/db';
import { enqueue } from '@/lib/queue';

/**
 * "Delete this lead": removes every row about the domain from the lead database (all tables cascade from
 * `domains`), puts the domain and its email on the do-not-contact list (never crawled, segmented or exported
 * again), and asks the worker to remove its raw data from the data lake too.
 */
export async function deleteLead(form: FormData) {
  const domain = String(form.get('domain') ?? '').trim().toLowerCase();
  if (!domain) return;
  await tx(async (c) => {
    // forget = also remove the raw data from the data lake (worker job system.forget, started below).
    await c.query(`INSERT INTO suppression (kind, value, reason, forget) VALUES ('domain', $1, 'deleted from the dashboard', true)
      ON CONFLICT (kind, value) DO UPDATE SET forget = true, purged_at = NULL`, [domain]);
    await c.query(`INSERT INTO suppression (kind, value, reason)
      SELECT 'email', lower(ct.email), 'deleted from the dashboard' FROM contacts ct JOIN domains d ON d.id = ct.domain_id
      WHERE d.domain = $1 AND ct.email IS NOT NULL ON CONFLICT (kind, value) DO NOTHING`, [domain]);
    await c.query(`DELETE FROM domains WHERE domain = $1`, [domain]);
  });
  await enqueue('system.forget', {}).catch(() => null); // also runs every 30 minutes
  redirect('/explorer');
}
