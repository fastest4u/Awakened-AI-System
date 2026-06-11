---
title: "2026-05-17 - Implement read-only follow-up radar"
type: session-log
agent: Codex
session-date: "2026-05-17"
duration-minutes: 32
outcomes:
  - Added MemoryFollowUpService to extract open unchecked tasks and bullet items under follow-up sections from vault markdown notes.
  - Added memory_followUpRadar read-only MCP tool with query/taskArea/mode/folders/limit inputs.
  - Surfaced compact followUps in memory_sessionStart and memory_contextPack responses.
  - "Wired follow-up radar into app bootstrap, workflow controller, workflow service, and schemas."
  - "Updated README, bootstrap-generated client docs, Retrieval Protocol, Memory Autopilot, and AI Client Setup notes to document follow-up radar."
tags:
  - session-log
  - project/general
created: "2026-05-17"
updated: "2026-05-17"
---

# 2026-05-17 - Implement read-only follow-up radar

## TL;DR
- Added MemoryFollowUpService to extract open unchecked tasks and bullet items under follow-up sections from vault markdown notes.
- Added memory_followUpRadar read-only MCP tool with query/taskArea/mode/folders/limit inputs.
- Surfaced compact followUps in memory_sessionStart and memory_contextPack responses.
- Wired follow-up radar into app bootstrap, workflow controller, workflow service, and schemas.
- Updated README, bootstrap-generated client docs, Retrieval Protocol, Memory Autopilot, and AI Client Setup notes to document follow-up radar.

## Goal
Implement read-only follow-up radar

## What Was Done
- Added MemoryFollowUpService to extract open unchecked tasks and bullet items under follow-up sections from vault markdown notes.
- Added memory_followUpRadar read-only MCP tool with query/taskArea/mode/folders/limit inputs.
- Surfaced compact followUps in memory_sessionStart and memory_contextPack responses.
- Wired follow-up radar into app bootstrap, workflow controller, workflow service, and schemas.
- Updated README, bootstrap-generated client docs, Retrieval Protocol, Memory Autopilot, and AI Client Setup notes to document follow-up radar.

## Files Touched
- src/services/memory-follow-up.service.ts
- src/app.ts
- src/controllers/workflow.controller.ts
- src/schemas/memory.ts
- src/services/memory-workflow.service.ts
- src/services/memory-bootstrap.service.ts
- README.md
- memory/00_Index/Retrieval-Protocol.md
- memory/00_Index/Memory-Autopilot.md
- memory/00_Index/AI-Client-Setup.md

## Decisions Made
- Implemented follow-up radar as read-only in v1; it surfaces open work but does not edit or close tasks.
- Scored follow-ups deterministically using query/taskArea/mode terms, note metadata, follow-up section context, type weights, and recency.
- Included compact followUps in sessionStart/contextPack so unresolved work appears before new task execution.

## Open Follow-ups
- [ ] Implement client integration diagnostics for Codex, Zed, Cursor, Windsurf, and OpenCode.
- [ ] Consider follow-up write workflows later: mark done, promote to Open-Followups, or carry unresolved items into sessionEnd.
- [ ] Consider result diversity constraints for contextPack after observing preset behavior on real projects.

## References
- 04_Architecture_Decisions/add-read-only-follow-up-radar.md
- 07_Insights/next-roadmap-slice-after-contextpack-presets.md

## Verification
npm run typecheck passed. npm run build passed. MCP stdio smoke test in a temp project confirmed memory_followUpRadar is registered, returns open follow-ups, reports scannedFiles, and memory_contextPack includes compact followUps. memory_verifyVault returned score 90, grade B, errors 0, warnings 0.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
