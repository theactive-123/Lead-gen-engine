-- Phase 11: re-check schedule, forgetting deleted leads, compaction, daily report.
INSERT INTO settings (key, value, description) VALUES
  ('recheck.in_niche_days', '30', 'In-niche websites are fetched again (and every later stage redone) after this many days'),
  ('recheck.retry_days', '[7, 21, 45]', 'Domains with no working DNS or no usable homepage are tried again this many days after the first attempt, then given up'),
  ('recheck.final_statuses', '["robots_disallowed", "offsite_redirect"]', 'Homepage results that are never retried (the site said no, or it moved to another domain)'),
  ('lake.compact_min_files', '4', 'A day folder of the data lake with at least this many files is merged into one file (daily, days before today)')
ON CONFLICT (key) DO NOTHING;

-- "Delete and suppress": also remove the domain from the data lake (raw data), not only from the lead database.
ALTER TABLE suppression ADD COLUMN IF NOT EXISTS forget boolean NOT NULL DEFAULT false;
ALTER TABLE suppression ADD COLUMN IF NOT EXISTS purged_at timestamptz;
UPDATE suppression SET forget = true WHERE kind = 'domain' AND reason = 'deleted from the dashboard';

INSERT INTO settings (key, value, description) VALUES
  ('sources.breaker_failures', '3', 'A source that fails this many runs in a row pauses (30 min, doubling to at most 24 h)')
ON CONFLICT (key) DO NOTHING;
