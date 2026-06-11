---
title: "Frontmatter System Implementation: Safe Parser, Hybrid Schema, Fix/Migrate/Report + CLI"
type: insight
status: active
confidence: high
derived-from:
  - src/utils/frontmatter.ts
  - src/utils/frontmatter-schema.ts
  - src/services/frontmatter.service.ts
  - src/config/frontmatter.config.ts
  - src/services/vault-health.service.ts
  - src/cli.ts
  - 04_Architecture_Decisions/adopt-option-c-hybrid-frontmatter-standard-with-safe-never-throw-parser.md
tags:
  - frontmatter
  - schema
  - vault-health
  - parsing
  - cli
  - mcp
  - implementation
created: "2026-06-01"
updated: "2026-06-01"
---

Implemented the Option C hybrid frontmatter system for the project-memory MCP (TypeScript, ESM).

Core (Phase 1-2):
- src/utils/frontmatter.ts: parseFrontmatter() never throws — pre-checks raw delimiters (BOM, leading-blank, unclosed, empty, multiple-block) and wraps gray-matter in try/catch, classifying YAMLException into FRONTMATTER_UNCLOSED/DUPLICATE_KEY/UNQUOTED_VALUE/BAD_INDENTATION/INVALID_YAML with line numbers. Also added yamlScalar (quotes dates+colons), serializeFrontmatter, buildNoteContent.
- Routed all read paths through it: vault.service.load (returns {raw, parsed:{data,content}, diagnostics, hasFrontmatter} + new readRaw()), vault.repository.readAllNotes, vault-health.readNotes. memory-query/follow-up get the crash fix for free via vault.load.
- VaultIssue gained info|critical severities + line/field/suggestion/autoFixAvailable; split MISSING_FRONTMATTER from UNPARSEABLE; scoring deducts critical*10/error*6/warning*2; info excluded from verifyVault to preserve the 88/B score.

Schema (Phase 4): src/utils/frontmatter-schema.ts — data-driven schema (alias map kebab canonical, date fields, key order), canonicalizeFrontmatter (alias resolve + Date->YYYY-MM-DD + tags string->array), validateFrontmatter, mergeFrontmatterSchema. memory-format.frontmatter() now uses shared yamlScalar so generated dates are quoted.

Phase 5: src/config/frontmatter.config.ts (global ~/.memory-vault + project .memory-mcp, optional, fallback). src/services/frontmatter.service.ts (validate/fix/migrate/report; safe fixes only; timestamped backups under .memory-mcp/backups; never rewrites critical files). MCP tools memory_validateFrontmatter/fixFrontmatter/migrateFrontmatter (dryRun default true). CLI src/cli.ts (validate/report/fix/migrate/init) + bin memory-vault + second esbuild bundle. Added .memory-mcp/** to listMarkdownFiles ignore.

Verification: typecheck clean; 95 tests pass (40 new); build OK; CLI on real 137-file vault = 0 errors/0 critical/2 warnings (template placeholders)/380 info DATE_NORMALIZED (legacy unquoted dates, auto-fixable), 0 blocked. memory_verifyVault (old running server) still 88/B. New diagnostics activate after MCP rebuild+restart.

Key lesson: the existing vault has ~380 unquoted-date fields that gray-matter coerces to Date; the fix is opt-in (dry-run default) and would rewrite ~135 files quoting dates — requires explicit user go-ahead before mutating the live vault.
