"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runEngine } = require("../dist/engine/runEngine");
const { rankSnapshot } = require("../dist/engine/ranking/claimRanking");
const { getReview, recordReview } = require("../dist/storage/reviews");
const { closeDb, getDb } = require("../dist/storage/db");
const date = "2026-09-26T12:00:00Z";
const item = (n, originator, stance = "supports", extras = {}) => ({
  title: "Same exact proposition", url: `https://source${n}.example/story`,
  snippet: "Source observation", published_at: date, source: "hn",
  claim_key: "Exact proposition", primary_url: `https://research.example/${originator}`,
  stance, ...extras
});

test("A-B-A replay preserves the original response, database row, and artifact bytes", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-replay-"));
  const previous = process.env.SIGNALFORGE_DB_PATH;
  process.env.SIGNALFORGE_DB_PATH = path.join(temp, "history.db");
  t.after(() => {
    closeDb();
    if (previous === undefined) delete process.env.SIGNALFORGE_DB_PATH;
    else process.env.SIGNALFORGE_DB_PATH = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const run = query => runEngine({ query, run_date: "2026-09-27", window_days: 7, sources: ["hn"],
    top_n: 1, collectors: { hn: async () => [item(1, "one")] } });
  const a = await run(`replay-original-${path.basename(temp)}`);
  const files = Object.values(a.artifacts).filter(file => fs.statSync(file).isFile());
  const original = files.map(file => [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs]);
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(a.run_id);
  const b = await run(`replay-intervening-${path.basename(temp)}`);
  assert.equal(a.run_telemetry.novelty.novel_clusters_in_top, 1);
  assert.equal(b.run_telemetry.novelty.novel_clusters_in_top, 0);
  closeDb(); // Persisted replay must survive a process/database restart.
  assert.deepEqual(await run(`replay-original-${path.basename(temp)}`), a);
  assert.deepEqual(getDb().prepare("SELECT * FROM runs WHERE id = ?").get(a.run_id), row);
  assert.deepEqual(files.map(file => [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs]), original);
});

test("schema migration adds replay storage without changing an older run", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-migrate-"));
  const previous = process.env.SIGNALFORGE_DB_PATH;
  const dbPath = path.join(temp, "old.db");
  process.env.SIGNALFORGE_DB_PATH = dbPath;
  t.after(() => {
    closeDb();
    if (previous === undefined) delete process.env.SIGNALFORGE_DB_PATH;
    else process.env.SIGNALFORGE_DB_PATH = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const Database = require("better-sqlite3");
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, query TEXT NOT NULL, window_days INTEGER NOT NULL,
    target TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, integrity_score INTEGER NOT NULL,
    flags TEXT NOT NULL, artifact_id TEXT, evidence_hash TEXT, evidence_json TEXT);
    INSERT INTO runs VALUES ('legacy', 'old', 7, 'gpt', 'quick', '2026-09-20', 50, '', NULL, NULL, NULL);`);
  legacy.close();
  const db = getDb();
  assert.ok(db.prepare("PRAGMA table_info(runs)").all().some(c => c.name === "response_json"));
  assert.equal(db.prepare("SELECT query FROM runs WHERE id = 'legacy'").get().query, "old");
});

test("UI artifact paths become relative for Windows, POSIX, and existing relative paths", () => {
  const vm = require("node:vm");
  const ui = fs.readFileSync(path.join(__dirname, "../ui/app.js"), "utf8");
  const fn = ui.match(/function toArtifactRelativePath\(artifactPath\) \{[\s\S]*?\n\}/)[0];
  const relative = vm.runInNewContext(`(${fn})`);
  const expected = "2026-09-27/query/summary_123.txt";
  assert.equal(relative(String.raw`C:\signalforge\dist\runs\2026-09-27\query\summary_123.txt`), expected);
  assert.equal(relative("/home/user/signalforge/dist/runs/" + expected), expected);
  assert.equal(relative(expected), expected);
  assert.equal(relative(null), "");
  assert.equal(path.win32.isAbsolute(relative(String.raw`C:\signalforge\dist\runs\2026-09-27\query\summary_123.txt`)), false);
});

// Runs share a fixed reference date and isolated local DB. No external requests are made.
test("/run derives rank and numeric integrity from admitted claim families, not hosts or source category", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-canonical-"));
  const cwd = process.cwd();
  const oldDb = process.env.SIGNALFORGE_DB_PATH;
  process.chdir(temp);
  process.env.SIGNALFORGE_DB_PATH = path.join(temp, "canonical.db");
  t.after(() => {
    closeDb(); process.chdir(cwd);
    if (oldDb === undefined) delete process.env.SIGNALFORGE_DB_PATH;
    else process.env.SIGNALFORGE_DB_PATH = oldDb;
    fs.rmSync(temp, {recursive:true, force:true});
  });
  const run = (query, items, extra = {}) => runEngine({
    query, run_date:"2026-09-27", window_days:7, sources:["hn"], top_n:10,
    collectors:{hn:async()=>items}, ...extra
  });
  const echo = await run("echo", [item(1,"one"),item(2,"one"),item(3,"one")]);
  const independent = await run("independent", [item(1,"one"),item(2,"two"),item(3,"three")]);
  const contested = await run("contested", [item(1,"one"),item(2,"two"),item(3,"three","refutes")]);
  const read = result => ({
    evidence:JSON.parse(fs.readFileSync(result.artifacts.evidence,"utf8")),
    sources:JSON.parse(fs.readFileSync(result.artifacts.sources,"utf8")),
    run:JSON.parse(fs.readFileSync(result.artifacts.run,"utf8"))
  });
  const e=read(echo), i=read(independent), c=read(contested);
  assert.equal(e.evidence.claims[0].status,"single_origin");
  assert.equal(e.evidence.claims[0].observed_families,1);
  assert.equal(i.evidence.claims[0].status,"corroborated");
  assert.equal(i.run.ranking_policy_version,3);
  assert.equal(i.run.integrity_policy_version,3);
  assert.equal(c.evidence.claims[0].status,"contested");
  assert.ok(e.sources.every(x=>x.origin_count===1 && x.echo_risk>=0.6));
  assert.ok(i.sources.every(x=>x.origin_count===3 && x.echo_risk===0));
  assert.ok(i.sources[0].score>e.sources[0].score);
  assert.ok(e.sources[0].score>c.sources[0].score);
  assert.ok(i.run.integrity.components.independence>e.run.integrity.components.independence);
  assert.equal(c.run.integrity.components.independence,0);
  assert.ok(i.run.integrity.components.evidence>c.run.integrity.components.evidence);
  assert.ok(c.run.integrity_score<e.run.integrity_score);
  assert.ok(contested.flags.includes("CONTRADICTORY_EVIDENCE"));
  assert.ok(echo.flags.includes("DEGRADED_SIGNAL_HIGH_ECHO_RISK"));
  assert.ok(contested.context_block_text.includes("adjudication=contested"));
  assert.equal(new Set(e.sources.map(x=>x.idea_cluster_id)).size,1);
  assert.equal(e.sources[0].idea_cluster_id,e.evidence.claims[0].claim_id);

  const excluded = await run("invalid siblings", [item(1,"one"),item(2,"two"),item(3,"three"),
    item(4,"four","supports",{published_at:null}),
    item(5,"five","supports",{published_at:"2020-01-01T00:00:00Z"})]);
  const x=read(excluded);
  assert.equal(x.evidence.accepted.length,3);
  assert.equal(x.evidence.rejected.length,2);
  assert.deepEqual(x.run.integrity.components,i.run.integrity.components);
  assert.equal(excluded.integrity_score,independent.integrity_score);
  assert.equal(x.sources[0].score,i.sources[0].score);

  const githubOnly = await runEngine({
    query:"github unassessed", run_date:"2026-09-27", window_days:7,
    sources:["github_release"], collectors:{github:async()=>({failed:false,items:[
      {title:"Same exact proposition",url:"https://github.com/acme/tool/releases/tag/v1",
       snippet:"Release",published_at:date,source:"github_release",timestamp_basis:"platform"}
    ]})}
  });
  const g=read(githubOnly);
  assert.equal(g.evidence.claims[0].status,"unassessed");
  assert.equal(g.sources[0].evidence_grade,"unassessed");
  assert.equal(g.run.integrity.components.independence,0);
  assert.equal(g.run.integrity.components.evidence,0);
  const hnUnassessed = await run("hn unassessed", [{
    title:"Same exact proposition",url:"https://news.example/announcement",snippet:"Release",
    published_at:date,source:"hn",timestamp_basis:"platform"
  }]);
  const h=read(hnUnassessed);
  assert.equal(g.sources[0].score,h.sources[0].score);
  assert.deepEqual(g.run.integrity.components,h.run.integrity.components);

  const newsEchoes = Array.from({length:6}, (_, n) => ({
    title:"Unverified excitement",url:`https://news${n}.example/coverage`,snippet:"Reposted report",
    published_at:date,source:"hn",claim_key:"Unverified excitement"
  }));
  const mixed = await run("rank independent claim above six host echoes", [
    item(1,"one"),item(2,"two"),...newsEchoes
  ]);
  const m=read(mixed);
  assert.equal(rankSnapshot(m.evidence)[0].status,"corroborated");
  assert.equal(rankSnapshot(m.evidence)[1].status,"unassessed");
  assert.ok(m.sources.filter(x=>x.title==="Unverified excitement").every(x=>x.origin_count===0));
  assert.ok(mixed.context_block_text.includes("adjudication=corroborated"));

  const partial = await runEngine({
    query:"partial collection",run_date:"2026-09-27",window_days:7,
    sources:["hn","github_issue"],collectors:{
      hn:async()=>[item(1,"one"),item(2,"two"),item(3,"three")],
      github:async()=>({failed:true,items:[]})
    }
  });
  assert.ok(partial.flags.includes("GITHUB_FETCH_FAILED"));
  assert.deepEqual(read(partial).run.integrity.components,i.run.integrity.components);

  const before = getReview(githubOnly.run_id);
  assert.equal(before.ranked_claims[0].status,"unassessed");
  recordReview(githubOnly.run_id,{
    base_artifact_id:before.snapshot.artifact_id, rationale:"Read the upstream release and identified its origin",
    edits:[{url:g.evidence.accepted[0].url,stance:"supports",originator_id:"maintainer"}]
  });
  const after = getReview(githubOnly.run_id);
  assert.equal(after.ranked_claims[0].status,"single_origin");
  assert.ok(after.ranked_claims[0].score>before.ranked_claims[0].score);
  assert.equal(JSON.parse(fs.readFileSync(githubOnly.artifacts.run,"utf8")).integrity_score,
    githubOnly.integrity_score);
});
