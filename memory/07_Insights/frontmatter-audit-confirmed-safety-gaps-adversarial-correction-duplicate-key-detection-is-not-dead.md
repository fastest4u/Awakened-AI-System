---
title: "Frontmatter audit: confirmed safety gaps + adversarial correction (duplicate-key detection is NOT dead)"
type: insight
derived-from:
  - claude-code-memory-vault-prompt-th.md
  - src/services/frontmatter.service.ts
  - src/utils/frontmatter.ts
  - src/utils/frontmatter-schema.ts
confidence: high
status: active
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - frontmatter
  - audit
  - safety
  - backup
  - migration
  - gray-matter
---
Audit of the Memory Vault frontmatter system (2026-06-03) vs the 15-section Thai prompt. System is ~90% complete (Option C hybrid shipped); live runtime clean (149/149 valid, score 88/B). Confirmed gaps with file:line:

HIGH-1: backup is opt-out-able — `backup:false` / CLI `--no-backup` sets backupDir=null so fix/migrate --apply overwrite notes with NO recoverable copy (frontmatter.service.ts:165,177-178,221,235-236). Violates "never overwrite memory without backup".

HIGH-2: migrate() fabricates frontmatter. For a note with no frontmatter (fromVersion '0', not exempt) the guard at frontmatter.service.ts:231 passes, then computeRewrite lines 311-317 invent title (guessed from heading/filename), type, and created=today (a FALSE date) — even in safe (non-unsafe) mode. Violates "no guessed YAML edits". Fix: migrate() should skip !hasFrontmatter notes; keep frontmatter creation in `fix` only; never set created=today in migrate.

MED: NoteService.create(overwrite=true) overwrites with no backup (note.service.ts:7-10, note.repository.ts:8-13); buildNoteContent strips ALL leading body whitespace + rejoins as LF -> silent body + CRLF->LF mutation on every fix (utils/frontmatter.ts:252); backup written but never verified before overwrite.

ADVERSARIAL CORRECTION: a gap-agent hypothesized the FRONTMATTER_DUPLICATE_KEY branch (frontmatter.ts:166-175) is dead because gray-matter's default js-yaml supposedly doesn't throw on duplicates. EMPIRICALLY FALSE — probed installed gray-matter@4.0.3: duplicate keys THROW `duplicated mapping key`, unquoted-colon and bad-indent also THROW; only tab-indented mappings do NOT throw (silently mis-parse to wrong data). Duplicate-key detection works; the only weakness is the test asserts severity but does not pin the code. Lesson: adversarial verify plausible "dead code" claims against the real dependency before acting. Consistent with [[frontmatter-parsing-in-project-memory-gray-matter-crash-surface-and-verified-behavior-matrix]].
