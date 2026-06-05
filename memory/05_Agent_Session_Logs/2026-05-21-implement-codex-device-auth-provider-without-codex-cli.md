---
title: "2026-05-21 - implement codex device auth provider without Codex CLI"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 35
outcomes:
  - Added direct Codex OAuth/PKCE auth flow modeled on Codex/OpenCode behavior without shelling out to Codex CLI.
  - Added Vercel AI SDK OpenAI provider integration with custom fetch that rewrites Responses API calls to ChatGPT Codex backend and applies required account/beta/originator headers.
  - Added authenticated API endpoints for Codex auth status/start/complete/logout.
  - Added DB-backed CODEX_IMAGE_PROVIDER setting and Settings UI provider selector.
  - "Added Settings UI controls for Codex device auth login, complete callback, and logout."
  - "Configured image reader to use codex-device when forced, or automatically when a stored Codex token exists."
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - implement codex device auth provider without Codex CLI

## TL;DR
- Added direct Codex OAuth/PKCE auth flow modeled on Codex/OpenCode behavior without shelling out to Codex CLI.
- Added Vercel AI SDK OpenAI provider integration with custom fetch that rewrites Responses API calls to ChatGPT Codex backend and applies required account/beta/originator headers.
- Added authenticated API endpoints for Codex auth status/start/complete/logout.
- Added DB-backed CODEX_IMAGE_PROVIDER setting and Settings UI provider selector.
- Added Settings UI controls for Codex device auth login, complete callback, and logout.
- Configured image reader to use codex-device when forced, or automatically when a stored Codex token exists.

## Goal
implement codex device auth provider without Codex CLI

## What Was Done
- Added direct Codex OAuth/PKCE auth flow modeled on Codex/OpenCode behavior without shelling out to Codex CLI.
- Added Vercel AI SDK OpenAI provider integration with custom fetch that rewrites Responses API calls to ChatGPT Codex backend and applies required account/beta/originator headers.
- Added authenticated API endpoints for Codex auth status/start/complete/logout.
- Added DB-backed CODEX_IMAGE_PROVIDER setting and Settings UI provider selector.
- Added Settings UI controls for Codex device auth login, complete callback, and logout.
- Configured image reader to use codex-device when forced, or automatically when a stored Codex token exists.

## Files Touched
- package.json
- package-lock.json
- src/services/codex-device-auth.ts
- src/services/codex-image-reader.ts
- src/controllers/ai-controller.ts
- src/config/env.ts
- src/services/settings.ts
- src/controllers/settings-controller.ts
- src/frontend/lib/api.ts
- src/frontend/types/index.ts
- src/frontend/routes/settings.tsx

## Decisions Made
- Use direct OAuth/PKCE token storage under data/codex-device-auth.json instead of invoking Codex CLI.
- Keep CODEX_IMAGE_PROVIDER default as auto so existing Codex CLI behavior remains fallback-compatible until device auth is completed.
- Store runtime Codex OAuth tokens in local data storage and never print token contents.

## Open Follow-ups
- [ ] Live OAuth login and model call still need to be tested by the user because it requires their OpenAI login session in a browser.
- [ ] Consider replacing prompt-based callback paste UI with a localhost callback capture helper if the manual paste flow is too awkward.

## References
- src/services/codex-device-auth.ts
- src/services/codex-image-reader.ts
- src/controllers/ai-controller.ts
- src/frontend/routes/settings.tsx

## Verification
npm run typecheck passed; npm run build passed. Build still emits existing Vite warning about NODE_ENV=production in env file, but exits 0.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
