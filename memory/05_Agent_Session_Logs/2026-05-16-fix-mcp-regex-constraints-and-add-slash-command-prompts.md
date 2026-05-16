---
title: 2026-05-16 - Fix MCP Regex Constraints and Add Slash Command Prompts
type: session-log
session-date: 2026-05-16
agent: Antigravity
duration-minutes: 30
outcomes:
  - Resolved MCP regex validation errors.
  - "Added UI slash commands for 5 key memory functions (session_start, session_end, self_check, awaken, write_adr)."
  - Successfully compiled the codebase.
created: 2026-05-16
updated: 2026-05-16
tags:
  - session-log
  - project/general
---
# 2026-05-16 - Fix MCP Regex Constraints and Add Slash Command Prompts

## TL;DR
- Resolved MCP regex validation errors.
- Added UI slash commands for 5 key memory functions (session_start, session_end, self_check, awaken, write_adr).
- Successfully compiled the codebase.

## Goal
Fix MCP Regex Constraints and Add Slash Command Prompts

## What Was Done
- Resolved MCP regex validation errors.
- Added UI slash commands for 5 key memory functions (session_start, session_end, self_check, awaken, write_adr).
- Successfully compiled the codebase.

## Files Touched
- src/controllers/workflow.controller.ts
- src/controllers/write.controller.ts
- src/controllers/note.controller.ts
- src/controllers/maintenance.controller.ts
- src/controllers/verify.controller.ts
- src/services/memory-bootstrap.service.ts
- AGENTS.md
- GEMINI.md
- .rules
- .windsurfrules

## Decisions Made
- Refactored all `memory.*` tools to `memory_*`
- Registered 5 MCP Prompts to allow user to trigger memory workflows via the IDE slash command menu.

## Open Follow-ups
- [ ] The user can test the new slash commands and let us know if any other commands should be added.

## References
- None

## Verification
Rebuilt the project using `npm run build` with no errors.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Refactoring dots to underscores solves the regex constraint, and registering Prompts adds slash commands. | high | The server builds successfully, the regex errors are gone, and Prompts were added to the controllers. | When building MCP servers with the official SDK, ensure tool names adhere to `^[a-zA-Z0-9_-]{1,64}$`. Adding prompts greatly improves UX for executing long tool workflows. |
