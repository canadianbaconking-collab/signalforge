# SignalForge engine

Local Node/TypeScript + Express + SQLite instrument. Node 22 or newer is recommended. The server binds to `127.0.0.1:8787`.
The pnpm workspace file approves the native builds required by `better-sqlite3` and `esbuild`.

## Run

```bash
pnpm install
pnpm run build
pnpm start
```

Open http://localhost:8787. For development, `pnpm run dev` runs the TypeScript server directly.

## Verify

```bash
pnpm run build
pnpm run smoke
pnpm run test:evidence
pnpm run test:collectors
pnpm run test:reviews
pnpm run test:canonical
```

The 42 legacy smoke checks and the adversarial evidence tests run offline using collector overrides. The 11 collector tests replay synthetic API response cassettes through the real parsers with network access replaced; they also verify default-run evidence artifacts and partial failure flags. These are authored fixtures, not captured live responses. Set `SIGNALFORGE_LIVE_SMOKE=1` only when you want an optional live Hacker News check.

## Run contract

`POST /run` accepts `query`, `window_days`, `target`, `mode`, `sources`, `top_n`, and optional URL-keyed `annotations`. Supported sources are `hn`, `reddit`, `github_issue`, `github_release`, and `web`. Omitting `sources` selects `reddit`, `hn`, `github_issue`, and `github_release`, matching the UI default. `web` is an explicit demo-only mock collector and sets `WEB_MOCK_SOURCE`; it is absent from defaults and presets.

Reddit failures return no items and `REDDIT_FETCH_FAILED`; the former mock-backed web fallback has been removed. GitHub searches issues and releases independently, preserves successful repositories, and continues after a repository fails; any partial failure sets `GITHUB_FETCH_FAILED`. HN invalid timestamps remain null for canonical rejection without dropping valid siblings; Reddit invalid timestamps increment `excluded_missing_timestamp`, and GitHub invalid timestamps are excluded. Malformed response envelopes fail explicitly. Retries remain bounded (HN three attempts, Reddit two, GitHub two for transport errors); this is not an adaptive rate-limit scheduler.

Collector-side Reddit/release windows and GitHub search cutoffs still use collection wall time. Historical `run_date` determinism requires fixed collector inputs; live collection is not a historical replay mechanism.

```json
{
  "query": "AI code review workflows",
  "window_days": 30,
  "target": "codex",
  "mode": "deep",
  "sources": ["hn", "github_issue", "github_release"],
  "top_n": 10,
  "annotations": {
    "https://example.org/study": {
      "claim_key": "Code review tool X reduces defects",
      "stance": "supports",
      "primary_url": "https://example.org/primary-study",
      "originator_id": "research-group-a"
    }
  }
}
```

Annotations are explicit operator judgments, matched to collector URLs exactly. A `stance` is never inferred from article text. Two observations citing one `primary_url` are one source family. Without a declared primary URL or originator, dependence remains unverified.

The response retains `run_id`, `integrity_score`, `flags`, `artifacts`, `context_block_text`, and run telemetry. Artifacts under `runs/YYYY-MM-DD/<slug>/` include `run`, `sources`, `summary`, `context_block`, and the new `evidence` snapshot. The evidence snapshot lists accepted/rejected observations, claim and family IDs, support and counter-evidence, conflict status, revalidation date, and its SHA-256 `artifact_id`. `run_id` includes the evidence hash so changed observations do not overwrite prior artifacts.

`allow_t4` is retained for legacy collection telemetry only; missing/invalid timestamps never enter adjudicated evidence, ranking, numeric integrity, context claims, or canonical history. Live runs reject future observations against actual collection time; explicit historical `run_date` replays use that UTC day's end as the reference time.

## Canonical ranking and integrity

Only accepted evidence enters numeric integrity and triage ranking. Items share `idea_cluster_id` only when the canonical snapshot assigns the same `claim_id`; exact-title fallback remains conservative until an operator supplies a shared key. A source type (including GitHub) and a new domain cannot themselves corroborate a claim. Explicit primary URLs or originators define known families. The triage score rewards corroborated claims and penalizes contested or unassessed claims, known-family echoes, unverified dependence, aging observations, inferred timestamps, and the opt-in mock web source. It is an ordering hint, not a probability.

Compatibility names in `sources.json`, SQLite, and run telemetry have new canonical meanings: `idea_cluster_id` is the claim ID, `origin_count` counts identified families, `evidence_grade` is claim status, and `echo_risk` counts repeated known-family evidence. No independent-support conclusion can be inferred from `origin_count` alone; consult `evidence.json` for support/counter families. The five integrity components are admitted timestamp quality (30), admitted observation volume (25), verified independent support (20), adjudicated claim status (15), and prior admitted canonical baseline anchors (10). Collection failures remain explicit flags, not numeric input. `run.json` records ranking and integrity policy version 2, included in the run ID. Old token-signature history is not mapped into canonical claim IDs, so baseline/novelty tracking restarts on policy-v2 runs. Old artifacts and decisions remain readable.

## Canonical claim review

The UI opens a Claim review panel after a run. Select a candidate claim, inspect its exact observation URL, then edit the claim key, stance, primary URL, originator ID, incentives, or distribution channels. A rationale is required. Shared claim keys group exact propositions; an explicit `supports` or `refutes` stance is needed for support or counter-evidence. Blank provenance fields remain unknown. The panel shows the latest artifact ID and event count.

`GET /review/:run_id` returns the latest evidence snapshot, candidate clusters with observations, deterministic `ranked_claims` for that exact snapshot, and ordered audit events. Supply `?artifact_id=evidence:...` to read an earlier snapshot, including the original. `POST /review/:run_id` accepts an optimistic base artifact and URL-exact edits:

```json
{
  "base_artifact_id": "evidence:<sha256>",
  "rationale": "Read the source and identified the shared study",
  "edits": [{
    "url": "https://example.org/article",
    "claim_key": "Claim X",
    "stance": "supports",
    "primary_url": "https://example.org/study",
    "originator_id": "lab-x",
    "incentives": "Vendor-funded",
    "channels": ["blog", "newsletter"]
  }]
}
```

Only supplied annotation fields change. Use `null` to clear string fields, `unassessed` or `null` to clear stance, and `[]` to clear channels. Accepted URLs must match the stored snapshot exactly. A stale base yields HTTP 409, invalid annotations HTTP 400, and an unknown run HTTP 404. A successful review returns a review event ID and new `artifact_id`. Original snapshots remain immutable (schema version 1); reviewed snapshots use schema version 2 and preserve rejected observations and collector flags. No collector is re-run. The append-only SQLite audit records rationale, edits, parent and resulting artifact IDs, and time; it is not externally signed.

Review recomputes canonical claim/family status and the read-only `ranked_claims` projection. The original run's integrity score, context block, summary, novelty selection, and `run_id` remain historical outputs, as the UI notes.

## Decision and outcome records

`POST /decision` requires `run_id`, an exact original or reviewed `artifact_id`, `question`, `choice`, `rationale`, and at least one `claim_id` from that snapshot. Decisions are immutable and idempotent by content.

`POST /outcome` requires `decision_id`, ISO `observed_at`, integer `rating` from 0 to 5, and optional `notes` and `confounders`. Outcomes are append-only. `GET /decision/:id` returns the decision and its observations.

SQLite defaults to `cache/signalforge.db`; set `SIGNALFORGE_DB_PATH` to use another local path.

## Compare evidence and prepare a decision

`POST /compare` accepts exact `from_artifact_id` and `to_artifact_id` values from stored original or reviewed evidence snapshots. The result has a deterministic `comparison_id`, per-claim additions/removals/changes, evidence identity and same-URL revisions, gained/lost identified support and counter families, and stale/contradiction flags. The first artifact's reference time must be no later than the second's. Revalidation is evaluated at the second artifact's fixed reference time.

`POST /decision-snapshot` accepts `evidence_artifact_id`, a `question`, and optionally that stored `comparison_id`. It returns a content-addressed evidence brief with ranked claim IDs, support and counter evidence IDs, revalidation dates, rejected evidence, and unresolved flags. It makes no choice or confidence claim. Retrieve the exact source evidence through `GET /evidence-artifact/:id` and either derived artifact through `GET /derived-artifact/:id`; reads verify content against its stored hash.

`POST /decision` may include `decision_snapshot_id`. When supplied, the brief must match the exact evidence artifact and question recorded with the decision. Outcomes continue to link to that immutable decision. Existing decisions without briefs remain valid.
