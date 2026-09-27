"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixtures = require("./fixtures/collectors/responses.json");
const { hnCollector } = require("../dist/engine/collectors/hnCollector");
const { redditCollector } = require("../dist/engine/collectors/redditCollector");
const { githubCollector } = require("../dist/engine/collectors/githubCollector");

// Synthetic API cassettes: no live traffic or claim of recorded production responses.
// Unexpected requests throw, and every expected response must be consumed.
function cassette(t, steps) {
  t.mock.method(Date, "now", () => Date.parse("2026-09-27T12:00:00Z"));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(String(url));
    const step = steps.shift();
    assert.ok(step, `Unexpected request: ${url}`);
    assert.ok(String(url).includes(step.path), `Expected ${step.path}, got ${url}`);
    assert.ok(options.signal instanceof AbortSignal);
    if (step.error) throw new Error(step.error);
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
  });
  t.after(() => assert.equal(steps.length, 0, "Unconsumed cassette responses"));
  return calls;
}
const hn = (body = fixtures.hn, status = 200) => ({ path: "hn.algolia.com/api/v1/search", body, status });
const reddit = (body = fixtures.reddit, status = 200) => ({ path: "/r/test/search.json", body, status });
const issues = (status = 200) => ({ path: "/search/issues", body: fixtures.issues, status });
const repos = (body = fixtures.repos) => ({ path: "/search/repositories", body });
const release = (name, status = 200, body = []) => ({ path: `/repos/test/${name}/releases`, status, body });

test("HN parses cassette; malformed and absent timestamps never destroy valid observations", async t => {
  const calls = cassette(t, [hn()]);
  const items = await hnCollector("AI & tools", 4);
  assert.equal(items.length, 4);
  assert.equal(items[0].title, "Valid story");
  assert.equal(items[0].snippet, "Useful evidence");
  assert.equal(items[0].published_at, "2026-09-26T12:00:00.000Z");
  assert.deepEqual(items.slice(1).map(i => i.published_at), [null, null, null]);
  assert.equal(items[1].url, "https://news.ycombinator.com/item?id=102");
  assert.equal(new URL(calls[0]).searchParams.get("query"), "AI & tools");
});

test("HN rate limiting has bounded retries and rejects instead of inventing evidence", async t => {
  const calls = cassette(t, [hn({}, 429), hn({}, 429), hn({}, 429)]);
  await assert.rejects(hnCollector("test"), /429/);
  assert.equal(calls.length, 3);
});

test("HN transient failure can recover; malformed envelopes fail explicitly", async t => {
  cassette(t, [hn({}, 503), hn(), hn({ unexpected: [] })]);
  assert.equal((await hnCollector("test")).length, 4);
  await assert.rejects(hnCollector("test"), /Invalid HN/);
});

test("Reddit parses subreddit request and excludes invalid, missing, old and future dates", async t => {
  const calls = cassette(t, [reddit()]);
  const result = await redditCollector("r/test AI & tools", 30, 10);
  assert.equal(result.failed, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.excluded_missing_timestamp, 3);
  assert.equal(result.items[0].url, "https://www.reddit.com/r/test/comments/one");
  assert.equal(result.items[0].snippet, "A report");
  const params = new URL(calls[0]).searchParams;
  assert.equal(params.get("q"), "AI & tools");
  assert.equal(params.get("restrict_sr"), "on");
});

test("Reddit rate limits and malformed envelopes fail with no mock fallback", async t => {
  const calls = cassette(t, [reddit({}, 429), reddit({}, 429), reddit({ unexpected: [] })]);
  for (let i = 0; i < 2; i++) {
    const result = await redditCollector("r/test tools", 30, 10);
    assert.deepEqual(result, { items: [], failed: true, strategy_used: "reddit_json", excluded_missing_timestamp: 0 });
  }
  assert.equal(calls.length, 3);
});

test("GitHub parses issues and releases; bad timestamps do not erase valid rows", async t => {
  const calls = cassette(t, [issues(), repos({items:[{full_name:"test/one"}]}), release("one", 200, fixtures.releases)]);
  const result = await githubCollector("AI tools", 30, 10);
  assert.equal(result.failed, false);
  assert.deepEqual(result.items.map(i => i.source), ["github_issue", "github_release"]);
  assert.equal(result.items[0].snippet, "Evidence text");
  assert.equal(result.items[1].title, "v1");
  assert.match(new URL(calls[0]).searchParams.get("q"), /created:>=2026-08-28/);
});

test("GitHub retains earlier releases and continues after a rate-limited repository", async t => {
  cassette(t, [issues(), repos(), release("one", 200, fixtures.releases), release("two", 403), release("three", 200, [{...fixtures.releases[0], html_url:"https://github.com/test/three/releases/tag/v1"}])]);
  const result = await githubCollector("test", 30, 10);
  assert.equal(result.failed, true);
  assert.equal(result.items.length, 3);
  assert.ok(result.items.some(i => i.url.includes("test/three")));
});

test("GitHub still collects releases when issue search is rate limited", async t => {
  cassette(t, [issues(429), repos({items:[{full_name:"test/one"}]}), release("one", 200, fixtures.releases)]);
  const result = await githubCollector("test", 30, 10);
  assert.equal(result.failed, true);
  assert.deepEqual(result.items.map(i => i.source), ["github_release"]);
});

test("GitHub malformed release envelope keeps issues and later repository results", async t => {
  cassette(t, [issues(), repos({items:[{full_name:"test/one"},{full_name:"test/two"}]}), release("one", 200, {}), release("two", 200, fixtures.releases)]);
  const result = await githubCollector("test", 30, 10);
  assert.equal(result.failed, true);
  assert.equal(result.items.length, 2);
});

test("GitHub transport retries are bounded and retain independent endpoint results", async t => {
  cassette(t, [{path:"/search/issues", error:"offline"}, {path:"/search/issues", error:"offline"}, repos({items:[]})]);
  assert.deepEqual(await githubCollector("test", 30, 10), {items:[], failed:true});
});

test("Default run uses real collectors only; partial failure and explicit mock stay visible in artifacts", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalforge-collectors-"));
  const cwd = process.cwd();
  const oldDb = process.env.SIGNALFORGE_DB_PATH;
  process.chdir(tmp);
  process.env.SIGNALFORGE_DB_PATH = path.join(tmp, "test.db");
  const { runEngine } = require(path.join(cwd, "dist/engine/runEngine"));
  const { closeDb } = require(path.join(cwd, "dist/storage/db"));
  t.after(() => {
    closeDb(); process.chdir(cwd);
    if (oldDb === undefined) delete process.env.SIGNALFORGE_DB_PATH; else process.env.SIGNALFORGE_DB_PATH = oldDb;
    fs.rmSync(tmp, {recursive:true, force:true});
  });
  cassette(t, [
    {path:"/search.json", body:fixtures.reddit}, hn(), issues(),
    repos({items:[{full_name:"test/one"},{full_name:"test/two"}]}),
    release("one", 200, fixtures.releases), release("two", 403)
  ]);
  const result = await runEngine({query:"test", run_date:"2026-09-27"});
  const evidence = JSON.parse(fs.readFileSync(result.artifacts.evidence, "utf8"));
  assert.ok(result.flags.includes("GITHUB_FETCH_FAILED"));
  assert.ok(evidence.flags.includes("GITHUB_FETCH_FAILED"));
  assert.ok(!result.flags.includes("WEB_MOCK_SOURCE"));
  assert.deepEqual(new Set(evidence.accepted.map(i => i.source)), new Set(["reddit", "hn", "github_issue", "github_release"]));
  assert.equal(evidence.rejected.filter(i => i.reason === "MISSING_TIMESTAMP").length, 3);
  const mock = await runEngine({query:"demo", sources:["web"], run_date:"2026-09-27"});
  assert.ok(mock.flags.includes("WEB_MOCK_SOURCE"));
  assert.ok(JSON.parse(fs.readFileSync(mock.artifacts.evidence, "utf8")).flags.includes("WEB_MOCK_SOURCE"));
});
