-- Phase 5 review 1 (real samples, 2026-11-24): narrower terms where samples showed wrong matches.
-- Idempotent: also safe on a fresh install where 010 already contains these changes.
DELETE FROM keywords WHERE term = 'lighting' AND sub_niche_id = (SELECT id FROM sub_niches WHERE key = 'home_kitchen');
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, t, 'positive' FROM sub_niches, unnest(ARRAY['lamps', 'table lamps', 'pendant lights']) t
  WHERE key = 'home_kitchen' ON CONFLICT DO NOTHING;
DELETE FROM keywords WHERE term IN ('consultancy', 'consulting firm') AND sub_niche_id = (SELECT id FROM sub_niches WHERE key = 'business_coach');
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, t, 'positive' FROM sub_niches, unnest(ARRAY['business consulting', 'business mentor']) t
  WHERE key = 'business_coach' ON CONFLICT DO NOTHING;
INSERT INTO keywords (sub_niche_id, term, kind) SELECT id, t, 'positive' FROM sub_niches, unnest(ARRAY['scouts', 'scout group']) t
  WHERE key = 'non_commercial' ON CONFLICT DO NOTHING;
-- Scoring rules (see apps/worker/src/stages/classify/engine.ts):
INSERT INTO settings (key, value, description) VALUES
  ('classify.text_cap', '2', 'Most points page body text can add per sub-niche (title/description/products/domain must carry the rest)'),
  ('classify.boost_min_keywords', '2', 'Page-structure and technology boosts only count when keywords already score at least this much')
ON CONFLICT (key) DO NOTHING;
