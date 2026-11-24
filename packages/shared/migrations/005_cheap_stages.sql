-- Phase 3: normalise, DNS, homepage fetch.

INSERT INTO settings (key, value, description) VALUES
  ('dns.mode',            '"udp"', 'udp = normal DNS (fastest, default) | doh = DNS over HTTPS (use where UDP DNS is blocked)'),
  ('dns.servers',         '["1.1.1.1", "8.8.8.8", "9.9.9.9"]', 'Public DNS resolvers used in udp mode'),
  ('dns.doh_endpoints',   '["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"]', 'DNS-over-HTTPS JSON endpoints used in doh mode'),
  ('dns.timeout_ms',      '4000', 'Timeout for one DNS question'),
  ('fetch.max_body_bytes','2000000', 'Largest homepage we download (bytes); bigger pages are cut'),
  ('fetch.max_redirects', '3', 'Redirects followed for the homepage'),
  ('html.retention_days', '7', 'Days we keep compressed homepage HTML for re-processing'),
  ('stage.dns.batch_size',      '2000', 'Domains per DNS job'),
  ('stage.dns.snapshot_size',   '20000', 'Domains planned at once for DNS'),
  ('stage.fetch.batch_size',    '400', 'Domains per homepage-fetch job'),
  ('stage.fetch.snapshot_size', '4000', 'Domains planned at once for homepage fetch'),
  ('normalize.rules', '{
     "base_priority": {"commoncrawl": 40, "ct": 10, "whoisds": 5, "tranco": 0},
     "cc_signal_bonus": 30,
     "cc_english_bonus": 20,
     "preferred_tlds": ["com", "us", "ca", "uk", "au", "nz", "ie", "co", "io", "shop", "store"],
     "preferred_tld_bonus": 15,
     "blocked_tlds": [],
     "tranco_top_rank": 5000,
     "tranco_top_penalty": -100,
     "junk_max_label_length": 40,
     "junk_max_digit_ratio": 0.5,
     "junk_max_hyphens": 4
   }', 'Stage 1: priority score per domain (higher = processed first) and junk filters')
ON CONFLICT (key) DO NOTHING;

-- DNS-based detection rules (platform, mail provider, parking). Seeded from measured data in Phase 3.
CREATE TABLE platform_signatures (
  id        serial PRIMARY KEY,
  kind      text    NOT NULL CHECK (kind IN ('platform', 'mx_provider', 'parking')),
  name      text    NOT NULL,             -- e.g. Shopify, Google Workspace, Sedo
  record    text    NOT NULL CHECK (record IN ('a', 'www_cname', 'mx', 'ns')),
  pattern   text    NOT NULL,             -- regular expression on the record value
  enabled   boolean NOT NULL DEFAULT true,
  evidence  jsonb   NOT NULL DEFAULT '{}', -- how it was verified (counts, sample domains)
  UNIQUE (kind, name, record, pattern)
);

-- Homepage tags (parked, coming soon, default server page...). Regex on title / text / final URL.
CREATE TABLE page_tag_rules (
  id       serial PRIMARY KEY,
  tag      text    NOT NULL,
  field    text    NOT NULL CHECK (field IN ('title', 'text', 'url', 'any')),
  pattern  text    NOT NULL,
  drops    boolean NOT NULL DEFAULT true,  -- true = the domain leaves the funnel
  enabled  boolean NOT NULL DEFAULT true,
  note     text
);

INSERT INTO page_tag_rules (tag, field, pattern, note) VALUES
  ('parked',       'any',  '(?i)\b(this domain|the domain [a-z0-9.-]+) (is|may be) for sale\b', 'Domain sale pages'),
  ('parked',       'any',  '(?i)\bbuy this domain\b', 'Domain sale pages'),
  ('parked',       'any',  '(?i)\b(domain|website) parked\b|\bparked (free|domain)\b', 'Parking pages'),
  ('parked',       'url',  '(?i)^https?://[^/]*(sedo\.com|afternic\.com|dan\.com|hugedomains\.com|parkingcrew\.net|bodis\.com|undeveloped\.com|atom\.com)/', 'Redirect to a domain marketplace'),
  ('coming_soon',  'any',  '(?i)\b(coming soon|launching soon|under construction|opening soon|site is under maintenance)\b', 'Not live yet'),
  ('default_page', 'any',  '(?i)\b(welcome to nginx|apache2? (ubuntu |debian )?default page|it works!|default web site page|iis windows server)\b', 'Server default page'),
  ('default_page', 'title','(?i)^index of /', 'Directory listing'),
  ('default_page', 'any',  '(?i)\bfuture home of something quite cool\b', 'Registrar placeholder'),
  ('store_closed', 'any',  '(?i)\bthis store (is unavailable|does not exist)\b', 'Closed online store'),
  ('spam_suspect', 'any',  '(?i)\b(slot gacor|togel|judi online|situs slot|bandar bola)\b', 'Hacked / gambling spam');

-- The lead database: domains that passed the cheap stages (live homepage, not parked).
ALTER TABLE domains
  ADD COLUMN priority     integer,
  ADD COLUMN platform     text,
  ADD COLUMN has_mx       boolean,
  ADD COLUMN mx_provider  text,
  ADD COLUMN final_url    text,
  ADD COLUMN http_status  integer,
  ADD COLUMN title        text,
  ADD COLUMN lang         text,
  ADD COLUMN tags         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN fetched_at   timestamptz;
CREATE INDEX domains_platform_idx ON domains (platform);
CREATE INDEX domains_priority_idx ON domains (priority DESC);
