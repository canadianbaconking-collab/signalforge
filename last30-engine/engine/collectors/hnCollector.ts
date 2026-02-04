import { CollectedItem } from "./redditCollector";

type HnHit = {
  objectID: string;
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  created_at?: string | null;
  created_at_i?: number | null;
};

const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";
const HN_TIMEOUT_MS = 8000;
const HN_RETRIES = 2;
const SNIPPET_LIMIT = 200;

/** Hacker News collector using the Algolia HN search API. */
export async function hnCollector(query: string, limit = 10): Promise<CollectedItem[]> {
  const hitsPerPage = Math.max(1, Math.min(limit, 50));
  const url = `${HN_SEARCH_URL}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${hitsPerPage}`;
  const response = await fetchWithRetry(url, { method: "GET" }, HN_RETRIES, HN_TIMEOUT_MS);
  const payload = (await response.json()) as { hits?: HnHit[] };
  const hits = payload.hits ?? [];

  return hits.slice(0, limit).map((hit) => {
    const publishedAt = hit.created_at_i
      ? new Date(hit.created_at_i * 1000).toISOString()
      : hit.created_at
      ? new Date(hit.created_at).toISOString()
      : new Date().toISOString();
    return {
      title: hit.title?.trim() || "Untitled",
      url: hit.url?.trim() || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      snippet: buildSnippet(hit.story_text),
      published_at: publishedAt,
      source: "hn"
    };
  });
}

function buildSnippet(text?: string | null): string {
  if (!text) {
    return "";
  }
  const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (stripped.length <= SNIPPET_LIMIT) {
    return stripped;
  }
  return `${stripped.slice(0, SNIPPET_LIMIT - 1)}…`;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number,
  timeoutMs: number
): Promise<Response> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HN request failed with status ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("HN request failed");
      if (attempt >= retries) {
        break;
      }
      const backoffMs = 500 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timeoutId);
    }
    attempt += 1;
  }

  throw lastError ?? new Error("HN request failed");
}
