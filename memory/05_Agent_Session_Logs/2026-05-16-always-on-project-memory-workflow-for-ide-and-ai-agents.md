---
title: 2026-05-16 - Always-on project-memory workflow for IDE and AI agents
type: session-log
session-date: 2026-05-16
agent: codex
outcomes:
  - Added a shared always-on memory protocol to the bootstrap generator
  - "Generated root .rules for Zed, .windsurfrules, GEMINI.md, GitHub Copilot instructions, Cursor rule, Windsurf rule, and project AGENTS.md"
  - Updated OpenCode instructions to include the always-on memory protocol note
  - Added memory/01_Project_Rules/Always-On-Memory-Protocol.md as the durable vault rule
  - Allowed key project-memory MCP tools in global Zed tool permissions
created: 2026-05-16
updated: 2026-05-16
tags:
  - session-log
  - project/general
---
# 2026-05-16 - Always-on project-memory workflow for IDE and AI agents

## TL;DR
- Added a shared always-on memory protocol to the bootstrap generator
- Generated root .rules for Zed, .windsurfrules, GEMINI.md, GitHub Copilot instructions, Cursor rule, Windsurf rule, and project AGENTS.md
- Updated OpenCode instructions to include the always-on memory protocol note
- Added memory/01_Project_Rules/Always-On-Memory-Protocol.md as the durable vault rule
- Allowed key project-memory MCP tools in global Zed tool permissions

## Goal
Always-on project-memory workflow for IDE and AI agents

## What Was Done
- Added a shared always-on memory protocol to the bootstrap generator
- Generated root .rules for Zed, .windsurfrules, GEMINI.md, GitHub Copilot instructions, Cursor rule, Windsurf rule, and project AGENTS.md
- Updated OpenCode instructions to include the always-on memory protocol note
- Added memory/01_Project_Rules/Always-On-Memory-Protocol.md as the durable vault rule
- Allowed key project-memory MCP tools in global Zed tool permissions

## Files Touched
- src/services/memory-bootstrap.service.ts
- README.md
- AGENTS.md
- .rules
- .windsurfrules
- GEMINI.md
- .github/copilot-instructions.md
- .cursor/rules/project-memory.mdc
- .windsurf/rules/project-memory.md
- opencode.json
- memory/01_Project_Rules/Always-On-Memory-Protocol.md
- C:/Users/Server/AppData/Roaming/Zed/settings.json

## Decisions Made
- Use one shared always-on protocol helper in the bootstrap service to avoid rule drift across IDE clients
- Use Zed root .rules because Zed auto-includes .rules at the root of a project's file tree
- Keep session memory writes explicit through MCP calls: sessionStart/contextPack at start, sessionEnd/verifyVault at end

## Open Follow-ups
- [ ] Reload Zed so global settings and project .rules are picked up by the Agent Panel
- [ ] For each new project, run memory_bootstrapProject so the same always-on rules are generated there

## References
- None

## Verification
npm run typecheck passed; npm run build passed; Zed settings JSON validated; required rule files exist; memory_verifyVault reported errors=0 warnings=0

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Zed can auto-include root .rules as project-level instructions. | high | Verified against current Zed Rules documentation and generated .rules at the project root. | Use .rules for Zed while keeping AGENTS.md for broader agent compatibility. |
