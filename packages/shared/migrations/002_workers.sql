-- Live worker processes. Each worker updates last_beat every 30s.
-- Runs owned by a worker that stopped beating are marked failed by the reaper.
CREATE TABLE workers (
  id         text PRIMARY KEY,          -- hostname:pid
  started_at timestamptz NOT NULL DEFAULT now(),
  last_beat  timestamptz NOT NULL DEFAULT now(),
  info       jsonb       NOT NULL DEFAULT '{}'
);
ALTER TABLE runs ADD COLUMN worker_id text;
CREATE INDEX runs_running_idx ON runs (worker_id) WHERE status = 'running';
