-- Phase 1: foundation tables. Later phases add their own numbered migration files.

-- One row per execution of a stage or source (feeds the funnel + throughput views).
CREATE TABLE runs (
  id           bigserial PRIMARY KEY,
  stage        text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  in_count     bigint      NOT NULL DEFAULT 0,
  out_count    bigint      NOT NULL DEFAULT 0,
  error_count  bigint      NOT NULL DEFAULT 0,
  dropped      jsonb       NOT NULL DEFAULT '{}',   -- {"no_dns": 120, "parked": 14}
  per_minute   integer     NOT NULL DEFAULT 0,      -- records/minute throughput
  meta         jsonb       NOT NULL DEFAULT '{}',
  error        text
);
CREATE INDEX runs_stage_started_idx ON runs (stage, started_at DESC);
CREATE INDEX runs_started_idx ON runs (started_at DESC);

-- Resume points for sources and stages ("where did we get to").
CREATE TABLE checkpoints (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Editable settings (concurrency, rate limits...). The dashboard writes here, not to code.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, description) VALUES
  ('http.global_concurrency', '200', 'Max simultaneous outbound HTTP requests across all sites'),
  ('http.per_host_rps',       '1',   'Max requests per second to any single website'),
  ('http.timeout_ms',         '10000', 'Request timeout in milliseconds'),
  ('dns.concurrency',         '500', 'Max simultaneous DNS lookups'),
  ('lighthouse.parallel',     '2',   'Number of Chrome instances for Lighthouse audits'),
  ('batch.size',              '2000', 'Records processed per batch job');

-- Periodic system measurements (disk usage, lake size) for the disk monitor.
CREATE TABLE system_metrics (
  id          bigserial PRIMARY KEY,
  measured_at timestamptz NOT NULL DEFAULT now(),
  metric      text        NOT NULL,
  value       jsonb       NOT NULL
);
CREATE INDEX system_metrics_metric_idx ON system_metrics (metric, measured_at DESC);

-- Core domain record. Only records that pass the cheap stages are kept here;
-- the millions of raw candidates live in Parquet (data/lake/candidates).
CREATE TABLE domains (
  id            bigserial PRIMARY KEY,
  domain        text        NOT NULL UNIQUE,
  first_seen    date        NOT NULL DEFAULT current_date,
  sources       text[]      NOT NULL DEFAULT '{}',
  stage_status  text        NOT NULL DEFAULT 'new',
  drop_reason   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domains_stage_idx ON domains (stage_status);
CREATE INDEX domains_first_seen_idx ON domains (first_seen DESC);
