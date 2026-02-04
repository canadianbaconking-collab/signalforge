CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  target TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  integrity_score INTEGER NOT NULL,
  flags TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT NOT NULL,
  published_at TEXT,
  source TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  timestamp_tier TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
