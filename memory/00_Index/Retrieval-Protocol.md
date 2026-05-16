---
title: Retrieval Protocol
type: reference
status: active
created: 2026-05-16
updated: 2026-05-16
tags:
  - retrieval
  - token-economy
  - project/general
last-verified: 2026-05-16
verified-by: memory-mcp
source: memory-mcp bootstrap
confidence: medium
---
# Retrieval Protocol

> [!important]
> The goal is to retrieve the right memory, not the most memory.

## Default MCP Flow

1. Call `memory_contextPack` with the current task or area.
2. Inspect selected paths, scores, and usage hints.
3. Call `memory_get` only for paths that need full body.
4. If a lesson repeats across sessions, write an insight instead of re-reading every old log.
5. End meaningful work with `memory_sessionEnd`; it writes a session log, refreshes `Auto-Memory-Digest`, and returns vault health when supported.

## Read Order

1. Rules and goals
2. Matching ADRs
3. Matching runbooks
4. Open mistakes in the area
5. Recent session logs
6. Full note bodies only when needed

## Token Budget Defaults

- Startup context: 12 items / 6000 chars
- Task context: 10 items / 5000 chars
- Session logs: excerpts only until selected
- Mistakes and ADRs outrank generic notes
- Repeatedly selected notes receive a lightweight usage boost
