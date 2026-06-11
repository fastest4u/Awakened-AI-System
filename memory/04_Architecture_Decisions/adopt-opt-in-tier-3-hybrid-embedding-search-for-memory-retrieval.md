---
title: Adopt opt-in Tier 3 hybrid embedding search for memory retrieval
type: adr
status: accepted
decision-date: "2026-06-05"
confidence: high
supersedes: []
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - memory-index
  - retrieval
  - embeddings
  - hybrid-search
  - architecture
---
## Context
Tier 1 BM25 and Tier 2 backlink/section-anchor search are already shipped. The current branch continues the retrieval roadmap with optional semantic recall while preserving local-first, offline-safe default behavior and existing lexical ranking when no provider is configured.

## Decision
Add an opt-in Tier 3 hybrid search layer: MEMORY_EMBEDDINGS defaults to none; hash/http providers can be enabled explicitly; document vectors are cached in the persisted index with an embedder signature; search fuses lexical BM25, vector cosine, and usage signals with Reciprocal Rank Fusion; Thai/CJK recall is improved with character n-grams; provider failures or malformed responses degrade to lexical-only with cooldown, and document embedding runs in bounded batches.

## Consequences
- Default behavior remains lexical-only/offline unless MEMORY_EMBEDDINGS is set.
- Cached vectors are stripped from public tool responses and invalidated when the active embedder signature changes.
- First search after enabling embeddings may spend time filling missing vectors, but bounded batches and cooldown reduce endpoint pressure and repeated failures.
- Hash embeddings provide deterministic offline overlap search, while real semantic/cross-lingual recall needs an HTTP embedding model.
