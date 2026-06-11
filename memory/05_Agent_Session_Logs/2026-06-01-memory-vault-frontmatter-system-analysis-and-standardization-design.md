---
title: "2026-06-01 - Memory Vault frontmatter system analysis and standardization design"
type: session-log
agent: cascade
session-date: "2026-06-01"
duration-minutes: 25
outcomes:
  - "Mapped full architecture: config (project-agnostic workspace detection), schemas (zod for tool inputs only), utils/memory-format (format source-of-truth), repositories, services, controllers, app composition root"
  - "Verified gray-matter@4.0.3 behavior empirically via probe: unclosed/duplicate-key/unquoted-colon/bad-indentation THROW; missing/empty/leading-blank/CRLF/BOM parse OK; ISO dates coerce to Date objects; only first frontmatter block is read"
  - "Identified CRITICAL defect: matter() called without try/catch in vault.service.load, vault.repository.readAllNotes, and memory-query.snapshotIndex -> one malformed file crashes search/recent/get/contextPack/sessionStart"
  - "Identified misdiagnosis: vault-health.readNotes swallows parse errors into frontmatter:null reported as generic MISSING_FRONTMATTER warning; severity model lacks info|critical"
  - "Designed project-agnostic standard: single safe parseFrontmatter() returning {data,body,diagnostics}, central data-driven schema with field aliases + date normalization, severity taxonomy info|warning|error|critical"
tags:
  - session-log
  - project/general
created: "2026-06-01"
updated: "2026-06-01"
---

# 2026-06-01 - Memory Vault frontmatter system analysis and standardization design

## TL;DR
- Mapped full architecture: config (project-agnostic workspace detection), schemas (zod for tool inputs only), utils/memory-format (format source-of-truth), repositories, services, controllers, app composition root
- Verified gray-matter@4.0.3 behavior empirically via probe: unclosed/duplicate-key/unquoted-colon/bad-indentation THROW; missing/empty/leading-blank/CRLF/BOM parse OK; ISO dates coerce to Date objects; only first frontmatter block is read
- Identified CRITICAL defect: matter() called without try/catch in vault.service.load, vault.repository.readAllNotes, and memory-query.snapshotIndex -> one malformed file crashes search/recent/get/contextPack/sessionStart
- Identified misdiagnosis: vault-health.readNotes swallows parse errors into frontmatter:null reported as generic MISSING_FRONTMATTER warning; severity model lacks info|critical
- Designed project-agnostic standard: single safe parseFrontmatter() returning {data,body,diagnostics}, central data-driven schema with field aliases + date normalization, severity taxonomy info|warning|error|critical

## Goal
Memory Vault frontmatter system analysis and standardization design

## What Was Done
- Mapped full architecture: config (project-agnostic workspace detection), schemas (zod for tool inputs only), utils/memory-format (format source-of-truth), repositories, services, controllers, app composition root
- Verified gray-matter@4.0.3 behavior empirically via probe: unclosed/duplicate-key/unquoted-colon/bad-indentation THROW; missing/empty/leading-blank/CRLF/BOM parse OK; ISO dates coerce to Date objects; only first frontmatter block is read
- Identified CRITICAL defect: matter() called without try/catch in vault.service.load, vault.repository.readAllNotes, and memory-query.snapshotIndex -> one malformed file crashes search/recent/get/contextPack/sessionStart
- Identified misdiagnosis: vault-health.readNotes swallows parse errors into frontmatter:null reported as generic MISSING_FRONTMATTER warning; severity model lacks info|critical
- Designed project-agnostic standard: single safe parseFrontmatter() returning {data,body,diagnostics}, central data-driven schema with field aliases + date normalization, severity taxonomy info|warning|error|critical

## Files Touched
- 07_Insights/frontmatter-parsing-in-project-memory-gray-matter-crash-surface-and-verified-behavior-matrix.md

## Decisions Made
- Recommend Hybrid normalization (Option C): central schema accepts both kebab/snake-case field names, canonicalizes on read/write via alias map, preserving backward compatibility with the existing 134-file vault while adding status/priority/source/project optional fields

## Open Follow-ups
- [ ] AWAITING USER DECISION: choose naming/back-compat strategy A (keep current kebab canonical), B (migrate to snake_case), or C (hybrid normalization, recommended) before implementing
- [ ] Implement utils/frontmatter.ts parseFrontmatter() wrapping matter() in try/catch + raw-delimiter pre-checks (unclosed/leading-blank/multiple-block/empty), returning diagnostics and never throwing
- [ ] Route vault.service.load, vault.repository.readAllNotes, memory-query.snapshotIndex/get through parseFrontmatter to isolate malformed files per-note
- [ ] Add info|critical severities to VaultIssue and split MISSING_FRONTMATTER from UNPARSEABLE_FRONTMATTER (with line numbers)
- [ ] Centralize schema as data with field aliases + ISO date quoting/normalization; add regression tests in tests/
- [ ] Write ADR for the chosen frontmatter standard once user selects A/B/C

## References
- src/services/vault.service.ts
- src/services/vault-health.service.ts
- src/services/memory-query.service.ts
- src/repositories/vault.repository.ts
- src/utils/memory-format.ts
- src/config/memory.config.ts
- 07_Insights/frontmatter-parsing-in-project-memory-gray-matter-crash-surface-and-verified-behavior-matrix.md

## Verification
Empirically verified gray-matter@4.0.3 edge-case behavior via temp probe (exit 0, all 13 cases observed). Confirmed missing try/catch by reading the three read-path source files directly. memory_verifyVault baseline: score 88/B, 0 errors, 0 warnings (all files machine-generated).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
