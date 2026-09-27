import { EvidenceSnapshot } from "../evidence/adjudicate";

/** Component weights add to 100. Scores are triage quality signals, not truth probabilities. */
export type IntegrityComponents = {
  timestamp: number;
  sources: number;
  independence: number;
  evidence: number;
  baseline: number;
};

export type IntegrityScoreInput = {
  evidence: EvidenceSnapshot;
  /** Only prior admitted canonical claim records qualify as baseline anchors. */
  baseline?: {
    clusters_with_baseline: number;
    top_claim_clusters_count: number;
  };
};

export type IntegrityScoreResult = {
  integrity_score: number;
  flags: string[];
  components: IntegrityComponents;
};

const SOURCE_FAILURE_FLAGS = new Map([
  ["REDDIT_FETCH_FAILED", "SOURCE_FAILURE_REDDIT"],
  ["HN_FETCH_FAILED", "SOURCE_FAILURE_HN"],
  ["GITHUB_FETCH_FAILED", "SOURCE_FAILURE_GITHUB"]
]);

/** Every numeric component is derived from admitted evidence, never excluded observations or host counts. */
export function calculateIntegrityScore(input: IntegrityScoreInput): IntegrityScoreResult {
  const { accepted, claims } = input.evidence;
  const count = accepted.length;
  const timestamp = count ? 30 * accepted.reduce((sum, item) =>
    sum + ({ T1: 1, T2: 0.8, T3: 0.4, T4: 0 }[item.timestamp_tier]), 0) / count : 0;
  const sources = 25 * Math.min(1, count / 5);
  const independence = claims.length ? 20 * claims.reduce((sum, claim) =>
    sum + (claim.status === "contested" ? 0 : Math.min(2, claim.independent_support_families) / 2), 0
  ) / claims.length : 0;
  const evidence = claims.length ? 15 * claims.reduce((sum, claim) =>
    sum + (claim.status === "corroborated" ? 1 : claim.status === "single_origin" ? 0.5 : 0), 0
  ) / claims.length : 0;
  const baseline = input.baseline && input.baseline.top_claim_clusters_count > 0
    ? 10 * Math.min(1, input.baseline.clusters_with_baseline / input.baseline.top_claim_clusters_count) : 0;

  const components = { timestamp, sources, independence, evidence, baseline };
  const flags = new Set<string>();
  if (count < 5) flags.add("DEGRADED_SIGNAL_LOW_VOLUME");
  if (count && accepted.filter((record) => record.timestamp_tier === "T3").length / count >= 0.2) {
    flags.add("DEGRADED_SIGNAL_LOW_TIMESTAMP_TRUST");
  }
  const knownFamilyEcho = claims.some((claim) => {
    const records = accepted.filter((record) => record.claim_id === claim.claim_id && record.family_basis !== "domain" && record.timestamp_tier !== "T3");
    return records.length >= 3 &&
      records.length - new Set(records.map((record) => record.family_id)).size >= 2;
  });
  if (knownFamilyEcho) flags.add("DEGRADED_SIGNAL_HIGH_ECHO_RISK");
  if (!claims.some((claim) => claim.independent_support_families > 0)) {
    flags.add("DEGRADED_SIGNAL_LOW_EVIDENCE");
  }
  if (claims.some((claim) => claim.status === "contested")) flags.add("DEGRADED_SIGNAL_CONTRADICTION");
  if (claims.some((claim) => claim.dependence_unverified)) flags.add("DEGRADED_SIGNAL_UNVERIFIED_DEPENDENCE");
  for (const [sourceFlag, resultFlag] of SOURCE_FAILURE_FLAGS) {
    if (input.evidence.flags.includes(sourceFlag)) flags.add(resultFlag);
  }

  return {
    integrity_score: Math.round(Object.values(components).reduce((sum, value) => sum + value, 0)),
    flags: [...flags],
    components
  };
}
