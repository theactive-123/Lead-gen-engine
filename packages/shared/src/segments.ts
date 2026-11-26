import { db } from './db.js';
import { segmentSql } from './segment-filter.js';

export * from './segment-filter.js';

/** Live count of a filter (no rows saved). */
export async function countSegment(brandId: number, filter: unknown): Promise<number> {
  const { sql, params } = segmentSql(brandId, filter);
  const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) x`, params);
  return Number(rows[0]!.n);
}

/**
 * Save the current members of every enabled segment (daily, or on demand). Leads that still match keep their
 * `added_at`, so "new in this segment since…" works; leads that no longer match are removed.
 */
export async function refreshSegments(onlyId?: number): Promise<{ id: number; name: string; members: number; added: number; removed: number }[]> {
  const segs = (await db().query<{ id: number; brand_id: number; name: string; filter: unknown }>(
    `SELECT id, brand_id, name, filter FROM segments WHERE enabled ${onlyId ? 'AND id = $1' : ''} ORDER BY id`, onlyId ? [onlyId] : [])).rows;
  const out = [];
  for (const s of segs) {
    const { sql, params } = segmentSql(s.brand_id, s.filter);
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE seg_now ON COMMIT DROP AS ${sql}`, params);
      const removed = await client.query(`DELETE FROM segment_members m WHERE m.segment_id = $1 AND NOT EXISTS (SELECT 1 FROM seg_now x WHERE x.domain_id = m.domain_id)`, [s.id]);
      const added = await client.query(`INSERT INTO segment_members (segment_id, domain_id) SELECT $1, domain_id FROM seg_now ON CONFLICT DO NOTHING`, [s.id]);
      const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM segment_members WHERE segment_id = $1`, [s.id]);
      await client.query(`UPDATE segments SET member_count = $2, refreshed_at = now() WHERE id = $1`, [s.id, Number(rows[0]!.n)]);
      await client.query('COMMIT');
      out.push({ id: s.id, name: s.name, members: Number(rows[0]!.n), added: added.rowCount ?? 0, removed: removed.rowCount ?? 0 });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return out;
}
