import { CollectedItem } from "./redditCollector";

/** Mock web collector returning deterministic sample data. */
export function webCollector(query: string): CollectedItem[] {
  return [
    {
      title: `${query} workflow checklist`,
      url: "https://example.com/dev-ai-checklist",
      snippet: "A lightweight checklist for AI-assisted development workflows.",
      published_at: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
      source: "web"
    },
    {
      title: "Prompt maintenance guide",
      url: "https://example.com/prompt-maintenance",
      snippet: "Guide to maintaining prompt packs and keeping them current.",
      published_at: null,
      source: "web"
    }
  ];
}
