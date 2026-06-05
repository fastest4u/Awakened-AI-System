---
title: "2026-06-03 - Add Full-Auto project-memory operating protocol directive to CLAUDE.md"
type: session-log
session-date: "2026-06-03"
agent: claude-code
outcomes:
  - "Added an 'Operating protocol — Full-Auto project memory (read first)' section near the top of CLAUDE.md so future Claude Code instances auto-run the SPX memory lifecycle without being told"
  - "Documented the per-task flow (sessionStart -> contextPack -> selfCheck-when-risky -> write ADR/insight/mistake -> sessionEnd -> verify) and the AUTO vs WARN-THEN-RUN tool policy mirroring AGENTS.md/.rules/ADR"
  - "Added guidance to confirm vaultRoot via memory_diagnoseWorkspace before writing, and the allowlist caveat that the IDE prompt is client-controlled"
  - Rewrote the closing dogfooding note to point to the new directive instead of duplicating the protocol descriptively
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - session-log
  - project/general
---
# 2026-06-03 - Add Full-Auto project-memory operating protocol directive to CLAUDE.md

## TL;DR
- Added an 'Operating protocol — Full-Auto project memory (read first)' section near the top of CLAUDE.md so future Claude Code instances auto-run the SPX memory lifecycle without being told
- Documented the per-task flow (sessionStart -> contextPack -> selfCheck-when-risky -> write ADR/insight/mistake -> sessionEnd -> verify) and the AUTO vs WARN-THEN-RUN tool policy mirroring AGENTS.md/.rules/ADR
- Added guidance to confirm vaultRoot via memory_diagnoseWorkspace before writing, and the allowlist caveat that the IDE prompt is client-controlled
- Rewrote the closing dogfooding note to point to the new directive instead of duplicating the protocol descriptively

## Goal
Add Full-Auto project-memory operating protocol directive to CLAUDE.md

## What Was Done
- Added an 'Operating protocol — Full-Auto project memory (read first)' section near the top of CLAUDE.md so future Claude Code instances auto-run the SPX memory lifecycle without being told
- Documented the per-task flow (sessionStart -> contextPack -> selfCheck-when-risky -> write ADR/insight/mistake -> sessionEnd -> verify) and the AUTO vs WARN-THEN-RUN tool policy mirroring AGENTS.md/.rules/ADR
- Added guidance to confirm vaultRoot via memory_diagnoseWorkspace before writing, and the allowlist caveat that the IDE prompt is client-controlled
- Rewrote the closing dogfooding note to point to the new directive instead of duplicating the protocol descriptively

## Files Touched
- CLAUDE.md

## Decisions Made
- Placed the protocol as an imperative directive at the top of CLAUDE.md (read first) rather than a descriptive note at the bottom, because Claude Code loads CLAUDE.md preferentially and needs the instruction early
- Kept AGENTS.md/.rules/ADR as the cited source of truth rather than restating every rule verbatim, to avoid drift

## Open Follow-ups
- [ ] Optional: add ADR recording the decision to commit obfuscated dist/ output, if not already captured
- [ ] Pre-existing: 99_Templates/Template-Daily-Note.md has 2 INVALID_DATE_FORMAT placeholder-date warnings (unrelated to this task)

## References
- CLAUDE.md
- AGENTS.md
- .rules
- 01_Project_Rules/Always-On-Memory-Protocol.md
- 04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md

## Verification
Documentation-only edit to CLAUDE.md; two Edit operations applied cleanly. No source code changed, so npm build/test not run. Protocol wording cross-checked against context-pack notes 01_Project_Rules/Always-On-Memory-Protocol.md and the full-auto invocation ADR.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
