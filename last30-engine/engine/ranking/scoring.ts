import { IdeaClusteredItem } from "./ideaClustering";

export type ScoredItem = IdeaClusteredItem & {
  score: number;
};

/** Assign a deterministic placeholder score based on index. */
export function scoreItems(items: IdeaClusteredItem[]): ScoredItem[] {
  return items.map((item, index) => ({
    ...item,
    score: 100 - index * 3
  }));
}
