import express from "express";
import fs from "fs";
import path from "path";
import { runRoute } from "./runRoute";
import { getDb } from "../storage/db";
import { getDecision, recordDecision, recordOutcome } from "../storage/decisions";

const app = express();
const PORT = 8787;

app.use(express.json({ limit: "1mb" }));

const appRoot = path.resolve(__dirname, "..");
const uiPath = [path.join(appRoot, "ui"), path.join(appRoot, "..", "ui")]
  .find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? path.join(appRoot, "ui");
app.use(express.static(uiPath));

app.post("/run", runRoute);

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
