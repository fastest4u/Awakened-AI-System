---
title: Memory System Map
type: reference
status: active
created: 2026-05-16
updated: 2026-05-16
tags:
  - diagram
  - memory-vault
  - project/general
last-verified: 2026-05-16
verified-by: memory-mcp
source: memory-mcp bootstrap
confidence: medium
---
# Memory System Map

```mermaid
graph TD
  MCP[MCP Server] --> Vault[Project Obsidian Vault]
  Vault --> Sessions[Session Logs]
  Vault --> ADRs[Architecture Decisions]
  Vault --> Insights[Insights]
  Vault --> Mistakes[Mistakes]
  Vault --> Runbooks[Runbooks]
  Obsidian[Obsidian Plugins] --> Vault
  Agent[AI Agent / IDE] --> MCP
```
