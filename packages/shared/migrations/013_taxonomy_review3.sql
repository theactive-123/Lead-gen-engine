-- Phase 5 review 3 (out-of-scope sample, 2026-11-24): graphic design firms and embroidery shops were missed. Idempotent.
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, t, 'positive' FROM sub_niches, unnest(ARRAY['graphic design', 'branding services']) t
  WHERE key = 'branding_studio' ON CONFLICT DO NOTHING;
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, t, 'positive' FROM sub_niches, unnest(ARRAY['embroidery', 'custom embroidery']) t
  WHERE key = 'print_sign' ON CONFLICT DO NOTHING;
