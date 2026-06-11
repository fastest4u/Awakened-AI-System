---
title: "2026-06-01 - Add project-local frontmatter config JSON schema and verify reusable init flow"
type: session-log
session-date: "2026-06-01"
agent: codex
duration-minutes: 20
outcomes:
  - Added a real local JSON Schema generator for frontmatter project config instead of the previous placeholder example.com schema URL.
  - Updated memory-vault init to write both .memory-mcp/frontmatter.config.json and .memory-mcp/frontmatter.config.schema.json for any target vault.
  - Added docs/frontmatter.config.schema.json and documented the generated project schema path in docs/frontmatter-system-th.md.
  - Added regression coverage proving sampleProjectConfig references ./frontmatter.config.schema.json and sampleProjectConfigSchema exposes the expected config field shapes.
  - Verified memory-vault init --vault against a temporary vault creates both config and schema files with the expected schema reference/title.
created: "2026-06-01"
updated: "2026-06-01"
tags:
  - session-log
  - project/general
---
# 2026-06-01 - Add project-local frontmatter config JSON schema and verify reusable init flow

## TL;DR
- Added a real local JSON Schema generator for frontmatter project config instead of the previous placeholder example.com schema URL.
- Updated memory-vault init to write both .memory-mcp/frontmatter.config.json and .memory-mcp/frontmatter.config.schema.json for any target vault.
- Added docs/frontmatter.config.schema.json and documented the generated project schema path in docs/frontmatter-system-th.md.
- Added regression coverage proving sampleProjectConfig references ./frontmatter.config.schema.json and sampleProjectConfigSchema exposes the expected config field shapes.
- Verified memory-vault init --vault against a temporary vault creates both config and schema files with the expected schema reference/title.

## Goal
Add project-local frontmatter config JSON schema and verify reusable init flow

## What Was Done
- Added a real local JSON Schema generator for frontmatter project config instead of the previous placeholder example.com schema URL.
- Updated memory-vault init to write both .memory-mcp/frontmatter.config.json and .memory-mcp/frontmatter.config.schema.json for any target vault.
- Added docs/frontmatter.config.schema.json and documented the generated project schema path in docs/frontmatter-system-th.md.
- Added regression coverage proving sampleProjectConfig references ./frontmatter.config.schema.json and sampleProjectConfigSchema exposes the expected config field shapes.
- Verified memory-vault init --vault against a temporary vault creates both config and schema files with the expected schema reference/title.

## Files Touched
- src/config/frontmatter.config.ts
- src/cli.ts
- tests/frontmatter.config.test.ts
- docs/frontmatter-system-th.md
- docs/frontmatter.config.schema.json
- dist/index.js
- dist/cli.js

## Decisions Made
- Use a local relative $schema path (./frontmatter.config.schema.json) so generated configs work in arbitrary projects without relying on a fake remote URL.
- Keep the JSON Schema strict with additionalProperties=false for editor feedback while runtime config loading remains defensive and ignores invalid shapes non-fatally.
- Do not mark the overall goal complete yet because the active project-memory MCP process still needs restart before direct memory_validateFrontmatter reflects the rebuilt dist bundle.

## Open Follow-ups
- [ ] Restart the project-memory MCP server / IDE session so direct memory_validateFrontmatter uses the rebuilt dist/index.js; current running MCP process still reports the old 2 template placeholder warnings.
- [ ] Optional live-vault canonicalization remains: run node dist/cli.js fix --apply after deciding to quote legacy date fields; dry-run currently shows 134 files would change and 380 info diagnostics would be normalized.
- [ ] Run strict review before committing because the worktree contains broad uncommitted source, docs, test, dist, and memory-note changes from the frontmatter implementation.

## References
- docs/frontmatter-system-th.md
- docs/frontmatter.config.schema.json
- tests/frontmatter.config.test.ts
- src/config/frontmatter.config.ts
- src/cli.ts

## Verification
npm test passed 111/111; npm run typecheck passed; npm run build passed; node dist/cli.js init --vault <temp> created both .memory-mcp/frontmatter.config.json and .memory-mcp/frontmatter.config.schema.json with ConfigSchema=./frontmatter.config.schema.json and SchemaTitle='Memory Vault frontmatter config'; node dist/cli.js validate --format json on the real vault reports critical=0,error=0,warning=0,info=380,blockedFiles=0; node dist/cli.js validate --path 99_Templates/Template-Daily-Note.md reports 0 issues; memory_verifyVault reports score=88/B with 0 critical, 0 errors, 0 warnings.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Generated project configs now reference a real local JSON Schema artifact. | high | Unit test parses sampleProjectConfig/sampleProjectConfigSchema successfully, and CLI init temp-vault verification created both files with the expected $schema reference. | A local schema artifact is better for project-agnostic reuse than a placeholder remote URL. |
| The original full objective is complete. | low | Current code/CLI behavior is strong, but the active MCP process remains stale and direct memory_validateFrontmatter still reports old template warnings until restart. | Completion must include runtime evidence for the MCP process, not only rebuilt dist/CLI evidence. |
