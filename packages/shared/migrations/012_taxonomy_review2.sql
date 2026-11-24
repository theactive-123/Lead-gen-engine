-- Phase 5 review 2 (real samples, 2026-11-24). Idempotent.
-- Baby & kids: "nursery" also means plant nurseries; services/charities/medical are not product brands.
DELETE FROM keywords WHERE term = 'nursery' AND sub_niche_id = (SELECT id FROM sub_niches WHERE key = 'baby_kids');
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, t, 'positive' FROM sub_niches, unnest(ARRAY['nursery decor', 'nursery furniture']) t
  WHERE key = 'baby_kids' ON CONFLICT DO NOTHING;
INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, t, 'negative', 3 FROM sub_niches,
  unnest(ARRAY['photographer', 'photography', 'incontinence', 'adult diapers', 'charity', 'medical equipment']) t
  WHERE key = 'baby_kids' ON CONFLICT DO NOTHING;
-- Design studios: interior design / architecture are different businesses. Agencies: software vendors are not agencies.
INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, t, 'negative', 3 FROM sub_niches,
  unnest(ARRAY['interior design', 'interior designer', 'architecture', 'architect']) t WHERE key = 'branding_studio' ON CONFLICT DO NOTHING;
INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, t, 'negative', 3 FROM sub_niches, unnest(ARRAY['free trial', 'saas']) t
  WHERE key IN ('marketing_agency', 'seo_agency', 'ppc_social_agency', 'web_agency', 'branding_studio') ON CONFLICT DO NOTHING;
-- Pet products: dog trainers; cycling gear: motorcycle parts.
INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, t, 'negative', 3 FROM sub_niches,
  unnest(ARRAY['dog training', 'dog trainer', 'k9 training', 'obedience training']) t WHERE key = 'pet_products' ON CONFLICT DO NOTHING;
INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, t, 'negative', 3 FROM sub_niches, unnest(ARRAY['motorcycle', 'motorbike']) t
  WHERE key = 'cycling_fitness_gear' ON CONFLICT DO NOTHING;
-- Hospitality: "cabins" also matches prefab cabin makers; travel agencies sell packages.
DELETE FROM keywords WHERE term = 'cabins' AND sub_niche_id = (SELECT id FROM sub_niches WHERE key = 'boutique_hospitality');
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, 'cabin rentals', 'positive' FROM sub_niches WHERE key = 'boutique_hospitality' ON CONFLICT DO NOTHING;
INSERT INTO keywords (sub_niche_id, term, kind, weight) SELECT id, t, 'negative', 3 FROM sub_niches, unnest(ARRAY['prefab', 'travel agency', 'holiday packages']) t
  WHERE key = 'boutique_hospitality' ON CONFLICT DO NOTHING;
