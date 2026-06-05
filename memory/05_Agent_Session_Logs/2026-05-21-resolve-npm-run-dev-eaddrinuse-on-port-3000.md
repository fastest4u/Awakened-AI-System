---
title: "2026-05-21 - Resolve npm run dev EADDRINUSE on port 3000"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 3
outcomes:
  - "Diagnosed current npm run dev failure as port collision, not script failure."
  - Found node.exe PID 14596 running src/app.ts from this SPX project on port 3000.
  - Found node.exe PID 14664 running Vite from this SPX project on port 5173.
  - "Stopped both stale dev server processes; ports 3000 and 5173 are now free."
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - Resolve npm run dev EADDRINUSE on port 3000

## TL;DR
- Diagnosed current npm run dev failure as port collision, not script failure.
- Found node.exe PID 14596 running src/app.ts from this SPX project on port 3000.
- Found node.exe PID 14664 running Vite from this SPX project on port 5173.
- Stopped both stale dev server processes; ports 3000 and 5173 are now free.

## Goal
Resolve npm run dev EADDRINUSE on port 3000

## What Was Done
- Diagnosed current npm run dev failure as port collision, not script failure.
- Found node.exe PID 14596 running src/app.ts from this SPX project on port 3000.
- Found node.exe PID 14664 running Vite from this SPX project on port 5173.
- Stopped both stale dev server processes; ports 3000 and 5173 are now free.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [x] None

## References
- None

## Verification
Used Get-NetTCPConnection and Win32_Process command lines to confirm owning processes before stopping them; rechecked ports after Stop-Process and confirmed free.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
