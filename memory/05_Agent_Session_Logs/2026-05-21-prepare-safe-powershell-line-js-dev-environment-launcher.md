---
title: "2026-05-21 - Prepare safe PowerShell LINE JS dev environment launcher"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 5
outcomes:
  - Did not read or edit .env because repository instructions prohibit editing .env and exposing secrets.
  - Added scripts/dev-linejs.ps1 to set PowerShell-compatible dev environment variables for LINE JS testing and run backend plus Vite via concurrently.
  - Script accepts -ChatId to set LINE_IMAGE_LISTENER_CHAT_ID for group image listener testing.
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - Prepare safe PowerShell LINE JS dev environment launcher

## TL;DR
- Did not read or edit .env because repository instructions prohibit editing .env and exposing secrets.
- Added scripts/dev-linejs.ps1 to set PowerShell-compatible dev environment variables for LINE JS testing and run backend plus Vite via concurrently.
- Script accepts -ChatId to set LINE_IMAGE_LISTENER_CHAT_ID for group image listener testing.

## Goal
Prepare safe PowerShell LINE JS dev environment launcher

## What Was Done
- Did not read or edit .env because repository instructions prohibit editing .env and exposing secrets.
- Added scripts/dev-linejs.ps1 to set PowerShell-compatible dev environment variables for LINE JS testing and run backend plus Vite via concurrently.
- Script accepts -ChatId to set LINE_IMAGE_LISTENER_CHAT_ID for group image listener testing.

## Files Touched
- scripts/dev-linejs.ps1

## Decisions Made
- None

## Open Follow-ups
- [ ] Consider adding a package.json script such as dev:linejs:windows if the user wants npm-based startup instead of calling the PowerShell script directly.

## References
- None

## Verification
Validated scripts/dev-linejs.ps1 with PowerShell PSParser syntax check: PowerShell syntax OK.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
