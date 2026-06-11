---
title: "2026-05-21 - Fix LINE image listener E2EE key not saved path"
type: session-log
agent: Codex
session-date: "2026-05-21"
duration-minutes: 8
outcomes:
  - "Diagnosed E2EE image failure: LINEJS session had auth token but no stored E2EE self key, so msg.getData() cannot decrypt image content."
  - "Confirmed LINEJS QR login can decode/save E2EE key when e2eeInfo is returned, but current app restored DB auth token before QR login, preventing a fresh E2EE-capable login."
  - "Added deleteLineBotSession() and made logout(clearStorage=true) delete DB token as well as file storage/auth token."
  - "Added Reset button in LINE Bot settings to call logout(true), so user can clear stored auth/E2EE data from UI and QR login again."
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - Fix LINE image listener E2EE key not saved path

## TL;DR
- Diagnosed E2EE image failure: LINEJS session had auth token but no stored E2EE self key, so msg.getData() cannot decrypt image content.
- Confirmed LINEJS QR login can decode/save E2EE key when e2eeInfo is returned, but current app restored DB auth token before QR login, preventing a fresh E2EE-capable login.
- Added deleteLineBotSession() and made logout(clearStorage=true) delete DB token as well as file storage/auth token.
- Added Reset button in LINE Bot settings to call logout(true), so user can clear stored auth/E2EE data from UI and QR login again.

## Goal
Fix LINE image listener E2EE key not saved path

## What Was Done
- Diagnosed E2EE image failure: LINEJS session had auth token but no stored E2EE self key, so msg.getData() cannot decrypt image content.
- Confirmed LINEJS QR login can decode/save E2EE key when e2eeInfo is returned, but current app restored DB auth token before QR login, preventing a fresh E2EE-capable login.
- Added deleteLineBotSession() and made logout(clearStorage=true) delete DB token as well as file storage/auth token.
- Added Reset button in LINE Bot settings to call logout(true), so user can clear stored auth/E2EE data from UI and QR login again.

## Files Touched
- src/repositories/line-bot-session-repository.ts
- src/services/line-bot.ts
- src/frontend/components/SettingsLineBotSection.tsx

## Decisions Made
- None

## Open Follow-ups
- [ ] After user clicks Reset and QR logs in again, verify Settings LINE Bot storage shows E2EE Keys present before sending another image.
- [ ] If QR login still does not populate E2EE keys, investigate LINEJS secure QR e2eeInfo response or email/password E2EE login path.

## References
- None

## Verification
npm run typecheck passed after backend and frontend changes.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
