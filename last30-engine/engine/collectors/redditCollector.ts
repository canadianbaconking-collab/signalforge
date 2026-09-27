import { isWithinWindow } from "../ranking/timestampTier";
import { CollectedItem } from "./types";

export type RedditCollectorResult = {
  items: CollectedItem[];
  failed: boolean;
  strategy_used: "reddit_json" | "web_fallback";
  excluded_missing_timestamp: number;
};

const REDDIT_BASE_URL = "https://www.reddit.com";
const USER_AGENT = "SignalForge/0.1 (local instrument)";
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_ATTEMPTS = 2;

export async function redditCollector(
  query: string,
  windowDays: number,
  limit: number
): Promise<RedditCollectorResult> {
  try {
    const searchUrl = buildRedditSearchUrl(query, limit);
    const json = await fetchJson(searchUrl);
    const { items, excludedMissingTimestamp } = parseSearchResults(json, windowDays);
    return {
      items,
      failed: false,
      strategy_used: "reddit_json",
      excluded_missing_timestamp: excludedMissingTimestamp
    };
  } catch (error) {
    // Never substitute mock web observations for a failed live API.
    return { items: [], failed: true, strategy_used: "reddit_json", excluded_missing_timestamp: 0 };
  }
}

function buildRedditSearchUrl(query: string, limit: number): string {
  const { subreddit, search } = parseSubredditQuery(query);
  const searchQuery = search || query;
  const basePath = subreddit ? `/r/${subreddit}/search.json` : "/search.json";
  const url = new URL(`${REDDIT_BASE_URL}${basePath}`);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("sort", "new");
  url.searchParams.set("t", "month");
  url.searchParams.set("limit", String(limit));
  if (subreddit) {
    url.searchParams.set("restrict_sr", "on");
  }
  return url.toString();
}

function parseSubredditQuery(query: string): { subreddit: string | null; search: string } {
  const trimmed = query.trim();
  const match = trimmed.match(/^r\/([A-Za-z0-9_]+)\s*(.*)$/);
  if (!match) {
    return { subreddit: null, search: trimmed };
  }
  return { subreddit: match[1], search: match[2].trim() };
}

function parseSearchResults(
  json: unknown,
  windowDays: number
): { items: CollectedItem[]; excludedMissingTimestamp: number } {
  const listing = json as { data?: { children?: Array<{ data?: RedditListingData }> } };
  const children = listing?.data?.children;
  if (!Array.isArray(children)) throw new Error("Invalid Reddit listing response");
  let excludedMissingTimestamp = 0;
  const items = children.flatMap((child) => {
    const data = child?.data;
    const date = new Date(typeof data?.created_utc === "number" ? data.created_utc * 1000 : NaN);
    if (Number.isNaN(date.getTime())) {
      excludedMissingTimestamp += 1;
      return [];
    }
    const publishedAt = date.toISOString();
    if (!isWithinWindow(publishedAt, windowDays)) {
      return [];
    }
    return [
      {
        title: data!.title ?? "",
        url: `${REDDIT_BASE_URL}${data!.permalink ?? ""}`,
        snippet: (data!.selftext ?? "").trim(),
        published_at: publishedAt,
        source: "reddit",
        timestamp_basis: "platform" as const
      }
    ];
  });

  return { items, excludedMissingTimestamp };
}

async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT
        }
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_ATTEMPTS) {
        await wait(400 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RedditListingData = {
  title?: string;
  permalink?: string;
  selftext?: string;
  created_utc?: number;
};
