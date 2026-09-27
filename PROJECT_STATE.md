# SignalForge project state — 2026-09-27

## Purpose and boundary

SignalForge is the general Frosted//Logic epistemic instrument. It helps decide what evidence deserves trust now, what to reject, and what to revisit. It is local-first and tool-for-self first. AlphaTrace may later consume its artifacts for market-specific weak-signal work; market prediction is not SignalForge's core.

## Reconciliation with recovered history

The GitHub repository contains a working `last30-engine/` implementation, not merely the early mock scaffold. Preserve its Express API, SQLite history, vanilla UI, deterministic run IDs and artifacts, HN/Reddit/GitHub collectors, baseline and novelty logic, integrity telemetry, and 42 passing smoke checks. The directory name reflects the earlier Last30 framing; the package and product name are SignalForge.

Before this tranche, HN/Reddit/GitHub ingestion was real but recency depended on wall time; HN silently substituted current time when no timestamp existed. GitHub and Reddit had explicit failure behavior, but the `web` source was mock data. URL deduplication, token-signature idea clusters, host-count independence, evidence grades, baseline anchors, novelty quota, and a context block existed. Ranking was positional. There was no canonical accepted/rejected evidence record, explicit counter-evidence, stable evidence hash, decision linkage, or outcome history.

## Current pipeline

1. Collect HN, Reddit, and GitHub by default (matching UI presets). Mock web observations require explicit `sources: ["web"]` selection and set `WEB_MOCK_SOURCE`. Reddit failures return no data, never a mock fallback. Independent GitHub endpoints/repositories preserve successful observations while partial failures set `GITHUB_FETCH_FAILED`.
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
- The existing `web` collector is opt-in mock data, flagged as `WEB_MOCK_SOURCE`; its sample timestamp is relative to wall time. It is absent from API/UI defaults and presets. HN, Reddit, and GitHub rely on their public APIs and can fail or rate limit.
- Collector-side Reddit/release windows and GitHub search cutoffs still use collection wall time. Historical replay requires fixed collector inputs; the adjudicator's fixed reference time does not make live collection historical.
- HN malformed timestamps become null for canonical rejection; Reddit counts malformed/missing dates in `excluded_missing_timestamp`; GitHub skips invalid dates. Reddit/GitHub exclusions are not yet individual canonical rejection records. HTTP retries remain bounded, without adaptive Retry-After scheduling.
- The engine uses SQLite and filesystem artifacts locally. No hosted service, MCP tunnel, embedding index, or AlphaTrace coupling is present.

## Verification

- `pnpm run build`: TypeScript compile passes.
- `pnpm run smoke`: 42 original offline checks pass.
- `pnpm run test:evidence`: window/timestamp rejection, URL deduplication, shared-primary echoes, independent support, counter-evidence, revalidation, collector failure, stable evidence hash and artifacts, changed-evidence run IDs, operator annotations, decision linkage, and outcome history pass.
- Fresh `pnpm install --frozen-lockfile` with only the required dependency builds approved, followed by build and all three test suites, passes.
- `pnpm run test:collectors`: 11 offline cassette tests pass, covering HN/Reddit/GitHub parsing, malformed timestamps/envelopes, HTTP rate limits, transient and transport failures, preservation of partial GitHub results, default real-source selection, and failure/mock flags in evidence artifacts. Fixtures are synthetic API-shaped examples, not live recordings.
- Build, 42 original smoke checks, four evidence tests, and 11 collector tests were rerun successfully on 2026-09-27 after a frozen-lockfile install.
- Live collector checks were not run. Public API behavior, availability, and real rate-limit responses remain unverified; cassette tests establish only behavior for the supplied responses.

## Completed collector tranche — 2026-09-27

Continued the existing open draft PR #13 from `fcfe6bb`; main remained at `702073e` at inspection and the PR had no review comments. Preserved the completed evidence/decision foundation. Chose the documented remove-from-defaults alternative instead of introducing an unaudited web scraper. API defaults now match the real-source UI defaults; the mock-backed Reddit fallback is removed. HN bad dates no longer abort whole batches. GitHub issue/release searches and individual repository failures are isolated so valid results survive. Added the dedicated cassette suite and reproducible verification commands.

## Exact next tranche

1. Introduce a canonical claim review workflow: inspect candidate clusters, assign shared `claim_key`, stance, primary URL/originator, and annotate incentives/channels with an explicit audit trail. Keep unknowns unknown.
2. Unify old idea clustering/ranking/integrity with canonical claim and family records, remove host-count corroboration language, and derive integrity components entirely from admitted evidence. Add adversarial echo and conflict fixtures at the `/run` boundary.
3. Add comparison of two evidence artifact IDs to answer what changed, what became stale, and what lost/gained independent support. Build a Decision Snapshot Generator on top of that, followed by pattern detection and confidence/outcome calibration once enough outcomes exist.
4. Add artifact manifest/signature support and a migration/versioning policy for evidence schema and SQLite. Keep replay deterministic and old artifacts readable.

Collector follow-up (not a prerequisite for claim review): run live validation when appropriate; carry explicit reference time into live collector contracts if historical collection is needed; retain per-item Reddit/GitHub rejection diagnostics. A real-web collector remains optional future scope, not completed work.
