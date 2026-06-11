---
title: "2026-05-22 - fix Codex auth 403 by routing login to device code flow"
type: session-log
agent: Codex
session-date: "2026-05-22"
duration-minutes: 10
outcomes:
  - Diagnosed 403 token exchange as old authorization-code callback flow still being used by /api/ai/codex-auth/start.
  - "Changed /api/ai/codex-auth/start to call startDeviceCodeAuth() so the Settings UI uses OAuth Device Code flow instead of localhost callback token exchange."
  - Started a fresh local dev server so backend code changes are active.
tags:
  - session-log
  - project/general
created: "2026-05-22"
updated: "2026-05-22"
---

# 2026-05-22 - fix Codex auth 403 by routing login to device code flow

## TL;DR
- Diagnosed 403 token exchange as old authorization-code callback flow still being used by /api/ai/codex-auth/start.
- Changed /api/ai/codex-auth/start to call startDeviceCodeAuth() so the Settings UI uses OAuth Device Code flow instead of localhost callback token exchange.
- Started a fresh local dev server so backend code changes are active.

## Goal
fix Codex auth 403 by routing login to device code flow

## What Was Done
- Diagnosed 403 token exchange as old authorization-code callback flow still being used by /api/ai/codex-auth/start.
- Changed /api/ai/codex-auth/start to call startDeviceCodeAuth() so the Settings UI uses OAuth Device Code flow instead of localhost callback token exchange.
- Started a fresh local dev server so backend code changes are active.

## Files Touched
- src/controllers/ai-controller.ts

## Decisions Made
- Keep old callback completion code present but no longer use it for the normal Login button.
- Use device-code flow as the default Codex login route because prior memory and current evidence show authorization-code callback exchange fails with 403.

## Open Follow-ups
- [ ] User should retry Settings > API & Polling > Codex Device Auth using the new Login flow and confirm it reaches Authenticated.
- [ ] If device-code polling still fails after user approval, inspect backend log entries codex-device-code-auth-poll-error or codex-device-code-auth-poll-exception.

## References
- src/controllers/ai-controller.ts
- src/services/codex-device-auth.ts
- src/frontend/routes/settings.tsx

## Verification
npm run typecheck passed; npm run build passed; http://localhost:3000/health returned success; dev server is listening on frontend port 5173 and backend port 3000.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
