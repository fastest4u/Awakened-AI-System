---
title: Restructure agent-team backend as MVC with MCP-backed long-term memory
type: adr
status: accepted
confidence: high
decision-date: "2026-05-24"
supersedes: []
tags:
  - architecture
  - mvc
  - mcp
  - agents
  - bun
  - memory
created: "2026-05-24"
updated: "2026-05-24"
---

## Context
User wants a Bun-based multi-agent backend (orchestrator + role-based team) restructured into a full MVC layout, and integrated with the project_memory MCP server so agents share durable long-term memory (insights, ADRs, session logs, runbooks) across runs. Initial flat layout under src/core/ was good as a sketch but conflates persistence, transport, and domain logic.

## Decision
Adopt a layered MVC structure: models (entities + SQLite repositories), views (HTTP JSON + CLI presenters), controllers (Hono routes + commander commands) glued by a services layer (orchestrator, agent runtime, providers, memory). Add an MCP client layer (official @modelcontextprotocol/sdk) that connects to configured stdio MCP servers and exposes their tools to agents via Vercel AI SDK tools, with a per-agent allowlist. Memory MCP becomes the canonical long-term memory: sessionStart context pack is fed to the lead's system prompt; sessionEnd is called with outcomes when a run completes.

## Consequences
- Clear separation of concerns: agents/orchestrator/providers stay pure, persistence + transport are pluggable.
- Agents gain durable memory across runs via memory_search / memory_recent / memory_writeInsight tools.
- MCP client is generic — any stdio MCP server can be plugged in (filesystem, github, obsidian, etc.) without code changes, just config.
- Slightly more boilerplate for small features; pays off as soon as we add a second transport (e.g., WebSocket) or a second persistence backend.
- Per-agent MCP tool allowlist required to prevent specialists from misusing privileged tools.
