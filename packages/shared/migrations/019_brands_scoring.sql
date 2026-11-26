-- Phase 8: brands, matching, segments, first lines, suppression.
-- Everything here is editable data (dashboard in Phase 9); the 5 brands are placeholders until real profiles arrive.

CREATE TABLE IF NOT EXISTS brands (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  website text,
  description text,
  services text[] NOT NULL DEFAULT '{}',
  price_min numeric, price_max numeric, currency text DEFAULT 'USD',
  -- Fit: platform weight 0-1 per platform name; others get platform_default, unknown platform gets platform_null.
  platform_weights jsonb NOT NULL DEFAULT '{}',
  platform_default numeric NOT NULL DEFAULT 1,
  platform_null numeric NOT NULL DEFAULT 0.5,
  target_countries text[] NOT NULL DEFAULT '{}',   -- empty = all countries
  excluded_countries text[] NOT NULL DEFAULT '{}', -- hard exclude (score 0)
  country_other numeric NOT NULL DEFAULT 0.3,      -- country known but not targeted
  country_unknown numeric NOT NULL DEFAULT 0.7,
  size jsonb NOT NULL DEFAULT '{}',                -- {"product_min": 20, "product_max": 2000}
  need_full_at numeric NOT NULL DEFAULT 1.5,       -- this much problem weight = full need (one strong problem = 2/3)
  need_floor numeric NOT NULL DEFAULT 0.15,        -- need when no mapped problem is found
  weights jsonb NOT NULL DEFAULT '{"fit": 1, "need": 1, "reach": 1, "fresh": 0.5}',  -- score = 100 x fit^w x need^w x reach^w x fresh^w
  tiers jsonb NOT NULL DEFAULT '{"A": 35, "B": 20}',  -- A ~ fit 0.8 x need 0.65 x reach 0.7 x fresh 0.95
  lead_with_niche boolean NOT NULL DEFAULT false,  -- first line about the lead's business before its site problems
  case_studies jsonb NOT NULL DEFAULT '[]',
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Niche targeting: sub_niche_id NULL = the whole niche; a sub-niche row overrides its niche row. weight 0 = excluded.
CREATE TABLE IF NOT EXISTS brand_niche_weights (
  id serial PRIMARY KEY,
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  niche_id int NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
  sub_niche_id int REFERENCES sub_niches(id) ON DELETE CASCADE,
  weight numeric NOT NULL CHECK (weight >= 0 AND weight <= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_niche_weights_uq ON brand_niche_weights (brand_id, niche_id, coalesce(sub_niche_id, 0));

-- Which findings this brand can fix, with the service it sells for it.
CREATE TABLE IF NOT EXISTS brand_problem_map (
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  finding_code text NOT NULL,
  service text NOT NULL,
  weight numeric NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (brand_id, finding_code)
);

-- First-line templates. brand_id NULL = shared by every brand (a brand row for the same code + variant wins).
-- finding_code is an audit finding code, or "niche:<sub_niche key>" for a line about the lead's line of business.
CREATE TABLE IF NOT EXISTS brand_templates (
  id serial PRIMARY KEY,
  brand_id int REFERENCES brands(id) ON DELETE CASCADE,
  niche_id int REFERENCES niches(id) ON DELETE CASCADE,  -- NULL = any niche
  finding_code text NOT NULL,
  variant int NOT NULL DEFAULT 1,
  template text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_templates_uq ON brand_templates (coalesce(brand_id, 0), coalesce(niche_id, 0), finding_code, variant);

CREATE TABLE IF NOT EXISTS brand_matches (
  domain_id bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  match_score numeric NOT NULL,
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'X')),  -- X = not a fit (score 0)
  breakdown jsonb NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain_id, brand_id)
);
CREATE INDEX IF NOT EXISTS brand_matches_brand_tier ON brand_matches (brand_id, tier, match_score DESC);

CREATE TABLE IF NOT EXISTS first_lines (
  domain_id bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  variant int NOT NULL,
  text text NOT NULL,
  finding_code text NOT NULL,
  template_id int REFERENCES brand_templates(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain_id, brand_id, variant)
);

CREATE TABLE IF NOT EXISTS segments (
  id serial PRIMARY KEY,
  brand_id int NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  filter jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  member_count int,
  refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, name)
);
CREATE TABLE IF NOT EXISTS segment_members (
  segment_id int NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  domain_id bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, domain_id)
);

-- Never contacted: checked when segments are refreshed and again before every export (Phase 10).
CREATE TABLE IF NOT EXISTS suppression (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  value text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

-- Indexes for the scoring read and dashboard filters.
CREATE INDEX IF NOT EXISTS technologies_tech ON technologies (tech);
CREATE INDEX IF NOT EXISTS audit_findings_code ON audit_findings (code);
CREATE INDEX IF NOT EXISTS companies_country ON companies (country);
CREATE INDEX IF NOT EXISTS companies_platform ON companies (platform);
CREATE INDEX IF NOT EXISTS classifications_niche ON classifications (niche_id, sub_niche_id);

INSERT INTO brands (key, name, description, services, platform_weights, platform_default, platform_null, target_countries, size, need_floor, lead_with_niche)
VALUES ('brand_1', 'Brand 1 (Shopify, placeholder)', 'Placeholder: Shopify store builds, speed, email and conversion work.', ARRAY['Shopify store build', 'Migration to Shopify', 'Speed optimisation', 'Klaviyo email setup', 'Reviews & conversion setup']::text[], '{"Shopify": 1, "WooCommerce": 0.6, "Wix": 0.6, "Squarespace": 0.6, "BigCommerce": 0.6, "Weebly": 0.5, "GoDaddy Website Builder": 0.5}'::jsonb, 0.15, 0.5,
  ARRAY['US', 'GB', 'CA', 'AU', 'NZ', 'IE']::text[], '{"product_min": 20, "product_max": 2000}'::jsonb, 0.15, false) ON CONFLICT (key) DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 1.0 FROM brands b, niches n WHERE b.key = 'brand_1' AND n.key = 'dtc' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.7 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_1' AND n.key = 'other' AND s.key = 'local_makers' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.6 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_1' AND n.key = 'other' AND s.key = 'wineries_breweries' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_email_marketing_tool', 'Klaviyo email setup', 1.0 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_email_capture', 'Email signup setup', 0.8 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_reviews', 'Reviews app setup', 0.7 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_performance_poor', 'Speed optimisation', 1.0 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_lcp_poor', 'Speed optimisation', 0.8 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_tbt_poor', 'App and script cleanup', 0.5 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'too_many_scripts', 'App and script cleanup', 0.4 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'render_blocking_scripts', 'Speed optimisation', 0.3 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'wix_site', 'Migration to Shopify', 0.8 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'squarespace_site', 'Migration to Shopify', 0.8 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'weebly_site', 'Migration to Shopify', 0.8 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'godaddy_builder_site', 'Migration to Shopify', 0.8 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_meta_description', 'Store SEO basics', 0.3 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_analytics', 'Analytics and pixel setup', 0.5 FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO brands (key, name, description, services, platform_weights, platform_default, platform_null, target_countries, size, need_floor, lead_with_niche)
VALUES ('brand_2', 'Brand 2 (Webflow, placeholder)', 'Placeholder: Webflow design and builds, migrations from website builders.', ARRAY['Webflow website build', 'Migration to Webflow', 'Website redesign', 'Webflow SEO setup']::text[], '{"Wix": 1, "Squarespace": 1, "Weebly": 1, "GoDaddy Website Builder": 1, "WordPress": 0.8, "Webflow": 0.6, "Framer Sites": 0.5, "Joomla": 0.8, "Drupal": 0.6}'::jsonb, 0.6, 0.6,
  ARRAY['US', 'GB', 'CA', 'AU', 'NZ', 'IE']::text[], '{}'::jsonb, 0.15, false) ON CONFLICT (key) DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.8 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_2' AND n.key = 'other' AND s.key = 'b2b_manufacturer' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.7 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_2' AND n.key = 'other' AND s.key = 'specialty_contractor' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.8 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_2' AND n.key = 'other' AND s.key = 'boutique_hospitality' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.7 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_2' AND n.key = 'other' AND s.key = 'course_creators' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.9 FROM brands b, niches n WHERE b.key = 'brand_2' AND n.key = 'wellness' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.5 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_2' AND n.key = 'white_label' AND s.key = 'branding_studio' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.7 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_2' AND n.key = 'white_label' AND s.key = 'business_coach' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.2 FROM brands b, niches n WHERE b.key = 'brand_2' AND n.key = 'dtc' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'wix_site', 'Migration to Webflow', 1.0 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'squarespace_site', 'Migration to Webflow', 1.0 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'weebly_site', 'Migration to Webflow', 1.0 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'godaddy_builder_site', 'Migration to Webflow', 1.0 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_viewport', 'Mobile-friendly rebuild', 1.0 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_copyright', 'Website redesign', 0.5 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_performance_poor', 'Fast Webflow rebuild', 0.8 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_jquery', 'Website rebuild', 0.4 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_title', 'Webflow SEO setup', 0.6 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_meta_description', 'Webflow SEO setup', 0.3 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_h1', 'Webflow SEO setup', 0.3 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_online_booking', 'Booking integration', 0.6 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_contact_form', 'Lead form setup', 0.5 FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO brands (key, name, description, services, platform_weights, platform_default, platform_null, target_countries, size, need_floor, lead_with_niche)
VALUES ('brand_3', 'Brand 3 (WordPress, placeholder)', 'Placeholder: WordPress and WooCommerce care, speed, security and development.', ARRAY['WordPress maintenance', 'Speed optimisation', 'Security fixes', 'WooCommerce development', 'Hosting migration']::text[], '{"WordPress": 1, "WooCommerce": 1}'::jsonb, 0.15, 0.5,
  ARRAY['US', 'GB', 'CA', 'AU', 'NZ', 'IE']::text[], '{}'::jsonb, 0.15, false) ON CONFLICT (key) DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_3' AND n.key = 'other' AND s.key = 'b2b_manufacturer' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.8 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_3' AND n.key = 'other' AND s.key = 'specialty_contractor' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.7 FROM brands b, niches n WHERE b.key = 'brand_3' AND n.key = 'wellness' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.5 FROM brands b, niches n WHERE b.key = 'brand_3' AND n.key = 'white_label' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.7 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_3' AND n.key = 'other' AND s.key = 'boutique_hospitality' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.6 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_3' AND n.key = 'other' AND s.key = 'wineries_breweries' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.6 FROM brands b, niches n WHERE b.key = 'brand_3' AND n.key = 'dtc' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_wordpress', 'WordPress update and maintenance', 1.0 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_jquery', 'WordPress maintenance', 0.7 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'slow_server_high', 'Hosting and speed', 1.0 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'slow_server', 'Hosting and speed', 0.7 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_performance_poor', 'Speed optimisation', 1.0 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_lcp_poor', 'Speed optimisation', 0.8 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'legacy_image_formats', 'Image optimisation', 0.6 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'render_blocking_scripts', 'Speed optimisation', 0.5 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'mixed_content_active', 'Security fixes', 1.0 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'mixed_content_passive', 'Security fixes', 0.5 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'broken_links', 'WordPress maintenance', 0.6 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'heavy_html', 'Speed optimisation', 0.3 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_contact_form', 'Lead form setup', 0.5 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_email_marketing_tool', 'WooCommerce email automation', 0.6 FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO brands (key, name, description, services, platform_weights, platform_default, platform_null, target_countries, size, need_floor, lead_with_niche)
VALUES ('brand_4', 'Brand 4 (white-label web development, placeholder)', 'Placeholder: white-label design and development for agencies and resellers.', ARRAY['White-label website development', 'White-label Shopify/WordPress/Webflow builds', 'Overflow development capacity']::text[], '{}'::jsonb, 1.0, 0.5,
  ARRAY['US', 'GB', 'CA', 'AU', 'NZ', 'IE']::text[], '{}'::jsonb, 0.5, true) ON CONFLICT (key) DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'web_agency' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'marketing_agency' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'seo_agency' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'ppc_social_agency' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.8 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'branding_studio' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.8 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'it_msp' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.7 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'print_sign' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.5 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_4' AND n.key = 'white_label' AND s.key = 'business_coach' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_performance_poor', 'Overflow development capacity', 0.6 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'no_viewport', 'Overflow development capacity', 0.8 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_copyright', 'Overflow development capacity', 0.5 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_jquery', 'Overflow development capacity', 0.4 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'slow_server', 'Overflow development capacity', 0.3 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'legacy_image_formats', 'Overflow development capacity', 0.3 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_meta_description', 'Overflow development capacity', 0.3 FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO brands (key, name, description, services, platform_weights, platform_default, platform_null, target_countries, size, need_floor, lead_with_niche)
VALUES ('brand_5', 'Brand 5 (design and branding, placeholder)', 'Placeholder: brand identity, packaging-led web design and visual refreshes.', ARRAY['Brand identity', 'Website visual redesign', 'Accessible design', 'Design system']::text[], '{}'::jsonb, 1.0, 0.5,
  ARRAY['US', 'GB', 'CA', 'AU', 'NZ', 'IE']::text[], '{}'::jsonb, 0.15, false) ON CONFLICT (key) DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.8 FROM brands b, niches n WHERE b.key = 'brand_5' AND n.key = 'dtc' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'dtc' AND s.key = 'clean_beauty' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'dtc' AND s.key = 'coffee_tea' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'dtc' AND s.key = 'specialty_food' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'dtc' AND s.key = 'home_fragrance' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 1.0 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'dtc' AND s.key = 'craft_beverages' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.8 FROM brands b, niches n WHERE b.key = 'brand_5' AND n.key = 'wellness' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.9 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'other' AND s.key = 'boutique_hospitality' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.9 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'other' AND s.key = 'wineries_breweries' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, sub_niche_id, weight)
  SELECT b.id, n.id, s.id, 0.8 FROM brands b, niches n JOIN sub_niches s ON s.niche_id = n.id
  WHERE b.key = 'brand_5' AND n.key = 'other' AND s.key = 'local_makers' ON CONFLICT DO NOTHING;
INSERT INTO brand_niche_weights (brand_id, niche_id, weight)
  SELECT b.id, n.id, 0.3 FROM brands b, niches n WHERE b.key = 'brand_5' AND n.key = 'white_label' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'outdated_copyright', 'Brand refresh', 0.6 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_favicon', 'Brand identity basics', 0.7 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_accessibility_poor', 'Accessible design', 0.6 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'lighthouse_cls_poor', 'Website visual redesign', 0.3 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'wix_site', 'Custom website design', 0.5 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'squarespace_site', 'Custom website design', 0.4 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'weebly_site', 'Custom website design', 0.6 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'godaddy_builder_site', 'Custom website design', 0.6 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'images_missing_alt', 'Accessible design', 0.2 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_problem_map (brand_id, finding_code, service, weight) SELECT id, 'missing_h1', 'Website visual redesign', 0.3 FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'lighthouse_performance_poor', 1, 'Ran {domain} through Google Lighthouse on mobile and the speed score came back {score}/100.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'lighthouse_performance_poor', 2, 'Your homepage scores {score}/100 for mobile speed in Google Lighthouse.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'lighthouse_lcp_poor', 1, 'On a phone, the main content of {domain} takes {lcp_s} seconds to appear; Google rates anything over 4 seconds as poor.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'lighthouse_tbt_poor', 1, 'On mobile, scripts on {domain} keep the page from responding to taps for {tbt_s} seconds while it loads.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'lighthouse_accessibility_poor', 1, '{domain} scores {score}/100 for accessibility in Google Lighthouse on mobile.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'lighthouse_cls_poor', 1, 'The layout on {domain} shifts while it loads on mobile (layout shift {cls}, Google calls over 0.25 poor).') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'slow_server_high', 1, 'When I loaded {domain}, the server took {ttfb_s} seconds just to start answering, before any images or scripts.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'slow_server', 1, 'When I loaded {domain}, the server took {ttfb_s} seconds to start answering, before any images or scripts.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_email_marketing_tool', 1, 'I couldn''t find an email marketing tool like Klaviyo or Mailchimp connected to the {domain} store.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_email_marketing_tool', 2, 'Looked through {domain} and didn''t see Klaviyo, Mailchimp or a similar email tool on the store.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_email_capture', 1, 'There''s no email signup on the {domain} homepage, so visitors who aren''t ready to buy leave without a way to follow up.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_reviews', 1, 'I opened a product page on {domain} and found no customer reviews or star ratings.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_online_booking', 1, 'I couldn''t find a way to book a class or session online on {domain}.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_contact_form', 1, 'I couldn''t find a contact form on {domain}.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_analytics', 1, 'I couldn''t find Google Analytics or any other analytics tool on {domain}.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'no_viewport', 1, '{domain} has no mobile viewport set, so phones show it as a shrunken desktop page.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'outdated_copyright', 1, 'The footer on {domain} still says © {year}.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'outdated_wordpress', 1, '{domain} still runs WordPress {version}, many releases behind the current version.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'outdated_jquery', 1, '{domain} loads jQuery {version}; versions before 3.5.0 have known security issues.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'mixed_content_active', 1, 'Some scripts or styles on {domain} load over plain http, so browsers block them on the secure page.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'broken_links', 1, 'The link to {broken_path} on {domain} leads to a page-not-found error.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'legacy_image_formats', 1, '{domain} serves its images as JPG and PNG rather than WebP or AVIF, which are usually smaller.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'missing_meta_description', 1, 'The {domain} homepage has no meta description, so Google writes its own snippet for search results.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'missing_title', 1, 'The {domain} homepage has no page title, so search results and browser tabs show the bare address.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'missing_favicon', 1, '{domain} has no favicon, so browser tabs and bookmarks show a blank icon.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES (NULL, 'too_many_scripts', 1, 'The {domain} homepage loads {scripts} separate script files before it''s ready.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_1'), 'wix_site', 1, 'Noticed {domain} runs on Wix and wanted to ask whether a move to Shopify has come up.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_1'), 'squarespace_site', 1, 'Noticed {domain} runs on Squarespace and wanted to ask whether a move to Shopify has come up.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_2'), 'wix_site', 1, 'Noticed {domain} is built on Wix and wanted to ask whether a move to Webflow has been on your list.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_2'), 'squarespace_site', 1, 'Noticed {domain} is built on Squarespace and wanted to ask whether a move to Webflow has been on your list.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_2'), 'weebly_site', 1, 'Noticed {domain} is still on Weebly and wanted to ask whether a rebuild has been on your list.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_2'), 'godaddy_builder_site', 1, 'Noticed {domain} is built with GoDaddy''s website builder and wanted to ask whether a rebuild has been on your list.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_5'), 'outdated_copyright', 1, 'The footer on {domain} still says © {year}, so I wondered whether a refresh of the site and brand is planned.') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_4'), 'niche:web_agency', 1, 'Saw that {domain} builds websites for clients; do you ever hand overflow development to a white-label team?') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_4'), 'niche:marketing_agency', 1, 'Saw that {domain} runs marketing for clients; when a client needs a new website, who builds it for you?') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_4'), 'niche:seo_agency', 1, 'Saw that {domain} does SEO for clients; when a client''s site needs rebuilding, who handles the development?') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_4'), 'niche:ppc_social_agency', 1, 'Saw that {domain} runs ads for clients; when a landing page or site needs building, who does that for you?') ON CONFLICT DO NOTHING;
INSERT INTO brand_templates (brand_id, finding_code, variant, template) VALUES ((SELECT id FROM brands WHERE key = 'brand_4'), 'niche:branding_studio', 1, 'Saw that {domain} does brand identity work; when a client needs the website built, who develops it for you?') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('scoring.reach', '{"email": {"named": 1, "role": 0.8, "freemail": 0.6}, "phone_only": 0.3, "nothing": 0.05, "completeness_share": 0.3}'::jsonb, 'Reachability: value per email type, phone only, or nothing; completeness_share of the score comes from completeness (phone, owner, address).') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('scoring.freshness', '{"active_days": 90, "active": 1, "copyright_current": 0.9, "new_domain_days": 365, "new_domain": 0.9, "unknown": 0.6, "stale_years": 3, "stale": 0.35}'::jsonb, 'Freshness: recent product (store), current copyright year, young domain, unknown, or stale (copyright years old).') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('scoring.severity', '{"high": 1, "medium": 0.8, "low": 0.5, "info": 1}'::jsonb, 'How much a matched problem counts by severity.') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('scoring.confidence_share', '0.4'::jsonb, 'Share of fit that depends on niche confidence (0 = ignore confidence).') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('scoring.size_outside', '0.5'::jsonb, 'Fit multiplier when the catalog size is outside the brand range.') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('scoring.size_unknown', '0.8'::jsonb, 'Fit multiplier when a store has no known product count.') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('first_lines.rules', '{"max_words": 25, "variants": 3, "banned": ["!", "i hope this finds you well", "hope you are well", "hope you''re well", "it''s not just", "isn’t just", "isn''t just", "game-changer", "game changer", "revolutionize", "revolutionise", "skyrocket", "supercharge", "unlock", "synergy", "guaranteed"]}'::jsonb, 'First lines: word limit, how many variants, and phrases that are never allowed.') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value, description) VALUES ('stage.score.batch_size', '2000'::jsonb, 'Leads scored per batch') ON CONFLICT (key) DO NOTHING;
INSERT INTO segments (brand_id, name, filter) SELECT id, 'Shopify DTC, US, 50-500 products, Meta Pixel, no Klaviyo, Lighthouse < 50', '{"niches": ["dtc"], "platforms": ["Shopify"], "countries": ["US"], "product_count_min": 50, "product_count_max": 500, "tech_has": ["Facebook Pixel"], "tech_not": ["Klaviyo"], "lighthouse_perf_max": 49}'::jsonb FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO segments (brand_id, name, filter) SELECT id, 'Shopify stores without an email tool, English-speaking, tier A/B', '{"platforms": ["Shopify"], "countries": ["US", "GB", "CA", "AU", "NZ", "IE"], "findings_has": ["no_email_marketing_tool"], "tiers": ["A", "B"]}'::jsonb FROM brands WHERE key = 'brand_1' ON CONFLICT DO NOTHING;
INSERT INTO segments (brand_id, name, filter) SELECT id, 'Website-builder sites (Wix, Squarespace, Weebly, GoDaddy), tier A/B', '{"platforms": ["Wix", "Squarespace", "Weebly", "GoDaddy Website Builder"], "tiers": ["A", "B"]}'::jsonb FROM brands WHERE key = 'brand_2' ON CONFLICT DO NOTHING;
INSERT INTO segments (brand_id, name, filter) SELECT id, 'WordPress / WooCommerce with security or speed problems, tier A/B', '{"platforms": ["WordPress", "WooCommerce"], "findings_any": ["outdated_wordpress", "outdated_jquery", "mixed_content_active", "slow_server_high", "lighthouse_performance_poor"], "tiers": ["A", "B"]}'::jsonb FROM brands WHERE key = 'brand_3' ON CONFLICT DO NOTHING;
INSERT INTO segments (brand_id, name, filter) SELECT id, 'Web, marketing, SEO and ads agencies, tier A/B', '{"sub_niches": ["web_agency", "marketing_agency", "seo_agency", "ppc_social_agency"], "tiers": ["A", "B"]}'::jsonb FROM brands WHERE key = 'brand_4' ON CONFLICT DO NOTHING;
INSERT INTO segments (brand_id, name, filter) SELECT id, 'Food, drink, beauty and fragrance brands, tier A/B', '{"sub_niches": ["clean_beauty", "coffee_tea", "specialty_food", "craft_beverages", "home_fragrance"], "tiers": ["A", "B"]}'::jsonb FROM brands WHERE key = 'brand_5' ON CONFLICT DO NOTHING;
