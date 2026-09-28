CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  target TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  integrity_score INTEGER NOT NULL,
  flags TEXT NOT NULL,
  artifact_id TEXT,
  evidence_hash TEXT,
  evidence_json TEXT,
  response_json TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  artifact_id TEXT NOT NULL,
  question TEXT NOT NULL,
  choice TEXT NOT NULL,
  rationale TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL,
  decision_snapshot_id TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  observed_at TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
  notes TEXT NOT NULL,
  confounders_json TEXT NOT NULL
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
  idea_cluster_id TEXT,
  evidence_grade TEXT,
  origin_count INTEGER,
  engagement INTEGER,
  timestamp_tier TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS review_events (
  event_number INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  parent_artifact_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  edits_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_events_run_order ON review_events(run_id, event_number);

CREATE TABLE IF NOT EXISTS derived_artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('comparison', 'decision_snapshot')),
  content_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
