-- Phase 2: volume sources.

-- One row per source plugin. Enable/disable and per-source options from the dashboard.
CREATE TABLE sources (
  key        text PRIMARY KEY,
  label      text    NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  schedule   text    NOT NULL,              -- cron (UTC)
  options    jsonb   NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sources (key, label, schedule, options) VALUES
  ('tranco',      'Tranco top 1M list',                    '17 3 * * *',  '{}'),
  ('whoisds',     'WhoisDS newly registered domains',      '41 */6 * * *', '{}'),
  ('ct',          'Certificate Transparency logs',         '*/10 * * * *',
     '{"max_entries_per_log_per_run": 200000, "start_back_entries": 50000,
       "logs": ["mon.sycamore.ct.letsencrypt.org", "mon.willow.ct.letsencrypt.org", "parcelyard", "plumbersarms",
                "ct.cloudflare.com/logs/nimbus", "sectigo.com", "digicert.com"]}'),
  ('commoncrawl', 'Common Crawl URL index',                '23 4 * * *',  '{"parallel_files": 4}');

-- URL path patterns that mark a Common Crawl domain as interesting (regex on the URL path).
-- A domain is kept when at least one enabled pattern matches one of its pages.
CREATE TABLE source_url_signals (
  id        serial PRIMARY KEY,
  category  text    NOT NULL,     -- ecommerce | wellness | agency | ...
  pattern   text    NOT NULL,     -- regular expression on url_path
  enabled   boolean NOT NULL DEFAULT true,
  note      text
);

INSERT INTO source_url_signals (category, pattern, note) VALUES
  ('ecommerce', '^/products/[^/]+',            'Shopify-style product pages'),
  ('ecommerce', '^/collections/[^/]+',         'Shopify-style collections'),
  ('ecommerce', '^/product/[^/]+',             'WooCommerce product pages'),
  ('ecommerce', '^/product-category/',         'WooCommerce categories'),
  ('ecommerce', '^/shop(/|$)',                 'Shop section'),
  ('ecommerce', '^/cart/?$',                   'Cart page'),
  ('wellness',  '^/(book|booking|book-now|book-online)(/|$)', 'Booking pages'),
  ('wellness',  '^/(schedule|class-schedule|timetable|classes)(/|$)', 'Class schedules'),
  ('wellness',  '^/(memberships?|pricing-memberships)(/|$)', 'Memberships'),
  ('agency',    '^/(white-label|whitelabel|white-label-[a-z-]+)(/|$)', 'White-label pages'),
  ('agency',    '^/(partners|partner-program|reseller|resellers)(/|$)', 'Partner / reseller programs'),
  ('agency',    '^/(case-studies|our-work|portfolio)(/|$)', 'Agency portfolio pages'),
  ('agency',    '^/services/(web-design|website-design|seo|ppc|social-media|branding|digital-marketing)', 'Agency service pages');
