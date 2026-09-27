import { EvidenceSnapshot } from "../engine/evidence/adjudicate";
import {
  compareSnapshots, EvidenceComparison, makeDecisionSnapshot, verifySnapshot
} from "../engine/evidence/compare";
import { getDb } from "./db";

export class ArtifactError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function loadEvidenceArtifact(artifactId: string): EvidenceSnapshot {
  if (!/^evidence:[a-f0-9]{64}$/.test(artifactId)) {
    throw new ArtifactError("invalid evidence artifact ID", 400);
  }
  const db = getDb();
  const row = db.prepare("SELECT evidence_json FROM runs WHERE artifact_id = ? AND evidence_json IS NOT NULL LIMIT 1")
    .get(artifactId) as { evidence_json: string } | undefined;
  const reviewed = row ?? db.prepare("SELECT evidence_json FROM review_events WHERE artifact_id = ? LIMIT 1")
    .get(artifactId) as { evidence_json: string } | undefined;
  if (!reviewed) throw new ArtifactError("evidence artifact not found", 404);
  let snapshot: EvidenceSnapshot;
  try {
    snapshot = JSON.parse(reviewed.evidence_json) as EvidenceSnapshot;
    verifySnapshot(snapshot);
  } catch {
    throw new ArtifactError("stored evidence artifact failed verification", 409);
  }
  if (snapshot.artifact_id !== artifactId) throw new ArtifactError("stored artifact ID mismatch", 409);
  return snapshot;
}

function storeDerived(id: string, kind: string, payload: unknown): void {
  getDb().prepare("INSERT OR IGNORE INTO derived_artifacts (id, kind, content_json, recorded_at) VALUES (?, ?, ?, ?)")
    .run(id, kind, JSON.stringify(payload), new Date().toISOString());
}

export function recordComparison(fromId: string, toId: string): EvidenceComparison {
  const from = loadEvidenceArtifact(fromId);
  const to = loadEvidenceArtifact(toId);
  let comparison: EvidenceComparison;
  try { comparison = compareSnapshots(from, to); }
  catch (error) { throw new ArtifactError(error instanceof Error ? error.message : "invalid comparison", 400); }
  storeDerived(comparison.comparison_id, "comparison", comparison);
  return comparison;
}

export function recordDecisionSnapshot(
  evidenceId: string, question: string, comparisonId?: string
): ReturnType<typeof makeDecisionSnapshot> {
  const snapshot = loadEvidenceArtifact(evidenceId);
  let comparison: EvidenceComparison | undefined;
  if (comparisonId) {
    const row = getDb().prepare("SELECT content_json FROM derived_artifacts WHERE id = ? AND kind = 'comparison'")
      .get(comparisonId) as { content_json: string } | undefined;
    if (!row) throw new ArtifactError("comparison artifact not found", 404);
    comparison = JSON.parse(row.content_json) as EvidenceComparison;
    const rebuilt = compareSnapshots(
      loadEvidenceArtifact(comparison.from_artifact_id), loadEvidenceArtifact(comparison.to_artifact_id)
    );
    if (rebuilt.comparison_id !== comparisonId || JSON.stringify(rebuilt) !== JSON.stringify(comparison)) {
      throw new ArtifactError("comparison artifact failed verification", 409);
    }
  }
  let decision;
  try { decision = makeDecisionSnapshot(snapshot, question, comparison); }
  catch (error) { throw new ArtifactError(error instanceof Error ? error.message : "invalid decision snapshot", 400); }
  storeDerived(decision.snapshot_id, "decision_snapshot", decision);
  return decision;
}

export function getDerivedArtifact(id: string): unknown {
  if (!/^(comparison|decision-snapshot):[a-f0-9]{64}$/.test(id)) return null;
  const row = getDb().prepare("SELECT content_json FROM derived_artifacts WHERE id = ?")
    .get(id) as { content_json: string } | undefined;
  if (!row) return null;
  try {
    const stored = JSON.parse(row.content_json);
    const rebuilt = id.startsWith("comparison:")
      ? compareSnapshots(
        loadEvidenceArtifact(stored.from_artifact_id), loadEvidenceArtifact(stored.to_artifact_id)
      )
      : makeDecisionSnapshot(
        loadEvidenceArtifact(stored.evidence_artifact_id), stored.question,
        stored.comparison_id ? getDerivedArtifact(stored.comparison_id) as EvidenceComparison : undefined
      );
    const rebuiltId = "snapshot_id" in rebuilt ? rebuilt.snapshot_id : rebuilt.comparison_id;
    if (JSON.stringify(stored) !== JSON.stringify(rebuilt) || rebuiltId !== id) {
      throw new Error("derived artifact content mismatch");
    }
    return stored;
  } catch {
    throw new ArtifactError("stored derived artifact failed verification", 409);
  }
}
