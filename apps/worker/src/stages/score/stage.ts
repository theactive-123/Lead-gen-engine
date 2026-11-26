import { createHash } from 'node:crypto';
import { db, getCheckpoint, setCheckpoint, setting, withRun } from '@lead/shared';
import { scoreLead, type Brand, type Lead, type ScoringSettings } from './engine.js';
import { firstLines, type LineRules, type Template } from './lines.js';

/**
 * Stages 11 + 12 as one job: score every in-niche lead for every enabled brand, and write its first lines.
 * Runs every 15 minutes. Only leads whose data changed since they were last scored are redone, unless the
 * brand setup (profiles, niche weights, problem map, templates, scoring settings) changed: then everything is.
 * Reads and writes Postgres only (in batches, bulk writes).
 */

interface Config { brands: Brand[]; templates: Template[]; settings: ScoringSettings; rules: LineRules; hash: string }

export async function loadConfig(): Promise<Config> {
  const q = db();
  const brandRows = (await q.query(`SELECT id, key, platform_weights, platform_default, platform_null, target_countries, excluded_countries,
      country_other, country_unknown, size, need_full_at, need_floor, weights, tiers, lead_with_niche, updated_at FROM brands WHERE enabled ORDER BY id`)).rows;
  const nw = (await q.query<{ brand_id: number; niche_id: number; sub_niche_id: number | null; weight: string }>(
    `SELECT brand_id, niche_id, sub_niche_id, weight FROM brand_niche_weights ORDER BY id`)).rows;
  const pm = (await q.query<{ brand_id: number; finding_code: string; service: string; weight: string }>(
    `SELECT brand_id, finding_code, service, weight FROM brand_problem_map WHERE enabled ORDER BY brand_id, finding_code`)).rows;
  const templates = (await q.query<Template>(
    `SELECT id, brand_id, niche_id, finding_code, variant, template FROM brand_templates WHERE enabled ORDER BY id`)).rows;
  const brands: Brand[] = brandRows.map((r) => ({
    id: r.id, key: r.key, platform_weights: r.platform_weights, platform_default: Number(r.platform_default), platform_null: Number(r.platform_null),
    target_countries: r.target_countries, excluded_countries: r.excluded_countries, country_other: Number(r.country_other),
    country_unknown: Number(r.country_unknown), size: r.size, need_full_at: Number(r.need_full_at), need_floor: Number(r.need_floor),
    weights: r.weights, tiers: r.tiers, lead_with_niche: r.lead_with_niche,
    niches: new Map(nw.filter((w) => w.brand_id === r.id && w.sub_niche_id == null).map((w) => [w.niche_id, Number(w.weight)])),
    subNiches: new Map(nw.filter((w) => w.brand_id === r.id && w.sub_niche_id != null).map((w) => [w.sub_niche_id!, Number(w.weight)])),
    problems: new Map(pm.filter((p) => p.brand_id === r.id).map((p) => [p.finding_code, { service: p.service, weight: Number(p.weight) }])),
  }));
  const settings: ScoringSettings = {
    reach: await setting('scoring.reach', { email: { named: 1, role: 0.8, freemail: 0.6 }, phone_only: 0.3, nothing: 0.05, completeness_share: 0.3 }),
    freshness: await setting('scoring.freshness', { active_days: 90, active: 1, copyright_current: 0.9, new_domain_days: 365, new_domain: 0.9, unknown: 0.6, stale_years: 3, stale: 0.35 }),
    severity: await setting('scoring.severity', { high: 1, medium: 0.8, low: 0.5, info: 1 }),
    confidence_share: Number(await setting('scoring.confidence_share', 0.4)),
    size_outside: Number(await setting('scoring.size_outside', 0.5)),
    size_unknown: Number(await setting('scoring.size_unknown', 0.8)),
  };
  const rules = await setting<LineRules>('first_lines.rules', { max_words: 25, variants: 3, banned: ['!'] });
  const hash = createHash('sha1').update(JSON.stringify({
    brands: brands.map((b) => ({ ...b, niches: [...b.niches], subNiches: [...b.subNiches], problems: [...b.problems] })), templates, settings, rules,
  })).digest('hex');
  return { brands, templates, settings, rules, hash };
}

/** The scoring inputs of a batch of leads (one row per lead, findings as JSON). */
export function leadSql(where: string): string {
  return `
    SELECT d.id::text AS domain_id, d.domain, k.niche_id, n.key AS niche_key, n.gate AS niche_gate, k.sub_niche_id, s.key AS sub_niche_key,
      k.confidence::float AS confidence, coalesce(c.platform, d.platform) AS platform, c.country, c.name AS company,
      sp.product_count, ct.email, ct.email_type, ct.phone, ct.completeness::float AS completeness, c.freshness,
      coalesce((SELECT json_agg(json_build_object('code', f.code, 'severity', f.severity, 'evidence', f.evidence))
                FROM audit_findings f WHERE f.domain_id = d.id), '[]') AS findings
    FROM classifications k
    JOIN domains d ON d.id = k.domain_id
    JOIN niches n ON n.id = k.niche_id
    LEFT JOIN sub_niches s ON s.id = k.sub_niche_id
    LEFT JOIN companies c ON c.domain_id = d.id
    LEFT JOIN contacts ct ON ct.domain_id = d.id
    LEFT JOIN store_profiles sp ON sp.domain_id = d.id
    LEFT JOIN audits a ON a.domain_id = d.id
    WHERE ${where}`;
}

/** Leads to (re)score: never scored, or any input changed after their last score. */
const CHANGED = `(
  NOT EXISTS (SELECT 1 FROM brand_matches m WHERE m.domain_id = d.id)
  OR greatest(k.classified_at, ct.extracted_at, c.updated_at, a.audited_at, a.lighthouse_at, sp.probed_at)
     > (SELECT min(m.scored_at) FROM brand_matches m WHERE m.domain_id = d.id))`;

export function scoreLeads(leads: Lead[], cfg: Config, now = new Date()) {
  const m = { domain: [] as string[], brand: [] as number[], score: [] as number[], tier: [] as string[], bd: [] as string[] };
  const l = { domain: [] as string[], brand: [] as number[], variant: [] as number[], text: [] as string[], code: [] as string[], tpl: [] as number[] };
  const tiers: Record<string, number> = {};
  for (const lead of leads) {
    for (const b of cfg.brands) {
      const match = scoreLead(lead, b, cfg.settings, now);
      m.domain.push(lead.domain_id); m.brand.push(b.id); m.score.push(match.score); m.tier.push(match.tier); m.bd.push(JSON.stringify(match.breakdown));
      tiers[`${b.key}:${match.tier}`] = (tiers[`${b.key}:${match.tier}`] ?? 0) + 1;
      if (match.tier === 'X') continue;
      for (const line of firstLines(lead, b.id, match.breakdown.need.problems, cfg.templates, cfg.rules, b.lead_with_niche)) {
        l.domain.push(lead.domain_id); l.brand.push(b.id); l.variant.push(line.variant); l.text.push(line.text); l.code.push(line.finding_code); l.tpl.push(line.template_id);
      }
    }
  }
  return { m, l, tiers };
}

async function writeBatch(domainIds: string[], r: ReturnType<typeof scoreLeads>): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM brand_matches WHERE domain_id = ANY($1::bigint[])`, [domainIds]);
    await client.query(`DELETE FROM first_lines WHERE domain_id = ANY($1::bigint[])`, [domainIds]);
    await client.query(
      `INSERT INTO brand_matches (domain_id, brand_id, match_score, tier, breakdown, scored_at)
       SELECT * , now() FROM unnest($1::bigint[], $2::int[], $3::numeric[], $4::text[], $5::jsonb[])`,
      [r.m.domain, r.m.brand, r.m.score, r.m.tier, r.m.bd],
    );
    await client.query(
      `INSERT INTO first_lines (domain_id, brand_id, variant, text, finding_code, template_id)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::int[], $4::text[], $5::text[], $6::int[])`,
      [r.l.domain, r.l.brand, r.l.variant, r.l.text, r.l.code, r.l.tpl],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** One scoring pass. `full` forces every lead to be rescored (also automatic when the brand setup changed). */
export async function runScoring(opts: { full?: boolean } = {}) {
  return withRun('stage.score', opts, async (run) => {
    const cfg = await loadConfig();
    const full = opts.full || (await getCheckpoint<string>('score:config')) !== cfg.hash;
    const size = Math.max(100, Number(await setting('stage.score.batch_size', 2000)));
    // Leads that left the niche list lose their matches (classifications only holds in-niche leads).
    const gone = await db().query(`DELETE FROM brand_matches m WHERE NOT EXISTS (SELECT 1 FROM classifications k WHERE k.domain_id = m.domain_id)`);
    await db().query(`DELETE FROM first_lines f WHERE NOT EXISTS (SELECT 1 FROM classifications k WHERE k.domain_id = f.domain_id)`);
    if (gone.rowCount) run.drop('left_niche', gone.rowCount);
    const tiers: Record<string, number> = {};
    let after = '0';
    for (;;) {
      const { rows } = await db().query<Lead>(`${leadSql(`d.id > $1 ${full ? '' : `AND ${CHANGED}`}`)} ORDER BY d.id LIMIT $2`, [after, size]);
      if (!rows.length) break;
      after = rows.at(-1)!.domain_id;
      for (const r of rows) r.findings ??= [];
      const res = scoreLeads(rows, cfg);
      await writeBatch(rows.map((r) => r.domain_id), res);
      for (const [k, v] of Object.entries(res.tiers)) tiers[k] = (tiers[k] ?? 0) + v;
      run.inCount += rows.length;
      run.outCount += res.m.tier.filter((t) => t === 'A' || t === 'B').length;
    }
    await setCheckpoint('score:config', cfg.hash);
    return { full, leads: run.inCount, brands: cfg.brands.length, tiers };
  });
}
