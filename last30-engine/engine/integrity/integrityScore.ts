export type StatSummary = {
  min: number;
  median: number;
  max: number;
};

export type IntegrityComponents = {
  timestamp: number;
  sources: number;
  independence: number;
  evidence: number;
  baseline: number;
};

export type IntegrityScoreInput = {
  timestamp_tier_counts: Record<string, number>;
  flags: string[];
  kept: number;
  echo_risk_stats?: StatSummary | null;
  evidence_grade_counts?: Record<string, number>;
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

export function calculateIntegrityScore(input: IntegrityScoreInput): IntegrityScoreResult {
  const totalTimestamped = sumCounts(input.timestamp_tier_counts);
  const percentT3 = percentOf(input.timestamp_tier_counts.T3 ?? 0, totalTimestamped);
  const percentT4 = percentOf(input.timestamp_tier_counts.T4 ?? 0, totalTimestamped);

  const timestamp = clamp(
    30 - 2 * Math.round(percentT3) - 5 * Math.round(percentT4),
    0,
    30
  );

  const failureFlagsCount = Array.from(SOURCE_FAILURE_FLAGS.keys()).filter((flag) =>
    input.flags.includes(flag)
  ).length;
  const sourcesPenalty = Math.min(20, failureFlagsCount * 10) + (input.kept < 5 ? 5 : 0);
  const sources = clamp(25 - sourcesPenalty, 0, 25);

  const medianEchoRisk = clamp01(input.echo_risk_stats?.median ?? 0);
  const independence = clamp(20 * (1 - medianEchoRisk), 0, 20);

  const evidenceCounts = input.evidence_grade_counts ?? {};
  const evidenceTotal = sumCounts(evidenceCounts);
  const multiConfirmed = evidenceCounts["multi-confirmed"] ?? 0;
  const implementationConfirmed = evidenceCounts["implementation-confirmed"] ?? 0;
  const multiRatio = ratio(multiConfirmed, evidenceTotal);
  const implementationRatio = ratio(implementationConfirmed, evidenceTotal);

  const evidence = clamp(
    5 + Math.min(10, 10 * multiRatio) + Math.min(5, 5 * implementationRatio),
    0,
    15
  );

  const baseline = calculateBaselineScore(input.baseline);

  const components = {
    timestamp,
    sources,
    independence,
    evidence,
    baseline
  };
  const integrityScore = clamp(
    timestamp + sources + independence + evidence + baseline,
    0,
    100
  );

  const flags = buildIntegrityFlags({
    kept: input.kept,
    percentT3,
    percentT4,
    medianEchoRisk,
    multiRatio,
    implementationRatio,
    existingFlags: input.flags
  });

  return {
    integrity_score: Math.round(integrityScore),
    flags,
    components
  };
}

function buildIntegrityFlags(input: {
  kept: number;
  percentT3: number;
  percentT4: number;
  medianEchoRisk: number;
  multiRatio: number;
  implementationRatio: number;
  existingFlags: string[];
}): string[] {
  const flags = new Set<string>();

  if (input.kept < 5) {
    flags.add("DEGRADED_SIGNAL_LOW_VOLUME");
  }

  if (input.percentT3 + input.percentT4 >= 20) {
    flags.add("DEGRADED_SIGNAL_LOW_TIMESTAMP_TRUST");
  }

  if (input.medianEchoRisk >= 0.6) {
    flags.add("DEGRADED_SIGNAL_HIGH_ECHO_RISK");
  }

  if (input.multiRatio === 0 && input.implementationRatio === 0) {
    flags.add("DEGRADED_SIGNAL_LOW_EVIDENCE");
  }

  for (const [flag, mapped] of SOURCE_FAILURE_FLAGS.entries()) {
    if (input.existingFlags.includes(flag)) {
      flags.add(mapped);
    }
  }

  return Array.from(flags);
}

function calculateBaselineScore(
  baseline: IntegrityScoreInput["baseline"] | undefined
): number {
  if (!baseline || baseline.clusters_with_baseline <= 0) {
    return 0;
  }
  const denominator = Math.max(1, baseline.top_claim_clusters_count);
  return clamp(10 * (baseline.clusters_with_baseline / denominator), 0, 10);
}

function percentOf(count: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (count / total) * 100;
}

function ratio(count: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return count / total;
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
