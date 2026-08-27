# Task 5R deterministic V1 source-snapshot deadline controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make the two V1 5-ms source-snapshot deadline controls deterministic without changing their deadline contract, preserve the approved 29-call functional amendment, and close the Task 5R release gate with independent review and repeated evidence.

**Architecture:** Production coordinator code remains unchanged. Test-local deferred promises prove that V1 reached openCommittedSnapshot or builder.build before the existing timer may settle the request. The existing now seam returns zero so synchronous pre-open work cannot consume wall-clock time; the real 5-ms timer remains the deadline authority once the intended async phase has started.

**Tech Stack:** TypeScript 5.8, Node.js 24 built-in test runner, Node SQLite fixtures, npm scripts, Git.

---

## File map

- Modify: tests/projection-coordinator.test.ts:467-1435,2342-2402
  - Preserve the uncommitted 29 replacements from 10_000 to FUNCTIONAL_TEST_DEADLINE_MS.
  - Replace only the two V1 5-ms fixture bodies with local milestones.
- Create: docs/superpowers/plans/2026-08-27-task-5r-v1-snapshot-deadline-milestones.md
- Do not modify: src, package.json, CI, release scripts, routing, deployment configuration, public APIs, or any other test file.

### Task 1: Synchronize both V1 5-ms fixture phases and preserve the 29-call functional amendment

**Files:**
- Modify: tests/projection-coordinator.test.ts:2342-2402
- Test: tests/projection-coordinator.test.ts:2342-2402

- [ ] **Step 1: Establish exact pre-edit boundaries and record RED evidence**

Run from C:\Users\Server\.codex\worktrees\subproject-3-projections:

~~~powershell
$functional = @(rg -n "ensurePublished\([^\n]*FUNCTIONAL_TEST_DEADLINE_MS" tests/projection-coordinator.test.ts)
if ($functional.Count -ne 29) { throw "Expected 29 prepared functional substitutions, got $($functional.Count)" }
rg -n "ensurePublished\([^\n]*(0|1|5)\)" tests/projection-coordinator.test.ts
rg -n "ensurePublished\([^\n]*1_000" tests/v2-retrieval-candidates.test.ts
rg -n "ensurePublished\([^\n]*5_000" tests/projection-coordinator.test.ts
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="bounds a slow source snapshot" dist-test/tests/projection-coordinator.test.js
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="closes an active source snapshot" dist-test/tests/projection-coordinator.test.js
~~~

Expected: functional count is 29 and protected controls remain. The slow-source test is the known RED reproduction (0 !== 1). The active-source test can pass alone because its race needs full-suite timing; do not treat that as proof that its rejected promise is safe.

- [ ] **Step 2: Make the slow-source test wait for source entry, then return a late snapshot after the outer request rejects**

Replace the setup and assertions in the test named bounds a slow source snapshot and closes its late result without invoking the builder with this exact shape. Keep its literal caller deadline 5.

~~~ts
let resolveSourceOpened = (): void => undefined;
const sourceOpened = new Promise<void>((resolve) => { resolveSourceOpened = resolve; });
let resolveLateSnapshot = (_snapshot: ProjectionEventSnapshot): void => undefined;
const lateSnapshot = new Promise<ProjectionEventSnapshot>((resolve) => { resolveLateSnapshot = resolve; });
let resolveClosed = (): void => undefined;
const closedOnce = new Promise<void>((resolve) => { resolveClosed = resolve; });
const eventReader: ProjectionEventReader = {
  async openCommittedSnapshot() {
    resolveSourceOpened();
    return lateSnapshot;
  },
};
const coordinator = new DefaultProjectionBuildCoordinator({
  projectionDirectory: join(root, "projections"),
  eventReader,
  builder: {
    async build() {
      builds += 1;
      throw new Error("late builder must not run");
    },
  },
  now: () => 0,
});

const publication = coordinator.ensurePublished(BINDING, 1n, 5);
await sourceOpened;
await assert.rejects(
  publication,
  (error: unknown) => error instanceof ProjectionLagError,
);
resolveLateSnapshot(emptySnapshot(() => {
  closed += 1;
  resolveClosed();
}));
await closedOnce;
assert.equal(closed, 1);
assert.equal(builds, 0);
~~~

The ordering is source-open reached → real 5-ms timer rejects outer request → test provides late snapshot → expired coordinator closes it. Do not retain the old 35-ms or 50-ms arbitrary waits.

- [ ] **Step 3: Make the active-source test wait for builder entry and settle its blocked builder without rejection**

Replace the setup and assertions in the test named closes an active source snapshot as soon as the build deadline expires with this exact shape. Keep its literal caller deadline 5.

~~~ts
let resolveBuilderEntered = (): void => undefined;
const builderEntered = new Promise<void>((resolve) => { resolveBuilderEntered = resolve; });
let resolveBuild = (_built: BuiltProjectionGeneration): void => undefined;
const blockedBuild = new Promise<BuiltProjectionGeneration>((resolve) => { resolveBuild = resolve; });
let resolveBuildReturned = (): void => undefined;
const buildReturned = new Promise<void>((resolve) => { resolveBuildReturned = resolve; });
const coordinator = new DefaultProjectionBuildCoordinator({
  projectionDirectory: join(root, "projections"),
  eventReader: {
    async openCommittedSnapshot() {
      return emptySnapshot(() => { closed += 1; });
    },
  },
  builder: {
    async build() {
      resolveBuilderEntered();
      try {
        return await blockedBuild;
      } finally {
        resolveBuildReturned();
      }
    },
  },
  now: () => 0,
});

const publication = coordinator.ensurePublished(BINDING, 1n, 5);
await builderEntered;
await assert.rejects(
  publication,
  (error: unknown) => error instanceof ProjectionLagError,
);
assert.equal(closed, 1);
resolveBuild(undefined as unknown as BuiltProjectionGeneration);
await buildReturned;
await new Promise<void>((resolve) => setImmediate(resolve));
~~~

Do not reject blockedBuild: when builder entry did not occur its rejection would have no consumer. Resolving it after the outer deadline rejection lets the existing inner deadline/finally cleanup settle. The coordinator checks expired state before consuming the placeholder build result.

- [ ] **Step 4: Compile and exercise each controlled behavior three times**

~~~powershell
npm run test:build
foreach ($attempt in 1..3) {
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="bounds a slow source snapshot" dist-test/tests/projection-coordinator.test.js
  if ($LASTEXITCODE -ne 0) { throw "Slow-source focused attempt $attempt failed" }
}
foreach ($attempt in 1..3) {
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="closes an active source snapshot" dist-test/tests/projection-coordinator.test.js
  if ($LASTEXITCODE -ne 0) { throw "Active-source focused attempt $attempt failed" }
}
~~~

Expected: each invocation has 1 pass and 0 failures. A failure blocks the task; do not alter the 5-ms literal or production code.

- [ ] **Step 5: Verify boundaries, repeat the coordinator gate, and commit the complete test-only diff**

~~~powershell
rg -n "ensurePublished\([^\n]*(2_000|10_000)" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
if ($LASTEXITCODE -ne 1) { throw "Unexpected literal functional deadline remains" }
rg -n "ensurePublished\([^\n]*(0|1|5)\)" tests/projection-coordinator.test.ts
rg -n "ensurePublished\([^\n]*1_000" tests/v2-retrieval-candidates.test.ts
rg -n "ensurePublished\([^\n]*5_000" tests/projection-coordinator.test.ts
foreach ($attempt in 1..3) {
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-coordinator.test.js
  if ($LASTEXITCODE -ne 0) { throw "Coordinator attempt $attempt failed" }
}
npm run typecheck
git diff --check
git diff --name-only
git add -- tests/projection-coordinator.test.ts
git commit -m "test: stabilize projection deadline fixtures"
~~~

Expected: every coordinator attempt reports 62 passing, 0 failing, and 0 skipped. The only staged code file is tests/projection-coordinator.test.ts; its diff is exactly the approved 29 functional substitutions plus the two milestone fixtures.

### Task 2: Independent Task 1 specification review, then independent code-quality review

**Files:**
- Review: tests/projection-coordinator.test.ts:467-1435,2342-2402
- Review: docs/superpowers/specs/2026-08-26-task-5r-functional-10-second-deadline-amendment.md
- Review: docs/superpowers/specs/2026-08-27-task-5r-v1-snapshot-deadline-milestones.md

- [ ] **Step 1: Dispatch a fresh specification reviewer**

The reviewer approves only if all conditions are true:

- Exactly one implementation file changed: tests/projection-coordinator.test.ts.
- Exactly 29 functional arguments use existing FUNCTIONAL_TEST_DEADLINE_MS; no ensurePublished argument remains literal 2_000 or 10_000 in the three covered suites.
- The two named V1 fixtures retain literal 5, use local source-open/builder-enter synchronization, omit arbitrary fixture delay waits, and prove close/no-builder or close/consumed-builder behavior.
- Protected 0, 1, 5, 1_000, and 5_000 tests remain; no runtime/API/routing/CI/release/deployment file changed.

The reviewer reports APPROVED or concrete file/line findings. Do not start quality review until specification review is approved.

- [ ] **Step 2: Dispatch a fresh code-quality reviewer**

After specification approval, inspect deferred-promise lifecycle, unhandled-rejection risk, assertions, cleanup behavior, TypeScript safety, serial-test isolation, and recorded gates. Any finding returns to the original implementer and requires a re-review.

### Task 3: Re-run the complete Task 5R release gate and independently review the evidence

**Files:**
- Review only: src/orchestrator/projections/coordinator.ts
- Review only: tests/projection-coordinator.test.ts
- Review only: tests/v2-reader-lease.test.ts
- Review only: tests/v2-retrieval-candidates.test.ts

- [ ] **Step 1: Audit final allowed boundaries**

~~~powershell
git diff --name-only 7f97a8b..HEAD -- src tests package.json
git diff --unified=20 7f97a8b..HEAD -- src/orchestrator/projections/coordinator.ts
rg -n "ensurePublished\([^\n]*(2_000|10_000)" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
if ($LASTEXITCODE -ne 1) { throw "Unexpected functional literal deadline remains" }
git diff --check 7f97a8b..HEAD
npm run typecheck
~~~

Expected: the source change remains the previously approved V2 ordering fix, whose order is persistence → retainLock false → deadline assertion → V2 sufficient-generation return. No V1 runtime, API, timer, routing, or release configuration diff is allowed.

- [ ] **Step 2: Run the full release gate three times serially**

~~~powershell
foreach ($attempt in 1..3) {
  npm run test:subproject-3
  if ($LASTEXITCODE -ne 0) { throw "Subproject 3 release-gate attempt $attempt failed" }
}
~~~

Expected per attempt: main test stage has 250 tests, 249 passing, 0 failures, with only the established Windows EPERM symlink skip; retrieval evaluation is 6/6 and CI lifecycle gates are 9/9. Stop at the first failure, report exact evidence, and do not widen a deadline budget.

- [ ] **Step 3: Dispatch fresh specification and code-quality reviewers for release evidence**

Specification review confirms the release evidence satisfies both approved specifications. Quality review audits final scope and command results. Findings return to the original implementer/release-gate agent and require re-review.

### Task 4: Final independent review and bounded Task 5R handoff

**Files:**
- Review: all commits from 7f97a8b through HEAD

- [ ] **Step 1: Dispatch a final independent reviewer**

Require evidence-backed approval that the two milestone tests and 29 functional substitutions are exactly in approved test scope; the V2 source fix preserves ordinary lock release and enforces deadline before V2 existing-generation return; all per-task reviews passed; and all three full release-gate attempts are green.

- [ ] **Step 2: Complete verification and prepare branch integration options**

Use superpowers:verification-before-completion with the recorded current evidence, then use superpowers:finishing-a-development-branch. Report Task 5R release-gate completion only if every review and gate is green. Do not deploy, route V2 traffic, or claim whole-product production readiness without a separately approved cutover task.
