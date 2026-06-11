---
title: "2026-06-10 - Implement B1 rules cache and B2 fail-fast list poll for accept-speed"
type: session-log
session-date: "2026-06-10"
agent: cascade
outcomes:
  - "B1: added in-memory rules cache in src/services/notify-rules.ts — readRules() serves from cache (TTL 5s safety net), every writer (writeRulesFile, broadcastAllRules after all DB mutations, migrateJsonToDb) refreshes/invalidates synchronously, single-flight guard prevents concurrent SELECT stampede; per-tick DB SELECT removed from the accept critical path"
  - "B2: added listPollRetries() and listPollTimeoutMs() in src/services/api-client.ts — bidding-list poll retry budget and timeout now derive from live POLL_INTERVAL_MS (worst-case backoff capped at interval/2, timeout clamped [5s, 15s] at 2x interval); default 30s interval keeps exactly today's behavior (3 retries, 15s timeout), aggressive intervals fail fast so cadence recovers via next tick"
  - "npm run typecheck passed (backend + frontend); stopped at typecheck per Commit & Deploy Policy — no commit"
created: "2026-06-10"
updated: "2026-06-10"
tags:
  - session-log
  - project/general
---
# 2026-06-10 - Implement B1 rules cache and B2 fail-fast list poll for accept-speed

## TL;DR
- B1: added in-memory rules cache in src/services/notify-rules.ts — readRules() serves from cache (TTL 5s safety net), every writer (writeRulesFile, broadcastAllRules after all DB mutations, migrateJsonToDb) refreshes/invalidates synchronously, single-flight guard prevents concurrent SELECT stampede; per-tick DB SELECT removed from the accept critical path
- B2: added listPollRetries() and listPollTimeoutMs() in src/services/api-client.ts — bidding-list poll retry budget and timeout now derive from live POLL_INTERVAL_MS (worst-case backoff capped at interval/2, timeout clamped [5s, 15s] at 2x interval); default 30s interval keeps exactly today's behavior (3 retries, 15s timeout), aggressive intervals fail fast so cadence recovers via next tick
- npm run typecheck passed (backend + frontend); stopped at typecheck per Commit & Deploy Policy — no commit

## Goal
Implement B1 rules cache and B2 fail-fast list poll for accept-speed

## What Was Done
- B1: added in-memory rules cache in src/services/notify-rules.ts — readRules() serves from cache (TTL 5s safety net), every writer (writeRulesFile, broadcastAllRules after all DB mutations, migrateJsonToDb) refreshes/invalidates synchronously, single-flight guard prevents concurrent SELECT stampede; per-tick DB SELECT removed from the accept critical path
- B2: added listPollRetries() and listPollTimeoutMs() in src/services/api-client.ts — bidding-list poll retry budget and timeout now derive from live POLL_INTERVAL_MS (worst-case backoff capped at interval/2, timeout clamped [5s, 15s] at 2x interval); default 30s interval keeps exactly today's behavior (3 retries, 15s timeout), aggressive intervals fail fast so cadence recovers via next tick
- npm run typecheck passed (backend + frontend); stopped at typecheck per Commit & Deploy Policy — no commit

## Files Touched
- src/services/notify-rules.ts
- src/services/api-client.ts

## Decisions Made
- Cache invalidation via writer-refresh + 5s TTL safety net instead of TTL-only or invalidation-only (covers out-of-band SQL edits while keeping in-app reads exact)
- Adaptive retry budget derived from POLL_INTERVAL_MS instead of hardcoded retries=0 (preserves long-interval recovery behavior unchanged)
- Fail-fast applies only to bidding-list pages; request-list/overview/accept hops keep full retries since post-detection completion matters more than cadence

## Open Follow-ups
- [ ] User to tune POLL_INTERVAL_MS themselves (1-3s during competition) via Settings UI
- [ ] Optional next slices not implemented: B3 stream bidding-list page 1, B4 adaptive interval, C1 HTTP/2 experiment
- [ ] Verify acceptRtt/detailToFirstMatch/pollLatency on dashboard after deploying with low interval

## References
- None

## Verification
npm run typecheck exit 0 (tsc backend + frontend). No runtime test run — db/smoke/flow tests hit live SPX/MySQL per AGENTS.md.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
