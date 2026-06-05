---
title: Retrieval Protocol
type: reference
status: active
confidence: medium
source: memory-mcp bootstrap
verified-by: memory-mcp
last-verified: "2026-05-17"
tags:
  - retrieval
  - token-economy
  - project/general
created: "2026-05-16"
updated: "2026-05-17"
---

# Retrieval Protocol

> [!important]
> The goal is to retrieve the right memory, not the most memory.

## Default MCP Flow

1. Call `memory_sessionStart` for startup context and lifecycle tracking.
2. Call `memory_contextPack` with the current task or area and mode.
3. Inspect selected paths, scores, mode metadata, followUps, and usage hints.
4. Call `memory_followUpRadar` when you need a focused open-work scan.
5. Call `memory_get` only for paths that need full body.
6. If a lesson repeats across sessions, write an insight instead of re-reading every old log.
7. End meaningful work with `memory_sessionEnd`; it writes a session log, refreshes `Auto-Memory-Digest`, and returns vault health plus a quality gate when supported.

## Context Pack Modes

- `auto`: infer a mode from `query` and `taskArea`, falling back to generic retrieval.
- `coding`: implementation, APIs, components, schemas, and tests.
- `debugging`: bugs, regressions, exceptions, and broken workflows.
- `review`: code review, risk audit, PR checks, and quality assessment.
- `deploy`: production, releases, migrations, rollback, and operations.
- `planning`: roadmap, architecture, prioritization, and decisions.
- `docs`: README, setup, reference notes, guides, and protocol updates.

## Read Order

1. Rules and goals
2. Matching ADRs
3. Matching runbooks
4. Open mistakes in the area
5. Recent session logs
6. Full note bodies only when needed

## Follow-up Radar

`memory_followUpRadar` scans unchecked tasks and follow-up sections, then scores open work by query, taskArea, and mode. `memory_sessionStart` and `memory_contextPack` include compact `followUps` so unresolved work is visible before new changes begin.

## Token Budget Defaults

- Startup context: 12 items / 6000 chars
- Task context: 10 items / 5000 chars
- Session logs: excerpts only until selected
- Mistakes and ADRs outrank generic notes
- Repeatedly selected notes receive a lightweight usage boost
