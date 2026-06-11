---
title: "2026-06-03 - Implement Tier 1 memory index: incremental persistent index + BM25 ranked search"
type: session-log
session-date: "2026-06-03"
agent: claude-code
outcomes:
  - "Added src/utils/bm25.ts (tokenizer matching usage term-keys + Okapi BM25 with cached model)"
  - "Rewrote IndexRepository: StoredRecord (public fields + mtimeMs + capped searchText), rank() = BM25 + optional usage boost returning only matches best-first, BM25 cached via dirty flag, toPublicRecord strips internal fields"
  - "Rewrote MemoryQueryService.snapshotIndex to be incremental (stat + re-parse only changed notes by mtime, drop deleted, persist to .memory-mcp/index.json loaded once); search uses BM25+usage and projects public records; recent projects public; reindex forces full rebuild"
  - "Added MemoryUsageService.buildBooster (reads usage.json once per query); wired usage into MemoryQueryService in app.ts; memory_reindex now forces rebuild"
  - "Verified: tsc clean, npm test 158 pass (+19), build green; perf smoke on 200 files ~28ms warm vs ~114ms cold. Committed + pushed branch feat/incremental-bm25-index; wrote ADR adopt-incremental-persistent-index-bm25"
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - session-log
  - project/general
---
# 2026-06-03 - Implement Tier 1 memory index: incremental persistent index + BM25 ranked search

## TL;DR
- Added src/utils/bm25.ts (tokenizer matching usage term-keys + Okapi BM25 with cached model)
- Rewrote IndexRepository: StoredRecord (public fields + mtimeMs + capped searchText), rank() = BM25 + optional usage boost returning only matches best-first, BM25 cached via dirty flag, toPublicRecord strips internal fields
- Rewrote MemoryQueryService.snapshotIndex to be incremental (stat + re-parse only changed notes by mtime, drop deleted, persist to .memory-mcp/index.json loaded once); search uses BM25+usage and projects public records; recent projects public; reindex forces full rebuild
- Added MemoryUsageService.buildBooster (reads usage.json once per query); wired usage into MemoryQueryService in app.ts; memory_reindex now forces rebuild
- Verified: tsc clean, npm test 158 pass (+19), build green; perf smoke on 200 files ~28ms warm vs ~114ms cold. Committed + pushed branch feat/incremental-bm25-index; wrote ADR adopt-incremental-persistent-index-bm25

## Goal
Implement Tier 1 memory index: incremental persistent index + BM25 ranked search

## What Was Done
- Added src/utils/bm25.ts (tokenizer matching usage term-keys + Okapi BM25 with cached model)
- Rewrote IndexRepository: StoredRecord (public fields + mtimeMs + capped searchText), rank() = BM25 + optional usage boost returning only matches best-first, BM25 cached via dirty flag, toPublicRecord strips internal fields
- Rewrote MemoryQueryService.snapshotIndex to be incremental (stat + re-parse only changed notes by mtime, drop deleted, persist to .memory-mcp/index.json loaded once); search uses BM25+usage and projects public records; recent projects public; reindex forces full rebuild
- Added MemoryUsageService.buildBooster (reads usage.json once per query); wired usage into MemoryQueryService in app.ts; memory_reindex now forces rebuild
- Verified: tsc clean, npm test 158 pass (+19), build green; perf smoke on 200 files ~28ms warm vs ~114ms cold. Committed + pushed branch feat/incremental-bm25-index; wrote ADR adopt-incremental-persistent-index-bm25

## Files Touched
- src/utils/bm25.ts
- src/repositories/index.repository.ts
- src/services/memory-query.service.ts
- src/services/memory-usage.service.ts
- src/app.ts
- src/controllers/maintenance.controller.ts
- tests/bm25.test.ts
- tests/index.repository.test.ts
- tests/memory-query.test.ts

## Decisions Made
- Kept the public IndexRecord shape unchanged for tool responses; stored mtimeMs/searchText internally and strip them on output
- Tokenizer matches MemoryUsageService.queryTerms (keeps _ and - in tokens) so BM25 query terms align with usage context keys for the boost
- BM25 over a capped 4000-char body (not full body) to bound index.json size while making body searchable; semantic search deferred to Tier 3

## Open Follow-ups
- [ ] Decide whether to open a PR for feat/incremental-bm25-index (Tier 1) and/or continue to Tier 2 (backlink graph + section-level chunks) / Tier 3 (optional embedding hybrid search)
- [ ] Recommend gitignoring .memory-mcp/index.json (derived cache, churns on edits) like dist/ — not done to avoid entangling with the already-dirty .gitignore
- [ ] Tier 2: real incomingLinks via a link graph built during indexing (the wikilink data is already cheap to capture); section-level chunk index returning section + line anchor

## References
- src/utils/bm25.ts
- src/services/memory-query.service.ts
- src/repositories/index.repository.ts
- 04_Architecture_Decisions/adopt-incremental-persistent-index-bm25-ranked-search-for-memory-retrieval.md

## Verification
tsc --noEmit clean; npm test 158 pass / 0 fail (42 suites); npm run build green; perf smoke (dist-test, 200-file temp vault): cold 114ms (build index), warm ~28ms/query (no re-parse of unchanged files). Live vault not mutated (tests/smoke used temp dirs).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
