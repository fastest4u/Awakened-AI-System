---
title: "2026-05-21 - Make npm run dev use local development NODE_ENV"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 4
outcomes:
  - "Added scripts/dev-frontend.mjs to run Vite with NODE_ENV=development without editing .env."
  - "Updated scripts/dev-backend.mjs to set NODE_ENV=development as well as HTTP_ENABLED=true."
  - "Updated package.json dev and dev:frontend scripts to use the launcher so npm run dev is Windows-compatible and local-dev oriented."
  - Fixed Windows Node v24 spawn EINVAL by using cmd.exe /d /s /c for npx commands on Windows.
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - Make npm run dev use local development NODE_ENV

## TL;DR
- Added scripts/dev-frontend.mjs to run Vite with NODE_ENV=development without editing .env.
- Updated scripts/dev-backend.mjs to set NODE_ENV=development as well as HTTP_ENABLED=true.
- Updated package.json dev and dev:frontend scripts to use the launcher so npm run dev is Windows-compatible and local-dev oriented.
- Fixed Windows Node v24 spawn EINVAL by using cmd.exe /d /s /c for npx commands on Windows.

## Goal
Make npm run dev use local development NODE_ENV

## What Was Done
- Added scripts/dev-frontend.mjs to run Vite with NODE_ENV=development without editing .env.
- Updated scripts/dev-backend.mjs to set NODE_ENV=development as well as HTTP_ENABLED=true.
- Updated package.json dev and dev:frontend scripts to use the launcher so npm run dev is Windows-compatible and local-dev oriented.
- Fixed Windows Node v24 spawn EINVAL by using cmd.exe /d /s /c for npx commands on Windows.

## Files Touched
- package.json
- scripts/dev-backend.mjs
- scripts/dev-frontend.mjs

## Decisions Made
- None

## Open Follow-ups
- [ ] package.json still has pre-existing dependency/order changes in the working tree unrelated to this local dev fix; review before committing.

## References
- None

## Verification
node --check scripts/dev-backend.mjs and scripts/dev-frontend.mjs passed; npm run typecheck passed; controlled npm run dev startup reached Vite ready, HTTP server started, LINE token restored, and line-image-listener-started with no NODE_ENV=production Vite warning.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
