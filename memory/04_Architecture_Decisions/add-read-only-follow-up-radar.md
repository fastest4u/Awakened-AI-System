---
title: Add Read-Only Follow-up Radar
type: adr
status: accepted
confidence: medium
decision-date: "2026-05-17"
supersedes: []
tags:
  - mcp
  - followups
  - automation
  - retrieval
created: "2026-05-17"
updated: "2026-05-17"
---

## Context
The MCP server now tracks lifecycle compliance and retrieves task-aware context, but unresolved work can still remain buried in session logs, Open Follow-ups notes, and unchecked task lists. The next roadmap slice should surface relevant open work at task start without mutating notes.

## Decision
Implement Follow-up Radar v1 as a read-only scanner that extracts unchecked markdown tasks and bullet items under follow-up sections from vault notes. Score results against query, taskArea, and mode, then expose them through a dedicated memory_followUpRadar tool and include compact followUps summaries in memory_sessionStart and memory_contextPack responses.

## Consequences
- Agents will see relevant open work during planning and context retrieval without needing broad vault reads.
- The first version does not modify or close follow-ups; write workflows can come later.
- Heuristic extraction may include some generic unchecked tasks, so scoring and limits should keep responses compact.
