import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { SUPPRESSED, db, env, lakeDir, logger, segmentWhere, setting, withRun } from '@lead/shared';
import { COLUMNS, csvLine, fileName, sheetName, toRow, type ExportLead } from './format.js';

/**
 * Stage 13 — exports. A dashboard request (or the daily schedule) creates a row in `exports`; this job writes the file.
 * Order of work: pick the leads → write the file under a temporary name → rename it → mark the leads as exported and
 * the export as done in one transaction. A crash at any point leaves no half file and no leads wrongly marked.
 * The do-not-contact list is applied in the same query that picks the leads, i.e. right before writing.
 */

export function exportDir(): string {
  return env().EXPORT_DIR ? path.resolve(env().EXPORT_DIR!) : path.resolve(lakeDir(), '..', 'exports');
}

interface ExportRow {
  id: number; brand_id: number; brand_key: string; brand_name: string; segment_id: number | null; segment_name: string | null; segment_filter: unknown;
  tiers: string[]; format: 'csv' | 'xlsx'; mode: 'new' | 'all'; require_email: boolean; sheets: 'niche' | 'none'; created_at: Date;
}

const CHUNK = 2000;

/** The leads of one export, best first (grouped by niche for Excel sheets). */
async function pickLeads(x: ExportRow, maxRows: number) {
  const segFilter = (x.segment_filter ?? {}) as Record<string, unknown>;
  const segTiers = Array.isArray(segFilter['tiers']) ? (segFilter['tiers'] as string[]) : null;
  const tiers = segTiers ? x.tiers.filter((t) => segTiers.includes(t)) : x.tiers;
  if (!tiers.length) return { candidates: 0, suppressed: 0, ids: [] as string[], niches: [] as { niche: string; n: number }[] };
  const filter = { ...segFilter, tiers, ...(x.require_email ? { has_email: true } : {}) };
  const extra = x.mode === 'new' ? `AND NOT EXISTS (SELECT 1 FROM exported_leads e WHERE e.brand_id = $1 AND e.domain_id = d.id)` : '';
  const all = segmentWhere(x.brand_id, filter, { includeSuppressed: true });
  const c = (await db().query<{ n: string; suppressed: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE ${SUPPRESSED}) AS suppressed FROM ${all.from} WHERE ${all.where} ${extra}`, all.params)).rows[0]!;
  const candidates = Number(c.n);
  const suppressed = Number(c.suppressed);
  const ok = segmentWhere(x.brand_id, filter);
  const order = x.format === 'xlsx' && x.sheets === 'niche' ? 'n.name, m.match_score DESC, d.id' : 'm.match_score DESC, d.id';
  const rows = (await db().query<{ id: string; niche: string }>(
    `SELECT d.id::text AS id, n.name AS niche FROM ${ok.from} WHERE ${ok.where} ${extra} ORDER BY ${order} LIMIT ${Math.max(1, maxRows)}`, ok.params)).rows;
  const niches = new Map<string, number>();
  for (const r of rows) niches.set(r.niche, (niches.get(r.niche) ?? 0) + 1);
  return { candidates, suppressed, ids: rows.map((r) => r.id), niches: [...niches].map(([niche, n]) => ({ niche, n })) };
}

/** Full export data for a batch of lead ids, in the given order. */
async function details(ids: string[], brandId: number, techCats: string[]): Promise<ExportLead[]> {
  return (await db().query<ExportLead>(`
    SELECT d.id::text AS id, d.domain, d.final_url, d.first_seen, d.sources, m.tier, m.match_score, m.breakdown,
      n.name AS niche, s.name AS sub_niche, c.name AS company, coalesce(c.platform, d.platform) AS platform, c.country, c.region, c.city,
      ct.email, ct.email_type, ct.phone, ct.owner_name, ct.owner_title, ct.socials, sp.product_count, sp.price_min::text, sp.price_max::text, sp.currency,
      (a.lighthouse->>'performance')::int AS perf,
      (SELECT string_agg(t.tech, ' | ' ORDER BY t.tech) FROM technologies t WHERE t.domain_id = d.id AND t.categories && $3::text[]) AS key_tech,
      (SELECT json_agg(json_build_object('code', f.code, 'severity', f.severity, 'message', f.message)) FROM audit_findings f WHERE f.domain_id = d.id) AS findings,
      (SELECT json_agg(fl.text ORDER BY fl.variant) FROM first_lines fl WHERE fl.domain_id = d.id AND fl.brand_id = $2) AS lines,
      (SELECT string_agg(sg.name, ' | ' ORDER BY sg.name) FROM segment_members sm JOIN segments sg ON sg.id = sm.segment_id
        WHERE sm.domain_id = d.id AND sg.brand_id = $2) AS segments
    FROM unnest($1::bigint[]) WITH ORDINALITY AS u(id, ord)
    JOIN domains d ON d.id = u.id
    JOIN brand_matches m ON m.domain_id = d.id AND m.brand_id = $2
    JOIN classifications k ON k.domain_id = d.id JOIN niches n ON n.id = k.niche_id LEFT JOIN sub_niches s ON s.id = k.sub_niche_id
    LEFT JOIN companies c ON c.domain_id = d.id LEFT JOIN contacts ct ON ct.domain_id = d.id
    LEFT JOIN store_profiles sp ON sp.domain_id = d.id LEFT JOIN audits a ON a.domain_id = d.id
    ORDER BY u.ord`, [ids, brandId, techCats])).rows;
}

async function writeCsv(file: string, x: ExportRow, ids: string[], techCats: string[]): Promise<number> {
  const out = createWriteStream(file, { encoding: 'utf8' });
  const write = async (s: string) => { if (!out.write(s)) await once(out, 'drain'); };
  await write('﻿'); // byte-order mark: Excel then reads the file as UTF-8 (accents, €, …)
  await write(csvLine([...COLUMNS]));
  let n = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const l of await details(ids.slice(i, i + CHUNK), x.brand_id, techCats)) {
      await write(csvLine(toRow(l, x.brand_name, x.segment_name)));
      n++;
    }
  }
  out.end();
  await once(out, 'finish');
  return n;
}

const WIDTH: Record<string, number> = { domain: 28, website: 32, company_name: 26, email: 30, key_technologies: 40, finding_1: 50, finding_2: 50,
  finding_3: 50, services_to_pitch: 34, first_line_1: 60, first_line_2: 60, first_line_3: 60, socials: 40, niche: 22, sub_niche: 22 };

async function writeXlsx(file: string, x: ExportRow, ids: string[], niches: { niche: string; n: number }[], candidates: number, suppressed: number, techCats: string[]): Promise<number> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true, useSharedStrings: false });
  wb.creator = 'LeadEngine';
  const taken = new Set<string>();
  const summary = wb.addWorksheet(sheetName('Summary', taken));
  summary.columns = [{ width: 34 }, { width: 60 }];
  const info: [string, string | number][] = [
    ['Brand', x.brand_name], ['Segment', x.segment_name ?? 'All leads of the brand'], ['Tiers', x.tiers.join(', ')],
    ['Mode', x.mode === 'new' ? 'New since last export (never exported for this brand)' : 'All matching leads'],
    ['Only leads with an email', x.require_email ? 'Yes' : 'No'], ['Created (UTC)', x.created_at.toISOString().slice(0, 16).replace('T', ' ')],
    ['Leads matching', candidates], ['Removed by the do-not-contact list', suppressed], ['Leads in this file', ids.length], ['', ''],
  ];
  // Streaming writer: style a row before commit(), it cannot be changed afterwards.
  const bold = (r: ExcelJS.Row) => { r.font = { bold: true }; return r; };
  for (const [i, r] of info.entries()) (i === 0 ? bold(summary.addRow(r)) : summary.addRow(r)).commit();
  if (x.sheets === 'niche') {
    bold(summary.addRow(['Sheet (niche)', 'Leads'])).commit();
    for (const s of niches) summary.addRow([s.niche, s.n]).commit();
  }
  await summary.commit();

  const groups = x.sheets === 'niche' ? niches : [{ niche: 'Leads', n: ids.length }];
  let at = 0;
  let written = 0;
  for (const g of groups) {
    const ws = wb.addWorksheet(sheetName(g.niche, taken), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: WIDTH[c] ?? 14 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    const mine = ids.slice(at, at + g.n);
    at += g.n;
    for (let i = 0; i < mine.length; i += CHUNK) {
      for (const l of await details(mine.slice(i, i + CHUNK), x.brand_id, techCats)) {
        // Excel stores these as text cells, never formulas, so no apostrophe is needed here.
        ws.addRow(toRow(l, x.brand_name, x.segment_name)).commit();
        written++;
      }
    }
    await ws.commit();
  }
  await wb.commit();
  return written;
}

export async function buildExport(id: number): Promise<Record<string, unknown>> {
  const x = (await db().query<ExportRow>(`
    SELECT e.id, e.brand_id, b.key AS brand_key, b.name AS brand_name, e.segment_id, coalesce(sg.name, e.segment_name) AS segment_name,
      sg.filter AS segment_filter, e.tiers, e.format, e.mode, e.require_email, e.sheets, e.created_at
    FROM exports e JOIN brands b ON b.id = e.brand_id LEFT JOIN segments sg ON sg.id = e.segment_id WHERE e.id = $1`, [id])).rows[0];
  if (!x) throw new Error(`export ${id} not found`);
  if (x.segment_id && x.segment_filter == null) throw new Error(`segment ${x.segment_id} no longer exists`);
  return withRun('stage.export', { id }, async (run) => {
    await db().query(`UPDATE exports SET status = 'running', started_at = now(), error = NULL WHERE id = $1`, [id]);
    const dir = exportDir();
    await mkdir(dir, { recursive: true });
    const name = fileName({ id, brandKey: x.brand_key, segment: x.segment_name, tiers: x.tiers, format: x.format, at: x.created_at });
    const tmp = path.join(dir, `${name}.part`);
    try {
      const maxRows = Number(await setting('exports.max_rows', 500000));
      const techCats = await setting<string[]>('exports.key_tech_categories', []);
      const { candidates, suppressed, ids, niches } = await pickLeads(x, maxRows);
      const rows = x.format === 'csv' ? await writeCsv(tmp, x, ids, techCats) : await writeXlsx(tmp, x, ids, niches, candidates, suppressed, techCats);
      await rename(tmp, path.join(dir, name));
      const bytes = (await stat(path.join(dir, name))).size;
      const client = await db().connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO exported_leads (brand_id, domain_id, first_export_id, last_export_id)
          SELECT $1, u.id, $2, $2 FROM unnest($3::bigint[]) AS u(id)
          ON CONFLICT (brand_id, domain_id) DO UPDATE SET last_export_id = EXCLUDED.last_export_id, last_exported_at = now(), times = exported_leads.times + 1`,
          [x.brand_id, id, ids]);
        await client.query(`UPDATE exports SET status = 'done', finished_at = now(), candidates = $2, suppressed = $3, row_count = $4, file_name = $5, file_bytes = $6
          WHERE id = $1`, [id, candidates, suppressed, rows, name, bytes]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      run.inCount = candidates;
      run.outCount = rows;
      if (suppressed) run.drop('suppressed', suppressed);
      return { id, rows, candidates, suppressed, file: name, bytes };
    } catch (err) {
      await rm(tmp, { force: true });
      await db().query(`UPDATE exports SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [id, (err as Error).message.slice(0, 500)]);
      throw err;
    }
  });
}

/** Daily: the exports listed in setting exports.daily (always "new since last export"), plus removal of old files. */
export async function dailyExports(): Promise<Record<string, unknown>> {
  const list = await setting<{ brand: string; segment?: string | null; tiers?: string[]; format?: 'csv' | 'xlsx'; require_email?: boolean }[]>('exports.daily', []);
  const made: number[] = [];
  for (const d of list) {
    const r = (await db().query<{ id: number }>(`
      INSERT INTO exports (brand_id, segment_id, segment_name, tiers, format, mode, require_email, requested_by)
      SELECT b.id, sg.id, sg.name, $3, $4, 'new', $5, 'daily schedule' FROM brands b LEFT JOIN segments sg ON sg.brand_id = b.id AND sg.name = $2
      WHERE b.key = $1 RETURNING id`, [d.brand, d.segment ?? null, d.tiers ?? ['A', 'B'], d.format ?? 'xlsx', d.require_email ?? true])).rows[0];
    if (!r) { logger.warn({ daily: d }, 'daily export: unknown brand'); continue; }
    await buildExport(r.id).catch((err) => logger.error({ err, id: r.id }, 'daily export failed'));
    made.push(r.id);
  }
  return { made, removed: await removeOldFiles() };
}

/** Files older than exports.keep_days are deleted (their history row stays, the download link then says so). */
export async function removeOldFiles(): Promise<number> {
  const keep = Number(await setting('exports.keep_days', 30));
  const dir = exportDir();
  let removed = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, f);
    const s = await stat(p).catch(() => null);
    if (s && Date.now() - s.mtimeMs > keep * 86_400_000) { await rm(p, { force: true }); removed++; }
  }
  return removed;
}
