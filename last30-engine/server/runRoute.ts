import { Request, Response } from "express";
import { runEngine } from "../engine/runEngine";

/** Handle POST /run to execute the research engine. */
export async function runRoute(req: Request, res: Response): Promise<void> {
  const { query, window_days, target, mode, sources, top_n, deterministic, allow_t4, annotations } = req.body as {
    query?: string;
    window_days?: number;
    target?: "gpt" | "codex";
    mode?: "quick" | "deep";
    sources?: string[];
    top_n?: number;
    deterministic?: boolean;
    allow_t4?: boolean;
    annotations?: Record<string, { claim_key?: string; stance?: "supports" | "refutes" | "neutral"; primary_url?: string; originator_id?: string; timestamp_basis?: "platform" | "publisher" | "inferred" }>;
  };

  if (typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  if (
    (window_days !== undefined && (!Number.isInteger(window_days) || window_days < 1 || window_days > 3650)) ||
    (top_n !== undefined && (!Number.isInteger(top_n) || top_n < 1 || top_n > 100)) ||
    (target !== undefined && !["gpt", "codex"].includes(target)) ||
    (mode !== undefined && !["quick", "deep"].includes(mode)) ||
    (deterministic !== undefined && typeof deterministic !== "boolean") ||
    (allow_t4 !== undefined && typeof allow_t4 !== "boolean") ||
    (annotations !== undefined && (!annotations || typeof annotations !== "object" ||
      Array.isArray(annotations) || Object.entries(annotations).some(([url, value]) =>
        !url.startsWith("http") || !value || typeof value !== "object" ||
        (value.stance !== undefined && !["supports", "refutes", "neutral"].includes(value.stance)) ||
        (value.timestamp_basis !== undefined &&
          !["platform", "publisher", "inferred"].includes(value.timestamp_basis)) ||
        ["claim_key", "primary_url", "originator_id"].some((key) =>
          (value as Record<string, unknown>)[key] !== undefined &&
          typeof (value as Record<string, unknown>)[key] !== "string"
        )
      ))) ||
    (sources !== undefined && (!Array.isArray(sources) ||
      sources.some((source) => !["reddit", "web", "hn", "github_issue", "github_release"].includes(source))))
  ) {
    res.status(400).json({ error: "invalid run options" });
    return;
  }
  try {
    const result = await runEngine({
      query, window_days, target, mode, sources, top_n, deterministic, allow_t4, annotations
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "run failed" });
  }
}
