import { CollectedItem } from "./redditCollector";
import { isWithinWindow } from "../ranking/timestampTier";

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const DEFAULT_SNIPPET_LENGTH = 200;
const DEFAULT_REPO_LIMIT = 3;
const DEFAULT_RELEASE_LIMIT = 3;

export type GithubCollectorResult = {
  items: CollectedItem[];
  failed: boolean;
};

type GithubSearchResponse<T> = {
  items: T[];
};

type GithubIssue = {
  title: string;
  html_url: string;
  body: string | null;
  created_at: string;
};

type GithubRepo = {
  full_name: string;
};

type GithubRelease = {
  name: string | null;
  tag_name: string;
  html_url: string;
  body: string | null;
  published_at: string | null;
};

export async function githubCollector(
  query: string,
  windowDays: number,
  limit: number
): Promise<GithubCollectorResult> {
  const sinceDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const headers = buildHeaders();
  const items: CollectedItem[] = [];

  try {
    const issues = await fetchIssues(query, sinceDate, Math.max(1, limit), headers);
    items.push(...issues);

    const releases = await fetchReleases(query, windowDays, headers);
    items.push(...releases);

    return { items, failed: false };
  } catch (error) {
    return { items, failed: true };
  }
}

async function fetchIssues(
  query: string,
  sinceDate: string,
  limit: number,
  headers: HeadersInit
): Promise<CollectedItem[]> {
  const searchParams = new URLSearchParams({
    q: `${query} created:>=${sinceDate}`,
    sort: "created",
    order: "desc",
    per_page: String(Math.min(limit, 10))
  });

  const url = `${GITHUB_API_BASE}/search/issues?${searchParams.toString()}`;
  const data = await fetchJson<GithubSearchResponse<GithubIssue>>(url, headers);

  return (data.items ?? [])
    .filter((issue) => Boolean(issue?.created_at))
    .map((issue) => ({
      title: issue.title,
      url: issue.html_url,
      snippet: buildSnippet(issue.body),
      published_at: new Date(issue.created_at).toISOString(),
      source: "github_issue"
    }));
}

async function fetchReleases(
  query: string,
  windowDays: number,
  headers: HeadersInit
): Promise<CollectedItem[]> {
  const repoParams = new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(DEFAULT_REPO_LIMIT)
  });
  const repoUrl = `${GITHUB_API_BASE}/search/repositories?${repoParams.toString()}`;
  const repoData = await fetchJson<GithubSearchResponse<GithubRepo>>(repoUrl, headers);

  const releases: CollectedItem[] = [];
  for (const repo of repoData.items ?? []) {
    if (!repo.full_name) {
      continue;
    }

    const releaseUrl = `${GITHUB_API_BASE}/repos/${repo.full_name}/releases?per_page=${DEFAULT_RELEASE_LIMIT}`;
    const releaseData = await fetchJson<GithubRelease[]>(releaseUrl, headers);

    for (const release of releaseData ?? []) {
      if (!release.published_at) {
        continue;
      }
      if (!isWithinWindow(release.published_at, windowDays)) {
        continue;
      }
      const publishedAt = new Date(release.published_at).toISOString();
      releases.push({
        title: release.name || release.tag_name,
        url: release.html_url,
        snippet: buildSnippet(release.body),
        published_at: publishedAt,
        source: "github_release"
      });
    }
  }

  return releases;
}

function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": "SignalForge"
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return {
      ...headers,
      Authorization: `Bearer ${token}`
    };
  }

  return headers;
}

function buildSnippet(text: string | null, maxLength: number = DEFAULT_SNIPPET_LENGTH): string {
  if (!text) {
    return "";
  }

  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

async function fetchJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const response = await fetchWithRetry(url, headers);
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchWithRetry(url: string, headers: HeadersInit): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
    }
  }

  throw lastError ?? new Error("GitHub request failed");
}
