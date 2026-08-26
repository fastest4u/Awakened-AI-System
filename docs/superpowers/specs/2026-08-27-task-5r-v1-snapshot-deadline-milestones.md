# Task 5R: deterministic V1 source-snapshot deadline controls

## Status

Approved design direction. The user directed completion of Task 5 after the release-gate diagnosis and the recommended deterministic-fixture option was presented.

## Problem

The Task 5R functional-deadline amendment is restricted to 29 ordinary V2 coordinator calls and correctly leaves controlled V1 deadline tests unchanged. In the required three serial coordinator runs, two protected 5-ms V1 fixtures failed only when host/filesystem work consumed the deadline before their intended phase:

- The slow-source fixture expected a late snapshot to be closed, but its `openCommittedSnapshot` delay was never entered, so `closed` correctly remained zero.
- The active-source fixture always rejected `blockedBuild` after `ensurePublished` returned. When the deadline elapsed before `builder.build` was entered, that promise was unconsumed and the rejection surfaced as `release blocked build`.

The coordinator's deadline and cleanup behavior is not changed by this amendment. The defects are test-fixture phase races.

## Decision

Keep the two V1 caller deadlines at `5` ms. Make their fixture phases deterministic with test-local synchronization milestones:

1. The slow-source fixture signals when `openCommittedSnapshot` begins. The test waits for that signal before allowing the delayed snapshot to resolve past the existing 5-ms caller deadline. It then asserts `ProjectionLagError`, exactly one late-snapshot close, and no builder invocation.
2. The active-source fixture signals when `builder.build` begins. The test waits for that signal before allowing the existing 5-ms deadline to expire. It then asserts `ProjectionLagError` and exactly one source close. The blocked build promise must be settled without creating an unhandled rejection when the builder did run.

The milestones are test-only promises/deferred controls local to the two existing test bodies. They are not production events, public APIs, timers, shared helpers, or configuration.

## Scope

Allowed implementation file:

- `tests/projection-coordinator.test.ts`

Allowed changes:

- The two tests named `bounds a slow source snapshot and closes its late result without invoking the builder` and `closes an active source snapshot as soon as the build deadline expires`.
- Test-local milestone/deferred mechanics needed only to prove source-open and builder-entry before the existing deadline control is released.
- The already approved, uncommitted 29-call `10_000` to `FUNCTIONAL_TEST_DEADLINE_MS` replacement in the same file remains in scope and must be preserved unchanged.

Explicitly excluded:

- Any `src/` runtime code, including `DefaultProjectionBuildCoordinator`.
- Deadline values: the two control values remain literal `5`; controlled `0` and `1`, candidate `1_000`, and existing `5_000` tests remain unchanged.
- Functional-deadline budgets, config, npm scripts, CI, routing, V2 cutover, public APIs, database schema, deployment, and production environment changes.

## Required assertions

The final tests must prove phase entry rather than infer it from wall-clock delay:

- Slow-source: source-open milestone observed, deadline rejection occurs, late snapshot closes once, and `build` is never called.
- Active-source: builder-enter milestone observed, deadline rejection occurs, source closes once, and the still-running build is settled/observed without an unhandled rejection.
- A run where the intended milestone is not reached is a test-fixture failure, not permission to increase the 5-ms budget.

## Verification and release gate

1. Demonstrate the two tests fail under their current race-prone fixture mechanics before the implementation, using their exact compiled name patterns after `npm run test:build`.
2. Run each exact test serially at least three times after the implementation.
3. Run the full compiled coordinator suite serially three times. Every attempt must finish with 62 passing, 0 failing, 0 skipped tests.
4. Verify `npm run test:build`, `npm run typecheck`, and `git diff --check`.
5. Re-check that the 29 functional calls have no literal `10_000` or `2_000` arguments in the three covered suites, while the protected `0`, `1`, `5`, `1_000`, and `5_000` controls remain.
6. After independent specification and code-quality review, run `npm run test:subproject-3` serially three times. Each must have no failures; only the established Windows symlink `EPERM` skip is permitted, and retrieval evaluation plus CI lifecycle gates must run.

## Completion boundary

This amendment can close Task 5R only if its independent reviews and repeated release gates pass. It does not by itself route V2 as primary, deploy anything, or establish whole-product production readiness.
