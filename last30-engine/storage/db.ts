import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = path.join(__dirname, "..", "cache", "signalforge.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

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
  timestamp_tier: string;
};

let db: Database.Database | null = null;

/** Initialize the SQLite database and apply schema. */
export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.exec(schema);
  return db;
}

/** Persist the run metadata and collected items. */
export function insertRun(run: RunRecord, items: ItemRecord[]): void {
  const database = getDb();
  const insertRunStmt = database.prepare(
    "INSERT INTO runs (id, query, window_days, target, mode, created_at, integrity_score, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertItemStmt = database.prepare(
    "INSERT INTO items (run_id, title, url, snippet, published_at, source, cluster_id, timestamp_tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
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
        item.timestamp_tier
      );
    }
  });

  insertMany(items);
}
