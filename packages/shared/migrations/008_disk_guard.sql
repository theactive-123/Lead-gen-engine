-- Measured in Phase 3: compressed homepage HTML ≈ 28 KB per site (1.9 GB for ~67k pages).
-- Full-speed fetching (~79k pages/hour) would write ~2 GB/hour, so:
--  * keep HTML 3 days (fingerprinting in Phase 4 reads it within hours), and
--  * stop planning new work when free disk falls below a floor.
UPDATE settings SET value = '3', updated_at = now() WHERE key = 'html.retention_days';
INSERT INTO settings (key, value, description) VALUES
  ('disk.min_free_gb', '20', 'Pause planning new DNS/fetch work when free disk space is below this (GB)')
ON CONFLICT (key) DO NOTHING;
