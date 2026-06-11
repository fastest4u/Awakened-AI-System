---
title: "Adopt incremental persistent index + BM25 ranked search for memory retrieval"
type: adr
status: accepted
decision-date: "2026-06-03"
confidence: high
supersedes: []
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - memory-index
  - retrieval
  - bm25
  - performance
  - architecture
---
## Context
MemoryQueryService re-read and re-parsed every markdown note on every search/recent/get/resolveReference call (the in-memory IndexRepository was overwritten each call so it cached nothing), and IndexRepository.search was a naive substring .includes() over a 360-char excerpt with no relevance ranking. This made retrieval O(N files) per query and returned unranked results, wasting both time and the AI's token budget. The persisted MemoryUsageService.scoreBoost (a good learn-to-rank signal) was used only by contextPack, not by memory_search.

## Decision
Adopt a persistent, incremental, ranked index (Tier 1). (1) MemoryQueryService.snapshotIndex now stat()s files and re-parses only new/modified notes by mtime, drops deleted ones, and persists to .memory-mcp/index.json (loaded once per process); memory_reindex forces a full rebuild. (2) IndexRepository.rank uses Okapi BM25 (src/utils/bm25.ts) with field weighting (title>tags/aliases>type/body) over a capped (4000-char) body text, fused with MemoryUsageService.buildBooster as a re-rank boost; the BM25 model is cached and rebuilt only when records change. (3) Internal index fields (mtimeMs/searchText) are stripped from results so tool responses stay lean.

## Consequences
- Warm queries no longer re-parse unchanged files (200-file temp vault: ~28ms warm vs ~114ms cold); results are relevance-ranked, improving token economy
- Usage scoring now re-ranks memory_search too, unifying ranking with contextPack
- .memory-mcp/index.json is a derived cache that changes on edits — recommend gitignoring it (like dist/) to avoid churn (currently NOT ignored; follow-up)
- Lexical-only for now: capped searchText (4000 chars) and no semantic match until the optional Tier 3 embedding index; Tier 2 (backlink graph, section chunks) and Tier 3 build on this index
- MemoryQueryService now depends on MemoryUsageService (optional constructor arg, wired in app.ts)
