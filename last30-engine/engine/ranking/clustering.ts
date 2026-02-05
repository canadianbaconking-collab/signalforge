import crypto from "crypto";
import { CollectedItem } from "../collectors/types";

export type ClusteredItem = CollectedItem & {
  cluster_id: string;
  timestamp_tier?: string;
};

/** Deduplicate identical URLs and assign cluster IDs. */
export function clusterItems(items: CollectedItem[]): ClusteredItem[] {
  const seen = new Map<string, CollectedItem>();
  for (const item of items) {
    if (!seen.has(item.url)) {
      seen.set(item.url, item);
    }
  }

  return Array.from(seen.values()).map((item) => ({
    ...item,
    cluster_id: crypto.createHash("sha1").update(item.url).digest("hex").slice(0, 10)
  }));
}
