---
title: Memory Autopilot
type: reference
status: active
created: 2026-05-16
updated: 2026-05-17
tags:
  - autopilot
  - project-memory
  - token-economy
  - project/general
last-verified: 2026-05-17
verified-by: memory-mcp
source: memory-mcp bootstrap
confidence: medium
---
# Memory Autopilot

Memory autopilot is the strongest supported workflow for this vault.

## What Runs Automatically When Agents Follow The Protocol

- `memory_sessionStart` loads startup context and updates lightweight usage scoring.
- `memory_contextPack` selects a compact task-specific pack, supports task-aware modes, and learns which notes are repeatedly selected.
- `memory_followUpRadar` surfaces relevant open work from unchecked tasks and follow-up sections.
- `memory_sessionEnd` writes the session log, updates `07_Insights/Auto-Memory-Digest.md`, and returns vault health plus a lifecycle quality gate.
- `memory_lifecycleStatus` reports the active lifecycle and recent quality gates from `.memory-mcp/lifecycle.json`.
- `memory_compactVault` can be run manually for dry runs or forced digest refreshes.

## Limits

- MCP servers cannot force an IDE to call tools, but lifecycle quality gates make skipped steps visible.
- If an agent ignores the rules, ask it to call `memory_lifecycleStatus`, then `memory_sessionStart` before continuing and `memory_sessionEnd` before stopping.
