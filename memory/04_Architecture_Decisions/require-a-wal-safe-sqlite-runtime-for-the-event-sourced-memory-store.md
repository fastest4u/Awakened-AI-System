---
title: Require a WAL-safe SQLite runtime for the event-sourced memory store
type: adr
status: accepted
decision-date: "2026-07-11"
confidence: high
supersedes: []
created: "2026-07-11"
updated: "2026-07-11"
tags:
  - architecture
  - nodejs
  - sqlite
  - wal
  - runtime-floor
  - data-integrity
  - memory-v2
---
## Context
The approved event-sourced orchestrator initially set Node.js 22.13.0 as the minimum because node:sqlite is unflagged there. Official SQLite documentation later confirmed that the WAL-reset corruption bug affects SQLite through 3.51.2 under concurrent cross-thread or cross-process writes/checkpoints. Node.js 22.13.0 bundles SQLite 3.47.2, so that floor is unsafe for this project's required multi-process WAL mode. The user explicitly approved raising the minimum.

## Decision
Require Node.js 22.22.3 or newer and fail closed unless SELECT sqlite_version() returns SQLite 3.51.3 or newer, node:sqlite loads successfully, WAL actually activates, FTS5 functions, and the required PRAGMA and transaction probes pass. Recommend Node.js 24.16.0 or newer within the supported Node.js 24 LTS line. Do not provide a reduced single-writer or non-WAL production fallback.

## Consequences
- package.json must declare engines.node >=22.22.3 and CI must test the minimum supported Node line plus the recommended Node 24 line.
- Startup and worker initialization must perform functional capability probes; semver alone cannot authorize the event store.
- Unsupported runtimes return SQLITE_CAPABILITY_MISSING before opening or mutating an authoritative project store.
- The architecture specification and Subproject 1 implementation plan use SQLite 3.51.3 as the minimum runtime engine.
