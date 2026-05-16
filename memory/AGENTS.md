---
title: Memory Vault Entry Point
type: rules
status: active
created: 2026-05-16
updated: 2026-05-16
tags:
  - meta
  - agent-rules
  - entry-point
---
# AGENTS.md

Every AI agent should read this file at session start.

See [[Always-On-Memory-Protocol]] for the mandatory session contract shared by all IDEs and AI agents.

## Session Start

1. Call `memory_sessionStart`.
2. Call `memory_contextPack` with the current task area.
3. Read full notes only when selected by the context pack.
4. Check `00_Index/Goals.md` and recent session logs.
5. Search `08_Mistakes/` or call `memory_selfCheck` before risky work.

## Session End

Call `memory_sessionEnd` after meaningful work, including outcomes, files touched, decisions made, open follow-ups, verification, and confidence lessons. Then call `memory_verifyVault`.

> [!tip]
> This vault is Obsidian-first but plain Markdown-safe. MCP writes notes in the project-local vault, while Obsidian plugins provide dashboards, tasks, templates, visuals, and git backup.

## Token Economy

- Start with [[Retrieval-Protocol]] and `memory_contextPack`.
- Read full note bodies only after the compact pack selects paths.
- Promote repeated session lessons into [[Memory-Digest]] or `07_Insights/`.
- Keep session logs append-only; compact learnings into insights monthly.
