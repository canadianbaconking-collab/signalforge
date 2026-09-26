import { BaselineItemRecord } from "../../storage/db";
import { ScoredItem } from "../ranking/scoring";
import { EvidenceSnapshot } from "../evidence/adjudicate";

export type ContextBlockInput = {
  query: string;
  windowDays: number;
  sourceCounts: Record<string, number>;
  integrityScore: number;
  flags: string[];
  target: "gpt" | "codex";
  topItems: ScoredItem[];
  baselineSummary: Array<{
    idea_cluster_id: string;
    current_title: string;
    baselines: BaselineItemRecord[];
  }>;
  newSignals: Array<{
    title: string;
    source: string;
    published_at: string | null;
  }>;
  evidence?: EvidenceSnapshot;
};

/** Build the context block with a deterministic template. */
export function buildContextBlock(input: ContextBlockInput): string {
  const counts = Object.entries(input.sourceCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(", ");
  const flagsText = input.flags.length ? input.flags.join(", ") : "none";
  const degradedSignal = input.flags.some((flag) => flag.startsWith("DEGRADED_SIGNAL_"));
  const claimStatusByUrl = new Map<string, string>();
  for (const claim of input.evidence?.claims ?? []) {
    for (const record of input.evidence?.accepted ?? []) {
      if (claim.evidence_ids.includes(record.evidence_id)) claimStatusByUrl.set(record.url, claim.status);
    }
  }

  const claims = input.topItems.slice(0, 5).map((item, index) => {
    return `${index + 1}. ${item.title} (${item.source}) [triage=${item.score}; adjudication=${claimStatusByUrl.get(item.url) ?? "unassessed"}]`;
  });

  const prompt = `Assess the linked evidence. Keep unassessed claims provisional, investigate counter-evidence and shared origins, and revalidate dated recommendations before deciding.`;
  const evidenceLines = input.evidence?.claims.slice(0, 8).map((claim) => {
    const records = input.evidence!.accepted.filter((record) => claim.evidence_ids.includes(record.evidence_id));
    const links = records.slice(0, 3).map((record) => record.url).join(" | ");
    return `- ${claim.label}: ${claim.status}; verified support families=${claim.independent_support_families}; counter=${claim.counter_ids.length}; dependence_unverified=${claim.dependence_unverified}; revalidate_by=${claim.revalidate_by}; evidence: ${links}`;
  }) ?? [];
  const rejectedCounts = input.evidence?.rejected.reduce<Record<string, number>>((counts, record) => {
    counts[record.reason] = (counts[record.reason] ?? 0) + 1;
    return counts;
  }, {}) ?? {};

  const newSignalLines = input.newSignals
    .slice(0, 5)
    .map((item) => `- ${item.title} (${item.source}, ${(item.published_at ?? "unknown").slice(0, 10)})`);

  const baselineLines = input.baselineSummary
    .filter((entry) => entry.baselines.length > 0)
    .slice(0, 6)
    .map((entry) => {
      const baselineText = entry.baselines
        .map((baseline) => `${baseline.title} (${baseline.published_at.slice(0, 10)})`)
        .join("; ");
      return `- Now: ${entry.current_title} | Baseline: ${baselineText}`;
    });

  return [
    "SIGNALFORGE RUN",
    `Query: ${input.query}`,
    `Window: last ${input.windowDays} days`,
    `Sources: ${counts || "none"}`,
    `Integrity: ${input.integrityScore}/100   Flags: ${flagsText}`,
    ...(degradedSignal ? ["Note: degraded signal — verify critical claims."] : []),
    "",
    "TOP SIGNALS (triage order)",
    claims.join("\n") || "1. No claims available",
    "",
    "EVIDENCE ADJUDICATION",
    evidenceLines.join("\n") || "No admissible evidence.",
    `Rejected: ${Object.entries(rejectedCounts).map(([reason, count]) => `${reason}:${count}`).join(", ") || "none"}`,
    "",
    "NEW SIGNALS",
    newSignalLines.length > 0 ? newSignalLines.join("\n") : "None.",
    "",
    "WHAT CHANGED VS BASELINE",
    baselineLines.length > 0 ? baselineLines.join("\n") : "None.",
    "",
    `PROMPT PACK FOR ${input.target.toUpperCase()}`,
    "PROMPT 1 — Research Expansion",
    prompt
  ].join("\n");
}
