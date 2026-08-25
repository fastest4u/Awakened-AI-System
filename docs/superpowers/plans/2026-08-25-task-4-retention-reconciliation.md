# Task 4 Retention-Based V2 Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unsafe V2 orphan deletion with durable, full-image-validated retirement that never deletes a mutable candidate path.

**Architecture:** Every V2 coordinator entry holds the existing publication lock before source access.  It records an fsync-backed retirement intent for a fully captured and validated orphan, atomically renames that exact image to a non-routable retained name, then durably marks the intent retired.  The V2 image validator is extracted into `integrity.ts` so orphan validation and integrity replay share reference and FTS semantic checks.

**Tech Stack:** TypeScript, Node 24 `node:sqlite`, Node file descriptors and atomic rename, existing stable-directory subprocess, Node test runner.

**Approved specification:** `docs/superpowers/specs/2026-08-25-task-4-retention-reconciliation-design.md` at commit `eb3101e`.

---

## File structure and ownership

- `src/orchestrator/projections/integrity.ts` owns immutable V2 image validation and is the only source for self-consistency checks of captured V2 bytes.
- `src/orchestrator/projections/reconciliation-journal.ts` owns parent-side typed intent/retirement state and delegates every journal read/write to stable directory operations.
- `src/orchestrator/projections/stable-directory.ts` owns identity-pinned, lock-checked child-process journal mutations and final-to-retired atomic rename.  It must not expose a V2 orphan removal operation.
- `src/orchestrator/projections/coordinator.ts` owns entry ordering, selection exclusions (active/leased files), journal recovery, and failure mapping.
- `tests/projection-integrity.test.ts` proves the shared validator rejects forged self-consistent row/FTS images.
- `tests/projection-coordinator.test.ts` proves the complete locking, crash, swap, retention, deadline, and V1-isolation behavior.
- `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/{progress.md,task-4-report.md}` records closure only after all gates and an independent review approve Task 4.

### Task 1: Extract one full immutable V2 image validator

**Files:**
- Modify: `src/orchestrator/projections/integrity.ts:17-290, 797-1007`
- Modify: `src/orchestrator/projections/coordinator.ts:13-300, 1048-1063`
- Modify: `tests/projection-integrity.test.ts:30-225, 912-990`

- [ ] **Step 1: Add failing self-consistent reference and FTS orphan tests**

Import `assertUnpublishedProjectionV2Image` from `integrity.ts`.  Reuse the existing
`coreChecksum`, `mutateDatabase`, and FTS fixture helpers in
`tests/projection-integrity.test.ts` so hashes are recomputed with the production
`projectionCoreChecksum` implementation.

```ts
function resignAllCoreChecksums(path: string, terminal: bigint): void {
  const database = new DatabaseSync(path);
  try {
    const update = database.prepare(`
      UPDATE projection_core_checksums SET checksum = ? WHERE projection_name = ?
    `);
    for (const name of PROJECTION_NAMES) update.run(coreChecksum(path, name, terminal), name);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  } finally {
    database.close();
  }
}

it("rejects an orphan image with a re-signed missing session reference", async () => {
  const fixture = await createFixture();
  mutateDatabase(fixture, `DELETE FROM session_tree WHERE session_id = '${SESSION_ID}'`);
  resignAllCoreChecksums(fixture.databasePath, BigInt(fixture.manifest.terminalEventPosition));
  assert.throws(
    () => assertUnpublishedProjectionV2Image(
      readFileSync(fixture.databasePath), fixture.manifest.databaseFile, BINDING,
    ),
    /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
  );
});

it("rejects an orphan image with re-signed core rows and forged FTS state", async () => {
  const fixture = await createFixture();
  mutateFtsShadowDatabase(fixture, `
    UPDATE lexical_chunks_fts_docsize SET sz = X'0101' WHERE id = 1
  `);
  resignAllCoreChecksums(fixture.databasePath, BigInt(fixture.manifest.terminalEventPosition));
  assert.throws(
    () => assertUnpublishedProjectionV2Image(
      readFileSync(fixture.databasePath), fixture.manifest.databaseFile, BINDING,
    ),
    /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
  );
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="re-signed.*(reference|FTS)" dist-test/tests/projection-integrity.test.js
```

Expected: FAIL because orphan validation remains private to `coordinator.ts` and omits `assertReferences` and `assertFtsSemantics`.

- [ ] **Step 3: Move recovery-only schema/row helpers and implement the exported validator**

Move `RECOVERY_*`, `recoveryStatement`, `recoveryCanonicalValue`,
`assertRecoveryV2Schema`, and `recoveryRows` from `coordinator.ts` into
`integrity.ts`.  Keep their current strict decoding semantics.  Add the only
public orphan validator, which owns database lifetime and maps every internal
failure to the recovery-required error.

```ts
export function assertUnpublishedProjectionV2Image(
  bytes: Uint8Array,
  filename: string,
  binding: ProjectBinding,
): void {
  let database: DatabaseSync | undefined;
  try {
    database = openImmutableProjectionImage(bytes);
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;");
    const { terminalPosition, lexicalRows } = assertUnpublishedV2MetadataAndChecksums(
      database, filename, binding,
    );
    assertSqliteIntegrity(database);
    assertReferences(database);
    assertFtsSemantics(database, lexicalRows);
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECTION_PUBLICATION_RECOVERY_REQUIRED") {
      throw error;
    }
    throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED", { cause: error });
  } finally {
    database?.close();
  }
}
```

`assertUnpublishedV2MetadataAndChecksums` must validate exactly one metadata
row, V2 schema, final filename generation, complete `ProjectBinding`, terminal
metadata, each persisted checksum, and recomputed `recoveryRows` checksums.  It
returns `recoveryRows(database, "lexicalChunks")` as `lexicalRows`; it does not
use a mutable pathname or a manifest.

Replace `#assertUnpublishedV2Candidate` in `coordinator.ts` with the exported
function and delete the duplicated SQLite/checksum imports and private helpers.

- [ ] **Step 4: Run focused GREEN and typecheck**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="re-signed.*(reference|FTS)|derived references|FTS" dist-test/tests/projection-integrity.test.js
npm run typecheck
```

Expected: all selected integrity tests pass; the forged images throw only
`PROJECTION_PUBLICATION_RECOVERY_REQUIRED`; typecheck exits 0.

- [ ] **Step 5: Commit the shared validator seam**

```bash
git add src/orchestrator/projections/integrity.ts src/orchestrator/projections/coordinator.ts tests/projection-integrity.test.ts
git commit -m "fix: fully validate unpublished V2 images"
```

### Task 2: Persist retirement intent and atomically retain a verified orphan

**Files:**
- Modify: `src/orchestrator/projections/reconciliation-journal.ts:1-30`
- Modify: `src/orchestrator/projections/stable-directory.ts:13-35, 301-384, 744-778, 870-879, 1087-1175`
- Modify: `src/orchestrator/projections/coordinator.ts:90-1080`
- Modify: `tests/projection-coordinator.test.ts:352-470`

- [ ] **Step 1: Write the failing valid-retirement and no-unlink tests**

Replace the current high-water test's deletion assertion with retained-state
assertions.  Use a 10-second deadline only in this durability test.

```ts
await reconciler.ensurePublished(BINDING, 1n, 10_000);
assert.equal(existsSync(join(projectionDirectory, "projections-2-2.sqlite")), false);
const retired = readdirSync(projectionDirectory).filter((name) => (
  /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
));
assert.equal(retired.length, 1, "a verified orphan is retained, never unlinked");
assert.match(
  readFileSync(join(projectionDirectory, "projection-reconciliation-v2.json"), "utf8"),
  /"state":"retired"/u,
);

const published = await restarted.ensurePublished(BINDING, 3n, 10_000);
assert.equal(published.manifest.generation, 3);
```

Add a source-level regression at the end of the coordinator suite:

```ts
it("has no stable V2 orphan deletion operation", () => {
  const stableDirectory = readFileSync(
    join(process.cwd(), "src", "orchestrator", "projections", "stable-directory.ts"), "utf8",
  );
  assert.doesNotMatch(stableDirectory, /remove-quarantined-generation|removeQuarantinedGeneration/u);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retired V2 generation high-water|no stable V2 orphan deletion" dist-test/tests/projection-coordinator.test.js
```

Expected: FAIL because the current implementation writes only a numeric journal,
uses a quarantine name, and calls `removeQuarantinedGeneration`.

- [ ] **Step 3: Add exact journal records and stable retirement operations**

In `reconciliation-journal.ts`, define parent-side data that always includes
the identity captured from the descriptor, never a host path.

```ts
export type V2RetirementImage = Readonly<Pick<
  StableProjectionGenerationIdentity,
  "device" | "inode" | "size" | "ctimeNs" | "sha256"
>>;

export function toRetirementImage(
  identity: StableProjectionGenerationIdentity,
): V2RetirementImage {
  return Object.freeze({
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    ctimeNs: identity.ctimeNs,
    sha256: identity.sha256,
  });
}

export function sameRetirementImage(
  identity: StableProjectionGenerationIdentity,
  expected: V2RetirementImage,
): boolean {
  return identity.device === expected.device
    && identity.inode === expected.inode
    && identity.size === expected.size
    && identity.ctimeNs === expected.ctimeNs
    && identity.sha256 === expected.sha256;
}

export interface V2RetirementIntent {
  readonly state: "intent";
  readonly generation: number;
  readonly finalFilename: string;
  readonly retiredFilename: string;
  readonly image: V2RetirementImage;
}

export interface V2RetiredGeneration {
  readonly state: "retired";
  readonly generation: number;
  readonly retiredFilename: string;
  readonly image: V2RetirementImage;
}

export class V2ReconciliationJournal {
  reserveAtLeast(directory: string, identity: ProjectionDirectoryIdentity, lockToken: string, minimum: number): number {
    return filesystemStableProjectionDirectoryOperations.reserveReconciliationJournal(
      directory, identity, lockToken, minimum,
    );
  }
  beginRetirement(directory: string, identity: ProjectionDirectoryIdentity, lockToken: string, intent: V2RetirementIntent): V2RetirementIntent {
    return filesystemStableProjectionDirectoryOperations.beginReconciliationRetirement(
      directory, identity, lockToken, intent,
    );
  }
  completeRetirement(directory: string, identity: ProjectionDirectoryIdentity, lockToken: string, intent: V2RetirementIntent, image: V2RetirementImage): V2RetiredGeneration {
    return filesystemStableProjectionDirectoryOperations.completeReconciliationRetirement(
      directory, identity, lockToken, intent, image,
    );
  }
  snapshot(directory: string, identity: ProjectionDirectoryIdentity, lockToken: string): readonly (V2RetirementIntent | V2RetiredGeneration)[] {
    return filesystemStableProjectionDirectoryOperations.readReconciliationRetirements(
      directory, identity, lockToken,
    );
  }
}
```

Extend the stable child journal codec to accept the legacy
`{ "highestReservedGeneration": number }` shape as an empty record set and
rewrite a canonical expanded object:

```ts
{
  highestReservedGeneration: number,
  retirements: readonly (IntentRecord | RetiredRecord)[],
}
```

Every mutation reads the exact journal, validates bounds and uniqueness by
generation/retired filename, atomically writes a temporary journal, fsyncs it,
renames it, fsyncs the directory, rereads it, and reasserts the lock.

Replace `V2_QUARANTINE`, `quarantine-generation`, and
`remove-quarantined-generation` with `V2_RETIRED` and
`retire-generation`.  `retire-generation` must:

```ts
assertLock(lockToken);
assertExactFinalIdentity(finalFilename, expected);
assertAbsent(retiredFilename);
renameSync(finalFilename, retiredFilename);
syncDirectory();
const observed = captureFileIdentity(retiredFilename, MAX_GENERATION_BYTES);
if (!sameGenerationIdentity(observed, expected)) invalid();
assertLock(lockToken);
return observed; // no unlink call
```

Expose `retireGeneration` and `captureRetiredGeneration` from
`StableProjectionDirectoryOperations`.  Both accept only the strict opaque
retired filename and reject sidecars, symlinks, directory changes, and identity
mismatches.  Remove the public removal method and its union member entirely.

- [ ] **Step 4: Wire the verified orphan happy path in the coordinator**

After `readGenerationImage` and `assertUnpublishedProjectionV2Image`, create a
random 128-bit retired name, write intent before rename, retire through the
stable helper, compare identity, then persist `retired`.

```ts
const intent = this.#reconciliationJournal.beginRetirement(
  this.#projectionDirectory, identity, lockToken,
  { generation, finalFilename: filename, retiredFilename, image: toRetirementImage(image.identity) },
);
const observed = filesystemStableProjectionDirectoryOperations.retireGeneration(
  this.#projectionDirectory, identity, lockToken, image.identity, intent.retiredFilename,
);
this.#reconciliationJournal.completeRetirement(
  this.#projectionDirectory, identity, lockToken, intent, toRetirementImage(observed),
);
```

Do not call any `unlink` API in this flow.  Keep active manifest and leased
filename exclusions unchanged.  `highestReservedGeneration` is still reserved
before processing any candidate.

- [ ] **Step 5: Run focused GREEN and typecheck**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retired V2 generation high-water|no stable V2 orphan deletion|fresh reads must reconcile" dist-test/tests/projection-coordinator.test.js
npm run typecheck
```

Expected: selected tests pass; a valid orphan has one retained name and journal
record; it is not routed as a final generation; its generation remains retired
after restart; typecheck exits 0.

- [ ] **Step 6: Commit durable retention**

```bash
git add src/orchestrator/projections/reconciliation-journal.ts src/orchestrator/projections/stable-directory.ts src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
git commit -m "fix: retain reconciled V2 orphan generations"
```

### Task 3: Recover intents and fail closed on every uncertain retained state

**Files:**
- Modify: `src/orchestrator/projections/reconciliation-journal.ts`
- Modify: `src/orchestrator/projections/stable-directory.ts`
- Modify: `src/orchestrator/projections/coordinator.ts:90-1080`
- Modify: `tests/projection-coordinator.test.ts:400-700`

- [ ] **Step 1: Add failing intent-recovery, swap, and unknown-evidence tests**

Extend the V2 fault injector union with these boundaries:

```ts
| "after-v2-retirement-intent-before-rename"
| "after-v2-retirement-rename-before-complete"
```

Write these tests using the existing faulted-orphan fixture:

```ts
it("finishes an exact retirement intent after restart", async () => {
  // Crash after rename and before journal completion.
  await assert.rejects(() => recovery.ensurePublished(BINDING, 1n, 10_000), /rename-before-complete/u);
  const resumed = await restarted.ensurePublished(BINDING, 1n, 10_000);
  assert.equal(resumed.manifest.generation, 1);
  assert.match(readFileSync(journalPath, "utf8"), /"state":"retired"/u);
});

it("retains lock and evidence when a retired pathname is swapped", async () => {
  // At after-v2-retirement-rename-before-complete, replace the retired name
  // with forged bytes.  The coordinator must throw and neither candidate file
  // may be unlinked.
  await assert.rejects(() => recovery.ensurePublished(BINDING, 1n, 10_000), /PROJECTION_PATH_INVALID/u);
  assert.equal(existsSync(lockPath), true);
  assert.equal(readdirSync(projectionDirectory).some((name) => name.includes("retired")), true);
});

it("rejects an unjournaled retired file and legacy quarantine evidence", async () => {
  writeFileSync(join(projectionDirectory, ".projections-2-retired-" + "a".repeat(32) + ".sqlite"), "x");
  await assert.rejects(() => coordinator.ensurePublished(BINDING, 1n, 10_000), /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u);
  assert.equal(existsSync(lockPath), true);
});
```

Also add coordinator integration cases that create a valid orphan, forge a
`tasks_followups.session_id` reference or FTS shadow data, recompute every core
checksum with the same `coreChecksum` helper from Task 1, and assert that the
final filename and lock remain.  These prove the coordinator calls the shared
validator rather than a new partial check.

- [ ] **Step 2: Run the fault matrix and verify RED**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retirement intent|retired pathname|unjournaled retired|legacy quarantine|forged.*(reference|FTS)" dist-test/tests/projection-coordinator.test.js
```

Expected: FAIL because the coordinator cannot resume journal intents, does not
enumerate retired evidence, and has no post-rename crash boundaries.

- [ ] **Step 3: Implement deterministic intent recovery before final-candidate scan**

At the start of `#reconcileUnpublished`, read the journal snapshot while the
lock is held.  For each record:

```ts
for (const record of this.#reconciliationJournal.snapshot(directory, identity, lockToken)) {
  if (record.state === "retired") {
    const observed = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
      directory, identity, lockToken, record.retiredFilename,
    );
    if (observed === null || !sameRetirementImage(observed, record.image)) {
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
    }
    continue;
  }
  const retiredPresent = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
    directory, identity, lockToken, record.retiredFilename,
  );
  if (retiredPresent !== null) {
    if (!sameRetirementImage(retiredPresent, record.image)) {
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
    }
    this.#reconciliationJournal.completeRetirement(
      directory, identity, lockToken, record, toRetirementImage(retiredPresent),
    );
  } else {
    const finalImage = filesystemStableProjectionDirectoryOperations.readGenerationImage(
      directory, identity, lockToken, record.finalFilename,
    );
    if (!sameRetirementImage(finalImage.identity, record.image)) {
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
    }
    assertUnpublishedProjectionV2Image(finalImage.bytes, record.finalFilename, binding);
    const observed = filesystemStableProjectionDirectoryOperations.retireGeneration(
      directory, identity, lockToken, finalImage.identity, record.retiredFilename,
    );
    this.#faultInjector?.hit("after-v2-retirement-rename-before-complete");
    this.#reconciliationJournal.completeRetirement(
      directory, identity, lockToken, record, toRetirementImage(observed),
    );
  }
}
```

Before this loop, enumerate strict retired and legacy-quarantine filenames.  A
retired filename must match exactly one journal record; any legacy quarantine
filename fails immediately.  A single unknown retired name, duplicate record,
sidecar, missing counterpart, or identity mismatch throws
`PROJECTION_PUBLICATION_RECOVERY_REQUIRED`; the existing lock-release path then
leaves its lock as evidence.

After journal recovery, scan only strict final V2 names for new candidate
retirement.  Retired names never affect publication routing or builder filename
selection; journal high-water prevents reuse.

- [ ] **Step 4: Run focused GREEN and V1 isolation**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 --test-name-pattern="retirement intent|retired pathname|unjournaled retired|legacy quarantine|forged.*(reference|FTS)|takes the V2 publication lock" dist-test/tests/projection-coordinator.test.js
node --test --test-concurrency=1 dist-test/tests/projection-manifest.test.js dist-test/tests/projection-builder.test.js
npm run typecheck
```

Expected: all selected V2 fault cases pass; uncertainty leaves the lock and
evidence; manifest/builder V1 isolation tests pass; typecheck exits 0.

- [ ] **Step 5: Commit recovery semantics**

```bash
git add src/orchestrator/projections/reconciliation-journal.ts src/orchestrator/projections/stable-directory.ts src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
git commit -m "fix: recover durable V2 retirement intents"
```

### Task 4: Release verification and independent Task 4 review

**Files:**
- Modify: `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/progress.md`
- Modify: `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/task-4-report.md`

- [ ] **Step 1: Run the complete Task 4 release gates on the final diff**

Run:

```bash
npm run test:subproject-3
npm run typecheck
```

Expected: `test:subproject-3` reports no failures (the Windows symlink test may
report its established expected skip); `typecheck` exits 0.  Do not mark Task 4
complete if either command fails or if a timeout hides a failed assertion.

- [ ] **Step 2: Independently review the final commits against the approved spec**

The reviewer must inspect the final diff and run the focused fault matrix.  The
review checklist is:

```text
1. No final/retired candidate disposition invokes unlink or a removal helper.
2. Every journal intent is fsynced before rename and is recoverable after both crash boundaries.
3. No-active-manifest high-water cannot regress or reuse a final generation.
4. The coordinator imports the shared integrity validator; it does not retain a partial duplicate.
5. The shared validator calls both assertReferences and assertFtsSemantics.
6. Unknown/forged/swapped/legacy evidence retains the lock; V1 routing is unchanged.
7. Full release commands are freshly green.
```

- [ ] **Step 3: Record closure only after approval**

Update `progress.md` and `task-4-report.md` with final commit IDs, exact focused
and full command output, expected skip count, review result, and any retained
operational follow-up.  Change Task 4 to complete only if Step 2 approves.

- [ ] **Step 4: Preserve the approved local ledger and hand off**

The SDD ledger is intentionally gitignored.  Confirm it is not staged while
preserving the recorded approval locally:

```bash
git check-ignore -v .superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/progress.md
git status --short
```

Expected: the ledger has an ignore rule and no accidental source/test changes
remain.  Task 5 and Task 6 begin only after the independent review is approved.
