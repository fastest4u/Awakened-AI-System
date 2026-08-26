# Task 5R Functional 10-Second Deadline Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the remaining host-load-sensitive functional test deadlines so the Subproject 3 release gate can prove behavior without changing any production deadline contract.

**Architecture:** The coordinator test file already owns the named harness budget `FUNCTIONAL_TEST_DEADLINE_MS = 15_000`. This amendment changes only the 29 remaining literal `10_000` deadline arguments used by functional publication, reconciliation, retention, restart, source-unavailable, and injected-fault scenarios. Controlled deadline-contract inputs and all production code remain unchanged.

**Tech Stack:** TypeScript 5.8, Node 24 `node:test`, SQLite `DatabaseSync`, npm scripts, PowerShell.

---

## File map

- `tests/projection-coordinator.test.ts`: Holds every remaining 10,000-ms functional `ensurePublished` call and the existing local functional harness constant. This is the only implementation file.
- `src/orchestrator/projections/coordinator.ts`: Audit-only. Its Task 5R V2 ordering must remain `persistObservedGeneration` → `retainLock = false` → `#assertDeadline` → sufficient-current return.
- `tests/v2-reader-lease.test.ts`: Audit-only. It already has its own 15,000-ms functional harness constant.
- `tests/v2-retrieval-candidates.test.ts`: Audit-only. Its independent 1,000-ms fixture remains unchanged.
- `package.json`: Audit-only. `test:subproject-3` remains the serial release-gate entry point.

### Task 1: Replace every approved 10-second functional argument

**Files:**
- Modify: `tests/projection-coordinator.test.ts:480,491,499,535,557,570,596,632,645,674,718,725,743,767,774,790,814,821,843,963,973,994,1004,1037,1049,1080,1103,1229,1432`
- Test: `tests/projection-coordinator.test.ts:467-535`

- [ ] **Step 1: Record the exact pre-change inventory and controlled-deadline boundary**

Run:

```powershell
$matches = @(rg -n "ensurePublished\\([^\n]*10_000" tests/projection-coordinator.test.ts)
if ($matches.Count -ne 29) { throw "Expected 29 functional 10,000-ms calls, got $($matches.Count)" }
$matches
rg -n "ensurePublished\\([^\n]*(0|1|5)\\)" tests/projection-coordinator.test.ts
rg -n "ensurePublished\\([^\n]*1_000" tests/v2-retrieval-candidates.test.ts
rg -n "ensurePublished\\([^\n]*5_000" tests/projection-coordinator.test.ts
```

Expected: exactly the 29 approved coordinator call sites print; zero, one, and five millisecond controlled tests, the candidate `1_000` fixture, and existing `5_000` inputs are visible for later unchanged-boundary comparison.

- [ ] **Step 2: Preserve the existing failure evidence before changing the harness**

The pre-amendment release evidence is already a RED result: the third fresh `npm run test:subproject-3` gate returned `PROJECTION_LAG` instead of `/post-install/` in the retired-high-water fixture. Re-run the same focused test once to confirm the test is environment-sensitive rather than a deterministic behavior failure:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="persists a retired V2 generation high-water" dist-test/tests/projection-coordinator.test.js
```

Expected: the isolated test may pass; its prior full-gate failure plus an isolated pass demonstrates that this task changes only a real-time functional harness deadline, not a deadline-contract assertion.

- [ ] **Step 3: Replace only the 29 literal functional deadlines**

At every inventory line, replace only the final `10_000` deadline argument with the existing local `FUNCTIONAL_TEST_DEADLINE_MS` constant. Preserve the binding, required position, callback, expected error, and all surrounding assertions. Representative replacements are:

```ts
await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

await assert.rejects(
  () => faulted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS),
  /post-install/u,
);

const published = await restarted.ensurePublished(
  BINDING,
  3n,
  FUNCTIONAL_TEST_DEADLINE_MS,
);
```

Do not add another constant, alter `FUNCTIONAL_TEST_DEADLINE_MS = 15_000`, change a literal `0`, `1`, `5`, `1_000`, or `5_000`, edit `src/`, or change npm/CI configuration.

- [ ] **Step 4: Prove the complete post-change inventory and boundary**

Run:

```powershell
rg -n "ensurePublished\\([^\n]*10_000" tests/projection-coordinator.test.ts
if ($LASTEXITCODE -ne 1) { throw "Expected no remaining 10,000-ms ensurePublished calls" }
rg -n "ensurePublished\\([^\n]*2_000" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
if ($LASTEXITCODE -ne 1) { throw "Expected no remaining 2,000-ms ensurePublished calls" }
rg -n "ensurePublished\\([^\n]*(0|1|5)\\)" tests/projection-coordinator.test.ts
rg -n "ensurePublished\\([^\n]*1_000" tests/v2-retrieval-candidates.test.ts
rg -n "ensurePublished\\([^\n]*5_000" tests/projection-coordinator.test.ts
```

Expected: both fixed-deadline inventories are empty with exit 1; the controlled and excluded values remain present.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```powershell
npm run test:build
foreach ($attempt in 1..3) {
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="persists a retired V2 generation high-water" dist-test/tests/projection-coordinator.test.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
foreach ($attempt in 1..3) {
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-coordinator.test.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
npm run typecheck
```

Expected: all three retired-high-water repetitions pass, all three complete coordinator-suite repetitions pass, and typecheck exits 0.

- [ ] **Step 6: Inspect and commit the bounded change**

Run:

```powershell
git diff --check
git diff -- tests/projection-coordinator.test.ts
git add tests/projection-coordinator.test.ts
git commit -m "test: stabilize remaining projection functional deadlines"
git status --short --branch
```

Expected: the diff contains only literal deadline-to-constant replacements in the approved test file, the commit succeeds, and status is clean.

### Task 2: Audit the amended boundary and run the complete release gate

**Files:**
- Modify: none
- Audit: `src/orchestrator/projections/coordinator.ts:601-613`
- Audit: `tests/projection-coordinator.test.ts`
- Audit: `tests/v2-reader-lease.test.ts`
- Audit: `tests/v2-retrieval-candidates.test.ts`
- Audit: `package.json`

- [ ] **Step 1: Audit source/test/release boundaries**

Run:

```powershell
git diff --name-only 7f97a8b..HEAD -- src tests package.json
git diff --unified=20 7f97a8b..HEAD -- src/orchestrator/projections/coordinator.ts
rg -n "ensurePublished\\([^\n]*(2_000|10_000)" tests/projection-coordinator.test.ts tests/v2-reader-lease.test.ts tests/v2-retrieval-candidates.test.ts
if ($LASTEXITCODE -ne 1) { throw "Expected no 2,000-ms or 10,000-ms ensurePublished calls" }
rg -n "ensurePublished\\([^\n]*(0|1|5)\\)" tests/projection-coordinator.test.ts
rg -n "ensurePublished\\([^\n]*1_000" tests/v2-retrieval-candidates.test.ts
rg -n "ensurePublished\\([^\n]*5_000" tests/projection-coordinator.test.ts
git diff --check 7f97a8b..HEAD
```

Expected: source diff remains only the completed Task 5R V2 order correction: `persistObservedGeneration`, then `retainLock = false`, then `#assertDeadline`, then existing-current return. No V1/API/timer/routing/release config change appears. The two fixed functional deadline inventories are empty; controlled/excluded values remain; diff check is clean.

- [ ] **Step 2: Run three fresh complete serial release gates**

Run:

```powershell
npm run typecheck
foreach ($attempt in 1..3) {
  npm run test:subproject-3
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected for every attempt: the main serial suite has zero failures; only the established Windows `EPERM` symlink capability skip may appear; retrieval evaluation passes 6/6; CI lifecycle gates pass 9/9, including the no-production-routing gate.

- [ ] **Step 3: Record final release evidence**

Run:

```powershell
git status --short --branch
git log --oneline -4
```

Expected: clean `codex/subproject-3-projections` worktree with the amendment implementation commit on top of `4675d9f`, `96d7eb0`, and `d8d1e00`.

### Task 3: Independent review and Task 5R handoff

**Files:**
- Modify: none unless a review identifies a concrete defect
- Review: `7f97a8b..HEAD`

- [ ] **Step 1: Run an independent specification-compliance review**

The reviewer must verify: exactly 29 former 10,000-ms coordinator calls use the existing 15,000-ms constant; no 2,000-ms or 10,000-ms `ensurePublished` call remains; 0/1/5 controlled tests, candidate 1,000, and coordinator 5,000 inputs are unchanged; runtime source and release configuration remain inside the approved Task 5R boundary; and every required gate result is present.

Expected: `APPROVED` with no Critical or Important findings, or concrete file-and-line findings returned to the Task 1 implementer for a focused fix and repeat of Tasks 1–2.

- [ ] **Step 2: Run an independent code-quality review after specification approval**

The reviewer must verify: the local constant has not changed value or scope; replacements preserve expected-fault/error assertions and all test cleanup; V2 deadline/lock regressions remain deterministic; no test runner or product behavior is masked; and the final diff is maintainable and constrained.

Expected: `APPROVED` with no Critical or Important findings, or concrete file-and-line findings returned to the Task 1 implementer for a focused fix and repeat of Tasks 1–2.

- [ ] **Step 3: Make the bounded handoff statement**

Report the exact commits, all three fresh full-gate outcomes, both review outcomes, and clean status. State only that Task 5R's addressed Subproject 3 release-gate blocker is resolved if every check is green. Do not state that V2 is routed, deployed, or generally PROD-ready; Task 6, Task 7, and the later cutover controls remain separate work.

