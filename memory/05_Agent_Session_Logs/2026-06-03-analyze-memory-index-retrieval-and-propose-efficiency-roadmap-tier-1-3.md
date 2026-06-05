---
title: "2026-06-03 - Analyze memory index/retrieval and propose efficiency roadmap (Tier 1-3)"
type: session-log
session-date: "2026-06-03"
agent: claude-code
outcomes:
  - "Mapped the current index/retrieval layer and identified the #1 bottleneck: MemoryQueryService re-scans + re-parses every vault file on every search/recent/get/resolveReference call (the in-memory IndexRepository is overwritten each call so it caches nothing)"
  - "Identified that memory_search uses naive substring matching with no ranking and only indexes a 360-char excerpt; incomingLinks is hardcoded []; the persisted usage scoreBoost is used only by contextPack, not by memory_search"
  - "Proposed a prioritized roadmap: Tier 1 = persistent incremental index (mtime/hash) + BM25 ranked search fused with usage scoreBoost; Tier 2 = backlink graph + section-level chunking with line anchors; Tier 3 = optional feature-flagged local-first embedding hybrid search"
  - "Recommended starting with Tier 1 as the highest-impact, no-lock-in win"
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - session-log
  - project/general
---
# 2026-06-03 - Analyze memory index/retrieval and propose efficiency roadmap (Tier 1-3)

## TL;DR
- Mapped the current index/retrieval layer and identified the #1 bottleneck: MemoryQueryService re-scans + re-parses every vault file on every search/recent/get/resolveReference call (the in-memory IndexRepository is overwritten each call so it caches nothing)
- Identified that memory_search uses naive substring matching with no ranking and only indexes a 360-char excerpt; incomingLinks is hardcoded []; the persisted usage scoreBoost is used only by contextPack, not by memory_search
- Proposed a prioritized roadmap: Tier 1 = persistent incremental index (mtime/hash) + BM25 ranked search fused with usage scoreBoost; Tier 2 = backlink graph + section-level chunking with line anchors; Tier 3 = optional feature-flagged local-first embedding hybrid search
- Recommended starting with Tier 1 as the highest-impact, no-lock-in win

## Goal
Analyze memory index/retrieval and propose efficiency roadmap (Tier 1-3)

## What Was Done
- Mapped the current index/retrieval layer and identified the #1 bottleneck: MemoryQueryService re-scans + re-parses every vault file on every search/recent/get/resolveReference call (the in-memory IndexRepository is overwritten each call so it caches nothing)
- Identified that memory_search uses naive substring matching with no ranking and only indexes a 360-char excerpt; incomingLinks is hardcoded []; the persisted usage scoreBoost is used only by contextPack, not by memory_search
- Proposed a prioritized roadmap: Tier 1 = persistent incremental index (mtime/hash) + BM25 ranked search fused with usage scoreBoost; Tier 2 = backlink graph + section-level chunking with line anchors; Tier 3 = optional feature-flagged local-first embedding hybrid search
- Recommended starting with Tier 1 as the highest-impact, no-lock-in win

## Files Touched
- None

## Decisions Made
- Advisory/planning task: did not edit code; presented a tiered roadmap and will ask the user which tier to implement
- Keep everything local-first and feature-flag the embedding tier so the default stays zero-dependency (consistent with the vault's no-lock-in principle)

## Open Follow-ups
- [ ] AWAITING USER DECISION: which index roadmap tier to implement first (recommended Tier 1: persistent incremental index + BM25 ranked search fused with usage scoreBoost)
- [ ] Consider writing an ADR for the index architecture direction once the tier is chosen
- [ ] Tier 1.1 persistent index should reuse the safe parseFrontmatter + handle add/modify/delete via mtime; Tier 1.2 should fold in MemoryUsageService.scoreBoost so ranking is unified across memory_search and contextPack

## References
- src/repositories/index.repository.ts
- src/services/memory-query.service.ts
- src/services/memory-usage.service.ts

## Verification
Analysis grounded in reading src/repositories/index.repository.ts, src/services/memory-query.service.ts, src/services/memory-usage.service.ts (full files). No code changed; no tests run (advisory).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
