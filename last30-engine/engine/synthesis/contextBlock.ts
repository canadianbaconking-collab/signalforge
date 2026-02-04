import { ScoredItem } from "../ranking/scoring";

export type ContextBlockInput = {
  query: string;
  windowDays: number;
  sourceCounts: Record<string, number>;
  integrityScore: number;
  flags: string[];
  target: "gpt" | "codex";
  topItems: ScoredItem[];
};

/** Build the context block with a deterministic template. */
export function buildContextBlock(input: ContextBlockInput): string {
  const counts = Object.entries(input.sourceCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(", ");
  const flagsText = input.flags.length ? input.flags.join(", ") : "none";

  const claims = input.topItems.slice(0, 5).map((item, index) => {
    return `${index + 1}. ${item.title} (${item.source})`;
  });

  const prompt = `You are an expert research assistant. Expand on the top claims above. Provide concise bullet points with citations where possible.`;

  return [
    "LAST30 RUN",
    `Query: ${input.query}`,
    `Window: last ${input.windowDays} days`,
    `Sources: ${counts || "none"}`,
    `Integrity: ${input.integrityScore}/100   Flags: ${flagsText}`,
    "",
    "TOP CLAIMS (ranked)",
    claims.join("\n") || "1. No claims available",
    "",
    `PROMPT PACK FOR ${input.target.toUpperCase()}`,
    "PROMPT 1 — Research Expansion",
    prompt
  ].join("\n");
}
