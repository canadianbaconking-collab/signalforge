import crypto from "crypto";
import { CollectedItem } from "../collectors/types";
import { assignTimestampTier, TimestampTier } from "../ranking/timestampTier";

export type RejectionReason =
  | "INVALID_URL"
  | "MISSING_TIMESTAMP"
  | "INVALID_TIMESTAMP"
  | "OUTSIDE_WINDOW"
  | "FUTURE_TIMESTAMP"
  | "DUPLICATE_URL";

export type EvidenceRecord = {
  evidence_id: string;
  claim_id: string;
  claim_key: string;
  title: string;
  url: string;
  snippet: string;
  published_at: string | null;
  source: string;
  timestamp_tier: TimestampTier;
  stance: "supports" | "refutes" | "neutral" | "unassessed";
  family_id: string;
  family_basis: "originator" | "primary_url" | "domain";
  primary_url: string | null;
  metadata_origin: "none" | "collector" | "operator";
  /** Explicit review metadata; absent means unknown. */
  originator_id?: string | null;
  /** Preserves a legacy hash-only originator when a schema-v1 review has no raw ID. */
  originator_family_id?: string;
  incentives?: string | null;
  channels?: string[];
};

export type RejectedEvidence = EvidenceRecord & { reason: RejectionReason };

export type ClaimRecord = {
  claim_id: string;
  label: string;
  evidence_ids: string[];
  support_ids: string[];
  counter_ids: string[];
  independent_support_families: number;
  independent_counter_families: number;
  observed_families: number;
  dependence_unverified: boolean;
  status: "contested" | "corroborated" | "single_origin" | "unassessed";
  revalidation: "current" | "revalidate_soon";
  revalidate_by: string;
};

export type EvidenceSnapshot = {
  schema_version: 1 | 2 | 3;
  artifact_id: string;
  evidence_hash: string;
  run_date: string;
  reference_at: string;
  window_days: number;
  accepted: EvidenceRecord[];
  rejected: RejectedEvidence[];
  claims: ClaimRecord[];
  flags: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure, conservative adjudication. No text classifier silently invents claim stance or origin. */
export function adjudicateEvidence(
  collected: CollectedItem[],
  runDate: string,
  windowDays: number,
  collectorFlags: string[] = [],
  referenceAt = `${runDate}T23:59:59.999Z`
): EvidenceSnapshot {
  const reference = Date.parse(referenceAt);
  if (!Number.isFinite(reference) || !Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error("Invalid evidence window or run date");
  }
  const cutoff = reference - windowDays * DAY_MS;
  const prepared = collected.map((item) => prepare(item));
  prepared.sort((a, b) =>
    a.record.url.localeCompare(b.record.url) ||
    tierRank(a.record.timestamp_tier) - tierRank(b.record.timestamp_tier) ||
    a.record.evidence_id.localeCompare(b.record.evidence_id)
  );

  const accepted: EvidenceRecord[] = [];
  const rejected: RejectedEvidence[] = [];
  const seenUrls = new Set<string>();
  for (const { record, invalidUrl, invalidTimestamp } of prepared) {
    let reason: RejectionReason | null = null;
    const time = record.published_at ? Date.parse(record.published_at) : NaN;
    if (invalidUrl) reason = "INVALID_URL";
    else if (invalidTimestamp) reason = "INVALID_TIMESTAMP";
    else if (!record.published_at) reason = "MISSING_TIMESTAMP";
    else if (time > reference) reason = "FUTURE_TIMESTAMP";
    else if (time < cutoff) reason = "OUTSIDE_WINDOW";
    else if (seenUrls.has(record.url)) reason = "DUPLICATE_URL";
    if (reason) {
      rejected.push({ ...record, reason });
    } else {
      accepted.push(record);
      seenUrls.add(record.url);
    }
  }

  return assembleSnapshot(runDate, reference, windowDays, accepted, rejected, collectorFlags);
}

/** Re-adjudicate stored evidence without fetching again or changing rejected records. */
export function reviewEvidenceSnapshot(
  original: EvidenceSnapshot,
  updates: Map<string, Partial<Pick<EvidenceRecord,
    "claim_key" | "stance" | "primary_url" | "originator_id" | "incentives" | "channels">>>
): EvidenceSnapshot {
  const seen = new Set<string>();
  const accepted = original.accepted.map((record) => {
    const update = updates.get(record.url);
    if (!update) return record;
    seen.add(record.url);
    const result: EvidenceRecord = { ...record, metadata_origin: "operator" };
    if (Object.prototype.hasOwnProperty.call(update, "claim_key")) {
      result.claim_key = normalize(update.claim_key || record.title);
      result.claim_id = `claim:${sha256(result.claim_key)}`;
    }
    if (Object.prototype.hasOwnProperty.call(update, "stance")) result.stance = update.stance ?? "unassessed";
    if (Object.prototype.hasOwnProperty.call(update, "incentives")) result.incentives = update.incentives ?? null;
    if (Object.prototype.hasOwnProperty.call(update, "channels")) result.channels = update.channels ?? [];
    if (Object.prototype.hasOwnProperty.call(update, "primary_url")) result.primary_url = update.primary_url ?? null;
    if (Object.prototype.hasOwnProperty.call(update, "originator_id")) {
      result.originator_id = update.originator_id ?? null;
      delete result.originator_family_id;
    }
    if (result.originator_id) {
      result.family_basis = "originator";
      result.family_id = `family:${sha256(`originator:${normalize(result.originator_id)}`)}`;
    } else if (record.family_basis === "originator" &&
               !Object.prototype.hasOwnProperty.call(update, "originator_id") && !record.originator_id) {
      // Legacy snapshots carried the family hash without the raw originator.
      result.family_basis = record.family_basis;
      result.family_id = record.family_id;
    } else if (result.primary_url) {
      result.family_basis = "primary_url";
      result.family_id = `family:${sha256(`primary:${result.primary_url}`)}`;
    } else {
      result.family_basis = "domain";
      result.family_id = `family:${sha256(`domain:${host(result.url)}`)}`;
    }
    const { evidence_id: _oldId, ...identity } = result;
    result.evidence_id = `ev:${sha256(JSON.stringify(identity))}`;
    return result;
  });
  if (seen.size !== updates.size) throw new Error("review URL is not accepted evidence in this artifact");
  const derived = /^(EVIDENCE_REJECTED_|CONTRADICTORY_EVIDENCE$|DEPENDENCE_UNVERIFIED$|REVALIDATION_DUE_SOON$)/;
  const collectorFlags = original.flags.filter((flag) => !derived.test(flag));
  return assembleSnapshot(original.run_date, Date.parse(original.reference_at), original.window_days,
    accepted, [...original.rejected], collectorFlags);
}

/** Shared explicit originators OR primary URLs connect dependent observations.
 * Rebuild from raw provenance on every review so clearing a link can split a family.
 * Domain-only evidence never creates a bridge or becomes verified by association.
 */
function reconcileFamilies(records: EvidenceRecord[]): EvidenceRecord[] {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (key !== root) {
      const next = parent.get(key)!;
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const tokens = records.map(record => {
    const ids: string[] = [];
    if (record.originator_id) ids.push(`family:${sha256(`originator:${normalize(record.originator_id)}`)}`);
    else if (record.family_basis === "originator") ids.push(record.originator_family_id ?? record.family_id);
    if (record.primary_url) ids.push(`family:${sha256(`primary:${record.primary_url}`)}`);
    for (const id of ids) find(id);
    for (const id of ids.slice(1)) {
      const a = find(ids[0]), b = find(id);
      // Lexical root choice makes component identity independent of input order.
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
    return ids;
  });
  return records.map((record, index) => {
    if (!tokens[index].length) return record;
    const family_id = find(tokens[index][0]);
    const legacyOriginator = record.family_basis === "originator" && !record.originator_id
      ? record.originator_family_id ?? record.family_id : undefined;
    if (family_id === record.family_id && legacyOriginator === record.originator_family_id) return record;
    const { evidence_id: _oldId, ...identity } = {
      ...record, family_id, ...(legacyOriginator ? { originator_family_id: legacyOriginator } : {})
    };
    return { evidence_id: `ev:${sha256(JSON.stringify(identity))}`, ...identity };
  });
}

function assembleSnapshot(
  runDate: string, reference: number, windowDays: number,
  accepted: EvidenceRecord[], rejected: RejectedEvidence[], collectorFlags: string[]
): EvidenceSnapshot {
  accepted = reconcileFamilies(accepted);
  const byClaim = new Map<string, EvidenceRecord[]>();
  for (const record of accepted) {
    const group = byClaim.get(record.claim_id) ?? [];
    group.push(record);
    byClaim.set(record.claim_id, group);
  }
  const claims = [...byClaim.entries()].map(([claimId, records]): ClaimRecord => {
    const supports = records.filter((r) => r.stance === "supports");
    const counters = records.filter((r) => r.stance === "refutes");
    const verified = (r: EvidenceRecord) =>
      r.family_basis !== "domain" && r.timestamp_tier !== "T3";
    const supportFamilies = new Set(supports.filter(verified).map((r) => r.family_id));
    const counterFamilies = new Set(counters.filter(verified).map((r) => r.family_id));
    const newest = Math.max(...records.map((r) => Date.parse(r.published_at!)));
    const revalidateBy = newest + windowDays * DAY_MS;
    const status: ClaimRecord["status"] =
      supports.length && counters.length ? "contested" :
      supportFamilies.size >= 2 ? "corroborated" :
      supports.length ? "single_origin" : "unassessed";
    return {
      claim_id: claimId,
      label: [...records].sort((a, b) => a.title.localeCompare(b.title))[0].title,
      evidence_ids: records.map((r) => r.evidence_id).sort(),
      support_ids: supports.map((r) => r.evidence_id).sort(),
      counter_ids: counters.map((r) => r.evidence_id).sort(),
      independent_support_families: supportFamilies.size,
      independent_counter_families: counterFamilies.size,
      observed_families: new Set(records.map((r) => r.family_id)).size,
      dependence_unverified: records.some((r) => r.family_basis === "domain"),
      status,
      revalidation: revalidateBy - reference <= windowDays * DAY_MS * 0.25
        ? "revalidate_soon" : "current",
      revalidate_by: new Date(revalidateBy).toISOString()
    };
  }).sort((a, b) => a.claim_id.localeCompare(b.claim_id));

  const reasons = new Set(rejected.map((r) => r.reason));
  const flags = [...new Set([
    ...collectorFlags,
    ...[...reasons].map((reason) => `EVIDENCE_REJECTED_${reason}`),
    ...(claims.some((claim) => claim.status === "contested") ? ["CONTRADICTORY_EVIDENCE"] : []),
    ...(claims.some((claim) => claim.dependence_unverified) ? ["DEPENDENCE_UNVERIFIED"] : []),
    ...(claims.some((claim) => claim.revalidation === "revalidate_soon") ? ["REVALIDATION_DUE_SOON"] : [])
  ])].sort();
  const payload = {
    schema_version: 3 as const,
    run_date: runDate,
    reference_at: new Date(reference).toISOString(),
    window_days: windowDays,
    accepted, rejected, claims, flags
  };
  const evidenceHash = sha256(JSON.stringify(payload));
  return {
    ...payload,
    artifact_id: `evidence:${evidenceHash}`,
    evidence_hash: evidenceHash
  };
}

function prepare(item: CollectedItem): {
  record: EvidenceRecord;
  invalidUrl: boolean;
  invalidTimestamp: boolean;
} {
  const url = canonicalUrl(item.url);
  const primary = item.primary_url ? canonicalUrl(item.primary_url) : null;
  const parsed = item.published_at ? Date.parse(item.published_at) : NaN;
  const invalidTimestamp = Boolean(item.published_at) && !Number.isFinite(parsed);
  const published = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  const timestampTier = assignTimestampTier(published, item.timestamp_basis ?? "platform").tier;
  const claimKey = normalize(item.claim_key || item.title);
  const claimId = `claim:${sha256(claimKey)}`;
  const familyBasis: EvidenceRecord["family_basis"] =
    item.originator_id ? "originator" : primary ? "primary_url" : "domain";
  const familyKey = item.originator_id
    ? `originator:${normalize(item.originator_id)}`
    : primary ? `primary:${primary}` : `domain:${host(url ?? item.url)}`;
  const recordBase = {
    claim_id: claimId,
    claim_key: claimKey,
    title: item.title.trim(),
    url: url ?? item.url.trim(),
    snippet: item.snippet.trim(),
    published_at: published,
    source: item.source,
    timestamp_tier: timestampTier,
    stance: item.stance ?? "unassessed" as EvidenceRecord["stance"],
    family_id: `family:${sha256(familyKey)}`,
    family_basis: familyBasis,
    primary_url: primary,
    ...(item.originator_id ? { originator_id: item.originator_id } : {}),
    metadata_origin: (item.metadata_origin ??
      (item.claim_key || item.stance || item.primary_url || item.originator_id ? "collector" : "none")) as EvidenceRecord["metadata_origin"]
  };
  return {
    record: { evidence_id: `ev:${sha256(JSON.stringify(recordBase))}`, ...recordBase },
    invalidUrl: !url || Boolean(item.primary_url && !primary),
    invalidTimestamp
  };
}

function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function canonicalUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname) return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

function host(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return "unknown"; }
}

function tierRank(tier: TimestampTier): number {
  return { T1: 1, T2: 2, T3: 3, T4: 4 }[tier];
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
