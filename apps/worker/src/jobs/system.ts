import { mkdir, statfs } from 'node:fs/promises';
import { WORKER_ID, db, datasetGlob, lakeDir, lakeQuery, lakeUsage, writeParquet, withRun } from '@lead/shared';

/** Called every 30s by each worker process (not via the queue): "I am alive". */
export async function beat(): Promise<void> {
  const info = { pid: process.pid, uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1e6) };
  await db().query(
    `INSERT INTO workers(id, info) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET last_beat = now(), info = EXCLUDED.info`,
    [WORKER_ID, JSON.stringify(info)],
  );
}

/**
 * Scheduled every minute (one worker runs it): records a heartbeat metric and
 * marks runs as failed when their worker stopped beating 2+ minutes ago (crash, kill, reboot).
 * The queue job itself is retried by pg-boss; this only keeps the run log honest.
 */
export async function heartbeat(): Promise<void> {
  const live = await db().query<{ n: string }>(`SELECT count(*)::text AS n FROM workers WHERE last_beat > now() - interval '2 minutes'`);
  await db().query(`INSERT INTO system_metrics(metric, value) VALUES ('heartbeat', $1)`, [
    JSON.stringify({ live_workers: Number(live.rows[0]!.n), by: WORKER_ID }),
  ]);
  await db().query(
    `UPDATE runs r SET status = 'failed', finished_at = now(), error = 'worker stopped before the run finished'
     WHERE r.status = 'running'
       AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = r.worker_id AND w.last_beat > now() - interval '2 minutes')`,
  );
  await db().query(`DELETE FROM workers WHERE last_beat < now() - interval '1 day'`);
}

/** Disk monitor (section 12): free disk space + size of each lake dataset. */
export async function diskUsage(): Promise<void> {
  await mkdir(lakeDir(), { recursive: true });
  const fs = await statfs(lakeDir());
  const value = {
    disk_free_gb: +((fs.bavail * fs.bsize) / 1e9).toFixed(2),
    disk_total_gb: +((fs.blocks * fs.bsize) / 1e9).toFixed(2),
    lake: await lakeUsage(),
  };
  await db().query(`INSERT INTO system_metrics(metric, value) VALUES ('disk', $1)`, [JSON.stringify(value)]);
}

/**
 * End-to-end check of the data lake: write N rows to Parquet, read them back with DuckDB,
 * and log it as a run. Used in Phase 1 to prove the storage layer and measure its speed.
 */
export async function lakeSelftest(data: { rows?: number }): Promise<Record<string, unknown>> {
  const n = data.rows ?? 100_000;
  return withRun('system.lake-selftest', { rows: n }, async (run) => {
    const rows = Array.from({ length: n }, (_, i) => ({
      domain: `selftest-${i}.example`,
      source: 'selftest',
      first_seen: new Date().toISOString().slice(0, 10),
    }));
    run.inCount = n;
    const t0 = performance.now();
    const { file } = await writeParquet('selftest', rows, {
      columns: { domain: 'VARCHAR', source: 'VARCHAR', first_seen: 'DATE' },
    });
    const writeMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const [res] = await lakeQuery<{ total: bigint; distinct_domains: bigint }>(
      `SELECT count(*) AS total, count(DISTINCT domain) AS distinct_domains FROM read_parquet(${datasetGlob('selftest')})`,
    );
    const readMs = Math.round(performance.now() - t1);
    run.outCount = n;
    return { file, writeMs, readMs, total: Number(res!.total), distinct: Number(res!.distinct_domains) };
  });
}

/** At worker start: which fingerprint data is loaded (shown on the dashboard Settings page). */
export async function fingerprintInfo(dir: string, technologies: number): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(`${dir}/SOURCE.md`, 'utf8').catch(() => '');
  const overrides = JSON.parse(await readFile(`${dir}/overrides.json`, 'utf8').catch(() => '{}')) as Record<string, { _note?: string }>;
  await db().query(`INSERT INTO system_metrics (metric, value) VALUES ('fingerprints', $1)`, [JSON.stringify({
    technologies,
    commit: /Commit: (.+)/.exec(source)?.[1]?.trim() ?? null,
    source: /Source: (\S+)/.exec(source)?.[1] ?? null,
    overrides: Object.entries(overrides).filter(([k]) => !k.startsWith('_')).map(([name, o]) => ({ name, note: o._note ?? null })),
  })]);
}
