---
title: "2026-06-03 - Add CLAUDE.md onboarding guide for Claude Code"
type: session-log
session-date: "2026-06-03"
agent: claude-code
outcomes:
  - "Created root CLAUDE.md (no prior one existed) documenting the awakened-ai-memory-mcp server for future Claude Code instances"
  - "Captured non-obvious build facts: dist/ is committed and obfuscated via scripts/build.js (esbuild + javascript-obfuscator), packages:'external' so node_modules must be present at runtime, never hand-edit dist/"
  - "Documented MVC layering wired in src/app.ts bootstrap(): schemas -> controllers -> services -> repositories, uniform ToolResponseService envelope, MemoryWorkflowService as orchestration hub"
  - "Documented the subtle vault-location resolution in config/memory.config.ts (env -> cwd-with-vault-marker -> IDE-state probing of VS Code/OpenCode/Zed -> cwd fallback) and the memory-vault CLI"
  - "Verified project-memory MCP runs Full-Auto in this session: diagnoseWorkspace resolved vaultRoot to the project (cwd selected over IDE_STATE api gateway candidate), lifecycleStatus and sessionStart returned ok"
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - session-log
  - project/general
---
# 2026-06-03 - Add CLAUDE.md onboarding guide for Claude Code

## TL;DR
- Created root CLAUDE.md (no prior one existed) documenting the awakened-ai-memory-mcp server for future Claude Code instances
- Captured non-obvious build facts: dist/ is committed and obfuscated via scripts/build.js (esbuild + javascript-obfuscator), packages:'external' so node_modules must be present at runtime, never hand-edit dist/
- Documented MVC layering wired in src/app.ts bootstrap(): schemas -> controllers -> services -> repositories, uniform ToolResponseService envelope, MemoryWorkflowService as orchestration hub
- Documented the subtle vault-location resolution in config/memory.config.ts (env -> cwd-with-vault-marker -> IDE-state probing of VS Code/OpenCode/Zed -> cwd fallback) and the memory-vault CLI
- Verified project-memory MCP runs Full-Auto in this session: diagnoseWorkspace resolved vaultRoot to the project (cwd selected over IDE_STATE api gateway candidate), lifecycleStatus and sessionStart returned ok

## Goal
Add CLAUDE.md onboarding guide for Claude Code

## What Was Done
- Created root CLAUDE.md (no prior one existed) documenting the awakened-ai-memory-mcp server for future Claude Code instances
- Captured non-obvious build facts: dist/ is committed and obfuscated via scripts/build.js (esbuild + javascript-obfuscator), packages:'external' so node_modules must be present at runtime, never hand-edit dist/
- Documented MVC layering wired in src/app.ts bootstrap(): schemas -> controllers -> services -> repositories, uniform ToolResponseService envelope, MemoryWorkflowService as orchestration hub
- Documented the subtle vault-location resolution in config/memory.config.ts (env -> cwd-with-vault-marker -> IDE-state probing of VS Code/OpenCode/Zed -> cwd fallback) and the memory-vault CLI
- Verified project-memory MCP runs Full-Auto in this session: diagnoseWorkspace resolved vaultRoot to the project (cwd selected over IDE_STATE api gateway candidate), lifecycleStatus and sessionStart returned ok

## Files Touched
- CLAUDE.md

## Decisions Made
- Documentation-only single-file change; selfCheck intentionally skipped per low-risk criteria
- Kept README's Thai-language note as the fullest tool-surface reference rather than duplicating it in CLAUDE.md

## Open Follow-ups
- [ ] Optional: add ADR recording the decision to commit obfuscated dist/ output, if not already captured
- [ ] Pre-existing: 99_Templates/Template-Daily-Note.md has 2 INVALID_DATE_FORMAT placeholder-date warnings (unrelated to this task)

## References
- CLAUDE.md
- README.md
- AGENTS.md
- src/app.ts
- src/config/memory.config.ts
- scripts/build.js

## Verification
Documentation-only change; CLAUDE.md authored from reading src/app.ts, scripts/build.js, config/memory.config.ts, package.json, tsconfig*. No code changed, so npm build/test not run. MCP Full-Auto confirmed live via memory_diagnoseWorkspace + memory_sessionStart returning ok:true.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
