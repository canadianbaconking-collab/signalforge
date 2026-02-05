import express from "express";
import fs from "fs";
import path from "path";
import { runRoute } from "./runRoute";
import { getDb } from "../storage/db";

const app = express();
const PORT = 8787;

app.use(express.json({ limit: "1mb" }));

const uiPath = path.join(__dirname, "..", "ui");
app.use(express.static(uiPath));

app.post("/run", runRoute);

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

  const runsDir = path.join(__dirname, "..", "runs");
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

app.listen(PORT, () => {
  console.log(`SignalForge server running at http://localhost:${PORT}`);
});
