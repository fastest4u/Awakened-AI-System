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

**Files:**
- Modify: `src/orchestrator/retrieval/service.ts`
- Modify: `src/orchestrator/retrieval/ranking.ts`
- Modify: `src/orchestrator/runtime/projection-runtime.ts`
- Test: `tests/retrieval-service.test.ts`
- Test: `tests/retrieval-ranking.test.ts`
- Test: `tests/projection-runtime.test.ts`

**Interfaces:**

```ts
function validateCustomRanking(
  ranked: readonly FusedCandidate[],
  eligible: ReadonlyMap<string, FusedCandidate>,
): readonly FusedCandidate[];
function selectRankedCandidates(
  ranked: readonly FusedCandidate[],
  request: ValidatedInternalRetrievalRequest,
): RankedSelection;
```

Every ranking path validates custom output then calls the same diversity, result,
token, conflict, and explanation-size selector. A custom ranker can reorder
supplied candidates only.

- [ ] **Step 1: Write hostile-ranker red tests**

```ts
it("applies limit and token budget after a custom ranker", async () => {
  const result = await serviceWithRanker(() => allEligibleCandidates())
    .retrieve({ ...request, limit: 1, tokenBudget: 10 });
  assert.equal(result.items.length, 1);
});
it("rejects injected and duplicate custom candidates", async () => {
  await assert.rejects(() => serviceWithRanker(() => [forgedCandidate]).retrieve(request), /RETRIEVAL_RANKER_INVALID/);
});
```

Cover diversity, conflict counts, forged metadata, oversized explanation input,
and default/custom selector equivalence.

- [ ] **Step 2: Run red**

Run: `npm run test:build && node --test --test-concurrency=1 dist-test/tests/retrieval-service.test.js dist-test/tests/retrieval-ranking.test.js dist-test/tests/projection-runtime.test.js`

Expected: FAIL because custom ranking bypasses hard selection.

- [ ] **Step 3: Validate then select**

```ts
const ranked = ranker === undefined
  ? defaultRank(filtered, request)
  : validateCustomRanking(customRank(ranker, filtered, request), filtered.byId);
const selection = selectRankedCandidates(ranked, request);
```

Keep the seam internal and do not register a tool or route. Build explanation
data from `selection` only.

- [ ] **Step 4: Verify**

Run: `npm run test:subproject-3`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/retrieval/service.ts src/orchestrator/retrieval/ranking.ts src/orchestrator/runtime/projection-runtime.ts tests/retrieval-service.test.ts tests/retrieval-ranking.test.ts tests/projection-runtime.test.ts
git commit -m "fix: enforce retrieval bounds after custom ranking"
```

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
