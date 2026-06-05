---
title: "2026-05-18 - Explain MEMORY_PROJECT_ROOT relationship to open project"
type: session-log
agent: codex
session-date: "2026-05-18"
duration-minutes: 3
outcomes:
  - "Clarified that MEMORY_PROJECT_ROOT should normally point to the root of the project whose memory vault should be used, which is usually the project currently opened in the MCP-capable client."
  - Clarified that the MCP server executable path can live in a different repository from the target project memory root.
tags:
  - session-log
  - project/general
created: "2026-05-18"
updated: "2026-05-18"
---

# 2026-05-18 - Explain MEMORY_PROJECT_ROOT relationship to open project

## TL;DR
- Clarified that MEMORY_PROJECT_ROOT should normally point to the root of the project whose memory vault should be used, which is usually the project currently opened in the MCP-capable client.
- Clarified that the MCP server executable path can live in a different repository from the target project memory root.

## Goal
Explain MEMORY_PROJECT_ROOT relationship to open project

## What Was Done
- Clarified that MEMORY_PROJECT_ROOT should normally point to the root of the project whose memory vault should be used, which is usually the project currently opened in the MCP-capable client.
- Clarified that the MCP server executable path can live in a different repository from the target project memory root.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] Reload MCP-capable clients in the Laravel project so they pick up the new project-memory config.

## References
- 00_Index/AI-Client-Setup.md
- C:/Users/Server/Desktop/laravel/AGENTS.md

## Verification
No file changes. Answer based on current MCP configuration and bootstrap behavior.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
