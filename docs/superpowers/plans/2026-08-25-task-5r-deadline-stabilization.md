# Task 5R Deadline Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Subproject 3 release gate deterministic while preserving the caller-owned V1 and V2 projection deadline contract.

**Architecture:** First restore V2 parity with V1 by checking the existing caller deadline after locked reconciliation but before returning a sufficient current generation. Then distinguish host-speed-sensitive integration setup from deadline-contract tests with a named, test-local functional deadline. No production timeout, retry, API, routing, or deployment behavior changes.

**Tech Stack:** TypeScript 5.8, Node.js 24 `node:test`, Node `node:sqlite`, immutable SQLite projections, npm scripts.

---

## File map

- `src/orchestrator/projections/coordinator.ts` — V2 publication control flow; the only runtime change is moving the existing `#assertDeadline` before the sufficient-current return.
- `tests/projection-coordinator.test.ts` — existing V1 deadline coverage, V2 coordinator coverage, and the 51 functional 2,000-ms calls; gains a controlled-clock V2 regression and a test-local deadline constant.
- `tests/v2-reader-lease.test.ts` — V2 fixture containing the remaining functional 2,000-ms call; gains only the same test-local deadline constant.
- `tests/v2-retrieval-candidates.test.ts` — inventory only; its V2 fixture uses 1,000 ms, so it must not change.
- `package.json` — verify only; `test:subproject-3` already runs serially and explicitly includes both V2 suites.

### Task 1: Restore V2 deadline enforcement before the sufficient-generation fast path

**Files:**

- Modify: `tests/projection-coordinator.test.ts:249-274,310-341,2217-2379`
- Modify: `src/orchestrator/projections/coordinator.ts:574-679`
- Verify: `tests/v2-reader-lease.test.ts`, `tests/v2-retrieval-candidates.test.ts`

- [ ] **Step 1: Add the named functional deadline and a controlled-clock V2 fixture.**

  Immediately after `NOW` in `tests/projection-coordinator.test.ts`, add:

  ```ts
  const FUNCTIONAL_TEST_DEADLINE_MS = 15_000;
  ```

  Add this fixture beside `publishedV2CoordinatorFixture`; it creates one real
  V2 generation at a stable clock and exposes only the test clock and the
  source/build call counters needed by the deadline assertions:

  ```ts
  interface V2DeadlineFixture {
    readonly source: DatabaseSync;
    readonly coordinator: V2ProjectionBuildCoordinator;
    readonly projectionDirectory: string;
    readonly calls: Readonly<{ sourceSnapshots: number; builds: number }>;
    setNow(now: () => number): void;
  }

  async function v2DeadlineFixture(): Promise<V2DeadlineFixture> {
    const root = mkdtempSync(join(tmpdir(), "projection-v2-deadline-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
    let currentNow: () => number = () => 0;
    let sourceSnapshots = 0;
    let builds = 0;
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: {
        async openCommittedSnapshot(binding) {
          sourceSnapshots += 1;
          return eventReader.openCommittedSnapshot(binding);
        },
      },
      builder: {
        async buildV2(snapshot, generation) {
          builds += 1;
          return builder.buildV2(snapshot, generation);
        },
      },
      now: () => currentNow(),
    });
    await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    return Object.freeze({
      source,
      coordinator,
      projectionDirectory,
      get calls() { return Object.freeze({ sourceSnapshots, builds }); },
      setNow(now: () => number): void { currentNow = now; },
    });
  }
  ```

  The initial publication must use the named test harness deadline.  Do not
  change the existing V1 zero/slow deadline tests.

- [ ] **Step 2: Write the two failing V2 existing-generation deadline tests.**

  Add these tests directly after the existing V1 deadline cases.  Each begins
  from a real manifest, records the manifest bytes and call counters, and
  checks both the error positions and absence of new source/build work:

  ```ts
  it("returns V2 projection lag at a zero deadline when a sufficient generation exists", async () => {
    const fixture = await v2DeadlineFixture();
    try {
      const manifestPath = join(fixture.projectionDirectory, "projection-manifest.json");
      const beforeManifest = readFileSync(manifestPath, "utf8");
      const beforeCalls = fixture.calls;
      fixture.setNow(() => 50);

      await assert.rejects(
        () => fixture.coordinator.ensurePublished(BINDING, 1n, 0),
        (error: unknown) => error instanceof ProjectionLagError
          && error.requiredEventPosition === 1n
          && error.availableEventPosition === 1n,
      );
      assert.deepEqual(fixture.calls, beforeCalls);
      assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
    } finally {
      fixture.source.close();
    }
  });

  it("returns V2 projection lag when a positive deadline elapses before its current-generation return", async () => {
    const fixture = await v2DeadlineFixture();
    try {
      const manifestPath = join(fixture.projectionDirectory, "projection-manifest.json");
      const beforeManifest = readFileSync(manifestPath, "utf8");
      const beforeCalls = fixture.calls;
      const ticks = [100, 101];
      fixture.setNow(() => ticks.shift() ?? 101);

      await assert.rejects(
        () => fixture.coordinator.ensurePublished(BINDING, 1n, 1),
        (error: unknown) => error instanceof ProjectionLagError
          && error.requiredEventPosition === 1n
          && error.availableEventPosition === 1n,
      );
      assert.deepEqual(fixture.calls, beforeCalls);
      assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
    } finally {
      fixture.source.close();
    }
  });
  ```

- [ ] **Step 3: Run the new deadline tests and verify RED.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="returns V2 projection lag" dist-test/tests/projection-coordinator.test.js
  ```

  Expected: both new tests fail because `ensurePublished` resolves the already
  sufficient V2 generation rather than rejecting.  The existing nonmatching
  tests are skipped by the name pattern; do not modify source before this RED
  result is recorded.

- [ ] **Step 4: Move only the V2 deadline assertion.**

  In `V2ProjectionBuildCoordinator.ensurePublished`, preserve the completed
  locked reconciliation and `retainLock = false`, but change the current
  generation fast path to exactly:

  ```ts
  const current = this.#persistObservedGeneration(
    binding,
    reconciled.current,
    reconciled.highestObservedGeneration,
    identity,
  );
  retainLock = false;
  this.#assertDeadline(expiresAt, requiredEventPosition, current);
  if (current !== null && BigInt(current.manifest.terminalEventPosition) >= requiredEventPosition) {
    return current;
  }
  this.#cleanupKnownTemps();
  ```

  Delete the now-redundant `#assertDeadline` call formerly located after the
  sufficient-current `if`.  Do not move `#reconcileEntry`, alter lock release,
  change any later deadline assertion, or edit the V1 coordinator.

- [ ] **Step 5: Run focused green verification.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="deadline" dist-test/tests/projection-coordinator.test.js
  npm run typecheck
  ```

  Expected: all matched V1 and V2 deadline tests pass; the compiled test suite
  and typecheck both exit 0.

- [ ] **Step 6: Commit the isolated contract repair.**

  ```powershell
  git add src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
  git commit -m "fix: enforce V2 deadline before existing generation return"
  ```

### Task 2: Separate functional test budgets from deadline-contract coverage

**Files:**

- Modify: `tests/projection-coordinator.test.ts:67-68` and every functional `ensurePublished(..., 2_000)` call
- Modify: `tests/v2-reader-lease.test.ts:50-51,138-150`
- Verify unchanged: `tests/v2-retrieval-candidates.test.ts:166-182`

- [ ] **Step 1: Inventory the fixed two-second test calls before changing them.**

  Run:

  ```powershell
  rg -n "ensurePublished\([^\n]*2_000" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
  ```

  Expected: 51 calls in `projection-coordinator.test.ts`, one call in
  `v2-reader-lease.test.ts`, and none in `v2-retrieval-candidates.test.ts`.
  Confirm each is ordinary publication, reconciliation, manifest, retention,
  lease-fixture, or candidate-fixture setup; retain all dedicated `0`, `1`,
  and `5` millisecond deadline cases unchanged.

- [ ] **Step 2: Introduce the two test-local constants and replace only the inventoried calls.**

  Keep the Task 1 constant in `projection-coordinator.test.ts`.  After `NOW`
  in `tests/v2-reader-lease.test.ts`, add:

  ```ts
  const FUNCTIONAL_TEST_DEADLINE_MS = 15_000;
  ```

  Replace each inventoried call with its file-local constant.  For example,
  make the fixture publication read:

  ```ts
  const published = await coordinator.ensurePublished(
    BINDING,
    0n,
    FUNCTIONAL_TEST_DEADLINE_MS,
  );
  ```

  Replace concurrent calls independently so both arguments remain explicit:

  ```ts
  const concurrent = await Promise.all([
    coordinator.ensurePublished(BINDING, 10n, FUNCTIONAL_TEST_DEADLINE_MS),
    coordinator.ensurePublished(BINDING, 10n, FUNCTIONAL_TEST_DEADLINE_MS),
  ]);
  ```

  Do not add a shared runtime configuration, modify `package.json`, alter a
  test's required event position, or change the V2 candidate fixture's
  existing 1,000-ms request.

- [ ] **Step 3: Verify the test-only classification.**

  Run:

  ```powershell
  rg -n "ensurePublished\([^\n]*2_000" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
  rg -n "FUNCTIONAL_TEST_DEADLINE_MS = 15_000" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts
  ```

  Expected: the first command returns no matches (exit code 1); the second
  command returns exactly one declaration per changed test file.  The zero and
  controlled-elapsed V1/V2 tests from Task 1 retain their literal small
  deadlines.

- [ ] **Step 4: Run the repeated focused suites.**

  Run:

  ```powershell
  npm run test:build
  foreach ($attempt in 1..3) {
    node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-coordinator.test.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-reader-lease.test.js dist-test/tests/v2-retrieval-candidates.test.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  ```

  Expected: all three fresh serial iterations report zero failures.  The known
  Windows symlink capability case may be reported as a skip only.

- [ ] **Step 5: Commit the test-only stabilization.**

  ```powershell
  git add tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts
  git commit -m "test: stabilize projection functional deadlines"
  ```

### Task 3: Produce release evidence and independently audit the boundary

**Files:**

- Verify: `src/orchestrator/projections/coordinator.ts`
- Verify: `tests/projection-coordinator.test.ts`, `tests/v2-reader-lease.test.ts`, `tests/v2-retrieval-candidates.test.ts`
- Verify: `package.json`

- [ ] **Step 1: Audit the final change boundary before running the full gate.**

  Run:

  ```powershell
  git diff --name-only 7f97a8b..HEAD -- src tests
  git diff --unified=20 7f97a8b..HEAD -- src/orchestrator/projections/coordinator.ts
  rg -n "ensurePublished\([^\n]*2_000" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
  git diff --check 7f97a8b..HEAD
  ```

  Expected: under `src` and `tests`, only the coordinator plus the two planned
  test files change; the source diff moves one V2 `#assertDeadline` before the
  sufficient-current return and contains no V1, public-interface, timer, or
  route change; no fixed 2,000-ms `ensurePublished` call remains; whitespace
  verification prints nothing.

- [ ] **Step 2: Run typecheck and the complete release gate three times.**

  Run:

  ```powershell
  npm run typecheck
  foreach ($attempt in 1..3) {
    npm run test:subproject-3
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  ```

  Expected: typecheck exits 0.  Each fresh serial full gate completes with no
  failures; only the established Windows symlink capability skip is allowed.

- [ ] **Step 3: Obtain two independent reviews in order.**

  1. A spec-compliance reviewer compares the final commits with both approved
     Task 5R specifications.  It must confirm the RED regression was added,
     V2 checks before a current-generation success, all 52 functional calls
     use test-local constants, small deadline cases remain, and no forbidden
     routing/deployment change exists.
  2. If that review has no Critical or Important issue, a code-quality reviewer
     inspects the final diff for lock/reconciliation ordering, error positions,
     source/build call assertions, V1 isolation, and test-harness scope.

  Any Critical or Important finding requires a new focused regression first,
  then rerunning the reviewer that reported it and repeating this task's full
  release gate.

- [ ] **Step 4: Record final evidence and hand off only the correct next work.**

  Capture the three full-gate results, exact commits, independent review
  outcomes, and clean status.  Do not claim Version 2 primary routing or PROD
  cutover readiness: Task 5R closes only the Subproject 3 deadline/release-gate
  blocker.  The next implementation work after a green audited Task 5R is Task
  6 custom-ranker bounds, then Task 7 sealed evaluation.
