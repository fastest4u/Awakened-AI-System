# V2 Fresh-Start Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separately initialized V2 deployment profile whose durable admission rules and compiled entry points can be exercised safely before public content features are enabled.

**Architecture:** Add a fresh-start profile alongside the historical V1-backed rollout, reuse the established store/identity/runtime boundaries, and enforce admission inside the same SQLite transaction that changes authoritative state. A distinct V2 service remains prepared and content-disabled until later public/privacy/recovery increments supply verified release evidence.

**Tech Stack:** TypeScript ESM, Node.js >=24.16.0, existing `node:sqlite` worker/driver, existing MCP SDK and Zod dependencies, `node:test`, existing build pipeline. No additional dependency is required by this foundation plan.

**Spec:** `docs/superpowers/specs/2026-09-29-v2-fresh-start-production-design.md`, approved 2026-09-29. Read it together with `docs/superpowers/plans/2026-09-29-v2-fresh-start-delivery-roadmap.md`; this plan implements F1, not all production work.

**Status:** Approved for Subagent-Driven execution on 2026-09-29. Tasks 1-5 implemented and independently reviewed through `03c4829`; Task 6 pending. Production implementation remains incomplete.

## Global Constraints

- "Its historical content must not be imported, searched, displayed, or used as a fallback by V2."
- "An already-populated destination is an error for `initialize fresh`; it must never be emptied or silently accepted as fresh."
- "A missing database after prior initialization enters recovery; it does not recreate an empty database and hide data loss."
- "No deployment or environment variable alone makes a release Active."
- "Ordinary callers cannot submit operator approvals."
- "A failure to verify a readable snapshot disables content reads rather than exposing uncertain data."
- Node minimum stays `>=24.16.0`; retain current platform support and existing migration checksums. Current registered schema is 7; add 8 without editing migrations 1-7.
- Run in an isolated checkout created/reused under the worktree skill at execution time. Base it on the committed approved design/plan, not the dirty Task 13B working tree. Do not discard or copy those unreviewed changes into this slice silently.
- Production activation stays unavailable in the shipped F1 composition; passing unit tests with injected evidence does not enable the real promotion verifier.
- Public names, values and wire JSON are versioned; use decimal strings for 64-bit positions/generations on wire and `bigint` inside storage. Reject malformed/unknown fields at trust boundaries.

## Review Focus

1. A junction, case alias, or ancestor overlap could make a fresh destination address V1; Task 2 tests real canonical-path boundaries before creating state.
2. Restart after database publication but before receipt publication could look fresh; Task 2 tests resumable initialization versus missing previously acknowledged data.
3. Recovery may race a request already admitted in another process; Task 4 tests a real transaction barrier, with either one prior commit or a refusal, never a later commit under the old generation.
4. A forged approval object or mismatched build could activate a store; Task 3 tests provenance, single use, binding, generation and evidence checks, and Task 5 proves the shipped verifier remains closed.
5. Schema-7 fixtures and bundled upgrade assertions could mask schema-8 drift; Task 1 updates explicit current-schema consumers and Task 6 runs compiled upgrade smoke without rewriting historical fixtures.

The six tasks below belong to the **F1 foundation increment**. F2/F3/F4 in the roadmap denote later increments; refer to a task as `Foundation Task N` to avoid confusing the two.

## File structure and interfaces shared by tasks

| Path | Responsibility / owner |
| --- | --- |
| `src/orchestrator/fresh-start/contracts.ts` | Strict profile/receipt/state/transition contracts and errors; Task 1 |
| `src/orchestrator/storage/migrations/0008-v2-fresh-start.ts` | Immutable receipt/releases/transitions, current state; Task 1 |
| `src/orchestrator/fresh-start/fresh-start.repository.ts` | Transaction-scoped SQL persistence/CAS; Task 1 |
| `src/orchestrator/fresh-start/fresh-start-initializer.ts`, `fresh-start-paths.ts` | Explicit fresh/resume operations and V1 boundary; Task 2 |
| `src/orchestrator/fresh-start/fresh-start-control-plane.ts`, `operator-approval.ts` | Closed transition policy and trusted approval port; Task 3 |
| `src/orchestrator/fresh-start/fresh-start-admission.ts` | Request and transaction admission/recovery fence; Task 4 |
| `src/v2/config.ts`, `composition.ts`, `app.ts`, `admin.ts`; `src/v2.ts`, `src/v2-admin.ts` | Separate prepared service and admin entry points; Task 5 |
| `scripts/run-v2-fresh-start-foundation.js`, `scripts/smoke-v2-fresh-start.js` | Focused deterministic gate and actual compiled smoke; Task 6 |
| `tests/support/fresh-start-fixture.ts` | Task-owned temporary-store fixture helpers; introduced by Task 1, extended by each owner |

No new file may become a second generic event store. Reuse `DefaultProjectStoreBootstrapService`, `ProjectBindingService`, `ProjectStoreRouter`, `ProjectStoreExecutor`, `EventAppendTransaction`, `MaintenanceFence`, and existing canonical JSON/hash/identity validators. Read their actual signatures before edits.

## Task 1: Schema 8, strict contracts, and transactional repository

**Files:** Create the contracts, migration, repository and fixture files above; create `tests/fresh-start-repository.test.ts`. Modify `src/orchestrator/storage/migrations/registry.ts`, `tests/migration-registry.test.ts`, `tests/project-store-bootstrap.test.ts`, `tests/project-store-upgrade.test.ts`, `tests/project-store-upgrade-phase-runner.test.ts`, `tests/qualified-checkpoint-migration.test.ts`, `tests/session-end-effective-state-migration.test.ts`, `tests/rollout-control-plane.test.ts`, `scripts/smoke-worker.js`, and the matching current-schema assertion in `tests/ci-lifecycle-gates.test.ts`. Those files are current-schema consumers, not permission to change old migration SQL or unrelated CI behavior.

**Interfaces:** Define in `contracts.ts`:

```ts
type FreshStartMode = 'prepared' | 'active' | 'read-only-recovery' | 'disabled';
type FreshStartIdentity = Readonly<{ projectId: ProjectId; vaultId: VaultId; storeId: StoreId }>;
type FreshStartRelease = FreshStartIdentity & Readonly<{
  profileVersion: 1; releaseId: string; buildIdentityHash: string;
  schemaIdentityHash: string; configurationHash: string;
  capabilityManifestHash: string; recoveryPolicyHash: string;
  evidenceDigest: string; createdAt: string;
}>;
type FreshStartGenesis = FreshStartIdentity & Readonly<{
  initializationId: string; releaseId: string; semanticPosition: '0';
  terminalHash: string; projectionChecksums: Readonly<Record<string, string>>;
  preparationIntentDigest: string; actorFingerprint: string; createdAt: string;
}>;
type FreshStartState = FreshStartIdentity & Readonly<{
  releaseId: string; mode: FreshStartMode; generation: bigint;
  recoveryPosition: bigint | null; recoveryHash: string | null;
  lastTransitionId: string | null; updatedAt: string;
}>;
```

Import `ProjectId`, `VaultId`, and `StoreId` from `identity/contracts.ts`. Export strict decoders `decodeFreshStartRelease(value: unknown): FreshStartRelease` and `decodeFreshStartGenesis(value: unknown): FreshStartGenesis`. UUIDs/hashes/timestamps use the existing canonical rules, semantic genesis hash uses `GENESIS_GLOBAL_HASH`, and checksums bind the actual empty projection generation. `FreshStartError` carries a closed redacted code union, never a raw input object.

`SqliteFreshStartRepository(connection: SqliteConnection).transact<T>(identity: FreshStartIdentity, operation: (tx: FreshStartTransaction) => T): T` owns `BEGIN IMMEDIATE`/commit/rollback, rejects reentrancy, promises and escaped transaction use. `FreshStartTransaction` exposes `installation(): FreshStartGenesis | null`, `state(): FreshStartState | null`, `release(releaseId: string): FreshStartRelease | null`, `install(genesis: FreshStartGenesis, release: FreshStartRelease): void`, and `transition(input: FreshStartStateChange): FreshStartState`. `FreshStartStateChange` contains expected mode/generation/release, target mode/release, transition ID, trusted approval audit metadata or typed automatic-stop reason, evidence digest, recovery position/hash, and timestamp. Define it here and reuse unchanged in Task 3. SQL enforces one installation, append-only audit/release/receipt records, project identity and uniqueness of consumed approval identity. Store state is null before install; install creates prepared generation 0 with no semantic append.

Use these exact state-change field names: `expectedMode`, `expectedGeneration: bigint`, `expectedReleaseId`, `nextMode`, `nextReleaseId`, `transitionId`, `authorization`, `evidenceDigest`, `recoveryPosition: bigint | null`, `recoveryHash: string | null`, and `recordedAt`. `authorization` is a closed union of `{ kind: 'operator'; approvalId; nonceDigest; actorFingerprint; requestDigest }` and `{ kind: 'automatic-stop'; reasonCode }`; the reason codes are `integrity-failure | privacy-failure | binding-failure | recovery-failure`. All unannotated ID/digest/timestamp fields are canonical strings. The repository persists audit metadata but does not accept it as proof; Task 3 supplies it only after trusted verification. Keep the production repository out of public controller dependencies.

- [x] **Step 1: Add schema/repository tests and their owned temporary fixture.** Assertions include:

```ts
it('installs prepared without semantic events', () => {
  assert.equal(state.mode, 'prepared');
  assert.equal(state.generation, 0n);
  assert.equal(eventCount, 0n);
});
it('rejects duplicate installation and immutable-record rewrites', () => {
  assert.throws(duplicateInstall, { code: 'FRESH_START_ALREADY_INITIALIZED' });
  assert.throws(deleteGenesis);
  assert.throws(rewriteRelease);
});
```

Bind those assertion values/functions to actual fixture SQL/repository calls, not constants. Add table-driven malformed input, wrong identity, foreign release, rollback on failure, reused approval, stale CAS, transaction escape and unexpected async-return cases. Add schema-7-to-8 migration and old-profile preservation tests.

- [x] **Step 2: Run `npm run test:build`, then `node --test --test-concurrency=1 dist-test/tests/fresh-start-repository.test.js dist-test/tests/migration-registry.test.js`.** Establish failure from the missing new contract/schema or behavior; do not damage existing code to create a failure.
- [x] **Step 3: Implement contracts and migration 8, register it, and implement repository operations.** Use separate `fresh_start_installation`, `fresh_start_releases`, `fresh_start_transitions`, and `fresh_start_control_state` tables. Keep old rollout rows/semantics unchanged. Enforce finite states and adjacent generations in SQL as well as TypeScript. New tables remain empty for existing legacy-profile stores.
- [x] **Step 4: Update the listed current-registry/upgrade expectations to version 8 and run the Step 2 command plus `tests/project-store-bootstrap.test.js`, `tests/project-store-upgrade.test.js`, and `tests/project-store-upgrade-phase-runner.test.js` under `dist-test/`.** Do not mechanically rewrite tests explicitly proving historical schema 7. Expected: all selected tests pass, with migrations 1-7 retaining their previous checksums.
- [x] **Step 5: Review and commit only this task's files as `feat: add fresh-start deployment schema and contracts`.** Record actual commands/counts and any still-applicable pending checks.

Task 1 evidence: `baf03f2` implementation and `9f13206` scoped transaction-lifetime fixes. Final compile native0; repository10/10, registry11/11, bootstrap24/24, upgrade50/50 and phase-runner4/4 passed across focused runs. The original combined97-case run had one stale bootstrap expectation (96pass/1fail), subsequently corrected and rerun24/24; it is not relabeled as a green combined run. Independent spec/quality review and scoped fix re-review passed. Compiled smoke and aggregate remain Task6. Internal callbacks are trusted synchronous code; arbitrary hostile Promise subclass runtime behavior is not sandboxed.

## Task 2: Explicit initialization, safe resume, and V1 separation

**Files:** Create `fresh-start-initializer.ts`, `fresh-start-paths.ts`, and `tests/fresh-start-initializer.test.ts`; extend `tests/support/fresh-start-fixture.ts`. Reuse the existing bootstrap/descriptor/router/projection components; modify `project-store-bootstrap.service.ts` only if a narrowly scoped publication/resume hook is necessary, preserving all existing callers.

**Interfaces:** Define `FreshStartPaths = Readonly<{ projectRoot: string; v2VaultRoot: string; v1ArchiveRoot: string }>` and `assertFreshStartPaths(paths: FreshStartPaths): Promise<FreshStartPaths>` returning canonical paths. Define `FreshStartInitializeInput = FreshStartPaths & Readonly<{ initializationId: string; release: Omit<FreshStartRelease, keyof FreshStartIdentity> }>`; fill identities from the newly created descriptor, never from caller-provided legacy identity. Export `FreshStartInitializer.initializeFresh(input: FreshStartInitializeInput): Promise<FreshStartGenesis>`, `resumeInitialization(input: FreshStartInitializeInput): Promise<FreshStartGenesis>`, and `openExisting(paths: FreshStartPaths): Promise<FreshStartGenesis>`.

The initialization ID binds a durable, exclusive `fresh-start-init.json` journal in the V2 administrative directory. Record phases `reserved`, `store-published`, `receipt-published`; record only owned paths/identities/hashes, not memory content. Fresh refuses pre-existing content; resume accepts only the exact journal and matching partial identity. `openExisting` never calls create/initialize. Use actual empty projection checksums and a database read proving semantic position 0 before installing the receipt. The normal server only opens a completed receipt.

Initial preparation is an explicit local operator action through `v2-admin`, not an ordinary content request. Persist its preparation intent digest and trusted local actor audit identity alongside the receipt; neither comes from a model-visible approval Boolean. Bind preparation to the inspected build/schema and completed foundation checks. This authorizes only prepared state, not Active. Construct the empty-generation receipt after its actual projection checks pass; do not use an all-zero placeholder checksum for a projection.

- [x] **Step 1: Add fresh, resume and path-boundary tests.** Include real Windows junction/case aliases where supported, ancestor/descendant overlap, a nonempty directory, duplicate initialize, same journal resume, foreign journal refusal, missing database after completion, and concurrent initialization. Assert stable descriptor/store IDs on resume and unchanged V1 sentinel content/metadata.

```ts
it('does not turn missing acknowledged storage into fresh data', async () => {
  await assert.rejects(openPreviouslyInitializedStore, { code: 'FRESH_START_RECOVERY_REQUIRED' });
  assert.equal(recreatedDatabase, false);
});
it('rejects archive overlap before creating a descriptor', async () => {
  await assert.rejects(initializeOverlappingRoot, { code: 'FRESH_START_PATH_OVERLAP' });
  assert.equal(createdDescriptor, false);
});
```

The fixture must actually remove only its owned test database for the missing-file case and inspect the resulting filesystem. Fault-inject at each journal/store/receipt publication boundary and resume in a new instance.

- [x] **Step 2: Run `npm run test:build`, then `node --test --test-concurrency=1 dist-test/tests/fresh-start-initializer.test.js`; confirm the new cases fail before implementation.**
- [x] **Step 3: Implement path checks and the three initializer operations.** Use explicit canonical project routing, reserve the journal exclusively before bootstrap, fsync/atomic publication patterns already present, and never reset an existing destination. Resolve and recheck path identity before publication. Do not copy V1 data or enumerate V1 contents. Keep incomplete initialization closed to request admission.
- [x] **Step 4: Rerun the Step 2 test plus `dist-test/tests/project-store-bootstrap.test.js` and `dist-test/tests/project-binding.service.test.js`.** Expected: pass, no foreign/overlapping path modification, same identities after every recoverable interruption.
- [x] **Step 5: Review and commit as `feat: initialize isolated fresh-start V2 stores`.**

Task 2 evidence: implementation `4e3bb20`; serialized `npm run test:build` native0 followed by initializer/bootstrap/binding tests native0, 86/86 passed (23 initializer, 24 bootstrap, 39 binding), no skips. Independent spec/quality review approved without findings. Real Windows junction/case and two-process contention checks ran. Abrupt process death may leave an exclusive operation lock and requires controlled recovery; no automatic lock stealing or full killed-process recovery is claimed. Task5 still supplies actual compiled-deployment measurement; F3 owns verified operational recovery.

## Task 3: Closed activation state machine and approval boundary

**Files:** Create `fresh-start-control-plane.ts`, `operator-approval.ts`, and `tests/fresh-start-control-plane.test.ts`; extend contracts/repository only for Task 1's declared transition interface.

**Interfaces:** `FreshStartControlPlane(repository: SqliteFreshStartRepository, approvals: OperatorApprovalVerifier, evidence: FreshStartEvidenceVerifier)` exposes `transition(request: FreshStartTransitionRequest): Promise<FreshStartState>` and `stop(request: FreshStartAutomaticStop): FreshStartState`. `FreshStartTransitionRequest` carries identity, expected state generation/mode/release, next mode/release, and opaque approval-envelope bytes. The envelope is not a public MCP input. `FreshStartAutomaticStop` contains identity, expected generation, target `read-only-recovery | disabled`, and a closed reason code. The approval/evidence verifier interfaces return server-created immutable values bound to all transition inputs; there is no caller-supplied `approved: true`.

`OperatorApprovalVerifier.verify(envelope: Uint8Array, requestDigest: string): Promise<VerifiedOperatorApproval>` returns a non-publicly-constructible value with approval ID, nonce digest, actor fingerprint and request/evidence binding. `FreshStartEvidenceVerifier.verify(release: FreshStartRelease): Promise<VerifiedFreshStartEvidence>` binds all release hashes and target identities, not just a Boolean. Factory functions for these verified values are private to trusted implementations. F1's production implementation is `DENY_FRESH_START_PROMOTION`, which rejects all availability-increasing transitions with `FRESH_START_RELEASE_NOT_READY`. Test verifier fixtures must stay out of production bundles; the real verified-release and operator-key implementations belong to F3 of the roadmap.

- [x] **Step 1: Add the exact allowed-edge matrix and rejection tests.** Prepared -> Active/Disabled, Active -> Read-only recovery/Disabled, Read-only recovery -> Active/Disabled, Disabled -> Prepared. Test stale expected generation, replayed approval, wrong project/store/build/evidence, forged verified result, and conflicting concurrent transitions. Availability increases and release replacements always require verified approval/evidence; automatic stop only reduces availability.

```ts
it('production verifier cannot promote a prepared release', async () => {
  await assert.rejects(promoteWithShippedVerifier, { code: 'FRESH_START_RELEASE_NOT_READY' });
  assert.equal(currentMode, 'prepared');
});
it('consumes one approval only once across concurrent attempts', async () => {
  assert.equal(successfulTransitions, 1);
  assert.equal(generationAfter, generationBefore + 1n);
});
```

Use actual concurrent repository connections for the second assertion. A fake verifying port tests state policy only; it is never treated as real production approval evidence.

- [x] **Step 2: Run `npm run test:build`, then `node --test --test-concurrency=1 dist-test/tests/fresh-start-control-plane.test.js`; verify meaningful failure.**
- [x] **Step 3: Implement strict transition validation and verification before mutation, then recheck state/identity inside the repository transaction.** Audit and CAS atomically; consume approvals once. Preserve the old `RolloutControlPlane` and its closed default gate.

Release replacement follows Disabled -> Prepared with a newly verified release; there is no Active -> Active replacement shortcut. Reopening an unchanged store is not a preparation transition. The production foundation may perform explicit local preparation and automatic availability reduction, but cannot increase availability to Active.
- [x] **Step 4: Rerun Step 2 plus `dist-test/tests/fresh-start-repository.test.js` and `dist-test/tests/rollout-control-plane.test.js`.** Expected: pass; old percentage-canary behavior unchanged and fresh production promotion still denied.
- [x] **Step 5: Review and commit as `feat: enforce fresh-start activation policy`.**

Task 3 evidence: implementation `b234374`; serialized compile native0 and control/repository/legacy-rollout tests native0, 140/140 passed (45+10+85), no skips. Independent spec/quality review approved without findings. Trusted provider boundaries privately mint runtime-authentic values; fixtures are not real release evidence and the shipped verifier denies promotion. Task4 must replace the temporary preserved recovery-fence fields with same-transaction actual capture before F1 completion.

## Task 4: Admission inside authoritative transactions and recovery fencing

**Files:** Create `fresh-start-admission.ts`, `tests/fresh-start-admission.test.ts`, and `tests/fixtures/fresh-start-admission-child.ts`. Modify `src/orchestrator/fresh-start/fresh-start-control-plane.ts`, `src/orchestrator/storage/event-append-transaction.ts`, `src/orchestrator/storage/event-store.ts`, `src/orchestrator/lifecycle/lifecycle-command.store.ts`, `src/orchestrator/lifecycle/lifecycle-operational.store.ts`, `src/orchestrator/runtime/project-store-executor.ts`, `src/orchestrator/runtime/project-store-worker-backend.ts`, `src/orchestrator/runtime/project-store-worker-runtime.ts`, `src/orchestrator/runtime/worker-protocol.ts`, `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts`, and `src/workers/project-store.worker.ts` where required to transport/enforce a trusted release identity. Include corresponding tests `tests/event-store.test.ts`, `tests/lifecycle-command-store.test.ts`, `tests/lifecycle-worker-runtime.test.ts`, and `tests/lifecycle-worker-protocol.test.ts` where their interfaces change.

**Interfaces:** `FreshStartAdmissionGuard(connection: SqliteConnection)` exposes `assertRequestAllowed(input: FreshStartAdmissionInput): FreshStartAdmission`, `assertMutationAllowed(input: FreshStartAdmissionInput): void`, and `captureRecoveryFence(identity: FreshStartIdentity, expectedGeneration: bigint): FreshStartRecoveryFence`. Input includes trusted identity, `releaseId`, measured build hash, captured state generation, and operation kind `content-read | semantic-mutation | command-recovery`; these are transport-private, not editable tool fields. Admission and recovery-fence results contain identity/release/generation plus verified event position/hash. Define and reuse these exact types here. Ordinary mutable lease/housekeeping work is separately allowlisted; it cannot create semantic commands or change user-visible authority during recovery.

Require the guard in the shared append path before any new semantic event and before lifecycle authority mutations in their enclosing transaction. A fresh-start store is detected by its immutable installation; absence on a context declared fresh-start is an error, not legacy fallback. Historical stores without the profile retain current behavior. Do not add a caller-controlled bypass flag. Extend the worker wire codec and opening handshake to bind the release/build context; schema/build mismatch refuses opening. Stored-command recovery must retain existing authorization checks and may reveal committed results only through an allowed verified read/recovery path.

`captureRecoveryFence` uses the already-open transaction owned by the control-plane transition and never nests `BEGIN`. Task 3's `stop` and operator recovery transition both use this capture before committing the new state. In this foundation, recovery content reads remain denied because no verified public content-view provider is installed yet; later composition may allow them only with its verified view. An internal authorized dedup probe may recover committed command status without authorizing a new append.

- [x] **Step 1: Add process-backed transaction-race tests.** Hold one real writer around `BEGIN IMMEDIATE`, change state through another connection/process, release the barrier, and assert a commit before the fence or a typed refusal after it. Exercise generic and lifecycle appends, bounded authority mutations, dedup replay, wrong release/build, missing receipt, and legacy unaffected behavior.

```ts
it('rejects a request admitted before a completed recovery transition', async () => {
  await assert.rejects(resumeStaleAppend, { code: 'FRESH_START_ADMISSION_STALE' });
  assert.equal(positionAfter, recoveryFencePosition);
});
it('recovery does not create a second semantic result', async () => {
  assert.deepEqual(recoveredEventIds, committedEventIds);
  assert.equal(semanticCommandCount, 1n);
});
```

Use process barriers and production append APIs, not fabricated dedup rows. Include timeout/error cleanup of owned child processes.

- [x] **Step 2: Run `npm run test:build`, then `node --test --test-concurrency=1 dist-test/tests/fresh-start-admission.test.js`; observe failures from missing enforcement.**
- [x] **Step 3: Wire request and transaction checks into every owned mutation entry point.** Transition to recovery and capture the last committed event/hash under the same write serialization; treat that as the conservative acknowledged boundary. Existing in-flight commits finish before that fence or are refused after it. Keep any data-changing recovery capability operator-only. No path may report writes drained before the actual fence is recorded.
- [x] **Step 4: Run Step 2 plus `dist-test/tests/event-store.test.js`, `dist-test/tests/lifecycle-command-store.test.js`, `dist-test/tests/lifecycle-worker-runtime.test.js`, `dist-test/tests/lifecycle-worker-protocol.test.js`, and `dist-test/tests/maintenance-fence.test.js`.** Expected: pass, unchanged idempotency/recovery semantics and no stale post-fence semantic append.
- [x] **Step 5: Review and commit as `feat: fence fresh-start request admission at commit`.**

Task 4 evidence: `cc76224` implementation plus `3ed54d1` test-only native-contention fix. Serial compilation and ten focused files passed 270/270, native0. Independent review identified that the original pre-BEGIN child-ready signal did not prove contention; the corrected fixture observes real SQLITE_BUSY during production stop before releasing the held writer, then explicitly retries after confirmed commit. Fresh compilation and admission26/26 passed, native0, and scoped re-review accepted. The prior broader run is not represented as newly rerun. Narrow additional owned-transaction guards in `lifecycle-command.processor.ts` and `lifecycle-query.service.ts` plus their tests were approved as R17/R18. Recovery capture now replaces Task3's temporary preserved fields in both operator and automatic paths. Recorded tail is a conservative committed boundary, not a full-history verifier/public content view. Task5 still wires actual independent compiled-build measurement; F1 public content remains denied.

## Task 5: Separate compiled entry points and prepared-only diagnostics

**Files:** Create the `src/v2/` and entry files in the structure table plus `tests/v2-foundation-entry.test.ts` and `docs/v2-fresh-start-operations.md`. Modify `scripts/build.js` and `package.json` only for new bundles/scripts; preserve `src/app.ts` and the existing V1 registrations. Any later worker composition must enter through the explicit factory below.

**Interfaces:** `loadV2LaunchConfig(env: Readonly<Record<string, string | undefined>>): V2LaunchConfig` requires `MEMORY_PROJECT_ROOT`, `MEMORY_V2_VAULT_PATH`, `MEMORY_V1_ARCHIVE_PATH`, and `MEMORY_V2_RELEASE_ID`; disallow dynamic/auto/default fallback for server startup. Administrative initialize may propose `<project>/memory-v2` but prints and validates the resolved value before use. `createV2Foundation(config: V2LaunchConfig): Promise<V2Foundation>` returns `status(): Promise<FreshStartStatus>` and `close(): Promise<void>`. `FreshStartStatus` exposes profile/version, opaque identities, state/generation, schema/build, and `productionReady: false`; never return private keys, raw paths or V1 content through public diagnostics.

Choose bundles `dist/v2.js` (stdio MCP) and `dist/v2-admin.js` (local operator CLI). Add `start:v2` using `check:runtime` then `node dist/v2.js`. The CLI supports exactly `initialize-fresh`, `resume-initialization`, and `status` with explicit `--project-root`, `--v2-vault-root`, `--v1-archive-root`, and release-manifest input; it has **no activate command in F1**. The V2 server exposes a read-only `memory_v2Status` diagnostic and rejects content tool invocation with `FRESH_START_RELEASE_NOT_READY`. It neither creates a store on startup nor registers existing Markdown controllers. Keep future content-adapter dependencies behind a typed composition boundary, with no testing-only injection from environment variables.

- [x] **Step 1: Add process-level entry tests.** Missing/dynamic roots fail before any file creation; status does not scan V1; repeated server starts reopen one identity; content calls and activation attempts are refused; `stdout` contains only protocol messages. Test environment errors containing a credential sentinel and require the sentinel to be absent from diagnostics.

```ts
it('compiled foundation cannot enable production through configuration', async () => {
  assert.equal(status.productionReady, false);
  assert.equal(contentError.code, 'FRESH_START_RELEASE_NOT_READY');
  assert.equal(v1AccessCount, 0);
});
```

The V1 access count must come from instrumented filesystem boundaries or an inaccessible sentinel archive exercised by the actual process; do not infer it from an empty result alone.

- [x] **Step 2: Run `npm run test:build`, then `node --test --test-concurrency=1 dist-test/tests/v2-foundation-entry.test.js`; confirm the missing entry/config behavior fails.**
- [x] **Step 3: Implement config, prepared composition, stdio diagnostics and CLI routing, then add both bundles to the build.** Keep diagnostics redacted and install only the deny-by-default promotion verifier. Document the exact commands as available only after this task builds, and document the unsupported content state clearly.
- [x] **Step 4: Run `npm run build`, `npm run test:build`, and `node --test --test-concurrency=1 dist-test/tests/v2-foundation-entry.test.js`.** Expected: both bundles exist, compiled process tests pass and the existing V1 entry is unchanged.
- [x] **Step 5: Review and commit as `feat: add prepared-only V2 service entry points`.**

Task 5 evidence: `084ac1a` implementation plus `03c4829` hardlink-read fix. Build and compilation native0; six-file focused integration131/131, current-byte loader9/9 and provenance25/25 passed in separately recorded runs. Independent review identified actual V1 bytes read through an outside-archive hardlink. Two compiled-process regressions demonstrated the defect before the fix; opened-handle single-link/bigint identity validation now precedes bounded reads. Fresh build/compilation and complete entry9/9 passed, native0, and scoped independent re-review accepted. No full suite was run for this task. Actual measured admin/server/worker deployment identities are F1 integrity evidence, not signed F3 release evidence; the shipped verifier still denies promotion and content. Task6 owns aggregate checks and CI reconciliation.

## Task 6: Focused gate, isolation contract and handoff evidence

**Files:** Create `scripts/run-v2-fresh-start-foundation.js`, `scripts/smoke-v2-fresh-start.js`, and `tests/ci-fresh-start-foundation.test.ts`. Modify `package.json`, `.github/workflows/ci.yml`, `tests/ci-lifecycle-gates.test.ts`, and the operations document narrowly. Create `docs/superpowers/evidence/2026-09-29-v2-fresh-start-foundation.md` only when actual results exist.

**Interfaces:** Add `npm run test:v2-fresh-start-foundation`: compile tests once, then run exactly the six fresh-start repository/initializer/control/admission/entry/CI test files named above serially, reporting native exit status. Add `node scripts/smoke-v2-fresh-start.js` to applicable build-artifact checks. The runner owns only its child processes and isolated temporary roots; it must propagate failure, timeout and cancellation without manufacturing a successful completion record.

- [ ] **Step 1: Add executable CI/build contract tests.** Assert both new entry artifacts are built, the focused gate is invoked, public V1 stays unchanged, and the old V1-only source fence permits only the explicit prepared V2 composition while still rejecting migration/test-fixture or generic-event-append exposure. Include a fake failed child to prove the runner returns nonzero and never emits success.
- [ ] **Step 2: Run `npm run test:build`, then `node --test --test-concurrency=1 dist-test/tests/ci-fresh-start-foundation.test.js`; confirm the missing gate fails.**
- [ ] **Step 3: Implement the runner and CI integration.** Compile once, use real child exit codes, and prevent concurrent gate runs over shared outputs. Inspect the preserved Task13B diff separately before reconciling overlapping package/CI files; do not mark its migration gate passed or remove unrelated migration coverage.
- [ ] **Step 4: Run `npm run typecheck`, `npm run build`, `npm run test:v2-fresh-start-foundation`, `npm run test:build-artifacts`, and the focused existing tests named in Tasks 1-4 that have changed since their last verified inputs.** Expected: native exit 0; no unresolved identity/admission/initialization regression. Do not run the full suite separately for each task. Run any additionally required unchanged repository release gate once at the increment boundary and record exact source/config hashes; final production release checks belong to roadmap F3.
- [ ] **Step 5: Obtain independent specification/quality review under the preserved Subagent-Driven method, resolve concrete findings, and write the evidence document.** Include source commit, commands/native outcomes, fixture platform coverage, preserved legacy scope, and the exact remaining F2-F4 dependencies. Report **foundation complete, production implementation incomplete**; the actual promotion verifier still denies activation.
- [ ] **Step 6: Commit as `test: verify fresh-start foundation and compiled isolation`.** Update this plan's completed checkboxes only against actual evidence. Move next to the public-memory/privacy plan using the delivered interfaces, not to live deployment.

## Plan self-review and coverage

This slice owns spec section 4's storage boundary and section 6's profile/admission contract, plus the entry-point portion of section 5. Its production verifier deliberately remains closed until roadmap F2/F3 supply content/privacy/recovery evidence. Actual archive protection and client switch belong to F4; the initializer only rejects overlap and reads required path metadata.

All five Review Focus risks map to explicit tests. Interface owners are Tasks 1-5; the evidence/approval production implementation is an explicitly unshipped later dependency, not a fabricated success path. Schema consumers and worker protocol changes are in scope. No step resets a populated store, copies live V1 data, changes client configuration, or claims that the first six tasks make V2 production-ready.
