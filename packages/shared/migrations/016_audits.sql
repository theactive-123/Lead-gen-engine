-- Phase 7: website audits (light audit for every in-niche lead, Lighthouse for the top tier).
CREATE TABLE audits (
  domain_id     bigint PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  light_audit   jsonb,          -- {summary: {high, medium, low, info}, checks: {name: ran|skipped reason}, metrics: {...}}
  lighthouse    jsonb,          -- {performance, accessibility, best_practices, seo, lcp_ms, cls, tbt_ms, ...}
  audited_at    timestamptz,    -- light audit time
  lighthouse_at timestamptz
);

CREATE TABLE audit_findings (
  domain_id bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  code      text   NOT NULL,      -- stable id used by brand problem maps, e.g. no_email_capture
  severity  text   NOT NULL CHECK (severity IN ('high', 'medium', 'low', 'info')),
  message   text   NOT NULL,      -- plain-English sentence
  evidence  jsonb  NOT NULL DEFAULT '{}',  -- the measured value / URL that proves the finding
  source    text   NOT NULL CHECK (source IN ('light', 'lighthouse')),
  PRIMARY KEY (domain_id, code)
);
CREATE INDEX audit_findings_code_idx ON audit_findings (code);
CREATE INDEX audit_findings_severity_idx ON audit_findings (severity);

INSERT INTO settings (key, value, description) VALUES
  ('stage.audit.batch_size', '100', 'Leads per light-audit job'),
  ('stage.audit.snapshot_size', '2000', 'Leads planned per light-audit snapshot'),
  ('audit.rules', '{
    "ttfb_ms": {"medium": 800, "high": 1800},
    "html_kb_max": 500,
    "max_external_scripts": 40,
    "max_render_blocking": 3,
    "legacy_images_min": 5,
    "legacy_images_share": 0.8,
    "auto_format_image_hosts": ["/cdn/shop/", "cdn.shopify.com", "images.squarespace-cdn.com", "static.wixstatic.com"],
    "images_missing_alt_min": 5,
    "jquery_min_version": "3.5.0",
    "wordpress_min_version": "6.0",
    "copyright_stale_years": 2,
    "broken_link_sample": 3,
    "check_favicon": true,
    "check_http_redirect": true,
    "check_contact_page": true,
    "analytics_categories": ["Analytics", "Tag managers"],
    "email_capture_categories": ["Marketing automation", "Email"],
    "review_categories": ["Reviews"],
    "booking_categories": ["Appointment scheduling", "Ticket booking"],
    "form_categories": ["Form builders", "Surveys"],
    "booking_path_pattern": "/(book|booking|book-now|schedule|class-schedule|classes|timetable|reserve|appointments?)(/|$|\\.)",
    "store_gates": ["store"],
    "booking_gates": ["booking"],
    "contact_form_skip_platforms": ["Weebly"],
    "email_input_skip_platforms": ["Weebly"],
    "analytics_builtin_platforms": ["Shopify", "Wix", "Squarespace"],
    "product_path_pattern": "^/(products|product)/[^/?#]+/?$",
    "builder_platforms": {"Wix": "wix_site", "Squarespace": "squarespace_site", "Weebly": "weebly_site", "GoDaddy Website Builder": "godaddy_builder_site"},
    "severity": {
      "missing_title": "high", "no_viewport": "high", "slow_server_high": "high", "mixed_content_active": "high",
      "slow_server": "medium", "missing_meta_description": "medium", "render_blocking_scripts": "medium", "legacy_image_formats": "medium",
      "outdated_jquery": "medium", "outdated_wordpress": "medium", "no_analytics": "medium", "no_email_capture": "medium", "no_email_marketing_tool": "medium",
      "no_reviews": "medium", "no_online_booking": "medium", "no_contact_form": "medium", "broken_links": "medium", "no_https_redirect": "medium",
      "missing_h1": "low", "heavy_html": "low", "too_many_scripts": "low", "images_missing_alt": "low", "mixed_content_passive": "low",
      "outdated_copyright": "low", "missing_favicon": "low",
      "wix_site": "info", "squarespace_site": "info", "weebly_site": "info", "godaddy_builder_site": "info"
    }
  }', 'Light audit thresholds, tool categories (from the fingerprint data) and severity per finding code. Image hosts verified 2026-11-25 to serve WebP/AVIF automatically.')
ON CONFLICT (key) DO NOTHING;
