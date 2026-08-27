# Subproject 3 Final-Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every final-review finding so Version 2 projections/retrieval are authenticated, bounded, fully materialized, and supported by real release evidence, without changing Version 1 routing.

**Architecture:** A shared stored-event authenticator feeds a bounded streaming source reader. Schema V2 adds the missing topology, entity, artifact, follow-up, and provenance relations. The coordinator adopts staged files and reader leases own verified in-memory byte images. The release evaluator uses the actual build → publish → lease → repository → service path.

**Tech Stack:** Node.js >= 24.16.0, TypeScript, `node:sqlite` (`DatabaseSync`), SQLite/FTS5, Node test runner.

**Spec:** [2026-08-24 Subproject 3 Final-Review Remediation Design](../specs/2026-08-24-subproject-3-final-review-remediation-design.md)

## Global Constraints

- Do not alter `src/app.ts`, `src/index.ts`, `src/controllers`, `src/schemas`, or `src/services` to route Version 2.
- V2 remains internal-only; evaluation disables vectors for every request.
- Never mutate authoritative events, replay from projection rows, or infer structured V2 fields from free text.
- Authenticate every event before decode/fold, including unprojected events.
- Preflight at most 100,000 source events and 64 MiB aggregate source bytes.
- Rebuild schema V2 from events; never migrate V1 projection rows in place.
- This plan does not deploy or enable V2. PROD readiness still requires Subprojects 4 and 5.

## File structure and boundaries

| Area | Files | Task |
| --- | --- | --- |
| Shared event authority | `integrity/stored-event-authenticator.ts`, `event-integrity.service.ts` | 1 |
| Bounded source snapshot | `projections/event-reader.ts`, `builder.ts`, `coordinator.ts` | 2 |
| Schema V2 and folds | `contracts.ts`, `source-event-codec.ts`, `folds.ts`, `schema.ts`, `checksum.ts`, `manifest.ts`, `integrity.ts` | 3 |
| Publish orphan safety | `builder.ts`, `coordinator.ts`, `stable-directory.ts`, `manifest.ts` | 4 |
| Verified image lease | `generation-image.ts`, `reader-lease.ts`, `candidates.ts` | 5 |
| Ranking hard limits | `retrieval/service.ts`, `ranking.ts`, `runtime/projection-runtime.ts` | 6 |
| Sealed evaluation | `retrieval/evaluation.ts`, fixtures, runner | 7 |
| Complete release gates | `package.json`, CI gate, SDD records | 8 |

Tasks are ordered. Do not modify production files outside a task unless a direct TypeScript consumer requires a matching type update; list that exception in the task report.

### Task 1: Extract the authoritative stored-event authenticator

**Files:**
- Create: `src/orchestrator/integrity/stored-event-authenticator.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Test: `tests/stored-event-authenticator.test.ts`
- Test: `tests/event-integrity.test.ts`

**Interfaces:**

```ts
export interface StoredEventChainCursor {
  readonly expectedPosition: bigint;
  readonly previousEventHash: string;
}
export interface AuthenticatedStoredEvent {
  readonly event: StoredEvent;
  readonly canonicalPayloadJson: string;
  readonly byteLength: number;
  readonly nextCursor: StoredEventChainCursor;
}
export function authenticateStoredEvent(
  event: StoredEvent,
  cursor: StoredEventChainCursor,
): AuthenticatedStoredEvent;
```

The helper uses the existing `payloadHash`, `eventHash`, and canonical JSON implementation. It throws `INTEGRITY_FAILURE` for untrusted input. `EventIntegrityService` must call it rather than retain a second event-hash calculation.

- [ ] **Step 1: Write failing chain tests**

```ts
it("rejects forged metadata and predecessor hashes before projection", () => {
  const event = validStoredEvent();
  assert.throws(
    () => authenticateStoredEvent({ ...event, occurredAt: "2026-01-01T00:00:01.000Z" }, genesisCursor()),
    /INTEGRITY_FAILURE/,
  );
  assert.throws(
    () => authenticateStoredEvent({ ...event, previousGlobalHash: "f".repeat(64) }, genesisCursor()),
    /INTEGRITY_FAILURE/,
  );
});
```

Also assert rejection for noncanonical `payloadJson`, payload-hash mismatch, position gap, forged event hash, and terminal cursor mismatch. Add one valid multi-event chain test that proves the cursor advances exactly once.

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test dist-test/tests/stored-event-authenticator.test.js`

Expected: FAIL because the shared authenticator is absent.

- [ ] **Step 3: Implement and reuse the exact hash domain**

```ts
const payload = JSON.parse(event.payloadJson);
if (canonicalJson(payload) !== event.payloadJson || payloadHash(payload) !== event.payloadHash) {
  throw new Error("INTEGRITY_FAILURE");
}
if (event.globalPosition !== cursor.expectedPosition || event.previousGlobalHash !== cursor.previousEventHash) {
  throw new Error("INTEGRITY_FAILURE");
}
if (eventHash(eventHashInput(event)) !== event.eventHash) throw new Error("INTEGRITY_FAILURE");
```

Move the established `eventHashInput` construction from the integrity service into this helper without changing its hash domain. Keep the existing integrity-service issue adapter around the helper.

- [ ] **Step 4: Verify**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/stored-event-authenticator.test.js dist-test/tests/event-integrity.test.js`

Expected: PASS, including valid historic fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/integrity/stored-event-authenticator.ts src/orchestrator/integrity/event-integrity.service.ts tests/stored-event-authenticator.test.ts tests/event-integrity.test.ts
git commit -m "feat: authenticate projection source event chains"
```

### Task 2: Stream bounded authenticated source snapshots

**Files:**
- Modify: `src/orchestrator/projections/event-reader.ts`
- Modify: `src/orchestrator/projections/builder.ts`
- Modify: `src/orchestrator/projections/coordinator.ts`
- Test: `tests/projection-builder.test.ts`
- Test: `tests/projection-coordinator.test.ts`
- Test: `tests/projection-integrity.test.ts`

**Interfaces:**

```ts
export interface ProjectionEventSnapshot {
  readonly binding: ProjectBinding;
  readonly eventCount: number;
  readonly aggregateBytes: number;
  readonly terminalEventPosition: bigint;
  readonly terminalEventHash: string;
  events(): Iterable<StoredEvent>; // authenticated, ascending, one call only
  close(): void;
}
```

`events()` owns the read transaction until `close()`. The builder consumes the stream with its fold accumulator and must not use `.all()` or retain a second full decoded copy.

- [ ] **Step 1: Write failing bound/order tests**

```ts
it("rejects an over-limit prefix before yielding or folding", async () => {
  const reader = readerForPreflight({ eventCount: 100_001, aggregateBytes: 1 });
  await assert.rejects(() => reader.openCommittedSnapshot(BINDING), /INTEGRITY_FAILURE/);
  assert.equal(builderInvocations, 0);
});
it("does not fold an unprojected event with a forged chain hash", async () => {
  await assert.rejects(() => coordinator.ensurePublished(BINDING, 9n, 1_000), /INTEGRITY_FAILURE/);
  assert.equal(publishedManifest(), null);
});
```

Add aggregate-byte overflow, metadata tamper, one-pass ascending stream, deadline resource-close, and replay-shares-authentication tests.

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js`

Expected: FAIL because live snapshots use unbounded `.all()`.

- [ ] **Step 3: Implement native preflight and iteration**

```ts
const bounds = connection.prepare(`
  SELECT COUNT(*) AS event_count, COALESCE(SUM(${EVENT_ROW_BYTE_EXPRESSION}), 0) AS aggregate_bytes
  FROM events WHERE global_position <= $terminalPosition
`).get({ $terminalPosition: terminalPosition });
if (count > MAX_PROJECTION_SOURCE_EVENTS || bytes > MAX_PROJECTION_SOURCE_BYTES) {
  throw new Error("INTEGRITY_FAILURE");
}
for (const row of statement.iterate({ $terminalPosition: terminalPosition })) {
  yield authenticateStoredEvent(storedEvent(row), cursor).event;
}
```

Capture terminal position/hash in the same read transaction, verify binding before yielding, close the transaction on all error/deadline paths, and make integrity replay call the same preflight/authenticator.

- [ ] **Step 4: Verify**

Run: `npm run test:subproject-3`

Expected: PASS; only the known Windows symlink permission skip may be reported.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/projections/event-reader.ts src/orchestrator/projections/builder.ts src/orchestrator/projections/coordinator.ts tests/projection-builder.test.ts tests/projection-coordinator.test.ts tests/projection-integrity.test.ts
git commit -m "feat: bound and authenticate projection snapshots"
```

### Task 3: Materialize and verify schema V2 completely

**Files:**
- Modify: `src/orchestrator/projections/contracts.ts`
- Modify: `src/orchestrator/projections/source-event-codec.ts`
- Modify: `src/orchestrator/projections/folds.ts`
- Modify: `src/orchestrator/projections/schema.ts`
- Modify: `src/orchestrator/projections/checksum.ts`
- Modify: `src/orchestrator/projections/manifest.ts`
- Modify: `src/orchestrator/projections/builder.ts`
- Modify: `src/orchestrator/projections/integrity.ts`
- Test: `tests/projection-source-event-codec.test.ts`
- Test: `tests/projection-folds.test.ts`
- Test: `tests/projection-schema.test.ts`
- Test: `tests/projection-builder.test.ts`
- Test: `tests/projection-integrity.test.ts`

**Interfaces:**

```ts
export const PROJECTION_SCHEMA_VERSION = 2 as const;
export type FollowUpStatus = "open" | "blocked" | "completed" | "carried-forward" | "abandoned";
export interface SessionTreeProjection {
  readonly rootSessionId: string;
  readonly parentSessionId: string | null;
  readonly lifecycleState: "open" | "closed";
  readonly ownerGeneration: number;
  readonly sourceEventId: string;
}
export interface ProvenancedArtifactProjection {
  readonly symbol: string | null;
  readonly commitHash: string | null;
  readonly heading: string | null;
  readonly sourceEventId: string;
  readonly anchor: string | null;
}
```

V2 governed-source payloads have exact bounded item/follow-up/artifact/entity/
alias/edge fields. V1 variants remain explicit; V2 data cannot be inferred from
summary text. V2 readers reject V1 manifests before opening bytes.

- [ ] **Step 1: Write red event-to-build tests**

```ts
it("builds an authenticated root/child tree and source citation", async () => {
  const generation = await buildFromEvents([rootOpened(), childOpened(), childCheckpoint()]);
  assert.deepEqual(readTree(generation), [{
    rootSessionId: ROOT_ID, parentSessionId: ROOT_ID, sourceEventId: CHILD_EVENT_ID,
  }]);
});
it("rejects a cycle rather than accepting a hand-seeded graph edge", () => {
  assert.throws(() => foldProjectionEvent(state, cyclicGovernedSource()), /INTEGRITY_FAILURE/);
});
```

Cover event → build → SQLite persistence for aliases/typed edges, structured
symbol/commit/heading, all five follow-up states, source IDs/anchors, and
nullable anchors. Add full-replay failures for missing, extra, and
provenance-tampered V2 rows.

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/projection-schema.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-integrity.test.js`

Expected: FAIL because schema V1 has no V2 union/tables/columns.

- [ ] **Step 3: Implement decoder, folds, schema, checksums, replay**

```ts
const next = Object.freeze({
  ...state,
  sessionTree: replaceBy(state.sessionTree, session, row => row.sessionId),
  entityNodes: upsertEntityNodes(state.entityNodes, event.entities, event.sourceEventId),
  entityAliases: upsertAliases(state.entityAliases, event.aliases, event.sourceEventId),
  entityEdges: upsertEdges(state.entityEdges, event.edges, event.sourceEventId),
});
```

Create ordered `session_tree` and `session_checkpoints`, `entity_nodes`,
`entity_aliases`, `entity_edges`, and V2 provenance fields on artifacts,
follow-ups, canonical items, and chunks. Validate parent/root membership and
cycles before state replacement. Update projection names, row order, builder
inserts, manifest checks, references, and full integrity replay together.

- [ ] **Step 4: Verify**

Run: `npm run test:subproject-3 && npm run typecheck`

Expected: PASS; no V1 manifest enters a V2 read path.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/projections/contracts.ts src/orchestrator/projections/source-event-codec.ts src/orchestrator/projections/folds.ts src/orchestrator/projections/schema.ts src/orchestrator/projections/checksum.ts src/orchestrator/projections/manifest.ts src/orchestrator/projections/builder.ts src/orchestrator/projections/integrity.ts tests/projection-source-event-codec.test.ts tests/projection-folds.test.ts tests/projection-schema.test.ts tests/projection-builder.test.ts tests/projection-integrity.test.ts
git commit -m "feat: materialize provenance-complete projection schema v2"
```

### Task 4: Stage generation adoption and reconcile orphans

**Files:**
- Modify: `src/orchestrator/projections/builder.ts`
- Modify: `src/orchestrator/projections/coordinator.ts`
- Modify: `src/orchestrator/projections/stable-directory.ts`
- Modify: `src/orchestrator/projections/manifest.ts`
- Test: `tests/projection-builder.test.ts`
- Test: `tests/projection-coordinator.test.ts`
- Test: `tests/projection-manifest.test.ts`

**Interfaces:**

```ts
export interface StagedProjectionGeneration {
  readonly manifest: ProjectionManifestV2;
  readonly temporaryDatabasePath: string;
  readonly directoryIdentity: ProjectionDirectoryIdentity;
}
installStagedGeneration(directory, staged, finalFilename, lockToken): StableProjectionGenerationIdentity;
reconcileUnpublishedGenerations(directory, activeManifest, leasedFilenames, lockToken): readonly string[];
```

The builder does not rename temporary data to a final name. The coordinator
alone installs it while holding the cooperative manifest lock. Reconciliation
removes only an identity-verified schema-V2 final file absent from active
manifest and the lease registry.

- [ ] **Step 1: Write fault-window red tests**

```ts
for (const boundary of ["before-install", "after-install-before-manifest", "manifest-publish-failed", "deadline-after-install"] as const) {
  it(`reconciles ${boundary} without removing active generation`, async () => {
    await assert.rejects(() => runFaultedBuild(boundary));
    await coordinator.ensurePublished(BINDING, 9n, 1_000);
    assert.equal(unreferencedFinalGenerationFiles(directory).length, 0);
    assert.equal(activeGenerationStillReadable(), true);
  });
}
```

Add restart, stale-temp, leased-old-generation, unreadable candidate, and
Windows deletion-retry tests. An uncertain observation must poison/retain
evidence rather than delete or unlock.

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-manifest.test.js`

Expected: FAIL because the builder currently exposes a final name before manifest
commit and no reconciliation removes it.

- [ ] **Step 3: Implement staged adoption**

```ts
const staged = await builder.build(snapshot, nextGeneration);
const lock = stable.acquireManifestPublicationLock(directory, identity);
try {
  stable.reconcileUnpublishedGenerations(directory, current?.manifest ?? null, leases.filenames(), lock.token);
  stable.installStagedGeneration(directory, staged, staged.manifest.databaseFile, lock.token);
  publishProjectionManifest({ projectionDirectory: directory, manifest: staged.manifest, expectedBinding: binding });
} finally {
  lock.releaseOnlyAfterVerifiedOutcome();
}
```

Maintain the existing fail-closed rule: uncertain post-transaction state poisons
the lock and preserves recovery evidence. Validate V2 filenames and never sweep
arbitrary files.

- [ ] **Step 4: Verify**

Run: `npm run test:subproject-3`

Expected: PASS for staging, restart, sidecar, retention, and orphan paths.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/projections/builder.ts src/orchestrator/projections/coordinator.ts src/orchestrator/projections/stable-directory.ts src/orchestrator/projections/manifest.ts tests/projection-builder.test.ts tests/projection-coordinator.test.ts tests/projection-manifest.test.ts
git commit -m "fix: reconcile unpublished projection generations"
```

### Task 5: Pin verified bytes inside reader leases

**Files:**
- Create: `src/orchestrator/projections/generation-image.ts`
- Modify: `src/orchestrator/projections/reader-lease.ts`
- Modify: `src/orchestrator/projections/coordinator.ts`
- Modify: `src/orchestrator/projections/integrity.ts`
- Modify: `src/orchestrator/retrieval/candidates.ts`
- Test: `tests/projection-coordinator.test.ts`
- Test: `tests/projection-integrity.test.ts`
- Test: `tests/retrieval-candidates.test.ts`
- Test: `tests/projection-runtime.test.ts`

**Interfaces:**

```ts
export interface VerifiedProjectionImage {
  readonly database: DatabaseSync;
  readonly sha256: string;
  close(): void;
}
export interface ProjectionReaderLease {
  readonly manifest: ProjectionManifestV2;
  readonly database: DatabaseSync;
  close(): void;
}
```

`openVerifiedProjectionImage` reuses descriptor-pinned capture from integrity,
checks manifest SHA-256, deserializes a private image, enables defensive and
query-only mode, and closes idempotently. Retrieval gets no pathname.

- [ ] **Step 1: Write red replace-between-lease-and-query tests**

```ts
it("queries verified bytes after published pathname replacement", async () => {
  const lease = await coordinator.leasePublished(BINDING);
  replaceFile(leaseManifestPath(lease), forgedProjectionBytes());
  assert.deepEqual(repository.collectEligible(lease, request), expectedFromVerifiedImage);
  lease.close();
});
```

Add truncate/rename/mutate variants, bad checksum at acquisition, double close,
and a `DatabaseSync` constructor spy proving candidates never reopen a path.

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/retrieval-candidates.test.js dist-test/tests/projection-runtime.test.js`

Expected: FAIL because candidates call `openProjection(lease.databasePath, ...)`.

- [ ] **Step 3: Implement shared byte-image lifecycle**

```ts
const image = openVerifiedProjectionImage(generation, manifest, directoryIdentity);
return Object.freeze({
  manifest,
  database: image.database,
  close: once(() => { image.close(); releaseLogicalLease(); }),
});
```

Move integrity inspection onto the same primitive. Release the logical lease if
image creation fails. Delete `openProjection`; every candidate statement uses
`lease.database` and never closes it.

- [ ] **Step 4: Verify**

Run: `npm run test:subproject-3 && npm run typecheck`

Expected: PASS with no retrieval-facing `databasePath` use.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/projections/generation-image.ts src/orchestrator/projections/reader-lease.ts src/orchestrator/projections/coordinator.ts src/orchestrator/projections/integrity.ts src/orchestrator/retrieval/candidates.ts tests/projection-coordinator.test.ts tests/projection-integrity.test.ts tests/retrieval-candidates.test.ts tests/projection-runtime.test.ts
git commit -m "fix: pin verified projection bytes in reader leases"
```

### Task 6: Enforce bounds after custom ranking

**Approved amendment:**
[Task 6 Custom-Ranker Bounds Amendment](../specs/2026-08-27-task-6-custom-ranker-bounds-amendment.md)

**Goal:** Make custom ranking an internal ordering hook that cannot evade the
same selection limits, conflicts, accounting, or explanation bounds as default
ranking.

**Architecture:** Filtered candidates are fused once. Default ranking returns
that fused set in deterministic rerank order; custom ranking returns the exact
same fused objects in a validated custom order. One order-preserving selector
then produces every result-derived field. No route, tool, configuration, V1
path, or V2 routing surface changes.

**Tech Stack:** Node.js 24, TypeScript, Node test runner, SQLite-backed
retrieval fixtures.

#### Execution-order correction: migrate every contract consumer atomically

The original task split incorrectly treated the `RetrievalRanker` relocation
as independently compilable. The type is imported by `service.ts` and
`projection-runtime.ts`; `service.ts` also invokes the old
`select(collection, request, manifest)` signature. Removing the old contract
therefore breaks the complete TypeScript build until all five source modules
are migrated together. This is a task-order correction only: it changes no
approved behavior, boundary, or file scope.

The following order is normative and supersedes the standalone GREEN and
commit steps in Tasks 6.1 through 6.3 below:

1. Write the ranking, service, and runtime tests described in Tasks 6.1–6.3
   before adding or changing production code for their respective behavior.
   Run `npm run test:build` and the three focused compiled tests; record the
   expected RED failure from the absent custom-order contract and current
   custom-result bypass.
2. Apply the source changes described in Tasks 6.1 Step 3, 6.2 Step 3, and
   6.3 Step 3 as one atomic migration: update the error union and remove the
   old contract; add the ranking contract, identity validator, and
   order-preserving selector; converge the service to one selector; then move
   both consumer type imports to `ranking.ts`.
3. Run one complete GREEN verification:

   ```bash
   npm run test:build
   node --test --test-concurrency=1 dist-test/tests/retrieval-ranking.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/projection-runtime.test.js
   npm run typecheck
   ```

   The build must pass before any implementation commit. It is not acceptable
   to commit a partial type migration that leaves `service.ts` or
   `projection-runtime.ts` importing the removed contract.
4. Commit the seven implementation/test files together:

   ```bash
   git add src/orchestrator/retrieval/contracts.ts src/orchestrator/retrieval/ranking.ts src/orchestrator/retrieval/service.ts src/orchestrator/runtime/projection-runtime.ts tests/retrieval-ranking.test.ts tests/retrieval-service.test.ts tests/projection-runtime.test.ts
   git commit -m "fix: enforce retrieval bounds after custom ranking"
   ```

Tasks 6.1–6.3 still define the exact test cases and source-level acceptance
criteria. They are no longer separately compiling commits.

**Files:**
- Modify: `src/orchestrator/retrieval/contracts.ts`
- Modify: `src/orchestrator/retrieval/ranking.ts`
- Modify: `src/orchestrator/retrieval/service.ts`
- Modify: `src/orchestrator/runtime/projection-runtime.ts`
- Test: `tests/retrieval-ranking.test.ts`
- Test: `tests/retrieval-service.test.ts`
- Test: `tests/projection-runtime.test.ts`

### Task 6.1: Define the closed custom-order contract

**Files:**
- Modify: `src/orchestrator/retrieval/contracts.ts`
- Modify: `src/orchestrator/retrieval/ranking.ts`
- Test: `tests/retrieval-ranking.test.ts`

- [ ] **Step 1: Write failing identity and order-preservation tests**

Import `InternalRetrievalError` and `validateCustomRanking`. Build a two-item
fused set with `fuseCandidates`, reverse the original object references, and
assert the validator returns that reversed array. Create
`foreignFusedCandidate` with a separate one-item `fuseCandidates` call. Then
assert that a cloned candidate, that foreign candidate, a duplicate, and a
missing candidate each fail with the closed error code:

```ts
const first = { id: "canonical:first", rank: 1, channel: "exact" as const, item: item("first") };
const second = { id: "canonical:second", rank: 2, channel: "exact" as const, item: item("second") };
const fused = fuseCandidates([[first, second]], DEFAULT_RANKING_POLICY);
const foreignFusedCandidate = fuseCandidates([[
  { id: "canonical:foreign", rank: 1, channel: "exact" as const, item: item("foreign") },
]], DEFAULT_RANKING_POLICY)[0]!;
const reversed = Object.freeze([fused[1]!, fused[0]!]);
assert.deepEqual(validateCustomRanking(reversed, fused), reversed);

for (const invalid of [
  Object.freeze([{ ...fused[0]! }, fused[1]!]),
  Object.freeze([foreignFusedCandidate, fused[1]!]),
  Object.freeze([fused[0]!, fused[0]!]),
  Object.freeze([fused[0]!]),
]) {
  assert.throws(
    () => validateCustomRanking(invalid, fused),
    (error: unknown) => error instanceof InternalRetrievalError
      && error.code === "RETRIEVAL_RANKER_INVALID",
  );
}
```

Add a selector assertion whose input is an intentionally reversed fused array
and whose `limit` is one. It must return the first supplied item, proving the
selector does not re-sort custom order.

- [ ] **Step 2: Run the focused ranking test and confirm it is red**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 dist-test/tests/retrieval-ranking.test.js
```

Expected: TypeScript fails because `validateCustomRanking` and the new error
code are not exported, and the current selector requires a
`RerankedCandidate` then sorts by score.

- [ ] **Step 3: Move the ranker contract to the ranking boundary**

In `contracts.ts`, add `"RETRIEVAL_RANKER_INVALID"` to
`InternalRetrievalErrorCode`, remove `RetrievalRanker`, and remove the
ranker-only `ProjectionManifestV1` import. In `ranking.ts`, import
`InternalRetrievalError` and `ValidatedInternalRetrievalRequest`, then add the
internal contract and validator:

```ts
export interface RetrievalRanker {
  select(
    eligible: readonly FusedCandidate[],
    request: ValidatedInternalRetrievalRequest,
  ): readonly FusedCandidate[];
}

export function validateCustomRanking(
  ranked: readonly FusedCandidate[],
  eligible: readonly FusedCandidate[],
): readonly FusedCandidate[] {
  if (ranked.length !== eligible.length) {
    throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
  }
  const expected = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  for (const candidate of ranked) {
    if (expected.get(candidate.id) !== candidate || seen.has(candidate.id)) {
      throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
    }
    seen.add(candidate.id);
  }
  return Object.freeze([...ranked]);
}
```

Change `RankedSelection.candidates`, selector input, its conflict-group map,
and its selected array from `RerankedCandidate` to `FusedCandidate`. Replace
the selector sort with `const ordered = [...candidates];`; retain its duplicate
ID guard, diversity, token, result-limit, conflict, and drop logic unchanged.

- [ ] **Step 4: Re-run the focused ranking test and confirm it is green**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 dist-test/tests/retrieval-ranking.test.js
```

Expected: PASS. The default reranker continues to provide score order before
selection, while valid custom order remains intact.

- [ ] **Step 5: Commit the contract and selector boundary**

```bash
git add src/orchestrator/retrieval/contracts.ts src/orchestrator/retrieval/ranking.ts tests/retrieval-ranking.test.ts
git commit -m "fix: validate custom retrieval ordering"
```

### Task 6.2: Converge service result construction through one selector

**Files:**
- Modify: `src/orchestrator/retrieval/service.ts`
- Test: `tests/retrieval-service.test.ts`

- [ ] **Step 1: Add failing service tests for valid and hostile rankers**

Add a static `RetrievalCandidateRepository` fixture with two valid bound items
and two exact-channel candidates. Use the existing valid lease fixture. Define
a `RetrievalRanker` that returns `Object.freeze([...eligible].reverse())` and
retrieve with `limit: 1`. Assert that the returned item is the first custom
candidate, `candidateCount` is the fused-set size, result-limit accounting is
nonzero, and the lease closes. Capture the `eligible` parameter and assert
each returned custom candidate is one of those exact object references.

Create a `serviceWith(ranker)` helper that returns `InternalRetrievalService`
with `projections.pin()` returning `createLease(onClose)`, the static candidate
repository, and the supplied ranker. Each test gives that helper its own
`onClose` counter so it can assert closure after a valid or rejected request.

Add a second ranker that returns a cloned candidate:

```ts
const invalidRanker: RetrievalRanker = {
  select(eligible) {
    return Object.freeze([{ ...eligible[0]! }, ...eligible.slice(1)]);
  },
};

await assert.rejects(
  () => serviceWith(invalidRanker).retrieve(request()),
  (error: unknown) => error instanceof InternalRetrievalError
    && error.code === "RETRIEVAL_RANKER_INVALID",
);
```

Use one high-impact conflict fixture with a deliberately insufficient token
budget and `explain: true`: two items share a `conflictGroupId`, use
`status: "conflicted"`, and declare their group in `conflictGroups`; a third,
lower-priority non-conflict item follows them. Set the token budget to admit
only one conflict member. Assert custom ranking returns the selector's conflict
cursor/truncation, redacted `tokenBudget` and `conflictSuppressed` counts, and
an explanation derived from the selected set rather than ranker-supplied
metadata.

- [ ] **Step 2: Run the focused service test and confirm it is red**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 dist-test/tests/retrieval-service.test.js
```

Expected: FAIL because the old ranker receives a collection and returns a
completed result, while the service leaves `selection` null and conflicts
empty for custom ranking.

- [ ] **Step 3: Replace parallel custom result handling with a common path**

Import `RetrievalRanker` and `validateCustomRanking` from `ranking.ts`. Delete
`DefaultRankingOutcome`, `defaultRank`, and `customRank`. After fusion, select
the ordered fused candidates and build one shared selection:

```ts
const ranked = this.#customRanker === undefined
  ? rerankCandidates(fused, request, DEFAULT_RANKING_POLICY)
  : validateCustomRanking(this.#customRanker.select(fused, request), fused);
const selection = selectRankedCandidates(ranked, {
  limit: request.limit,
  tokenBudget: request.tokenBudget,
}, DEFAULT_RANKING_POLICY);
const items = resultItems(selection);
const candidateCount = fused.length;
const rankedTruncated = selection.truncated;
```

Use that same `selection` for `conflicts`, selected IDs, redacted drop counts,
conflict truncation/cursor, and explanation. Keep the pre-fusion defensive
filtering, vector diagnostic, manifest parsing, lease closure, and default
reranker unchanged.

- [ ] **Step 4: Re-run the focused service test and confirm it is green**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 dist-test/tests/retrieval-service.test.js
```

Expected: PASS. Both default and custom paths materialize only from the shared
selector and a hostile custom ranker fails closed.

- [ ] **Step 5: Commit the service convergence**

```bash
git add src/orchestrator/retrieval/service.ts tests/retrieval-service.test.ts
git commit -m "fix: enforce custom retrieval selection bounds"
```

### Task 6.3: Migrate the runtime dependency seam without widening it

**Files:**
- Modify: `src/orchestrator/runtime/projection-runtime.ts`
- Test: `tests/projection-runtime.test.ts`

- [ ] **Step 1: Write a failing runtime ranker-wiring test**

Import `RetrievalRanker` from `ranking.ts`. Create a ranker that returns its
single eligible fused candidate and pass it to `createInternalProjectionRuntime`:

```ts
const ranker: RetrievalRanker = {
  select(eligible) {
    return eligible;
  },
};
const runtime = createInternalProjectionRuntime({ coordinator, candidates: CANDIDATES, ranker });
const result = await runtime.retrieval.retrieve(Object.freeze({
  binding: BINDING,
  query: "runtime:projection",
  limit: 10,
  tokenBudget: 1_000,
  consistency: Object.freeze({ requiredEventPosition: 42n, deadlineMs: 250 }),
}));
assert.deepEqual(result.items.map((candidate) => candidate.id), [ITEM.id]);
```

The test proves the runtime carries only the internal ordering contract; it
does not assert, register, or expose any route or tool.

- [ ] **Step 2: Run the focused runtime test and confirm it is red**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 dist-test/tests/projection-runtime.test.js
```

Expected: TypeScript fails until the runtime imports `RetrievalRanker` from
`ranking.ts` rather than `contracts.ts`.

- [ ] **Step 3: Migrate the type-only runtime import**

Keep `ProjectionLeaseProvider`, `RetrievalCandidateRepository`, and
`VectorCandidateChannel` imported from `contracts.ts`. Add the type-only
`RetrievalRanker` import from `../retrieval/ranking.js`; no runtime construction
or public dependency property changes are allowed.

- [ ] **Step 4: Re-run all focused Task 6 tests and confirm they are green**

Run:

```bash
npm run test:build
node --test --test-concurrency=1 dist-test/tests/retrieval-ranking.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/projection-runtime.test.js
npm run typecheck
```

Expected: PASS. The revised type seam compiles, custom ordering remains bounded,
and all existing ranking/runtime behavior remains intact.

- [ ] **Step 5: Commit the runtime type migration**

```bash
git add src/orchestrator/runtime/projection-runtime.ts tests/projection-runtime.test.ts
git commit -m "refactor: relocate retrieval ranker contract"
```

### Task 6.4: Audit the complete Task 6 scope and release evidence

**Files:**
- Verify: `src/orchestrator/retrieval/contracts.ts`
- Verify: `src/orchestrator/retrieval/ranking.ts`
- Verify: `src/orchestrator/retrieval/service.ts`
- Verify: `src/orchestrator/runtime/projection-runtime.ts`
- Verify: `tests/retrieval-ranking.test.ts`
- Verify: `tests/retrieval-service.test.ts`
- Verify: `tests/projection-runtime.test.ts`

- [ ] **Step 1: Run the full Subproject 3 release gate**

Run:

```bash
git diff --check
npm run test:subproject-3
```

Expected: PASS. The only permitted skip is the established Windows `EPERM`
symlink capability skip; any failed executable test blocks Task 6.

- [ ] **Step 2: Obtain independent specification and code-quality reviews**

Dispatch fresh read-only reviewers after the implementation commits. The
specification reviewer verifies exact-object identity validation, one shared
selector, fail-closed error behavior, and scope boundaries. The code-quality
reviewer verifies default ordering, custom-order preservation, conflict/drop/
explanation accounting, test coverage, type-only imports, and the complete
release evidence.

- [ ] **Step 3: Commit only Task 6 documentation corrections, if reviewers require them**

```bash
git add docs/superpowers/plans/2026-08-24-subproject-3-final-review-remediation.md
git commit -m "docs: correct Task 6 release evidence"
```

Do not commit code outside the three Task 6 implementation commits without a
new scoped plan step and review.

### Task 7: Replace answer-driven evaluation with a sealed real harness

**Files:**
- Modify: `src/orchestrator/retrieval/evaluation.ts`
- Modify: `tests/retrieval-evaluation.test.ts`
- Create: `tests/fixtures/retrieval-evaluation/v2/source-events.json`
- Create: `tests/fixtures/retrieval-evaluation/v2/judgments.json`
- Create: `tests/fixtures/retrieval-evaluation/v2/v1-shadow-baseline.json`
- Create: `tests/fixtures/retrieval-evaluation/v2/manifest.json`
- Modify: `scripts/run-retrieval-evaluation.js`
- Test: `tests/ci-lifecycle-gates.test.ts`

**Interfaces:**

```ts
export interface RetrievalEvaluationBundleV2 {
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly files: Readonly<Record<"source-events.json" | "judgments.json" | "v1-shadow-baseline.json", string>>;
}
export interface FrozenV1ShadowBaseline {
  readonly v1Version: string;
  readonly corpusSha256: string;
  readonly metrics: RetrievalEvaluationMetrics;
  readonly provenanceCommand: string;
}
```

The harness seeds authoritative synthetic events, uses the actual projection
reader/builder/coordinator/verified lease/candidate repository/service, and
never maps a query ID or text to an answer. Vectors are disabled for all 500+
requests.

- [ ] **Step 1: Write bundle and black-box red tests**

```ts
it("builds sealed source events then measures real retrieval", async () => {
  const harness = await createSealedEvaluationHarness(bundle);
  const report = await runEvaluation(harness.service, bundle.judgments);
  assert.equal(report.crossProjectContamination, 0);
  assert.ok(report.recallAt10 >= bundle.baseline.metrics.recallAt10);
});
it("rejects a changed corpus, baseline, or enabled vector channel", () => {
  assert.throws(() => loadBundle(tamperedManifest), /RETRIEVAL_EVALUATION_CORPUS_INVALID/);
});
```

Require 500+ judged queries and 50+ in every critical class. Source events must
actually produce the tested relations and a cross-project near duplicate.

- [ ] **Step 2: Run red**

Run: `npm run test:retrieval-evaluation`

Expected: FAIL because the current test creates a candidate from the answer key.

- [ ] **Step 3: Implement sealed build-to-query evaluation**

```ts
const bundle = parseSealedBundle(readJson(manifestPath));
verifyBundleHashes(bundle, fixtureDirectory);
const coordinator = await buildRealProjectionFromAuthoritativeEvents(bundle.sourceEvents);
const service = new InternalRetrievalService({
  projections: realProjectionProvider(coordinator),
  candidates: new SqliteRetrievalCandidateRepository(),
});
```

Fixture data contains synthetic identifiers only and exact SHA-256 hashes. Count
contamination over every returned item before metric deduplication. Compare every
V2 metric with absolute thresholds and the frozen V1 baseline. Unit fake
services remain only for parser/metric arithmetic tests.

- [ ] **Step 4: Verify**

Run: `npm run test:retrieval-evaluation && node --test --test-concurrency=1 dist-test/tests/ci-lifecycle-gates.test.js`

Expected: PASS with sealed report, 500+ queries, zero contamination, vectors
disabled, and no baseline regression.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/retrieval/evaluation.ts tests/retrieval-evaluation.test.ts tests/fixtures/retrieval-evaluation/v2 scripts/run-retrieval-evaluation.js tests/ci-lifecycle-gates.test.ts
git commit -m "test: measure retrieval using sealed real projections"
```

### Task 8: Complete release gates and request final review

**Files:**
- Modify: `package.json`
- Modify: `tests/ci-lifecycle-gates.test.ts`
- Modify: `.superpowers/sdd/2026-08-23-subproject-3-projections-and-explainable-retrieval/progress.md`
- Create: `.superpowers/sdd/2026-08-23-subproject-3-projections-and-explainable-retrieval/remediation-task-8-report.md`

**Interfaces:**

```json
{
  "scripts": {
    "test:subproject-3": "... lifecycle-command-store.test.js lifecycle-contracts.test.js ... retrieval-evaluation ... ci-lifecycle-gates.test.js"
  }
}
```

The focused gate includes every test changed by Tasks 1–7, especially lifecycle
isolation. CI rejects protected V1 diffs, V2 production imports/tool
registration, answer-derived evaluation behavior, enabled evaluation vectors,
and unsupported V1 manifests.

- [ ] **Step 1: Write gate-completeness red tests**

```ts
it("requires changed lifecycle isolation tests in the focused command", () => {
  assert.match(readPackageScript("test:subproject-3"), /lifecycle-command-store\.test\.js/);
  assert.match(readPackageScript("test:subproject-3"), /lifecycle-contracts\.test\.js/);
});
it("rejects production registration and answer-derived evaluator fixtures", () => {
  assert.throws(() => assertProductionIsolation(forbiddenDiff), /V2_PRODUCTION_ISOLATION/);
});
```

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/ci-lifecycle-gates.test.js`

Expected: FAIL because the focused script omits lifecycle tests and lacks the
new evaluator structural guard.

- [ ] **Step 3: Complete scripts, guards, and evidence record**

```json
"test:subproject-3": "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec ... lifecycle-command-store.test.js lifecycle-contracts.test.js ... && node scripts/run-retrieval-evaluation.js ... && node --test ... ci-lifecycle-gates.test.js"
```

Record Node version, OS, commands, passed/skipped/failed counts, protected-path
diff result, and only evidence-backed baseline failures.

- [ ] **Step 4: Run final verification before review**

Run: `npm run check:runtime && npm run typecheck && npm run test:build && npm run test:build-artifacts && npm run test:subproject-3 && npm test`

Expected: every release gate passes. If any full-suite test fails, stop and
diagnose the exact failing test; do not claim merge or PROD readiness.

- [ ] **Step 5: Commit and dispatch independent review**

```bash
git add package.json tests/ci-lifecycle-gates.test.ts .superpowers/sdd/2026-08-23-subproject-3-projections-and-explainable-retrieval/progress.md .superpowers/sdd/2026-08-23-subproject-3-projections-and-explainable-retrieval/remediation-task-8-report.md
git commit -m "test: complete Subproject 3 remediation release gates"
```

Generate a review package from `30b0393` to `HEAD`, dispatch a read-only
reviewer against this plan/spec, and fix every Critical or Important finding
before a merge decision.

## Plan self-review

**Spec coverage:** Tasks 1–8 map one-for-one to source authentication, bounded
snapshots, full V2 contracts, orphan safety, pinned leases, custom-ranker limits,
real evaluation, and complete release evidence. V1 isolation is global.

**Placeholder scan:** No deferred-work markers or unspecified error-handling
steps appear. Each task lists files, interfaces, red tests, commands, and a
commit.

**Type consistency:** Task 1 supplies authenticated events to Task 2. Task 2
feeds bounded streams into Task 3 schema V2. Tasks 4 and 5 consume V2 manifests
and images. Tasks 6–7 consume the V2 retrieval path. Task 8 verifies all of it.
