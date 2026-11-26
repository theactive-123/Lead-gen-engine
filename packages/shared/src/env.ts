import { z } from 'zod';

/**
 * All runtime settings come from environment variables (see .env.example).
 * Business logic (niches, brands, scoring) lives in the database, not here.
 */
const schema = z.object({
  DATABASE_URL: z.string().default('postgres://lead:lead@localhost:5432/lead'),
  LAKE_DIR: z.string().default('./data/lake'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CRAWLER_CONTACT_EMAIL: z.string().default('crawler-contact@example.invalid'),
  CRAWLER_NAME: z.string().default('LeadEngineBot'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  DUCKDB_MEMORY_LIMIT: z.string().default('2GB'),
  DUCKDB_THREADS: z.coerce.number().int().positive().default(4),
  /** Most disk DuckDB may use to spill big queries (fails the query instead of filling the disk). */
  DUCKDB_MAX_TEMP: z.string().default('4GB'),
  CHROME_PATH: z.string().optional(), // Chrome/Chromium binary for Lighthouse (the worker image sets it)
  /** Where export files (CSV / Excel) are written; default: next to the data lake (data/exports). */
  EXPORT_DIR: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

/** User-Agent sent with every outbound request: identifies us and gives site owners a contact. */
export function userAgent(): string {
  const e = env();
  return `${e.CRAWLER_NAME}/0.1 (+mailto:${e.CRAWLER_CONTACT_EMAIL})`;
}
