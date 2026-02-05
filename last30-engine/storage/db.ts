import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DEFAULT_DB_PATH = path.join(__dirname, "..", "cache", "signalforge.db");
const SCHEMA_PATH = resolveSchemaPath();
const BASELINE_DEFAULT_LOOKBACK_DAYS = 180;
const CLUSTER_HISTORY_LOOKBACK_DAYS = 180;


function resolveSchemaPath(): string {
  const candidates = [
    path.join(__dirname, "schema.sql"),
    path.join(__dirname, "..", "..", "storage", "schema.sql")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export type RunRecord = {
  id: string;
  query: string;
  window_days: number;
  target: string;
  mode: string;
  created_at: string;
  integrity_score: number;
  flags: string[];
};

export type ItemRecord = {
  run_id: string;
  title: string;
  url: string;
  snippet: string;
  published_at: string | null;
  source: string;
  cluster_id: string;
  idea_cluster_id: string;
  evidence_grade: string;
  origin_count: number;
  engagement: number | null;
  timestamp_tier: string;
};

export type BaselineItemRecord = {
  title: string;
  url: string;
  published_at: string;
  source: string;
  evidence_grade: string;
  origin_count: number;
  engagement: number | null;
};

export type ClusterHistoryRecord = {
  first_seen: string | null;
  last_seen: string | null;
  seen_count: number;
};

let db: any = null;

/** Initialize the SQLite database and apply schema. */
export function getDb(): any {
  if (db) {
    return db;
  }

  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.exec(schema);
  ensureItemColumns(db);
  return db;
}

/** Persist the run metadata and collected items. */
export function insertRun(run: RunRecord, items: ItemRecord[]): void {
  const database = getDb();
  const existingRun = database.prepare("SELECT 1 FROM runs WHERE id = ?").get(run.id);
  if (existingRun) {
    return;
  }
  const insertRunStmt = database.prepare(
    "INSERT INTO runs (id, query, window_days, target, mode, created_at, integrity_score, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertItemStmt = database.prepare(
    "INSERT INTO items (run_id, title, url, snippet, published_at, source, cluster_id, idea_cluster_id, evidence_grade, origin_count, engagement, timestamp_tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  const flagsJoined = run.flags.join(",");
  insertRunStmt.run(
    run.id,
    run.query,
    run.window_days,
    run.target,
    run.mode,
    run.created_at,
    run.integrity_score,
    flagsJoined
  );

  const insertMany = database.transaction((records: ItemRecord[]) => {
    for (const item of records) {
      insertItemStmt.run(
        item.run_id,
        item.title,
        item.url,
        item.snippet,
        item.published_at,
        item.source,
        item.cluster_id,
        item.idea_cluster_id,
        item.evidence_grade,
        item.origin_count,
        item.engagement,
        item.timestamp_tier
      );
    }
  });

  insertMany(items);
}

export function fetchBaselineItems(
  ideaClusterId: string,
  runDate: string,
  windowDays: number,
  lookbackDays = BASELINE_DEFAULT_LOOKBACK_DAYS
): BaselineItemRecord[] {
  const database = getDb();
  const { baselineCutoff, lookbackCutoff } = buildBaselineCutoffs(runDate, windowDays, lookbackDays);
  const rows = database
    .prepare(
      `SELECT items.title,
        items.url,
        items.published_at,
        items.source,
        items.evidence_grade,
        items.origin_count,
        items.engagement
      FROM items
      INNER JOIN runs ON runs.id = items.run_id
      WHERE items.idea_cluster_id = ?
        AND items.published_at IS NOT NULL
        AND items.published_at < ?
        AND runs.created_at >= ?
      ORDER BY items.published_at DESC`
    )
    .all(ideaClusterId, baselineCutoff, lookbackCutoff) as BaselineItemRecord[];

  return rows
    .sort((a, b) => compareBaselineItems(a, b))
    .slice(0, 2);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getClusterHistory(
  ideaClusterId: string,
  runDate: string,
  lookbackDays = CLUSTER_HISTORY_LOOKBACK_DAYS
): ClusterHistoryRecord {
  const database = getDb();
  const runDateEnd = `${runDate}T23:59:59.999Z`;
  const lookbackCutoff = new Date(new Date(`${runDate}T00:00:00Z`).getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString();

  const row = database
    .prepare(
      `SELECT
        MIN(COALESCE(items.published_at, runs.created_at)) AS first_seen,
        MAX(COALESCE(items.published_at, runs.created_at)) AS last_seen,
        COUNT(*) AS seen_count
      FROM items
      INNER JOIN runs ON runs.id = items.run_id
      WHERE items.idea_cluster_id = ?
        AND COALESCE(items.published_at, runs.created_at) >= ?
        AND COALESCE(items.published_at, runs.created_at) <= ?`
    )
    .get(ideaClusterId, lookbackCutoff, runDateEnd) as
    | { first_seen: string | null; last_seen: string | null; seen_count: number }
    | undefined;

  return {
    first_seen: row?.first_seen ?? null,
    last_seen: row?.last_seen ?? null,
    seen_count: row?.seen_count ?? 0
  };
}

export function upsertClusterSeen(_ideaClusterId: string, _runDate: string): void {
  // Cluster history is derived from existing rows in runs/items for deterministic replay.
}

function resolveDbPath(): string {
  return process.env.SIGNALFORGE_DB_PATH ?? DEFAULT_DB_PATH;
}

function ensureItemColumns(database: any): void {
  const columns = database.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const additions: Array<{ name: string; type: string }> = [
    { name: "idea_cluster_id", type: "TEXT" },
    { name: "evidence_grade", type: "TEXT" },
    { name: "origin_count", type: "INTEGER" },
    { name: "engagement", type: "INTEGER" }
  ];

  for (const addition of additions) {
    if (!columnNames.has(addition.name)) {
      database.exec(`ALTER TABLE items ADD COLUMN ${addition.name} ${addition.type}`);
    }
  }
}

function buildBaselineCutoffs(runDate: string, windowDays: number, lookbackDays: number): {
  baselineCutoff: string;
  lookbackCutoff: string;
} {
  const runDateUtc = new Date(`${runDate}T00:00:00Z`);
  const baselineCutoff = new Date(runDateUtc.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const lookbackCutoff = new Date(runDateUtc.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return {
    baselineCutoff: baselineCutoff.toISOString(),
    lookbackCutoff: lookbackCutoff.toISOString()
  };
}

function compareBaselineItems(a: BaselineItemRecord, b: BaselineItemRecord): number {
  const gradeOrder: Record<string, number> = {
    "discussion-only": 1,
    "implementation-confirmed": 2,
    "multi-confirmed": 3
  };
  const gradeDelta = (gradeOrder[b.evidence_grade] ?? 0) - (gradeOrder[a.evidence_grade] ?? 0);
  if (gradeDelta !== 0) {
    return gradeDelta;
  }

  if (b.origin_count !== a.origin_count) {
    return b.origin_count - a.origin_count;
  }

  if (a.engagement !== null && b.engagement !== null && b.engagement !== a.engagement) {
    return b.engagement - a.engagement;
  }

  if (a.published_at !== b.published_at) {
    return b.published_at.localeCompare(a.published_at);
  }

  return a.title.localeCompare(b.title);
}
