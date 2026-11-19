import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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

let instance: DuckDBInstance | undefined;

/** In-memory DuckDB with the httpfs extension (needed to query Common Crawl over HTTPS). */
export async function duck(): Promise<DuckDBConnection> {
  if (!instance) {
    instance = await DuckDBInstance.create(':memory:', { threads: '4', memory_limit: '2GB' });
  }
  return instance.connect();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * Write rows to a new Parquet file in the dataset's partition for `dt`.
 * Rows are staged as newline-delimited JSON and converted by DuckDB (fast, typed by inference
 * or by the explicit `columns` map). Returns the file path and row count.
 */
export async function writeParquet(
  dataset: string,
  rows: Record<string, unknown>[],
  opts: { dt?: string; columns?: Record<string, string> } = {},
): Promise<{ file: string; rows: number }> {
  if (rows.length === 0) return { file: '', rows: 0 };
  const dir = lakeDir(dataset, `dt=${opts.dt ?? today()}`);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const tmp = path.join(dir, `.staging-${id}.ndjson`);
  const file = path.join(dir, `part-${id}.parquet`);
  await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join('\n'));
  const con = await duck();
  try {
    const cols = opts.columns
      ? `, columns={${Object.entries(opts.columns).map(([k, v]) => `${sqlString(k)}: ${sqlString(v)}`).join(', ')}}`
      : '';
    // Written to a temp name, then renamed: readers never see half-written files.
    await con.run(
      `COPY (SELECT * FROM read_json(${sqlString(tmp)}, format='newline_delimited'${cols}))
       TO ${sqlString(file + '.tmp')} (FORMAT parquet, COMPRESSION zstd)`,
    );
    await rename(file + '.tmp', file);
  } finally {
    con.closeSync();
    await rm(tmp, { force: true });
  }
  return { file, rows: rows.length };
}

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
