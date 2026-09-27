"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runEngine } = require("../dist/engine/runEngine");
const { getReview, recordReview } = require("../dist/storage/reviews");
const { recordDecision } = require("../dist/storage/decisions");
const { closeDb } = require("../dist/storage/db");

const date = "2026-09-26T12:00:00Z";
const base = (title, url, extras = {}) => ({
  title, url, snippet: title, published_at: date, source: "hn", ...extras
});

// One end-to-end offline run exercises persistence, immutable review lineage, and decisions.
test("review candidates, auditable changes, evidence lineage, conflicts, and decisions", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-review-"));
  const cwd = process.cwd();
  const oldDb = process.env.SIGNALFORGE_DB_PATH;
  process.chdir(temp);
  process.env.SIGNALFORGE_DB_PATH = path.join(temp, "review.db");
  t.after(() => {
    closeDb(); process.chdir(cwd);
    if (oldDb === undefined) delete process.env.SIGNALFORGE_DB_PATH;
    else process.env.SIGNALFORGE_DB_PATH = oldDb;
    fs.rmSync(temp, {recursive:true, force:true});
  });
  const supportUrl = "https://lab.example/paper";
  const refuteUrl = "https://review.example/rebuttal";
  const run = await runEngine({
    query:"review workflow", run_date:"2026-09-27", sources:["hn"],
    collectors:{hn: async () => [
      base("Tool A is safe", supportUrl),
      base("Tool A safety disputed", refuteUrl),
      base("Missing date", "https://lab.example/missing", {published_at:null})
    ]}
  });
  const start = getReview(run.run_id);
  assert.equal(start.candidates.length, 2);
  assert.equal(start.snapshot.rejected.length, 1);
  assert.equal(start.history.length, 0);
  assert.ok(start.candidates.every(c => c.status === "unassessed"));
  const baseId = start.snapshot.artifact_id;
  const first = recordReview(run.run_id, {
    base_artifact_id:baseId, rationale:"Shared proposition and distinct primary sources inspected",
    edits:[
      {url:supportUrl, claim_key:"Tool A safety", stance:"supports", originator_id:"lab-one",
       incentives:"Sells the tool", channels:["newsletter", "blog"]},
      {url:refuteUrl, claim_key:"Tool A safety", stance:"refutes", primary_url:"https://independent.example/study?utm_source=feed"}
    ]
  });
  assert.notEqual(first.artifact_id, baseId);
  const current = getReview(run.run_id);
  assert.equal(current.snapshot.schema_version, 2);
  assert.equal(current.snapshot.rejected.length, 1);
  assert.equal(current.snapshot.claims.length, 1);
  assert.equal(current.snapshot.claims[0].status, "contested");
  assert.equal(current.ranked_claims[0].status, "contested");
  assert.ok(current.snapshot.flags.includes("CONTRADICTORY_EVIDENCE"));
  assert.equal(current.snapshot.accepted.find(x=>x.url===supportUrl).incentives, "Sells the tool");
  assert.deepEqual(current.snapshot.accepted.find(x=>x.url===supportUrl).channels, ["blog", "newsletter"]);
  assert.equal(current.snapshot.accepted.find(x=>x.url===refuteUrl).primary_url, "https://independent.example/study");
  assert.equal(current.history[0].parent_artifact_id, baseId);
  assert.equal(getReview(run.run_id, baseId).snapshot.claims.length, 2);
  assert.equal(getReview(run.run_id, first.artifact_id).snapshot.claims[0].status, "contested");
  assert.equal(JSON.parse(fs.readFileSync(run.artifacts.evidence, "utf8")).artifact_id, baseId);
  assert.throws(() => recordReview(run.run_id, {
    base_artifact_id:baseId, rationale:"Stale", edits:[{url:supportUrl, stance:"neutral"}]
  }), e=>e.status===409);
  assert.throws(() => recordReview(run.run_id, {
    base_artifact_id:first.artifact_id, rationale:"Invented URL", edits:[{url:"https://fake.example/", stance:"supports"}]
  }), e=>e.status===400);
  assert.throws(() => recordReview(run.run_id, {
    base_artifact_id:first.artifact_id, rationale:"Bad source", edits:[{url:supportUrl, primary_url:"file:///tmp/source"}]
  }), e=>e.status===400);
  assert.throws(() => recordReview(run.run_id, {
    base_artifact_id:first.artifact_id, rationale:"Duplicate", edits:[
      {url:supportUrl, stance:"neutral"}, {url:supportUrl, stance:"refutes"}]
  }), e=>e.status===400);
  const second = recordReview(run.run_id, {
    base_artifact_id:first.artifact_id, rationale:"Counterargument resolved after primary read",
    edits:[{url:refuteUrl, stance:"neutral", incentives:"Unknown"}]
  });
  const revised = getReview(run.run_id);
  assert.equal(revised.history.length, 2);
  assert.equal(revised.snapshot.claims[0].status, "single_origin");
  assert.equal(revised.ranked_claims[0].status, "single_origin");
  assert.ok(revised.ranked_claims[0].score > current.ranked_claims[0].score);
  assert.equal(revised.history[1].parent_artifact_id, first.artifact_id);
  assert.notEqual(second.artifact_id, first.artifact_id);
  assert.equal(getReview(run.run_id, first.artifact_id).snapshot.claims[0].status, "contested");
  const decision = recordDecision({run_id:run.run_id, artifact_id:first.artifact_id,
    question:"Adopt?", choice:"Wait", rationale:"Counter-evidence", claim_ids:[current.snapshot.claims[0].claim_id]});
  assert.equal(decision.artifact_id, first.artifact_id);
  assert.throws(() => recordDecision({run_id:run.run_id, artifact_id:first.artifact_id,
    question:"Adopt?", choice:"Wait", rationale:"Counter-evidence", claim_ids:[start.snapshot.claims[0].claim_id]}),
  /unknown claim/);
  assert.equal(getReview("missing"), null);
  assert.equal(getReview(run.run_id, "evidence:fake"), null);
});
