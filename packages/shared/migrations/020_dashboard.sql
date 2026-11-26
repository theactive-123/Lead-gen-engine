-- Phase 9: numbers the dashboard reads without touching the data lake.
-- One row per first-seen day and source (plus source 'all' = each domain counted once).
CREATE TABLE IF NOT EXISTS funnel_daily (
  day date NOT NULL,
  source text NOT NULL,
  candidates int NOT NULL DEFAULT 0,   -- new domains in the registry
  kept int NOT NULL DEFAULT 0,         -- not dropped by the junk rules
  dns_checked int NOT NULL DEFAULT 0,
  resolved int NOT NULL DEFAULT 0,     -- DNS passed (resolves, not parked)
  fetched int NOT NULL DEFAULT 0,      -- homepage fetched and usable
  in_niche int NOT NULL DEFAULT 0,
  with_contact int NOT NULL DEFAULT 0, -- in niche + email found
  qualified int NOT NULL DEFAULT 0,    -- tier A or B for at least one brand
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, source)
);

INSERT INTO settings (key, value, description) VALUES
  ('funnel.days', '45', 'How many days back the dashboard funnel is recounted every hour'),
  ('dashboard.page_size', '50', 'Rows per page in the lead explorer')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS runs_stage_started ON runs (stage, started_at DESC);
CREATE INDEX IF NOT EXISTS domains_first_seen_sources ON domains (first_seen);
