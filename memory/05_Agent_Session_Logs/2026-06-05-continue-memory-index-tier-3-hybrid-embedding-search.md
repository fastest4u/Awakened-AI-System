---
title: "2026-06-05 - Continue memory index Tier 3 hybrid embedding search"
type: session-log
session-date: "2026-06-05"
agent: codex
outcomes:
  - "Completed opt-in Tier 3 hybrid search plumbing with MEMORY_EMBEDDINGS config, hash/http providers, vector cache signatures, RRF fusion, and lexical-only fallback."
  - Added Thai/CJK character n-gram recall across index and section matching while preserving Latin/code token behavior.
  - Hardened embedding refresh with bounded document batches and cooldown on endpoint errors or malformed provider responses.
  - Documented embedding environment variables in README and recorded the Tier 3 retrieval ADR.
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - session-log
  - project/general
---
# 2026-06-05 - Continue memory index Tier 3 hybrid embedding search

## TL;DR
- Completed opt-in Tier 3 hybrid search plumbing with MEMORY_EMBEDDINGS config, hash/http providers, vector cache signatures, RRF fusion, and lexical-only fallback.
- Added Thai/CJK character n-gram recall across index and section matching while preserving Latin/code token behavior.
- Hardened embedding refresh with bounded document batches and cooldown on endpoint errors or malformed provider responses.
- Documented embedding environment variables in README and recorded the Tier 3 retrieval ADR.

## Goal
Continue memory index Tier 3 hybrid embedding search

## What Was Done
- Completed opt-in Tier 3 hybrid search plumbing with MEMORY_EMBEDDINGS config, hash/http providers, vector cache signatures, RRF fusion, and lexical-only fallback.
- Added Thai/CJK character n-gram recall across index and section matching while preserving Latin/code token behavior.
- Hardened embedding refresh with bounded document batches and cooldown on endpoint errors or malformed provider responses.
- Documented embedding environment variables in README and recorded the Tier 3 retrieval ADR.

## Files Touched
- C:\Users\Server\Desktop\Awakened-AI-System\README.md
- C:\Users\Server\Desktop\Awakened-AI-System\src\app.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\config\embedding.config.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\repositories\index.repository.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\services\embedding\embedding-provider.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\services\embedding\hash-embedder.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\services\embedding\http-embedder.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\services\memory-query.service.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\utils\ngram.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\utils\sections.ts
- C:\Users\Server\Desktop\Awakened-AI-System\src\utils\vector.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\embedding.config.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\hash-embedder.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\http-embedder.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\index.repository.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\memory-query.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\ngram.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\tests\vector.test.ts
- C:\Users\Server\Desktop\Awakened-AI-System\memory\04_Architecture_Decisions\adopt-opt-in-tier-3-hybrid-embedding-search-for-memory-retrieval.md

## Decisions Made
- Embeddings remain off by default; lexical/BM25 behavior remains the default local-first path.
- Hybrid ranking fuses BM25, vector cosine, and usage arms by Reciprocal Rank Fusion instead of comparing raw scores.
- Document vectors are persisted only with an active embedder signature and stripped from public search/get/list results.
- Embedding provider failures and malformed responses degrade to lexical-only rather than failing MCP search tools.

## Open Follow-ups
- [ ] Review/commit the branch worktree separately; git status still contains broad pre-existing memory vault and AGENTS.md changes outside the Tier 3 implementation surface.
- [ ] Consider a PR for feat/memory-index-tier3-embeddings once the user is ready to ship.

## References
- None

## Verification
Ran targeted Node tests for memory-query and retrieval helpers, then ran full `npm test` after the final README edit: 237 tests passed, 0 failed. Ran `npm run build` after the final README edit: build completed successfully for dist/index.js and dist/cli.js.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
