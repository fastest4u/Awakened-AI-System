---
title: Add Non-Blocking Lifecycle Guardrails to Project-Memory MCP
type: adr
status: accepted
confidence: medium
decision-date: "2026-05-17"
supersedes: []
tags:
  - mcp
  - project-memory
  - lifecycle
  - quality-gate
created: "2026-05-17"
updated: "2026-05-17"
---

## Context
The project-memory MCP already supports sessionStart, contextPack, selfCheck, sessionEnd, compaction, and vault verification, but the protocol still depends on agents remembering to call tools in the right order. Hard-failing calls would be brittle because MCP clients may call tools standalone or after server restarts.

## Decision
Implement a durable lifecycle tracker under .memory-mcp that records sessionStart, contextPack, selfCheck, and sessionEnd events. Use it to emit warnings and an end-of-task quality gate instead of blocking tool calls. The quality gate should make missing lifecycle steps, skipped verification, weak session-log content, inferred risky work without selfCheck, and vault health issues visible at sessionEnd.

## Consequences
- Correct memory behavior becomes easier to audit without breaking standalone MCP tool usage.
- The lifecycle state remains project-local and survives server restarts.
- Concurrent agents may share the same project-level active lifecycle, so this is a guardrail and diagnostic signal rather than a strict transaction system.
