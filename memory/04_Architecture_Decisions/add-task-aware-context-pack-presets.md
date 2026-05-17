---
title: Add Task-Aware Context Pack Presets
type: adr
status: accepted
decision-date: 2026-05-17
confidence: medium
supersedes: []
created: 2026-05-17
updated: 2026-05-17
tags:
  - mcp
  - context-pack
  - retrieval
  - presets
---
## Context
The MCP server already has contextPack retrieval with static type weights and include flags. After lifecycle guardrails, the next improvement is to make context retrieval adapt to the work type without breaking older clients that call memory_contextPack with only query/taskArea.

## Decision
Add a contextPack mode enum with auto, coding, debugging, review, deploy, planning, and docs. Auto mode will infer a mode from query/taskArea keywords, falling back to the existing generic behavior when no strong signal exists. Presets will provide default include flags, type-weight adjustments, extra scoring terms, recommended reads, and checklist hints. Explicit include flags still override preset defaults.

## Consequences
- Existing callers remain compatible because mode defaults to auto and generic behavior remains available.
- Agents can request predictable retrieval behavior for common task categories.
- Scoring remains deterministic and local, with no external embeddings or network dependency.
- The first implementation will not guarantee a minimum count per note type; it changes ranking and defaults only.
