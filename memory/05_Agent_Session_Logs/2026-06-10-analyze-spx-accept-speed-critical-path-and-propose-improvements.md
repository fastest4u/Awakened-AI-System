---
title: "2026-06-10 - Analyze SPX accept-speed critical path and propose improvements"
type: session-log
session-date: "2026-06-10"
agent: cascade
outcomes:
  - "Mapped end-to-end critical path: poll wait (avg POLL_INTERVAL_MS/2) -> bidding list page1 RTT (+extra pages) -> per-tick DB rules query -> request-list page1 RTT (page-level fast lane exists) -> accept POST RTT"
  - "Found stale comment in poller.ts:246 claiming rules are cached; readRulesDb() does a real DB SELECT every tick on the critical path before any detail fetch launches"
  - "Found bidding-list fetch waits for ALL extra pages before scheduling details (api-client.ts fetch -> fetchRemainingBiddingListPages)"
  - "Found list-poll retries (MAX_RETRIES=3, exponential backoff) stretch a failed tick ~7s+ even though the next tick supersedes it"
  - "Proposed ranked improvements: ops (lower POLL_INTERVAL_MS, cooldown 30-60s, raise detail concurrency when saturated, host near SPX), code (rules cache/parallel fetch, fail-fast list poll, page-1 streaming, adaptive interval, newness-aware sort), experiments (undici allowH2)"
created: "2026-06-10"
updated: "2026-06-10"
tags:
  - session-log
  - project/general
---
# 2026-06-10 - Analyze SPX accept-speed critical path and propose improvements

## TL;DR
- Mapped end-to-end critical path: poll wait (avg POLL_INTERVAL_MS/2) -> bidding list page1 RTT (+extra pages) -> per-tick DB rules query -> request-list page1 RTT (page-level fast lane exists) -> accept POST RTT
- Found stale comment in poller.ts:246 claiming rules are cached; readRulesDb() does a real DB SELECT every tick on the critical path before any detail fetch launches
- Found bidding-list fetch waits for ALL extra pages before scheduling details (api-client.ts fetch -> fetchRemainingBiddingListPages)
- Found list-poll retries (MAX_RETRIES=3, exponential backoff) stretch a failed tick ~7s+ even though the next tick supersedes it
- Proposed ranked improvements: ops (lower POLL_INTERVAL_MS, cooldown 30-60s, raise detail concurrency when saturated, host near SPX), code (rules cache/parallel fetch, fail-fast list poll, page-1 streaming, adaptive interval, newness-aware sort), experiments (undici allowH2)

## Goal
Analyze SPX accept-speed critical path and propose improvements

## What Was Done
- Mapped end-to-end critical path: poll wait (avg POLL_INTERVAL_MS/2) -> bidding list page1 RTT (+extra pages) -> per-tick DB rules query -> request-list page1 RTT (page-level fast lane exists) -> accept POST RTT
- Found stale comment in poller.ts:246 claiming rules are cached; readRulesDb() does a real DB SELECT every tick on the critical path before any detail fetch launches
- Found bidding-list fetch waits for ALL extra pages before scheduling details (api-client.ts fetch -> fetchRemainingBiddingListPages)
- Found list-poll retries (MAX_RETRIES=3, exponential backoff) stretch a failed tick ~7s+ even though the next tick supersedes it
- Proposed ranked improvements: ops (lower POLL_INTERVAL_MS, cooldown 30-60s, raise detail concurrency when saturated, host near SPX), code (rules cache/parallel fetch, fail-fast list poll, page-1 streaming, adaptive interval, newness-aware sort), experiments (undici allowH2)

## Files Touched
- src/controllers/poller.ts (read)
- src/services/api-client.ts (read)
- src/services/notifier.ts (read)
- src/services/notify-rules.ts (read)
- src/utils/http-dispatcher.ts (read)
- src/config/env.ts (read)

## Decisions Made
- None

## Open Follow-ups
- [ ] User decision: which improvements to implement (B1 rules cache, B2 fail-fast poll, B3 page-1 streaming, B4 adaptive interval)
- [ ] Check dashboard metrics acceptRtt/detailToFirstMatch/pollLatency to size each fix before implementing
- [ ] Check logs for booking-detail-concurrency-saturated and bidding-list-fetching-extra-pages to confirm B3/concurrency relevance

## References
- None

## Verification
Read-only analysis; no code changes, no commands run. Claims grounded in cited source lines.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
