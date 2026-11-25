-- Phase 7 tuning from the real run (2026-11-25):
-- * Heavy pages (300+ requests, 30+ MB) need 60-65 s in Lighthouse even alone -> 90 s limit.
-- * Each run now has its own process + Chrome; 4 vCPU handled 4 in parallel.
-- * Preliminary score >= 70 selected the top ~19% of 23,949 leads (>= 60 was 49%).
UPDATE settings SET value = '90000' WHERE key = 'lighthouse.timeout_ms' AND value = '60000';
UPDATE settings SET value = '4', description = 'Lighthouse runs at once (each one is a separate Chrome; about 1 per CPU core)'
  WHERE key = 'lighthouse.parallel' AND value = '2';
UPDATE settings SET value = jsonb_set(value, '{min_score}', '70') WHERE key = 'lighthouse.prelim' AND value->>'min_score' = '60';
INSERT INTO settings (key, value, description) VALUES
  ('lighthouse.retry_failed_days', '7', 'Try a failed Lighthouse run (timeout, crash) again after this many days')
ON CONFLICT (key) DO NOTHING;
