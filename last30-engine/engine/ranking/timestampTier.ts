export type TimestampTier = "T1" | "T2" | "T3" | "T4";

export type TimestampResult = {
  tier: TimestampTier;
  isValid: boolean;
};

/** Assign timestamp tier and validate ISO timestamp. */
export function assignTimestampTier(
  publishedAt: string | null,
  basis: "platform" | "publisher" | "inferred" = "platform"
): TimestampResult {
  if (!publishedAt) {
    return { tier: "T4", isValid: false };
  }

  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return { tier: "T4", isValid: false };
  }

  return { tier: basis === "platform" ? "T1" : basis === "publisher" ? "T2" : "T3", isValid: true };
}

/** Filter items older than the configured window. */
export function isWithinWindow(publishedAt: string | null, windowDays: number, referenceTime = Date.now()): boolean {
  if (!publishedAt) {
    return false;
  }

  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const ageMs = referenceTime - parsed;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs <= windowMs;
}
