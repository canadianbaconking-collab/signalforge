import express from "express";
import path from "path";
import { runRoute } from "./runRoute";
import { getDb } from "../storage/db";

const app = express();
const PORT = 8787;

app.use(express.json({ limit: "1mb" }));

const uiPath = path.join(__dirname, "..", "ui");
app.use(express.static(uiPath));

app.post("/run", runRoute);

app.get("/", (_req, res) => {
  res.sendFile(path.join(uiPath, "index.html"));
});

getDb();

app.listen(PORT, () => {
  console.log(`SignalForge server running at http://localhost:${PORT}`);
});
