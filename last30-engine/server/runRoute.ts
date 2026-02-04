import { Request, Response } from "express";
import { runEngine } from "../engine/runEngine";

/** Handle POST /run to execute the research engine. */
export function runRoute(req: Request, res: Response): void {
  const { query, window_days, target, mode, sources, top_n } = req.body as {
    query?: string;
    window_days?: number;
    target?: "gpt" | "codex";
    mode?: "quick" | "deep";
    sources?: string[];
    top_n?: number;
  };

  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const result = runEngine({
    query,
    window_days,
    target,
    mode,
    sources,
    top_n
  });

  res.json(result);
}
