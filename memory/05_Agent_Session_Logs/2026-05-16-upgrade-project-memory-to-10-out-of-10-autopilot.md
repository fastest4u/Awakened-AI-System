---
title: "2026-05-16 - Upgrade project-memory to 10 out of 10 autopilot"
type: session-log
agent: codex
session-date: "2026-05-16"
outcomes:
  - Added lightweight usage scoring that boosts repeatedly selected notes in future context packs
  - Implemented deterministic session-log compaction into 07_Insights/Auto-Memory-Digest.md
  - "Made memory_sessionEnd write the session log, auto-compact recent sessions, and return vault health by default"
  - Updated Zed permissions for key project-memory MCP tools
  - Regenerated always-on rules and project memory notes for the current repository
tags:
  - session-log
  - project/general
created: "2026-05-16"
updated: "2026-05-16"
---

# 2026-05-16 - Upgrade project-memory to 10 out of 10 autopilot

## TL;DR
- Added lightweight usage scoring that boosts repeatedly selected notes in future context packs
- Implemented deterministic session-log compaction into 07_Insights/Auto-Memory-Digest.md
- Made memory_sessionEnd write the session log, auto-compact recent sessions, and return vault health by default
- Updated Zed permissions for key project-memory MCP tools
- Regenerated always-on rules and project memory notes for the current repository

## Goal
Upgrade project-memory to 10 out of 10 autopilot

## What Was Done
- Added lightweight usage scoring that boosts repeatedly selected notes in future context packs
- Implemented deterministic session-log compaction into 07_Insights/Auto-Memory-Digest.md
- Made memory_sessionEnd write the session log, auto-compact recent sessions, and return vault health by default
- Updated Zed permissions for key project-memory MCP tools
- Regenerated always-on rules and project memory notes for the current repository

## Files Touched
- src/services/memory-usage.service.ts
- src/services/memory-compaction.service.ts
- src/services/memory-workflow.service.ts
- src/controllers/workflow.controller.ts
- src/controllers/maintenance.controller.ts
- src/schemas/memory.ts
- src/app.ts
- src/services/memory-bootstrap.service.ts
- README.md
- .rules
- .windsurfrules
- GEMINI.md
- .github/copilot-instructions.md
- .cursor/rules/project-memory.mdc
- .windsurf/rules/project-memory.md
- memory/00_Index/Memory-Autopilot.md
- memory/07_Insights/Auto-Memory-Digest.md
- C:/Users/Server/AppData/Roaming/Zed/settings.json

## Decisions Made
- Use usage scoring as lightweight local learning stored in memory/.memory-mcp/usage.json
- Keep compaction deterministic and source-backed instead of LLM-generated
- Run compaction and health verification inside sessionEnd by default while keeping verifyVault available as an explicit tool

## Open Follow-ups
- [ ] Reload Zed to pick up updated global tool permissions and root .rules
- [ ] For other projects, rerun memory_bootstrapProject with overwrite when ready to regenerate their always-on rules

## References
- None

## Verification
npm run typecheck passed; npm run build passed; smoke test confirmed usage.json, Auto-Memory-Digest, session log, and vault health; memory_verifyVault errors=0 warnings=0

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| The new project-memory workflow is 10/10 for enforceable local memory within MCP limits. | high | MCP cannot force an IDE to call tools, but rules, tool permissions, usage scoring, auto compaction, and sessionEnd health now cover the full controllable workflow. | State the limit clearly: enforcement comes from IDE rules and tool permissions; memory quality comes from MCP tools and vault checks. |
