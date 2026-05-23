---
title: Guessed Codex Device Code OAuth Endpoint Instead of Verifying Official Source
type: mistake
severity: medium
status: open
occurred-date: 2026-05-22
agent: Codex
area: auth provider integration
confidence: high
created: 2026-05-22
updated: 2026-05-22
tags:
  - area/auth provider integration
  - topic/memory-vault
---
## Problem
Codex device auth was first implemented against a guessed Auth0 OAuth device-code endpoint, causing CODEX_AUTH_START_FAILED with 404/403 responses.

## Root Cause
Assumed the Codex login used the standard OAuth Device Code Grant endpoint. The official Codex CLI implementation uses custom endpoints under https://auth.openai.com/api/accounts/deviceauth/usercode and /deviceauth/token, followed by a normal authorization_code exchange.

## Avoidance
Before implementing private or semi-private auth flows, inspect the current official client/source or package binary strings and probe endpoints with non-secret requests. Do not infer endpoint paths from OAuth standards alone.

## References
- src/services/codex-device-auth.ts
- https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs
