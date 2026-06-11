---
title: "2026-06-11 - Implement all audit fixes: P0 vault-resolution safety, contextPack BM25 refactor, atomic state writes, Thai-language support, token-economy trims, API hardening"
type: session-log
session-date: "2026-06-11"
agent: claude-code
outcomes:
  - "Implemented the full P0-P3 audit roadmap via 8 implementation agents in 3 phases (6 parallel disjoint-file packages + workflow refactor + failed-package recovery), then integrated: npm run typecheck clean, 364/364 tests pass, npm run build succeeds"
  - "P0 vault resolution: 5-pass precedence (vault-marker pass first, PWD/OLDPWD demoted to last env tier), home-dir/filesystem-root rejected as workspace, resolution provenance + PROJECT_ROOT_UNVERIFIED doctor warning, bootstrap entrypoint fixed via package.json walk-up (was one dir above dist/), generated configs and doctor snippets pin literal MEMORY_PROJECT_ROOT, doctor scans global ~/.claude.json, mojibake comments restored"
  - "Retrieval accuracy: contextPack now ranks via new MemoryQueryService.rankFor (BM25 full-text + usage boost capped at 0.75x BM25 applied only to matching docs, booster built once), relevance gate kills the dead typeWeight filter, usage telemetry stripped from wire, SEARCH_TEXT_LIMIT 4000->12000, cosine floor 0.15, Thai n-gram TF preserved, Unicode slugify, folder filters segment-aware case-insensitive, sortBy/scope/includeBody/similarityThreshold/verifyNote flags honored"
  - "Robustness: usage.json/lifecycle.json atomic tmp+rename writes with stderr warning on parse fallback, contexts capped top-40, supersede archives with null gate + endReason instead of forced grade-F, awaken now lifecycle-non-mutating, backup rotation keeps 20, yamlScalar quoting matrix, date inputs validated YYYY-MM-DD end-to-end, Zod .strict() on all 34 schemas, export/import return NOT_IMPLEMENTED"
  - "Token economy: compact JSON text envelope, sessionStart followUps/lifecycle/recommendedReads single-copy, sessionEnd lean candidateCount/candidatePaths, selfCheck compact projection, auto-compact minSessions 1->5, digest re-emits follow-ups as non-checkbox lines and preserves created date"
  - "Updated CLAUDE.md to match all new behaviors; rebuilt dist/ (MCP clients must reload to see new behavior)"
created: "2026-06-11"
updated: "2026-06-11"
tags:
  - session-log
  - project/general
---
# 2026-06-11 - Implement all audit fixes: P0 vault-resolution safety, contextPack BM25 refactor, atomic state writes, Thai-language support, token-economy trims, API hardening

## TL;DR
- Implemented the full P0-P3 audit roadmap via 8 implementation agents in 3 phases (6 parallel disjoint-file packages + workflow refactor + failed-package recovery), then integrated: npm run typecheck clean, 364/364 tests pass, npm run build succeeds
- P0 vault resolution: 5-pass precedence (vault-marker pass first, PWD/OLDPWD demoted to last env tier), home-dir/filesystem-root rejected as workspace, resolution provenance + PROJECT_ROOT_UNVERIFIED doctor warning, bootstrap entrypoint fixed via package.json walk-up (was one dir above dist/), generated configs and doctor snippets pin literal MEMORY_PROJECT_ROOT, doctor scans global ~/.claude.json, mojibake comments restored
- Retrieval accuracy: contextPack now ranks via new MemoryQueryService.rankFor (BM25 full-text + usage boost capped at 0.75x BM25 applied only to matching docs, booster built once), relevance gate kills the dead typeWeight filter, usage telemetry stripped from wire, SEARCH_TEXT_LIMIT 4000->12000, cosine floor 0.15, Thai n-gram TF preserved, Unicode slugify, folder filters segment-aware case-insensitive, sortBy/scope/includeBody/similarityThreshold/verifyNote flags honored
- Robustness: usage.json/lifecycle.json atomic tmp+rename writes with stderr warning on parse fallback, contexts capped top-40, supersede archives with null gate + endReason instead of forced grade-F, awaken now lifecycle-non-mutating, backup rotation keeps 20, yamlScalar quoting matrix, date inputs validated YYYY-MM-DD end-to-end, Zod .strict() on all 34 schemas, export/import return NOT_IMPLEMENTED
- Token economy: compact JSON text envelope, sessionStart followUps/lifecycle/recommendedReads single-copy, sessionEnd lean candidateCount/candidatePaths, selfCheck compact projection, auto-compact minSessions 1->5, digest re-emits follow-ups as non-checkbox lines and preserves created date
- Updated CLAUDE.md to match all new behaviors; rebuilt dist/ (MCP clients must reload to see new behavior)

## Goal
Implement all audit fixes: P0 vault-resolution safety, contextPack BM25 refactor, atomic state writes, Thai-language support, token-economy trims, API hardening

## What Was Done
- Implemented the full P0-P3 audit roadmap via 8 implementation agents in 3 phases (6 parallel disjoint-file packages + workflow refactor + failed-package recovery), then integrated: npm run typecheck clean, 364/364 tests pass, npm run build succeeds
- P0 vault resolution: 5-pass precedence (vault-marker pass first, PWD/OLDPWD demoted to last env tier), home-dir/filesystem-root rejected as workspace, resolution provenance + PROJECT_ROOT_UNVERIFIED doctor warning, bootstrap entrypoint fixed via package.json walk-up (was one dir above dist/), generated configs and doctor snippets pin literal MEMORY_PROJECT_ROOT, doctor scans global ~/.claude.json, mojibake comments restored
- Retrieval accuracy: contextPack now ranks via new MemoryQueryService.rankFor (BM25 full-text + usage boost capped at 0.75x BM25 applied only to matching docs, booster built once), relevance gate kills the dead typeWeight filter, usage telemetry stripped from wire, SEARCH_TEXT_LIMIT 4000->12000, cosine floor 0.15, Thai n-gram TF preserved, Unicode slugify, folder filters segment-aware case-insensitive, sortBy/scope/includeBody/similarityThreshold/verifyNote flags honored
- Robustness: usage.json/lifecycle.json atomic tmp+rename writes with stderr warning on parse fallback, contexts capped top-40, supersede archives with null gate + endReason instead of forced grade-F, awaken now lifecycle-non-mutating, backup rotation keeps 20, yamlScalar quoting matrix, date inputs validated YYYY-MM-DD end-to-end, Zod .strict() on all 34 schemas, export/import return NOT_IMPLEMENTED
- Token economy: compact JSON text envelope, sessionStart followUps/lifecycle/recommendedReads single-copy, sessionEnd lean candidateCount/candidatePaths, selfCheck compact projection, auto-compact minSessions 1->5, digest re-emits follow-ups as non-checkbox lines and preserves created date
- Updated CLAUDE.md to match all new behaviors; rebuilt dist/ (MCP clients must reload to see new behavior)

## Files Touched
- src/config/memory.config.ts
- src/config/embedding.config.ts
- src/services/memory-bootstrap.service.ts
- src/services/memory-query.service.ts
- src/services/memory-workflow.service.ts
- src/services/memory-follow-up.service.ts
- src/services/memory-usage.service.ts
- src/services/memory-lifecycle.service.ts
- src/services/memory-compaction.service.ts
- src/services/memory-template.service.ts
- src/services/vault-health.service.ts
- src/services/frontmatter.service.ts
- src/services/tool-response.service.ts
- src/services/embedding/http-embedder.ts
- src/repositories/index.repository.ts
- src/repositories/note.repository.ts
- src/utils/memory-format.ts
- src/utils/ngram.ts
- src/utils/vector.ts
- src/utils/frontmatter.ts
- src/utils/links.ts
- src/schemas/memory.ts
- src/controllers/note.controller.ts
- src/controllers/verify.controller.ts
- src/controllers/maintenance.controller.ts
- tests (12 files updated, 8 new)
- CLAUDE.md

## Decisions Made
- Disjoint-file ownership across 6 parallel agents instead of worktrees; integration gates (typecheck/tests) run only after merge
- contextPack relevance = rankFor(BM25)*10 + preset type weight + mistake/ADR bonuses with a zero-relevance gate; empty-terms packs keep type-weight fallback
- Supersede semantics: null quality gate + endReason 'superseded' rather than per-agent session slots (schema-compatible, removes falsified grade-F telemetry)
- search scope enum changed from never-honored vault|folder|index to implemented all|title|tags
- memory_export/memory_import return NOT_IMPLEMENTED errors instead of fabricated ok:true

## Open Follow-ups
- [ ] Reload MCP clients to pick up the rebuilt dist/index.js; first verifyVault after reload may surface previously-skipped path-style broken wikilinks in the live vault (stricter link validation)
- [ ] README.md (Thai) still documents the old search scope enum vault|folder|index and old export/import placeholders — update docs; also line-1 typo 'co#' remains
- [ ] Auto-Memory-Digest heading renamed to 'Unresolved From Source Sessions' — anything grepping for the old 'Open Follow-ups' heading in the digest must adjust
- [ ] awaken response shape changed (context.contextPack + top-level lifecycle status) — external consumers of the old shape must adapt
- [ ] Cross-process index staleness (processes never reload index.json after startup) only partially addressed: vector wipes prevented, duplicate embedding work across processes remains
- [ ] RANK_SCORE_SCALE=10 in contextPack is a heuristic — tune if pack ordering looks relevance-flat on the real vault
- [ ] Write the missing full-auto ADR cited by AGENTS.md; consider committing this large working-tree change set on the feature branch

## References
- 07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md
- CLAUDE.md

## Verification
npm run typecheck: clean. npm test: 364/364 pass (one cross-package conflict found and fixed: schema-version now stamped as numeric CURRENT_SCHEMA_VERSION so the hardened yamlScalar does not quote it). npm run build: success. Bootstrap entrypoint fix diff-reviewed by hand. memory_selfCheck was run before implementation.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
