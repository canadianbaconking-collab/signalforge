import fs from "fs";
import path from "path";
import crypto from "crypto";
import { RedditCollectorResult, redditCollector } from "./collectors/redditCollector";
import { webCollector } from "./collectors/webCollector";
import { hnCollector } from "./collectors/hnCollector";
import { githubCollector } from "./collectors/githubCollector";
import { CollectedItem } from "./collectors/types";
import { assignTimestampTier, isWithinWindow } from "./ranking/timestampTier";
import { clusterItems } from "./ranking/clustering";
import { clusterIdeas, IdeaClusterSummary } from "./ranking/ideaClustering";
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
  deterministic?: boolean;
  allow_t4?: boolean;
  run_date?: string;
  collectors?: CollectorOverrides;
};

export type CollectorOverrides = Partial<{
  reddit: (query: string, windowDays: number, limit: number) => Promise<RedditCollectorResult>;
  web: (query: string) => CollectedItem[];
  hn: (query: string, limit: number) => Promise<CollectedItem[]>;
  github: (query: string, windowDays: number, limit: number) => Promise<{ items: CollectedItem[]; failed: boolean }>;
}>;

export type RunResponse = {
  run_id: string;
  integrity_score: number;
  flags: string[];
  artifacts: Record<string, string>;
  context_block_text: string;
};

const DEFAULT_WINDOW = 30;
const DEFAULT_TARGET: "gpt" | "codex" = "gpt";
const DEFAULT_TOP_N = 10;
const DEFAULT_ALLOW_T4 = true;
const RUN_ID_HASH_LENGTH = 10;
let sanityChecksCompleted = false;

/** Execute the simplified research pipeline. */
export async function runEngine(options: RunOptions): Promise<RunResponse> {
  runEngineSanityChecks();
  const windowDays = options.window_days ?? DEFAULT_WINDOW;
  const target = options.target ?? DEFAULT_TARGET;
  const mode = options.mode ?? "quick";
  const requestedSources = options.sources ?? ["reddit", "web", "hn"];
  const allowT4 = options.allow_t4 ?? DEFAULT_ALLOW_T4;
  const runDate = options.run_date ?? getRunDate();
  const limit = options.top_n ?? DEFAULT_TOP_N;

  const runId = buildRunId(options, runDate, requestedSources);

  const {
    items: collected,
    flags: collectorFlags,
    excludedMissingTimestamp,
    redditStrategyUsed
  } = await collectSources(
    options.query,
    requestedSources,
    limit,
    windowDays,
    options.collectors
  );
  const windowFiltered = collected.filter((item) => isWithinWindow(item.published_at, windowDays));
  const timestamped = windowFiltered.map((item) => ({
    ...item,
    timestamp_tier: assignTimestampTier(item.published_at).tier
  }));
  const timestampTierCounts = countTimestampTiers(timestamped);
  const { kept: policyKept, excludedT4 } = applyTimestampPolicy(timestamped, allowT4);
  const perSourceCounts = countBySource(policyKept);
  for (const source of requestedSources) {
    if (perSourceCounts[source] === undefined) {
      perSourceCounts[source] = 0;
    }
  }

  const clustered = clusterItems(policyKept);
  const { items: ideaClustered, clusters: ideaClusters } = clusterIdeas(clustered);
  const scored = scoreItems(ideaClustered).slice(0, options.top_n ?? DEFAULT_TOP_N);

  const sourceCounts = ideaClustered.reduce<Record<string, number>>((acc, item) => {
    acc[item.source] = (acc[item.source] ?? 0) + 1;
    return acc;
  }, {});

  const flags = mergeFlags(buildFlags(collected.length, windowFiltered.length), collectorFlags);
  const integrityScore = calculateIntegrityScore(windowFiltered.length, collected.length, flags.length);
  const ideaTelemetry = buildIdeaTelemetry(ideaClusters);

  const contextBlockText = buildContextBlock({
    query: options.query,
    windowDays,
    sourceCounts,
    integrityScore,
    flags,
    target,
    topItems: scored
  });

  const runFolder = writeArtifacts(
    runId,
    contextBlockText,
    scored,
    options,
    integrityScore,
    flags,
    runDate,
    allowT4,
    {
      collected: collected.length,
      kept: policyKept.length,
      excluded_t4: excludedT4,
      excluded_missing_timestamp: excludedMissingTimestamp,
      per_source_counts: perSourceCounts
    },
    timestampTierCounts,
    redditStrategyUsed,
    ideaTelemetry
  );

  persistRun(runId, options, windowDays, target, mode, integrityScore, flags, clustered);

  const runFileSuffix = runId.slice(-RUN_ID_HASH_LENGTH);
  return {
    run_id: runId,
    integrity_score: integrityScore,
    flags,
    artifacts: {
      run_folder: runFolder,
      context_block: path.join(runFolder, `context_block_${runFileSuffix}.txt`),
      summary: path.join(runFolder, `summary_${runFileSuffix}.md`),
      sources: path.join(runFolder, `sources_${runFileSuffix}.json`),
      run: path.join(runFolder, `run_${runFileSuffix}.json`)
    },
    context_block_text: contextBlockText
  };
}

async function collectSources(
  query: string,
  sources: string[],
  limit: number,
  windowDays: number,
  collectors?: CollectorOverrides
): Promise<{
  items: CollectedItem[];
  flags: string[];
  excludedMissingTimestamp: number;
  redditStrategyUsed: string | null;
}> {
  const results: CollectedItem[] = [];
  const flags: string[] = [];
  let excludedMissingTimestamp = 0;
  let redditStrategyUsed: string | null = null;
  if (sources.includes("reddit")) {
    try {
      const redditResult = await (collectors?.reddit ?? redditCollector)(query, windowDays, limit);
      results.push(...redditResult.items);
      excludedMissingTimestamp += redditResult.excluded_missing_timestamp;
      redditStrategyUsed = redditResult.strategy_used;
      if (redditResult.failed) {
        flags.push("REDDIT_FETCH_FAILED");
      }
    } catch (error) {
      flags.push("REDDIT_FETCH_FAILED");
      redditStrategyUsed = "reddit_json";
    }
  }
  if (sources.includes("web")) {
    results.push(...(collectors?.web ?? webCollector)(query));
  }
  if (sources.includes("hn")) {
    try {
      const hnResults = await (collectors?.hn ?? hnCollector)(query, limit);
      results.push(...hnResults);
    } catch (error) {
      flags.push("HN_FETCH_FAILED");
    }
  }
  if (sources.includes("github_issue") || sources.includes("github_release")) {
    const githubSources = new Set(["github_issue", "github_release"]);
    const githubFilter = (item: CollectedItem) => !githubSources.has(item.source) || sources.includes(item.source);
    try {
      const githubResult = await (collectors?.github ?? githubCollector)(query, windowDays, limit);
      results.push(...githubResult.items.filter(githubFilter));
      if (githubResult.failed) {
        flags.push("GITHUB_FETCH_FAILED");
      }
    } catch (error) {
      flags.push("GITHUB_FETCH_FAILED");
    }
  }
  return {
    items: results,
    flags,
    excludedMissingTimestamp,
    redditStrategyUsed
  };
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

function mergeFlags(base: string[], additional: string[]): string[] {
  return Array.from(new Set([...base, ...additional]));
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
  flags: string[],
  runDate: string,
  allowT4: boolean,
  counts: {
    collected: number;
    kept: number;
    excluded_t4: number;
    excluded_missing_timestamp: number;
    per_source_counts: Record<string, number>;
  },
  timestampTierCounts: Record<string, number>,
  redditStrategyUsed: string | null,
  ideaTelemetry: {
    idea_cluster_count: number;
    origin_count_stats: StatSummary;
    echo_risk_stats: StatSummary;
    evidence_grade_counts: Record<string, number>;
  }
): string {
  const runFolder = buildRunFolder(runDate, options.query);
  fs.mkdirSync(runFolder, { recursive: true });
  const runFileSuffix = runId.slice(-RUN_ID_HASH_LENGTH);

  const summary = `# SignalForge Run\n\nQuery: ${options.query}\nMode: ${options.mode ?? "quick"}\nTarget: ${options.target ?? DEFAULT_TARGET}\nIntegrity: ${integrityScore}/100\nFlags: ${flags.join(", ") || "none"}\n`;

  fs.writeFileSync(path.join(runFolder, `context_block_${runFileSuffix}.txt`), contextBlockText, "utf8");
  fs.writeFileSync(path.join(runFolder, `summary_${runFileSuffix}.md`), summary, "utf8");
  fs.writeFileSync(path.join(runFolder, `sources_${runFileSuffix}.json`), JSON.stringify(scored, null, 2), "utf8");
  fs.writeFileSync(
    path.join(runFolder, `run_${runFileSuffix}.json`),
    JSON.stringify({
      run_id: runId,
      options,
      integrity_score: integrityScore,
      flags,
      allow_t4: allowT4,
      counts,
      timestamp_tier_counts: timestampTierCounts,
      idea_cluster_count: ideaTelemetry.idea_cluster_count,
      origin_count_stats: ideaTelemetry.origin_count_stats,
      echo_risk_stats: ideaTelemetry.echo_risk_stats,
      evidence_grade_counts: ideaTelemetry.evidence_grade_counts,
      reddit: {
        strategy_used: redditStrategyUsed
      }
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

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getRunDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildRunId(options: RunOptions, runDate: string, sources: string[]): string {
  const normalizedQuery = normalizeQuery(options.query);
  const windowDays = options.window_days ?? DEFAULT_WINDOW;
  const target = options.target ?? DEFAULT_TARGET;
  const mode = options.mode ?? "quick";
  const topN = options.top_n ?? DEFAULT_TOP_N;
  const normalizedSources = [...sources].map((source) => source.toLowerCase()).sort();
  const deterministic = options.deterministic ?? true;
  const nonce = deterministic ? "" : `|${crypto.randomUUID()}`;
  const payload = JSON.stringify({
    query: normalizedQuery,
    window_days: windowDays,
    target,
    mode,
    sources: normalizedSources,
    top_n: topN,
    run_date: runDate
  });

  const hash = crypto.createHash("sha256").update(`${payload}${nonce}`).digest("hex");
  const slug = slugify(options.query);
  return `${runDate}-${slug}-${hash.slice(0, RUN_ID_HASH_LENGTH)}`;
}

function buildRunFolder(runDate: string, query: string): string {
  const slug = slugify(query);
  return path.join(__dirname, "..", "runs", runDate, slug);
}

function countTimestampTiers(items: Array<{ timestamp_tier: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.timestamp_tier] = (acc[item.timestamp_tier] ?? 0) + 1;
    return acc;
  }, {});
}

function countBySource(items: Array<{ source: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.source] = (acc[item.source] ?? 0) + 1;
    return acc;
  }, {});
}

type StatSummary = {
  min: number;
  median: number;
  max: number;
};

function applyTimestampPolicy<T extends { timestamp_tier: string }>(
  items: T[],
  allowT4: boolean
): { kept: T[]; excludedT4: number } {
  if (allowT4) {
    return { kept: items, excludedT4: 0 };
  }

  const kept = items.filter((item) => item.timestamp_tier !== "T4");
  return { kept, excludedT4: items.length - kept.length };
}

function buildIdeaTelemetry(clusters: IdeaClusterSummary[]): {
  idea_cluster_count: number;
  origin_count_stats: StatSummary;
  echo_risk_stats: StatSummary;
  evidence_grade_counts: Record<string, number>;
} {
  const originCounts = clusters.map((cluster) => cluster.origin_count);
  const echoRisks = clusters.map((cluster) => cluster.echo_risk);
  const evidenceGradeCounts = clusters.reduce<Record<string, number>>((acc, cluster) => {
    acc[cluster.evidence_grade] = (acc[cluster.evidence_grade] ?? 0) + 1;
    return acc;
  }, {});

  return {
    idea_cluster_count: clusters.length,
    origin_count_stats: buildStats(originCounts),
    echo_risk_stats: buildStats(echoRisks),
    evidence_grade_counts: evidenceGradeCounts
  };
}

function buildStats(values: number[]): StatSummary {
  if (values.length === 0) {
    return { min: 0, median: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return { min, median, max };
}

function runEngineSanityChecks(): void {
  if (sanityChecksCompleted) {
    return;
  }
  sanityChecksCompleted = true;

  const sampleOptions: RunOptions = {
    query: "Example Query",
    window_days: 7,
    target: "gpt",
    mode: "quick",
    sources: ["web", "hn"],
    top_n: 5
  };
  const runDate = "2024-01-02";
  const runIdA = buildRunId(sampleOptions, runDate, sampleOptions.sources ?? []);
  const runIdB = buildRunId(sampleOptions, runDate, sampleOptions.sources ?? []);
  if (runIdA !== runIdB) {
    throw new Error("Run ID deterministic check failed.");
  }

  const expectedFolder = buildRunFolder(runDate, sampleOptions.query);
  const expectedFolderRepeat = buildRunFolder(runDate, sampleOptions.query);
  const expectedSuffix = path.join("runs", runDate, slugify(sampleOptions.query));
  if (expectedFolder !== expectedFolderRepeat) {
    throw new Error("Run folder determinism check failed.");
  }
  if (!expectedFolder.endsWith(expectedSuffix)) {
    throw new Error("Run folder path contract check failed.");
  }

  const sampleItems = [
    { timestamp_tier: "T1", title: "valid" },
    { timestamp_tier: "T4", title: "missing" }
  ];
  const { kept, excludedT4 } = applyTimestampPolicy(sampleItems, false);
  if (kept.some((item) => item.timestamp_tier === "T4") || excludedT4 !== 1) {
    throw new Error("Timestamp policy check failed.");
  }
}
