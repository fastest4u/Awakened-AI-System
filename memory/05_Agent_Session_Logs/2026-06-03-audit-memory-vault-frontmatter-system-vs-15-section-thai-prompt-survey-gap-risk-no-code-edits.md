---
title: "2026-06-03 - Audit Memory Vault + frontmatter system vs 15-section Thai prompt (survey + gap + risk, no code edits)"
type: session-log
session-date: "2026-06-03"
agent: claude-code
outcomes:
  - "Ran a 15-agent workflow (degraded: synthesis hit session limit, 2 risk agents failed StructuredOutput) and recovered all structured results (7 readers, 4 gap groups, 1 risk) from subagent transcripts via a Node extraction script"
  - "Produced a Thai deliverable report per the prompt's section 12: structure, main issues, frontmatter-warning origin, checklist verdict (~50 items verified vs code), confirmed risks by severity, incremental plan, cautions, long-term items"
  - "Confirmed 2 HIGH safety gaps in code: (1) backup opt-out via backup:false/--no-backup overwrites notes with no recoverable copy; (2) migrate() fabricates frontmatter (guessed title + created=today) on notes without frontmatter even in safe mode (computeRewrite frontmatter.service.ts:311-317 reached from migrate:231)"
  - "Adversarially corrected a FALSE gap-agent claim: empirically probed gray-matter@4.0.3 and proved duplicate-key/unquoted-colon/bad-indent all THROW (detection works); only tab-indent silently mis-parses"
  - "Live ground truth: validateFrontmatter 149/149 valid 0 issues, verifyVault score 88/B; configSources=[] is expected (no project config file, built-in defaults)"
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - session-log
  - project/general
---
# 2026-06-03 - Audit Memory Vault + frontmatter system vs 15-section Thai prompt (survey + gap + risk, no code edits)

## TL;DR
- Ran a 15-agent workflow (degraded: synthesis hit session limit, 2 risk agents failed StructuredOutput) and recovered all structured results (7 readers, 4 gap groups, 1 risk) from subagent transcripts via a Node extraction script
- Produced a Thai deliverable report per the prompt's section 12: structure, main issues, frontmatter-warning origin, checklist verdict (~50 items verified vs code), confirmed risks by severity, incremental plan, cautions, long-term items
- Confirmed 2 HIGH safety gaps in code: (1) backup opt-out via backup:false/--no-backup overwrites notes with no recoverable copy; (2) migrate() fabricates frontmatter (guessed title + created=today) on notes without frontmatter even in safe mode (computeRewrite frontmatter.service.ts:311-317 reached from migrate:231)
- Adversarially corrected a FALSE gap-agent claim: empirically probed gray-matter@4.0.3 and proved duplicate-key/unquoted-colon/bad-indent all THROW (detection works); only tab-indent silently mis-parses
- Live ground truth: validateFrontmatter 149/149 valid 0 issues, verifyVault score 88/B; configSources=[] is expected (no project config file, built-in defaults)

## Goal
Audit Memory Vault + frontmatter system vs 15-section Thai prompt (survey + gap + risk, no code edits)

## What Was Done
- Ran a 15-agent workflow (degraded: synthesis hit session limit, 2 risk agents failed StructuredOutput) and recovered all structured results (7 readers, 4 gap groups, 1 risk) from subagent transcripts via a Node extraction script
- Produced a Thai deliverable report per the prompt's section 12: structure, main issues, frontmatter-warning origin, checklist verdict (~50 items verified vs code), confirmed risks by severity, incremental plan, cautions, long-term items
- Confirmed 2 HIGH safety gaps in code: (1) backup opt-out via backup:false/--no-backup overwrites notes with no recoverable copy; (2) migrate() fabricates frontmatter (guessed title + created=today) on notes without frontmatter even in safe mode (computeRewrite frontmatter.service.ts:311-317 reached from migrate:231)
- Adversarially corrected a FALSE gap-agent claim: empirically probed gray-matter@4.0.3 and proved duplicate-key/unquoted-colon/bad-indent all THROW (detection works); only tab-indent silently mis-parses
- Live ground truth: validateFrontmatter 149/149 valid 0 issues, verifyVault score 88/B; configSources=[] is expected (no project config file, built-in defaults)

## Files Touched
- None

## Decisions Made
- Did NOT edit code this turn, per the prompt's section 15 (survey -> report -> propose plan first)
- Recovered workflow data from disk transcripts instead of re-running agents, to avoid re-hitting the session limit
- Spot-verified the two HIGH findings and the duplicate-key hypothesis myself rather than trusting agent output, because the findings are decision-heavy and one agent claim was plausibly wrong

## Open Follow-ups
- [ ] Implement Step 1-2 (HIGH safety): make backup mandatory on non-dry-run writes (frontmatter.service.ts + note.service/repository); migrate() skip !hasFrontmatter notes and stop fabricating created=today
- [ ] Step 3-6: preserve body bytes/line-endings in buildNoteContent; verify+atomic backup; CLI exit codes + --format whitelist; tighten tests (pin DUPLICATE_KEY, add BAD_INDENTATION/INVALID_YAML/tab-indent fixtures) + MigrateSummary renderer
- [ ] Step 7 long-term: versioned migration registry, numeric schema-version compare, central code/severity enum, line numbers on schema-layer diagnostics, vaultRoot subset-of projectRoot check

## References
- claude-code-memory-vault-prompt-th.md
- src/services/frontmatter.service.ts
- src/utils/frontmatter.ts
- src/utils/frontmatter-schema.ts
- src/config/frontmatter.config.ts
- src/cli.ts
- docs/frontmatter-system-th.md

## Verification
Empirical: Node probe of installed gray-matter@4.0.3 confirmed throw/no-throw behavior for duplicate-key, unquoted-colon, bad-indent, tab-indent. Code reads confirmed migrate->computeRewrite fabrication path (frontmatter.service.ts:217-257,294-342) and body-strip (utils/frontmatter.ts:250-254). Live MCP validateFrontmatter + verifyVault rechecked (clean). No code changed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
