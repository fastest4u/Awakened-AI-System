---
title: "2026-06-05 - Implement MCP Doctor client diagnostics v2"
type: session-log
session-date: "2026-06-05"
agent: Codex
duration-minutes: 55
outcomes:
  - Extended memory_diagnoseWorkspace with an additive doctor section for project/vault/build checks and AI client MCP config diagnostics.
  - "Added read-only diagnostics for Claude Code, Codex, Cursor, Windsurf, Zed, OpenCode, and Antigravity local config files."
  - "Added machine-readable issue codes including VAULT_AGENT_RULES_MISSING, CLIENT_CONFIG_MISSING_PROJECT_MEMORY, CLIENT_CONFIG_PARSE_ERROR, and CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL."
  - Handled UTF-8 BOM-prefixed JSON client configs to avoid false parse-error warnings.
  - Updated the maintenance tool description and README documentation for MCP Doctor output.
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - session-log
  - project/general
---
# 2026-06-05 - Implement MCP Doctor client diagnostics v2

## TL;DR
- Extended memory_diagnoseWorkspace with an additive doctor section for project/vault/build checks and AI client MCP config diagnostics.
- Added read-only diagnostics for Claude Code, Codex, Cursor, Windsurf, Zed, OpenCode, and Antigravity local config files.
- Added machine-readable issue codes including VAULT_AGENT_RULES_MISSING, CLIENT_CONFIG_MISSING_PROJECT_MEMORY, CLIENT_CONFIG_PARSE_ERROR, and CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL.
- Handled UTF-8 BOM-prefixed JSON client configs to avoid false parse-error warnings.
- Updated the maintenance tool description and README documentation for MCP Doctor output.

## Goal
Implement MCP Doctor client diagnostics v2

## What Was Done
- Extended memory_diagnoseWorkspace with an additive doctor section for project/vault/build checks and AI client MCP config diagnostics.
- Added read-only diagnostics for Claude Code, Codex, Cursor, Windsurf, Zed, OpenCode, and Antigravity local config files.
- Added machine-readable issue codes including VAULT_AGENT_RULES_MISSING, CLIENT_CONFIG_MISSING_PROJECT_MEMORY, CLIENT_CONFIG_PARSE_ERROR, and CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL.
- Handled UTF-8 BOM-prefixed JSON client configs to avoid false parse-error warnings.
- Updated the maintenance tool description and README documentation for MCP Doctor output.

## Files Touched
- src/config/memory.config.ts
- tests/memory.config.test.ts
- src/controllers/maintenance.controller.ts
- README.md
- memory/04_Architecture_Decisions/extend-memory-diagnoseworkspace-with-mcp-doctor-client-diagnostics.md
- memory/07_Insights/client-config-diagnostics-should-tolerate-utf-8-bom-in-json-files.md

## Decisions Made
- Kept diagnostics on the existing memory_diagnoseWorkspace tool instead of adding a separate tool, preserving the empty input schema and backward compatibility.
- Reported Claude Code missing root .mcp.json as info rather than warning because the server definition may intentionally live in a global config.
- Made client diagnostics file-based and read-only; no client processes are started or modified.

## Open Follow-ups
- [ ] Consider adding optional remediation suggestions to doctor.issues, such as the exact config path and snippet to add when a client config is missing project-memory.

## References
- None

## Verification
TDD red/green completed. Ran npm run test:build, node --test --test-reporter=spec dist-test/tests/memory.config.test.js, npm test (240 tests passed), npm run build, git diff --check, and node dist/cli.js diagnose via child_process summary. Built diagnose reported doctor.ok=true, configuredClients=7/7, issueCount=1 info-only CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
