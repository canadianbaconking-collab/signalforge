export type TimestampTier = "T1" | "T4";

export type TimestampResult = {
  tier: TimestampTier;
  isValid: boolean;
};

/** Assign timestamp tier and validate ISO timestamp. */
export function assignTimestampTier(publishedAt: string | null): TimestampResult {
  if (!publishedAt) {
    return { tier: "T4", isValid: false };
  }

  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return { tier: "T4", isValid: false };
  }

  return { tier: "T1", isValid: true };
}

/** Filter items older than the configured window. */
export function isWithinWindow(publishedAt: string | null, windowDays: number): boolean {
  if (!publishedAt) {
    return true;
  }

  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const ageMs = Date.now() - parsed;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return ageMs <= windowMs;
}
