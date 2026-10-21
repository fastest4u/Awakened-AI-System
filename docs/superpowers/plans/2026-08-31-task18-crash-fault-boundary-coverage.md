# Task 18 Crash Fault Boundary Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two Task 18 crash tests exercise the correct durable boundaries, including the missing post-write final-checkpoint crash window.

**Architecture:** A `workflow-recovery` operation is executed by `LifecycleOperationalStore`, whose durable boundary is `workflow-phase`; the direct fixture must select that boundary rather than `ownership-recovery`. A final checkpoint row already faults before its SQL update but omits the symmetric `after-write-before-commit` hit. Add exactly that fault hit after a one-row update and preserve the existing transaction rollback semantics.

**Tech Stack:** TypeScript, Node test runner, forked lifecycle fixture, SQLite transaction repository.

**Spec:** `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/task-8-report.md` and the Task 18 durable fault matrix in `src/orchestrator/lifecycle/lifecycle-faults.ts`.

## Global Constraints

- The `after-write-before-commit` hook must run only after `changed(result)` confirms one final-checkpoint row changed and before the caller's enclosing transaction commits.
- Preserve existing `before-write` behavior, compare-and-set predicates, and rollback behavior.
- The recovery fixture must request only the declared `workflow-phase`/`after-commit-before-response` pair.
- Do not change V2 routing, deployment configuration, or production database schema.
- Preserve the sealed evaluator source-diff gate: its explicit allowlist must include every approved production remediation after the sealed baseline and no other source path.

---

### Task 1: Correct the recovery fixture to the operational durable boundary

**Files:**
- Modify: `tests/fixtures/project-store-lifecycle-child.ts:167-187,421-431`
- Modify: `tests/lifecycle.crash.test.ts:601-612`

**Interfaces:**
- Consumes: `LifecycleOperationalStore.operationalFaultBoundary`, which returns `workflow-phase` for `kind: "workflow-recovery"`.
- Produces: a forked fixture that exits after the committed operational recovery response-loss boundary and retries read-only recovery safely.

- [ ] **Step 1: Express the expected boundary in the recovery test**

  Change the fault request to:

  ```ts
  boundary: "workflow-phase",
  point: "after-commit-before-response",
  ```

  The test should continue to require a fixture-exit rejection, then verify the retry is `readOnly` and the empty store remains empty.

- [ ] **Step 2: Run the recovery test and verify RED**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="retries one real fenced recovery" dist-test/tests/lifecycle.crash.test.js
  ```

  Expected before fixture support: failure from `FIXTURE_PROTOCOL_ERROR`, because `selectDirectFault` accepts only `ownership-recovery`.

- [ ] **Step 3: Allow the one declared workflow-phase pair in the direct fixture**

  Broaden the direct-fault discriminated type to `"ownership-recovery" | "workflow-phase"`; retain `ownership-recovery`'s existing SQLite point set and accept only `workflow-phase` with `after-commit-before-response`. The fault injector remains generic and exits only when both selected boundary and point match.

- [ ] **Step 4: Rebuild and verify recovery is green**

  Run the Step 2 command. Expected: 1 pass, 0 fail.

### Task 2: Add the missing final-checkpoint post-write fault hook

**Files:**
- Modify: `src/orchestrator/storage/session-end.repository.ts:1981-2037`
- Test: `tests/lifecycle.crash.test.ts:893-995`

**Interfaces:**
- Consumes: `LifecycleFaultInjector.hit(boundary, point, context)` and `SessionEndWorkflowRepository.recordFinalCheckpoint`.
- Produces: a real-process failure at both `final-checkpoint/before-write` and `final-checkpoint/after-write-before-commit`, followed by a fenced retry that records exactly one final checkpoint.

- [ ] **Step 1: Run the existing final-checkpoint crash test to verify RED**

  Run:

  ```text
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="crashes at every pre-commit" dist-test/tests/lifecycle.crash.test.js
  ```

  Expected: failure for `after-write-before-commit` with a fulfilled fixture mutation; the `before-write` iteration already exits.

- [ ] **Step 2: Add the minimal symmetric post-write hook**

  Immediately after `if (!changed(result)) throw new LifecycleError("EVENT_CONFLICT");`, call:

  ```ts
  this.#faultInjector.hit("final-checkpoint", "after-write-before-commit", {
    projectId: projectId as LifecycleFaultContext["projectId"],
    sessionId: sessionId as LifecycleFaultContext["sessionId"],
    workflowId: workflowId as LifecycleFaultContext["workflowId"],
    commandId: rootCommandId,
    idempotencyKeyHash: null,
    workId: null,
    eventPosition: checkpointEventPosition.toString(),
    materializationRevision: null,
  });
  ```

  Do not alter the update SQL or post-write workflow state.

- [ ] **Step 3: Rebuild and verify both crash cases are green**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="retries one real fenced recovery|crashes at every pre-commit" dist-test/tests/lifecycle.crash.test.js
  ```

  Expected: 2 pass, 0 fail.

- [ ] **Step 4: Run Task 18 crash coverage and commit**

  Run:

  ```text
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle.crash.test.js
  git add -- src/orchestrator/storage/session-end.repository.ts tests/fixtures/project-store-lifecycle-child.ts tests/lifecycle.crash.test.ts
  git commit -m "fix: cover Task 18 recovery crash boundaries"
  ```

### Task 3: Register the approved final-checkpoint remediation in the sealed source-diff gate

**Files:**
- Modify: `tests/ci-lifecycle-gates.test.ts:41-45,738-746`

**Interfaces:**
- Consumes: the sealed evaluator baseline `68e77fa10165c99243ded1e8c1c80d1e0f7da92f` and Git's sorted `diff --name-only` output for `src`.
- Produces: a strict allowlist containing exactly the earlier approved Task 8 Git timeout remediation and this approved Task 18 final-checkpoint hook.

- [ ] **Step 1: Prove the sealed-diff gate is RED after Task 2**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="Subproject 3 evaluation and projection runtime remain internal-only" dist-test/tests/ci-lifecycle-gates.test.js
  ```

  Expected before the test-only allowlist update: the source diff contains both `src/orchestrator/identity/git-workspace.resolver.ts` and `src/orchestrator/storage/session-end.repository.ts`, while the gate permits only the former.

- [ ] **Step 2: Make the smallest strict allowlist update**

  Rename `APPROVED_TASK_EIGHT_SEALED_SOURCE_DIFF` to an accurate remediation-neutral name, include exactly:

  ```ts
  "src/orchestrator/identity/git-workspace.resolver.ts",
  "src/orchestrator/storage/session-end.repository.ts",
  ```

  Keep lexical order to match `git diff --name-only`. Update the assertion diagnostic to name the approved sealed-source remediations rather than only Task 8. Do not weaken the command, base, assertion, or empty-diff behavior.

- [ ] **Step 3: Rebuild and verify the focused CI gate is GREEN**

  Rerun the Step 1 command. Expected: 1 pass, 0 fail.

- [ ] **Step 4: Commit the sealed-gate correction**

  Commit only `tests/ci-lifecycle-gates.test.ts` with a focused message such as `test: register final checkpoint remediation in sealed gate`.

### Task 4: Bound observer bootstrap pressure without weakening the 32-process proof

**Files:**
- Modify: `tests/lifecycle.concurrent.test.ts:575-667`

**Interfaces:**
- Consumes: `LifecycleFixtureClient.ready`, `start`, `mutation`, and `close`, plus the existing real `workflow-recovery` operation.
- Produces: 32 live real observer processes that all execute the same read-only fenced recovery concurrently after their Git-backed bootstrap is admitted in bounded batches.

- [ ] **Step 1: Record the release-gate RED and isolate the symptom**

  The full `npm test` gate failed at this test with `GIT_PROBE_FAILED`: both the initial Git spawn and the already approved one retry returned `ETIMEDOUT` while 32 observers started at once. The same compiled test passed in isolation, proving a full-suite resource-spike flake rather than a semantic Git classification failure.

- [ ] **Step 2: Separate bounded bootstrap from concurrent recovery**

  Retain exactly 32 `LifecycleFixtureClient` instances. Construct and start them in fixed batches of four, with no sleeps, backoff, extra Git retry, or mutation during bootstrap. Once all 32 have returned `started`, dispatch all 32 existing `workflow-recovery` mutations with one `Promise.all`, then close all observers. Keep every current root/child authority and row-count assertion.

  This must preserve (and strengthen) the proof: all 32 real processes are live for the simultaneous recovery operations; only external Git bootstrap pressure is bounded.

- [ ] **Step 3: Rebuild and verify repeated focused stability**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="keeps thirty-two real process observers" dist-test/tests/lifecycle.concurrent.test.js
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="keeps thirty-two real process observers" dist-test/tests/lifecycle.concurrent.test.js
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="keeps thirty-two real process observers" dist-test/tests/lifecycle.concurrent.test.js
  ```

  Expected: each run passes. The test must still prove 32 observer responses, immutable event/command/session-authority counts, root owner generation `1`, and root state `active`.

- [ ] **Step 4: Commit the scoped test orchestration remediation**

  Commit only `tests/lifecycle.concurrent.test.ts` with a focused message such as `test: stage Task 18 observer bootstrap`.

## Plan self-review

- Spec coverage: recovery's boundary mismatch is Task 1; the missing final-checkpoint post-write fault is Task 2; Task 3 retains the evaluator's strict source-diff seal while registering that approved hook; Task 4 removes only the full-suite Git bootstrap spike while preserving 32 simultaneous real-process recoveries.
- Placeholder scan: exact files, fault pairs, command lines, expected outputs, baseline, sorted paths, batch size, and no-sleep/no-extra-retry constraints are specified.
- Type consistency: both names (`workflow-phase`, `final-checkpoint`) are members of `LifecycleDurableBoundary`, the selected points are already declared in `LifecycleFaultPoint`, the source-diff paths are exact canonical repo-relative paths, and each observer continues to use the existing fixed operation wire.
