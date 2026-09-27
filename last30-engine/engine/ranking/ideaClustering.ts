import { EvidenceSnapshot, EvidenceRecord, ClaimRecord } from "../evidence/adjudicate";
import { ClusteredItem } from "./clustering";

/** Historical field name retained for artifact/SQLite compatibility. Values are now claim status. */
export type EvidenceGrade = ClaimRecord["status"];

export type IdeaClusteredItem = ClusteredItem & {
  /** Canonical claim ID. The legacy idea_cluster_id field keeps downstream artifact contracts. */
  idea_cluster_id: string;
  idea_label: string;
  origin_id: string;
  /** Count of explicitly identified source families; domains never count as independent. */
  origin_count: number;
  /** Observed repeated use of a known primary/originator; unknown dependence is separate. */
  echo_risk: number;
  evidence_grade: EvidenceGrade;
  claim_status: ClaimRecord["status"];
  independent_support_families: number;
  independent_counter_families: number;
  dependence_unverified: boolean;
  revalidation: ClaimRecord["revalidation"];
};

export type IdeaClusterSummary = {
  id: string;
  label: string;
  origin_count: number;
  echo_risk: number;
  evidence_grade: EvidenceGrade;
  item_count: number;
  independent_support_families: number;
  independent_counter_families: number;
  dependence_unverified: boolean;
};

/** Group only by canonical claim_id. Prose similarity remains a review candidate, not evidence. */
export function clusterIdeas(items: ClusteredItem[], evidence: EvidenceSnapshot): {
  items: IdeaClusteredItem[];
  clusters: IdeaClusterSummary[];
} {
  const byUrl = new Map(evidence.accepted.map((record) => [record.url, record]));
  const byClaim = new Map(evidence.claims.map((claim) => [claim.claim_id, claim]));
  const records = new Map<string, EvidenceRecord[]>();
  for (const record of evidence.accepted) {
    const group = records.get(record.claim_id) ?? [];
    group.push(record);
    records.set(record.claim_id, group);
  }
  const summaries = evidence.claims.map((claim): IdeaClusterSummary => {
    const group = records.get(claim.claim_id) ?? [];
    const known = group.filter((record) => record.family_basis !== "domain" && record.timestamp_tier !== "T3");
    const families = new Set(known.map((record) => record.family_id));
    const duplicateKnown = known.length - families.size;
    return {
      id: claim.claim_id,
      label: claim.label,
      origin_count: families.size,
      echo_risk: group.length ? duplicateKnown / group.length : 0,
      evidence_grade: claim.status,
      item_count: group.length,
      independent_support_families: claim.independent_support_families,
      independent_counter_families: claim.independent_counter_families,
      dependence_unverified: claim.dependence_unverified
    };
  });
  const bySummary = new Map(summaries.map((summary) => [summary.id, summary]));
  return {
    items: items.map((item): IdeaClusteredItem => {
      const record = byUrl.get(item.url);
      const claim = record && byClaim.get(record.claim_id);
      const summary = claim && bySummary.get(claim.claim_id);
      if (!record || !claim || !summary) throw new Error("Item lacks an admitted canonical claim");
      return {
        ...item,
        idea_cluster_id: claim.claim_id,
        idea_label: claim.label,
        origin_id: record.family_id,
        origin_count: summary.origin_count,
        echo_risk: summary.echo_risk,
        evidence_grade: claim.status,
        claim_status: claim.status,
        independent_support_families: claim.independent_support_families,
        independent_counter_families: claim.independent_counter_families,
        dependence_unverified: claim.dependence_unverified,
        revalidation: claim.revalidation
      };
    }),
    clusters: summaries
  };
}
