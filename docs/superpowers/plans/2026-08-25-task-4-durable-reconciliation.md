# Task 4 Durable Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every V2 coordinator entry reconcile orphan generations safely across restart, forgery, and pathname races.

**Architecture:** The V2 coordinator reconciles under the publication lock before fresh-return, source access, build, or adoption. A durable manifest watermark prevents generation reuse; one stable captured candidate image is fully validated and only that same capture may be deleted. Uncertainty retains the lock as recovery evidence.

**Tech Stack:** TypeScript, Node `DatabaseSync`, SQLite, existing stable-directory helpers, Node test runner.

---

### Task 1: Durable V2 generation watermark and entry reconciliation

**Files:**
- Modify: `src/orchestrator/projections/manifest.ts`
- Modify: `src/orchestrator/projections/coordinator.ts`
- Test: `tests/projection-coordinator.test.ts`

- [ ] **Step 1: Write RED restart and before-source regressions**

```ts
it("does not reuse a reconciled V2 generation after restart", async () => {
  await publishActiveGeneration(1);
  await writeVerifiedUnpublishedGeneration(2);
  await firstCoordinator.ensurePublished({ requiredEventPosition: 1n });
  const next = await restartedCoordinator.ensurePublished({ requiredEventPosition: 2n });
  assert.equal(next.manifest.generation, 3);
});
it("reconciles an orphan before a non-fresh source failure", async () => {
  await writeVerifiedUnpublishedGeneration(2);
  await assert.rejects(() => coordinator.ensurePublished({ requiredEventPosition: 2n }), /SOURCE_UNAVAILABLE/);
  assert.equal(exists(generationPath(2)), false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-coordinator.test.js`

Expected: FAIL because generation state is process-local and reconciliation waits for a build.

- [ ] **Step 3: Implement persistent watermark and entry reconcile**

```ts
export interface ProjectionManifestV2 {
  readonly generation: number;
  readonly highestObservedGeneration: number;
}
const nextGeneration = Math.max(active.generation, active.highestObservedGeneration, observed) + 1;
```

Invoke `#reconcileEntry` under the lock before the fresh/source/build branch. Raise and persist the watermark for every positively identified final V2 filename, including deleted verified orphans.

- [ ] **Step 4: Run GREEN and typecheck**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-coordinator.test.js && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/projections/manifest.ts src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
git commit -m "fix: persist V2 reconciliation generation watermark"
```

### Task 2: Identity-pinned full V2 candidate disposition

**Files:**
- Modify: `src/orchestrator/projections/stable-directory.ts`
- Modify: `src/orchestrator/projections/coordinator.ts`
- Modify: `src/orchestrator/projections/integrity.ts`
- Test: `tests/projection-coordinator.test.ts`

- [ ] **Step 1: Write RED forged-image and A-to-B-to-A tests**

```ts
it("retains lock for a metadata-forged V2 orphan", async () => {
  await writeMetadataForgedSqlite(generationPath(2));
  await assert.rejects(() => coordinator.ensurePublished({ requiredEventPosition: 1n }), /INTEGRITY_FAILURE/);
  assert.equal(publicationLockIsRetained(), true);
});
it("never deletes a candidate after an A-to-B-to-A pathname swap", async () => {
  await scheduleSwapDuringCandidateVerification(validA, forgedB, validA);
  await assert.rejects(() => coordinator.ensurePublished({ requiredEventPosition: 1n }), /INTEGRITY_FAILURE/);
  assert.equal(exists(generationPath(2)), true);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-coordinator.test.js`

Expected: FAIL because metadata-only/pathname validation authorizes deletion.

- [ ] **Step 3: Implement one capture-bound inspect/remove operation**

```ts
const candidate = stableDirectory.captureReadOnlyImage(candidateName);
verifyV2GenerationImage(candidate.bytes, expectedBinding, candidate.identity);
stableDirectory.removeCapturedFile(candidate.identity);
```

Verify V2 schema, binding, terminal metadata, required relations, core checksums, and SQLite integrity from the captured bytes. Mismatch, swap, or unreadability retains candidate/evidence and keeps the publication lock.

- [ ] **Step 4: Run GREEN, V1 isolation, and typecheck**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-manifest.test.js && npm run typecheck`

Expected: PASS; valid inactive V2 orphan deletes, forged/swap cases retain lock, V1 remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/projections/stable-directory.ts src/orchestrator/projections/coordinator.ts src/orchestrator/projections/integrity.ts tests/projection-coordinator.test.ts
git commit -m "fix: bind V2 orphan validation to captured identity"
```

### Task 3: Final Task 4 verification and independent review

**Files:**
- Modify: `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/task-4-report.md`

- [ ] **Step 1: Run complete verification**

Run: `npm run test:subproject-3 && npm run typecheck`

Expected: V2 Task 4 gates pass. Record any pre-existing V1 deadline failures separately; never mask them.

- [ ] **Step 2: Re-review final diff**

Verify every-entry reconciliation, restart-safe high-water, single-identity validation/deletion, uncertainty lock retention, and V1 isolation.

- [ ] **Step 3: Update Task 4 status only on approval**

Record commits, exact test output, known unrelated failures, and approval in the SDD ledger; only then start Task 5.
