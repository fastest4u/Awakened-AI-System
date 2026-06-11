---
title: Client config diagnostics should tolerate UTF-8 BOM in JSON files
type: insight
derived-from:
  - tests/memory.config.test.ts BOM-prefixed JSON client config coverage
  - src/config/memory.config.ts parseJsonConfig implementation
confidence: high
status: active
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - mcp
  - diagnostics
  - windows
  - json
---
MCP client config files generated or edited on Windows can contain a leading UTF-8 BOM. JSON.parse rejects that character even when the visible JSON looks valid, which can create false parse-error warnings in diagnostics. Read-only config doctors should strip a leading BOM before parsing JSON and still expose parse errors per file so broken active configs remain debuggable.
