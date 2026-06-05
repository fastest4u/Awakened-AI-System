---
title: Adopt Option C Hybrid Frontmatter Standard with Safe Never-Throw Parser
type: adr
status: accepted
confidence: high
decision-date: "2026-06-01"
supersedes: []
tags:
  - frontmatter
  - schema
  - vault-health
  - parsing
  - stability
  - mcp
created: "2026-06-01"
updated: "2026-06-01"
---

## Context
project-memory MCP calls gray-matter matter() without try/catch in vault.service.load, vault.repository.readAllNotes, and memory-query.snapshotIndex/get, so one malformed YAML file crashes the whole retrieval surface (search/recent/get/contextPack/sessionStart). vault-health.readNotes catches errors but collapses every YAML error into a generic MISSING_FRONTMATTER warning; VaultIssue severity is only error|warning. The 136-file vault is machine-generated, scores 88/B with 0 warnings, so any schema standard must stay backward compatible. A prior 2026-06-01 session parked on a user decision A/B/C; user selected C (full build) on 2026-06-01.

## Decision
Adopt Option C hybrid: canonical keys stay kebab-case (matching the existing vault) but a data-driven alias map accepts snake_case/camelCase (created_at -> created, last_verified -> last-verified) and canonicalizes on read/write. Date fields normalize to YYYY-MM-DD strings to stop gray-matter coercing unquoted ISO dates into Date objects. Introduce one never-throw parseFrontmatter() in src/utils/frontmatter.ts returning {data, body, diagnostics, hasFrontmatter}; route all read paths through it to isolate malformed files per-note. Extend VaultIssue with info|critical and split MISSING_FRONTMATTER from UNPARSEABLE_FRONTMATTER with line numbers, codes, suggestions, autoFixAvailable. Add safe auto-fix with timestamped backups under .memory-mcp/backups, migration with dry-run first, report in text/json/markdown, optional project/global config with fallback, and expose both MCP tools and a thin CLI sharing one FrontmatterService.

## Consequences
- Backward compatible: existing kebab-case notes remain valid, no forced migration
- One malformed YAML file can no longer crash search or session bootstrap
- Richer diagnostics improve DX but callers must handle new severities
- New surface area (services, MCP tools, CLI, config) adds maintenance and test burden
- Date normalization changes in-memory values Date -> string, improving search/sort consistency
