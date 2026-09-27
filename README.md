# SignalForge

SignalForge is a local-first Frosted//Logic Intelligence Instrument for inspecting evidence before making technology and product decisions. Microtools solve problems; instruments discover which problems are worth solving. It is a tool for its operator, not a news feed or hosted platform.

The historical implementation directory is [last30-engine](last30-engine/README.md). Its name is retained to preserve the existing code and tests.

See [PROJECT_STATE.md](PROJECT_STATE.md) for the current architecture, contracts, gaps, and exact next tranche.

The local UI now lists stored collection and review artifacts for evidence comparison and decision brief inspection. `GET /evidence-artifacts` returns the latest 200 artifact entries; `POST /compare` and `POST /decision-snapshot` store content-addressed derived artifacts. Live collection never substitutes synthetic responses after a source failure; offline collector tests use synthetic API-shaped fixtures. The web source remains an explicitly selected, flagged mock.

Default runs use HN, Reddit, GitHub issues, and GitHub releases. Mock web data is opt-in and visibly flagged; failed live requests never silently substitute it. Collector cassette tests cover parsing, malformed timestamps, rate limits, and preservation of partial results.

Verify from the repository root:

```bash
cd last30-engine
pnpm install --frozen-lockfile
pnpm run build
pnpm run smoke
pnpm run test:evidence
pnpm run test:collectors
pnpm run test:reviews
pnpm run test:canonical
```

These checks are offline. They do not establish current live API availability.

After collecting a run, the claim review panel lists candidate claims and observations. Operator edits create new content-addressed evidence artifacts and append-only review events. Decisions can cite original or reviewed artifacts. See [the engine README](last30-engine/README.md) for the API contract. Review does not recalculate the original run score or context block.

Ranking and integrity now use admitted canonical claims and identified source families; host counts and source categories do not confer corroboration. Reviewed evidence exposes its own claim-level triage projection.
