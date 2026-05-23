---
title: 2026-05-22 - Require explicit Codex auth login mode
type: session-log
session-date: 2026-05-22
agent: codex
duration-minutes: 18
outcomes:
  - Changed /api/ai/codex-auth/start so it no longer defaults to browser mode when mode is omitted.
  - Made the frontend API client require a mode argument for Codex auth start calls.
  - Renamed the second settings button to Device Code Login so users explicitly choose Browser Login or Device Code Login.
  - Removed Codex CLI fallback wording from Codex login provider-unavailable errors.
  - Added a controller-level smoke test proving an omitted mode returns CODEX_AUTH_MODE_REQUIRED instead of starting a login flow.
created: 2026-05-22
updated: 2026-05-22
tags:
  - session-log
  - project/general
---
# 2026-05-22 - Require explicit Codex auth login mode

## TL;DR
- Changed /api/ai/codex-auth/start so it no longer defaults to browser mode when mode is omitted.
- Made the frontend API client require a mode argument for Codex auth start calls.
- Renamed the second settings button to Device Code Login so users explicitly choose Browser Login or Device Code Login.
- Removed Codex CLI fallback wording from Codex login provider-unavailable errors.
- Added a controller-level smoke test proving an omitted mode returns CODEX_AUTH_MODE_REQUIRED instead of starting a login flow.

## Goal
Require explicit Codex auth login mode

## What Was Done
- Changed /api/ai/codex-auth/start so it no longer defaults to browser mode when mode is omitted.
- Made the frontend API client require a mode argument for Codex auth start calls.
- Renamed the second settings button to Device Code Login so users explicitly choose Browser Login or Device Code Login.
- Removed Codex CLI fallback wording from Codex login provider-unavailable errors.
- Added a controller-level smoke test proving an omitted mode returns CODEX_AUTH_MODE_REQUIRED instead of starting a login flow.

## Files Touched
- src/controllers/ai-controller.ts
- src/frontend/lib/api.ts
- src/frontend/routes/settings.tsx
- tests/codex-auth-start.test.ts

## Decisions Made
- Keep browser and device-code login modes available, but require the caller/user to choose one explicitly.
- Do not remove the separate CODEX_IMAGE_PROVIDER options in this change because that is a distinct provider configuration surface.

## Open Follow-ups
- [ ] User still needs to complete a live Browser Login or Device Code Login from Settings with their OpenAI account to confirm account-side approval.
- [ ] If the user also wants to remove the separate CODEX_IMAGE_PROVIDER=auto behavior, update config/schema/UI as a separate explicit provider-selection change.

## References
- None

## Verification
npx tsx tests/codex-auth-start.test.ts failed before implementation with 200 !== 400, then passed after implementation; npm run typecheck passed; npm run build passed; npm run dev restarted; backend health OK at http://localhost:3000/health and frontend listening at http://localhost:5173/. Live unauthenticated POST to /api/ai/codex-auth/start returns 401 due the app session guard, so controller behavior was verified through Fastify inject.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
