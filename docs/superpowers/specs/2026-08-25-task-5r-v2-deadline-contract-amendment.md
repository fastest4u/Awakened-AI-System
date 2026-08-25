# Task 5R V2 Deadline Contract Amendment

**Status:** Draft for written user review — amendment direction approved 2026-08-25

**Amends:** [Task 5R Release-Gate Deadline Stabilization Design](2026-08-25-task-5r-deadline-stabilization-design.md)

## Reason for amendment

The approved Task 5R design requires both coordinators to fail closed when a
caller supplies a zero or elapsed deadline.  Preflight inspection found that
`V2ProjectionBuildCoordinator.ensurePublished` currently reconciles and then
returns an already-sufficient generation before it calls `#assertDeadline`.
Therefore a `deadlineMs` of zero can receive a successful V2 result.  The V1
coordinator performs its deadline assertion before the equivalent return.

This is a production contract divergence, not the host-speed-sensitive test
budget issue addressed by the original Task 5R design.  It must be corrected
before the test-only stabilization can establish a valid release gate.

## Exact V2 behavior

Within the existing V2 publication lock and after the existing durable entry
reconciliation and observed-generation persistence complete, V2 must invoke:

```ts
this.#assertDeadline(expiresAt, requiredEventPosition, current);
```

immediately before evaluating whether `current` already satisfies
`requiredEventPosition`.  Thus its effective ordering is:

```ts
const current = this.#persistObservedGeneration(
  binding,
  reconciled.current,
  reconciled.highestObservedGeneration,
  identity,
);
this.#assertDeadline(expiresAt, requiredEventPosition, current);
if (current !== null && BigInt(current.manifest.terminalEventPosition) >= requiredEventPosition) {
  return current;
}
```

The reconciliation, cooperative-lock ownership/release, `current` loading,
available-position value, error type, and the later deadline checks around
source, build, verification, and manifest publication remain unchanged.  The
change must not move reconciliation outside its lock or add a new timer,
retry, fallback deadline, or time source.

## Deterministic regressions

Add V2 coordinator tests beside the existing V1 deadline tests in
`tests/projection-coordinator.test.ts`.

1. Publish a real V2 generation under the named functional test deadline.
   Advance the coordinator's injected `now` value, then request that already
   sufficient generation with `deadlineMs = 0`.  The call must reject with
   `ProjectionLagError`, report the requested and available positions as the
   published position, open no source snapshot, invoke no builder, and leave
   the manifest bytes unchanged.
2. Repeat the existing-generation assertion using a controlled clock that is
   valid while computing `expiresAt` and equal to `expiresAt` at the V2
   post-reconciliation assertion.  A positive caller deadline must also fail
   closed without a source or builder call.
3. Retain the existing V1 zero-deadline tests unchanged.  They remain the
   compatibility reference and must continue to pass.

The first V2 test is intentionally RED against the pre-amendment source: its
current fast path returns the published generation.  It becomes green only
when the assertion ordering above is present.

## Interaction with functional deadline stabilization

After the V2 contract regression is fixed, Task 5R still performs the
approved test-only classification of fixed 2,000-ms calls.  Ordinary V1/V2
filesystem, SQLite, reconciliation, manifest, lease-fixture, and
candidate-fixture scenarios use the test-local
`FUNCTIONAL_TEST_DEADLINE_MS = 15_000`.  Dedicated deadline tests retain zero,
controlled-elapsed, and slow-operation inputs; they must never use the
functional test deadline merely to avoid an assertion.

## Boundaries and release proof

This amendment permits only:

- `src/orchestrator/projections/coordinator.ts`, for the single V2 assertion
  ordering correction; and
- `tests/projection-coordinator.test.ts`, `tests/v2-reader-lease.test.ts`,
  and `tests/v2-retrieval-candidates.test.ts`, only for deterministic
  deadline and functional-test budget coverage.

It does not change V1 behavior, public interfaces, V2 evaluator leasing,
production timeout values, release scripts, routing, deployment, or canary
state.  It does not relax the caller-owned deadline contract.

Verification must first demonstrate the new V2 existing-generation regression
fails on the pre-fix ordering.  After the minimal correction, it must pass
with `npm run test:build`, the compiled coordinator suite, the V2 lease and
candidate suites, and three fresh successful serial executions of
`npm run test:subproject-3` (allowing only the established Windows symlink
capability skip).  Independent review must confirm that the only `src/`
behavior change is the V2 check-before-return ordering.
