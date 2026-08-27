# Task 6 Custom-Ranker Bounds Amendment

**Status:** Design approved by user 2026-08-27; pending written-spec review

**Amends:**

- [Subproject 3 Final-Review Remediation Design](2026-08-24-subproject-3-final-review-remediation-design.md)
- [Subproject 3 Final-Review Remediation Plan](../plans/2026-08-24-subproject-3-final-review-remediation.md), Task 6

## Context

Task 6 requires every retrieval path to apply the same result limit, token
budget, diversity, conflict, drop-accounting, and explanation constraints. The
current `RetrievalRanker` contract instead accepts the pre-fusion collection
and returns a completed `InternalRetrievalResult`. That custom path bypasses
`selectRankedCandidates`, has no conflict output, and provides separate
candidate/truncation accounting.

Preflight also found that `RetrievalRanker` is declared in
`src/orchestrator/retrieval/contracts.ts`, which was omitted from the original
Task 6 file list. The contract must move to the ranking boundary and the
retrieval error-code union must cover invalid custom output.

## Decision

The custom-ranker seam is an internal ordering hook only. It receives the
already filtered and fused candidates and returns the same candidate objects in
the desired order. It cannot add, mutate, duplicate, remove, or otherwise
replace candidates.

The retrieval service converges before selection:

```text
collect -> filter -> fuse -> default rerank OR validated custom order
        -> one selector -> items, conflicts, drops, explanation
```

The default path provides the fused candidates in default rerank order. The
custom path validates the returned order against that same fused set. The
shared selector then consumes the ordering as supplied; it must not sort again.
It still enforces diversity, result count, token budget, conflict closure, and
truncation exactly once for both paths.

## Contract and validation

`src/orchestrator/retrieval/ranking.ts` becomes the owner of the internal
ranker contract because it owns `FusedCandidate`:

```ts
export interface RetrievalRanker {
  select(
    eligible: readonly FusedCandidate[],
    request: ValidatedInternalRetrievalRequest,
  ): readonly FusedCandidate[];
}

export function validateCustomRanking(
  ranked: readonly FusedCandidate[],
  eligible: readonly FusedCandidate[],
): readonly FusedCandidate[];
```

`validateCustomRanking` accepts only an output with the same cardinality and
the exact same object identity for every eligible candidate, once each. A
cloned candidate with the same ID is invalid, as are a foreign candidate,
duplicate, omission, or any other replacement. It throws
`InternalRetrievalError("RETRIEVAL_RANKER_INVALID")` on failure.

`src/orchestrator/retrieval/contracts.ts` retains the error class and adds
`"RETRIEVAL_RANKER_INVALID"` to `InternalRetrievalErrorCode`, but no longer
declares `RetrievalRanker`. This contract move also removes its ranker-only
manifest dependency. `service.ts` and `projection-runtime.ts` import the type
from `ranking.ts`.

## Shared selection and result materialization

`selectRankedCandidates` accepts `readonly FusedCandidate[]` and returns the
selected fused candidates plus its existing conflict, token, drop, and
truncation data. It validates duplicate input IDs defensively but preserves
the caller's supplied order. Default reranking remains responsible for putting
its candidates in score order before selection; a custom ranker remains
responsible only for its chosen valid order.

`InternalRetrievalService.retrieve` obtains `items`, `conflicts`,
`candidateCount`, truncation, channel contributions, redacted drop counts, and
the explanation from that one shared selection. It does not accept a completed
custom `InternalRetrievalResult`, synthesize an empty conflict list, or use
custom-ranker-supplied metadata.

## Required scope

This amendment authorizes changes only to:

- `src/orchestrator/retrieval/contracts.ts`
- `src/orchestrator/retrieval/ranking.ts`
- `src/orchestrator/retrieval/service.ts`
- `src/orchestrator/runtime/projection-runtime.ts`
- `tests/retrieval-ranking.test.ts`
- `tests/retrieval-service.test.ts`
- `tests/projection-runtime.test.ts`
- the Task 6 section of `docs/superpowers/plans/2026-08-24-subproject-3-final-review-remediation.md`

Task 6 does not authorize a tool, route, public API, configuration key,
production routing change, deployment, canary, V1 behavior change, or V2
primary-traffic claim.

## Test and acceptance evidence

Tests must first demonstrate the old custom path is unsafe, then prove:

1. a custom ranker receives fused candidates and can reorder their exact
   identities;
2. custom ordering is preserved through selection;
3. the same result limit, token budget, diversity, conflict closure, drop
   accounting, truncation, and explanation bounds apply after custom ranking;
4. foreign, cloned, duplicate, and incomplete output throws
   `RETRIEVAL_RANKER_INVALID`; and
5. the runtime dependency type migrates without widening any public surface.

The focused compiled tests, typecheck, and complete Subproject 3 release gate
must pass. Independent specification review and independent code-quality
review are required before Task 6 can be marked complete. The established
Windows `EPERM` symlink capability skip is the only permitted skip; any failed
executable test blocks completion.

## Review and release boundary

Task 6 is complete only when the amended plan is approved, the implementation
and reviews are green, and the required release gate passes. Completing Task 6
does not make V2 production-primary ready: Task 7 and the separate privacy,
migration, shadow-parity, backup/restore/replay, rollback, and monitored
cutover programs remain required.
