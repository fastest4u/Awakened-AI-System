# Task 5R Release-Gate Deadline Stabilization Design

**Status:** Draft for written user review — design direction approved 2026-08-25

**Scope:** Subproject 3 release gate only; test code only unless a controlled
deadline regression proves a production defect.

## Purpose

The Subproject 3 release gate is not currently deterministic.  Its serial test
run has reported `PROJECTION_LAG` from ordinary V1 and V2 filesystem, SQLite,
reconciliation, and manifest-publication scenarios.  The common condition is a
fixed 2,000 ms caller deadline used by 52 test calls, not a demonstrated
functional failure: one failing V1 case had already reached its required event
position when its two-second budget expired.

Task 5R separates functional behavior tests from deadline-contract tests.  It
must make the gate reliable without widening, removing, or otherwise changing
the production deadline contract.

## Production contract that must not change

`DefaultProjectionBuildCoordinator.ensurePublished` and
`V2ProjectionBuildCoordinator.ensurePublished` keep their existing
caller-supplied `deadlineMs` semantics.  A zero or elapsed deadline continues
to fail closed with `PROJECTION_LAG`; a build, source snapshot, verification,
or publication that crosses the caller's deadline must not report success.

Task 5R must not edit `src/orchestrator/projections/**` merely to make a test
run faster or less strict.  It must not add a production fallback deadline,
remove deadline checks, alter timeout error mapping, or conceal a genuine
production timing failure.

## Test design

### Functional scenarios

The affected test files will define a test-local named constant,
`FUNCTIONAL_TEST_DEADLINE_MS`, with an initial value of **15,000 ms**.  It is a
generous harness budget, not a product SLA, export, configuration setting, or
runtime default.

Before changing calls, the implementation will inventory every current
2,000-ms `ensurePublished` invocation and classify it as either functional or
deadline-specific.  Only functional scenarios receive the named test value.
These include normal source publication, V1/V2 reconciliation, manifest
adoption, retention, V2 lease fixtures, and candidate-adapter setup.  The
implementation may use a narrowly scoped test helper when it improves that
classification, but it must not hide the actual required event position or
binding under an ambiguous wrapper.

### Deadline-specific scenarios

Dedicated tests retain a deliberately small or controlled deadline and prove
the production contract independently of host filesystem and SQLite speed.

The existing V1 tests for a zero deadline, a source/build operation that
crosses expiry, and cleanup of an active source snapshot remain explicit.
Task 5R adds or strengthens equivalent V2 coverage using its existing injected
clock/test seams so expiry is deterministic rather than dependent on real
wall-clock load.  The V2 assertions must establish that no successful manifest
authority is published after expiry and that the error is `PROJECTION_LAG`.

The test suite must continue to distinguish these outcomes:

1. a functional publication succeeds within its generous *test* budget;
2. a caller that provides a zero or controlled-elapsed deadline receives the
   correct fail-closed lag result; and
3. a completed result is never returned after the caller deadline is known to
   have elapsed.

## Allowed files and boundaries

The planned implementation is limited to test files, initially:

- `tests/projection-coordinator.test.ts`
- `tests/v2-reader-lease.test.ts`
- `tests/v2-retrieval-candidates.test.ts`, only if its fixture inventory
  contains an affected functional deadline

No runtime source, release-gate script, production configuration, routing, or
Version 1/V2 public interface changes are expected.  If a deterministic
deadline test exposes an actual coordinator defect, implementation stops and a
new production-code design amendment is required before changing `src/`.

## Verification and release gate

The Task 5R implementation is acceptable only when all of the following fresh
checks pass:

1. `npm run test:build`;
2. the compiled coordinator deadline suite, including its V1 and V2 controlled
   deadline cases, run serially at least three times;
3. the compiled V2 reader-lease and candidate-adapter suites run serially at
   least three times; and
4. `npm run test:subproject-3` completes successfully on three fresh serial
   runs.  The known Windows symlink capability skip is allowed only when it is
   reported as a skip, not as a failure.

The implementation must inspect the final diff to confirm that it contains no
`src/` or production-configuration change, and an independent code review must
confirm both the deadline contract and the V1/V2 boundary remain intact.

## Non-goals and next gate

Task 5R does not make Version 2 primary traffic-ready by itself.  It resolves
the red Subproject 3 release gate required before Task 6 (custom-ranker
bounds), Task 7 (sealed evaluation), Subproject 4 privacy/retention controls,
and Subproject 5 migration, shadow, recovery, rollback, and progressive
cutover gates.

No deployment, routing change, or canary progression is authorized by this
test-only task.
