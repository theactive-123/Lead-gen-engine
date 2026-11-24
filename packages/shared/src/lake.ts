import { DuckDBInstance, LIST, VARCHAR, dateValue, timestampValue, type DuckDBConnection } from '@duckdb/node-api';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';

/**
 * The data lake: Parquet files on disk, one folder per dataset, partitioned by day:
 *   data/lake/<dataset>/dt=YYYY-MM-DD/part-<uuid>.parquet
 * DuckDB reads and writes them. Nothing here touches Postgres.
 */
export function lakeDir(...parts: string[]): string {
  return path.resolve(env().LAKE_DIR, ...parts);
}

let instance: Promise<DuckDBInstance> | undefined;

async function createInstance(): Promise<DuckDBInstance> {
  const inst = await DuckDBInstance.create(':memory:', {
    threads: String(env().DUCKDB_THREADS),
    memory_limit: env().DUCKDB_MEMORY_LIMIT,
  });
  const con = await inst.connect();
  try {
    // httpfs lets DuckDB read Parquet over HTTPS (Common Crawl). Installed once, then cached on disk.
    await con.run('INSTALL httpfs');
    await con.run('LOAD httpfs');
    // Spill space: a fixed folder next to the lake (not the current directory) with a hard size cap.
    const tmp = path.resolve(env().LAKE_DIR, '..', 'duckdb-tmp');
    await mkdir(tmp, { recursive: true });
    await con.run(`SET temp_directory = ${sqlString(tmp)}`);
    await con.run(`SET max_temp_directory_size = ${sqlString(env().DUCKDB_MAX_TEMP)}`);
    await con.run('SET preserve_insertion_order = false'); // lets big scans stream instead of buffering
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    if (proxy) await con.run(`SET http_proxy = ${sqlString(proxy.replace(/^https?:\/\//, ''))}`);
  } finally {
    con.closeSync();
  }
  return inst;
}

/** In-memory DuckDB with the httpfs extension loaded (shared by the whole process). */
export async function duck(): Promise<DuckDBConnection> {
  instance ??= createInstance();
  return (await instance).connect();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

type ColType = 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'DATE' | 'VARCHAR[]';

/**
 * Write rows to a new Parquet file in the dataset's partition for `dt`.
 * Rows go straight into DuckDB through its native appender (no text/JSON staging, so any
 * character found on real web pages is safe), then DuckDB writes one zstd-compressed Parquet file.
 * `columns` fixes the schema and column order; keys not listed are ignored.
 */
export async function writeParquet(
  dataset: string,
  rows: Record<string, unknown>[],
  opts: { dt?: string; columns: Record<string, ColType>; name?: string },
): Promise<{ file: string; rows: number }> {
  if (rows.length === 0) return { file: '', rows: 0 };
  const dir = lakeDir(dataset, `dt=${opts.dt ?? today()}`);
  await mkdir(dir, { recursive: true });
  // A fixed `name` makes writes idempotent: re-running the same batch overwrites the same file.
  const id = opts.name ?? randomUUID();
  const file = path.join(dir, `part-${id}.parquet`);
  const table = `w_${randomUUID().replaceAll('-', '')}`;
  const cols = Object.entries(opts.columns);
  const con = await duck();
  try {
    await con.run(`CREATE TABLE ${table} (${cols.map(([c, t]) => `"${c}" ${t}`).join(', ')})`);
    const app = await con.createAppender(table);
    const varcharList = LIST(VARCHAR);
    for (const row of rows) {
      for (const [c, t] of cols) {
        const v = row[c];
        if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) {
          app.appendNull();
          continue;
        }
        switch (t) {
          case 'VARCHAR': app.appendVarchar(clean(String(v))); break;
          case 'INTEGER': app.appendInteger(Math.trunc(Number(v))); break;
          case 'BIGINT': app.appendBigInt(BigInt(Math.trunc(Number(v)))); break;
          case 'DOUBLE': app.appendDouble(Number(v)); break;
          case 'BOOLEAN': app.appendBoolean(Boolean(v)); break;
          case 'TIMESTAMP': app.appendTimestamp(timestampValue(BigInt(toDate(v).getTime()) * 1000n)); break;
          case 'DATE': app.appendDate(dateValue(Math.floor(toDate(v).getTime() / 86_400_000))); break;
          case 'VARCHAR[]': app.appendList((v as unknown[]).map((x) => clean(String(x))), varcharList); break;
        }
      }
      app.endRow();
    }
    app.flushSync();
    app.closeSync();
    // Written to a temp name, then renamed: readers never see half-written files.
    const tmpOut = `${file}.${randomUUID()}.tmp`;
    await con.run(`COPY ${table} TO ${sqlString(tmpOut)} (FORMAT parquet, COMPRESSION zstd)`);
    await rename(tmpOut, file);
  } finally {
    await con.run(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    con.closeSync();
  }
  return { file, rows: rows.length };
}

const toDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
// NUL characters are not allowed in DuckDB text; web pages occasionally contain them.
const clean = (s: string) => (s.includes('\u0000') ? s.replaceAll('\u0000', '') : s);

/** Glob for every Parquet file of a dataset (all days), for use inside DuckDB SQL. */
export function datasetGlob(dataset: string): string {
  return sqlString(lakeDir(dataset, '*', '*.parquet'));
}

/** Run a read query and return plain JS objects. */
export async function lakeQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const con = await duck();
  try {
    const reader = await con.runAndReadAll(sql);
    return reader.getRowObjectsJS() as T[];
  } finally {
    con.closeSync();
  }
}

/** Size and file count per dataset, for the disk monitor. */
export async function lakeUsage(): Promise<{ dataset: string; files: number; bytes: number }[]> {
  const root = lakeDir();
  await mkdir(root, { recursive: true });
  const out: { dataset: string; files: number; bytes: number }[] = [];
  for (const dataset of await readdir(root)) {
    let files = 0;
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.parquet')) {
          files++;
          bytes += (await stat(p)).size;
        }
      }
    };
    const p = path.join(root, dataset);
    if ((await stat(p)).isDirectory()) {
      await walk(p);
      out.push({ dataset, files, bytes });
    }
  }
  return out;
}

/** True when the dataset has at least one Parquet file (DuckDB errors on an empty glob). */
export async function datasetExists(dataset: string): Promise<boolean> {
  const { glob } = await import('node:fs/promises');
  for await (const _ of glob(path.join(lakeDir(dataset), '**', '*.parquet'))) return true;
  return false;
}

/** Run a statement (COPY, CREATE...) without reading results. */
export async function lakeRun(sql: string): Promise<void> {
  const con = await duck();
  try {
    await con.run(sql);
  } finally {
    con.closeSync();
  }
}

export { sqlString as sqlLiteral };

/**
 * Latest stored homepage HTML (and fetch metadata) for some domains.
 * Two steps on purpose: find the few files that contain these domains (reads only the small domain
 * column), then read the HTML from those files only. Reading the HTML column across all files at once
 * made concurrent batches spill gigabytes to disk.
 */
export async function htmlFor(
  domains: string[],
): Promise<{ domain: string; final_url: string; headers: string; cookies: string[]; html: string; robots_txt: string | null }[]> {
  if (!domains.length || !(await datasetExists('html'))) return [];
  const list = domains.map(sqlString).join(', ');
  const files = await lakeQuery<{ f: string }>(
    `SELECT DISTINCT filename AS f FROM read_parquet(${datasetGlob('html')}, filename = true) WHERE domain IN (${list})`,
  );
  if (!files.length) return [];
  return lakeQuery(`
    SELECT domain, arg_max(final_url, fetched_at) AS final_url, arg_max(headers, fetched_at) AS headers,
           arg_max(cookies, fetched_at) AS cookies, arg_max(html, fetched_at) AS html, arg_max(robots_txt, fetched_at) AS robots_txt
    FROM read_parquet([${files.map((x) => sqlString(x.f)).join(', ')}]) WHERE domain IN (${list}) GROUP BY domain`);
}
