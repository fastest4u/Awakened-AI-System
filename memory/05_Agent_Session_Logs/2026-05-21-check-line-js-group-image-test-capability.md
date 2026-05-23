---
title: 2026-05-21 - Check LINE JS group image test capability
type: session-log
session-date: 2026-05-21
agent: Codex
duration-minutes: 3
outcomes:
  - Confirmed LINE JS text sending to group is supported via /api/line-bot/send and dashboard /line-bot.
  - Confirmed image listener exists for inbound group images via LINE_IMAGE_LISTENER_CHAT_ID and startImageListener.
  - Confirmed outbound image sending to LINE group is not currently exposed in service/controller/UI.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Check LINE JS group image test capability

## TL;DR
- Confirmed LINE JS text sending to group is supported via /api/line-bot/send and dashboard /line-bot.
- Confirmed image listener exists for inbound group images via LINE_IMAGE_LISTENER_CHAT_ID and startImageListener.
- Confirmed outbound image sending to LINE group is not currently exposed in service/controller/UI.

## Goal
Check LINE JS group image test capability

## What Was Done
- Confirmed LINE JS text sending to group is supported via /api/line-bot/send and dashboard /line-bot.
- Confirmed image listener exists for inbound group images via LINE_IMAGE_LISTENER_CHAT_ID and startImageListener.
- Confirmed outbound image sending to LINE group is not currently exposed in service/controller/UI.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] If outbound image testing is needed, add a sendImage service/controller endpoint or script after confirming @evex/linejs image message API shape.

## References
- None

## Verification
Inspected src/services/line-bot.ts, src/controllers/line-bot-controller.ts, src/services/http-server.ts, src/frontend/routes/line-bot.tsx, and src/frontend/lib/api.ts. No code changes made.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
