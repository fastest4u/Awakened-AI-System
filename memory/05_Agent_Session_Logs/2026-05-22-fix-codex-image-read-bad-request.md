---
title: "2026-05-22 - Fix Codex image read Bad Request"
type: session-log
agent: codex
session-date: "2026-05-22"
duration-minutes: 25
outcomes:
  - Diagnosed LINE image read failure as a Codex endpoint request-shape issue rather than LINE/E2EE failure.
  - "Captured sanitized Codex response details showing sequential 400 causes: missing instructions, missing store:false, missing stream:true, then SSE returned without content-type."
  - "Updated codex-device fetch to add default instructions, force store:false and stream:true for ChatGPT Codex responses, and convert Codex SSE responses to JSON for non-stream generateText calls even when content-type is missing."
  - Added a regression test for Codex image reader request requirements and SSE conversion.
  - Verified real image smoke test with 439805.jpg now returns 200 and OCR text.
tags:
  - session-log
  - project/general
created: "2026-05-22"
updated: "2026-05-22"
---

# 2026-05-22 - Fix Codex image read Bad Request

## TL;DR
- Diagnosed LINE image read failure as a Codex endpoint request-shape issue rather than LINE/E2EE failure.
- Captured sanitized Codex response details showing sequential 400 causes: missing instructions, missing store:false, missing stream:true, then SSE returned without content-type.
- Updated codex-device fetch to add default instructions, force store:false and stream:true for ChatGPT Codex responses, and convert Codex SSE responses to JSON for non-stream generateText calls even when content-type is missing.
- Added a regression test for Codex image reader request requirements and SSE conversion.
- Verified real image smoke test with 439805.jpg now returns 200 and OCR text.

## Goal
Fix Codex image read Bad Request

## What Was Done
- Diagnosed LINE image read failure as a Codex endpoint request-shape issue rather than LINE/E2EE failure.
- Captured sanitized Codex response details showing sequential 400 causes: missing instructions, missing store:false, missing stream:true, then SSE returned without content-type.
- Updated codex-device fetch to add default instructions, force store:false and stream:true for ChatGPT Codex responses, and convert Codex SSE responses to JSON for non-stream generateText calls even when content-type is missing.
- Added a regression test for Codex image reader request requirements and SSE conversion.
- Verified real image smoke test with 439805.jpg now returns 200 and OCR text.

## Files Touched
- src/services/codex-device-auth.ts
- src/services/codex-image-reader.ts
- tests/codex-image-reader-instructions.test.ts

## Decisions Made
- Keep AI SDK generateText call path, adapting only the private codex-device fetch bridge to match ChatGPT Codex endpoint requirements.
- Force Codex endpoint calls to stream:true while converting SSE back for non-streaming callers to preserve the existing readImageWithCodex API.

## Open Follow-ups
- [ ] User should send another image into the LINE group to verify the live listener path now replies and saves when Agency is LH-PWL.
- [ ] If live LINE reply still fails, inspect the next line-image-listener-error because the previous Bad Request request-shape issue is fixed.

## References
- None

## Verification
npx tsx tests/codex-image-reader-instructions.test.ts passed; npx tsx tests/codex-image-reader.test.ts passed; npx tsx tests/codex-auth-start.test.ts passed; npx tsx tests/ai-local-service-smoke.ts 439805.jpg passed with HTTP 200 and OCR output; npm run typecheck passed; npm run build passed; npm run dev restarted; backend health OK and line-image-listener-started logged.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
