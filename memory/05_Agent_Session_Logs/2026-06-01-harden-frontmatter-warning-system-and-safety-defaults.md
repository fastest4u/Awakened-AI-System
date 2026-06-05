---
title: "2026-06-01 - Harden frontmatter warning system and safety defaults"
type: session-log
session-date: "2026-06-01"
agent: codex
duration-minutes: 55
outcomes:
  - "Added semantic exemption for 99_Templates/** in FrontmatterService so template placeholders no longer produce false INVALID_DATE_FORMAT warnings while structural parse diagnostics remain reportable."
  - "Made FrontmatterService fix(), migrate(), and rollback() dry-run by default at the service boundary, matching CLI/MCP safety expectations."
  - Hardened frontmatter config loading so invalid global/project config shapes are ignored with reported errors instead of poisoning the merged schema.
  - "Added regression coverage for template placeholder warnings, service dry-run defaults, invalid config shapes, and repository backup-scan behavior."
  - "Updated docs/frontmatter-system-th.md with template exemption, safety defaults, defensive config handling, and current test count."
created: "2026-06-01"
updated: "2026-06-01"
tags:
  - session-log
  - project/general
---
# 2026-06-01 - Harden frontmatter warning system and safety defaults

## TL;DR
- Added semantic exemption for 99_Templates/** in FrontmatterService so template placeholders no longer produce false INVALID_DATE_FORMAT warnings while structural parse diagnostics remain reportable.
- Made FrontmatterService fix(), migrate(), and rollback() dry-run by default at the service boundary, matching CLI/MCP safety expectations.
- Hardened frontmatter config loading so invalid global/project config shapes are ignored with reported errors instead of poisoning the merged schema.
- Added regression coverage for template placeholder warnings, service dry-run defaults, invalid config shapes, and repository backup-scan behavior.
- Updated docs/frontmatter-system-th.md with template exemption, safety defaults, defensive config handling, and current test count.

## Goal
Harden frontmatter warning system and safety defaults

## What Was Done
- Added semantic exemption for 99_Templates/** in FrontmatterService so template placeholders no longer produce false INVALID_DATE_FORMAT warnings while structural parse diagnostics remain reportable.
- Made FrontmatterService fix(), migrate(), and rollback() dry-run by default at the service boundary, matching CLI/MCP safety expectations.
- Hardened frontmatter config loading so invalid global/project config shapes are ignored with reported errors instead of poisoning the merged schema.
- Added regression coverage for template placeholder warnings, service dry-run defaults, invalid config shapes, and repository backup-scan behavior.
- Updated docs/frontmatter-system-th.md with template exemption, safety defaults, defensive config handling, and current test count.

## Files Touched
- src/services/frontmatter.service.ts
- src/config/frontmatter.config.ts
- tests/frontmatter.service.test.ts
- tests/frontmatter.config.test.ts
- tests/vault.repository.test.ts
- docs/frontmatter-system-th.md
- dist/index.js
- dist/cli.js

## Decisions Made
- Treat 99_Templates/** as semantically exempt from validation/fix/migrate because placeholders are not actual note metadata; keep structural YAML parse diagnostics active.
- Keep legacy unquoted dates as info-level auto-fixable diagnostics rather than warnings, so vault health and validation are warning-clean without mutating live notes.
- Do not mass-apply date quoting to the live memory vault in this turn; verify dry-run behavior and leave apply as an explicit follow-up.

## Open Follow-ups
- [ ] Restart the project-memory MCP server / IDE session so memory_validateFrontmatter uses the rebuilt dist/index.js; the currently running MCP process still reports the old 2 template warnings for direct tool calls.
- [ ] Optional live-vault cleanup remains: run node dist/cli.js fix --apply or memory_fixFrontmatter after restart to quote legacy date fields if the project wants to remove the 380 info diagnostics; dry-run shows 134 files would change.
- [ ] Run strict review before committing because the worktree contains substantial uncommitted source, docs, tests, and memory notes from this broader frontmatter implementation.

## References
- memory/04_Architecture_Decisions/adopt-option-c-hybrid-frontmatter-standard-with-safe-never-throw-parser.md
- docs/frontmatter-system-th.md
- tests/frontmatter.service.test.ts
- tests/frontmatter.config.test.ts
- tests/vault.repository.test.ts

## Verification
npm test passed 110/110; npm run typecheck passed; npm run build passed and rebuilt dist/index.js + dist/cli.js; node dist/cli.js validate --format json on the real vault reports filesScanned=140, critical=0, error=0, warning=0, info=380, blockedFiles=0; node dist/cli.js validate --path 99_Templates/Template-Daily-Note.md reports 0 issues; node dist/cli.js fix dry-run reports dryRun=true, scanned=140, changed=134, manual=0; memory_verifyVault reports score=88/B with 0 critical, 0 errors, 0 warnings.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| The rebuilt CLI validation no longer reports template placeholder warnings. | high | node dist/cli.js validate --path 99_Templates/Template-Daily-Note.md returned 0 critical, 0 errors, 0 warnings, 0 info. | Template placeholders should be handled as a semantic exemption, not by trying to coerce placeholder dates into the normal date schema. |
| The running MCP frontmatter tool reflects the rebuilt behavior immediately after build. | low | Direct memory_validateFrontmatter still reports 2 template warnings because the active MCP server process is stale and must be restarted. | Building dist is necessary but not sufficient for active MCP tools; runtime restart is a separate verification step. |
