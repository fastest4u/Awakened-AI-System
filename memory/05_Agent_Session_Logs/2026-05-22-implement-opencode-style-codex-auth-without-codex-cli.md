---
title: "2026-05-22 - Implement OpenCode-style Codex auth without Codex CLI"
type: session-log
agent: codex
session-date: "2026-05-22"
duration-minutes: 45
outcomes:
  - "Changed SPX Codex auth start endpoint to default to browser OAuth with localhost callback, matching OpenCode desktop behavior without invoking Codex CLI."
  - Kept device-code login as an explicit fallback using auth.openai.com/codex/device and official deviceauth endpoints.
  - Updated the AI SDK custom Codex fetch to use OpenCode-like originator/User-Agent headers and direct Codex API bearer auth from stored tokens.
  - Updated Settings UI to expose Browser Login and Code Login actions for the codex-device provider.
  - "Verified npm run typecheck, npm run build, browser/device auth smoke starts, backend health, and local dev server startup."
tags:
  - session-log
  - project/general
created: "2026-05-22"
updated: "2026-05-22"
---

# 2026-05-22 - Implement OpenCode-style Codex auth without Codex CLI

## TL;DR
- Changed SPX Codex auth start endpoint to default to browser OAuth with localhost callback, matching OpenCode desktop behavior without invoking Codex CLI.
- Kept device-code login as an explicit fallback using auth.openai.com/codex/device and official deviceauth endpoints.
- Updated the AI SDK custom Codex fetch to use OpenCode-like originator/User-Agent headers and direct Codex API bearer auth from stored tokens.
- Updated Settings UI to expose Browser Login and Code Login actions for the codex-device provider.
- Verified npm run typecheck, npm run build, browser/device auth smoke starts, backend health, and local dev server startup.

## Goal
Implement OpenCode-style Codex auth without Codex CLI

## What Was Done
- Changed SPX Codex auth start endpoint to default to browser OAuth with localhost callback, matching OpenCode desktop behavior without invoking Codex CLI.
- Kept device-code login as an explicit fallback using auth.openai.com/codex/device and official deviceauth endpoints.
- Updated the AI SDK custom Codex fetch to use OpenCode-like originator/User-Agent headers and direct Codex API bearer auth from stored tokens.
- Updated Settings UI to expose Browser Login and Code Login actions for the codex-device provider.
- Verified npm run typecheck, npm run build, browser/device auth smoke starts, backend health, and local dev server startup.

## Files Touched
- src/services/codex-device-auth.ts
- src/controllers/ai-controller.ts
- src/frontend/types/index.ts
- src/frontend/lib/api.ts
- src/frontend/routes/settings.tsx

## Decisions Made
- Use direct OpenAI auth endpoints and local callback/device fallback instead of shelling out to Codex CLI.
- Default the UI/API to browser login because the user requested OpenCode desktop-style auth.
- Preserve device-code login as fallback for headless environments.

## Open Follow-ups
- [ ] User still needs to complete the live browser OAuth approval in Settings to confirm their account accepts the OpenCode-style client flow.
- [ ] Memory vault has an unrelated pre-existing session-log structure issue in 05_Agent_Session_Logs/2026-05-21-codex-pkce-auth-improvements.md missing outcomes.

## References
- None

## Verification
npm run typecheck passed; npm run build passed; startCodexBrowserAuth returned an auth.openai.com authorize URL and localhost:1455 callback; startDeviceCodeAuth returned a user code and https://auth.openai.com/codex/device verification URL; npm run dev is running with backend health OK at http://localhost:3000/health and frontend at http://localhost:5173/.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
