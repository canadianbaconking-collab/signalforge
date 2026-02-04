# SignalForge (Last30 Engine)

SignalForge is a local-first research microtool that collects recent developer + AI workflow signals from mock sources, ranks them deterministically, and produces a copyable context block for GPT or Codex.

## Project Overview

- Local-first, deterministic research scaffold
- Express + TypeScript server with SQLite persistence
- Vanilla HTML UI for running and copying context blocks

## Install

```bash
cd last30-engine
npm install
```

## Run

```bash
npm run dev
```

Open [http://localhost:8787](http://localhost:8787).

## Example curl request

```bash
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{
    "query": "AI code review workflows",
    "window_days": 30,
    "target": "gpt",
    "mode": "quick",
    "sources": ["reddit", "web", "hn"],
    "top_n": 5
  }'
```
