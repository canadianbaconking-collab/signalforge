import { CollectedItem } from "./redditCollector";

/** Mock Hacker News collector returning deterministic sample data. */
export function hnCollector(query: string): CollectedItem[] {
  return [
    {
      title: `${query} recap: practical AI dev loops`,
      url: "https://news.ycombinator.com/item?id=123456",
      snippet: "Highlights from recent discussion about AI-assisted dev loops.",
      published_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      source: "hn"
    },
    {
      title: "Local-first search strategies",
      url: "https://news.ycombinator.com/item?id=654321",
      snippet: "Notes on search strategies for private developer workflows.",
      published_at: new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString(),
      source: "hn"
    }
  ];
}
