export type CollectedItem = {
  title: string;
  url: string;
  snippet: string;
  published_at: string | null;
  source: string;
};

/** Mock Reddit collector returning deterministic sample data. */
export function redditCollector(query: string): CollectedItem[] {
  const base = "https://reddit.com/r/programming";
  return [
    {
      title: `Dev workflow tip: ${query} automation` ,
      url: `${base}/comments/abc123`,
      snippet: "Discussion on automating routine checks for AI-assisted coding.",
      published_at: new Date().toISOString(),
      source: "reddit"
    },
    {
      title: "Local-first tools for AI experimentation",
      url: `${base}/comments/def456`,
      snippet: "Users compare local-first research notebooks and prompt workflows.",
      published_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      source: "reddit"
    }
  ];
}
