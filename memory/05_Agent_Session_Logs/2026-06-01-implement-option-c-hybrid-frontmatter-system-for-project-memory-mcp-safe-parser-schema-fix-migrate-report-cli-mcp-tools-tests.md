---
title: "2026-06-01 - Implement Option C hybrid frontmatter system for project-memory MCP (safe parser, schema, fix/migrate/report, CLI + MCP tools, tests)"
type: session-log
agent: cascade
session-date: "2026-06-01"
duration-minutes: 90
outcomes:
  - "Fixed critical crash: parseFrontmatter() never throws; routed vault.service/vault.repository/vault-health read paths through it so one malformed YAML file can no longer break search/recent/get/contextPack/sessionStart"
  - "Upgraded vault-health diagnostics: added info|critical severities, split MISSING vs UNPARSEABLE frontmatter with line numbers/suggestions/autoFix flags, critical-aware scoring; info excluded so the 88/B score is preserved"
  - "Built Option C hybrid schema (alias map + ISO date normalization) in frontmatter-schema.ts; generator now quotes dates via shared yamlScalar"
  - "Added FrontmatterService (validate/fix/migrate/report) with safe-only auto-fix, timestamped backups under .memory-mcp/backups, and never rewriting unparseable files"
  - "Added optional global+project config with fallback, 3 MCP tools (validate/fix/migrate, dryRun default true), and a thin CLI (memory-vault) with a second esbuild bundle + bin"
  - "Verified: typecheck clean, 95 tests pass (40 new), build OK, CLI on real 137-file vault = 0 errors/0 critical/2 template warnings/380 auto-fixable info, 0 blocked"
tags:
  - session-log
  - project/general
created: "2026-06-01"
updated: "2026-06-01"
---

# 2026-06-01 - Implement Option C hybrid frontmatter system for project-memory MCP (safe parser, schema, fix/migrate/report, CLI + MCP tools, tests)

## TL;DR
- Fixed critical crash: parseFrontmatter() never throws; routed vault.service/vault.repository/vault-health read paths through it so one malformed YAML file can no longer break search/recent/get/contextPack/sessionStart
- Upgraded vault-health diagnostics: added info|critical severities, split MISSING vs UNPARSEABLE frontmatter with line numbers/suggestions/autoFix flags, critical-aware scoring; info excluded so the 88/B score is preserved
- Built Option C hybrid schema (alias map + ISO date normalization) in frontmatter-schema.ts; generator now quotes dates via shared yamlScalar
- Added FrontmatterService (validate/fix/migrate/report) with safe-only auto-fix, timestamped backups under .memory-mcp/backups, and never rewriting unparseable files
- Added optional global+project config with fallback, 3 MCP tools (validate/fix/migrate, dryRun default true), and a thin CLI (memory-vault) with a second esbuild bundle + bin
- Verified: typecheck clean, 95 tests pass (40 new), build OK, CLI on real 137-file vault = 0 errors/0 critical/2 template warnings/380 auto-fixable info, 0 blocked

## Goal
Implement Option C hybrid frontmatter system for project-memory MCP (safe parser, schema, fix/migrate/report, CLI + MCP tools, tests)

## What Was Done
- Fixed critical crash: parseFrontmatter() never throws; routed vault.service/vault.repository/vault-health read paths through it so one malformed YAML file can no longer break search/recent/get/contextPack/sessionStart
- Upgraded vault-health diagnostics: added info|critical severities, split MISSING vs UNPARSEABLE frontmatter with line numbers/suggestions/autoFix flags, critical-aware scoring; info excluded so the 88/B score is preserved
- Built Option C hybrid schema (alias map + ISO date normalization) in frontmatter-schema.ts; generator now quotes dates via shared yamlScalar
- Added FrontmatterService (validate/fix/migrate/report) with safe-only auto-fix, timestamped backups under .memory-mcp/backups, and never rewriting unparseable files
- Added optional global+project config with fallback, 3 MCP tools (validate/fix/migrate, dryRun default true), and a thin CLI (memory-vault) with a second esbuild bundle + bin
- Verified: typecheck clean, 95 tests pass (40 new), build OK, CLI on real 137-file vault = 0 errors/0 critical/2 template warnings/380 auto-fixable info, 0 blocked

## Files Touched
- src/utils/frontmatter.ts
- src/utils/frontmatter-schema.ts
- src/utils/memory-format.ts
- src/services/vault.service.ts
- src/repositories/vault.repository.ts
- src/services/vault-health.service.ts
- src/config/frontmatter.config.ts
- src/services/frontmatter.service.ts
- src/controllers/frontmatter.controller.ts
- src/schemas/memory.ts
- src/app.ts
- src/cli.ts
- scripts/build.js
- package.json
- tests/frontmatter.test.ts
- tests/frontmatter-schema.test.ts
- tests/frontmatter.service.test.ts
- docs/frontmatter-system-th.md

## Decisions Made
- Adopted Option C hybrid (kebab canonical + snake_case/camelCase aliases + ISO date normalization) per user choice; recorded in ADR
- verifyVault keeps info-level diagnostics out of the health gate to preserve backward-compatible scoring; new validate/report/fix tools surface all severities
- fix/migrate are dry-run by default, always back up, and refuse to rewrite critical/unparseable files
- Exposed functionality as both MCP tools and a CLI sharing one FrontmatterService; added .memory-mcp/** to listMarkdownFiles ignore so backups are not re-scanned

## Open Follow-ups
- [ ] AWAITING USER GO-AHEAD: run `memory-vault fix --apply` to quote ~380 legacy dates across ~135 live vault files (backed up automatically) — not run yet to avoid mutating the live vault without approval
- [ ] Restart the project-memory MCP server (rebuilt dist/index.js) so memory_verifyVault uses the new info|critical diagnostics
- [ ] Fix 2 INVALID_DATE_FORMAT warnings in 99_Templates/Template-Daily-Note.md (placeholder dates) if templates should validate clean
- [ ] Uncommitted source changes — route through /strict-pr-review-8-category before committing
- [ ] Prior design session follow-ups (parseFrontmatter routing, central schema, info|critical split, regression tests) are now all resolved

## References
- 04_Architecture_Decisions/adopt-option-c-hybrid-frontmatter-standard-with-safe-never-throw-parser.md
- 07_Insights/frontmatter-system-implementation-safe-parser-hybrid-schema-fix-migrate-report-cli.md
- 07_Insights/frontmatter-parsing-in-project-memory-gray-matter-crash-surface-and-verified-behavior-matrix.md
- 05_Agent_Session_Logs/2026-06-01-memory-vault-frontmatter-system-analysis-and-standardization-design.md
- docs/frontmatter-system-th.md

## Verification
typecheck (tsc --noEmit) exit 0; npm test = 95/95 pass incl 40 new frontmatter regression tests; npm run build OK (MCP bundle + CLI); node dist/cli.js validate on real 137-file vault: 0 errors, 0 critical, 2 warnings (templates), 380 info (auto-fixable), 0 blocked; memory_verifyVault (old running server) = 88/B, 0 errors, 0 warnings

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| parseFrontmatter never throws across all gray-matter failure modes | high | Verified by 40 regression tests + CLI run over 137 real files with 0 crashes | Pre-checking raw delimiters before calling gray-matter makes failure classification reliable |
| Changes preserve the existing 88/B vault health score | high | memory_verifyVault still 88/B, 0 warnings because info-level diagnostics are excluded from the gate | Separating advisory info from the scoring gate avoids breaking backward-compatible health metrics |
