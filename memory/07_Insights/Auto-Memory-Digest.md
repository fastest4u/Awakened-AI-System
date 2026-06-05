---
title: Auto Memory Digest
type: insight
derived-from:
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
  - 05_Agent_Session_Logs/2026-06-01-memory-vault-analysis-quality-gate-check.md
  - 05_Agent_Session_Logs/2026-06-01-memory-vault-frontmatter-system-analysis-and-standardization-design.md
  - 05_Agent_Session_Logs/2026-06-01-memory-vault-system-structure-analysis.md
  - 05_Agent_Session_Logs/2026-06-01-populate-empty-outcomes-in-2-stub-session-logs-to-clear-missing-required-field-errors.md
  - 05_Agent_Session_Logs/2026-06-01-re-verify-after-mcp-restart-99-templates-warnings-fix-confirmed-0-warnings.md
confidence: medium
status: active
created: "2026-06-05"
updated: "2026-06-05"
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-06-05

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- Completed opt-in Tier 3 hybrid search plumbing with MEMORY_EMBEDDINGS config, hash/http providers, vector cache signatures, RRF fusion, and lexical-only fallback.
- Added Thai/CJK character n-gram recall across index and section matching while preserving Latin/code token behavior.
- Hardened embedding refresh with bounded document batches and cooldown on endpoint errors or malformed provider responses.
- Documented embedding environment variables in README and recorded the Tier 3 retrieval ADR.
- Checked project docs and source for memory compaction/token-economy behavior.
- Confirmed project-memory MCP supports token-budgeted context packs, manual memory_compactVault, and sessionEnd autoCompact.
- Checked CLAUDE.md and .claude/settings.local.json for Claude Code integration status.
- Confirmed CLAUDE.md contains Full-Auto project-memory protocol and .claude/settings.local.json enables project-memory with core memory tool allowlist.
- Reviewed roadmap and follow-up context for project-memory MCP improvements.
- Prepared prioritized recommendation focused on runtime diagnostics, token economy, retrieval quality, multi-agent safety, and import/export completion.
- Extended memory_diagnoseWorkspace with an additive doctor section for project/vault/build checks and AI client MCP config diagnostics.
- Added read-only diagnostics for Claude Code, Codex, Cursor, Windsurf, Zed, OpenCode, and Antigravity local config files.
- Added machine-readable issue codes including VAULT_AGENT_RULES_MISSING, CLIENT_CONFIG_MISSING_PROJECT_MEMORY, CLIENT_CONFIG_PARSE_ERROR, and CLAUDE_MCP_SERVER_DEFINITION_NOT_LOCAL.
- Handled UTF-8 BOM-prefixed JSON client configs to avoid false parse-error warnings.
- Updated the maintenance tool description and README documentation for MCP Doctor output.
- Added optional doctor.issues[].remediation to MCP Doctor diagnostics with summary/path/snippet/command fields.
- Added client-specific project-memory config snippets for Codex TOML, Zed context_servers JSON, OpenCode JSON, and mcpServers JSON clients.
- Added remediation guidance for missing project root, missing vault, missing vault AGENTS.md, vault outside project, missing build info, client parse errors, missing project-memory client configs, missing Claude Code project-local .mcp.json, and no local client configs found.
- Updated README documentation for the remediation field.
- Verified built CLI diagnose now includes remediation for the Claude Code project-local .mcp.json info issue.
- Reviewed current roadmap/follow-up context after MCP Doctor and remediation work.
- Prepared recommendation to stabilize and verify the newly built MCP Doctor across real clients before starting another feature slice.
- Confirmed active project-memory MCP runtime is using this repo's dist/index.js and current build info; runtime frontmatter validation for 99_Templates/Template-Daily-Note.md is warning-clean.
- Strict-reviewed Tier 3 hybrid embedding search and MCP Doctor diagnostics/remediation before starting memory_export/import work.
- Found and fixed two Tier 3 review defects: vector arm cap was applied before folder/type/tag eligibility, and stale vectors could remain persisted after disabling/changing the embedder signature.
- Found and fixed one MCP Doctor review defect: inactive example configs could raise parse-error warnings or influence enabled-state inference.
- Added regression coverage for filtered vector recall, vector cache scrubbing, and inactive example parse errors.
- Committed implementation as a focused code/docs commit: a20cf48 feat: add hybrid embeddings and MCP doctor diagnostics.
- Shipped Tier 2 (backlink graph + section-anchor search) to main via PR #6, squash-merged as ac8a8b4.
- Ran a 6-dimension adversarial multi-agent review of the Tier 2 diff (25 agents); 17 findings confirmed (each independently verified), 2 rejected as correct-by-design.

## Decisions To Remember
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
- Documentation-only single-file change; selfCheck intentionally skipped per low-risk criteria
- Kept README's Thai-language note as the fullest tool-surface reference rather than duplicating it in CLAUDE.md
- Placed the protocol as an imperative directive at the top of CLAUDE.md (read first) rather than a descriptive note at the bottom, because Claude Code loads CLAUDE.md preferentially and needs the instruction early
- Kept AGENTS.md/.rules/ADR as the cited source of truth rather than restating every rule verbatim, to avoid drift
- Advisory/planning task: did not edit code; presented a tiered roadmap and will ask the user which tier to implement
- Keep everything local-first and feature-flag the embedding tier so the default stays zero-dependency (consistent with the vault's no-lock-in principle)
- Did NOT edit code this turn, per the prompt's section 15 (survey -> report -> propose plan first)
- Recovered workflow data from disk transcripts instead of re-running agents, to avoid re-hitting the session limit
- Spot-verified the two HIGH findings and the duplicate-key hypothesis myself rather than trusting agent output, because the findings are decision-heavy and one agent claim was plausibly wrong
- Implemented sequentially (not via parallel workflow) because the 6 steps mutate overlapping files (frontmatter.service.ts, frontmatter.ts) and must be verified in order
- Made backup non-optional on writes rather than just warning, to fully satisfy the prompt's section-11 rule 'never overwrite memory without backup'
- Kept created=today fabrication in `fix` (the prompt sanctions 'add missing frontmatter / fill created_at' as a SAFE fix) but removed it from `migrate` (which should only stamp versions)

## Open Follow-ups
- [ ] Review/commit the branch worktree separately; git status still contains broad pre-existing memory vault and AGENTS.md changes outside the Tier 3 implementation surface.
- [ ] Consider a PR for feat/memory-index-tier3-embeddings once the user is ready to ship.
- [ ] If user wants 100% Claude Code setup audit, inspect Claude Code global/project MCP server definition because this repo has .claude/settings.local.json but no root .mcp.json file visible in the workspace.
- [ ] Consider adding optional remediation suggestions to doctor.issues, such as the exact config path and snippet to add when a client config is missing project-memory.
- [ ] Implement memory_export and memory_import so README no longer lists them as placeholders.
- [ ] Add safe Doctor Auto-Repair as dry-run plan/apply flow, not automatic file mutation.
- [ ] Optionally add a project-local .mcp.json if this repo should be self-contained for Claude Code; current Doctor reports this as info-only because the server definition may live globally.
- [ ] Tier 3: optional embedding hybrid search (next memory-index roadmap slice).
- [ ] Backlink graph: duplicate-basename folder-aware resolution (Obsidian shortest-path) so a bare `dup` link in b/dup.md resolves to b's own folder rather than the lexicographically-first path — LOW, currently documented + deferred.
- [ ] Optional: add ADR recording the decision to commit obfuscated dist/ output, if not already captured
- [ ] Pre-existing: 99_Templates/Template-Daily-Note.md has 2 INVALID_DATE_FORMAT placeholder-date warnings (unrelated to this task)
- [ ] AWAITING USER DECISION: which index roadmap tier to implement first (recommended Tier 1: persistent incremental index + BM25 ranked search fused with usage scoreBoost)
- [ ] Consider writing an ADR for the index architecture direction once the tier is chosen
- [ ] Tier 1.1 persistent index should reuse the safe parseFrontmatter + handle add/modify/delete via mtime; Tier 1.2 should fold in MemoryUsageService.scoreBoost so ranking is unified across memory_search and contextPack
- [ ] Implement Step 1-2 (HIGH safety): make backup mandatory on non-dry-run writes (frontmatter.service.ts + note.service/repository); migrate() skip !hasFrontmatter notes and stop fabricating created=today
- [ ] Step 3-6: preserve body bytes/line-endings in buildNoteContent; verify+atomic backup; CLI exit codes + --format whitelist; tighten tests (pin DUPLICATE_KEY, add BAD_INDENTATION/INVALID_YAML/tab-indent fixtures) + MigrateSummary renderer
- [ ] Step 7 long-term: versioned migration registry, numeric schema-version compare, central code/severity enum, line numbers on schema-layer diagnostics, vaultRoot subset-of projectRoot check
- [ ] Decide how to commit: the frontmatter subsystem (frontmatter.ts/.service.ts/cli.ts/config + tests) is untracked from a prior session and entangled with other uncommitted src changes (app.ts, vault.service.ts, vault-health.service.ts, memory.config.ts) — needs a strict-pr-review pass before committing per the existing follow-up
- [ ] dist/ was rebuilt locally (obfuscated) to make the MCP runtime reflect the hardening; decide whether to commit the rebuilt bundle per the repo's commit-dist convention
- [ ] Step 7 (long-term, not done): versioned migration registry (from->to transforms), numeric schema-version comparison, central code/severity enum, line numbers on schema-layer diagnostics, vaultRoot subset-of projectRoot containment check
- [ ] Optional: snapshot-before-restore in rollback() (currently atomic+skip-on-error but still overwrites live edits without a pre-restore backup)
- [ ] Decide whether to open a PR for feat/incremental-bm25-index (Tier 1) and/or continue to Tier 2 (backlink graph + section-level chunks) / Tier 3 (optional embedding hybrid search)
- [ ] Recommend gitignoring .memory-mcp/index.json (derived cache, churns on edits) like dist/ — not done to avoid entangling with the already-dirty .gitignore
- [ ] Tier 2: real incomingLinks via a link graph built during indexing (the wikilink data is already cheap to capture); section-level chunk index returning section + line anchor
- [ ] AWAITING EXPLICIT USER CONFIRMATION to squash-merge PR #4 into main (auto-merge denied earlier; needs a clear go-ahead). PR now has 3 commits, 139 tests green, no P0-P3 blockers remaining
- [ ] The PR #4 squash (frontmatter system + Steps 1-6 + Step 7 + rollback) is now on main; 158 unrelated files remain uncommitted in the working tree (memory/ vault notes, README/AGENTS/CLAUDE.md/.gitignore) — the user's call when/whether to commit those
- [ ] Optional: commit CLAUDE.md (onboarding doc, currently untracked) if the project wants it in the repo
- [ ] Optional: add ADR recording that dist/ is a gitignored artifact (not committed), to prevent the confusion that produced the wrong CLAUDE.md line
- [ ] AWAITING EXPLICIT USER CONFIRMATION to squash-merge PR #4 into main (auto-merge was denied by the classifier; needs a clear go-ahead)
- [ ] Remaining minor: rollback() still overwrites live edits without a snapshot-before-restore (atomic + skip-on-error mitigate; LOW)

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
- tsc --noEmit clean; npm test 139 pass / 0 fail (37 suites); npm run build green. New test asserts rollback writes the edited content to snapshotDir and restores the original. No live vault note mutated.
- git diff --stat HEAD origin/main was empty before switching (trees identical). After: git branch --show-current=main, git log -1=88e1ea3, git rev-list --left-right --count origin/main...HEAD = 0 0, git status dirty count unchanged at 158. .gitignore confirmed dist/ is ignored.
- tsc --noEmit clean; npm test 138 pass / 0 fail (37 suites); npm run build green; live CLI smoke: `diagnose` -> vaultWithinProject:true, `migrate --vault ./memory` dry-run -> 145 would-migrate, 0 manual. No live vault note mutated. Changes committed (8486881) + pushed to origin PR #4.
- npm test passed (118 tests, 33 suites). npm run typecheck passed. npm run build passed and emitted dist/build-info.json. node dist\cli.js diagnose selected C:\Users\Server\Desktop\Awakened-AI-System from cwd and included build version metadata. node dist\cli.js validate --format json passed with 146/146 valid and zero diagnostics. memory_validateFrontmatter passed with 146/146 valid and zero info/warning/error/critical diagnostics. memory_verifyVault passed with score 88 grade B and 0 warnings/errors.
- npm test passed 111/111; npm run typecheck passed; npm run build passed; node dist/cli.js init --vault <temp> created both .memory-mcp/frontmatter.config.json and .memory-mcp/frontmatter.config.schema.json with ConfigSchema=./frontmatter.config.schema.json and SchemaTitle='Memory Vault frontmatter config'; node dist/cli.js validate --format json on the real vault reports critical=0,error=0,warning=0,info=380,blockedFiles=0; node dist/cli.js validate --path 99_Templates/Template-Daily-Note.md reports 0 issues; memory_verifyVault reports score=88/B with 0 critical, 0 errors, 0 warnings.

## Source Sessions
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
- [[05_Agent_Session_Logs/2026-06-01-memory-vault-analysis-quality-gate-check|2026-06-01-memory-vault-analysis-quality-gate-check.md]]
- [[05_Agent_Session_Logs/2026-06-01-memory-vault-frontmatter-system-analysis-and-standardization-design|2026-06-01-memory-vault-frontmatter-system-analysis-and-standardization-design.md]]
- [[05_Agent_Session_Logs/2026-06-01-memory-vault-system-structure-analysis|2026-06-01-memory-vault-system-structure-analysis.md]]
- [[05_Agent_Session_Logs/2026-06-01-populate-empty-outcomes-in-2-stub-session-logs-to-clear-missing-required-field-errors|2026-06-01-populate-empty-outcomes-in-2-stub-session-logs-to-clear-missing-required-field-errors.md]]
- [[05_Agent_Session_Logs/2026-06-01-re-verify-after-mcp-restart-99-templates-warnings-fix-confirmed-0-warnings|2026-06-01-re-verify-after-mcp-restart-99-templates-warnings-fix-confirmed-0-warnings.md]]
