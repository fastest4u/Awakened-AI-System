---
title: "Deep audit 2026-06-11: 86 verified findings and prioritized improvement roadmap for memory MCP server"
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-06-11-refresh-claude-md-via-init-verify-all-claims-against-current-code-and-document-tier-1-3-search-embeddings-env-mcp-doctor-lifecycle-mechanics.md
confidence: high
status: active
created: "2026-06-11"
updated: "2026-06-11"
tags:
  - audit
  - roadmap
  - retrieval-accuracy
  - performance
  - token-economy
  - multi-agent
  - thai-language
---
95-agent adversarial audit (8 finder dimensions, every finding independently verified by a skeptic agent; 86 confirmed, 1 refuted). Full data: workflow run wf_d0260d55-0d3. Prioritized roadmap:

P0 — Vault resolution correctness (CRITICAL, core guarantee broken):
- Dynamic IDE-state resolution attaches to the WRONG project's vault; cross-project contamination confirmed in this live vault (memory.config.ts:678-769). Add a hard vault-marker requirement before writes, or refuse dynamic resolution for write tools.
- memory_bootstrapProject generates client configs pointing at a nonexistent entrypoint one directory above dist/ (memory-bootstrap.service.ts:54) — onboarding ships broken wiring.
- Generated configs pin MEMORY_PROJECT_ROOT to the 'dynamic' sentinel instead of the literal project root they are written into (memory.config.ts:899-908). Write the absolute root instead.
- PWD/OLDPWD/INIT_CWD env candidates outrank a vault-bearing cwd with no marker requirement (memory.config.ts:144-151,737-750); home dir accepted as workspace via ~/AGENTS.md or ~/package.json.

P1 — contextPack accuracy/perf cluster (one refactor fixes 5 confirmed highs):
- contextPack bypasses BM25/hybrid entirely; scores a 360-char excerpt by substring (memory-workflow.service.ts:161,344-358) — Thai body text invisible. Route scoring through IndexRepository.rank()/rankHybrid().
- Dead relevance filter: typeWeight>=1 makes every record score>0, packs fill with irrelevant high-weight notes (:170).
- scoreRecord calls usage.scoreBoost per record → ~190 re-reads+parses of 143KB usage.json per call, measured ~290-394ms, grows unboundedly. Build booster once (the documented pattern memory-query.service.ts:136 already uses).
- compactRecord embeds full usage telemetry (up to 3KB contexts map per note) AND bills it against maxChars, crowding out real excerpts (:441). Return only {selectedCount,lastSelectedAt}.
- Usage booster (up to +18) overrides BM25: exact-title queries fail 9x more often with boost on (memory-usage.service.ts:70-80). Cap/normalize the boost relative to BM25 score; add usage decay.

P1 — State-file integrity:
- usage.json/lifecycle.json written with plain writeFileSync + silent catch-reset-to-empty: a torn read wipes ALL usage/lifecycle history and the next write persists the wipe (memory-usage.service.ts:106-114, memory-lifecycle.service.ts:356-365). Apply the tmp+renameSync pattern already used in memory-query.service.ts:368.
- Single global activeSession: concurrent agents archive each other's sessions as forced grade-F (4 of last 20 live sessions are such casualties); memory_awaken internally calls sessionStart and silently kills the in-flight session (memory-workflow.service.ts:223). Make awaken non-mutating; consider per-agent session slots.

P2 — Token economy (mandatory-path waste):
- sessionEnd ships up to 30 full candidateSessions excerpts (~5-7k tokens) nobody asked for (memory-compaction.service.ts:47); return counts only.
- sessionStart duplicates followUps + lifecycle blocks twice in one payload (memory-workflow.service.ts:143-146).
- Every envelope serialized twice and pretty-printed (+10-20% tokens) (tool-response.service.ts:44-47); use compact JSON for the text copy.
- selfCheck returns raw StoredRecords (searchText 4KB each, vectors once embeddings on) violating the documented toPublicRecord invariant (memory-workflow.service.ts:242-253).

P2 — Thai-language correctness (this vault is mixed Thai/English):
- slugify strips all non-ASCII → Thai topics become 'untitled' filenames and digest dedupe silently drops distinct Thai lessons (memory-format.ts:51-57).
- Risky-work gate regex and inferMode keywords are English-only with raw substring bugs ('pr' matches 'project') (memory-lifecycle.service.ts:293-304, memory-workflow.service.ts:383-402).
- Thai n-gram dedup destroys term frequency: a note with the keyword 10x ranks below one with it once (ngram.ts:67-76 + bm25.ts:52).

P2 — Compaction churn: auto-compact on every sessionEnd (minSessions:1) rewrites Auto-Memory-Digest, re-emits all open follow-ups as fresh unchecked checkboxes (30/30 duplicated in live vault), resets created/updated so the digest permanently tops recency, and accumulates one backup dir per run.

P3 — Contract/robustness quick wins: silently-ignored declared params (search sortBy/scope/includeBody, list sortBy, findDuplicates similarityThreshold, verifyNote flags); Zod strip-mode swallows typo'd fields (add .strict()); date inputs unvalidated → '2026/06/10' nests folders and ':' crashes sessionEnd with EINVAL on Windows (add YYYY-MM-DD regex); export/import stubs fake ok:true (return NOT_IMPLEMENTED); SEARCH_TEXT_LIMIT=4000 leaves 15% of live notes partially unsearchable; doctor only reads project-local configs (false NO_CLIENT_CONFIGS warnings); isPathWithin case-sensitive on Windows; broken-link scan uses different resolution semantics than the backlink graph (false flags possible on 121/177 notes); yamlScalar emits unquoted '#'/numeric-like strings corrupting frontmatter on next read.
