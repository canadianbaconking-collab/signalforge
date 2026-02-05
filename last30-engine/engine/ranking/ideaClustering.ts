import crypto from "crypto";
import { ClusteredItem } from "./clustering";

export type EvidenceGrade = "discussion-only" | "implementation-confirmed" | "multi-confirmed";

export type IdeaClusteredItem = ClusteredItem & {
  idea_cluster_id: string;
  idea_label: string;
  origin_id: string;
  origin_count: number;
  echo_risk: number;
  evidence_grade: EvidenceGrade;
};

export type IdeaClusterSummary = {
  id: string;
  label: string;
  origin_count: number;
  echo_risk: number;
  evidence_grade: EvidenceGrade;
  item_count: number;
};

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "with",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves"
]);

const SIGNATURE_TOKEN_COUNT = 5;
const HASH_LENGTH = 10;

export function clusterIdeas(items: ClusteredItem[]): {
  items: IdeaClusteredItem[];
  clusters: IdeaClusterSummary[];
} {
  const prepared = items.map((item) => {
    const { signature, label } = buildSignature(item.title, item.snippet);
    const ideaClusterId = hashValue(signature);
    const host = extractHost(item.url);
    const originId = hashValue(`${host}|${signature}`);
    return {
      item,
      signature,
      label,
      idea_cluster_id: ideaClusterId,
      origin_id: originId
    };
  });

  const clusters = new Map<string, { label: string; items: typeof prepared }>();
  for (const entry of prepared) {
    const existing = clusters.get(entry.idea_cluster_id);
    if (existing) {
      existing.items.push(entry);
    } else {
      clusters.set(entry.idea_cluster_id, { label: entry.label, items: [entry] });
    }
  }

  const clusterSummaries: IdeaClusterSummary[] = [];
  for (const [id, cluster] of clusters.entries()) {
    const originCount = new Set(cluster.items.map((entry) => entry.origin_id)).size;
    const itemCount = cluster.items.length;
    const echoRisk = clamp01(1 - originCount / itemCount);
    const evidenceGrade = deriveEvidenceGrade(cluster.items.map((entry) => entry.item.source));

    clusterSummaries.push({
      id,
      label: cluster.label,
      origin_count: originCount,
      echo_risk: echoRisk,
      evidence_grade: evidenceGrade,
      item_count: itemCount
    });
  }

  const summaryMap = new Map(clusterSummaries.map((summary) => [summary.id, summary]));
  const outputItems: IdeaClusteredItem[] = prepared.map((entry) => {
    const summary = summaryMap.get(entry.idea_cluster_id);
    return {
      ...entry.item,
      idea_cluster_id: entry.idea_cluster_id,
      idea_label: summary?.label ?? entry.label,
      origin_id: entry.origin_id,
      origin_count: summary?.origin_count ?? 1,
      echo_risk: summary?.echo_risk ?? 0,
      evidence_grade: summary?.evidence_grade ?? "discussion-only"
    };
  });

  return { items: outputItems, clusters: clusterSummaries };
}

function buildSignature(title: string, snippet: string): { signature: string; label: string } {
  const tokens = tokenize(`${title} ${snippet}`);
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const topTokens = Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, SIGNATURE_TOKEN_COUNT)
    .map(([token]) => token);

  if (topTokens.length === 0) {
    return { signature: "misc", label: "misc" };
  }

  const signatureTokens = [...topTokens].sort();
  const signature = signatureTokens.join("|");
  const label = signatureTokens.join(" ");
  return { signature, label };
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return matches.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function hashValue(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function extractHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch (error) {
    return url;
  }
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function deriveEvidenceGrade(sources: string[]): EvidenceGrade {
  const categories = new Set(sources.map((source) => categorizeSource(source)));
  const gradedCategories = new Set(
    Array.from(categories).filter((category) => category !== "web")
  );
  const categoryCount = gradedCategories.size;
  const hasImplementation = categories.has("implementation");

  if (categoryCount >= 2) {
    return "multi-confirmed";
  }
  if (hasImplementation) {
    return "implementation-confirmed";
  }
  return "discussion-only";
}

function categorizeSource(source: string): "discussion" | "implementation" | "demonstration" | "web" {
  if (source === "reddit" || source === "hn") {
    return "discussion";
  }
  if (source === "github_issue" || source === "github_release") {
    return "implementation";
  }
  if (source === "youtube") {
    return "demonstration";
  }
  return "web";
}
