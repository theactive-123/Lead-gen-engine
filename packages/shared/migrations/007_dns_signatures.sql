-- DNS rules derived from measured data (Phase 3 benchmark, 2026-11-24): 62,800 fetched homepages,
-- platform from page fingerprints compared with each site's DNS records. Only rules with
-- >= 99.5% precision and >= 100 sites are enabled. Nameservers were too weak (24-93%) and are not used.
INSERT INTO platform_signatures (kind, name, record, pattern, evidence) VALUES
  ('platform', 'Squarespace', 'www_cname', '^ext-(sq|cust)\.squarespace\.com$', '{"sites": 7786, "precision_pct": 99.8, "measured": "2026-11-24"}'),
  ('platform', 'Squarespace', 'a',         '^198\.(185\.159|49\.23)\.14[45]$',  '{"sites": 7858, "precision_pct": 99.8, "measured": "2026-11-24"}'),
  ('platform', 'Shopify',     'www_cname', '^shops\.myshopify\.com$',            '{"sites": 4930, "precision_pct": 99.8, "measured": "2026-11-24"}'),
  ('platform', 'Shopify',     'a',         '^23\.227\.38\.\d{1,3}$',             '{"sites": 7009, "precision_pct": 99.9, "measured": "2026-11-24", "note": "Shopify IP range; every observed address 99.9-100%"}'),
  ('platform', 'Wix',         'www_cname', '^(cdn\d+|pointing)\.wixdns\.net$',   '{"sites": 2804, "precision_pct": 99.9, "measured": "2026-11-24"}'),
  ('platform', 'Wix',         'a',         '^185\.230\.63\.(107|171|186)$',      '{"sites": 2840, "precision_pct": 99.9, "measured": "2026-11-24"}'),
  ('platform', 'Webflow',     'www_cname', '^(cdn|proxy-ssl)\.webflow\.com$',   '{"sites": 517, "precision_pct": 99.8, "measured": "2026-11-24"}'),
  ('platform', 'Webflow',     'a',         '^198\.202\.211\.1$',                 '{"sites": 464, "precision_pct": 100, "measured": "2026-11-24"}'),
  ('platform', 'Framer Sites','www_cname', '^sites\.framer\.app$',               '{"sites": 113, "precision_pct": 100, "measured": "2026-11-24"}'),
  ('platform', 'GoDaddy Website Builder', 'a', '^76\.223\.105\.230$',            '{"sites": 272, "precision_pct": 100, "measured": "2026-11-24"}'),
  ('platform', 'Weebly',      'a',         '^199\.34\.228\.(164|191)$',          '{"sites": 493, "precision_pct": 100, "measured": "2026-11-24"}');

-- Mail providers: the MX host names belong to these companies (top 10 suffixes in 875,604 domains).
INSERT INTO platform_signatures (kind, name, record, pattern, evidence) VALUES
  ('mx_provider', 'Google Workspace',      'mx', '(^|\.)(google\.com|googlemail\.com)$', '{"domains": 231623, "measured": "2026-11-24"}'),
  ('mx_provider', 'Microsoft 365',         'mx', '\.mail\.protection\.outlook\.com$',    '{"domains": 138798, "measured": "2026-11-24"}'),
  ('mx_provider', 'Hostinger',             'mx', '(^|\.)hostinger\.[a-z.]+$',            '{"domains": 32388, "measured": "2026-11-24"}'),
  ('mx_provider', 'OpenSRS / Tucows',      'mx', '(^|\.)hostedemail\.com$',              '{"domains": 22830, "measured": "2026-11-24"}'),
  ('mx_provider', 'GoDaddy',               'mx', '(^|\.)secureserver\.net$',             '{"domains": 17252, "measured": "2026-11-24"}'),
  ('mx_provider', 'Proofpoint Essentials', 'mx', '(^|\.)ppe-hosted\.com$',               '{"domains": 14351, "measured": "2026-11-24", "note": "email security filter; usually in front of Microsoft 365"}'),
  ('mx_provider', 'SiteGround',            'mx', '(^|\.)mailspamprotection\.com$',       '{"domains": 13613, "measured": "2026-11-24"}'),
  ('mx_provider', 'Zoho Mail',             'mx', '(^|\.)zoho\.[a-z.]+$',                 '{"domains": 11906, "measured": "2026-11-24"}'),
  ('mx_provider', 'Titan',                 'mx', '(^|\.)titan\.email$',                  '{"domains": 6911, "measured": "2026-11-24"}'),
  ('mx_provider', 'IONOS',                 'mx', '(^|\.)ionos\.[a-z.]+$',                '{"domains": 5935, "measured": "2026-11-24"}');
