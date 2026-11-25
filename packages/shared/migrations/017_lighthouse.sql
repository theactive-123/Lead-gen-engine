-- Phase 7b: Lighthouse for the top tier, and technologies seen only when the page runs in a browser.
ALTER TABLE technologies ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'html' CHECK (source IN ('html', 'runtime'));

INSERT INTO settings (key, value, description) VALUES
  ('stage.lighthouse.batch_size', '20', 'Leads per Lighthouse job'),
  ('stage.lighthouse.snapshot_size', '200', 'Leads planned per Lighthouse snapshot'),
  ('lighthouse.timeout_ms', '60000', 'Give up on one Lighthouse run after this many milliseconds'),
  ('lighthouse.prelim', '{
    "weights": {"email": 30, "named_email": 10, "niche_confidence": 25, "completeness": 15, "active_store": 10, "problems": 10},
    "problems_full_at": 3,
    "active_store_days": 90,
    "min_score": 60
  }', 'Preliminary lead score (0-100) that decides who gets the expensive Lighthouse audit. Weights add up to 100.'),
  ('lighthouse.rules', '{
    "performance_poor": 50,
    "accessibility_poor": 70,
    "best_practices_poor": 70,
    "seo_poor": 80,
    "lcp_poor_ms": 4000,
    "cls_poor": 0.25,
    "tbt_poor_ms": 600,
    "severity": {
      "lighthouse_performance_poor": "high", "lighthouse_lcp_poor": "high", "lighthouse_tbt_poor": "medium", "lighthouse_cls_poor": "medium",
      "lighthouse_accessibility_poor": "medium", "lighthouse_seo_poor": "medium", "lighthouse_best_practices_poor": "low"
    },
    "runtime_clears": {
      "no_analytics": ["Analytics", "Tag managers"],
      "no_email_marketing_tool": ["Marketing automation", "Email"],
      "no_email_capture": ["Marketing automation", "Email"],
      "no_reviews": ["Reviews"],
      "no_online_booking": ["Appointment scheduling", "Ticket booking"]
    }
  }', 'Lighthouse finding thresholds (Google: score < 50 = poor; LCP > 4 s, CLS > 0.25, TBT > 600 ms = poor) and which light findings a tool seen at runtime disproves.')
ON CONFLICT (key) DO NOTHING;
