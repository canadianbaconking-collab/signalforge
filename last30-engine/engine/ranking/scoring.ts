import { IdeaClusteredItem } from "./ideaClustering";

export type ScoredItem = IdeaClusteredItem & {
  score: number;
};

/** Rank observable signals with a stable tie break. Scores are triage hints, not truth probabilities. */
export function scoreItems(items: IdeaClusteredItem[]): ScoredItem[] {
  return items.map((item) => ({
    ...item,
    score: Math.max(0, Math.round(
      40 +
      (item.evidence_grade === "multi-confirmed" ? 12 :
        item.evidence_grade === "implementation-confirmed" ? 8 : 0) +
      Math.min(3, item.origin_count) * 2 -
      Math.round(item.echo_risk * 15) -
      (item.timestamp_tier === "T4" ? 20 : item.timestamp_tier === "T3" ? 8 : 0) -
      (item.source === "web" ? 10 : 0)
    ))
  })).sort((a, b) => b.score - a.score || a.idea_cluster_id.localeCompare(b.idea_cluster_id) ||
    a.url.localeCompare(b.url));
}
