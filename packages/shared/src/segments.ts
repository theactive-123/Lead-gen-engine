import { z } from 'zod';
import { db } from './db.js';

/**
 * Segments = saved lead filters per brand (e.g. "Shopify DTC, US, 50–500 products, Meta Pixel, no Klaviyo,
 * Lighthouse < 50"). The filter is JSON in `segments.filter`; this file checks it and turns it into SQL with
 * bind parameters (values are never pasted into the SQL text). The dashboard uses the same code for live counts.
 * Suppressed domains and emails are always left out.
 */
const list = z.array(z.string().min(1)).min(1);
export const SegmentFilter = z.object({
  tiers: z.array(z.enum(['A', 'B', 'C'])).min(1).optional(),
  min_score: z.number().min(0).max(100).optional(),
  niches: list.optional(),             // niche keys, e.g. ["dtc"]
  sub_niches: list.optional(),         // sub-niche keys, e.g. ["coffee_tea"]
  platforms: list.optional(),          // e.g. ["Shopify"]
  tech_has: list.optional(),           // has ALL of these technologies
  tech_any: list.optional(),           // has at least one
  tech_not: list.optional(),           // has none of these
  countries: list.optional(),          // ISO codes, e.g. ["US", "GB"]
  exclude_countries: list.optional(),
  product_count_min: z.number().int().min(0).optional(),
  product_count_max: z.number().int().min(0).optional(),
  price_median_min: z.number().min(0).optional(),
  price_median_max: z.number().min(0).optional(),
  lighthouse_perf_max: z.number().min(0).max(100).optional(), // only leads that have a Lighthouse score
  completeness_min: z.number().min(0).max(1).optional(),
  has_email: z.boolean().optional(),
  email_types: z.array(z.enum(['named', 'role', 'freemail'])).min(1).optional(),
  findings_has: list.optional(),       // has ALL of these audit findings
  findings_any: list.optional(),       // has at least one
  findings_not: list.optional(),
  first_seen_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export type SegmentFilter = z.infer<typeof SegmentFilter>;

/** SQL that selects the domain ids of one brand's leads matching `filter` (params start at $1 = brand id). */
export function segmentSql(brandId: number, raw: unknown): { sql: string; params: unknown[] } {
  const f = SegmentFilter.parse(raw ?? {});
  const params: unknown[] = [brandId];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const w: string[] = [
    'm.brand_id = $1',
    "m.tier <> 'X'",
    `NOT EXISTS (SELECT 1 FROM suppression x WHERE (x.kind = 'domain' AND x.value = d.domain) OR (x.kind = 'email' AND x.value = lower(ct.email)))`,
  ];
  if (f.tiers) w.push(`m.tier = ANY(${p(f.tiers)}::text[])`);
  if (f.min_score != null) w.push(`m.match_score >= ${p(f.min_score)}`);
  if (f.niches) w.push(`n.key = ANY(${p(f.niches)}::text[])`);
  if (f.sub_niches) w.push(`s.key = ANY(${p(f.sub_niches)}::text[])`);
  if (f.platforms) w.push(`coalesce(c.platform, d.platform) = ANY(${p(f.platforms)}::text[])`);
  if (f.tech_has) w.push(`(SELECT count(DISTINCT t.tech) FROM technologies t WHERE t.domain_id = d.id AND t.tech = ANY(${p(f.tech_has)}::text[])) = ${p(f.tech_has.length)}`);
  if (f.tech_any) w.push(`EXISTS (SELECT 1 FROM technologies t WHERE t.domain_id = d.id AND t.tech = ANY(${p(f.tech_any)}::text[]))`);
  if (f.tech_not) w.push(`NOT EXISTS (SELECT 1 FROM technologies t WHERE t.domain_id = d.id AND t.tech = ANY(${p(f.tech_not)}::text[]))`);
  if (f.countries) w.push(`c.country = ANY(${p(f.countries)}::text[])`);
  if (f.exclude_countries) w.push(`(c.country IS NULL OR NOT c.country = ANY(${p(f.exclude_countries)}::text[]))`);
  if (f.product_count_min != null) w.push(`sp.product_count >= ${p(f.product_count_min)}`);
  if (f.product_count_max != null) w.push(`sp.product_count <= ${p(f.product_count_max)}`);
  if (f.price_median_min != null) w.push(`sp.price_median >= ${p(f.price_median_min)}`);
  if (f.price_median_max != null) w.push(`sp.price_median <= ${p(f.price_median_max)}`);
  if (f.lighthouse_perf_max != null) w.push(`(a.lighthouse->>'performance')::int <= ${p(f.lighthouse_perf_max)}`);
  if (f.completeness_min != null) w.push(`ct.completeness >= ${p(f.completeness_min)}`);
  if (f.has_email === true) w.push('ct.email IS NOT NULL');
  if (f.has_email === false) w.push('ct.email IS NULL');
  if (f.email_types) w.push(`ct.email_type = ANY(${p(f.email_types)}::text[])`);
  if (f.findings_has) w.push(`(SELECT count(DISTINCT g.code) FROM audit_findings g WHERE g.domain_id = d.id AND g.code = ANY(${p(f.findings_has)}::text[])) = ${p(f.findings_has.length)}`);
  if (f.findings_any) w.push(`EXISTS (SELECT 1 FROM audit_findings g WHERE g.domain_id = d.id AND g.code = ANY(${p(f.findings_any)}::text[]))`);
  if (f.findings_not) w.push(`NOT EXISTS (SELECT 1 FROM audit_findings g WHERE g.domain_id = d.id AND g.code = ANY(${p(f.findings_not)}::text[]))`);
  if (f.first_seen_after) w.push(`d.first_seen >= ${p(f.first_seen_after)}::date`);
  const sql = `
    SELECT d.id AS domain_id
    FROM brand_matches m
    JOIN domains d ON d.id = m.domain_id
    JOIN classifications k ON k.domain_id = d.id
    JOIN niches n ON n.id = k.niche_id
    LEFT JOIN sub_niches s ON s.id = k.sub_niche_id
    LEFT JOIN companies c ON c.domain_id = d.id
    LEFT JOIN contacts ct ON ct.domain_id = d.id
    LEFT JOIN store_profiles sp ON sp.domain_id = d.id
    LEFT JOIN audits a ON a.domain_id = d.id
    WHERE ${w.join('\n      AND ')}`;
  return { sql, params };
}

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
