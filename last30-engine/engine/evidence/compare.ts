import crypto from "crypto";
import { ClaimRecord, EvidenceSnapshot } from "./adjudicate";
import { rankSnapshot } from "../ranking/claimRanking";

const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reject a corrupted or unsupported stored artifact before deriving another one from it. */
export function verifySnapshot(snapshot: EvidenceSnapshot): void {
  if (!snapshot || ![1, 2, 3].includes(snapshot.schema_version) ||
      !/^evidence:[a-f0-9]{64}$/.test(snapshot.artifact_id)) {
    throw new Error("unsupported evidence artifact");
  }
  const { artifact_id, evidence_hash, ...payload } = snapshot;
  if (hash(payload) !== evidence_hash || artifact_id !== `evidence:${evidence_hash}`) {
    throw new Error("evidence artifact hash mismatch");
  }
}

type ClaimChange = {
  claim_id: string;
  label: string;
  change: "added" | "removed" | "changed" | "unchanged";
  before: ClaimRecord | null;
  after: ClaimRecord | null;
  gained_evidence_ids: string[];
  lost_evidence_ids: string[];
  changed_evidence_ids: string[];
  revised_evidence: Array<{ url: string; before_id: string; after_id: string }>;
  gained_support_families: string[];
  lost_support_families: string[];
  gained_counter_families: string[];
  lost_counter_families: string[];
  revalidation_at_target: "current" | "due";
};

export type EvidenceComparison = {
  schema_version: 1;
  comparison_id: string;
  from_artifact_id: string;
  to_artifact_id: string;
  reference_at: string;
  from_flags: string[];
  to_flags: string[];
  changes: ClaimChange[];
  flags: string[];
};

function families(snapshot: EvidenceSnapshot, claim: ClaimRecord | undefined, stance: "supports" | "refutes"): string[] {
  if (!claim) return [];
  return [...new Set(snapshot.accepted
    .filter((record) => record.claim_id === claim.claim_id && record.stance === stance &&
      record.family_basis !== "domain" && record.timestamp_tier !== "T3")
    .map((record) => record.family_id))].sort();
}

const difference = (a: string[], b: string[]) => a.filter((value) => !b.includes(value)).sort();

/** Compare exact immutable artifacts; claim identity remains the adjudicated claim ID. */
export function compareSnapshots(from: EvidenceSnapshot, to: EvidenceSnapshot): EvidenceComparison {
  verifySnapshot(from);
  verifySnapshot(to);
  if (Date.parse(from.reference_at) > Date.parse(to.reference_at)) {
    throw new Error("from artifact must not be later than to artifact");
  }
  const before = new Map(from.claims.map((claim) => [claim.claim_id, claim]));
  const after = new Map(to.claims.map((claim) => [claim.claim_id, claim]));
  const changes: ClaimChange[] = [...new Set([...before.keys(), ...after.keys()])].sort().map((claim_id) => {
    const old = before.get(claim_id);
    const current = after.get(claim_id);
    const oldIds = old?.evidence_ids ?? [];
    const newIds = current?.evidence_ids ?? [];
    const oldSupport = families(from, old, "supports");
    const newSupport = families(to, current, "supports");
    const oldCounter = families(from, old, "refutes");
    const newCounter = families(to, current, "refutes");
    const gained_evidence_ids = difference(newIds, oldIds);
    const lost_evidence_ids = difference(oldIds, newIds);
    const oldRecords = new Map(from.accepted.filter((record) => record.claim_id === claim_id)
      .map((record) => [record.evidence_id, record]));
    const changed_evidence_ids = to.accepted
      .filter((record) => record.claim_id === claim_id && oldRecords.has(record.evidence_id) &&
        JSON.stringify(record) !== JSON.stringify(oldRecords.get(record.evidence_id)))
      .map((record) => record.evidence_id).sort();
    const oldByUrl = new Map(from.accepted.filter((record) => record.claim_id === claim_id)
      .map((record) => [record.url, record]));
    const revised_evidence = to.accepted.filter((record) => record.claim_id === claim_id)
      .flatMap((record) => {
        const prior = oldByUrl.get(record.url);
        return prior && prior.evidence_id !== record.evidence_id
          ? [{ url: record.url, before_id: prior.evidence_id, after_id: record.evidence_id }] : [];
      }).sort((a, b) => a.url.localeCompare(b.url));
    const gained_support_families = difference(newSupport, oldSupport);
    const lost_support_families = difference(oldSupport, newSupport);
    const gained_counter_families = difference(newCounter, oldCounter);
    const lost_counter_families = difference(oldCounter, newCounter);
    const revalidation_at_target = Date.parse(current?.revalidate_by ?? old!.revalidate_by) <= Date.parse(to.reference_at)
      ? "due" : "current";
    const materiallyChanged = gained_evidence_ids.length || lost_evidence_ids.length ||
      changed_evidence_ids.length || revised_evidence.length ||
      gained_support_families.length || lost_support_families.length ||
      gained_counter_families.length || lost_counter_families.length ||
      old?.status !== current?.status || old?.revalidation !== current?.revalidation ||
      old?.dependence_unverified !== current?.dependence_unverified;
    return {
      claim_id, label: current?.label ?? old!.label,
      change: !old ? "added" : !current ? "removed" : materiallyChanged ? "changed" : "unchanged",
      before: old ?? null, after: current ?? null,
      gained_evidence_ids, lost_evidence_ids, changed_evidence_ids, revised_evidence,
      gained_support_families, lost_support_families,
      gained_counter_families, lost_counter_families,
      revalidation_at_target
    };
  });
  const flags = [...new Set([
    ...(changes.some((item) => item.revalidation_at_target === "due") ? ["REVALIDATION_DUE"] : []),
    ...(changes.some((item) => item.after?.status === "contested") ? ["CONTRADICTORY_EVIDENCE"] : []),
    ...(changes.some((item) => item.lost_support_families.length) ? ["INDEPENDENT_SUPPORT_LOST"] : []),
    ...(changes.some((item) => item.gained_counter_families.length) ? ["COUNTER_EVIDENCE_GAINED"] : []),
    ...(to.flags.some((flag) => flag.endsWith("_FETCH_FAILED")) ? ["TARGET_COLLECTOR_FAILURE"] : [])
  ])].sort();
  const payload = {
    schema_version: 1 as const,
    from_artifact_id: from.artifact_id,
    to_artifact_id: to.artifact_id,
    reference_at: to.reference_at,
    from_flags: from.flags,
    to_flags: to.flags,
    changes, flags
  };
  return { ...payload, comparison_id: `comparison:${hash(payload)}` };
}

export type DecisionSnapshot = {
  schema_version: 1;
  snapshot_id: string;
  evidence_artifact_id: string;
  comparison_id: string | null;
  question: string;
  reference_at: string;
  claims: Array<{
    claim_id: string;
    label: string;
    status: ClaimRecord["status"];
    support_evidence_ids: string[];
    counter_evidence_ids: string[];
    independent_support_families: number;
    independent_counter_families: number;
    dependence_unverified: boolean;
    revalidate_by: string;
    revalidation_due: boolean;
  }>;
  rejected_evidence: Array<{ evidence_id: string; reason: string }>;
  change_flags: string[];
  unresolved: string[];
};

/** A decision brief is a traceable evidence inventory, never an invented recommendation. */
export function makeDecisionSnapshot(
  snapshot: EvidenceSnapshot, question: string, comparison?: EvidenceComparison
): DecisionSnapshot {
  verifySnapshot(snapshot);
  const cleanQuestion = question.trim();
  if (!cleanQuestion || cleanQuestion.length > 1000) throw new Error("question must be 1–1000 characters");
  if (comparison && comparison.to_artifact_id !== snapshot.artifact_id) {
    throw new Error("comparison target does not match evidence artifact");
  }
  const byId = new Map(snapshot.claims.map((claim) => [claim.claim_id, claim]));
  const claims = rankSnapshot(snapshot).map((ranked) => byId.get(ranked.claim_id)!)
    .map((claim) => ({
      claim_id: claim.claim_id, label: claim.label, status: claim.status,
      support_evidence_ids: claim.support_ids, counter_evidence_ids: claim.counter_ids,
      independent_support_families: claim.independent_support_families,
      independent_counter_families: claim.independent_counter_families,
      dependence_unverified: claim.dependence_unverified,
      revalidate_by: claim.revalidate_by,
      revalidation_due: Date.parse(claim.revalidate_by) <= Date.parse(snapshot.reference_at)
    }));
  const unresolved = [...new Set([
    ...(claims.some((claim) => claim.status === "contested") ? ["CONTESTED_CLAIMS"] : []),
    ...(claims.some((claim) => claim.status === "single_origin") ? ["SINGLE_ORIGIN_SUPPORT"] : []),
    ...(claims.some((claim) => claim.status === "unassessed") ? ["STANCE_UNASSESSED"] : []),
    ...(claims.some((claim) => claim.dependence_unverified) ? ["DEPENDENCE_UNVERIFIED"] : []),
    ...(claims.some((claim) => claim.revalidation_due) ? ["REVALIDATION_DUE"] : []),
    ...(snapshot.rejected.length ? ["REJECTED_EVIDENCE_PRESENT"] : []),
    ...snapshot.flags,
    ...(comparison?.flags ?? [])
  ])].sort();
  const payload = {
    schema_version: 1 as const, evidence_artifact_id: snapshot.artifact_id,
    comparison_id: comparison?.comparison_id ?? null,
    question: cleanQuestion, reference_at: snapshot.reference_at,
    claims,
    rejected_evidence: snapshot.rejected.map((record) => ({
      evidence_id: record.evidence_id, reason: record.reason
    })),
    change_flags: comparison?.flags ?? [], unresolved
  };
  return { ...payload, snapshot_id: `decision-snapshot:${hash(payload)}` };
}
