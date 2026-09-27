import express from "express";
import fs from "fs";
import path from "path";
import { runRoute } from "./runRoute";
import { getDb } from "../storage/db";
import { getDecision, recordDecision, recordOutcome } from "../storage/decisions";
import { getReview, recordReview, ReviewError } from "../storage/reviews";
import {
  ArtifactError, getDerivedArtifact, loadEvidenceArtifact, recordComparison, recordDecisionSnapshot
} from "../storage/derivedArtifacts";

const app = express();
const PORT = 8787;

app.use(express.json({ limit: "1mb" }));

const appRoot = path.resolve(__dirname, "..");
const uiPath = [path.join(appRoot, "ui"), path.join(appRoot, "..", "ui")]
  .find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? path.join(appRoot, "ui");
app.use(express.static(uiPath));

app.post("/run", runRoute);

app.get("/evidence-artifacts", (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT artifact_id, id AS run_id, query, created_at AS recorded_at, 'collection' AS origin
    FROM runs WHERE artifact_id IS NOT NULL
    UNION ALL
    SELECT e.artifact_id, e.run_id, r.query, e.recorded_at, 'review' AS origin
    FROM review_events e JOIN runs r ON r.id = e.run_id
    ORDER BY recorded_at DESC, artifact_id DESC LIMIT 200
  `).all();
  res.json(rows);
});

app.post("/compare", (req, res) => {
  try {
    if (typeof req.body?.from_artifact_id !== "string" || typeof req.body?.to_artifact_id !== "string") {
      throw new ArtifactError("from_artifact_id and to_artifact_id are required", 400);
    }
    res.json(recordComparison(req.body.from_artifact_id, req.body.to_artifact_id));
  } catch (error) {
    res.status(error instanceof ArtifactError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : "comparison failed" });
  }
});

app.post("/decision-snapshot", (req, res) => {
  try {
    if (typeof req.body?.evidence_artifact_id !== "string" || typeof req.body?.question !== "string" ||
        (req.body.comparison_id !== undefined && typeof req.body.comparison_id !== "string")) {
      throw new ArtifactError("evidence_artifact_id and question are required", 400);
    }
    res.json(recordDecisionSnapshot(
      req.body.evidence_artifact_id, req.body.question, req.body.comparison_id
    ));
  } catch (error) {
    res.status(error instanceof ArtifactError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : "decision snapshot failed" });
  }
});

app.get("/derived-artifact/:id", (req, res) => {
  try {
    const artifact = getDerivedArtifact(req.params.id);
    if (!artifact) { res.status(404).json({ error: "derived artifact not found" }); return; }
    res.json(artifact);
  } catch (error) {
    res.status(error instanceof ArtifactError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : "artifact read failed" });
  }
});

app.get("/evidence-artifact/:id", (req, res) => {
  try { res.json(loadEvidenceArtifact(req.params.id)); }
  catch (error) {
    res.status(error instanceof ArtifactError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : "evidence read failed" });
  }
});

app.get("/review/:run_id", (req, res) => {
  const artifactId = typeof req.query.artifact_id === "string" ? req.query.artifact_id : undefined;
  const review = getReview(req.params.run_id, artifactId);
  if (!review) { res.status(404).json({ error: "review artifact not found" }); return; }
  res.json(review);
});

app.post("/review/:run_id", (req, res) => {
  try {
    const saved = recordReview(req.params.run_id, req.body);
    res.status(201).json(saved);
  } catch (error) {
    res.status(error instanceof ReviewError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : "review failed" });
  }
});

app.post("/decision", (req, res) => {
  try {
    res.json(recordDecision(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "invalid decision" });
  }
});

app.post("/outcome", (req, res) => {
  try {
    res.json(recordOutcome(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "invalid outcome" });
  }
});

app.get("/decision/:id", (req, res) => {
  const decision = getDecision(req.params.id);
  if (!decision) {
    res.status(404).json({ error: "decision not found" });
    return;
  }
  res.json(decision);
});

app.get("/artifact", (req, res) => {
  const relativePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!relativePath) {
    res.status(400).json({ error: "path is required" });
    return;
  }

  const normalizedPath = path.normalize(relativePath);
  if (path.isAbsolute(relativePath) || normalizedPath.includes("..") || normalizedPath.startsWith("..")) {
    res.status(400).json({ error: "invalid artifact path" });
    return;
  }

  const runsDir = path.join(appRoot, "runs");
  const resolvedPath = path.resolve(runsDir, normalizedPath);
  const relativeToRuns = path.relative(runsDir, resolvedPath);
  if (relativeToRuns.startsWith("..") || path.isAbsolute(relativeToRuns)) {
    res.status(400).json({ error: "invalid artifact path" });
    return;
  }

  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }

  res.sendFile(resolvedPath);
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(uiPath, "index.html"));
});

getDb();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`SignalForge server running at http://localhost:${PORT}`);
});
