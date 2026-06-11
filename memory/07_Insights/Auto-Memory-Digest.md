---
title: Auto Memory Digest
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-06-11-refresh-claude-md-via-init-verify-all-claims-against-current-code-and-document-tier-1-3-search-embeddings-env-mcp-doctor-lifecycle-mechanics.md
  - 05_Agent_Session_Logs/2026-06-11-deep-multi-agent-audit-of-memory-mcp-server-86-adversarially-verified-improvement-findings-across-8-dimensions.md
  - 05_Agent_Session_Logs/2026-06-11-implement-all-audit-fixes-p0-vault-resolution-safety-contextpack-bm25-refactor-atomic-state-writes-thai-language-support-token-economy-trims-api-hardening.md
  - 05_Agent_Session_Logs/2026-06-10-analyze-spx-accept-speed-critical-path-and-propose-improvements.md
  - 05_Agent_Session_Logs/2026-06-10-implement-b1-rules-cache-and-b2-fail-fast-list-poll-for-accept-speed.md
  - 05_Agent_Session_Logs/2026-06-05-continue-memory-index-tier-3-hybrid-embedding-search.md
  - 05_Agent_Session_Logs/2026-06-05-answer-compact-memory-behavior-in-project-memory-mcp.md
  - 05_Agent_Session_Logs/2026-06-05-answer-claude-code-integration-status.md
  - 05_Agent_Session_Logs/2026-06-05-recommend-next-project-memory-mcp-improvements.md
  - 05_Agent_Session_Logs/2026-06-05-implement-mcp-doctor-client-diagnostics-v2.md
  - 05_Agent_Session_Logs/2026-06-05-add-mcp-doctor-remediation-suggestions.md
  - 05_Agent_Session_Logs/2026-06-05-recommend-next-project-memory-mcp-roadmap-step.md
  - 05_Agent_Session_Logs/2026-06-05-runtime-verification-strict-review-and-commit-preparation-for-tier-3-embeddings-mcp-doctor.md
  - 05_Agent_Session_Logs/2026-06-04-review-harden-and-ship-memory-index-tier-2-backlink-graph-section-anchors-via-pr-6.md
  - 05_Agent_Session_Logs/2026-06-03-add-claude-md-onboarding-guide-for-claude-code.md
  - 05_Agent_Session_Logs/2026-06-03-add-full-auto-project-memory-operating-protocol-directive-to-claude-md.md
  - 05_Agent_Session_Logs/2026-06-03-analyze-memory-index-retrieval-and-propose-efficiency-roadmap-tier-1-3.md
  - 05_Agent_Session_Logs/2026-06-03-audit-memory-vault-frontmatter-system-vs-15-section-thai-prompt-survey-gap-risk-no-code-edits.md
  - 05_Agent_Session_Logs/2026-06-03-implement-steps-1-6-frontmatter-safety-hardening-fix-gray-matter-cache-non-idempotency.md
  - 05_Agent_Session_Logs/2026-06-03-implement-tier-1-memory-index-incremental-persistent-index-bm25-ranked-search.md
  - 05_Agent_Session_Logs/2026-06-03-make-rollback-reversible-snapshot-before-restore-scope-latestbackupdir-to-fix-migrate-backups.md
  - 05_Agent_Session_Logs/2026-06-03-post-merge-cleanup-fix-claude-md-dist-claim-delete-merged-branch-sync-local-main.md
  - 05_Agent_Session_Logs/2026-06-03-step-7-frontmatter-enhancements-versioned-migration-central-codes-diagnostic-line-numbers-vault-containment.md
  - 05_Agent_Session_Logs/2026-06-02-memory-vault-full-refactor.md
  - 05_Agent_Session_Logs/2026-06-01-add-project-local-frontmatter-config-json-schema-and-verify-reusable-init-flow.md
  - 05_Agent_Session_Logs/2026-06-01-close-prompt-checklist-gaps-cli-safe-unsafe-confirm-migrate-rollback-validfiles-report-count-and-missing-tests-unknown-fields-config-fallback-override.md
  - 05_Agent_Session_Logs/2026-06-01-confirm-runtime-mcp-blocker-for-frontmatter-completion.md
  - 05_Agent_Session_Logs/2026-06-01-document-runtime-refresh-workflow-for-stale-project-memory-mcp-frontmatter-diagnostics.md
  - 05_Agent_Session_Logs/2026-06-01-harden-frontmatter-warning-system-and-safety-defaults.md
  - 05_Agent_Session_Logs/2026-06-01-implement-option-c-hybrid-frontmatter-system-for-project-memory-mcp-safe-parser-schema-fix-migrate-report-cli-mcp-tools-tests.md
confidence: medium
status: active
created: "2026-06-11"
updated: "2026-06-11"
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-06-11

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- Rewrote CLAUDE.md after a 5-agent verification pass (claim audit + 4 subsystem explorers) cross-checked every existing claim against source
- Corrected tool count from ~40 to exactly 32 registered memory_* tools plus 4 MCP prompts; flagged memory_export/memory_import as no-op stubs
- Removed dead source-of-truth reference: memory/04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md does not exist; tier policy lives only in root AGENTS.md
- Fixed allowlist pointer from .claude/settings.json to .claude/settings.local.json
- Documented the three-tier search/index subsystem (persistent index.json + BM25, backlink graph + section anchors, RRF hybrid embeddings), MEMORY_EMBEDDINGS* env family with silent lexical fallback, and the contextPack-does-not-use-BM25 split
- Documented MCP doctor (lives in memory.config.ts, surfaced via memory_diagnoseWorkspace and memory-vault diagnose; no doctor subcommand), corrected build to three stages (cli.js minified not obfuscated), expanded vault resolution to the real 5-step order, added lifecycle/quality-gate mechanics and CLI footguns (--no-backup ignored, --unsafe needs --confirm, diagnose ignores --vault)
- Ran a 95-agent workflow (8 dimension finders + 1 adversarial verifier per finding): 86 findings confirmed, 1 refuted, across index correctness, search accuracy, contextPack quality, lifecycle/usage/compaction, vault IO, config/doctor, performance, and API/token economy
- CRITICAL confirmed: dynamic IDE-state vault resolution attaches to the wrong project's vault with cross-project contamination present in this live vault; bootstrap also generates client configs with a nonexistent entrypoint path and pins MEMORY_PROJECT_ROOT to the dynamic sentinel
- Top accuracy cluster: contextPack (the mandated retrieval surface) bypasses BM25/hybrid, has a dead relevance filter, re-reads usage.json ~190x per call (~0.3-0.4s measured), and embeds 3KB usage telemetry per item billed against the maxChars budget; usage booster (+18) makes exact-title search fail 9x more often
- Top robustness cluster: usage.json/lifecycle.json non-atomic writes with silent catch-reset can wipe all accumulated state; single global activeSession means concurrent agents force-grade each other F (4 of last 20 live sessions); memory_awaken silently destroys the active session
- Thai-language cluster: slugify produces untitled filenames and digest dedupe drops distinct Thai lessons; risky-work regex and inferMode are English-only; Thai n-gram dedup destroys term frequency in BM25
- Wrote prioritized P0-P3 roadmap to 07_Insights/deep-audit-2026-06-11-86-verified-findings-and-prioritized-improvement-roadmap-for-memory-mcp-server.md and delivered full Thai report to user
- Implemented the full P0-P3 audit roadmap via 8 implementation agents in 3 phases (6 parallel disjoint-file packages + workflow refactor + failed-package recovery), then integrated: npm run typecheck clean, 364/364 tests pass, npm run build succeeds
- P0 vault resolution: 5-pass precedence (vault-marker pass first, PWD/OLDPWD demoted to last env tier), home-dir/filesystem-root rejected as workspace, resolution provenance + PROJECT_ROOT_UNVERIFIED doctor warning, bootstrap entrypoint fixed via package.json walk-up (was one dir above dist/), generated configs and doctor snippets pin literal MEMORY_PROJECT_ROOT, doctor scans global ~/.claude.json, mojibake comments restored
- Retrieval accuracy: contextPack now ranks via new MemoryQueryService.rankFor (BM25 full-text + usage boost capped at 0.75x BM25 applied only to matching docs, booster built once), relevance gate kills the dead typeWeight filter, usage telemetry stripped from wire, SEARCH_TEXT_LIMIT 4000->12000, cosine floor 0.15, Thai n-gram TF preserved, Unicode slugify, folder filters segment-aware case-insensitive, sortBy/scope/includeBody/similarityThreshold/verifyNote flags honored
- Robustness: usage.json/lifecycle.json atomic tmp+rename writes with stderr warning on parse fallback, contexts capped top-40, supersede archives with null gate + endReason instead of forced grade-F, awaken now lifecycle-non-mutating, backup rotation keeps 20, yamlScalar quoting matrix, date inputs validated YYYY-MM-DD end-to-end, Zod .strict() on all 34 schemas, export/import return NOT_IMPLEMENTED
- Token economy: compact JSON text envelope, sessionStart followUps/lifecycle/recommendedReads single-copy, sessionEnd lean candidateCount/candidatePaths, selfCheck compact projection, auto-compact minSessions 1->5, digest re-emits follow-ups as non-checkbox lines and preserves created date
- Updated CLAUDE.md to match all new behaviors; rebuilt dist/ (MCP clients must reload to see new behavior)
- Mapped end-to-end critical path: poll wait (avg POLL_INTERVAL_MS/2) -> bidding list page1 RTT (+extra pages) -> per-tick DB rules query -> request-list page1 RTT (page-level fast lane exists) -> accept POST RTT
- Found stale comment in poller.ts:246 claiming rules are cached; readRulesDb() does a real DB SELECT every tick on the critical path before any detail fetch launches
- Found bidding-list fetch waits for ALL extra pages before scheduling details (api-client.ts fetch -> fetchRemainingBiddingListPages)
- Found list-poll retries (MAX_RETRIES=3, exponential backoff) stretch a failed tick ~7s+ even though the next tick supersedes it
- Proposed ranked improvements: ops (lower POLL_INTERVAL_MS, cooldown 30-60s, raise detail concurrency when saturated, host near SPX), code (rules cache/parallel fetch, fail-fast list poll, page-1 streaming, adaptive interval, newness-aware sort), experiments (undici allowH2)
- B1: added in-memory rules cache in src/services/notify-rules.ts — readRules() serves from cache (TTL 5s safety net), every writer (writeRulesFile, broadcastAllRules after all DB mutations, migrateJsonToDb) refreshes/invalidates synchronously, single-flight guard prevents concurrent SELECT stampede; per-tick DB SELECT removed from the accept critical path
- B2: added listPollRetries() and listPollTimeoutMs() in src/services/api-client.ts — bidding-list poll retry budget and timeout now derive from live POLL_INTERVAL_MS (worst-case backoff capped at interval/2, timeout clamped [5s, 15s] at 2x interval); default 30s interval keeps exactly today's behavior (3 retries, 15s timeout), aggressive intervals fail fast so cadence recovers via next tick
- npm run typecheck passed (backend + frontend); stopped at typecheck per Commit & Deploy Policy — no commit
- Completed opt-in Tier 3 hybrid search plumbing with MEMORY_EMBEDDINGS config, hash/http providers, vector cache signatures, RRF fusion, and lexical-only fallback.
- Added Thai/CJK character n-gram recall across index and section matching while preserving Latin/code token behavior.
- Hardened embedding refresh with bounded document batches and cooldown on endpoint errors or malformed provider responses.
- Documented embedding environment variables in README and recorded the Tier 3 retrieval ADR.

## Decisions To Remember
- Keep CLAUDE.md as the single onboarding doc but split operating protocol (what to do) from lifecycle mechanics (how the gate works in code)
- Describe IDE product list at summary level so the doc does not rot as products are added
- Prioritized vault-resolution correctness as P0 over all perf/token work because it breaks the product's core per-project isolation guarantee
- Grouped 5 independently-confirmed contextPack findings into one P1 refactor (route scoring through rank()/rankHybrid, build booster once, strip usage telemetry from wire format)
- Disjoint-file ownership across 6 parallel agents instead of worktrees; integration gates (typecheck/tests) run only after merge
- contextPack relevance = rankFor(BM25)*10 + preset type weight + mistake/ADR bonuses with a zero-relevance gate; empty-terms packs keep type-weight fallback
- Supersede semantics: null quality gate + endReason 'superseded' rather than per-agent session slots (schema-compatible, removes falsified grade-F telemetry)
- search scope enum changed from never-honored vault|folder|index to implemented all|title|tags
- memory_export/memory_import return NOT_IMPLEMENTED errors instead of fabricated ok:true
- Cache invalidation via writer-refresh + 5s TTL safety net instead of TTL-only or invalidation-only (covers out-of-band SQL edits while keeping in-app reads exact)
- Adaptive retry budget derived from POLL_INTERVAL_MS instead of hardcoded retries=0 (preserves long-interval recovery behavior unchanged)
- Fail-fast applies only to bidding-list pages; request-list/overview/accept hops keep full retries since post-detection completion matters more than cadence
- Embeddings remain off by default; lexical/BM25 behavior remains the default local-first path.
- Hybrid ranking fuses BM25, vector cosine, and usage arms by Reciprocal Rank Fusion instead of comparing raw scores.
- Document vectors are persisted only with an active embedder signature and stripped from public search/get/list results.
- Embedding provider failures and malformed responses degrade to lexical-only rather than failing MCP search tools.
- Kept diagnostics on the existing memory_diagnoseWorkspace tool instead of adding a separate tool, preserving the empty input schema and backward compatibility.
- Reported Claude Code missing root .mcp.json as info rather than warning because the server definition may intentionally live in a global config.
- Made client diagnostics file-based and read-only; no client processes are started or modified.
- Kept remediation additive and optional on each issue to preserve existing memory_diagnoseWorkspace consumers.
- Kept diagnostics read-only; remediation provides snippets and commands but does not modify client files.
- Recommended runtime/client verification and review/commit hygiene ahead of new feature work because the current diagnostic improvements are built but client processes may still be stale until reloaded.
- Keep memory_export/memory_import implementation for the next task after review/commit stabilization.
- Keep Doctor remediation read-only; provide snippets/commands but no auto-write behavior yet.
- Group implementation source/tests/README separately from memory vault notes and agent docs so PR review can separate runtime behavior from repository memory artifacts.
- Register link-graph resolution keys in precedence tiers (path/basename -> title/id -> aliases) across all notes instead of a flat per-note first-wins loop.
- Track fenced-code-block state in splitSections so heading detection is suppressed inside ``` / ~~~ fences.
- Snapshot the index once up front in resolveReference (all branches) rather than a second time in get().
- Defer duplicate-basename folder-aware (Obsidian shortest-path) resolution to a follow-up — LOW severity, does not occur in the current vault; documented in the ensureLinkGraph docstring.
- Kept broken-link warning dedup and full link-graph rebuild-on-mutation unchanged (both correct-by-design per the review).

## Open Follow-ups
- [ ] Uncommitted src/config/memory.config.ts edit (adds 'devin' to IDE_PRODUCT_DIRS) also corrupted UTF-8 comment chars to U+FFFD at ~6 sites — clean the mojibake before committing
- [ ] AGENTS.md:19 still cites the non-existent full-auto ADR — either write that ADR via memory_writeADR or drop the citation
- [ ] memory_export and memory_import remain no-op stubs (also tracked in Auto-Memory-Digest)
- [ ] README.md line 1 has a committed typo: 'co# Awakened AI Memory MCP Server' (broken H1)
- [ ] memory_diagnoseWorkspace and the three frontmatter tools are unassigned in the AGENTS.md tier policy — assign tiers
- [ ] P0: guard dynamic vault resolution (vault-marker requirement before writes; bootstrap should write literal project root, fix entrypoint path one dir above dist/)
- [ ] P1: contextPack refactor — use BM25/hybrid index, fix dead typeWeight filter, build usage booster once per call, return only {selectedCount,lastSelectedAt} usage
- [ ] P1: atomic tmp+rename writes for usage.json/lifecycle.json; make memory_awaken non-mutating
- [ ] P2: trim sessionEnd candidateSessions to counts, dedupe sessionStart followUps/lifecycle blocks, compact JSON in envelope text copy, selfCheck through toPublicRecord
- [ ] P2: Thai support — Unicode-preserving slugify, Thai keywords in risky-work regex and inferMode, fix n-gram term-frequency dedup
- [ ] P2: auto-compact churn — raise minSessions, stop re-emitting open follow-ups as unchecked checkboxes, stop resetting digest created/updated
- [ ] P3 quick wins: .strict() Zod schemas, YYYY-MM-DD date regex, NOT_IMPLEMENTED for export/import, raise SEARCH_TEXT_LIMIT, doctor global-config awareness, isPathWithin case-insensitive on Windows
- [ ] Carried from before: implement memory_export/memory_import; clean U+FFFD mojibake in memory.config.ts before commit; fix README.md line-1 typo; write the missing full-auto ADR cited by AGENTS.md
- [ ] Reload MCP clients to pick up the rebuilt dist/index.js; first verifyVault after reload may surface previously-skipped path-style broken wikilinks in the live vault (stricter link validation)
- [ ] README.md (Thai) still documents the old search scope enum vault|folder|index and old export/import placeholders — update docs; also line-1 typo 'co#' remains
- [ ] Auto-Memory-Digest heading renamed to 'Unresolved From Source Sessions' — anything grepping for the old 'Open Follow-ups' heading in the digest must adjust
- [ ] awaken response shape changed (context.contextPack + top-level lifecycle status) — external consumers of the old shape must adapt
- [ ] Cross-process index staleness (processes never reload index.json after startup) only partially addressed: vector wipes prevented, duplicate embedding work across processes remains
- [ ] RANK_SCORE_SCALE=10 in contextPack is a heuristic — tune if pack ordering looks relevance-flat on the real vault
- [ ] Write the missing full-auto ADR cited by AGENTS.md; consider committing this large working-tree change set on the feature branch
- [ ] User decision: which improvements to implement (B1 rules cache, B2 fail-fast poll, B3 page-1 streaming, B4 adaptive interval)
- [ ] Check dashboard metrics acceptRtt/detailToFirstMatch/pollLatency to size each fix before implementing
- [ ] Check logs for booking-detail-concurrency-saturated and bidding-list-fetching-extra-pages to confirm B3/concurrency relevance
- [ ] User to tune POLL_INTERVAL_MS themselves (1-3s during competition) via Settings UI
- [ ] Optional next slices not implemented: B3 stream bidding-list page 1, B4 adaptive interval, C1 HTTP/2 experiment
- [ ] Verify acceptRtt/detailToFirstMatch/pollLatency on dashboard after deploying with low interval
- [ ] Review/commit the branch worktree separately; git status still contains broad pre-existing memory vault and AGENTS.md changes outside the Tier 3 implementation surface.
- [ ] Consider a PR for feat/memory-index-tier3-embeddings once the user is ready to ship.
- [ ] If user wants 100% Claude Code setup audit, inspect Claude Code global/project MCP server definition because this repo has .claude/settings.local.json but no root .mcp.json file visible in the workspace.
- [ ] Consider adding optional remediation suggestions to doctor.issues, such as the exact config path and snippet to add when a client config is missing project-memory.

## Confidence Lessons
- Generated project configs now reference a real local JSON Schema artifact. -> A local schema artifact is better for project-agnostic reuse than a placeholder remote URL.
- The original full objective is complete. -> Completion must include runtime evidence for the MCP process, not only rebuilt dist/CLI evidence.
- validFiles addition keeps the suite green without re-running -> Additive, well-typed fields are low-risk, but state explicitly when a final test re-run was skipped so verification status stays honest
- PowerShell pipes to Select-String/node -e were the cause of hangs, not the code -> Avoid piping npm/node --test through PowerShell filters; run bare commands to prevent child-handle deadlocks
- The active MCP runtime is stale and not using the rebuilt frontmatter code. -> When MCP and CLI disagree after build, process ownership/creation time is decisive runtime evidence.
- Killing the Codex-owned project-memory process from this session is safe. -> Prefer client-level MCP restart over process termination from inside an active agent session.
- The frontmatter source/bundle behavior is warning-clean for template placeholders. -> Use CLI/new-bundle verification to distinguish source correctness from active MCP process freshness.
- The overall goal can be marked complete now. -> Completion evidence must include the actual runtime surface the user relies on, not only rebuilt artifacts.
- The rebuilt CLI validation no longer reports template placeholder warnings. -> Template placeholders should be handled as a semantic exemption, not by trying to coerce placeholder dates into the normal date schema.
- The running MCP frontmatter tool reflects the rebuilt behavior immediately after build. -> Building dist is necessary but not sufficient for active MCP tools; runtime restart is a separate verification step.
- parseFrontmatter never throws across all gray-matter failure modes -> Pre-checking raw delimiters before calling gray-matter makes failure classification reliable
- Changes preserve the existing 88/B vault health score -> Separating advisory info from the scoring gate avoids breaking backward-compatible health metrics

## Verification Evidence
- All facts verified against source by parallel audit agents with file:line evidence (e.g. 32 tools counted via registerTool grep across 6 controllers; resolution order traced in memory.config.ts:730-778; embedder env in embedding.config.ts:8-90; stubs at maintenance.controller.ts:59-65). Single-file doc edit; typecheck/tests not applicable.
- Read-only analysis; no source changes. Every finding was verified by an independent skeptic agent reading the cited code (several included runtime measurements, e.g. 190x usage.json reads = ~350ms reproduced, byte-exact file sizes). 1 finding rejected for fabricated evidence, demonstrating the verification layer filtered false positives. Full results: workflow wf_d0260d55-0d3 output file.
- npm run typecheck: clean. npm test: 364/364 pass (one cross-package conflict found and fixed: schema-version now stamped as numeric CURRENT_SCHEMA_VERSION so the hardened yamlScalar does not quote it). npm run build: success. Bootstrap entrypoint fix diff-reviewed by hand. memory_selfCheck was run before implementation.
- Read-only analysis; no code changes, no commands run. Claims grounded in cited source lines.
- npm run typecheck exit 0 (tsc backend + frontend). No runtime test run — db/smoke/flow tests hit live SPX/MySQL per AGENTS.md.
- Ran targeted Node tests for memory-query and retrieval helpers, then ran full `npm test` after the final README edit: 237 tests passed, 0 failed. Ran `npm run build` after the final README edit: build completed successfully for dist/index.js and dist/cli.js.
- Read README.md, memory notes, src/services/memory-compaction.service.ts, src/services/memory-workflow.service.ts, and src/schemas/memory.ts via rg/Get-Content. No code changes or tests were needed for this explanatory answer.
- Read CLAUDE.md, .claude/settings.local.json, AI Client setup notes, and related session logs using Get-Content/rg. No code changes or tests were needed for this explanatory answer.
- Used memory_sessionStart planning mode plus memory_followUpRadar, memory_search, and rg over src/README to ground recommendations in current roadmap, source, and known placeholders. No code changes or tests were needed.
- TDD red/green completed. Ran npm run test:build, node --test --test-reporter=spec dist-test/tests/memory.config.test.js, npm test (240 tests passed), npm run build, git diff --check, and node dist/cli.js diagnose via child_process summary. Built diagnose reported doctor.ok=true, configuredClients=7/7, issueCount=1 info-only CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL.
- TDD red/green completed. Ran npm run test:build, node --test --test-reporter=spec dist-test/tests/memory.config.test.js, npm test (240 tests passed), npm run build, node dist/cli.js diagnose summary confirming doctor.ok=true and remediation present, and git diff --check.
- Planning-only session; no files changed. Used memory_sessionStart with planning context and reviewed returned followUps/ADRs.
- memory_diagnoseWorkspace active MCP: argv dist/index.js, build builtAt 2026-06-05T09:41:46.336Z, doctor.ok=true with one info-only CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL; memory_validateFrontmatter on 99_Templates/Template-Daily-Note.md returned 0 issues; memory_verifyVault score 88/B with 0 warnings/errors; node dist/cli.js diagnose matched Doctor OK; npm test passed 243/243; npm run build succeeded; git diff --cached --check and git diff --check returned no whitespace errors (Windows CRLF warnings only).
- npm run typecheck clean; npm test 183/183 pass (was 172); npm run build green (obfuscated dist/index.js + dist/cli.js). PR #6 squash-merged to main (ac8a8b4); local main fast-forwarded and re-ran suite 183/183 on main; feature branch deleted local + remote.
- Documentation-only change; CLAUDE.md authored from reading src/app.ts, scripts/build.js, config/memory.config.ts, package.json, tsconfig*. No code changed, so npm build/test not run. MCP Full-Auto confirmed live via memory_diagnoseWorkspace + memory_sessionStart returning ok:true.
- Documentation-only edit to CLAUDE.md; two Edit operations applied cleanly. No source code changed, so npm build/test not run. Protocol wording cross-checked against context-pack notes 01_Project_Rules/Always-On-Memory-Protocol.md and the full-auto invocation ADR.
- Analysis grounded in reading src/repositories/index.repository.ts, src/services/memory-query.service.ts, src/services/memory-usage.service.ts (full files). No code changed; no tests run (advisory).
- Empirical: Node probe of installed gray-matter@4.0.3 confirmed throw/no-throw behavior for duplicate-key, unquoted-colon, bad-indent, tab-indent. Code reads confirmed migrate->computeRewrite fabrication path (frontmatter.service.ts:217-257,294-342) and body-strip (utils/frontmatter.ts:250-254). Live MCP validateFrontmatter + verifyVault rechecked (clean). No code changed.
- npm test => 129 pass / 0 fail (35 suites). tsc --noEmit clean. npm run build green (esbuild + obfuscator, dist rebuilt). Live CLI smoke on ./memory: validate 151/151 valid 0 issues; migrate dry-run text renderer shows would-migrate 143 manual 0; validate --format xml -> 'Invalid --format' exit 2; fix --apply --no-backup -> mandatory-backup warning. No live vault note was mutated (all dry-run/read-only).
- tsc --noEmit clean; npm test 158 pass / 0 fail (42 suites); npm run build green; perf smoke (dist-test, 200-file temp vault): cold 114ms (build index), warm ~28ms/query (no re-parse of unchanged files). Live vault not mutated (tests/smoke used temp dirs).

## Source Sessions
- [[05_Agent_Session_Logs/2026-06-11-refresh-claude-md-via-init-verify-all-claims-against-current-code-and-document-tier-1-3-search-embeddings-env-mcp-doctor-lifecycle-mechanics|2026-06-11-refresh-claude-md-via-init-verify-all-claims-against-current-code-and-document-tier-1-3-search-embeddings-env-mcp-doctor-lifecycle-mechanics.md]]
- [[05_Agent_Session_Logs/2026-06-11-deep-multi-agent-audit-of-memory-mcp-server-86-adversarially-verified-improvement-findings-across-8-dimensions|2026-06-11-deep-multi-agent-audit-of-memory-mcp-server-86-adversarially-verified-improvement-findings-across-8-dimensions.md]]
- [[05_Agent_Session_Logs/2026-06-11-implement-all-audit-fixes-p0-vault-resolution-safety-contextpack-bm25-refactor-atomic-state-writes-thai-language-support-token-economy-trims-api-hardening|2026-06-11-implement-all-audit-fixes-p0-vault-resolution-safety-contextpack-bm25-refactor-atomic-state-writes-thai-language-support-token-economy-trims-api-hardening.md]]
- [[05_Agent_Session_Logs/2026-06-10-analyze-spx-accept-speed-critical-path-and-propose-improvements|2026-06-10-analyze-spx-accept-speed-critical-path-and-propose-improvements.md]]
- [[05_Agent_Session_Logs/2026-06-10-implement-b1-rules-cache-and-b2-fail-fast-list-poll-for-accept-speed|2026-06-10-implement-b1-rules-cache-and-b2-fail-fast-list-poll-for-accept-speed.md]]
- [[05_Agent_Session_Logs/2026-06-05-continue-memory-index-tier-3-hybrid-embedding-search|2026-06-05-continue-memory-index-tier-3-hybrid-embedding-search.md]]
- [[05_Agent_Session_Logs/2026-06-05-answer-compact-memory-behavior-in-project-memory-mcp|2026-06-05-answer-compact-memory-behavior-in-project-memory-mcp.md]]
- [[05_Agent_Session_Logs/2026-06-05-answer-claude-code-integration-status|2026-06-05-answer-claude-code-integration-status.md]]
- [[05_Agent_Session_Logs/2026-06-05-recommend-next-project-memory-mcp-improvements|2026-06-05-recommend-next-project-memory-mcp-improvements.md]]
- [[05_Agent_Session_Logs/2026-06-05-implement-mcp-doctor-client-diagnostics-v2|2026-06-05-implement-mcp-doctor-client-diagnostics-v2.md]]
- [[05_Agent_Session_Logs/2026-06-05-add-mcp-doctor-remediation-suggestions|2026-06-05-add-mcp-doctor-remediation-suggestions.md]]
- [[05_Agent_Session_Logs/2026-06-05-recommend-next-project-memory-mcp-roadmap-step|2026-06-05-recommend-next-project-memory-mcp-roadmap-step.md]]
- [[05_Agent_Session_Logs/2026-06-05-runtime-verification-strict-review-and-commit-preparation-for-tier-3-embeddings-mcp-doctor|2026-06-05-runtime-verification-strict-review-and-commit-preparation-for-tier-3-embeddings-mcp-doctor.md]]
- [[05_Agent_Session_Logs/2026-06-04-review-harden-and-ship-memory-index-tier-2-backlink-graph-section-anchors-via-pr-6|2026-06-04-review-harden-and-ship-memory-index-tier-2-backlink-graph-section-anchors-via-pr-6.md]]
- [[05_Agent_Session_Logs/2026-06-03-add-claude-md-onboarding-guide-for-claude-code|2026-06-03-add-claude-md-onboarding-guide-for-claude-code.md]]
- [[05_Agent_Session_Logs/2026-06-03-add-full-auto-project-memory-operating-protocol-directive-to-claude-md|2026-06-03-add-full-auto-project-memory-operating-protocol-directive-to-claude-md.md]]
- [[05_Agent_Session_Logs/2026-06-03-analyze-memory-index-retrieval-and-propose-efficiency-roadmap-tier-1-3|2026-06-03-analyze-memory-index-retrieval-and-propose-efficiency-roadmap-tier-1-3.md]]
- [[05_Agent_Session_Logs/2026-06-03-audit-memory-vault-frontmatter-system-vs-15-section-thai-prompt-survey-gap-risk-no-code-edits|2026-06-03-audit-memory-vault-frontmatter-system-vs-15-section-thai-prompt-survey-gap-risk-no-code-edits.md]]
- [[05_Agent_Session_Logs/2026-06-03-implement-steps-1-6-frontmatter-safety-hardening-fix-gray-matter-cache-non-idempotency|2026-06-03-implement-steps-1-6-frontmatter-safety-hardening-fix-gray-matter-cache-non-idempotency.md]]
- [[05_Agent_Session_Logs/2026-06-03-implement-tier-1-memory-index-incremental-persistent-index-bm25-ranked-search|2026-06-03-implement-tier-1-memory-index-incremental-persistent-index-bm25-ranked-search.md]]
- [[05_Agent_Session_Logs/2026-06-03-make-rollback-reversible-snapshot-before-restore-scope-latestbackupdir-to-fix-migrate-backups|2026-06-03-make-rollback-reversible-snapshot-before-restore-scope-latestbackupdir-to-fix-migrate-backups.md]]
- [[05_Agent_Session_Logs/2026-06-03-post-merge-cleanup-fix-claude-md-dist-claim-delete-merged-branch-sync-local-main|2026-06-03-post-merge-cleanup-fix-claude-md-dist-claim-delete-merged-branch-sync-local-main.md]]
- [[05_Agent_Session_Logs/2026-06-03-step-7-frontmatter-enhancements-versioned-migration-central-codes-diagnostic-line-numbers-vault-containment|2026-06-03-step-7-frontmatter-enhancements-versioned-migration-central-codes-diagnostic-line-numbers-vault-containment.md]]
- [[05_Agent_Session_Logs/2026-06-02-memory-vault-full-refactor|2026-06-02-memory-vault-full-refactor.md]]
- [[05_Agent_Session_Logs/2026-06-01-add-project-local-frontmatter-config-json-schema-and-verify-reusable-init-flow|2026-06-01-add-project-local-frontmatter-config-json-schema-and-verify-reusable-init-flow.md]]
- [[05_Agent_Session_Logs/2026-06-01-close-prompt-checklist-gaps-cli-safe-unsafe-confirm-migrate-rollback-validfiles-report-count-and-missing-tests-unknown-fields-config-fallback-override|2026-06-01-close-prompt-checklist-gaps-cli-safe-unsafe-confirm-migrate-rollback-validfiles-report-count-and-missing-tests-unknown-fields-config-fallback-override.md]]
- [[05_Agent_Session_Logs/2026-06-01-confirm-runtime-mcp-blocker-for-frontmatter-completion|2026-06-01-confirm-runtime-mcp-blocker-for-frontmatter-completion.md]]
- [[05_Agent_Session_Logs/2026-06-01-document-runtime-refresh-workflow-for-stale-project-memory-mcp-frontmatter-diagnostics|2026-06-01-document-runtime-refresh-workflow-for-stale-project-memory-mcp-frontmatter-diagnostics.md]]
- [[05_Agent_Session_Logs/2026-06-01-harden-frontmatter-warning-system-and-safety-defaults|2026-06-01-harden-frontmatter-warning-system-and-safety-defaults.md]]
- [[05_Agent_Session_Logs/2026-06-01-implement-option-c-hybrid-frontmatter-system-for-project-memory-mcp-safe-parser-schema-fix-migrate-report-cli-mcp-tools-tests|2026-06-01-implement-option-c-hybrid-frontmatter-system-for-project-memory-mcp-safe-parser-schema-fix-migrate-report-cli-mcp-tools-tests.md]]
