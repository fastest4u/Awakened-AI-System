---
title: "2026-05-21 - Clarify and improve LINE receive-images E2EE requirement"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 4
outcomes:
  - Explained that DB auth token is enough for outbound text but not enough for receiving/decrypting images from other users in E2EE chats.
  - "Verified current data/linejs-storage.json has zero keys, zero E2EE self keys, zero group keys, and zero public keys, so incoming media decrypt cannot work yet."
  - "Added guard: when LINE_IMAGE_LISTENER_CHAT_ID is configured and storage lacks E2EE keys, line-bot skips DB/file token restore and starts QR login instead."
  - Kept prior reset support so clearStorage also deletes DB session and UI has Reset button.
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - Clarify and improve LINE receive-images E2EE requirement

## TL;DR
- Explained that DB auth token is enough for outbound text but not enough for receiving/decrypting images from other users in E2EE chats.
- Verified current data/linejs-storage.json has zero keys, zero E2EE self keys, zero group keys, and zero public keys, so incoming media decrypt cannot work yet.
- Added guard: when LINE_IMAGE_LISTENER_CHAT_ID is configured and storage lacks E2EE keys, line-bot skips DB/file token restore and starts QR login instead.
- Kept prior reset support so clearStorage also deletes DB session and UI has Reset button.

## Goal
Clarify and improve LINE receive-images E2EE requirement

## What Was Done
- Explained that DB auth token is enough for outbound text but not enough for receiving/decrypting images from other users in E2EE chats.
- Verified current data/linejs-storage.json has zero keys, zero E2EE self keys, zero group keys, and zero public keys, so incoming media decrypt cannot work yet.
- Added guard: when LINE_IMAGE_LISTENER_CHAT_ID is configured and storage lacks E2EE keys, line-bot skips DB/file token restore and starts QR login instead.
- Kept prior reset support so clearStorage also deletes DB session and UI has Reset button.

## Files Touched
- src/services/line-bot.ts

## Decisions Made
- None

## Open Follow-ups
- [ ] Restart dev server, trigger QR login again, and verify storage has E2EE keys before retesting incoming images.
- [ ] If QR login still stores no E2EE keys, investigate @evex/linejs QR e2eeInfo behavior or add password/E2EE login flow.

## References
- None

## Verification
Redacted storage inspection showed TotalKeys=0 and E2EESelfKeys=0; npm run typecheck passed after code changes.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
