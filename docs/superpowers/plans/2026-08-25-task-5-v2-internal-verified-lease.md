# Task 5 V2 Internal Verified Lease Implementation Plan

> **Execution status (2026-08-25):** Tasks 1–3 and the Task 4 audit/review actions are complete at `a55f874`. The final full Subproject 3 gate was run and is **blocked**: 242 passed, 4 `PROJECTION_LAG` deadline failures in existing coordinator coverage, and 1 expected Windows symlink skip. The newly registered V2 lease and V2 candidate suites both passed (6/6 and 4/4). This approved evaluator-only Task 5 does not provide V2 production routing or cutover.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an evaluator-only V2 reader lease that queries a detached, checksum-verified SQLite byte image and protects its final filename from V2 reconciliation while it is leased.

**Architecture:** Keep every public Version 1 surface unchanged.  A new V2 registry creates a private `DatabaseSync` from the stable-directory worker's descriptor-captured bytes before it records a logical filename lease.  The V2 coordinator acquires that lease under the existing manifest-publication lock, and a separate V2 candidate adapter reads only `lease.database`; neither adapter nor runtime path receives a pathname.

**Tech Stack:** TypeScript, Node.js 24.16+ `node:sqlite` `DatabaseSync`, Node test runner, existing stable-directory worker, SQLite projection V2.

**Approved scope:** This plan implements [the approved V2-only amendment](../specs/2026-08-25-task-5-v2-internal-verified-lease-amendment.md).  It does not wire V2 into `InternalProjectionRuntime`, expose a V2 production route, alter `ProjectionReaderLease`/`ProjectionBuildCoordinator`, or deploy/cut over traffic.

---

## File structure and invariants

- Create `src/orchestrator/projections/v2-reader-lease.ts`: owns the V2-only public-internal contracts, byte-hash validation, detached image construction, logical filename reference counting, and idempotent shutdown.
- Modify `src/orchestrator/projections/coordinator.ts`: adds only `V2ProjectionBuildCoordinator.leasePublishedForEvaluation(binding)` and merges the V2 registry's active filenames into its existing reconciliation exclusion callback.
- Modify `src/orchestrator/retrieval/candidates.ts`: extracts a private-database collection seam and supports its existing private helpers for a V1-or-V2 manifest without changing the `SqliteRetrievalCandidateRepository` signature or behavior.
- Create `src/orchestrator/retrieval/v2-candidates.ts`: contains the V2-named evaluator adapter; it accepts a `V2ProjectionReaderLease`, never a path, and never closes the caller-owned lease.
- Create `tests/v2-reader-lease.test.ts` and `tests/v2-retrieval-candidates.test.ts`: use real published V2 images, not mock SQLite objects.
- Modify `tests/projection-coordinator.test.ts`: proves capture/retention and failure behavior through the coordinator.
- Modify `package.json`: adds both new test files to the explicit `test:subproject-3` list.

The path captured by `StableProjectionDirectoryOperations.readGenerationImage` is a one-time acquisition mechanism.  After it returns, the lease, its registry, and the V2 candidate adapter must not retain, rebuild, reopen, inspect, or revalidate a database pathname.  A file's hash must be checked both from the stable identity and from the captured `Uint8Array` before SQLite opens it.

### Task 1: Detached V2 image and logical lease registry

**Files:**
- Create: `src/orchestrator/projections/v2-reader-lease.ts`
- Test: `tests/v2-reader-lease.test.ts`
- Reference: `src/orchestrator/projections/integrity.ts:293-337`, `src/orchestrator/projections/stable-directory.ts:855-920`, `src/orchestrator/projections/manifest.ts:101-121`

- [x] **Step 1: Write failing image/registry tests first.**

  In `tests/v2-reader-lease.test.ts`, build a real V2 projection with the existing `ImmutableProjectionBuilder` and `V2ProjectionBuildCoordinator`, acquire its `StableProjectionGenerationImage` under `acquireProjectionManifestPublicationLease`, then write these tests against the desired API:

  ```ts
  const image = filesystemStableProjectionDirectoryOperations.readGenerationImage(
    generation.projectionDirectory,
    generation.directoryIdentity,
    publicationLease.lockToken,
    generation.manifest.databaseFile,
  );
  const lease = registry.acquire(Object.freeze({ manifest: generation.manifest, image }));
  assert.equal(lease.database.prepare("SELECT schema_version FROM projection_metadata").get()?.schema_version, 2n);
  assert.deepEqual(registry.activeFilenames(), [generation.manifest.databaseFile]);
  ```

  Add independent tests that (a) replace `image.identity.sha256` with a different 64-hex digest, (b) replace `image.bytes` with malformed bytes, and (c) change `image.identity.filename`.  Each must throw `LifecycleError` with code `INTEGRITY_FAILURE`, and `registry.activeFilenames()` must remain empty.  Add a test that calls `lease.close()` twice, asserts `activeFilenames()` becomes empty once, and asserts a query on `lease.database` now throws because the private database was closed.  Add a direct `PRAGMA query_only`, `PRAGMA trusted_schema`, and `PRAGMA foreign_keys` assertion on an acquired lease database.

- [x] **Step 2: Run the new tests and record RED.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 dist-test/tests/v2-reader-lease.test.js
  ```

  Expected: the test build fails because `v2-reader-lease.ts` and its exported V2 contracts do not yet exist, or the direct test run fails because the module cannot be resolved.  Do not write production code until that is the observed failure.

- [x] **Step 3: Implement the V2-only contracts and verified image.**

  Create `v2-reader-lease.ts` with these contracts; do not import `reader-lease.ts` and do not expose a database path:

  ```ts
  export interface VerifiedV2ProjectionImage {
    readonly database: DatabaseSync;
    readonly sha256: string;
    close(): void;
  }

  export interface V2ProjectionReaderLease {
    readonly manifest: ProjectionManifestV2;
    readonly database: DatabaseSync;
    close(): void;
  }

  export interface LeasableV2ProjectionGeneration {
    readonly manifest: ProjectionManifestV2;
    readonly image: StableProjectionGenerationImage;
  }

  export class V2ProjectionLeaseUnavailableError extends Error {
    readonly code = "PROJECTION_LEASE_UNAVAILABLE" as const;
    constructor() {
      super("PROJECTION_LEASE_UNAVAILABLE");
      this.name = "V2ProjectionLeaseUnavailableError";
    }
  }
  ```

  Implement `openVerifiedV2ProjectionImage(image, manifest, busyTimeoutMs?)` as the single image constructor:

  ```ts
  export function openVerifiedV2ProjectionImage(
    image: StableProjectionGenerationImage,
    manifest: ProjectionManifestV2,
    busyTimeoutMs?: number,
  ): VerifiedV2ProjectionImage {
    if (
      image.identity.filename !== manifest.databaseFile
      || image.identity.sha256 !== manifest.databaseSha256
      || sha256Bytes(image.bytes) !== manifest.databaseSha256
    ) return integrityFailure();
    let database: DatabaseSync | undefined;
    try {
      database = openImmutableProjectionImage(image.bytes, busyTimeoutMs);
      let closed = false;
      return Object.freeze({
        database,
        sha256: manifest.databaseSha256,
        close: (): void => {
          if (closed) return;
          closed = true;
          database!.close();
        },
      });
    } catch {
      try { database?.close(); } catch { /* retain original integrity failure */ }
      return integrityFailure();
    }
  }
  ```

  `sha256Bytes` must use `createHash("sha256").update(bytes).digest("hex")`; `integrityFailure` must throw `new LifecycleError("INTEGRITY_FAILURE")`.  Reuse `openImmutableProjectionImage`, whose current implementation creates a detached normalized copy and verifies `query_only`, `trusted_schema`, `foreign_keys`, and `busy_timeout`.  Do not add a `DatabaseSync` pathname open, `readFileSync`, or path field in this module.

- [x] **Step 4: Implement atomic logical leasing.**

  Implement a standalone `V2ProjectionReaderLeaseRegistry` with a private `Map<string, number>` keyed only by `manifest.databaseFile` and this observable surface:

  ```ts
  export class V2ProjectionReaderLeaseRegistry {
    acquire(generation: LeasableV2ProjectionGeneration): V2ProjectionReaderLease {
      const image = openVerifiedV2ProjectionImage(generation.image, generation.manifest);
      const previous = this.#leases.get(generation.manifest.databaseFile) ?? 0;
      this.#leases.set(generation.manifest.databaseFile, previous + 1);
      let closed = false;
      return Object.freeze({
        manifest: generation.manifest,
        database: image.database,
        close: (): void => {
          if (closed) return;
          closed = true;
          try { image.close(); } finally { this.#release(generation.manifest.databaseFile); }
        },
      });
    }

    activeFilenames(): readonly string[] {
      return Object.freeze([...this.#leases]
        .filter(([, count]) => count > 0)
        .map(([filename]) => filename)
        .sort());
    }
  }
  ```

  `#release` must decrement once, delete a zero-count entry, and throw `INTEGRITY_FAILURE` only if an impossible negative count is reached.  Image construction occurs before `#leases.set`, so every checksum/deserialization failure leaves no filename reference.  Closing the private image precedes releasing its logical reference, so reconciliation cannot retire a name while a usable lease still exists.

- [x] **Step 5: Run the focused green tests and typecheck.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-reader-lease.test.js
  npm run typecheck
  ```

  Expected: all Task 1 tests pass; typecheck exits 0.  Confirm the test performs all assertions through a real in-memory SQLite image rather than a mocked database.

- [x] **Step 6: Commit the isolated image/registry change.**

  ```powershell
  git add src/orchestrator/projections/v2-reader-lease.ts tests/v2-reader-lease.test.ts
  git commit -m "feat: add verified V2 projection reader leases"
  ```

### Task 2: Acquire V2 evaluator leases under the publication lock

**Files:**
- Modify: `src/orchestrator/projections/coordinator.ts:1-91,538-560,670-755,842-1048`
- Modify: `tests/projection-coordinator.test.ts`
- Reference: `src/orchestrator/projections/v2-reader-lease.ts`, `src/orchestrator/projections/stable-directory.ts:920-927,1439-1450`

- [x] **Step 1: Write failing coordinator tests first.**

  Add tests after existing V2 coordinator coverage that first publish a real V2 generation and then call the desired internal method:

  ```ts
  const lease = await coordinator.leasePublishedForEvaluation(BINDING);
  assert.equal(lease.manifest.databaseFile, "projections-2-1.sqlite");
  assert.equal(lease.database.prepare("SELECT count(*) AS n FROM projection_metadata").get()?.n, 1n);
  ```

  Add the following independent regressions:

  1. Set the coordinator's `pathInspection` so the directory identity changes during acquisition; `leasePublishedForEvaluation` must reject with `PROJECTION_PATH_INVALID` and issue no lease.
  2. Create a `-wal` or `-shm` sidecar beside the final V2 file before acquisition; it must reject before a lease is issued.
  3. After acquiring a lease, rename the final file away, replace the original pathname with a different file, truncate it, and mutate its SQLite content in separate fixture cases.  The query against `lease.database` must still return the original captured metadata/item results.
  4. Publish generation 1, acquire its lease, then publish generation 2.  Call `ensurePublished(BINDING, 2n, 2_000)` once more so its entry reconciliation observes generation 2 as active and generation 1 as an unreferenced final.  Assert generation 1's filename remains present while the V2 lease is open; close it, call `ensurePublished(BINDING, 2n, 2_000)` again, and assert generation 1 has been retired according to the existing Task 4 reconciliation protocol.

- [x] **Step 2: Run the coordinator additions and verify RED.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-coordinator.test.js
  ```

  Expected: compilation or tests fail specifically because `leasePublishedForEvaluation` and V2-registry retention integration have not been implemented.

- [x] **Step 3: Add V2 registry ownership without changing V1 types.**

  In `coordinator.ts`, import only the new V2 types and add an optional internal registry option:

  ```ts
  readonly evaluationLeases?: V2ProjectionReaderLeaseRegistry;
  ```

  Replace the current one `#leasedFilenames` field with these three V2-coordinator-private fields; no V1 class field changes:

  ```ts
  readonly #externalLeasedFilenames: () => readonly string[];
  readonly #evaluationLeases: V2ProjectionReaderLeaseRegistry;
  readonly #leasedFilenames: () => readonly string[];
  ```

  Initialize them as follows:

  ```ts
  this.#externalLeasedFilenames = options.leasedFilenames ?? (() => Object.freeze([]));
  this.#evaluationLeases = options.evaluationLeases ?? new V2ProjectionReaderLeaseRegistry();
  this.#leasedFilenames = () => Object.freeze([...new Set([
    ...this.#externalLeasedFilenames(),
    ...this.#evaluationLeases.activeFilenames(),
  ])].sort());
  ```

  Preserve `leasedFilenames` exactly as a test seam and use the merged private callback only in `#reconcileUnpublished`.  Do not add any V2 method to `ProjectionBuildCoordinator`, `DefaultProjectionBuildCoordinator`, or `InternalProjectionRuntime`.

- [x] **Step 4: Implement locked one-shot capture.**

  Add this internal-only public method on `V2ProjectionBuildCoordinator` directly after `ensurePublished`:

  ```ts
  async leasePublishedForEvaluation(binding: ProjectBinding): Promise<V2ProjectionReaderLease> {
    return this.#serialized(binding.projectId, async () => {
      const identity = this.#ensureProjectionDirectory();
      const publicationLease = acquireProjectionManifestPublicationLease(this.#projectionDirectory);
      let retainLock = true;
      try {
        if (!sameProjectionDirectoryIdentity(identity, publicationLease.directoryIdentity)) {
          throw new Error("PROJECTION_PATH_INVALID");
        }
        const published = this.#loadPublishedLocked(binding, identity);
        if (published === null) throw new V2ProjectionLeaseUnavailableError();
        const image = filesystemStableProjectionDirectoryOperations.readGenerationImage(
          this.#projectionDirectory,
          identity,
          publicationLease.lockToken,
          published.manifest.databaseFile,
        );
        const lease = this.#evaluationLeases.acquire(Object.freeze({
          manifest: published.manifest,
          image,
        }));
        retainLock = false;
        return lease;
      } finally {
        publicationLease.release(retainLock);
      }
    });
  }
  ```

  Before `readGenerationImage`, require that `identity` still equals `#requiredDirectoryIdentity()` and preserve `#loadPublishedLocked`'s sidecar, manifest-content, hash, and stable-final checks.  If any path or stable-worker operation fails, do not create the registry lease; translate absence to `V2ProjectionLeaseUnavailableError`, preserve `LifecycleError`, and surface other uncertainty as `PROJECTION_PATH_INVALID` or `MATERIALIZATION_CONFLICT` according to the existing coordinator convention.  The method must release the cooperative lock after registry acquisition, never retain it during evaluator use.

- [x] **Step 5: Run focused green verification and commit.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-coordinator.test.js dist-test/tests/v2-reader-lease.test.js
  npm run typecheck
  git diff --check
  ```

  Expected: test command has zero failures, typecheck exits 0, and `git diff --check` has no output.

  Commit:

  ```powershell
  git add src/orchestrator/projections/coordinator.ts tests/projection-coordinator.test.ts
  git commit -m "feat: acquire V2 evaluation leases from pinned images"
  ```

### Task 3: V2-only retrieval candidate adapter

**Files:**
- Modify: `src/orchestrator/retrieval/candidates.ts:1-11,139-249,614-837,912-942`
- Create: `src/orchestrator/retrieval/v2-candidates.ts`
- Create: `tests/v2-retrieval-candidates.test.ts`
- Modify: `package.json:21-33`
- Reference: `src/orchestrator/projections/manifest.ts:101-121`, `src/orchestrator/projections/v2-reader-lease.ts`

- [x] **Step 1: Write failing V2 adapter tests first.**

  Create `tests/v2-retrieval-candidates.test.ts` using a real coordinator lease and the desired API:

  ```ts
  const lease = await coordinator.leasePublishedForEvaluation(BINDING);
  const repository = new V2SqliteRetrievalCandidateRepository();
  const result = repository.collectEligible(lease, request);
  assert.equal(result.channels.flatMap((channel) => channel.candidates).length > 0, true);
  ```

  In the same test suite, acquire a lease, replace/rename/truncate the original final path, call `collectEligible`, and assert the returned candidate IDs and summaries equal the pre-mutation baseline.  Spy only at the stable-directory boundary or use a path fixture that becomes invalid: the assertion must prove the adapter succeeds solely through its existing `lease.database`, not through a new pathname open.  Add a test that invokes `collectEligible` twice and then queries `lease.database`; it must remain usable until the test calls `lease.close()`.

  Add a TypeScript fixture that assigns the existing `SqliteRetrievalCandidateRepository` to a `ProjectionReaderLease` call and uses an unchanged V1 request, so its public signature remains protected by compilation.  Do not convert that V1 test to a V2 type.

- [x] **Step 2: Run the new adapter tests and verify RED.**

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retrieval-candidates.test.js
  ```

  Expected: the test build fails because `V2SqliteRetrievalCandidateRepository` does not exist.  Do not first add an adapter that opens a filename.

- [x] **Step 3: Extract a database-taking collection seam while preserving V1 behavior.**

  In `candidates.ts`, introduce the private-union alias and change only internal helper parameter types:

  ```ts
  type RetrievalProjectionManifest = ProjectionManifestV1 | ProjectionManifestV2;

  function verifyMetadata(database: DatabaseSync, manifest: RetrievalProjectionManifest): void {
    const metadata = database.prepare(`
      SELECT project_id, vault_id, store_id, workspace_id, branch_scope_id, branch_ref,
             session_id, generation, terminal_event_position, terminal_event_hash
      FROM projection_metadata WHERE singleton = 1 AND schema_version = ?
    `).get(manifest.schemaVersion);
    // Retain every existing identity, generation, terminal-position, and hash assertion.
  }
  ```

  Change `canonicalItem`, `scopedItem`, all channel selectors, `conflictClosure`, `conflictCursor`, and `collectChannels` to accept `RetrievalProjectionManifest`.  Their fields are common to V1 and V2.  Keep the V1 cursor bytes unchanged by deriving its label from `manifest.schemaVersion`:

  ```ts
  const cursorPrefix = `retrieval-conflict-closure-v${manifest.schemaVersion}`;
  // hash cursorPrefix, then return `${cursorPrefix}:${returnedMemberCount}:${digest}`
  ```

  Export exactly one internal database seam for the V2 adapter:

  ```ts
  export function collectEligibleFromProjectionDatabase(
    database: DatabaseSync,
    manifest: RetrievalProjectionManifest,
    input: InternalRetrievalRequest,
  ): RetrievalCandidateCollection {
    const request = validateInternalRetrievalRequest(input);
    verifyMetadata(database, manifest);
    const collected = collectChannels(database, manifest, request);
    return Object.freeze({
      channels: collected.channels,
      eligibleItemCount: collected.eligibleItemCount,
      droppedItemCount: collected.droppedItemCount,
      truncated: collected.truncated,
      conflictGroups: collected.conflictGroups,
    });
  }
  ```

  Rewrite the existing `SqliteRetrievalCandidateRepository.collectEligible` to preserve its current public V1 parsing, sidecar checks, `openProjection`/`finally database.close()` behavior, and errors, then call that seam after opening its own database.  It must still parse only `ProjectionManifestV1` and accept only `ProjectionReaderLease`.

- [x] **Step 4: Implement the pathless V2 adapter.**

  Create `v2-candidates.ts` with no import from `node:sqlite`, `node:fs`, or `node:path`:

  ```ts
  import type { InternalRetrievalRequest, RetrievalCandidateCollection } from "./contracts.js";
  import { collectEligibleFromProjectionDatabase } from "./candidates.js";
  import { parseProjectionManifestV2 } from "../projections/manifest.js";
  import type { V2ProjectionReaderLease } from "../projections/v2-reader-lease.js";
  import { InternalRetrievalError } from "./contracts.js";

  export class V2SqliteRetrievalCandidateRepository {
    collectEligible(
      lease: V2ProjectionReaderLease,
      input: InternalRetrievalRequest,
    ): RetrievalCandidateCollection {
      try {
        const manifest = parseProjectionManifestV2(lease.manifest, input.binding);
        return collectEligibleFromProjectionDatabase(lease.database, manifest, input);
      } catch (error) {
        if (error instanceof InternalRetrievalError) throw error;
        throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
      }
    }
  }
  ```

  Do not close `lease.database`, accept a `databasePath`, call `assertProjectionSidecarsAbsent`, construct `DatabaseSync`, or add the adapter to `InternalRetrievalService` or runtime wiring.

- [x] **Step 5: Include the tests in the Subproject 3 gate and verify green.**

  Append these two explicit compiled tests after the other projection tests in the `test:subproject-3` script:

  ```text
  dist-test/tests/v2-reader-lease.test.js dist-test/tests/v2-retrieval-candidates.test.js
  ```

  Run:

  ```powershell
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/retrieval-candidates.test.js dist-test/tests/v2-retrieval-candidates.test.js dist-test/tests/v2-reader-lease.test.js
  npm run typecheck
  git diff --check
  ```

  Expected: zero test failures, typecheck exit 0, no whitespace errors.  Confirm the original V1 retrieval test suite still runs unchanged.

- [x] **Step 6: Commit the V2 adapter.**

  ```powershell
  git add src/orchestrator/retrieval/candidates.ts src/orchestrator/retrieval/v2-candidates.ts tests/v2-retrieval-candidates.test.ts package.json
  git commit -m "feat: add V2 internal retrieval candidate adapter"
  ```

### Task 4: Task 5 release evidence and V1-isolation audit

**Files:**
- Verify: `src/orchestrator/projections/reader-lease.ts`, `src/orchestrator/projections/coordinator.ts`, `src/orchestrator/runtime/projection-runtime.ts`, `src/orchestrator/retrieval/candidates.ts`, `src/orchestrator/retrieval/v2-candidates.ts`
- Verify: `tests/projection-runtime.test.ts`, `tests/projection-coordinator.test.ts`, `tests/v2-reader-lease.test.ts`, `tests/v2-retrieval-candidates.test.ts`

- [x] **Step 1: Run the complete Task 5 release gate.**

  Run from `C:\\Users\\Server\\.codex\\worktrees\\subproject-3-projections`:

  ```powershell
  npm run typecheck
  npm run test:subproject-3
  git diff --check
  git status --short
  ```

  Expected: typecheck exits 0; the complete Subproject 3 suite reports no failures (record the known Windows symlink skip only if it occurs); `git diff --check` prints nothing; status contains only intentional tracked Task 5 files or is clean after commits.

- [x] **Step 2: Perform a source-boundary audit before requesting reviews.**

  Run:

  ```powershell
  rg -n "leasePublishedForEvaluation|V2ProjectionReaderLease|V2SqliteRetrievalCandidateRepository" src tests
  rg -n "V2Projection|leasePublishedForEvaluation" src/orchestrator/runtime src/orchestrator/retrieval/service.ts
  git diff --name-only HEAD~3..HEAD
  ```

  Expected: V2 lease symbols occur only in V2 coordinator, V2 lease, V2 adapter, and their focused tests; runtime/service search has no V2 lease or adapter wiring; the V1 `ProjectionBuildCoordinator` interface, `ProjectionReaderLease`, and V1 repository signature are unchanged.

- [x] **Step 3: Obtain independent reviews in this order.**

  1. Spec-compliance reviewer checks every required test and non-goal in the approved amendment against the exact Task 5 commits.
  2. If and only if spec review reports no open Critical or Important issue, code-quality reviewer checks error cleanup, close ordering, filename-counting, detached-byte use, and V1 isolation.
  3. Fix every Critical/Important issue with a regression test first; rerun the reviewer that found it and then repeat the release gate.

  Do not begin Task 6 or claim production V2 routing is ready after Task 5.  Task 5 only establishes the internal evaluator dependency required by later work.
