import { IdeaClusteredItem } from "./ideaClustering";

export type ScoredItem = IdeaClusteredItem & { score: number };

/** Triage order from adjudicated claims. This is not a probability of truth. */
export function scoreItems(items: IdeaClusteredItem[]): ScoredItem[] {
  return items.map((item) => ({
    ...item,
    score: Math.max(0, Math.round(
      40 +
      (item.claim_status === "corroborated" ? 14 :
        item.claim_status === "single_origin" ? 5 :
        item.claim_status === "contested" ? -20 : -12) -
      (item.dependence_unverified ? 8 : 0) -
      Math.round(item.echo_risk * 12) -
      (item.revalidation === "revalidate_soon" ? 5 : 0) -
      (item.timestamp_tier === "T3" ? 8 : 0) -
      (item.source === "web" ? 10 : 0)
    ))
  })).sort((a, b) => b.score - a.score || a.idea_cluster_id.localeCompare(b.idea_cluster_id) ||
    a.url.localeCompare(b.url));
}
