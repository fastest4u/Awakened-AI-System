---
title: Extend memory_diagnoseWorkspace with MCP Doctor client diagnostics
type: adr
status: accepted
decision-date: "2026-06-05"
confidence: high
supersedes: []
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - mcp
  - diagnostics
  - client-integration
  - workspace-detection
---
## Context
The user wanted the MCP to work more efficiently across AI clients and asked whether Claude Code and other clients were fully integrated. The existing memory_diagnoseWorkspace tool already reported project root, vault root, workspace candidates, runtime metadata, and build info, so adding another diagnostics tool would have duplicated the same troubleshooting entry point.

## Decision
Extend memory_diagnoseWorkspace with a read-only doctor section instead of adding a separate tool. The doctor output reports project/vault/build checks, known local client config diagnostics for Claude Code, Codex, Cursor, Windsurf, Zed, OpenCode, and Antigravity, and machine-readable issue codes. Claude Code's missing root .mcp.json is reported as an info issue because the server definition may intentionally live in a global config.

## Consequences
- Existing clients keep calling the same tool with the same empty input schema; the new diagnostics are additive and backward-compatible.
- Troubleshooting can now distinguish workspace/vault resolution issues from client integration issues in one response.
- Client config parsing is intentionally read-only and file-based; it does not try to start MCP clients or inspect live processes.
- Future client support can be added by extending the client probe definitions in memory.config.ts.
