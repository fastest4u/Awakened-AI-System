---
title: "2026-06-11 - Refresh CLAUDE.md via /init: verify all claims against current code and document Tier 1-3 search, embeddings env, MCP doctor, lifecycle mechanics"
type: session-log
session-date: "2026-06-11"
agent: claude-code
outcomes:
  - "Rewrote CLAUDE.md after a 5-agent verification pass (claim audit + 4 subsystem explorers) cross-checked every existing claim against source"
  - "Corrected tool count from ~40 to exactly 32 registered memory_* tools plus 4 MCP prompts; flagged memory_export/memory_import as no-op stubs"
  - "Removed dead source-of-truth reference: memory/04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md does not exist; tier policy lives only in root AGENTS.md"
  - Fixed allowlist pointer from .claude/settings.json to .claude/settings.local.json
  - "Documented the three-tier search/index subsystem (persistent index.json + BM25, backlink graph + section anchors, RRF hybrid embeddings), MEMORY_EMBEDDINGS* env family with silent lexical fallback, and the contextPack-does-not-use-BM25 split"
  - "Documented MCP doctor (lives in memory.config.ts, surfaced via memory_diagnoseWorkspace and memory-vault diagnose; no doctor subcommand), corrected build to three stages (cli.js minified not obfuscated), expanded vault resolution to the real 5-step order, added lifecycle/quality-gate mechanics and CLI footguns (--no-backup ignored, --unsafe needs --confirm, diagnose ignores --vault)"
created: "2026-06-11"
updated: "2026-06-11"
tags:
  - session-log
  - project/general
---
# 2026-06-11 - Refresh CLAUDE.md via /init: verify all claims against current code and document Tier 1-3 search, embeddings env, MCP doctor, lifecycle mechanics

## TL;DR
- Rewrote CLAUDE.md after a 5-agent verification pass (claim audit + 4 subsystem explorers) cross-checked every existing claim against source
- Corrected tool count from ~40 to exactly 32 registered memory_* tools plus 4 MCP prompts; flagged memory_export/memory_import as no-op stubs
- Removed dead source-of-truth reference: memory/04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md does not exist; tier policy lives only in root AGENTS.md
- Fixed allowlist pointer from .claude/settings.json to .claude/settings.local.json
- Documented the three-tier search/index subsystem (persistent index.json + BM25, backlink graph + section anchors, RRF hybrid embeddings), MEMORY_EMBEDDINGS* env family with silent lexical fallback, and the contextPack-does-not-use-BM25 split
- Documented MCP doctor (lives in memory.config.ts, surfaced via memory_diagnoseWorkspace and memory-vault diagnose; no doctor subcommand), corrected build to three stages (cli.js minified not obfuscated), expanded vault resolution to the real 5-step order, added lifecycle/quality-gate mechanics and CLI footguns (--no-backup ignored, --unsafe needs --confirm, diagnose ignores --vault)

## Goal
Refresh CLAUDE.md via /init: verify all claims against current code and document Tier 1-3 search, embeddings env, MCP doctor, lifecycle mechanics

## What Was Done
- Rewrote CLAUDE.md after a 5-agent verification pass (claim audit + 4 subsystem explorers) cross-checked every existing claim against source
- Corrected tool count from ~40 to exactly 32 registered memory_* tools plus 4 MCP prompts; flagged memory_export/memory_import as no-op stubs
- Removed dead source-of-truth reference: memory/04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md does not exist; tier policy lives only in root AGENTS.md
- Fixed allowlist pointer from .claude/settings.json to .claude/settings.local.json
- Documented the three-tier search/index subsystem (persistent index.json + BM25, backlink graph + section anchors, RRF hybrid embeddings), MEMORY_EMBEDDINGS* env family with silent lexical fallback, and the contextPack-does-not-use-BM25 split
- Documented MCP doctor (lives in memory.config.ts, surfaced via memory_diagnoseWorkspace and memory-vault diagnose; no doctor subcommand), corrected build to three stages (cli.js minified not obfuscated), expanded vault resolution to the real 5-step order, added lifecycle/quality-gate mechanics and CLI footguns (--no-backup ignored, --unsafe needs --confirm, diagnose ignores --vault)

## Files Touched
- CLAUDE.md

## Decisions Made
- Keep CLAUDE.md as the single onboarding doc but split operating protocol (what to do) from lifecycle mechanics (how the gate works in code)
- Describe IDE product list at summary level so the doc does not rot as products are added

## Open Follow-ups
- [ ] Uncommitted src/config/memory.config.ts edit (adds 'devin' to IDE_PRODUCT_DIRS) also corrupted UTF-8 comment chars to U+FFFD at ~6 sites — clean the mojibake before committing
- [ ] AGENTS.md:19 still cites the non-existent full-auto ADR — either write that ADR via memory_writeADR or drop the citation
- [ ] memory_export and memory_import remain no-op stubs (also tracked in Auto-Memory-Digest)
- [ ] README.md line 1 has a committed typo: 'co# Awakened AI Memory MCP Server' (broken H1)
- [ ] memory_diagnoseWorkspace and the three frontmatter tools are unassigned in the AGENTS.md tier policy — assign tiers

## References
- CLAUDE.md
- AGENTS.md
- src/config/memory.config.ts
- src/config/embedding.config.ts
- src/services/memory-query.service.ts
- src/repositories/index.repository.ts
- src/cli.ts
- scripts/build.js

## Verification
All facts verified against source by parallel audit agents with file:line evidence (e.g. 32 tools counted via registerTool grep across 6 controllers; resolution order traced in memory.config.ts:730-778; embedder env in embedding.config.ts:8-90; stubs at maintenance.controller.ts:59-65). Single-file doc edit; typecheck/tests not applicable.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
