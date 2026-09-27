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

`allow_t4` is retained for legacy timestamp telemetry and its integrity component, but missing/invalid timestamps never enter the adjudicated evidence set, ranking, context claims, or history. Live runs reject future observations against actual collection time; explicit historical `run_date` replays use that UTC day's end as the reference time.

## Decision and outcome records

`POST /decision` requires `run_id`, the exact `artifact_id` from `evidence.json`, `question`, `choice`, `rationale`, and at least one `claim_id` from that snapshot. Decisions are immutable and idempotent by content.

`POST /outcome` requires `decision_id`, ISO `observed_at`, integer `rating` from 0 to 5, and optional `notes` and `confounders`. Outcomes are append-only. `GET /decision/:id` returns the decision and its observations.

SQLite defaults to `cache/signalforge.db`; set `SIGNALFORGE_DB_PATH` to use another local path.
