---
title: "2026-05-22 - fix Codex device-code start 404 by using official Codex deviceauth endpoints"
type: session-log
agent: Codex
session-date: "2026-05-22"
duration-minutes: 18
outcomes:
  - Diagnosed CODEX_AUTH_START_FAILED 404 as the service using the wrong OAuth device-code endpoint.
  - "Verified the official Codex CLI source uses /api/accounts/deviceauth/usercode and /api/accounts/deviceauth/token, not /oauth/device/code."
  - "Updated Codex device auth to request user codes via JSON, poll the Codex deviceauth token endpoint, then exchange the returned authorization_code at /oauth/token with the deviceauth callback redirect URI."
  - Restarted the local dev server so the fixed backend is active.
tags:
  - session-log
  - project/general
created: "2026-05-22"
updated: "2026-05-22"
---

# 2026-05-22 - fix Codex device-code start 404 by using official Codex deviceauth endpoints

## TL;DR
- Diagnosed CODEX_AUTH_START_FAILED 404 as the service using the wrong OAuth device-code endpoint.
- Verified the official Codex CLI source uses /api/accounts/deviceauth/usercode and /api/accounts/deviceauth/token, not /oauth/device/code.
- Updated Codex device auth to request user codes via JSON, poll the Codex deviceauth token endpoint, then exchange the returned authorization_code at /oauth/token with the deviceauth callback redirect URI.
- Restarted the local dev server so the fixed backend is active.

## Goal
fix Codex device-code start 404 by using official Codex deviceauth endpoints

## What Was Done
- Diagnosed CODEX_AUTH_START_FAILED 404 as the service using the wrong OAuth device-code endpoint.
- Verified the official Codex CLI source uses /api/accounts/deviceauth/usercode and /api/accounts/deviceauth/token, not /oauth/device/code.
- Updated Codex device auth to request user codes via JSON, poll the Codex deviceauth token endpoint, then exchange the returned authorization_code at /oauth/token with the deviceauth callback redirect URI.
- Restarted the local dev server so the fixed backend is active.

## Files Touched
- src/services/codex-device-auth.ts

## Decisions Made
- Use official Codex custom deviceauth endpoints rather than standard OAuth device-code grant endpoints.
- Keep the old callback flow code present for compatibility, but normal UI Login now uses the fixed deviceauth flow.

## Open Follow-ups
- [ ] User should refresh Settings and retry Codex Device Auth Login; if approval succeeds but status does not become Authenticated, inspect codex-device-code-auth-poll-error or codex-device-code-auth-poll-exception in the backend log.

## References
- src/services/codex-device-auth.ts
- https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs

## Verification
Probed https://auth.openai.com/api/accounts/deviceauth/usercode with public client_id and received 200; smoke-tested startDeviceCodeAuth() and confirmed it returns a user code and verification URL; npm run typecheck passed; npm run build passed; restarted npm run dev and /health returned success.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
