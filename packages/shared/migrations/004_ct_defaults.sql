-- Phase 2 measurement (2026-11-19, matched 30-min window): 14 active logs -> 347,259 unique domains;
-- these 4 logs alone -> 283,300 (82%) at about a quarter of the bandwidth/CPU.
-- The filter is matched against the log URL; the active shard (by expiry date) is picked automatically.
UPDATE sources SET options = '{
  "logs": ["sycamore", "parcelyard", "tiger", "wyvern"],
  "active_shards_only": true,
  "shard_days_ahead": 60,
  "start_back_entries": 0,
  "max_entries_per_log_per_run": 1000000,
  "parallel_requests": 8
}', updated_at = now()
WHERE key = 'ct';
