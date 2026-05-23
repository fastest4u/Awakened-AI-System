---
title: 2026-05-21 - Diagnose PowerShell npm run dev HTTP_ENABLED failure
type: session-log
session-date: 2026-05-21
agent: Codex
duration-minutes: 2
outcomes:
  - "Explained npm run dev fails on PowerShell/Windows because package script uses POSIX env assignment syntax HTTP_ENABLED=true."
  - Provided immediate PowerShell-compatible backend and frontend startup commands.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Diagnose PowerShell npm run dev HTTP_ENABLED failure

## TL;DR
- Explained npm run dev fails on PowerShell/Windows because package script uses POSIX env assignment syntax HTTP_ENABLED=true.
- Provided immediate PowerShell-compatible backend and frontend startup commands.

## Goal
Diagnose PowerShell npm run dev HTTP_ENABLED failure

## What Was Done
- Explained npm run dev fails on PowerShell/Windows because package script uses POSIX env assignment syntax HTTP_ENABLED=true.
- Provided immediate PowerShell-compatible backend and frontend startup commands.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] Consider changing npm dev script to a Windows-compatible approach such as cross-env or a small Node startup script.

## References
- None

## Verification
No code changes; diagnosis based on user terminal output and package script behavior.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
