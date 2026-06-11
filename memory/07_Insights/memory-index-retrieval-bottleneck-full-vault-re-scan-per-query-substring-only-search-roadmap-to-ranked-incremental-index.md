---
title: "Memory index/retrieval bottleneck: full vault re-scan per query + substring-only search; roadmap to ranked incremental index"
type: insight
derived-from:
  - src/repositories/index.repository.ts
  - src/services/memory-query.service.ts
  - src/services/memory-usage.service.ts
confidence: high
status: active
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - memory-index
  - retrieval
  - performance
  - bm25
  - roadmap
  - architecture
---
Analysis 2026-06-03 of the project-memory index/retrieval layer.

CURRENT STATE (file:line):
- IndexRepository (src/repositories/index.repository.ts): in-memory Map only, NOT persisted. search() is a naive substring .includes() over id+path+title+excerpt(360 chars)+tags+aliases (:34-40). No tokenization, ranking, or fuzzy.
- MemoryQueryService (src/services/memory-query.service.ts): search/recent/get/resolveReference each call snapshotIndex() which reads + gray-matter-parses EVERY markdown file on EVERY query (:32,:42,:69). The in-memory index gives zero benefit because it is overwritten each call. incomingLinks always returns [] (:60). Only the 360-char excerpt is searchable, not the full body.
- MemoryUsageService (src/services/memory-usage.service.ts): the good part — persists .memory-mcp/usage.json with selectedCount, per-term contexts, recency; scoreBoost = log-use + term + recency (:61-69). But it is used only by contextPack, NOT by memory_search.

TOP BOTTLENECKS (by impact on AI retrieval efficiency):
1. Full vault re-scan + re-parse on every query (O(N) disk+YAML per call). Biggest win to fix.
2. Substring-only matching with no relevance ranking -> unranked noise -> AI reads more notes than needed (wastes tokens).
3. Only excerpt indexed (body not searchable). 4. No backlink graph. 5. No persistence/incremental.

ROADMAP (local-first, no lock-in):
- Tier 1 (do first): (1.1) persistent incremental index at .memory-mcp/index.json keyed by mtime/hash, re-parse only changed files -> O(changed) per query; (1.2) inverted index + BM25/TF-IDF ranked search with field boosts, fused with the existing usage.scoreBoost, replacing substring filter.
- Tier 2: backlink/link graph (real incomingLinks + graph expansion); section-level (H2/H3) chunking returning section + line number (pairs with the new schema-diagnostic line numbers).
- Tier 3 (optional, feature-flagged): pluggable local-first embedding index + hybrid BM25∪vector via reciprocal-rank fusion for Thai<->English synonym/paraphrase recall.
- Cross-cutting: index version/freshness in diagnostics; incremental memory_reindex; promote usage scoring to a first-class re-ranker for memory_search too.

Recommend starting with Tier 1 (1.1+1.2): fixes the two highest-impact bottlenecks. Relates to [[next-roadmap-slice-after-lifecycle-guardrails]] and [[gray-matter-caches-by-input-string-parsefrontmatter-was-non-idempotent-for-malformed-yaml-until-clearcache]] (parse cost is why per-query re-parse hurts).
