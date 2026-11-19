import { db } from './db.js';
import { logger } from './logger.js';
import { WORKER_ID } from './worker-id.js';

/**
 * A "run" is one execution of a stage or source (e.g. "dns" on a batch of 5,000 domains).
 * Every run records counts in/out, drops by reason, errors and throughput,
 * which feeds the funnel and throughput views in the dashboard.
 */
export class Run {
  inCount = 0;
  outCount = 0;
  errorCount = 0;
  dropped: Record<string, number> = {};
  private readonly started = Date.now();

  private constructor(readonly id: number, readonly stage: string) {}

  static async start(stage: string, meta: Record<string, unknown> = {}): Promise<Run> {
    const r = await db().query<{ id: string }>(
      `INSERT INTO runs(stage, status, meta, worker_id) VALUES ($1, 'running', $2, $3) RETURNING id`,
      [stage, JSON.stringify(meta), WORKER_ID],
    );
    return new Run(Number(r.rows[0]!.id), stage);
  }

  drop(reason: string, n = 1): void {
    this.dropped[reason] = (this.dropped[reason] ?? 0) + n;
  }

  /** Save progress mid-run so long jobs show live numbers. */
  async flush(): Promise<void> {
    await db().query(
      `UPDATE runs SET in_count=$2, out_count=$3, error_count=$4, dropped=$5, per_minute=$6 WHERE id=$1`,
      [this.id, this.inCount, this.outCount, this.errorCount, JSON.stringify(this.dropped), this.perMinute()],
    );
  }

  async finish(status: 'ok' | 'failed' = 'ok', error?: string): Promise<void> {
    await db().query(
      `UPDATE runs SET status=$2, finished_at=now(), in_count=$3, out_count=$4, error_count=$5,
         dropped=$6, per_minute=$7, error=$8 WHERE id=$1`,
      [this.id, status, this.inCount, this.outCount, this.errorCount, JSON.stringify(this.dropped), this.perMinute(), error ?? null],
    );
    logger.info({ run: this.id, stage: this.stage, status, in: this.inCount, out: this.outCount, perMin: this.perMinute() }, 'run finished');
  }

  perMinute(): number {
    const mins = Math.max((Date.now() - this.started) / 60000, 1 / 60);
    return Math.round(this.inCount / mins);
  }
}

/** Convenience wrapper: start a run, execute, finish with ok/failed. */
export async function withRun<T>(stage: string, meta: Record<string, unknown>, fn: (run: Run) => Promise<T>): Promise<T> {
  const run = await Run.start(stage, meta);
  try {
    const out = await fn(run);
    await run.finish('ok');
    return out;
  } catch (err) {
    await run.finish('failed', (err as Error).stack ?? String(err));
    throw err;
  }
}
