import fs from "fs";
import path from "path";
import { runEngine } from "../engine/runEngine";
import { CollectedItem } from "../engine/collectors/types";
import { RedditCollectorResult } from "../engine/collectors/redditCollector";

type SmokeResult = {
  name: string;
  passed: boolean;
  details?: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 40) || "run"
  );
}

function assertCondition(condition: boolean, message: string): SmokeResult {
  return { name: message, passed: condition, details: condition ? undefined : message };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function collectResults(results: SmokeResult[]): { failures: SmokeResult[]; passes: SmokeResult[] } {
  const failures = results.filter((result) => !result.passed);
  const passes = results.filter((result) => result.passed);
  return { failures, passes };
}

async function runOfflineSmoke(): Promise<{ failures: SmokeResult[]; passes: SmokeResult[] }> {
  const fixedNow = new Date("2024-02-10T12:00:00Z");
  const fixedRunDate = "2024-02-10";
  const originalDateNow = Date.now;
  Date.now = () => fixedNow.getTime();

  const recentIso = new Date(fixedNow.getTime() - 2 * ONE_DAY_MS).toISOString();
  const oldIso = new Date(fixedNow.getTime() - 10 * ONE_DAY_MS).toISOString();

  const fakeRedditCollector = async (): Promise<RedditCollectorResult> => ({
    items: [
      {
        title: "Recent Reddit",
        url: "https://example.com/dup",
        snippet: "Recent reddit item.",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Old Reddit",
        url: "https://example.com/old",
        snippet: "Old reddit item.",
        published_at: oldIso,
        source: "reddit"
      },
      {
        title: "Missing Timestamp Reddit",
        url: "https://example.com/no-timestamp",
        snippet: "Missing timestamp.",
        published_at: null,
        source: "reddit"
      },
      {
        title: "SignalForge CLI launch",
        url: "https://example.com/cli-launch",
        snippet: "SignalForge CLI launch",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Quantum widget leak",
        url: "https://repost.com/quantum-widget-1",
        snippet: "Quantum widget leak",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Quantum widget leak",
        url: "https://repost.com/quantum-widget-2",
        snippet: "Quantum widget leak",
        published_at: recentIso,
        source: "reddit"
      }
    ],
    failed: false,
    strategy_used: "reddit_json",
    excluded_missing_timestamp: 1
  });

  const fakeHnCollector = async (): Promise<CollectedItem[]> => [
    {
      title: "HN Duplicate",
      url: "https://example.com/dup",
      snippet: "Duplicated URL.",
      published_at: recentIso,
      source: "hn"
    },
    {
      title: "HN Fresh",
      url: "https://example.com/hn-fresh",
      snippet: "Fresh HN item.",
      published_at: recentIso,
      source: "hn"
    },
    {
      title: "SignalForge CLI launch",
      url: "https://news.ycombinator.com/item?id=999",
      snippet: "SignalForge CLI launch",
      published_at: recentIso,
      source: "hn"
    },
    {
      title: "Quantum widget leak",
      url: "https://repost.com/quantum-widget-3",
      snippet: "Quantum widget leak",
      published_at: recentIso,
      source: "hn"
    }
  ];

  const fakeGithubCollector = async (): Promise<{ items: CollectedItem[]; failed: boolean }> => ({
    items: [
      {
        title: "ForgeRunner release",
        url: "https://github.com/signalforge/forgerunner/issues/1",
        snippet: "ForgeRunner release notes",
        published_at: recentIso,
        source: "github_issue"
      }
    ],
    failed: false
  });

  const options = {
    query: "Smoke Test Query",
    window_days: 7,
    sources: ["reddit", "hn", "github_issue"],
    top_n: 10,
    allow_t4: false,
    run_date: fixedRunDate,
    collectors: {
      reddit: fakeRedditCollector,
      hn: fakeHnCollector,
      github: fakeGithubCollector
    }
  };

  const resultA = await runEngine(options);
  const resultB = await runEngine(options);

  Date.now = originalDateNow;

  const runFolder = resultA.artifacts.run_folder;
  const runFiles = fs.readdirSync(runFolder);
  const sources = readJson<
    Array<{
      url: string;
      source: string;
      title: string;
      idea_cluster_id: string;
      evidence_grade: string;
      origin_id: string;
      origin_count: number;
      echo_risk: number;
    }>
  >(resultA.artifacts.sources);
  const runData = readJson<{
    counts: {
      kept: number;
      excluded_t4: number;
      excluded_missing_timestamp: number;
      per_source_counts: Record<string, number>;
    };
    timestamp_tier_counts: Record<string, number>;
    idea_cluster_count: number;
    origin_count_stats: { min: number; median: number; max: number };
    echo_risk_stats: { min: number; median: number; max: number };
    evidence_grade_counts: Record<string, number>;
  }>(resultA.artifacts.run);

  const expectedRunFolderSuffix = path.join("runs", fixedRunDate, slugify(options.query));
  const sourceUrls = sources.map((item) => item.url);
  const uniqueUrls = new Set(sourceUrls);
  const perSourceCounts = runData.counts.per_source_counts;
  const perSourceSum = Object.values(perSourceCounts).reduce((sum, value) => sum + value, 0);
  const signalforgeItems = sources.filter((item) => item.title === "SignalForge CLI launch");
  const quantumItems = sources.filter((item) => item.title === "Quantum widget leak");
  const githubItem = sources.find((item) => item.source === "github_issue");

  const checks: SmokeResult[] = [
    assertCondition(resultA.run_id === resultB.run_id, "Determinism: run_id is stable"),
    assertCondition(
      resultA.artifacts.run_folder === resultB.artifacts.run_folder,
      "Determinism: run_folder is stable"
    ),
    assertCondition(
      runFolder.endsWith(expectedRunFolderSuffix),
      "Artifact contract: run folder path matches runs/YYYY-MM-DD/<slug>"
    ),
    assertCondition(
      runFiles.some((file) => file.startsWith("context_block_") && file.endsWith(".txt")),
      "Artifact contract: context_block file exists"
    ),
    assertCondition(
      runFiles.some((file) => file.startsWith("sources_") && file.endsWith(".json")),
      "Artifact contract: sources file exists"
    ),
    assertCondition(
      runFiles.some((file) => file.startsWith("run_") && file.endsWith(".json")),
      "Artifact contract: run file exists"
    ),
    assertCondition(
      runFiles.some((file) => file.startsWith("summary_") && file.endsWith(".md")),
      "Artifact contract: summary file exists"
    ),
    assertCondition(
      !sourceUrls.includes("https://example.com/old"),
      "Time window: items older than window_days are excluded"
    ),
    assertCondition(
      runData.timestamp_tier_counts.T1 === 9,
      "Timestamp tiering: ISO timestamps counted as T1"
    ),
    assertCondition(
      runData.timestamp_tier_counts.T4 === 1,
      "Timestamp tiering: missing timestamps counted as T4"
    ),
    assertCondition(
      runData.counts.excluded_t4 === 1 && runData.counts.kept === 9,
      "Timestamp policy: allow_t4=false excludes T4 items"
    ),
    assertCondition(
      uniqueUrls.size === sources.length && sourceUrls.filter((url) => url === "https://example.com/dup").length === 1,
      "Dedupe: duplicate URLs only appear once in sources output"
    ),
    assertCondition(
      perSourceSum === runData.counts.kept,
      "Telemetry: per_source_counts sums to kept item count"
    ),
    assertCondition(
      perSourceCounts.reddit === 4 && perSourceCounts.hn === 4 && perSourceCounts.github_issue === 1,
      "Telemetry: per_source_counts per source values are correct"
    ),
    assertCondition(
      runData.counts.excluded_missing_timestamp === 1,
      "Telemetry: excluded_missing_timestamp increments as expected"
    ),
    assertCondition(
      resultA.flags.every((flag) => !flag.endsWith("FETCH_FAILED")),
      "Failure behavior: no fetch failure flags in offline mode"
    ),
    assertCondition(
      signalforgeItems.length === 2 && new Set(signalforgeItems.map((item) => item.idea_cluster_id)).size === 1,
      "Idea clustering: shared signature items map to same idea_cluster_id"
    ),
    assertCondition(
      signalforgeItems.every((item) => item.origin_count === 2),
      "Idea clustering: origin_count increases across different domains"
    ),
    assertCondition(
      quantumItems.length === 3 && quantumItems.every((item) => item.origin_count === 1),
      "Idea clustering: reposts from same domain share a single origin"
    ),
    assertCondition(
      quantumItems.length > 0 && quantumItems.every((item) => item.echo_risk >= 0.6),
      "Idea clustering: echo_risk is high for repost-heavy clusters"
    ),
    assertCondition(
      githubItem?.evidence_grade === "implementation-confirmed",
      "Evidence grading: github sources yield implementation-confirmed grade"
    ),
    assertCondition(
      runData.idea_cluster_count === 5,
      "Telemetry: idea_cluster_count tracks unique idea clusters"
    ),
    assertCondition(
      runData.origin_count_stats.min === 1 &&
        runData.origin_count_stats.median === 1 &&
        runData.origin_count_stats.max === 2,
      "Telemetry: origin_count_stats min/median/max are correct"
    ),
    assertCondition(
      runData.echo_risk_stats.min === 0 &&
        runData.echo_risk_stats.median === 0 &&
        runData.echo_risk_stats.max >= 0.6,
      "Telemetry: echo_risk_stats min/median/max are correct"
    ),
    assertCondition(
      runData.evidence_grade_counts[\"discussion-only\"] === 4 &&
        runData.evidence_grade_counts[\"implementation-confirmed\"] === 1,
      "Telemetry: evidence_grade_counts map is populated"
    ),
    assertCondition(
      fs.existsSync(resultA.artifacts.context_block),
      "Artifact contract: context_block path exists"
    ),
    assertCondition(fs.existsSync(resultA.artifacts.sources), "Artifact contract: sources path exists"),
    assertCondition(fs.existsSync(resultA.artifacts.run), "Artifact contract: run path exists"),
    assertCondition(fs.existsSync(resultA.artifacts.summary), "Artifact contract: summary path exists")
  ];

  return collectResults(checks);
}

async function runLiveSmoke(): Promise<string[]> {
  if (process.env.SIGNALFORGE_LIVE_SMOKE !== "1") {
    return [];
  }

  const warnings: string[] = [];
  try {
    const liveResult = await runEngine({
      query: "OpenAI developer workflow",
      window_days: 7,
      sources: ["hn"],
      top_n: 5
    });

    const sources = readJson<Array<{ source: string }>>(liveResult.artifacts.sources);
    const runData = readJson<{ timestamp_tier_counts: Record<string, number> }>(liveResult.artifacts.run);

    if (!fs.existsSync(liveResult.artifacts.run_folder)) {
      warnings.push("Live smoke: run folder missing");
    }
    if (sources.length === 0) {
      warnings.push("Live smoke: no items returned from HN");
    }
    if (!sources.some((item) => item.source === "hn")) {
      warnings.push("Live smoke: no HN items found in sources");
    }
    if ((runData.timestamp_tier_counts.T1 ?? 0) < 1) {
      warnings.push("Live smoke: expected at least one T1 timestamp tier");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    warnings.push(`Live smoke warning: ${message}`);
  }

  return warnings;
}

async function main(): Promise<void> {
  const offline = await runOfflineSmoke();
  const liveWarnings = await runLiveSmoke();

  if (offline.failures.length === 0) {
    console.log("Offline smoke: PASS");
  } else {
    console.error("Offline smoke: FAIL");
    for (const failure of offline.failures) {
      console.error(` - ${failure.details ?? failure.name}`);
    }
  }

  if (liveWarnings.length > 0) {
    console.warn("Live smoke warnings:");
    for (const warning of liveWarnings) {
      console.warn(` - ${warning}`);
    }
  } else if (process.env.SIGNALFORGE_LIVE_SMOKE === "1") {
    console.log("Live smoke: PASS");
  }

  console.log(
    `Smoke summary: ${offline.failures.length === 0 ? "PASS" : "FAIL"} (${offline.passes.length} passed, ${
      offline.failures.length
    } failed)`
  );

  if (offline.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Smoke runner crashed.");
  console.error(error);
  process.exitCode = 1;
});
