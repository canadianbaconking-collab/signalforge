import { Request, Response } from "express";
import { runEngine } from "../engine/runEngine";

/** Handle POST /run to execute the research engine. */
export async function runRoute(req: Request, res: Response): Promise<void> {
  const { query, window_days, target, mode, sources, top_n, deterministic, allow_t4 } = req.body as {
    query?: string;
    window_days?: number;
    target?: "gpt" | "codex";
    mode?: "quick" | "deep";
    sources?: string[];
    top_n?: number;
    deterministic?: boolean;
    allow_t4?: boolean;
  };

  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const result = await runEngine({
    query,
    window_days,
    target,
    mode,
    sources,
    top_n,
    deterministic,
    allow_t4
  });

  res.json(result);
}
