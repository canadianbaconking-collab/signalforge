"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { adjudicateEvidence } = require("../dist/engine/evidence/adjudicate");
const { compareSnapshots, makeDecisionSnapshot, verifySnapshot } = require("../dist/engine/evidence/compare");
const { closeDb, insertRun, getDb } = require("../dist/storage/db");
const { recordDecision, getDecision } = require("../dist/storage/decisions");
const {
  recordComparison, recordDecisionSnapshot, getDerivedArtifact, loadEvidenceArtifact
} = require("../dist/storage/derivedArtifacts");

const evidence = (id, claim, stance, origin, published = "2026-09-20T12:00:00Z") => ({
  title: claim, url: `https://source${id}.example/item`, snippet: claim,
  source: "hn", published_at: published, claim_key: claim, stance,
  primary_url: `https://origin.example/${origin}`
});
const make = (records, day) => adjudicateEvidence(records, day, 30, [], `${day}T23:59:59.999Z`);

test("comparison distinguishes support loss, counterevidence gain, and echo families", () => {
  const from = make([
    evidence(1, "use engine X", "supports", "one"),
    evidence(2, "use engine X", "supports", "two"),
    evidence(3, "use engine X", "supports", "two")
  ], "2026-09-21");
  const to = make([
    evidence(1, "use engine X", "supports", "one"),
    evidence(4, "use engine X", "refutes", "three")
  ], "2026-09-27");
  const comparison = compareSnapshots(from, to);
  const change = comparison.changes[0];
  assert.equal(change.change, "changed");
  assert.equal(change.before.status, "corroborated");
  assert.equal(change.after.status, "contested");
  assert.equal(change.lost_support_families.length, 1);
  assert.equal(change.gained_counter_families.length, 1);
  assert.equal(change.lost_evidence_ids.length, 2);
  assert.deepEqual(change.changed_evidence_ids, []);
  assert.deepEqual(comparison.flags, [
    "CONTRADICTORY_EVIDENCE", "COUNTER_EVIDENCE_GAINED", "INDEPENDENT_SUPPORT_LOST"
  ]);
  assert.equal(compareSnapshots(from, to).comparison_id, comparison.comparison_id);
  assert.equal(makeDecisionSnapshot(to, "Use engine X?", comparison).comparison_id, comparison.comparison_id);
});

test("comparison detects removed stale claims and added claims without treating them as same identity", () => {
  const old = make([evidence(1, "claim A", "supports", "one", "2026-09-01T12:00:00Z")], "2026-09-02");
  const newer = make([evidence(2, "claim B", "supports", "two", "2026-10-10T12:00:00Z")], "2026-10-15");
  const result = compareSnapshots(old, newer);
  assert.deepEqual(result.changes.map(x => x.change).sort(), ["added", "removed"]);
  assert.ok(result.changes.some(x => x.change === "removed" && x.revalidation_at_target === "due"));
  assert.ok(result.flags.includes("REVALIDATION_DUE"));
  assert.throws(() => compareSnapshots(newer, old), /later/);
});

test("missing target support carries collector failure as an explicit caveat", () => {
  const from = make([evidence(1, "claim A", "supports", "one")], "2026-09-21");
  const to = adjudicateEvidence([], "2026-09-27", 30,
    ["HN_FETCH_FAILED"], "2026-09-27T23:59:59.999Z");
  const result = compareSnapshots(from, to);
  assert.equal(result.changes[0].change, "removed");
  assert.deepEqual(result.to_flags, ["HN_FETCH_FAILED"]);
  assert.ok(result.flags.includes("TARGET_COLLECTOR_FAILURE"));
});

test("hash verification rejects mutated evidence and deterministic briefs retain rejections", () => {
  const snapshot = make([
    evidence(1, "claim A", "supports", "one"),
    evidence(2, "claim A", "refutes", "two", "2026-07-01T12:00:00Z")
  ], "2026-09-27");
  verifySnapshot(snapshot);
  const brief = makeDecisionSnapshot(snapshot, "Should I choose A?");
  assert.equal(brief.rejected_evidence.length, 1);
  assert.ok(brief.unresolved.includes("REJECTED_EVIDENCE_PRESENT"));
  assert.equal(brief.snapshot_id, makeDecisionSnapshot(snapshot, "Should I choose A?").snapshot_id);
  assert.throws(() => makeDecisionSnapshot(snapshot, " "), /question/);
  const tampered = structuredClone(snapshot);
  tampered.accepted[0].title = "changed";
  assert.throws(() => verifySnapshot(tampered), /hash mismatch/);
});

test("review-only provenance edits are linked by URL across changed evidence IDs", () => {
  const original = make([evidence(1, "claim A", "supports", "one")], "2026-09-27");
  // Rebuild through the public review reducer so the content address remains valid.
  const { reviewEvidenceSnapshot } = require("../dist/engine/evidence/adjudicate");
  const updated = reviewEvidenceSnapshot(original, new Map([[
    original.accepted[0].url, { incentives: "vendor funded" }
  ]]));
  const comparison = compareSnapshots(original, updated);
  assert.equal(comparison.changes[0].change, "changed");
  assert.deepEqual(comparison.changes[0].revised_evidence, [{
    url: original.accepted[0].url,
    before_id: original.accepted[0].evidence_id,
    after_id: updated.accepted[0].evidence_id
  }]);
});

test("stored comparison and brief are content addressed and linked to exact evidence artifacts", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-comparison-"));
  const previous = process.env.SIGNALFORGE_DB_PATH;
  process.env.SIGNALFORGE_DB_PATH = path.join(dir, "evidence.db");
  t.after(() => {
    closeDb();
    if (previous === undefined) delete process.env.SIGNALFORGE_DB_PATH;
    else process.env.SIGNALFORGE_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const from = make([evidence(1, "claim A", "supports", "one")], "2026-09-21");
  const to = make([evidence(1, "claim A", "supports", "one"), evidence(2, "claim A", "refutes", "two")], "2026-09-27");
  for (const [id, snapshot] of [["run-a", from], ["run-b", to]]) {
    insertRun({
      id, query: "claim A", window_days: 30, target: "self", mode: "default",
      created_at: snapshot.reference_at, integrity_score: 50, flags: [],
      evidence: snapshot
    }, []);
  }
  const comparison = recordComparison(from.artifact_id, to.artifact_id);
  const brief = recordDecisionSnapshot(to.artifact_id, "Choose A?", comparison.comparison_id);
  assert.deepEqual(getDerivedArtifact(comparison.comparison_id), comparison);
  assert.deepEqual(getDerivedArtifact(brief.snapshot_id), brief);
  const saved = recordDecision({
    run_id: "run-b", artifact_id: to.artifact_id, question: "Choose A?",
    choice: "wait", rationale: "Counterevidence needs review",
    claim_ids: [to.claims[0].claim_id], decision_snapshot_id: brief.snapshot_id
  });
  assert.equal(getDecision(saved.decision_id).decision_snapshot_id, brief.snapshot_id);
  assert.throws(() => recordDecision({
    run_id: "run-a", artifact_id: from.artifact_id, question: "Choose A?",
    choice: "wait", rationale: "wrong snapshot",
    claim_ids: [from.claims[0].claim_id], decision_snapshot_id: brief.snapshot_id
  }), /exact evidence artifact/);
  assert.equal(recordComparison(from.artifact_id, to.artifact_id).comparison_id, comparison.comparison_id);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM derived_artifacts").get().n, 2);
  assert.throws(() => recordDecisionSnapshot(from.artifact_id, "Choose A?", comparison.comparison_id), /target/);
  getDb().prepare("UPDATE derived_artifacts SET content_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...comparison, flags: [] }), comparison.comparison_id);
  assert.throws(() => getDerivedArtifact(comparison.comparison_id), /verification/);
  getDb().prepare("UPDATE runs SET evidence_json = ? WHERE id = ?").run(
    JSON.stringify({ ...from, evidence_hash: "0".repeat(64) }), "run-a"
  );
  assert.throws(() => loadEvidenceArtifact(from.artifact_id), /verification/);
});
