/**
 * Source plugin contract. A source streams batches of domain candidates.
 * Each batch carries the cursor to save AFTER the batch is stored, so a restart
 * resumes exactly after the last stored batch (no lost or duplicated work).
 */
export interface Candidate {
  domain: string;           // registrable domain (Public Suffix List)
  hint?: Record<string, unknown>; // optional source-specific data (rank, signals, names...)
}

export interface SourceBatch<C> {
  partKey: string;          // stable id of this batch -> stable file name (idempotent rewrite)
  candidates: Candidate[];
  cursor: C;                // where to resume after this batch
  rawCount: number;         // records read from the source before filtering
  dropped?: Record<string, number>;
}

export interface SourceHealth {
  ok: boolean;
  detail: string;
}

export interface SourceContext {
  options: Record<string, any>;
  signal: AbortSignal;
}

export interface Source<C = unknown> {
  key: string;
  label: string;
  run(cursor: C | undefined, ctx: SourceContext): AsyncIterable<SourceBatch<C>>;
  health(): Promise<SourceHealth>;
}
