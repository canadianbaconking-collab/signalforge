import crypto from "crypto";
import { getDb } from "./db";
import { EvidenceSnapshot } from "../engine/evidence/adjudicate";

export type DecisionInput = {
  run_id: string;
  artifact_id: string;
  question: string;
  choice: string;
  rationale: string;
  claim_ids: string[];
};

export type OutcomeInput = {
  decision_id: string;
  observed_at: string;
  rating: number;
  notes: string;
  confounders?: string[];
};

function id(prefix: string, value: unknown): string {
  return `${prefix}:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

/** Immutable decision record linked to one exact evidence snapshot and its claim IDs. */
export function recordDecision(input: DecisionInput): { decision_id: string; artifact_id: string } {
  const database = getDb();
  const runId = nonempty(input.run_id, "run_id");
  const artifactId = nonempty(input.artifact_id, "artifact_id");
  const question = nonempty(input.question, "question");
  const choice = nonempty(input.choice, "choice");
  const rationale = nonempty(input.rationale, "rationale");
  if (!Array.isArray(input.claim_ids) || input.claim_ids.length === 0 ||
      !input.claim_ids.every((claim) => typeof claim === "string")) {
    throw new Error("claim_ids must contain at least one claim");
  }
  const row = database.prepare("SELECT artifact_id, evidence_json FROM runs WHERE id = ?").get(runId) as
    | { artifact_id: string | null; evidence_json: string | null } | undefined;
  const reviewed = row && row.artifact_id !== artifactId
    ? database.prepare("SELECT evidence_json FROM review_events WHERE run_id = ? AND artifact_id = ?")
      .get(runId, artifactId) as { evidence_json: string } | undefined
    : undefined;
  const evidenceJson = row?.artifact_id === artifactId ? row.evidence_json : reviewed?.evidence_json;
  if (!evidenceJson) {
    throw new Error("run and artifact_id do not match a stored evidence snapshot");
  }
  const snapshot = JSON.parse(evidenceJson) as EvidenceSnapshot;
  const known = new Set(snapshot.claims.map((claim) => claim.claim_id));
  const claims = [...new Set(input.claim_ids)].sort();
  if (claims.some((claim) => !known.has(claim))) throw new Error("claim_ids contain an unknown claim");
  const payload = { run_id: runId, artifact_id: artifactId, question, choice, rationale, claim_ids: claims };
  const decisionId = id("decision", payload);
  database.prepare(
    "INSERT OR IGNORE INTO decisions (id, run_id, artifact_id, question, choice, rationale, claim_ids_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(decisionId, runId, artifactId, question, choice, rationale, JSON.stringify(claims), new Date().toISOString());
  return { decision_id: decisionId, artifact_id: artifactId };
}

/** Append-only outcome event. A rating is an observation, not retroactive evidence. */
export function recordOutcome(input: OutcomeInput): { outcome_id: string; decision_id: string } {
  const database = getDb();
  const decisionId = nonempty(input.decision_id, "decision_id");
  if (!Number.isInteger(input.rating) || input.rating < 0 || input.rating > 5) {
    throw new Error("rating must be an integer from 0 to 5");
  }
  if (typeof input.observed_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.observed_at)) {
    throw new Error("observed_at must be an ISO timestamp");
  }
  const observed = Date.parse(input.observed_at);
  if (!Number.isFinite(observed)) throw new Error("observed_at must be an ISO timestamp");
  const exists = database.prepare("SELECT 1 FROM decisions WHERE id = ?").get(decisionId);
  if (!exists) throw new Error("decision_id does not exist");
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const confounders = input.confounders ?? [];
  if (!Array.isArray(confounders) || !confounders.every((value) => typeof value === "string")) {
    throw new Error("confounders must be strings");
  }
  const payload = {
    decision_id: decisionId,
    observed_at: new Date(observed).toISOString(),
    rating: input.rating,
    notes,
    confounders: [...new Set(confounders.map((value) => value.trim()).filter(Boolean))].sort()
  };
  const outcomeId = id("outcome", payload);
  database.prepare(
    "INSERT OR IGNORE INTO outcomes (id, decision_id, observed_at, rating, notes, confounders_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(outcomeId, decisionId, payload.observed_at, payload.rating, notes, JSON.stringify(payload.confounders));
  return { outcome_id: outcomeId, decision_id: decisionId };
}

export function getDecision(decisionId: string): unknown {
  const database = getDb();
  const row = database.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as
    | Record<string, unknown> | undefined;
  if (!row) return null;
  const outcomes = database.prepare("SELECT * FROM outcomes WHERE decision_id = ? ORDER BY observed_at, id").all(decisionId) as
    Array<Record<string, unknown>>;
  return {
    ...row,
    claim_ids: JSON.parse(row.claim_ids_json as string),
    claim_ids_json: undefined,
    outcomes: outcomes.map((outcome) => ({
      ...outcome,
      confounders: JSON.parse(outcome.confounders_json as string),
      confounders_json: undefined
    }))
  };
}
