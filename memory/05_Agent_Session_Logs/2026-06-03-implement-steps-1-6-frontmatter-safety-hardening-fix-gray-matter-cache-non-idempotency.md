---
title: "2026-06-03 - Implement Steps 1-6 frontmatter safety hardening + fix gray-matter cache non-idempotency"
type: session-log
session-date: "2026-06-03"
agent: claude-code
outcomes:
  - "Step 1: backups are now MANDATORY on any non-dry-run write in fix()/migrate() (the `backup` flag can no longer disable safety; CLI --no-backup warns and is ignored); NoteRepository.write backs up an existing differing note before overwriting and writes atomically (temp+rename)"
  - "Step 2: migrate() no longer fabricates frontmatter — a body-only note is now 'skipped' (was: invented title + created=today). Adding frontmatter stays in `fix` only"
  - "Step 3: buildNoteContent preserves body bytes (no longer strips leading spaces/tabs) and the note's dominant line ending (CRLF no longer silently downgraded to LF); parseFrontmatter now returns eol"
  - "Step 4: backups are verified (read-back equals original) before the destructive write, and all writes are atomic via temp-file+rename; rollback is per-file try/catch + atomic"
  - "Step 5: CLI sets exit code 1 on manual/blocked fix/migrate (CI-gateable), validates --format against text|json|markdown (exit 2 on bad value), warns on --no-backup, and renders migrate as human-readable text"
  - "Step 6: added/tightened tests (pin DUPLICATE_KEY/UNQUOTED_VALUE/BAD_INDENTATION codes, CRLF+indent preservation, migrate no-fabricate, mandatory backup, multiple-blocks->manual, NoteRepository overwrite backup) — 129/129 pass"
  - "BONUS correctness fix: gray-matter caches by input string, making parseFrontmatter non-idempotent for malformed YAML (2nd parse silently dropped the critical). Fixed with matter.clearCache() before each parse; also extended the YAML classifier to bucket 'incomplete explicit mapping pair' as UNQUOTED_VALUE"
  - "Verified: npm test 129/129 pass, tsc --noEmit clean, npm run build green, live CLI smoke (validate 151/151 clean, migrate dry-run renderer, --format xml rejected exit 2, --no-backup warning) — no live vault files mutated"
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - session-log
  - project/general
---
# 2026-06-03 - Implement Steps 1-6 frontmatter safety hardening + fix gray-matter cache non-idempotency

## TL;DR
- Step 1: backups are now MANDATORY on any non-dry-run write in fix()/migrate() (the `backup` flag can no longer disable safety; CLI --no-backup warns and is ignored); NoteRepository.write backs up an existing differing note before overwriting and writes atomically (temp+rename)
- Step 2: migrate() no longer fabricates frontmatter — a body-only note is now 'skipped' (was: invented title + created=today). Adding frontmatter stays in `fix` only
- Step 3: buildNoteContent preserves body bytes (no longer strips leading spaces/tabs) and the note's dominant line ending (CRLF no longer silently downgraded to LF); parseFrontmatter now returns eol
- Step 4: backups are verified (read-back equals original) before the destructive write, and all writes are atomic via temp-file+rename; rollback is per-file try/catch + atomic
- Step 5: CLI sets exit code 1 on manual/blocked fix/migrate (CI-gateable), validates --format against text|json|markdown (exit 2 on bad value), warns on --no-backup, and renders migrate as human-readable text
- Step 6: added/tightened tests (pin DUPLICATE_KEY/UNQUOTED_VALUE/BAD_INDENTATION codes, CRLF+indent preservation, migrate no-fabricate, mandatory backup, multiple-blocks->manual, NoteRepository overwrite backup) — 129/129 pass
- BONUS correctness fix: gray-matter caches by input string, making parseFrontmatter non-idempotent for malformed YAML (2nd parse silently dropped the critical). Fixed with matter.clearCache() before each parse; also extended the YAML classifier to bucket 'incomplete explicit mapping pair' as UNQUOTED_VALUE
- Verified: npm test 129/129 pass, tsc --noEmit clean, npm run build green, live CLI smoke (validate 151/151 clean, migrate dry-run renderer, --format xml rejected exit 2, --no-backup warning) — no live vault files mutated

## Goal
Implement Steps 1-6 frontmatter safety hardening + fix gray-matter cache non-idempotency

## What Was Done
- Step 1: backups are now MANDATORY on any non-dry-run write in fix()/migrate() (the `backup` flag can no longer disable safety; CLI --no-backup warns and is ignored); NoteRepository.write backs up an existing differing note before overwriting and writes atomically (temp+rename)
- Step 2: migrate() no longer fabricates frontmatter — a body-only note is now 'skipped' (was: invented title + created=today). Adding frontmatter stays in `fix` only
- Step 3: buildNoteContent preserves body bytes (no longer strips leading spaces/tabs) and the note's dominant line ending (CRLF no longer silently downgraded to LF); parseFrontmatter now returns eol
- Step 4: backups are verified (read-back equals original) before the destructive write, and all writes are atomic via temp-file+rename; rollback is per-file try/catch + atomic
- Step 5: CLI sets exit code 1 on manual/blocked fix/migrate (CI-gateable), validates --format against text|json|markdown (exit 2 on bad value), warns on --no-backup, and renders migrate as human-readable text
- Step 6: added/tightened tests (pin DUPLICATE_KEY/UNQUOTED_VALUE/BAD_INDENTATION codes, CRLF+indent preservation, migrate no-fabricate, mandatory backup, multiple-blocks->manual, NoteRepository overwrite backup) — 129/129 pass
- BONUS correctness fix: gray-matter caches by input string, making parseFrontmatter non-idempotent for malformed YAML (2nd parse silently dropped the critical). Fixed with matter.clearCache() before each parse; also extended the YAML classifier to bucket 'incomplete explicit mapping pair' as UNQUOTED_VALUE
- Verified: npm test 129/129 pass, tsc --noEmit clean, npm run build green, live CLI smoke (validate 151/151 clean, migrate dry-run renderer, --format xml rejected exit 2, --no-backup warning) — no live vault files mutated

## Files Touched
- src/utils/frontmatter.ts
- src/services/frontmatter.service.ts
- src/repositories/note.repository.ts
- src/cli.ts
- tests/frontmatter.test.ts
- tests/frontmatter.service.test.ts
- tests/note-write.test.ts

## Decisions Made
- Implemented sequentially (not via parallel workflow) because the 6 steps mutate overlapping files (frontmatter.service.ts, frontmatter.ts) and must be verified in order
- Made backup non-optional on writes rather than just warning, to fully satisfy the prompt's section-11 rule 'never overwrite memory without backup'
- Kept created=today fabrication in `fix` (the prompt sanctions 'add missing frontmatter / fill created_at' as a SAFE fix) but removed it from `migrate` (which should only stamp versions)
- Did NOT commit: git shows the entire frontmatter subsystem is still untracked from a prior session, and there is a pre-existing follow-up to route those changes through strict-pr-review before committing — committing now would sweep in unrelated uncommitted changes

## Open Follow-ups
- [ ] Decide how to commit: the frontmatter subsystem (frontmatter.ts/.service.ts/cli.ts/config + tests) is untracked from a prior session and entangled with other uncommitted src changes (app.ts, vault.service.ts, vault-health.service.ts, memory.config.ts) — needs a strict-pr-review pass before committing per the existing follow-up
- [ ] dist/ was rebuilt locally (obfuscated) to make the MCP runtime reflect the hardening; decide whether to commit the rebuilt bundle per the repo's commit-dist convention
- [ ] Step 7 (long-term, not done): versioned migration registry (from->to transforms), numeric schema-version comparison, central code/severity enum, line numbers on schema-layer diagnostics, vaultRoot subset-of projectRoot containment check
- [ ] Optional: snapshot-before-restore in rollback() (currently atomic+skip-on-error but still overwrites live edits without a pre-restore backup)

## References
- claude-code-memory-vault-prompt-th.md
- src/utils/frontmatter.ts
- src/services/frontmatter.service.ts
- src/cli.ts
- 07_Insights/gray-matter-caches-by-input-string-parsefrontmatter-was-non-idempotent-for-malformed-yaml-until-clearcache.md

## Verification
npm test => 129 pass / 0 fail (35 suites). tsc --noEmit clean. npm run build green (esbuild + obfuscator, dist rebuilt). Live CLI smoke on ./memory: validate 151/151 valid 0 issues; migrate dry-run text renderer shows would-migrate 143 manual 0; validate --format xml -> 'Invalid --format' exit 2; fix --apply --no-backup -> mandatory-backup warning. No live vault note was mutated (all dry-run/read-only).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
