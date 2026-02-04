import { isWithinWindow } from "../ranking/timestampTier";
import { webCollector } from "./webCollector";
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
const FALLBACK_URL_LIMIT = 5;

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
    return fallbackToWebSearch(query, windowDays);
  }
}

function buildRedditSearchUrl(query: string, limit: number): string {
  const { subreddit, search } = parseSubredditQuery(query);
  const encodedQuery = encodeURIComponent(search || query);
  const basePath = subreddit ? `/r/${subreddit}/search.json` : "/search.json";
  const url = new URL(`${REDDIT_BASE_URL}${basePath}`);
  url.searchParams.set("q", encodedQuery);
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
  const children = listing.data?.children ?? [];
  let excludedMissingTimestamp = 0;
  const items = children.flatMap((child) => {
    const data = child.data;
    if (!data?.created_utc) {
      excludedMissingTimestamp += 1;
      return [];
    }
    const publishedAt = new Date(data.created_utc * 1000).toISOString();
    if (!isWithinWindow(publishedAt, windowDays)) {
      return [];
    }
    return [
      {
        title: data.title ?? "",
        url: `${REDDIT_BASE_URL}${data.permalink ?? ""}`,
        snippet: (data.selftext ?? "").trim(),
        published_at: publishedAt,
        source: "reddit"
      }
    ];
  });

  return { items, excludedMissingTimestamp };
}

async function fallbackToWebSearch(query: string, windowDays: number): Promise<RedditCollectorResult> {
  const fallbackItems = webCollector(query)
    .filter((item) => item.url.includes("reddit.com"))
    .slice(0, FALLBACK_URL_LIMIT);

  if (fallbackItems.length === 0) {
    return {
      items: [],
      failed: true,
      strategy_used: "web_fallback",
      excluded_missing_timestamp: 0
    };
  }

  const items: CollectedItem[] = [];
  let excludedMissingTimestamp = 0;
  let hadSuccessfulFetch = false;

  for (const item of fallbackItems) {
    const jsonUrl = buildRedditJsonUrl(item.url);
    try {
      const json = await fetchJson(jsonUrl);
      hadSuccessfulFetch = true;
      const parsed = parseThreadJson(json);
      if (!parsed) {
        excludedMissingTimestamp += 1;
        continue;
      }
      if (isWithinWindow(parsed.published_at, windowDays)) {
        items.push(parsed);
      }
    } catch (error) {
      continue;
    }
  }

  return {
    items,
    failed: !hadSuccessfulFetch,
    strategy_used: "web_fallback",
    excluded_missing_timestamp: excludedMissingTimestamp
  };
}

function buildRedditJsonUrl(url: string): string {
  const redditUrl = new URL(url);
  let pathname = redditUrl.pathname.replace(/\/$/, "");
  if (!pathname.endsWith(".json")) {
    pathname = `${pathname}.json`;
  }
  redditUrl.pathname = pathname;
  redditUrl.search = "";
  return redditUrl.toString();
}

function parseThreadJson(json: unknown): CollectedItem | null {
  if (!Array.isArray(json)) {
    return null;
  }
  const listing = json[0] as { data?: { children?: Array<{ data?: RedditListingData }> } };
  const data = listing?.data?.children?.[0]?.data;
  if (!data?.created_utc) {
    return null;
  }
  const publishedAt = new Date(data.created_utc * 1000).toISOString();
  return {
    title: data.title ?? "",
    url: `${REDDIT_BASE_URL}${data.permalink ?? ""}`,
    snippet: (data.selftext ?? "").trim(),
    published_at: publishedAt,
    source: "reddit"
  };
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
