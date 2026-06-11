---
title: "Frontmatter Parsing in project-memory: gray-matter Crash Surface and Verified Behavior Matrix"
type: insight
status: active
confidence: high
derived-from:
  - src/services/vault.service.ts
  - src/services/vault-health.service.ts
  - src/services/memory-query.service.ts
  - src/repositories/vault.repository.ts
  - src/utils/memory-format.ts
  - gray-matter@4.0.3 probe 2026-06-01
tags:
  - memory-vault
  - frontmatter
  - gray-matter
  - parsing
  - stability
  - yaml
created: "2026-06-01"
updated: "2026-06-01"
---

Empirically verified against the installed gray-matter@4.0.3 (probe run 2026-06-01).

## gray-matter behavior (ground truth)
THROWS YAMLException on: unclosed `---` block, duplicate mapping keys, unquoted colon in value (`title: foo: bar`), bad indentation.
Parses OK (no throw) on: missing frontmatter (data={}), empty frontmatter `---\n---` (data={}), frontmatter NOT at file start / leading blank line (data={} BUT body still starts with `---` -> silently skipped), CRLF, BOM (stripped), unquoted ISO date (returns a JS Date object, not string), inline arrays. Multiple frontmatter blocks: only the FIRST is read; the rest become body.

## Core defect (critical, project-agnostic)
matter() is called WITHOUT try/catch in three read paths:
- src/services/vault.service.ts load() (lines ~36-40)
- src/repositories/vault.repository.ts readAllNotes() (lines ~22-28)
- src/services/memory-query.service.ts snapshotIndex()+get() (lines ~8-29, 50-62)
snapshotIndex() loads EVERY .md and backs memory_search / memory_recent / memory_get / memory_contextPack / memory_sessionStart. Therefore a SINGLE malformed YAML file (unclosed/dupkey/colon/indent) throws an uncaught YAMLException that breaks the entire retrieval surface incl. session bootstrap.

In contrast, src/services/vault-health.service.ts readNotes() (lines ~142-166) catches the throw and collapses it to frontmatter:null, which is then reported identically to genuinely-missing frontmatter as a single MISSING_FRONTMATTER warning -> misdiagnosis (a YAML syntax error looks like "no frontmatter"). VaultIssue severity is only error|warning (no info|critical).

## Recommendation
Introduce one safe parseFrontmatter() (wraps matter in try/catch, pre-checks raw delimiters for unclosed/leading-blank/multiple-block/empty, returns {data, body, diagnostics[]} and never throws). Route all read paths through it to isolate bad files per-note. Centralize schema as data with field aliases (created_at->created) + date normalization (quote ISO to avoid Date coercion). Add info|critical severities. Current vault scores 88/B with 0 warnings ONLY because all files are machine-generated and clean.
