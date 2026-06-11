---
title: "2026-05-21 - Explain how to test LINE image listener in group"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 2
outcomes:
  - "Provided test flow for inbound LINE group image listener: enable LINEJS, login, get group MID, set LINE_IMAGE_LISTENER_CHAT_ID, run server, send image, verify reply/logs."
  - Clarified outbound image sending remains a follow-up because no sendImage endpoint/script exists yet.
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - Explain how to test LINE image listener in group

## TL;DR
- Provided test flow for inbound LINE group image listener: enable LINEJS, login, get group MID, set LINE_IMAGE_LISTENER_CHAT_ID, run server, send image, verify reply/logs.
- Clarified outbound image sending remains a follow-up because no sendImage endpoint/script exists yet.

## Goal
Explain how to test LINE image listener in group

## What Was Done
- Provided test flow for inbound LINE group image listener: enable LINEJS, login, get group MID, set LINE_IMAGE_LISTENER_CHAT_ID, run server, send image, verify reply/logs.
- Clarified outbound image sending remains a follow-up because no sendImage endpoint/script exists yet.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] If outbound image testing is needed, add a sendImage service/controller endpoint or script after confirming @evex/linejs image message API shape.

## References
- None

## Verification
Answered from inspected code and prior session context; no code changes made.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
