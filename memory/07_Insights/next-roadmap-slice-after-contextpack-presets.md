---
title: Next Roadmap Slice After ContextPack Presets
type: insight
status: active
confidence: medium
derived-from:
  - 05_Agent_Session_Logs/2026-05-17-implement-task-aware-contextpack-presets.md
  - 07_Insights/next-mcp-improvements-should-reduce-agent-discipline-dependency.md
tags:
  - mcp
  - roadmap
  - followups
  - automation
created: "2026-05-17"
updated: "2026-05-17"
---

After lifecycle guardrails and task-aware contextPack presets, the next highest-value project-memory MCP slice is follow-up radar. It should extract open task checkboxes and follow-up sections from indexed notes, score them against query/taskArea/mode, and return relevant followUps from sessionStart and contextPack. This will make unresolved work visible at the moment agents plan or start tasks, reducing buried follow-ups in session logs. Client diagnostics should come after follow-up radar because diagnostics are narrower and mostly setup-time value.
