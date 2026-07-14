---
title: Adopt a Strictly Isolated Full Event-Sourced Project Memory Orchestrator
type: adr
status: superseded
decision-date: "2026-07-11"
confidence: high
supersedes: []
created: "2026-07-11"
updated: "2026-07-14"
tags:
  - architecture
  - event-sourcing
  - project-isolation
  - session-lifecycle
  - retrieval
  - sqlite
  - memory-v2
---
## Context
The current lifecycle service holds one process-global active session. Concurrent primary and sub-agent starts therefore supersede each other, allowing a primary end call to close the wrong session. Markdown-first persistence and heuristic retrieval also lack explicit per-project, per-workspace, temporal, provenance, and idempotency boundaries needed for maximum cross-session accuracy.

## Decision
Adopt a Node.js 22.13+ (Node.js 24 recommended) full event-sourced memory orchestrator. Each logical project receives an isolated SQLite/WAL append-only event store and encrypted raw-evidence store. Identity is explicit across project, workspace/worktree, session, parent session, continuity key, agent, client, correlation, and causation. Only the primary agent owns the root lifecycle; sub-agents use child streams and return durable results without superseding or closing the root. Deterministic projections power canonical facts, decisions, tasks, artifacts, graph, temporal state, sessions, and hybrid provenance-aware retrieval. Cross-project reads are denied by default; global memory is a separate scope populated only by explicit promotion and read only through opt-in. Rollout is non-destructive and reversible through off, shadow, and primary modes.

## Consequences
- Eliminates session ownership inversion and makes replay, audit, correction, checkpointing, and crash recovery deterministic.
- Prevents cross-project contamination by enforcing identity before retrieval and storage.
- Improves retrieval accuracy through canonical temporal projections, hybrid ranking, provenance, contradiction handling, and feedback.
- Raises the minimum supported Node.js runtime to 22.13+, with Node.js 24 recommended.
- Adds operational complexity for schema migrations, projections, encryption keys, backups, event compaction views, and parity evaluation.
- Retains encrypted raw evidence permanently by default until explicit cryptographic erasure, increasing storage and privacy responsibilities.
- Requires a staged migration and shadow parity gate before primary cutover; legacy vault data remains available for rollback.
