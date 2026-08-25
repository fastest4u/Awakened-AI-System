# Task 4 ctime rename identity amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Task 4 retained V2 orphan reconciliation portable across filesystems that update `ctimeNs` during a verified rename, without weakening pre-rename authorization or later retained-evidence checks.

**Architecture:** The existing exact five-field retirement image remains the authority for a final candidate before rename and for completed retained evidence thereafter.  Add a second four-field continuity predicate, usable only when bridging the coordinator-owned final-to-retired rename.  Persist the observed post-rename five-field identity as the `retired` record, and use the same one-time continuity predicate for an intent found after a crash.

**Tech Stack:** Node.js 24 TypeScript, `node:fs` stable-directory child process, SQLite projection generations, Node test runner.

**Precondition:** The preserved uncommitted Task 4.2 draft in the four listed source/test files is the starting point.  Do not discard it; bring it into compliance with [the approved specification amendment](../specs/2026-08-25-task-4-ctime-rename-amendment.md).

---

### Task 1: Make the current retained-orphan happy path ctime-portable

**Files:**
- Modify: `src/orchestrator/projections/reconciliation-journal.ts:9-55`
- Modify: `src/orchestrator/projections/stable-directory.ts:222-228, 421-505, 1360-1460`
- Modify: `src/orchestrator/projections/coordinator.ts:28-33, 850-905`
- Modify: `tests/projection-coordinator.test.ts:352-410`

- [ ] **Step 1: Strengthen the retained-orphan test before changing comparisons**

Keep the existing Task 4.2 retained high-water test and add exact retained-file
identity assertions after the first reconciliation:

```ts
const retiredFilename = retired[0];
const journal = JSON.parse(readFileSync(
  join(projectionDirectory, "projection-reconciliation-v2.json"), "utf8",
)) as { retirements: readonly { state: string; image: { ctimeNs: string } }[] };
const retiredRecord = journal.retirements.find((record) => record.state === "retired");
assert.notEqual(retiredRecord, undefined);
assert.equal(
  retiredRecord!.image.ctimeNs,
  lstatSync(join(projectionDirectory, retiredFilename), { bigint: true }).ctimeNs.toString(),
);
```

This control proves that the journal stores the *observed retired identity*,
not the pre-rename timestamp.  Preserve the four `10_000`-ms calls only in
this durability test.

Update the existing post-rename A-to-B swap regression in the same test file
to locate a strict `.projections-2-retired-<32hex>.sqlite` entry rather than a
quarantine entry.  At the existing post-rename fault boundary, move that
retired file aside and place forged bytes at the same retired filename.  The
test must continue to expect a fail-closed error and retained evidence.  This
is the direct negative control for the four-field continuity predicate: a
timestamp change is permitted, but a changed device/inode/size/SHA-256 is not.

- [ ] **Step 2: Run the focused test and verify RED on the current exact-post-rename code**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retired V2 generation high-water|no stable V2 orphan deletion" dist-test/tests/projection-coordinator.test.js
```

Expected on Windows/NTFS: the high-water case fails with
`PROJECTION_PATH_INVALID` because the stable operation compares the
post-rename `ctimeNs` to the exact pre-rename identity.  The no-deletion test
continues to pass.  Do not modify deadlines outside the already-approved four
durability calls.

- [ ] **Step 3: Introduce the single-use rename-continuity predicate**

In `reconciliation-journal.ts`, retain `sameRetirementImage` as exact
five-field equality and add this exported predicate:

```ts
export function sameRetirementRenameContinuity(
  identity: StableProjectionGenerationIdentity,
  expected: V2RetirementImage,
): boolean {
  return identity.device === expected.device
    && identity.inode === expected.inode
    && identity.size === expected.size
    && identity.sha256 === expected.sha256;
}
```

Inside the stable child script, keep `sameGenerationIdentity` unchanged and
add an equivalent local predicate for its JSON records:

```js
const sameGenerationRenameContinuity = (file, expected) => (
  file.device === expected.device
  && file.inode === expected.inode
  && file.size === expected.size
  && file.sha256 === expected.sha256
);
```

Use that local predicate only at these two pre/post bridge boundaries:

```js
// retire-generation, after exact pre-rename capture, rename, directory fsync, and recapture
if (!sameGenerationRenameContinuity(retired, expected)) invalid();

// complete-reconciliation-retirement, before replacing the intent record
if (!sameGenerationRenameContinuity(image, intent.image)) invalid();
```

Do not change the exact pre-rename `sameGenerationIdentity(current, expected)`
check.  `complete-reconciliation-retirement` must replace the `intent` with a
`retired` record whose `image` is the returned observation, including the new
`ctimeNs`, then write/fsync/reread/reassert the lock exactly as the current
journal implementation does.

In `coordinator.ts`, import the new predicate and replace only the post-rename
comparison:

```ts
if (!sameRetirementRenameContinuity(retired, intent.image)) {
  throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
}
```

Keep the full immutable-byte validator, intent-before-rename order, random
128-bit retired name, no-unlink rule, and exact retired-record decoding
unchanged.

- [ ] **Step 4: Run GREEN verification for Task 4.2**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retired V2 generation high-water|no stable V2 orphan deletion|fresh reads must reconcile" dist-test/tests/projection-coordinator.test.js
npm run typecheck
```

Expected: every selected case passes; the final name is absent, exactly one
opaque retired file remains, its journal `ctimeNs` equals its actual
post-rename `ctimeNs`, and no source-level deletion operation exists.

- [ ] **Step 5: Commit the completed Task 4.2 retained disposition**

```bash
git add src/orchestrator/projections/reconciliation-journal.ts src/orchestrator/projections/stable-directory.ts src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
git commit -m "fix: retain reconciled V2 orphan generations"
```

### Task 2: Recover a ctime-changing retirement intent without weakening completed evidence

**Files:**
- Modify: `src/orchestrator/projections/coordinator.ts:80-87, 830-910`
- Modify: `tests/projection-coordinator.test.ts:400-700`

- [ ] **Step 1: Write failing ctime-aware recovery tests**

Extend `V2ProjectionBuildCoordinatorOptions.faultInjector.hit` with these
boundaries:

```ts
| "after-v2-retirement-intent-before-rename"
| "after-v2-retirement-rename-before-complete"
```

Add a restart case that injects at
`after-v2-retirement-rename-before-complete`, verifies the journal still has
an `intent`, then restarts.  It must complete to `retired` and record the
actual retired file timestamp:

```ts
const retiredName = readdirSync(projectionDirectory).find((name) => (
  /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
));
assert.notEqual(retiredName, undefined);
const afterRestart = JSON.parse(readFileSync(journalPath, "utf8")) as {
  retirements: readonly { state: string; image: { ctimeNs: string } }[];
};
assert.equal(afterRestart.retirements[0].state, "retired");
assert.equal(
  afterRestart.retirements[0].image.ctimeNs,
  lstatSync(join(projectionDirectory, retiredName!), { bigint: true }).ctimeNs.toString(),
);
```

Add a completed-evidence exactness case: retire an orphan normally, move the
retired entry to a non-routable temporary name and back with `renameSync`, then
call `ensurePublished` again.  The content can remain identical, but the
second rename changes `ctimeNs` on Windows.  Assert rejection with
`PROJECTION_PUBLICATION_RECOVERY_REQUIRED`, the publication lock remains, and
the retained file still exists.  This proves the continuity exception cannot
be reused after a `retired` record has been committed.

Keep the approved swapped-retired-path, unjournaled-retired, legacy-quarantine,
forged-reference, and forged-FTS tests from the parent Task 4 plan.

- [ ] **Step 2: Run the recovery matrix and verify RED**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retirement intent|retired pathname|retired evidence|unjournaled retired|legacy quarantine|forged.*(reference|FTS)" dist-test/tests/projection-coordinator.test.js
```

Expected: the post-rename restart case fails because recovery has not yet
scanned journal records.  The completed-evidence mutation must not be accepted
by an implementation that incorrectly applies continuity to a `retired`
record.

- [ ] **Step 3: Implement deterministic ctime-aware recovery before the final scan**

At the start of `#reconcileUnpublished`, while the V2 lock and pinned directory
identity are held, read `this.#reconciliationJournal.snapshot(...)`.  First
reject any strict legacy quarantine name, unjournaled strict retired name,
sidecar, duplicate record, or malformed/unknown record as
`PROJECTION_PUBLICATION_RECOVERY_REQUIRED`.

Use these record-specific rules:

```ts
if (record.state === "retired") {
  const observed = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
    this.#projectionDirectory, identity, lockToken, record.retiredFilename,
  );
  if (observed === null || !sameRetirementImage(observed, record.image)) {
    throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
  }
  continue;
}

const retired = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
  this.#projectionDirectory, identity, lockToken, record.retiredFilename,
);
if (retired !== null) {
  if (!sameRetirementRenameContinuity(retired, record.image)) {
    throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
  }
  this.#reconciliationJournal.completeRetirement(
    this.#projectionDirectory, identity, lockToken, record, toRetirementImage(retired),
  );
  continue;
}
```

If the intent's retired name is absent, read its final image and require
`sameRetirementImage(finalImage.identity, record.image)` before revalidating
with `assertUnpublishedProjectionV2Image`, calling `retireGeneration`, and
writing the observed retired record.  Invoke
`after-v2-retirement-rename-before-complete` after the stable rename and before
`completeRetirement`.  The new happy-path intent boundary must fire after
`beginRetirement` and before `retireGeneration`.

Never use `sameRetirementRenameContinuity` for a `retired` record, final-path
authorization, publication selection, leases, or manifest files.

- [ ] **Step 4: Run GREEN recovery, V1 isolation, and type verification**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retirement intent|retired pathname|retired evidence|unjournaled retired|legacy quarantine|forged.*(reference|FTS)|takes the V2 publication lock" dist-test/tests/projection-coordinator.test.js
node --test --test-concurrency=1 dist-test/tests/projection-manifest.test.js dist-test/tests/projection-builder.test.js
npm run typecheck
```

Expected: an after-rename crash completes one time using continuity and stores
the observed identity; any later timestamp-only mutation of a completed
retained file fails closed; swaps and unjournaled/legacy evidence retain the
lock; V1 tests and typecheck pass.

- [ ] **Step 5: Commit durable ctime-aware recovery**

```bash
git add src/orchestrator/projections/reconciliation-journal.ts src/orchestrator/projections/stable-directory.ts src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
git commit -m "fix: recover durable V2 retirement intents"
```

### Task 3: Re-run Task 4 release verification with the amended identity rules

**Files:**
- Modify: `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/progress.md`
- Modify: `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/task-4-report.md`

- [ ] **Step 1: Run release gates from a quiet host**

Run:

```bash
npm run test:subproject-3
npm run typecheck
```

Expected: no test failures; the established Windows symlink permission case may
be skipped.  Do not alter production deadlines to hide machine-load failures.

- [ ] **Step 2: Require an independent review of both identity domains**

The reviewer must verify the final diff and focused fault matrix prove all of:

```text
1. Exact five-field identity authorizes the final candidate before rename.
2. Four-field continuity appears only between that rename and its first durable retired record.
3. The retired journal record stores the observed post-rename ctimeNs.
4. An existing retired record is checked with exact five-field identity, including ctimeNs.
5. No V2 final or retired candidate path invokes unlink or a removal helper.
6. Full immutable-byte validation, lock-before-source, high-water, lease and manifest exclusions remain intact.
```

- [ ] **Step 3: Record approval without committing ignored SDD artifacts**

Only after the reviewer approves, update the ignored local ledger with the
commit IDs, focused matrix, full commands, expected skip count, and retained
evidence follow-up.  Confirm it remains ignored:

```bash
git check-ignore -v .superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/progress.md
git status --short
```

Expected: no accidental ledger commit, no unstaged source/test changes, and
Task 5/Task 6 remain blocked until this Task 4 approval is recorded.
