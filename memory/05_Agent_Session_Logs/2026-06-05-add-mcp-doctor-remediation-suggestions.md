---
title: "2026-06-05 - Add MCP Doctor remediation suggestions"
type: session-log
session-date: "2026-06-05"
agent: Codex
duration-minutes: 18
outcomes:
  - "Added optional doctor.issues[].remediation to MCP Doctor diagnostics with summary/path/snippet/command fields."
  - "Added client-specific project-memory config snippets for Codex TOML, Zed context_servers JSON, OpenCode JSON, and mcpServers JSON clients."
  - "Added remediation guidance for missing project root, missing vault, missing vault AGENTS.md, vault outside project, missing build info, client parse errors, missing project-memory client configs, missing Claude Code project-local .mcp.json, and no local client configs found."
  - Updated README documentation for the remediation field.
  - Verified built CLI diagnose now includes remediation for the Claude Code project-local .mcp.json info issue.
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - session-log
  - project/general
---
# 2026-06-05 - Add MCP Doctor remediation suggestions

## TL;DR
- Added optional doctor.issues[].remediation to MCP Doctor diagnostics with summary/path/snippet/command fields.
- Added client-specific project-memory config snippets for Codex TOML, Zed context_servers JSON, OpenCode JSON, and mcpServers JSON clients.
- Added remediation guidance for missing project root, missing vault, missing vault AGENTS.md, vault outside project, missing build info, client parse errors, missing project-memory client configs, missing Claude Code project-local .mcp.json, and no local client configs found.
- Updated README documentation for the remediation field.
- Verified built CLI diagnose now includes remediation for the Claude Code project-local .mcp.json info issue.

## Goal
Add MCP Doctor remediation suggestions

## What Was Done
- Added optional doctor.issues[].remediation to MCP Doctor diagnostics with summary/path/snippet/command fields.
- Added client-specific project-memory config snippets for Codex TOML, Zed context_servers JSON, OpenCode JSON, and mcpServers JSON clients.
- Added remediation guidance for missing project root, missing vault, missing vault AGENTS.md, vault outside project, missing build info, client parse errors, missing project-memory client configs, missing Claude Code project-local .mcp.json, and no local client configs found.
- Updated README documentation for the remediation field.
- Verified built CLI diagnose now includes remediation for the Claude Code project-local .mcp.json info issue.

## Files Touched
- src/config/memory.config.ts
- tests/memory.config.test.ts
- README.md

## Decisions Made
- Kept remediation additive and optional on each issue to preserve existing memory_diagnoseWorkspace consumers.
- Kept diagnostics read-only; remediation provides snippets and commands but does not modify client files.

## Open Follow-ups
- [x] None

## References
- None

## Verification
TDD red/green completed. Ran npm run test:build, node --test --test-reporter=spec dist-test/tests/memory.config.test.js, npm test (240 tests passed), npm run build, node dist/cli.js diagnose summary confirming doctor.ok=true and remediation present, and git diff --check.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
