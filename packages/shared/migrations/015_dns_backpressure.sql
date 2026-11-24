-- Pause DNS while many resolved domains still wait for their homepage fetch (saves CPU/disk; see dnsPlan.hold).
INSERT INTO settings (key, value, description) VALUES
  ('stage.dns.max_fetch_backlog', '100000', 'Pause DNS while this many resolved domains still wait for their homepage fetch')
ON CONFLICT (key) DO NOTHING;
