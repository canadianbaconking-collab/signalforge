import { EvidenceSnapshot } from "../evidence/adjudicate";
import { clusterItems } from "./clustering";
import { clusterIdeas } from "./ideaClustering";
import { scoreItems } from "./scoring";

/** Deterministic claim-level triage from one immutable evidence artifact. */
export function rankSnapshot(snapshot: EvidenceSnapshot): Array<{
  claim_id: string;
  label: string;
  status: string;
  score: number;
  representative_url: string;
  evidence_count: number;
  independent_support_families: number;
  independent_counter_families: number;
  dependence_unverified: boolean;
}> {
  const clustered = clusterItems(snapshot.accepted.map((record) => ({
    title: record.title, url: record.url, snippet: record.snippet,
    published_at: record.published_at, source: record.source,
    timestamp_tier: record.timestamp_tier
  })));
  const ranked = scoreItems(clusterIdeas(clustered, snapshot).items);
  const claims = new Map(snapshot.claims.map((claim) => [claim.claim_id, claim]));
  const seen = new Set<string>();
  return ranked.filter((item) => {
    if (seen.has(item.idea_cluster_id)) return false;
    seen.add(item.idea_cluster_id);
    return true;
  }).map((item) => {
    const claim = claims.get(item.idea_cluster_id)!;
    return {
      claim_id: claim.claim_id, label: claim.label, status: claim.status, score: item.score,
      representative_url: item.url, evidence_count: claim.evidence_ids.length,
      independent_support_families: claim.independent_support_families,
      independent_counter_families: claim.independent_counter_families,
      dependence_unverified: claim.dependence_unverified
    };
  });
}
