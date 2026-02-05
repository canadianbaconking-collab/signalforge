import { BaselineItemRecord } from "../../storage/db";
import { ScoredItem } from "../ranking/scoring";

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
};

/** Build the context block with a deterministic template. */
export function buildContextBlock(input: ContextBlockInput): string {
  const counts = Object.entries(input.sourceCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(", ");
  const flagsText = input.flags.length ? input.flags.join(", ") : "none";
  const degradedSignal = input.flags.some((flag) => flag.startsWith("DEGRADED_SIGNAL_"));

  const claims = input.topItems.slice(0, 5).map((item, index) => {
    const echoRisk = Number.isFinite(item.echo_risk) ? item.echo_risk.toFixed(2) : "0.00";
    return `${index + 1}. ${item.title} (${item.source}) [grade=${item.evidence_grade} origins=${item.origin_count} echo=${echoRisk}]`;
  });

  const prompt = `You are an expert research assistant. Expand on the top claims above. Provide concise bullet points with citations where possible.`;
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
    "LAST30 RUN",
    `Query: ${input.query}`,
    `Window: last ${input.windowDays} days`,
    `Sources: ${counts || "none"}`,
    `Integrity: ${input.integrityScore}/100   Flags: ${flagsText}`,
    ...(degradedSignal ? ["Note: degraded signal — verify critical claims."] : []),
    "",
    "TOP CLAIMS (ranked)",
    claims.join("\n") || "1. No claims available",
    "",
    "WHAT CHANGED VS BASELINE",
    baselineLines.length > 0 ? baselineLines.join("\n") : "None.",
    "",
    `PROMPT PACK FOR ${input.target.toUpperCase()}`,
    "PROMPT 1 — Research Expansion",
    prompt
  ].join("\n");
}
