---
title: Optional embedding providers need bounded batches and malformed-response cooldown
type: insight
derived-from:
  - 04_Architecture_Decisions/adopt-opt-in-tier-3-hybrid-embedding-search-for-memory-retrieval.md
confidence: high
status: active
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - embeddings
  - retrieval
  - resilience
  - mcp
---
When optional external embedding providers are plugged into a read path, first-search index filling must be bounded and failure-tolerant. Batch document embedding requests so one query cannot send the whole vault to a provider at once. Treat malformed provider responses (wrong vector count or invalid vectors) like endpoint failures: degrade to lexical-only and start a short cooldown, otherwise every subsequent search pays the same doomed retry cost.
