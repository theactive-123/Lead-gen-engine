-- Phase 4: technologies per domain and store profiles.
CREATE TABLE technologies (
  domain_id   bigint  NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  tech        text    NOT NULL,
  categories  text[]  NOT NULL DEFAULT '{}',
  version     text,
  confidence  integer NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain_id, tech)
);
CREATE INDEX technologies_tech_idx ON technologies (tech);
CREATE INDEX technologies_categories_idx ON technologies USING gin (categories);

CREATE TABLE store_profiles (
  domain_id           bigint PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  platform            text   NOT NULL,
  product_count       integer,          -- exact when the store reports it, else counted (see count_method)
  count_method        text,             -- 'reported' | 'counted' | 'at_least'
  price_min           numeric,
  price_max           numeric,
  price_median        numeric,
  currency            text,
  last_product_update timestamptz,
  newest_product_at   timestamptz,
  vendors             text[] NOT NULL DEFAULT '{}',
  product_types       text[] NOT NULL DEFAULT '{}',
  sample_titles       text[] NOT NULL DEFAULT '{}',
  collections_count   integer,
  theme               text,
  extra               jsonb  NOT NULL DEFAULT '{}',
  probed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_profiles_platform_idx ON store_profiles (platform);
CREATE INDEX store_profiles_count_idx ON store_profiles (product_count);

INSERT INTO settings (key, value, description) VALUES
  ('stage.tech.batch_size', '200', 'Pages per technology-detection job'),
  ('tech.threads', '3', 'CPU threads used for technology detection inside one worker (0 = no threads)'),
  ('stage.tech.snapshot_size', '4000', 'Pages planned at once for technology detection'),
  ('stage.fetch.max_tech_backlog', '20000', 'Pause homepage fetching while this many fetched pages still wait for technology detection (HTML is only kept a few days)')
ON CONFLICT (key) DO NOTHING;
