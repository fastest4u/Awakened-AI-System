---
title: "2026-05-21 - persist LINE image AI extraction to DB"
type: session-log
agent: codex
session-date: "2026-05-21"
duration-minutes: 22
outcomes:
  - Added line_image_extractions schema/migration support for MySQL and memory DB.
  - Added LINE image extraction parser/validator that only saves complete 5-field AI output when normalized Agency equals LH-PWL.
  - Added repository insert path for saved LINE image extraction records.
  - "Updated LINE image listener to save valid images under data/line-images/YYYY-MM and persist relative image_path plus extracted fields to DB, while replying with saved/not-saved status."
  - Adjusted dynamic import handling in LINE listener to work with both ESM and CommonJS namespace shapes under tsx/dev runtime.
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - persist LINE image AI extraction to DB

## TL;DR
- Added line_image_extractions schema/migration support for MySQL and memory DB.
- Added LINE image extraction parser/validator that only saves complete 5-field AI output when normalized Agency equals LH-PWL.
- Added repository insert path for saved LINE image extraction records.
- Updated LINE image listener to save valid images under data/line-images/YYYY-MM and persist relative image_path plus extracted fields to DB, while replying with saved/not-saved status.
- Adjusted dynamic import handling in LINE listener to work with both ESM and CommonJS namespace shapes under tsx/dev runtime.

## Goal
persist LINE image AI extraction to DB

## What Was Done
- Added line_image_extractions schema/migration support for MySQL and memory DB.
- Added LINE image extraction parser/validator that only saves complete 5-field AI output when normalized Agency equals LH-PWL.
- Added repository insert path for saved LINE image extraction records.
- Updated LINE image listener to save valid images under data/line-images/YYYY-MM and persist relative image_path plus extracted fields to DB, while replying with saved/not-saved status.
- Adjusted dynamic import handling in LINE listener to work with both ESM and CommonJS namespace shapes under tsx/dev runtime.

## Files Touched
- src/db/schema.ts
- src/db/client.ts
- src/db/client-memory.ts
- src/db/migration-sql.ts
- src/scripts/generate-migration.ts
- src/services/line-bot.ts
- src/services/line-image-extraction.ts
- src/repositories/line-image-extraction-repository.ts
- migrations/013_create_line_image_extractions.sql

## Decisions Made
- None

## Open Follow-ups
- [ ] Restart npm run dev before testing the new listener flow.
- [ ] For deployed/long-lived DBs, run npm run db:migrate or rely on ensureDashboardTables during HTTP startup to create line_image_extractions.
- [ ] Add a dashboard/API view for saved line_image_extractions if the user wants to browse saved images from UI.

## References
- None

## Verification
Ran npm run typecheck; ran parser validation smoke test via npx tsx; ran npm run build successfully. Build still emits pre-existing Vite NODE_ENV=production warning but exits 0.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
