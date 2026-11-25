import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { datasetExists, datasetGlob, db, env, lakeQuery, logger, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { loadBatch, type StagePlan } from '../plan.js';
import { TechEngine } from '../tech/engine.js';
import { clearedByRuntime, lighthouseFindings, runtimeTechs, summarizeLhr, type LighthouseRules } from './core.js';

/**
 * Stage 10 — Lighthouse (local, headless Chrome, mobile preset; no API key) for the top tier only.
 * Who is "top tier" is decided by a preliminary score from data we already have (setting
 * `lighthouse.prelim`), so the expensive browser runs only where it matters.
 */
interface Prelim {
  weights: { email: number; named_email: number; niche_confidence: number; completeness: number; active_store: number; problems: number };
  problems_full_at: number;
  active_store_days: number;
  min_score: number;
}

/** SQL for the preliminary score (0-100) per audited lead. Exported for the report. */
export async function prelimSql(p: Prelim): Promise<string | null> {
  for (const d of ['classified', 'contacts', 'audits', 'pages']) if (!(await datasetExists(d))) return null;
  const storeNiches = (await db().query<{ key: string }>(`SELECT key FROM niches WHERE gate = 'store'`)).rows.map((r) => sqlLiteral(r.key));
  const probe = (await datasetExists('store_probe'))
    ? `LEFT JOIN (SELECT domain, arg_max(last_published_at, probed_at) last_pub FROM read_parquet(${datasetGlob('store_probe')}) GROUP BY domain) s USING (domain)`
    : `LEFT JOIN (SELECT NULL::VARCHAR domain, NULL::TIMESTAMP last_pub) s USING (domain)`;
  const w = p.weights;
  return `
    WITH k AS (SELECT domain, arg_max(in_scope, classified_at) in_scope, arg_max(niche, classified_at) niche, arg_max(confidence, classified_at) confidence
               FROM read_parquet(${datasetGlob('classified')}) GROUP BY domain),
         c AS (SELECT domain, arg_max(email, extracted_at) email, arg_max(email_type, extracted_at) email_type, arg_max(completeness, extracted_at) completeness
               FROM read_parquet(${datasetGlob('contacts')}) GROUP BY domain),
         a AS (SELECT domain, arg_max(summary, audited_at) summary FROM read_parquet(${datasetGlob('audits')}) GROUP BY domain),
         p AS (SELECT domain, arg_max(final_url, fetched_at) final_url, arg_max(copyright_year, fetched_at) copyright_year
               FROM read_parquet(${datasetGlob('pages')}, union_by_name = true) WHERE pass GROUP BY domain),
         x AS (
           SELECT a.domain, p.final_url, k.niche,
             (CASE WHEN c.email IS NOT NULL THEN ${Number(w.email)} ELSE 0 END)
             + (CASE WHEN c.email_type = 'named' THEN ${Number(w.named_email)} ELSE 0 END)
             + ${Number(w.niche_confidence)} * least(coalesce(k.confidence, 0), 1)
             + ${Number(w.completeness)} * coalesce(c.completeness, 0)
             + (CASE WHEN ${storeNiches.length ? `k.niche IN (${storeNiches.join(', ')})` : 'false'}
                     THEN (CASE WHEN s.last_pub >= now() - INTERVAL ${Number(p.active_store_days)} DAY THEN ${Number(w.active_store)} ELSE 0 END)
                     ELSE (CASE WHEN p.copyright_year >= year(now()) - 1 THEN ${Number(w.active_store)} ELSE 0 END) END)
             + ${Number(w.problems)} * least((coalesce(json_extract(a.summary, '$.high')::INT, 0) + coalesce(json_extract(a.summary, '$.medium')::INT, 0)) / ${Math.max(1, Number(p.problems_full_at))}, 1)
             AS prelim
           FROM a JOIN k USING (domain) JOIN p USING (domain) LEFT JOIN c USING (domain) ${probe}
           WHERE k.in_scope)
    SELECT domain, final_url, niche, round(prelim, 1) AS prelim FROM x`;
}

export const lighthousePlan: StagePlan = {
  key: 'lighthouse',
  defaults: { batch: 20, snapshot: 200 },
  async todoSql() {
    const p = await setting<Prelim | null>('lighthouse.prelim', null);
    if (!p) return null;
    const base = await prelimSql(p);
    if (!base) return null;
    const done = (await datasetExists('lighthouse')) ? `AND domain NOT IN (SELECT domain FROM read_parquet(${datasetGlob('lighthouse')}))` : '';
    // The planner orders by `priority`: best preliminary score first.
    return `SELECT domain, final_url, niche, prelim, CAST(round(prelim) AS INTEGER) AS priority FROM (${base}) WHERE prelim >= ${Number(p.min_score)} ${done}`;
  },
};

interface Row { domain: string; final_url: string; niche: string; prelim: number }

/** One Chrome per slot; relaunched after a failure so one bad page cannot poison the rest. */
class ChromeSlot {
  private chrome: chromeLauncher.LaunchedChrome | null = null;
  constructor(private flags: string[], private chromePath: string | undefined) {}
  async port(): Promise<number> {
    this.chrome ??= await chromeLauncher.launch({ chromePath: this.chromePath, chromeFlags: this.flags, logLevel: 'silent' });
    return this.chrome.port;
  }
  kill() {
    try {
      this.chrome?.kill();
    } catch {
      /* already gone */
    }
    this.chrome = null;
  }
}

function chromeFlags(): string[] {
  const flags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--mute-audio'];
  // Behind an outbound HTTPS proxy that inspects TLS (e.g. a locked-down cloud sandbox) Chrome must use it too.
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxy) flags.push(`--proxy-server=${proxy.replace(/^https?:\/\//, '')}`, '--ignore-certificate-errors');
  return flags;
}

let engine: TechEngine | undefined;

export async function runLighthouseBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<Row>('lighthouse', snapshot, batch);
  const rules = await setting<LighthouseRules | null>('lighthouse.rules', null);
  if (!rules) throw new Error('setting lighthouse.rules is missing');
  const parallel = Math.max(1, await setting<number>('lighthouse.parallel', 2));
  const timeoutMs = await setting<number>('lighthouse.timeout_ms', 60_000);
  engine ??= new TechEngine();
  const slots = Array.from({ length: Math.min(parallel, rows.length || 1) }, () => new ChromeSlot(chromeFlags(), env().CHROME_PATH));

  // Light findings of this batch, to correct those a runtime tool disproves.
  const light = new Map<string, string[]>();
  if (rows.length) {
    for (const r of await lakeQuery<{ domain: string; codes: string[] }>(`
      SELECT domain, arg_max(codes, audited_at) codes FROM read_parquet(${datasetGlob('audits')})
      WHERE domain IN (${rows.map((r) => sqlLiteral(r.domain)).join(', ')}) GROUP BY domain`)) light.set(r.domain, r.codes ?? []);
  }

  return withRun('stage.lighthouse', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = [];
    let next = 0;
    try {
      await Promise.all(slots.map(async (slot) => {
        while (next < rows.length) {
          const row = rows[next++]!;
          const started = Date.now();
          let timer: NodeJS.Timeout | undefined;
          try {
            const port = await slot.port();
            const result = await Promise.race([
              lighthouse(row.final_url, { port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] }),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lighthouse_timeout')), timeoutMs); }),
            ]);
            const lhr = result?.lhr;
            if (!lhr) throw new Error('lighthouse_no_result');
            if (lhr.runtimeError?.code) throw new Error(`lighthouse_${lhr.runtimeError.code}`);
            const { summary, scriptUrls } = summarizeLhr(lhr);
            const techs = runtimeTechs(engine!, row.final_url, scriptUrls);
            const findings = lighthouseFindings(summary, rules);
            const cleared = clearedByRuntime(light.get(row.domain) ?? [], techs, rules);
            out.push({
              domain: row.domain, run_at: new Date().toISOString(), ok: true, error: null, prelim: row.prelim, ms: Date.now() - started,
              performance: summary.performance, accessibility: summary.accessibility, best_practices: summary.best_practices, seo: summary.seo,
              summary: JSON.stringify(summary), findings: JSON.stringify(findings), codes: findings.map((f) => f.code),
              runtime_techs: JSON.stringify(techs.map((t) => ({ name: t.name, version: t.version, categories: t.categories }))),
              cleared: JSON.stringify(cleared),
            });
          } catch (e) {
            slot.kill(); // a fresh Chrome for the next page
            const error = (e as Error).message.slice(0, 200);
            run.drop(error.startsWith('lighthouse_') ? error : 'lighthouse_error');
            logger.debug({ domain: row.domain, error }, 'lighthouse failed');
            out.push({ domain: row.domain, run_at: new Date().toISOString(), ok: false, error, prelim: row.prelim, ms: Date.now() - started,
              performance: null, accessibility: null, best_practices: null, seo: null, summary: null, findings: '[]', codes: [], runtime_techs: '[]', cleared: '[]' });
          } finally {
            clearTimeout(timer);
          }
        }
      }));
    } finally {
      for (const s of slots) s.kill();
    }

    await writeParquet('lighthouse', out, {
      name: `lighthouse-${snapshot}-${batch}`,
      columns: { domain: 'VARCHAR', run_at: 'TIMESTAMP', ok: 'BOOLEAN', error: 'VARCHAR', prelim: 'DOUBLE', ms: 'INTEGER',
        performance: 'INTEGER', accessibility: 'INTEGER', best_practices: 'INTEGER', seo: 'INTEGER', summary: 'VARCHAR',
        findings: 'VARCHAR', codes: 'VARCHAR[]', runtime_techs: 'VARCHAR', cleared: 'VARCHAR' },
    });

    const ok = out.filter((o) => o.ok);
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const domains = ok.map((o) => o.domain as string);
      await client.query(
        `INSERT INTO audits (domain_id, lighthouse, lighthouse_at)
         SELECT d.id, x.s::jsonb, now() FROM unnest($1::text[], $2::text[]) AS x(domain, s) JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id) DO UPDATE SET lighthouse = EXCLUDED.lighthouse, lighthouse_at = now()`,
        [domains, ok.map((o) => o.summary)],
      );
      await client.query(`DELETE FROM audit_findings f USING domains d WHERE f.domain_id = d.id AND d.domain = ANY($1::text[]) AND f.source = 'lighthouse'`, [domains]);
      const fd: string[] = [], code: string[] = [], sev: string[] = [], msg: string[] = [], ev: string[] = [];
      const cd: string[] = [], cc: string[] = [];
      const td: string[] = [], tn: string[] = [], tc: string[] = [], tv: (string | null)[] = [];
      for (const o of ok) {
        for (const f of JSON.parse(o.findings as string)) {
          fd.push(o.domain as string); code.push(f.code); sev.push(f.severity); msg.push(f.message); ev.push(JSON.stringify(f.evidence));
        }
        for (const c of JSON.parse(o.cleared as string)) { cd.push(o.domain as string); cc.push(c.code); }
        for (const t of JSON.parse(o.runtime_techs as string)) { td.push(o.domain as string); tn.push(t.name); tc.push(t.categories.join(String.fromCharCode(31))); tv.push(t.version); }
      }
      await client.query(
        `INSERT INTO audit_findings (domain_id, code, severity, message, evidence, source)
         SELECT d.id, x.code, x.sev, x.msg, x.ev::jsonb, 'lighthouse'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(domain, code, sev, msg, ev) JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id, code) DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, evidence = EXCLUDED.evidence, source = 'lighthouse'`,
        [fd, code, sev, msg, ev],
      );
      // Light findings disproved by a tool the browser saw loading (e.g. Klaviyo added by a tag manager).
      await client.query(
        `DELETE FROM audit_findings f USING unnest($1::text[], $2::text[]) AS x(domain, code), domains d
         WHERE d.domain = x.domain AND f.domain_id = d.id AND f.code = x.code AND f.source = 'light'`,
        [cd, cc],
      );
      await client.query(
        `INSERT INTO technologies (domain_id, tech, categories, version, confidence, source)
         SELECT d.id, x.tech, string_to_array(x.cats, chr(31)), x.version, 100, 'runtime'
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(domain, tech, cats, version) JOIN domains d ON d.domain = x.domain
         ON CONFLICT (domain_id, tech) DO NOTHING`,
        [td, tn, tc, tv],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    run.inCount = rows.length;
    run.outCount = ok.length;
    return { audited: ok.length, failed: rows.length - ok.length, findings: ok.reduce((n, o) => n + (o.codes as string[]).length, 0) };
  });
}
