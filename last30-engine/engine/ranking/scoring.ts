import { CollectedItem } from "../collectors/redditCollector";

export type ScoredItem = CollectedItem & {
  score: number;
};

/** Assign a deterministic placeholder score based on index. */
export function scoreItems(items: CollectedItem[]): ScoredItem[] {
  return items.map((item, index) => ({
    ...item,
    score: 100 - index * 3
  }));
}
