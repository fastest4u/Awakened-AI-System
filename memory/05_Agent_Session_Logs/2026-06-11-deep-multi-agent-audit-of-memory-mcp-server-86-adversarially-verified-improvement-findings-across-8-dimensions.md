---
title: "2026-06-11 - Deep multi-agent audit of memory MCP server: 86 adversarially-verified improvement findings across 8 dimensions"
type: session-log
session-date: "2026-06-11"
agent: claude-code
outcomes:
  - "Ran a 95-agent workflow (8 dimension finders + 1 adversarial verifier per finding): 86 findings confirmed, 1 refuted, across index correctness, search accuracy, contextPack quality, lifecycle/usage/compaction, vault IO, config/doctor, performance, and API/token economy"
  - "CRITICAL confirmed: dynamic IDE-state vault resolution attaches to the wrong project's vault with cross-project contamination present in this live vault; bootstrap also generates client configs with a nonexistent entrypoint path and pins MEMORY_PROJECT_ROOT to the dynamic sentinel"
  - "Top accuracy cluster: contextPack (the mandated retrieval surface) bypasses BM25/hybrid, has a dead relevance filter, re-reads usage.json ~190x per call (~0.3-0.4s measured), and embeds 3KB usage telemetry per item billed against the maxChars budget; usage booster (+18) makes exact-title search fail 9x more often"
  - "Top robustness cluster: usage.json/lifecycle.json non-atomic writes with silent catch-reset can wipe all accumulated state; single global activeSession means concurrent agents force-grade each other F (4 of last 20 live sessions); memory_awaken silently destroys the active session"
  - "Thai-language cluster: slugify produces untitled filenames and digest dedupe drops distinct Thai lessons; risky-work regex and inferMode are English-only; Thai n-gram dedup destroys term frequency in BM25"
  - Wrote prioritized P0-P3 roadmap to 07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md and delivered full Thai report to user
created: "2026-06-11"
updated: "2026-06-11"
tags:
  - session-log
  - project/general
---
# 2026-06-11 - Deep multi-agent audit of memory MCP server: 86 adversarially-verified improvement findings across 8 dimensions

## TL;DR
- Ran a 95-agent workflow (8 dimension finders + 1 adversarial verifier per finding): 86 findings confirmed, 1 refuted, across index correctness, search accuracy, contextPack quality, lifecycle/usage/compaction, vault IO, config/doctor, performance, and API/token economy
- CRITICAL confirmed: dynamic IDE-state vault resolution attaches to the wrong project's vault with cross-project contamination present in this live vault; bootstrap also generates client configs with a nonexistent entrypoint path and pins MEMORY_PROJECT_ROOT to the dynamic sentinel
- Top accuracy cluster: contextPack (the mandated retrieval surface) bypasses BM25/hybrid, has a dead relevance filter, re-reads usage.json ~190x per call (~0.3-0.4s measured), and embeds 3KB usage telemetry per item billed against the maxChars budget; usage booster (+18) makes exact-title search fail 9x more often
- Top robustness cluster: usage.json/lifecycle.json non-atomic writes with silent catch-reset can wipe all accumulated state; single global activeSession means concurrent agents force-grade each other F (4 of last 20 live sessions); memory_awaken silently destroys the active session
- Thai-language cluster: slugify produces untitled filenames and digest dedupe drops distinct Thai lessons; risky-work regex and inferMode are English-only; Thai n-gram dedup destroys term frequency in BM25
- Wrote prioritized P0-P3 roadmap to 07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md and delivered full Thai report to user

## Goal
Deep multi-agent audit of memory MCP server: 86 adversarially-verified improvement findings across 8 dimensions

## What Was Done
- Ran a 95-agent workflow (8 dimension finders + 1 adversarial verifier per finding): 86 findings confirmed, 1 refuted, across index correctness, search accuracy, contextPack quality, lifecycle/usage/compaction, vault IO, config/doctor, performance, and API/token economy
- CRITICAL confirmed: dynamic IDE-state vault resolution attaches to the wrong project's vault with cross-project contamination present in this live vault; bootstrap also generates client configs with a nonexistent entrypoint path and pins MEMORY_PROJECT_ROOT to the dynamic sentinel
- Top accuracy cluster: contextPack (the mandated retrieval surface) bypasses BM25/hybrid, has a dead relevance filter, re-reads usage.json ~190x per call (~0.3-0.4s measured), and embeds 3KB usage telemetry per item billed against the maxChars budget; usage booster (+18) makes exact-title search fail 9x more often
- Top robustness cluster: usage.json/lifecycle.json non-atomic writes with silent catch-reset can wipe all accumulated state; single global activeSession means concurrent agents force-grade each other F (4 of last 20 live sessions); memory_awaken silently destroys the active session
- Thai-language cluster: slugify produces untitled filenames and digest dedupe drops distinct Thai lessons; risky-work regex and inferMode are English-only; Thai n-gram dedup destroys term frequency in BM25
- Wrote prioritized P0-P3 roadmap to 07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md and delivered full Thai report to user

## Files Touched
- memory/07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md

## Decisions Made
- Prioritized vault-resolution correctness as P0 over all perf/token work because it breaks the product's core per-project isolation guarantee
- Grouped 5 independently-confirmed contextPack findings into one P1 refactor (route scoring through rank()/rankHybrid, build booster once, strip usage telemetry from wire format)

## Open Follow-ups
- [ ] P0: guard dynamic vault resolution (vault-marker requirement before writes; bootstrap should write literal project root, fix entrypoint path one dir above dist/)
- [ ] P1: contextPack refactor — use BM25/hybrid index, fix dead typeWeight filter, build usage booster once per call, return only {selectedCount,lastSelectedAt} usage
- [ ] P1: atomic tmp+rename writes for usage.json/lifecycle.json; make memory_awaken non-mutating
- [ ] P2: trim sessionEnd candidateSessions to counts, dedupe sessionStart followUps/lifecycle blocks, compact JSON in envelope text copy, selfCheck through toPublicRecord
- [ ] P2: Thai support — Unicode-preserving slugify, Thai keywords in risky-work regex and inferMode, fix n-gram term-frequency dedup
- [ ] P2: auto-compact churn — raise minSessions, stop re-emitting open follow-ups as unchecked checkboxes, stop resetting digest created/updated
- [ ] P3 quick wins: .strict() Zod schemas, YYYY-MM-DD date regex, NOT_IMPLEMENTED for export/import, raise SEARCH_TEXT_LIMIT, doctor global-config awareness, isPathWithin case-insensitive on Windows
- [ ] Carried from before: implement memory_export/memory_import; clean U+FFFD mojibake in memory.config.ts before commit; fix README.md line-1 typo; write the missing full-auto ADR cited by AGENTS.md

## References
- 07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md
- src/config/memory.config.ts
- src/services/memory-workflow.service.ts
- src/services/memory-usage.service.ts
- src/services/memory-lifecycle.service.ts
- src/services/memory-compaction.service.ts
- src/services/tool-response.service.ts
- src/utils/memory-format.ts
- src/utils/ngram.ts

## Verification
Read-only analysis; no source changes. Every finding was verified by an independent skeptic agent reading the cited code (several included runtime measurements, e.g. 190x usage.json reads = ~350ms reproduced, byte-exact file sizes). 1 finding rejected for fabricated evidence, demonstrating the verification layer filtered false positives. Full results: workflow wf_d0260d55-0d3 output file.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
