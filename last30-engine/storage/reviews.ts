import crypto from "crypto";
import { EvidenceRecord, EvidenceSnapshot, reviewEvidenceSnapshot } from "../engine/evidence/adjudicate";
import { getDb } from "./db";

type ReviewEdit = {
  url: string;
  claim_key?: string | null;
  stance?: "supports" | "refutes" | "neutral" | "unassessed" | null;
  primary_url?: string | null;
  originator_id?: string | null;
  incentives?: string | null;
  channels?: string[] | null;
};
export type ReviewInput = {
  base_artifact_id: string;
  rationale: string;
  edits: ReviewEdit[];
};

export class ReviewError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

function originalSnapshot(runId: string): EvidenceSnapshot | null {
  const row = getDb().prepare("SELECT evidence_json FROM runs WHERE id = ?").get(runId) as
    { evidence_json: string | null } | undefined;
  return row?.evidence_json ? JSON.parse(row.evidence_json) as EvidenceSnapshot : null;
}

function history(runId: string): Array<Record<string, unknown>> {
  return getDb().prepare(`SELECT review_id, parent_artifact_id, artifact_id, rationale, edits_json, recorded_at
    FROM review_events WHERE run_id = ? ORDER BY event_number`).all(runId).map((row: any) => {
    const { edits_json, ...event } = row;
    return { ...event, edits: JSON.parse(edits_json) };
  });
}

export function getReview(runId: string, artifactId?: string): unknown {
  const original = originalSnapshot(runId);
  if (!original) return null;
  const events = history(runId);
  const latest = events.length ? String(events[events.length - 1].artifact_id) : original.artifact_id;
  const selected = artifactId || latest;
  let snapshot = original;
  if (selected !== original.artifact_id) {
    const row = getDb().prepare("SELECT evidence_json FROM review_events WHERE run_id = ? AND artifact_id = ?")
      .get(runId, selected) as { evidence_json: string } | undefined;
    if (!row) return null;
    snapshot = JSON.parse(row.evidence_json) as EvidenceSnapshot;
  }
  return {
    run_id: runId, original_artifact_id: original.artifact_id, latest_artifact_id: latest,
    snapshot, history: events,
    candidates: snapshot.claims.map((claim) => ({
      ...claim,
      observations: snapshot.accepted.filter((record) => record.claim_id === claim.claim_id)
        .map((record) => ({
          evidence_id: record.evidence_id, url: record.url, title: record.title, source: record.source,
          stance: record.stance, family_basis: record.family_basis, family_id: record.family_id,
          primary_url: record.primary_url, originator_id: record.originator_id ?? null,
          incentives: record.incentives ?? null, channels: record.channels ?? [],
          metadata_origin: record.metadata_origin
        }))
    }))
  };
}

function validateEdit(edit: unknown): ReviewEdit {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new ReviewError("invalid review edit", 400);
  const value = edit as Record<string, unknown>;
  const allowed = ["url", "claim_key", "stance", "primary_url", "originator_id", "incentives", "channels"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      !allowed.slice(1).some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ReviewError("review edit requires at least one supported annotation", 400);
  }
  if (typeof value.url !== "string" || !/^https?:\/\//.test(value.url)) {
    throw new ReviewError("review URL must be an exact accepted http(s) URL", 400);
  }
  for (const key of ["claim_key", "primary_url", "originator_id", "incentives"]) {
    if (key in value && value[key] !== null &&
        (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > 1000)) {
      throw new ReviewError(`${key} must be a nonempty string or null`, 400);
    }
  }
  if (value.primary_url) {
    try {
      const parsed = new URL(value.primary_url as string);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
      parsed.hash = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
      }
      parsed.searchParams.sort();
      if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      value.primary_url = parsed.toString();
    } catch { throw new ReviewError("primary_url must be an http(s) URL", 400); }
  }
  if ("stance" in value && value.stance !== null &&
      !["supports", "refutes", "neutral", "unassessed"].includes(value.stance as string)) {
    throw new ReviewError("invalid stance", 400);
  }
  if ("channels" in value && value.channels !== null &&
      (!Array.isArray(value.channels) || value.channels.length > 10 ||
       value.channels.some((channel: unknown) => typeof channel !== "string" || !channel.trim() || channel.length > 120))) {
    throw new ReviewError("channels must contain at most ten nonempty strings or null", 400);
  }
  const cleaned: Record<string, unknown> = { url: value.url };
  for (const key of allowed.slice(1)) {
    if (!(key in value)) continue;
    cleaned[key] = Array.isArray(value[key])
      ? [...new Set((value[key] as string[]).map((channel) => channel.trim()))].sort()
      : typeof value[key] === "string" ? (value[key] as string).trim() : value[key];
  }
  return cleaned as ReviewEdit;
}

/** Append one review event and its immutable resulting evidence snapshot. */
export function recordReview(runId: string, input: ReviewInput): { review_id: string; artifact_id: string } {
  if (!input || typeof input !== "object" ||
      typeof input.base_artifact_id !== "string" ||
      typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 4000 ||
      !Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100) {
    throw new ReviewError("base_artifact_id, rationale, and 1–100 edits are required", 400);
  }
  const edits = input.edits.map(validateEdit);
  if (new Set(edits.map((edit) => edit.url)).size !== edits.length) {
    throw new ReviewError("duplicate review URL", 400);
  }
  const database = getDb();
  return database.transaction(() => {
    const original = originalSnapshot(runId);
    if (!original) throw new ReviewError("run not found", 404);
    const latest = database.prepare("SELECT artifact_id, evidence_json FROM review_events WHERE run_id = ? ORDER BY event_number DESC LIMIT 1")
      .get(runId) as { artifact_id: string; evidence_json: string } | undefined;
    const parent = latest ? JSON.parse(latest.evidence_json) as EvidenceSnapshot : original;
    if (parent.artifact_id !== input.base_artifact_id) {
      throw new ReviewError("stale base_artifact_id; reload the latest review", 409);
    }
    const acceptedUrls = new Set(parent.accepted.map((item) => item.url));
    if (edits.some((edit) => !acceptedUrls.has(edit.url))) {
      throw new ReviewError("review URLs must exactly match accepted evidence in the base artifact", 400);
    }
    const updates = new Map<string, Partial<Pick<EvidenceRecord,
      "claim_key" | "stance" | "primary_url" | "originator_id" | "incentives" | "channels">>>();
    for (const { url, ...annotations } of edits) updates.set(url, annotations as any);
    const snapshot = reviewEvidenceSnapshot(parent, updates);
    if (snapshot.artifact_id === parent.artifact_id) throw new ReviewError("review changes no evidence", 400);
    const reviewId = `review:${crypto.randomUUID()}`;
    database.prepare(`INSERT INTO review_events
      (review_id, run_id, parent_artifact_id, artifact_id, rationale, edits_json, evidence_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      reviewId, runId, parent.artifact_id, snapshot.artifact_id, input.rationale.trim(),
      JSON.stringify(edits), JSON.stringify(snapshot), new Date().toISOString()
    );
    return { review_id: reviewId, artifact_id: snapshot.artifact_id };
  })();
}
