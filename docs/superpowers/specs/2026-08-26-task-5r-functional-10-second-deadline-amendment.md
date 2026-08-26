# Task 5R Functional 10-Second Deadline Amendment

**Status:** Design approved by user 2026-08-26; pending written-spec review

**Amends:**

- [Task 5R Release-Gate Deadline Stabilization Design](2026-08-25-task-5r-deadline-stabilization-design.md)
- [Task 5R V2 Deadline Contract Amendment](2026-08-25-task-5r-v2-deadline-contract-amendment.md)

## Context

Task 5R correctly replaced the inventoried 52 fixed 2,000-ms functional
`ensurePublished` calls with the test-local
`FUNCTIONAL_TEST_DEADLINE_MS = 15_000` budget. Its V2 deadline and
publication-lock regressions are deterministic and pass.

The third required fresh serial `test:subproject-3` run nevertheless failed.
`persists a retired V2 generation high-water across reconciliation and
coordinator restart` expected its injected `post-install` fault but received
`PROJECTION_LAG` first. The failing call still used a literal 10,000-ms
deadline. An isolated rerun passed, while two prior complete serial gates
passed, establishing a host-load-sensitive functional harness failure rather
than a reproducible production deadline-contract defect.

The coordinator suite still contains 29 one-line
`ensurePublished(..., 10_000)` calls. They are ordinary publication,
reconciliation, retention, restart, source-unavailable, and fault-injection
scenarios; none is a dedicated assertion of a caller-provided deadline.

## Decision

Classify all 29 remaining literal 10,000-ms coordinator calls as functional
test scenarios. Replace only their deadline argument with the existing
test-local `FUNCTIONAL_TEST_DEADLINE_MS` constant, whose value remains
**15,000 ms**. Do not add a second timeout value, helper, configuration, or
production fallback.

The existing Task 5R test-local constant remains a harness budget only. It is
not a product SLA, public API default, release-script setting, or routing
control.

## Required boundaries

The amendment authorizes changes only to:

- `tests/projection-coordinator.test.ts`

It does not authorize changes to runtime source, `package.json`, release
scripts, CI workflow, production configuration, V1 or V2 public interfaces,
routing, deployment, or canary behavior.

All deliberate deadline-contract tests stay literal and unchanged, including
zero, one, and five millisecond V1/V2 controlled deadlines. The V2 retrieval
candidate fixture remains at its independent `1_000` value. Existing
`5_000`-ms inputs are outside this evidence-led amendment and remain
unchanged.

## Implementation and test evidence

Before changing code, inventory the 29 literal 10,000-ms calls with:

```powershell
rg -n "ensurePublished\([^\n]*10_000" tests/projection-coordinator.test.ts
```

After replacement, the same search must print no matches and return exit 1.
The existing 2,000-ms inventory across coordinator, reader-lease, and
candidate suites must also remain empty. A targeted search must confirm the
controlled `0`, `1`, and `5` calls are unchanged.

The implementation must run:

1. `npm run test:build`;
2. the retired-high-water regression serially at least three times;
3. the complete compiled coordinator suite serially at least three times;
4. `npm run typecheck`; and
5. `npm run test:subproject-3` on three fresh serial runs.

For each complete gate, only the established Windows `EPERM` symlink
capability skip is permitted. Any failed executable test blocks Task 5R.

## Review and release condition

Independent specification and code-quality reviews must confirm that all 29
replacements are functional test calls, that controlled deadline coverage is
untouched, and that no runtime or release configuration changed. Task 5R is
release-gate-ready only after every required gate and review is green.

This amendment still does not authorize V2 primary routing, deployment, or a
general PROD-ready claim.
