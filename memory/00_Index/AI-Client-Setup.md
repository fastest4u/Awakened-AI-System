---
title: AI Client Setup
type: reference
status: active
created: 2026-05-16
updated: 2026-05-16
tags:
  - mcp
  - ai-clients
  - project/general
last-verified: 2026-05-16
verified-by: memory-mcp
source: memory-mcp bootstrap
confidence: medium
---
# AI Client Setup

This project is optimized for OpenCode, Codex, Zed, Cursor, Windsurf, and Google Antigravity.

## Generated Project Files

- `../AGENTS.md`: shared agent instructions for project memory.
- `../.rules`: Zed project-level always-on memory rule.
- `../.windsurfrules`: Windsurf compatibility memory rule.
- `../GEMINI.md`: Gemini and Google Antigravity compatibility memory rule.
- `../.github/copilot-instructions.md`: GitHub Copilot compatibility memory rule.
- `../opencode.json`: OpenCode MCP server configuration and memory instruction list.
- `../.opencode/commands/`: OpenCode memory workflow commands.
- `../.codex/config.toml`: Codex project MCP configuration.
- `../.zed/settings.json`: Zed custom MCP context server.
- `../.cursor/mcp.json`: Cursor project MCP configuration.
- `../.cursor/rules/project-memory.mdc`: Cursor always-on memory rule.
- `../.windsurf/rules/project-memory.md`: Windsurf always-on memory rule.
- `../.windsurf/workflows/`: Windsurf workflow prompts.
- `../.windsurf/mcp_config.example.json`: Windsurf MCP example for user-level import.
- `../.antigravity/mcp.example.json`: Google Antigravity MCP example for user-level import.

## Required Flow

1. Call `memory_sessionStart` when opening the IDE or starting meaningful work.
2. Call `memory_contextPack` for task-specific memory. Do not dump the full vault.
3. Call `memory_selfCheck` before risky edits.
4. Call `memory_sessionEnd` before ending the session. It auto-compacts recent sessions and returns vault health when supported.
5. Call `memory_verifyVault` only when the sessionEnd response did not include a healthy vault summary.

See [[Always-On-Memory-Protocol]] for the mandatory session contract shared by all AI clients.
