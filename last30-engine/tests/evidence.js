"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { adjudicateEvidence } = require("../dist/engine/evidence/adjudicate");
const { runEngine } = require("../dist/engine/runEngine");
const { closeDb } = require("../dist/storage/db");
const { recordDecision, recordOutcome, getDecision } = require("../dist/storage/decisions");

const runDate = "2024-02-10";
const recent = "2024-02-09T12:00:00.000Z";
const old = "2024-01-01T12:00:00.000Z";
const source = (title, url, extras = {}) => ({
  title, url, snippet: title, published_at: recent, source: "hn", ...extras
});

test("strict window, timestamp tiers, duplicate URLs, and stable snapshot hash", () => {
  const input = [
    source("Claim A", "https://a.example/post?utm_source=x", { claim_key: "claim A", stance: "supports", originator_id: "lab-a" }),
    source("Claim A repost", "https://a.example/post?utm_source=y", { claim_key: "claim A", stance: "supports" }),
    source("Old", "https://a.example/old", { published_at: old }),
    source("Future", "https://a.example/future", { published_at: "2024-02-11T00:00:00Z" }),
    source("Missing", "https://a.example/missing", { published_at: null }),
    source("Invalid date", "https://a.example/bad-date", { published_at: "yesterday" }),
    source("Bad URL", "file:///tmp/secret"),
    source("Publisher", "https://a.example/publisher", { timestamp_basis: "publisher" }),
    source("Inferred", "https://a.example/inferred", { timestamp_basis: "inferred" })
  ];
  const a = adjudicateEvidence(input, runDate, 7);
  const b = adjudicateEvidence([...input].reverse(), runDate, 7);
  assert.deepEqual(a, b);
  assert.equal(a.accepted.length, 3);
  assert.deepEqual(new Set(a.rejected.map((r) => r.reason)),
    new Set(["DUPLICATE_URL", "OUTSIDE_WINDOW", "FUTURE_TIMESTAMP", "MISSING_TIMESTAMP", "INVALID_TIMESTAMP", "INVALID_URL"]));
  assert.deepEqual(new Set(a.accepted.map((r) => r.timestamp_tier)), new Set(["T1", "T2", "T3"]));
  assert.equal(a.artifact_id, `evidence:${a.evidence_hash}`);
  assert.equal(a.evidence_hash,
    crypto.createHash("sha256").update(JSON.stringify({
      schema_version: a.schema_version, run_date: a.run_date, reference_at: a.reference_at,
      window_days: a.window_days,
      accepted: a.accepted, rejected: a.rejected, claims: a.claims, flags: a.flags
    })).digest("hex"));
});

test("shared primary source is one family; explicit independent counter-evidence contests a claim", () => {
  const base = [
    source("Tool X is safe", "https://a.example/analysis", {
      claim_key: "Tool X safety", stance: "supports", primary_url: "https://research.example/study"
    }),
    source("Tool X safe repost", "https://b.example/analysis", {
      claim_key: "Tool X safety", stance: "supports", primary_url: "https://research.example/study?utm_campaign=echo"
    })
  ];
  const echoed = adjudicateEvidence(base, runDate, 7).claims[0];
  assert.equal(echoed.observed_families, 1);
  assert.equal(echoed.independent_support_families, 1);
  assert.equal(echoed.status, "single_origin");

  const corroborated = adjudicateEvidence([...base,
    source("Independent replication", "https://c.example/replication", {
      claim_key: "Tool X safety", stance: "supports", originator_id: "lab-c"
    })
  ], runDate, 7).claims[0];
  assert.equal(corroborated.status, "corroborated");
  assert.equal(corroborated.independent_support_families, 2);

  const contested = adjudicateEvidence([...base,
    source("Independent replication", "https://c.example/replication", {
      claim_key: "Tool X safety", stance: "supports", originator_id: "lab-c"
    }),
    source("Counter study", "https://d.example/counter", {
      claim_key: "Tool X safety", stance: "refutes", originator_id: "lab-d"
    })
  ], runDate, 7);
  assert.equal(contested.claims[0].status, "contested");
  assert.equal(contested.claims[0].counter_ids.length, 1);
  assert.ok(contested.flags.includes("CONTRADICTORY_EVIDENCE"));

  const unverified = adjudicateEvidence([
    source("Opinion", "https://e.example/opinion", { claim_key: "Tool X safety", stance: "supports" })
  ], runDate, 7);
  assert.equal(unverified.claims[0].independent_support_families, 0);
  assert.equal(unverified.claims[0].dependence_unverified, true);
});

test("aging evidence requests revalidation", () => {
  const snapshot = adjudicateEvidence([
    source("Aging advice", "https://a.example/aging", {
      published_at: "2024-02-04T12:00:00Z", stance: "supports", originator_id: "lab-a"
    })
  ], runDate, 7);
  assert.equal(snapshot.claims[0].revalidation, "revalidate_soon");
  assert.ok(snapshot.flags.includes("REVALIDATION_DUE_SOON"));
});

test("collector failure, immutable artifacts, decision linkage, and outcome history", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-evidence-"));
  process.env.SIGNALFORGE_DB_PATH = path.join(temp, "test.db");
  const item = source("Tool X is safe", "https://a.example/analysis", {
    claim_key: "Tool X safety", stance: "supports", originator_id: "lab-a"
  });
  const options = {
    query: "Tool X safety", sources: ["hn"], run_date: runDate, window_days: 7, top_n: 5,
    collectors: { hn: async () => [item] }
  };
  try {
    const first = await runEngine(options);
    const firstBytes = fs.readFileSync(first.artifacts.evidence);
    const firstRunBytes = fs.readFileSync(first.artifacts.run);
    const second = await runEngine(options);
    assert.equal(first.run_id, second.run_id);
    assert.deepEqual(fs.readFileSync(second.artifacts.evidence), firstBytes);
    assert.deepEqual(fs.readFileSync(second.artifacts.run), firstRunBytes);
    const evidence = JSON.parse(firstBytes);
    const run = JSON.parse(firstRunBytes);
    assert.equal(run.artifact_id, evidence.artifact_id);
    assert.equal(run.evidence_hash, evidence.evidence_hash);
    assert.ok(fs.readFileSync(first.artifacts.context_block, "utf8").includes(item.url));

    const changed = await runEngine({
      ...options, collectors: { hn: async () => [{ ...item, snippet: "New observable fact" }] }
    });
    assert.notEqual(changed.run_id, first.run_id);
    assert.ok(fs.existsSync(first.artifacts.evidence));
    assert.ok(fs.existsSync(changed.artifacts.evidence));

    const annotated = await runEngine({
      ...options,
      query: "operator annotation",
      annotations: {
        [item.url]: { claim_key: "operator claim", stance: "refutes", originator_id: "operator-reviewed-origin" }
      }
    });
    const annotatedRecord = JSON.parse(fs.readFileSync(annotated.artifacts.evidence)).accepted[0];
    assert.equal(annotatedRecord.metadata_origin, "operator");
    assert.equal(annotatedRecord.stance, "refutes");
    assert.equal(annotatedRecord.claim_key, "operator claim");

    const failed = await runEngine({
      ...options, query: "failed collector", collectors: { hn: async () => { throw new Error("offline"); } }
    });
    assert.ok(failed.flags.includes("HN_FETCH_FAILED"));
    assert.equal(JSON.parse(fs.readFileSync(failed.artifacts.evidence)).accepted.length, 0);

    assert.throws(() => recordDecision({
      run_id: first.run_id, artifact_id: "wrong", question: "Use Tool X?", choice: "yes",
      rationale: "Pilot", claim_ids: [evidence.claims[0].claim_id]
    }), /do not match/);
    assert.throws(() => recordDecision({
      run_id: first.run_id, artifact_id: evidence.artifact_id, question: "Use Tool X?", choice: "yes",
      rationale: "Pilot", claim_ids: ["claim:unknown"]
    }), /unknown claim/);
    const decisionInput = {
      run_id: first.run_id, artifact_id: evidence.artifact_id, question: "Use Tool X?",
      choice: "Pilot", rationale: "One source warrants a bounded trial",
      claim_ids: [evidence.claims[0].claim_id]
    };
    const decision = recordDecision(decisionInput);
    assert.deepEqual(recordDecision(decisionInput), decision);
    const outcome = recordOutcome({
      decision_id: decision.decision_id, observed_at: "2024-03-10T00:00:00Z",
      rating: 3, notes: "Partial improvement", confounders: ["team change"]
    });
    assert.equal(getDecision(decision.decision_id).outcomes[0].id, outcome.outcome_id);
    assert.throws(() => recordOutcome({
      decision_id: decision.decision_id, observed_at: recent, rating: 6, notes: ""
    }), /rating/);
  } finally {
    closeDb();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
