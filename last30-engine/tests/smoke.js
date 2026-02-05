"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {Object} SmokeResult
 * @property {string} name
 * @property {boolean} passed
 * @property {string=} details
 */

/**
 * @returns {{ runEngine: import("../engine/runEngine").runEngine }}
 */
function loadRunEngine() {
  const distRunEngine = path.join(__dirname, "..", "dist", "engine", "runEngine.js");
  if (fs.existsSync(distRunEngine)) {
    return require(distRunEngine);
  }

  const tsNodeRegister = path.join(
    __dirname,
    "..",
    "node_modules",
    "ts-node",
    "register",
    "transpile-only.js"
  );
  if (fs.existsSync(tsNodeRegister)) {
    require(tsNodeRegister);
    return require(path.join(__dirname, "..", "engine", "runEngine.ts"));
  }

  console.error("Smoke runner could not locate a compiled engine or ts-node register.");
  console.error("Run `npm run build` to generate dist output or install dev dependencies.");
  process.exit(1);
}

/**
 * @returns {{ closeDb: import("../storage/db").closeDb }}
 */
function loadStorage() {
  const distStorage = path.join(__dirname, "..", "dist", "storage", "db.js");
  if (fs.existsSync(distStorage)) {
    return require(distStorage);
  }

  const tsNodeRegister = path.join(
    __dirname,
    "..",
    "node_modules",
    "ts-node",
    "register",
    "transpile-only.js"
  );
  if (fs.existsSync(tsNodeRegister)) {
    require(tsNodeRegister);
    return require(path.join(__dirname, "..", "storage", "db.ts"));
  }

  console.error("Smoke runner could not locate compiled storage or ts-node register.");
  process.exit(1);
}

const { runEngine } = loadRunEngine();
const { closeDb } = loadStorage();

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 40) || "run"
  );
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {SmokeResult}
 */
function assertCondition(condition, message) {
  return { name: message, passed: condition, details: condition ? undefined : message };
}

/**
 * @template T
 * @param {string} filePath
 * @returns {T}
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * @param {SmokeResult[]} results
 * @returns {{ failures: SmokeResult[]; passes: SmokeResult[] }}
 */
function collectResults(results) {
  const failures = results.filter((result) => !result.passed);
  const passes = results.filter((result) => result.passed);
  return { failures, passes };
}

async function runOfflineSmoke() {
  const fixedNow = new Date("2024-02-10T12:00:00Z");
  const fixedRunDate = "2024-02-10";
  const originalDateNow = Date.now;
  Date.now = () => fixedNow.getTime();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-smoke-"));
  const tempDbPath = path.join(tempDir, "signalforge.db");
  process.env.SIGNALFORGE_DB_PATH = tempDbPath;

  const recentIso = new Date(fixedNow.getTime() - 2 * ONE_DAY_MS).toISOString();
  const oldIso = new Date(fixedNow.getTime() - 10 * ONE_DAY_MS).toISOString();
  const baselineUrl = "https://baseline.example.com/cli-launch";

  const fakeRedditCollector = async () => ({
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

  const baselineCollector = async () => ({
    items: [
      {
        title: "SignalForge CLI launch",
        url: baselineUrl,
        snippet: "SignalForge CLI launch",
        published_at: oldIso,
        source: "reddit"
      }
    ],
    failed: false,
    strategy_used: "reddit_json",
    excluded_missing_timestamp: 0
  });

  const fakeHnCollector = async () => [
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

  const fakeGithubCollector = async () => ({
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

  const highEchoCollector = async () => ({
    items: [
      {
        title: "Echo cluster event",
        url: "https://echo.example.com/item-a",
        snippet: "Echo cluster event details.",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Echo cluster event",
        url: "https://echo.example.com/item-b",
        snippet: "Echo cluster event details.",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Echo cluster event",
        url: "https://echo.example.com/item-c",
        snippet: "Echo cluster event details.",
        published_at: recentIso,
        source: "reddit"
      }
    ],
    failed: false,
    strategy_used: "reddit_json",
    excluded_missing_timestamp: 0
  });

  const lowVolumeCollector = async () => ({
    items: [
      {
        title: "Low volume item A",
        url: "https://low.example.com/item-a",
        snippet: "Low volume item.",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Low volume item B",
        url: "https://low.example.com/item-b",
        snippet: "Low volume item.",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Low volume item C",
        url: "https://low.example.com/item-c",
        snippet: "Low volume item.",
        published_at: recentIso,
        source: "reddit"
      }
    ],
    failed: false,
    strategy_used: "reddit_json",
    excluded_missing_timestamp: 0
  });

  const t4Collector = async () => ({
    items: [
      {
        title: "Timestamped item",
        url: "https://timestamp.example.com/t1",
        snippet: "Timestamped item.",
        published_at: recentIso,
        source: "reddit"
      },
      {
        title: "Missing timestamp item",
        url: "https://timestamp.example.com/t4",
        snippet: "Missing timestamp item.",
        published_at: null,
        source: "reddit"
      }
    ],
    failed: false,
    strategy_used: "reddit_json",
    excluded_missing_timestamp: 1
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

  await runEngine({
    query: options.query,
    window_days: 30,
    sources: ["reddit"],
    top_n: 5,
    allow_t4: false,
    run_date: "2024-02-01",
    collectors: {
      reddit: baselineCollector
    }
  });

  const resultA = await runEngine(options);
  const resultB = await runEngine(options);
  const highEchoResult = await runEngine({
    query: "High Echo Query",
    window_days: 7,
    sources: ["reddit"],
    top_n: 5,
    allow_t4: true,
    run_date: fixedRunDate,
    collectors: {
      reddit: highEchoCollector
    }
  });
  const lowVolumeResult = await runEngine({
    query: "Low Volume Query",
    window_days: 7,
    sources: ["reddit"],
    top_n: 5,
    allow_t4: true,
    run_date: fixedRunDate,
    collectors: {
      reddit: lowVolumeCollector
    }
  });
  const allowT4Result = await runEngine({
    query: "Allow T4 Query",
    window_days: 7,
    sources: ["reddit"],
    top_n: 5,
    allow_t4: true,
    run_date: fixedRunDate,
    collectors: {
      reddit: t4Collector
    }
  });
  const disallowT4Result = await runEngine({
    query: "Disallow T4 Query",
    window_days: 7,
    sources: ["reddit"],
    top_n: 5,
    allow_t4: false,
    run_date: fixedRunDate,
    collectors: {
      reddit: t4Collector
    }
  });

  Date.now = originalDateNow;

  const runFolder = resultA.artifacts.run_folder;
  const runFiles = fs.readdirSync(runFolder);
  const sources = readJson(resultA.artifacts.sources);
  const runData = readJson(resultA.artifacts.run);
  const summaryText = fs.readFileSync(resultA.artifacts.summary, "utf8");
  const contextBlockText = fs.readFileSync(resultA.artifacts.context_block, "utf8");
  const highEchoRun = readJson(highEchoResult.artifacts.run);
  const lowVolumeRun = readJson(lowVolumeResult.artifacts.run);
  const allowT4Run = readJson(allowT4Result.artifacts.run);
  const disallowT4Run = readJson(disallowT4Result.artifacts.run);

  const expectedRunFolderSuffix = path.join("runs", fixedRunDate, slugify(options.query));
  const sourceUrls = sources.map((item) => item.url);
  const uniqueUrls = new Set(sourceUrls);
  const perSourceCounts = runData.counts.per_source_counts;
  const perSourceSum = Object.values(perSourceCounts).reduce((sum, value) => sum + value, 0);
  const signalforgeItems = sources.filter((item) => item.title === "SignalForge CLI launch");
  const quantumItems = sources.filter((item) => item.title === "Quantum widget leak");
  const githubItem = sources.find((item) => item.source === "github_issue");
  const baselineDate = oldIso.slice(0, 10);

  const checks = [
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
      uniqueUrls.size === sources.length &&
        sourceUrls.filter((url) => url === "https://example.com/dup").length === 1,
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
      runData.evidence_grade_counts["discussion-only"] === 4 &&
        runData.evidence_grade_counts["implementation-confirmed"] === 1,
      "Telemetry: evidence_grade_counts map is populated"
    ),
    assertCondition(
      runData.baseline?.lookback_days === 180 &&
        runData.baseline?.clusters_with_baseline >= 1 &&
        runData.baseline?.total_baseline_items_attached >= 1,
      "Telemetry: baseline metadata is populated"
    ),
    assertCondition(
      typeof runData.integrity?.components?.timestamp === "number" &&
        typeof runData.integrity?.components?.sources === "number" &&
        typeof runData.integrity?.components?.independence === "number" &&
        typeof runData.integrity?.components?.evidence === "number" &&
        typeof runData.integrity?.components?.baseline === "number",
      "Integrity: components are persisted in run.json"
    ),
    assertCondition(
      highEchoResult.flags.includes("DEGRADED_SIGNAL_HIGH_ECHO_RISK") &&
        highEchoRun.integrity.components.independence <= 8,
      "Integrity: high echo risk run emits degraded flag and lowers independence score"
    ),
    assertCondition(
      lowVolumeResult.flags.includes("DEGRADED_SIGNAL_LOW_VOLUME"),
      "Integrity: low kept volume emits degraded low volume flag"
    ),
    assertCondition(
      disallowT4Run.integrity.components.timestamp > allowT4Run.integrity.components.timestamp,
      "Integrity: excluding T4 improves timestamp component"
    ),
    assertCondition(
      !sourceUrls.includes(baselineUrl),
      "Baseline anchors: baseline items do not appear in top claims ranking"
    ),
    assertCondition(
      summaryText.includes("WHAT CHANGED VS BASELINE") &&
        summaryText.includes(`Baseline: SignalForge CLI launch (${baselineDate})`),
      "Artifacts: summary includes baseline anchors"
    ),
    assertCondition(
      contextBlockText.includes("WHAT CHANGED VS BASELINE") &&
        contextBlockText.includes(`Baseline: SignalForge CLI launch (${baselineDate})`),
      "Artifacts: context block includes baseline anchors"
    ),
    assertCondition(
      fs.existsSync(resultA.artifacts.context_block),
      "Artifact contract: context_block path exists"
    ),
    assertCondition(fs.existsSync(resultA.artifacts.sources), "Artifact contract: sources path exists"),
    assertCondition(fs.existsSync(resultA.artifacts.run), "Artifact contract: run path exists"),
    assertCondition(fs.existsSync(resultA.artifacts.summary), "Artifact contract: summary path exists")
  ];

  const results = collectResults(checks);
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  return results;
}

async function runLiveSmoke() {
  if (process.env.SIGNALFORGE_LIVE_SMOKE !== "1") {
    return [];
  }

  const warnings = [];
  try {
    const liveResult = await runEngine({
      query: "OpenAI developer workflow",
      window_days: 7,
      sources: ["hn"],
      top_n: 5
    });

    const sources = readJson(liveResult.artifacts.sources);
    const runData = readJson(liveResult.artifacts.run);

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

async function main() {
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
