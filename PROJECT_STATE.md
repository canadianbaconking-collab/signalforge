# SignalForge project state — 2026-09-26

## Purpose and boundary

SignalForge is the general Frosted//Logic epistemic instrument. It helps decide what evidence deserves trust now, what to reject, and what to revisit. It is local-first and tool-for-self first. AlphaTrace may later consume its artifacts for market-specific weak-signal work; market prediction is not SignalForge's core.

## Reconciliation with recovered history

The GitHub repository contains a working `last30-engine/` implementation, not merely the early mock scaffold. Preserve its Express API, SQLite history, vanilla UI, deterministic run IDs and artifacts, HN/Reddit/GitHub collectors, baseline and novelty logic, integrity telemetry, and 42 passing smoke checks. The directory name reflects the earlier Last30 framing; the package and product name are SignalForge.

Before this tranche, HN/Reddit/GitHub ingestion was real but recency depended on wall time; HN silently substituted current time when no timestamp existed. GitHub and Reddit had explicit failure behavior, but the `web` source was mock data. URL deduplication, token-signature idea clusters, host-count independence, evidence grades, baseline anchors, novelty quota, and a context block existed. Ranking was positional. There was no canonical accepted/rejected evidence record, explicit counter-evidence, stable evidence hash, decision linkage, or outcome history.

## Current pipeline

1. Collect HN, Reddit, GitHub, and optional mock web observations. Collector failures and fallback/mock paths set visible flags.
2. Adjudicate against a fixed run-date window. Reject invalid URL, missing/invalid/future/out-of-window timestamp, and duplicate canonical URL. T1 is platform time, T2 publisher time, T3 inferred time, T4 missing/invalid. Accepted observations receive stable SHA-256 evidence and claim IDs.
3. Group claims using an explicit `claim_key` when supplied; otherwise use normalized title conservatively. Explicit `supports`/`refutes` stances reveal contradictions. No prose classifier silently invents a stance.
4. Model dependence by explicit originator or shared primary URL. Domain-only grouping is flagged as unverified dependence and cannot by itself make a claim corroborated. A contradiction yields `contested`. Claims carry `revalidate_by` and `revalidate_soon` semantics.
5. Feed accepted evidence to the existing idea clustering, novelty, baseline, scoring, integrity, and context-block pipeline. The old `sources` artifact remains for compatibility. The authoritative `evidence` snapshot records rejections and claim adjudication; context blocks now display its status, links, and revalidation dates.
6. Write content-addressed evidence and run artifacts. The run ID includes the evidence hash and effective ranking policy. Same-input replay excludes its own prior database row from novelty history so artifact bytes stay stable.
7. Store run and evidence JSON in SQLite. An immutable decision must cite the exact run artifact and claim IDs. Append-only outcomes record rating, time, notes, and confounders.

## Contracts and limits

- `POST /run` and its response fields remain compatible; `artifacts.evidence` is added. `run.json` adds `artifact_id`, `evidence_hash`, and `evidence_counts`.
- `evidence.json` schema version 1 is deterministic for fixed inputs and reference time. Live runs use actual collection time; explicit historical `run_date` replay uses the end of that UTC day. Its hash covers accepted/rejected records, claims, flags, and window. Artifacts are not cryptographically signed or externally timestamped.
- Explicit operator annotations are URL-keyed and preserved in the run options and each evidence record's `metadata_origin`. Exact URL matching is intentional; annotation tooling and alias handling are deferred.
- The legacy `allow_t4` option affects old timestamp telemetry and its integrity component; T4 observations never influence admitted evidence or claims.
- The legacy `origin_count`, `evidence_grade`, and numeric integrity score remain heuristic. The score is capped for contested claims and unverified dependence; it is not a calibrated probability. Canonical claim status is authoritative for adjudication.
- Claim grouping without `claim_key` uses normalized exact titles. Semantic paraphrases, implicit negation, and hidden shared sources are not automatically resolved.
- The existing `web` collector is deterministic mock data, flagged as `WEB_MOCK_SOURCE`. HN, Reddit, and GitHub rely on their public APIs and can fail or rate limit.
- The engine uses SQLite and filesystem artifacts locally. No hosted service, MCP tunnel, embedding index, or AlphaTrace coupling is present.

## Verification

- `pnpm run build`: TypeScript compile passes.
- `pnpm run smoke`: 42 original offline checks pass.
- `pnpm run test:evidence`: window/timestamp rejection, URL deduplication, shared-primary echoes, independent support, counter-evidence, revalidation, collector failure, stable evidence hash and artifacts, changed-evidence run IDs, operator annotations, decision linkage, and outcome history pass.
- Fresh `pnpm install --frozen-lockfile` with only the required dependency builds approved, followed by build and both test suites, passes.
- Live collector checks were not run in this tranche. Public API behavior and rate-limit handling need a later live validation pass.

## Exact next tranche

1. Replace the mock web path with a bounded, auditable real-web collector or remove it from default presets. Add cassette tests for HN, Reddit, and GitHub parsing, partial failures, rate limits, and malformed timestamps.
2. Introduce a canonical claim review workflow: inspect candidate clusters, assign shared `claim_key`, stance, primary URL/originator, and annotate incentives/channels with an explicit audit trail. Keep unknowns unknown.
3. Unify old idea clustering/ranking/integrity with canonical claim and family records, remove host-count corroboration language, and derive integrity components entirely from admitted evidence. Add adversarial echo and conflict fixtures at the `/run` boundary.
4. Add comparison of two evidence artifact IDs to answer what changed, what became stale, and what lost/gained independent support. Build a Decision Snapshot Generator on top of that, followed by pattern detection and confidence/outcome calibration once enough outcomes exist.
5. Add artifact manifest/signature support and a migration/versioning policy for evidence schema and SQLite. Keep replay deterministic and old artifacts readable.
