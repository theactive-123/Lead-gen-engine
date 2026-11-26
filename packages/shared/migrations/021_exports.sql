-- Phase 10: export history and which leads were already exported per brand ("new since last export").
CREATE TABLE IF NOT EXISTS exports (
  id serial PRIMARY KEY,
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  segment_id int REFERENCES segments(id) ON DELETE SET NULL,
  segment_name text,                         -- kept even if the segment is deleted later
  tiers text[] NOT NULL DEFAULT '{A,B}',
  format text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  mode text NOT NULL DEFAULT 'new' CHECK (mode IN ('new', 'all')),   -- new = never exported for this brand
  require_email boolean NOT NULL DEFAULT true,
  sheets text NOT NULL DEFAULT 'niche' CHECK (sheets IN ('niche', 'none')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  candidates int,                            -- leads matching before the do-not-contact check
  suppressed int,                            -- removed by the do-not-contact list
  row_count int,
  file_name text,
  file_bytes bigint,
  error text,
  requested_by text NOT NULL DEFAULT 'dashboard',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS exports_created ON exports (created_at DESC);

CREATE TABLE IF NOT EXISTS exported_leads (
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  domain_id bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  first_export_id int REFERENCES exports(id) ON DELETE SET NULL,
  last_export_id int REFERENCES exports(id) ON DELETE SET NULL,
  first_exported_at timestamptz NOT NULL DEFAULT now(),
  last_exported_at timestamptz NOT NULL DEFAULT now(),
  times int NOT NULL DEFAULT 1,
  PRIMARY KEY (brand_id, domain_id)
);

INSERT INTO settings (key, value, description) VALUES
  ('exports.key_tech_categories', '["Ecommerce", "CMS", "Page builders", "Marketing automation", "Email", "Analytics", "Advertising", "Reviews", "Appointment scheduling", "Live chat"]',
   'Technology categories listed in the "key technologies" column'),
  ('exports.keep_days', '30', 'Export files older than this are deleted from disk (the history row stays)'),
  ('exports.max_rows', '500000', 'Safety limit: an export never has more rows than this'),
  ('exports.daily', '[]',
   'Exports made automatically every day at 05:13 UTC, e.g. [{"brand": "brand_1", "segment": null, "tiers": ["A","B"], "format": "xlsx"}] (always "new since last export")')
ON CONFLICT (key) DO NOTHING;
