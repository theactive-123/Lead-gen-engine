-- Phase 3 review of real pages: "coming soon" / "launching soon" appear as menu labels and product badges
-- on live shops (8 of 8 matches in the first 400 pages; only 1-2 were real placeholders).
-- Placeholder rules now only apply to short pages, or when the phrase is in the title.
ALTER TABLE page_tag_rules ADD COLUMN max_words integer;  -- rule applies only if the page has at most this many words
UPDATE page_tag_rules SET max_words = 150 WHERE tag IN ('coming_soon', 'default_page');
UPDATE page_tag_rules SET max_words = 300 WHERE tag IN ('parked', 'store_closed');
INSERT INTO page_tag_rules (tag, field, pattern, note) VALUES
  ('coming_soon', 'title', '(?i)\b(coming soon|launching soon|under construction|opening soon)\b', 'Placeholder title');
