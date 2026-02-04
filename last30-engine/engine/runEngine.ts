import fs from "fs";
import path from "path";
import crypto from "crypto";
import { redditCollector, CollectedItem } from "./collectors/redditCollector";
import { webCollector } from "./collectors/webCollector";
import { hnCollector } from "./collectors/hnCollector";
import { assignTimestampTier, isWithinWindow } from "./ranking/timestampTier";
import { clusterItems } from "./ranking/clustering";
import { scoreItems, ScoredItem } from "./ranking/scoring";
import { buildContextBlock } from "./synthesis/contextBlock";
import { insertRun, ItemRecord, RunRecord } from "../storage/db";

export type RunOptions = {
  query: string;
  window_days?: number;
  target?: "gpt" | "codex";
  mode?: "quick" | "deep";
  sources?: string[];
  top_n?: number;
};

export type RunResponse = {
  run_id: string;
  integrity_score: number;
  flags: string[];
  artifacts: Record<string, string>;
  context_block_text: string;
};

const DEFAULT_WINDOW = 30;
const DEFAULT_TARGET: "gpt" | "codex" = "gpt";

/** Execute the simplified research pipeline. */
export function runEngine(options: RunOptions): RunResponse {
  const windowDays = options.window_days ?? DEFAULT_WINDOW;
  const target = options.target ?? DEFAULT_TARGET;
  const mode = options.mode ?? "quick";
  const requestedSources = options.sources ?? ["reddit", "web", "hn"];

  const runId = `${new Date().toISOString().slice(0, 10)}-${slugify(options.query)}-${crypto.randomBytes(3).toString("hex")}`;

  const collected = collectSources(options.query, requestedSources);
  const filtered = collected.filter((item) => isWithinWindow(item.published_at, windowDays));
  const timestamped = filtered.map((item) => ({
    ...item,
    timestamp_tier: assignTimestampTier(item.published_at).tier
  }));

  const clustered = clusterItems(timestamped);
  const scored = scoreItems(clustered).slice(0, options.top_n ?? 10);

  const sourceCounts = clustered.reduce<Record<string, number>>((acc, item) => {
    acc[item.source] = (acc[item.source] ?? 0) + 1;
    return acc;
  }, {});

  const flags = buildFlags(collected.length, filtered.length);
  const integrityScore = calculateIntegrityScore(filtered.length, collected.length, flags.length);

  const contextBlockText = buildContextBlock({
    query: options.query,
    windowDays,
    sourceCounts,
    integrityScore,
    flags,
    target,
    topItems: scored
  });

  const runFolder = writeArtifacts(runId, contextBlockText, scored, options, integrityScore, flags);

  persistRun(runId, options, windowDays, target, mode, integrityScore, flags, clustered);

  return {
    run_id: runId,
    integrity_score: integrityScore,
    flags,
    artifacts: {
      run_folder: runFolder,
      context_block: path.join(runFolder, "context_block.txt"),
      summary: path.join(runFolder, "summary.md"),
      sources: path.join(runFolder, "sources.json"),
      run: path.join(runFolder, "run.json")
    },
    context_block_text: contextBlockText
  };
}

function collectSources(query: string, sources: string[]): CollectedItem[] {
  const results: CollectedItem[] = [];
  if (sources.includes("reddit")) {
    results.push(...redditCollector(query));
  }
  if (sources.includes("web")) {
    results.push(...webCollector(query));
  }
  if (sources.includes("hn")) {
    results.push(...hnCollector(query));
  }
  return results;
}

function buildFlags(total: number, kept: number): string[] {
  const flags: string[] = [];
  if (total === 0) {
    flags.push("no_sources");
  }
  if (kept < total) {
    flags.push("window_filtered");
  }
  return flags;
}

function calculateIntegrityScore(kept: number, total: number, flagsCount: number): number {
  if (total === 0) {
    return 0;
  }
  const base = Math.round((kept / total) * 100);
  return Math.max(0, base - flagsCount * 5);
}

function writeArtifacts(
  runId: string,
  contextBlockText: string,
  scored: ScoredItem[],
  options: RunOptions,
  integrityScore: number,
  flags: string[]
): string {
  const datePath = new Date().toISOString().slice(0, 10);
  const slug = slugify(options.query);
  const runFolder = path.join(__dirname, "..", "runs", datePath, `${slug}-${runId.slice(-6)}`);
  fs.mkdirSync(runFolder, { recursive: true });

  const summary = `# SignalForge Run\n\nQuery: ${options.query}\nMode: ${options.mode ?? "quick"}\nTarget: ${options.target ?? DEFAULT_TARGET}\nIntegrity: ${integrityScore}/100\nFlags: ${flags.join(", ") || "none"}\n`;

  fs.writeFileSync(path.join(runFolder, "context_block.txt"), contextBlockText, "utf8");
  fs.writeFileSync(path.join(runFolder, "summary.md"), summary, "utf8");
  fs.writeFileSync(path.join(runFolder, "sources.json"), JSON.stringify(scored, null, 2), "utf8");
  fs.writeFileSync(
    path.join(runFolder, "run.json"),
    JSON.stringify({
      run_id: runId,
      options,
      integrity_score: integrityScore,
      flags
    }, null, 2),
    "utf8"
  );

  return runFolder;
}

function persistRun(
  runId: string,
  options: RunOptions,
  windowDays: number,
  target: string,
  mode: string,
  integrityScore: number,
  flags: string[],
  items: Array<CollectedItem & { cluster_id: string; timestamp_tier: string }>
): void {
  const runRecord: RunRecord = {
    id: runId,
    query: options.query,
    window_days: windowDays,
    target,
    mode,
    created_at: new Date().toISOString(),
    integrity_score: integrityScore,
    flags
  };

  const itemRecords: ItemRecord[] = items.map((item) => ({
    run_id: runId,
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    published_at: item.published_at ?? null,
    source: item.source,
    cluster_id: item.cluster_id,
    timestamp_tier: item.timestamp_tier
  }));

  insertRun(runRecord, itemRecords);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 40) || "run";
}
