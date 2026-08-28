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

Also add a stateful Proxy/iterable regression. Its first iteration must yield
the exact reversed fused references; a second iteration must yield
`foreignFusedCandidate` followed by an eligible reference. Assert the
validator returns only the reversed eligible references, excludes the foreign
candidate, and iterates the ranker result exactly once:

```ts
let iterations = 0;
const statefulRanking = new Proxy([...fused], {
  get(target, property, receiver) {
    if (property === Symbol.iterator) {
      return function* (): IterableIterator<typeof fused[number]> {
        iterations += 1;
        yield* iterations === 1
          ? [fused[1]!, fused[0]!]
          : [foreignFusedCandidate, fused[1]!];
      };
    }
    return Reflect.get(target, property, receiver);
  },
});

const statefulResult = validateCustomRanking(statefulRanking, fused);
assert.equal(statefulResult[0], fused[1]!);
assert.equal(statefulResult[1], fused[0]!);
assert.equal(statefulResult.includes(foreignFusedCandidate), false);
assert.equal(iterations, 1);
```

This regression must fail against a validator that validates one traversal and
returns a second traversal, because that old two-pass behavior accepts the
foreign candidate from the second iteration.

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
  const snapshot = [...ranked];
  if (snapshot.length !== eligible.length) {
    throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
  }
  const expected = new Set(eligible);
  for (const candidate of snapshot) {
    if (!expected.delete(candidate)) {
      throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
    }
  }
  if (expected.size !== 0) {
    throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
  }
  return Object.freeze(snapshot);
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

### Task 7: Implement the sealed real Version 2 retrieval evaluator

**Approved design:** `docs/superpowers/specs/2026-08-28-task-7-sealed-real-evaluation-design.md`

**Goal:** Replace the answer-driven integration evaluation with a sealed,
reproducible black-box measurement of authenticated synthetic events through a
real Version 2 projection, evaluator lease, Version 2 candidate adapter, and
`InternalRetrievalService`.

**Architecture:** `evaluation.ts` owns strict, cross-platform canonical parsing
of the four-artifact bundle and its aggregate metric contract. The test owns a
test-only bridge from `InternalRetrievalService`'s current Version 1-shaped
`ProjectionLeaseProvider` seam to the real V2 evaluator lease: its manifest
view exists only so the service can perform its existing scope/position check;
the candidate repository receives the original `V2ProjectionReaderLease` and
never opens a Version 1 database, uses a pathname, or participates in runtime
routing. This avoids changing the public Version 1 contract while testing the
actual V2 builder, verified detached image, and V2 adapter.

**Files and responsibilities:**

- Modify: `src/orchestrator/retrieval/evaluation.ts` — parse the sealed V2
  bundle, validate canonical hashes and the frozen baseline, issue only
  vector-disabled requests, score V2 reports, and enforce thresholds/baseline.
- Modify: `tests/retrieval-evaluation.test.ts` — replace answer-derived
  integration fixtures with an authenticated SQLite source, real V2
  coordinator/lease/adapter harness, parser tests, and metric arithmetic tests.
- Create: `tests/fixtures/retrieval-evaluation/v2/source-events.json` — the
  deterministic, authenticated synthetic input events including one excluded
  cross-project near duplicate.
- Create: `tests/fixtures/retrieval-evaluation/v2/judgments.json` — 500 or
  more independently judged queries and their scope, citations, relevance, and
  expected relations; it contains no candidate-answer mapping.
- Create: `tests/fixtures/retrieval-evaluation/v2/v1-shadow-baseline.json` —
  reviewed immutable aggregate metrics for this judgments hash.
- Create: `tests/fixtures/retrieval-evaluation/v2/manifest.json` — the exact
  V2 bundle version and SHA-256 values of the parsed canonical JSON artifacts.
- Modify: `scripts/run-retrieval-evaluation.js` — admit only the compiled
  sealed-evaluation target and emit aggregate report output.
- Modify: `tests/ci-lifecycle-gates.test.ts` — reject restored answer maps,
  evaluation vector opt-in, and any V2 production registration/import.
- Modify: `docs/superpowers/plans/2026-08-24-subproject-3-final-review-remediation.md`
  — check off Task 7 only after every command and review below has evidence.

**Shared contracts to add before using them in later steps:**

```ts
export type RetrievalEvaluationCorpusVersion =
  | "retrieval-evaluation-v1"
  | "retrieval-evaluation-v2";

export interface RetrievalEvaluationBundleV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly files: Readonly<Record<
    "source-events.json" | "judgments.json" | "v1-shadow-baseline.json",
    string
  >>;
}

export interface FrozenV1ShadowBaseline {
  readonly schemaVersion: 1;
  readonly v1Version: string;
  readonly judgmentsSha256: string;
  readonly metrics: RetrievalEvaluationReport;
  readonly provenanceCommand: string;
}

export interface SealedRetrievalEvaluationSourceV2 {
  readonly binding: ProjectBinding;
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

export interface RetrievalEvaluationSourceEventsV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly sources: readonly SealedRetrievalEvaluationSourceV2[];
}

export interface RetrievalEvaluationJudgmentsV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly queries: readonly RetrievalEvaluationQueryV1[];
}

export interface SealedRetrievalEvaluationCorpusV2 {
  readonly bundle: RetrievalEvaluationBundleV2;
  readonly sources: readonly SealedRetrievalEvaluationSourceV2[];
  readonly queries: readonly RetrievalEvaluationQueryV1[];
  readonly baseline: FrozenV1ShadowBaseline;
}

export function parseSealedRetrievalEvaluationBundle(
  manifest: unknown,
  sourceEvents: unknown,
  judgments: unknown,
  baseline: unknown,
): SealedRetrievalEvaluationCorpusV2;

export function assertSealedEvaluationVectorDisabled(
  vector: Readonly<{ readonly enabled: boolean }>,
): asserts vector is Readonly<{ readonly enabled: false }>;

export async function evaluateSealedRetrieval(
  corpus: SealedRetrievalEvaluationCorpusV2,
  service: RetrievalEvaluationService,
): Promise<RetrievalEvaluationReport>;

export async function evaluateRetrievalQueries(
  queries: readonly RetrievalEvaluationQueryV1[],
  corpusVersion: RetrievalEvaluationCorpusVersion,
  service: RetrievalEvaluationService,
): Promise<RetrievalEvaluationReport>;
```

`RetrievalEvaluationReport.corpusVersion` becomes
`RetrievalEvaluationCorpusVersion`; it stays frozen and aggregate-only. Keep
`RetrievalEvaluationCorpusError` as the existing zero-argument class, so every
malformed, tampered, noncanonical, unsafe, or baseline-regressing bundle throws
exactly `RETRIEVAL_EVALUATION_CORPUS_INVALID` without changing its public
constructor.

#### Task 7.1: Define and seal the four-artifact V2 contract

**Files:**

- Modify: `src/orchestrator/retrieval/evaluation.ts:95-442`
- Modify: `tests/retrieval-evaluation.test.ts:1-295`
- Create: `tests/fixtures/retrieval-evaluation/v2/source-events.json`
- Create: `tests/fixtures/retrieval-evaluation/v2/judgments.json`
- Create: `tests/fixtures/retrieval-evaluation/v2/v1-shadow-baseline.json`
- Create: `tests/fixtures/retrieval-evaluation/v2/manifest.json`

- [ ] **Step 1: Replace the V1-only fixture read helper with a V2 bundle read helper and write its failing parser tests.**

  Import `parseSealedRetrievalEvaluationBundle` and define four `URL` values
  under `tests/fixtures/retrieval-evaluation/v2/`. Parse the JSON values
  separately; do not concatenate raw file bytes. Add this helper and the
  following red tests before writing the parser:

  ```ts
  function readSealedBundle(): SealedRetrievalEvaluationCorpusV2 {
    return parseSealedRetrievalEvaluationBundle(
      JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as unknown,
      JSON.parse(readFileSync(SOURCE_EVENTS_URL, "utf8")) as unknown,
      JSON.parse(readFileSync(JUDGMENTS_URL, "utf8")) as unknown,
      JSON.parse(readFileSync(BASELINE_URL, "utf8")) as unknown,
    );
  }

  it("accepts only a sealed canonical V2 bundle", () => {
    const corpus = readSealedBundle();
    assert.equal(corpus.bundle.schemaVersion, 2);
    assert.equal(corpus.bundle.corpusVersion, "retrieval-evaluation-v2");
    assert.equal(corpus.sources.length, 2);
    assert.equal(corpus.sources.flatMap((source) => source.events).length, 505);
    assert.equal(corpus.queries.length, 504);
    assert.equal(corpus.baseline.judgmentsSha256, canonicalSha256(corpus.queries));
    assert.equal(Object.isFrozen(corpus), true);
  });

  it("rejects each sealed artifact when its canonical JSON or declared hash changes", () => {
    const manifest = readJson(MANIFEST_URL);
    const events = readJson(SOURCE_EVENTS_URL) as {
      readonly sources: readonly { readonly binding: unknown; readonly events: readonly unknown[] }[];
    };
    const judgments = readJson(JUDGMENTS_URL);
    const baseline = readJson(BASELINE_URL);
    const [primary, competing] = events.sources;
    assert.ok(primary);
    assert.ok(competing);
    const mutations = [
      [manifest, {
        ...events,
        sources: [{ ...primary, events: [...primary.events, primary.events[0]] }, competing],
      }, judgments, baseline],
      [manifest, events, { ...judgments, queries: judgments.queries.slice(1) }, baseline],
      [manifest, events, judgments, { ...baseline, judgmentsSha256: "0".repeat(64) }],
      [{ ...manifest, files: { ...manifest.files, "judgments.json": "0".repeat(64) } }, events, judgments, baseline],
    ] as const;
    for (const [changedManifest, changedEvents, changedJudgments, changedBaseline] of mutations) {
      assert.throws(
        () => parseSealedRetrievalEvaluationBundle(
          changedManifest,
          changedEvents,
          changedJudgments,
          changedBaseline,
        ),
        /RETRIEVAL_EVALUATION_CORPUS_INVALID/,
      );
    }
  });
  ```

  Make each mutation actually selected inside the loop by passing its returned
  artifact in the relevant parser argument. Also cover: an extra own field,
  an accessor property, NFKC-unstable text, duplicate `eventId`, duplicate
  `queryId`, duplicate query text, a raw-evidence/credential-bearing string,
  a non-64-character hash, and a V1 baseline whose `metrics.corpusVersion` is
  not `"retrieval-evaluation-v1"`. Each must throw the existing corpus error
  without invoking an accessor.


- [ ] **Step 2: Add the four deterministic JSON artifacts in their final schema.**

  Commit a static `source-events.json` exact-key object with
  `schemaVersion: 2`, `corpusVersion: "retrieval-evaluation-v2"`, and two
  `sources` records. Each source record has exact keys `binding` and `events`;
  each event array has its own ascending contiguous event positions and
  authenticated hash chain. This separation is required because
  `SqliteProjectionEventReader` fails closed when a single project store
  contains another project's event. The primary source contains exactly 504
  events and the competing source contains exactly one event, for 505 static
  events in total.

  Every event has the exact stored-event field set used by
  `decodeProjectionEvent` — including `globalPosition` and `streamVersion` as
  decimal strings, canonical `payloadJson`, `payloadHash`,
  `previousGlobalHash`, and `eventHash` — and no empty text field. The test's
  `hydrateStoredEvent` recomputes payload and chain hashes from the static
  record and asserts equality before inserting each row in its source's
  authenticated SQLite event store. The primary source starts a session at
  position 1, records a valid `SessionCheckpointRecorded` at position 2, and
  contains `MemorySourceRecorded` schema-2 events for the remaining source
  facts. This is intentionally Version-1-decodable as well as Version-2
  decodable so the frozen V1 shadow can be reproduced from the same primary
  event stream without changing V1 code.

  Allocate 56 judged primary-project relations to each of the nine existing
  critical classes for 504 total queries: 18 English, 19 Thai, and 19 mixed per
  class. The checkpoint's task summary, `next-action` work items, open
  follow-ups, and file/artifact rows materialize the session-continuity,
  next-action, follow-up, and code-artifact relations. The schema-2 memory
  events materialize identifiers, semantic paraphrases, conflicts,
  stale/superseded transitions, and valid-time boundaries. The sole competing
  source event has a distinct project binding but the same normalized key and
  summary as one selected primary event. Build it in its own real V2
  coordinator, then prove the primary binding's real V2 retrieval result
  excludes it while the competing coordinator's own V2 query can retrieve it.
  Judgments identify expected visible relations; they never synthesize result
  objects.

  Commit `judgments.json` as the exact-key object
  `{ "schemaVersion": 2, "corpusVersion": "retrieval-evaluation-v2", "queries": [...] }`.
  Its static query IDs are `eval-v2-0001` through `eval-v2-0504`; every query
  has all existing `RetrievalEvaluationQueryV1` fields, two distinct judge IDs
  with matching reviewed relevance grades, positive cited items, and a source
  item ID in `source-events.json`. It contains no map, answer, candidate,
  expected-result, or query-text-to-item-id lookup field.

  Commit `v1-shadow-baseline.json` as the exact-key
  `FrozenV1ShadowBaseline` object whose `v1Version` is
  `"retrieval-evaluation-v1-shadow-2026-08-28"`, whose
  `provenanceCommand` is `"npm run test:retrieval-evaluation"`, and whose
  `metrics` is the full aggregate `RetrievalEvaluationReport` from the real
  Version 1 shadow build of the exact primary event source and 504 parsed
  judgments. Add the real-V1-shadow assertion in Task 7.2 before committing:
  it must `deepEqual` the generated V1 aggregate report and the static baseline
  metrics, and must confirm the static `judgmentsSha256` is
  `canonicalSha256(parsedJudgments.queries)`. This makes every numeric value in
  the committed baseline an independently reproducible V1 result, not a
  fabricated threshold or a V2-derived value.

  Commit `manifest.json` as the exact-key
  `RetrievalEvaluationBundleV2` object. Its three `files` values are the
  SHA-256 values of the three parsed, validated, compact-`JSON.stringify`
  artifact objects; the parser recomputes all three values before evaluation.
  The manifest does not contain hashes of raw checkout bytes. All four
  artifacts contain only synthetic identifiers, fixed timestamps, and the
  declared safe aggregate/provenance values.

- [ ] **Step 3: Run only the new parser test to prove the contract is absent.**

  Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/retrieval-evaluation.test.js`

  Expected: FAIL at TypeScript compilation because
  `parseSealedRetrievalEvaluationBundle`, its types, and the V2 fixture reader
  are absent. Do not continue if the test passes while the old
  `createEvaluationService` query-to-answer map still drives integration
  metrics.

- [ ] **Step 4: Implement strict V2 parsing and canonical hashing in `evaluation.ts`.**

  Keep the existing exact-own-property helpers and extend them with these
  concrete rules:

  ```ts
  function canonicalSha256(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  }

  export function parseSealedRetrievalEvaluationBundle(
    manifestValue: unknown,
    sourceValue: unknown,
    judgmentsValue: unknown,
    baselineValue: unknown,
  ): SealedRetrievalEvaluationCorpusV2 {
    const bundle = parseBundleManifest(manifestValue);
    const sourceArtifact = parseSourceEventsV2(sourceValue);
    const judgmentsArtifact = parseJudgmentsV2(judgmentsValue);
    const baseline = parseFrozenV1ShadowBaseline(baselineValue, judgmentsArtifact.queries);
    if (
      bundle.files["source-events.json"] !== canonicalSha256(sourceArtifact)
      || bundle.files["judgments.json"] !== canonicalSha256(judgmentsArtifact)
      || bundle.files["v1-shadow-baseline.json"] !== canonicalSha256(baseline)
    ) return invalid();
    return Object.freeze({
      bundle,
      sources: sourceArtifact.sources,
      queries: judgmentsArtifact.queries,
      baseline,
    });
  }
  ```

  `parseSourceEventsV2` returns a frozen
  `RetrievalEvaluationSourceEventsV2` object and validates the exact top-level
  `sources` wrapper, two distinct source bindings, and a separate ascending
  contiguous event chain in each source. It rejects duplicate event
  IDs/idempotency keys across the whole bundle, exact stored-event key
  violations, unsafe NFKC text, secret-bearing text, and payload/binding
  mismatch. `parseJudgmentsV2` returns a frozen
  `RetrievalEvaluationJudgmentsV2` object and reuses strict query parsing after
  changing its expected prefix to `eval-v2-`; it validates exact V2 wrapper
  keys and coverage. `parseFrozenV1ShadowBaseline` validates the complete
  aggregate report shape, requires a V1 `corpusVersion`, checks its counts
  against `queries`, and compares `judgmentsSha256` to the canonical hash of
  the parsed `queries` array. Return defensively frozen arrays, records, and
  nested values. Import `createHash` from `node:crypto`; do not calculate a
  hash from source bytes or mutate a fixture object.

- [ ] **Step 5: Re-run the parser tests and freeze the contract commit.**

  Run: `npm run test:build && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/retrieval-evaluation.test.js`

  Expected: the V2 parser/fixture tests pass; old V1 parser arithmetic tests
  may remain only if they are explicitly isolated from an answer-derived
  integration service.

  ```bash
  git add src/orchestrator/retrieval/evaluation.ts tests/retrieval-evaluation.test.ts tests/fixtures/retrieval-evaluation/v2
  git commit -m "test: seal the V2 retrieval evaluation corpus"
  ```

#### Task 7.2: Build the real V2 evaluator harness and remove answer-derived integration results

**Files:**

- Modify: `tests/retrieval-evaluation.test.ts:1-420`
- Modify: `src/orchestrator/retrieval/evaluation.ts:365-520`

- [ ] **Step 1: Write the failing real-harness test before deleting the answer map.**

  Add the test below. Define `createRealV2EvaluationHarness` in this test file,
  not production runtime code.

  ```ts
  it("builds authenticated source events into a real V2 evaluator lease and scores only real V2 results", async () => {
    const corpus = readSealedBundle();
    const harness = await createRealV2EvaluationHarness(corpus);
    const report = await evaluateSealedRetrieval(corpus, harness.service);

    assert.equal(harness.sourceEventCount, corpus.sources.flatMap((source) => source.events).length);
    assert.equal(harness.v2LeaseCount, corpus.queries.length);
    assert.equal(harness.v1RepositoryCalls, 0);
    assert.equal(report.corpusVersion, "retrieval-evaluation-v2");
    assert.equal(report.queryCount, corpus.queries.length);
    assert.equal(report.failedQueryCount, 0);
    assert.equal(report.crossProjectContamination, 0);
    assert.equal(Object.isFrozen(report), true);
    assert.doesNotMatch(JSON.stringify(report), /queryText|expectedCitations|relevanceGrades|projectId|databasePath/);
  });
  ```

  Add a test that opens the evaluator lease from the coordinator, swaps the
  published database pathname for another V2 image, and still gets the
  original result through `V2SqliteRetrievalCandidateRepository`. This is the
  evaluation-specific proof that retrieval reads the verified detached image,
  not the published path.

- [ ] **Step 2: Run the focused test and record the expected red failure.**

  Run: `npm run test:build && node --test --test-concurrency=1 --test-name-pattern="builds authenticated source events" dist-test/tests/retrieval-evaluation.test.js`

  Expected: FAIL because the current `createEvaluationService` builds results
  from `Map<queryText, query>` and no V2 source/lease/candidate harness exists.

- [ ] **Step 3: Build the harness with actual source authentication, V2 projection publication, and the V2 candidate adapter.**

  In `tests/retrieval-evaluation.test.ts`, use `DatabaseSync`,
  `NodeSqliteDriver`, `SqliteProjectionEventReader`,
  `ImmutableProjectionBuilder`, `DefaultProjectionBuildCoordinator`,
  `V2ProjectionBuildCoordinator`, `SqliteRetrievalCandidateRepository`,
  `V2SqliteRetrievalCandidateRepository`, `canonicalJson`, `payloadHash`, and
  `eventHash`. Hydrate each sealed source record, write it to one canonical
  event-store SQLite database per source binding, recompute/check its payload
  and chain hashes, and open it through `SqliteProjectionEventReader`. Never
  feed a hand-made `ProjectionEventSnapshot` directly to either evaluator.

  Use this test-only adapter shape, preserving the original V2 lease in a
  private test-only property:

  ```ts
  interface EvaluationLeaseView extends ProjectionReaderLease {
    readonly evaluatorLease: V2ProjectionReaderLease;
  }

  function serviceManifestView(manifest: ProjectionManifestV2): ProjectionManifestV1 {
    return Object.freeze({
      schemaVersion: 1,
      projectId: manifest.projectId,
      vaultId: manifest.vaultId,
      storeId: manifest.storeId,
      workspaceId: manifest.workspaceId,
      branchScopeId: manifest.branchScopeId,
      branchRef: manifest.branchRef,
      sessionId: null,
      generation: manifest.generation,
      terminalEventPosition: manifest.terminalEventPosition,
      terminalEventHash: manifest.terminalEventHash,
      databaseFile: "v2-evaluation-lease.sqlite",
      databaseSha256: manifest.databaseSha256,
      coreChecksums: Object.freeze({
        sessionTree: manifest.coreChecksums.sessionTree,
        canonicalItems: manifest.coreChecksums.canonicalItems,
        tasksFollowups: manifest.coreChecksums.tasksFollowups,
        artifactsFiles: manifest.coreChecksums.artifactsFiles,
        entityGraph: manifest.coreChecksums.entityGraph,
        lexicalChunks: manifest.coreChecksums.lexicalChunks,
        retrievalFeedback: manifest.coreChecksums.retrievalFeedback,
      }),
      createdAt: manifest.createdAt,
    });
  }

  const projections: ProjectionLeaseProvider = {
    async pin(binding, consistency): Promise<EvaluationLeaseView> {
      await coordinator.ensurePublished(binding, consistency.requiredEventPosition, consistency.deadlineMs);
      const evaluatorLease = await coordinator.leasePublishedForEvaluation(binding);
      return Object.freeze({
        manifest: serviceManifestView(evaluatorLease.manifest),
        databasePath: "v2-evaluation-lease.sqlite",
        evaluatorLease,
        close: () => evaluatorLease.close(),
      });
    },
  };

  const candidates: RetrievalCandidateRepository = {
    collectEligible(lease, request) {
      const view = lease as EvaluationLeaseView;
      return new V2SqliteRetrievalCandidateRepository().collectEligible(view.evaluatorLease, request);
    },
  };

  const service = new InternalRetrievalService({ projections, candidates });
  ```

  The manifest view is only metadata for the already-existing service scope and
  event-position verification. Assert in the test that no V1 candidate
  repository is instantiated, `databasePath` is never read by `candidates`,
  and the V2 adapter receives the `V2ProjectionReaderLease` returned by
  `leasePublishedForEvaluation`. Do not import this bridge outside this test
  file; do not modify `InternalProjectionRuntime`, `service.ts`, V1 lease
  interfaces, or V1 candidate code.

  Build the primary source a second time with the actual legacy coordinator and
  legacy candidate repository solely to reproduce the immutable baseline; it
  is not used by the V2 harness or V2 acceptance path:

  ```ts
  const v1Coordinator = new DefaultProjectionBuildCoordinator({
    projectionDirectory: join(root, "v1-projections"),
    eventReader: primaryEventReader,
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory: join(root, "v1-projections"), now: () => NOW }),
    now: () => 0,
  });
  await v1Coordinator.ensurePublished(PRIMARY_BINDING, 504n, 15_000);
  const v1Service = new InternalRetrievalService({
    projections: {
      async pin(binding, consistency) {
        await v1Coordinator.ensurePublished(binding, consistency.requiredEventPosition, consistency.deadlineMs);
        return v1Coordinator.leasePublished(binding);
      },
    },
    candidates: new SqliteRetrievalCandidateRepository(),
  });
  const v1Report = await evaluateRetrievalQueries(
    corpus.queries,
    "retrieval-evaluation-v1",
    v1Service,
  );
  assert.deepEqual(v1Report, corpus.baseline.metrics);
  ```

  The primary event stream remains V1-decodable: `SessionStarted` is ignored
  by the legacy decoder, the checkpoint populates legacy checkpoints,
  follow-ups, next actions, and artifacts, and schema-2 memory events populate
  canonical/temporal/conflict rows. Build the competing source only with its
  own V2 coordinator; no primary reader may open a store containing its event.

  Delete `createEvaluationService`, `channelFor`, `kindFor`, and `itemFor`
  from the integration path. A small synthetic retrieval service is permitted
  only in the two metric-arithmetic tests that prove macro averaging and
  duplicate-id behavior; its fixture must be declared adjacent to those tests
  and must not read the V2 bundle or emit the release report.

- [ ] **Step 4: Extend V2 scoring so requests are vector-disabled and reports compare to the frozen baseline.**

  In `evaluation.ts`, have `evaluateRetrievalQueries` perform the common metric
  accumulation for already parsed judgments and have `evaluateRetrieval` call
  it after V1 parsing. `evaluateSealedRetrieval` calls it with the V2 corpus
  version before running V2 acceptance. Change `requestFor` to build this exact
  option and reject
  any other option before `service.retrieve` is reached:

  ```ts
  const vector = Object.freeze({ enabled: false as const });
  assertSealedEvaluationVectorDisabled(vector);
  return Object.freeze({
    binding,
    query: query.queryText,
    limit: 10,
    tokenBudget: 32_768,
    candidateLimit: 512,
    explain: false,
    includeGlobal: false,
    visibility: scope.visibility,
    vector,
    consistency: Object.freeze({
      requiredEventPosition: BigInt(scope.requiredEventPosition),
      deadlineMs: scope.deadlineMs,
    }),
    ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
    ...(scope.validAt === null ? {} : { validAt: scope.validAt }),
    ...(scope.knownAt === null ? {} : { knownAt: BigInt(scope.knownAt) }),
  });
  ```

  `assertSealedEvaluationVectorDisabled` throws `RetrievalEvaluationCorpusError`
  when `enabled !== false`. `evaluateSealedRetrieval` parses the bundle again,
  invokes the existing outcome logic for its V2 queries, sets
  `corpusVersion: "retrieval-evaluation-v2"`, then calls
  `assertV2Acceptance(report, baseline)`. That helper must require exactly:

  ```ts
  report.failedQueryCount === 0
  report.crossProjectContamination === 0
  report.recallAt10 >= 0.95
  report.mrr >= 0.90
  report.ndcgAt10 >= 0.90
  report.citationPrecision >= 0.95
  report.citationRecall >= 0.95
  report.staleActiveMemoryRate <= 0.01
  report.exactIdentifierPathRecall === 1
  report.currentSessionCheckpointRecallAt10 === 1
  report.openFollowUpRecallAt10 === 1
  report.nextActionRecallAt10 === 1
  report.semanticParaphraseRecallAt10 >= 0.90
  report.bitemporalAccuracy >= 0.95
  report.conflictRecall === 1
  report.conflictPrecision === 1
  report.unsupportedHighImpactVerifiedClaims === 0
  ```

  Compare all higher-is-better numeric metrics with `>= baseline.metrics`; for
  `staleActiveMemoryRate` and `unsupportedHighImpactVerifiedClaims`, compare
  with `<= baseline.metrics`. Compare counts only for the specified zero
  acceptance rules and corpus coverage. A failed comparison throws
  `RETRIEVAL_EVALUATION_CORPUS_INVALID` and never updates the baseline.

- [ ] **Step 5: Add the adversarial real-path tests and run the harness to green.**

  Add these exact assertions:

  ```ts
  it("rejects an enabled vector before the V2 lease provider is called", () => {
    let pins = 0;
    const service = new InternalRetrievalService({
      projections: { async pin() { pins += 1; throw new Error("must not pin"); } },
      candidates: { collectEligible() { throw new Error("must not collect"); } },
    });
    assert.throws(() => assertSealedEvaluationVectorDisabled({ enabled: true }), /RETRIEVAL_EVALUATION_CORPUS_INVALID/);
    assert.equal(pins, 0);
    void service;
  });

  it("counts injected cross-project output before duplicate-item metric collapsing", async () => {
    const corpus = readSealedBundle();
    const harness = await createRealV2EvaluationHarness(corpus);
    const contaminated = withInjectedCrossProjectResult(harness.service, corpus.queries[0]!);
    const report = await evaluateSealedRetrievalUnchecked(corpus, contaminated);
    assert.equal(report.crossProjectContamination, 1);
  });
  ```

  `evaluateSealedRetrievalUnchecked` is a test-only call to the existing metric
  accumulator before acceptance comparison; it must not be exported. Add a
  separate test proving that the real source contains the near duplicate but
  the unwrapped real V2 service returns none for it. Run:

  `npm run test:retrieval-evaluation`

  Expected: PASS with one aggregate-only V2 report, at least 500 requests,
  zero unwrapped contamination, all absolute thresholds, and no frozen
  baseline regression.

- [ ] **Step 6: Commit the real evaluator conversion.**

  ```bash
  git add src/orchestrator/retrieval/evaluation.ts tests/retrieval-evaluation.test.ts
  git commit -m "test: evaluate retrieval through sealed V2 projections"
  ```

#### Task 7.3: Lock the runner and CI against evaluation or production-routing shortcuts

**Files:**

- Modify: `scripts/run-retrieval-evaluation.js:1-42`
- Modify: `tests/ci-lifecycle-gates.test.ts:1-470`
- Modify: `tests/retrieval-evaluation.test.ts:1-460`

- [ ] **Step 1: Write failing runner and source-structure guard tests.**

  Add a `ci-lifecycle-gates` test that reads the normalized sources and rejects
  all of the following:

  ```ts
  const evaluationTest = source("tests/retrieval-evaluation.test.ts");
  assert.doesNotMatch(evaluationTest, /new Map\(corpus\.queries\.map\(\(query\) => \[/);
  assert.doesNotMatch(evaluationTest, /byText\.get\(request\.query\)/);
  assert.doesNotMatch(evaluationTest, /function (?:itemFor|channelFor|kindFor)\(/);
  assert.match(evaluationTest, /new V2ProjectionBuildCoordinator\(/);
  assert.match(evaluationTest, /leasePublishedForEvaluation\(/);
  assert.match(evaluationTest, /new V2SqliteRetrievalCandidateRepository\(/);
  assert.match(evaluationTest, /new InternalRetrievalService\(/);
  assert.match(evaluationTest, /vector:\s*Object\.freeze\(\{ enabled: false/);
  ```

  Add source checks that V2 imports remain absent from
  `src/orchestrator/runtime/projection-runtime.ts`, all protected Version 1
  paths, `src/app.ts`, `src/index.ts`, controllers, schemas, and services;
  assert no `memory_retrieval*`/`memory_projection*` production tool is
  registered. Finally, invoke `scripts/run-retrieval-evaluation.js` with a
  second compiled test path and assert it exits nonzero with
  `RETRIEVAL_EVALUATION_TARGET_INVALID`.

- [ ] **Step 2: Run the isolation guard red.**

  Run: `npm run test:build && node --test --test-concurrency=1 --test-name-pattern="Subproject 3 evaluation" dist-test/tests/ci-lifecycle-gates.test.js`

  Expected: FAIL until the guard recognizes the sealed harness and the runner
  verifies its exact compiled target.

- [ ] **Step 3: Harden the runner and CI checks.**

  Preserve its current exact resolved target comparison, then reject a missing
  compiled file and require the V2 report marker emitted by the test:

  ```js
  if (requested !== evaluationTest || !existsSync(evaluationTest)) {
    throw new Error("RETRIEVAL_EVALUATION_TARGET_INVALID");
  }
  const child = spawn(process.execPath, [
    "--test", "--test-concurrency=1", "--test-reporter=spec", evaluationTest,
  ], {
    cwd: root,
    shell: false,
    stdio: "inherit",
    env: { ...process.env, RETRIEVAL_EVALUATION_REPORT: "sealed-v2" },
  });
  ```

  In the evaluation test, emit `JSON.stringify(report)` only when the env value
  is exactly `"sealed-v2"`, and assert `report.corpusVersion` is V2 before
  writing. The runner must not log source events, queries, baseline fixture
  content, bindings, or paths. Add the structural checks from Step 1 to the
  existing internal-only gate without relaxing its protected V1 diff check.

- [ ] **Step 4: Run all focused Task 7 checks.**

  Run: `npm run typecheck && npm run test:retrieval-evaluation && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-lifecycle-gates.test.js`

  Expected: PASS. The only permitted executable-test skip is the established
  Windows `EPERM` symlink capability skip; any evaluator, source integrity,
  baseline, vector, routing, or TypeScript failure blocks this task.

- [ ] **Step 5: Commit the permanent shortcut guards.**

  ```bash
  git add scripts/run-retrieval-evaluation.js tests/retrieval-evaluation.test.ts tests/ci-lifecycle-gates.test.ts
  git commit -m "test: guard sealed V2 retrieval evaluation"
  ```

#### Task 7.4: Evidence, full gates, and independent review

**Files:**

- Modify: `docs/superpowers/plans/2026-08-24-subproject-3-final-review-remediation.md`

- [ ] **Step 1: Run the complete Subproject 3 gate from a clean working tree.**

  Run: `npm run test:subproject-3`

  Expected: exit 0; the runner prints exactly one aggregate V2 report, every
  projection/retrieval/lifecycle gate passes, and no test other than the known
  Windows symlink capability case is skipped.

- [ ] **Step 2: Run the broader release verification.**

  Run: `npm run check:runtime && npm run typecheck && npm run test:build && npm run test:build-artifacts && npm test`

  Expected: exit 0 for every command. On the first failure, preserve its full
  command/output, stop the completion claim, and remediate under a newly
  approved scoped step if it falls outside Task 7's authorized files.

- [ ] **Step 3: Complete independent specification and code-quality reviews.**

  Review the final diff against the approved Task 7 design. Verify all nine
  authorized scope paths only, no answer-derived integration behavior, real V2
  evaluator lease/adapter use, no V2 runtime/tool/routing wiring, static
  source-event/judgment/baseline hashes, aggregate-only output, the acceptance
  inequalities, and immutable V1 baseline semantics. Fix review findings,
  re-run the focused command plus the affected full command, and commit each
  scoped correction separately.

- [ ] **Step 4: Record evidence and mark the Task 7 checkboxes only after verified success.**

  Record the exact Node version, OS, commit SHA, every command above, pass/fail
  counts, permitted skip count, V2 aggregate report, protected-path diff
  result, and review conclusions in the existing Task 7 section. Do not state
  that V2 is production-ready: this task produces sealed pre-shadow evidence
  only; Subprojects 4 and 5 retain the shadow, recovery, privacy, and routing
  approval gates.

  ```bash
  git add docs/superpowers/plans/2026-08-24-subproject-3-final-review-remediation.md
  git commit -m "docs: record Task 7 sealed evaluation evidence"
  git status --short
  ```

  Expected: the final status output is empty.

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
