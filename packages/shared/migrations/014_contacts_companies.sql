-- Phase 6: contacts and business signals for in-scope leads.
CREATE TABLE contacts (
  domain_id        bigint PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  email            text,
  email_type       text CHECK (email_type IN ('named', 'role', 'freemail')),
  email_confidence numeric,
  email_source_url text,
  mx_ok            boolean,
  all_emails       jsonb NOT NULL DEFAULT '[]',   -- [{email, type, confidence, source, via}]
  phone            text,                          -- E.164
  phone_source     text,
  owner_name       text,
  owner_title      text,
  owner_source     text,
  address          jsonb,                         -- {street, city, region, postal, country, source}
  socials          jsonb NOT NULL DEFAULT '{}',   -- {facebook: url, instagram: url, ...}
  completeness     numeric NOT NULL DEFAULT 0,    -- share of email / phone / owner / address found (0..1)
  extracted_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_email_type_idx ON contacts (email_type);
CREATE INDEX contacts_completeness_idx ON contacts (completeness);

CREATE TABLE companies (
  domain_id      bigint PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  name           text,
  country        text,       -- ISO 3166-1 alpha-2
  country_source text,       -- address | store | phone | tld
  region         text,
  city           text,
  address        text,
  platform       text,
  size_signals   jsonb NOT NULL DEFAULT '{}',
  freshness      jsonb NOT NULL DEFAULT '{}',
  marketing      jsonb NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_country_idx ON companies (country);

INSERT INTO settings (key, value, description) VALUES
  ('stage.contacts.batch_size', '100', 'Leads per contact-extraction job'),
  ('stage.contacts.snapshot_size', '2000', 'Leads planned at once for contact extraction'),
  ('contacts.max_pages', '5', 'Extra pages fetched per lead for contacts (contact, about, team, privacy, terms...)'),
  ('stage.signals.batch_size', '500', 'Leads per business-signal job'),
  ('stage.signals.snapshot_size', '5000', 'Leads planned at once for business signals'),
  ('rdap.per_registry_rps', '4', 'Requests per second to one domain registry (RDAP, for domain age)')
ON CONFLICT (key) DO NOTHING;
