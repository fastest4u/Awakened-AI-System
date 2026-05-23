---
title: 2026-05-21 - Fix npm run dev on Windows PowerShell
type: session-log
session-date: 2026-05-21
agent: Codex
duration-minutes: 8
outcomes:
  - "Added scripts/dev-backend.mjs cross-platform backend launcher that sets HTTP_ENABLED=true before running tsx src/app.ts."
  - "Updated package.json dev and dev:backend scripts to use node scripts/dev-backend.mjs instead of POSIX env assignment."
  - "Confirmed npm run dev no longer fails with HTTP_ENABLED not recognized; startup reached Vite ready, HTTP server started, LINE token restored, and image listener started."
  - Removed temporary startup check log.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Fix npm run dev on Windows PowerShell

## TL;DR
- Added scripts/dev-backend.mjs cross-platform backend launcher that sets HTTP_ENABLED=true before running tsx src/app.ts.
- Updated package.json dev and dev:backend scripts to use node scripts/dev-backend.mjs instead of POSIX env assignment.
- Confirmed npm run dev no longer fails with HTTP_ENABLED not recognized; startup reached Vite ready, HTTP server started, LINE token restored, and image listener started.
- Removed temporary startup check log.

## Goal
Fix npm run dev on Windows PowerShell

## What Was Done
- Added scripts/dev-backend.mjs cross-platform backend launcher that sets HTTP_ENABLED=true before running tsx src/app.ts.
- Updated package.json dev and dev:backend scripts to use node scripts/dev-backend.mjs instead of POSIX env assignment.
- Confirmed npm run dev no longer fails with HTTP_ENABLED not recognized; startup reached Vite ready, HTTP server started, LINE token restored, and image listener started.
- Removed temporary startup check log.

## Files Touched
- package.json
- scripts/dev-backend.mjs

## Decisions Made
- None

## Open Follow-ups
- [ ] package.json still has pre-existing dependency/order changes in the working tree unrelated to this fix; review before committing.
- [ ] NODE_ENV=production in .env causes a Vite warning during dev startup; consider changing local dev environment to NODE_ENV=development if appropriate.

## References
- None

## Verification
node -e package.json parse OK; node --check scripts/dev-backend.mjs OK; npm run typecheck passed. A controlled npm run dev startup check reached backend/frontend readiness before being stopped.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
