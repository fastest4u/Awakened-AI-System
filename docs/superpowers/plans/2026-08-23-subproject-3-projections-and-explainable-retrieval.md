# Subproject 3: Projections and Explainable Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a Version 2 internal read model that rebuilds deterministically from each isolated project event store and explains bounded, scope-safe retrieval results without changing Version 1 production routing.

**Architecture:** Authoritative events commit only to the existing per-project SQLite/WAL store. A separate coordinator reads a committed event snapshot, builds and verifies an immutable projection generation, then atomically publishes a manifest. Retrieval pins one published generation, applies every scope/temporal/status filter before any channel ranks candidates, and exposes only internal contracts until Subproject 5 enables shadow mode.

**Tech Stack:** Node.js 24.16.0+, TypeScript 5.8, node:sqlite through the existing SqliteDriver abstraction, SQLite 3.51.3+ with WAL and FTS5, existing canonical JSON and SHA-256 utilities, Node test runner.

**Spec:** docs/superpowers/specs/2026-08-23-subproject-3-projections-and-explainable-retrieval-design.md

## Global Constraints

- Preserve Task 19 isolation: do not change src/app.ts, src/index.ts, src/controllers, src/schemas, or src/services to route a production request through Version 2.
- Keep the event store authoritative. Derived projection files, their manifest, vector cache, and evaluation data are never authoritative and never repair event history.
- Do not attach a projection SQLite file to the event-store transaction. Commit events first; publish a separately verified generation later.
- Resolve all project, workspace, branch, session, temporal, status, and erasure eligibility before ranking or conflict expansion.
- The projection database, manifest, temporary files, and logs contain no raw evidence, session handles, capability material, provider keys, authorization data, or process command text.
- Keep external vector or reranker providers disabled by default. Their eventual use requires a later explicit per-project opt-in and redacted canonical inputs only.
- Every task retains full replay determinism, validates strict own-data inputs, and supplies bounded work, byte, result, and timeout limits.
- Every task runs typecheck, its focused tests, and the existing Version 1 isolation gate before commit. Do not stage unrelated worktree changes or .superpowers scratch files.

---

## File Structure

- src/orchestrator/projections/contracts.ts defines public-internal projection, manifest, lease, source-event, and consistency types.
- src/orchestrator/projections/source-event-codec.ts strictly maps StoredEvent values into projectable events or an intentionally-unprojected result.
- src/orchestrator/projections/folds.ts contains pure current-state, artifact, follow-up, and lexical fold functions.
- src/orchestrator/projections/checksum.ts canonicalizes and hashes deterministic core rows.
- src/orchestrator/projections/schema.ts creates the independent read-model SQLite schema including FTS5.
- src/orchestrator/projections/manifest.ts validates and atomically reads or publishes projection manifests.
- src/orchestrator/projections/event-reader.ts reads a stable ordered snapshot from the authoritative event store.
- src/orchestrator/projections/builder.ts writes and validates one immutable projection generation.
- src/orchestrator/projections/coordinator.ts serializes per-project builds, cleans abandoned temporary files, and enforces required event positions.
- src/orchestrator/projections/reader-lease.ts pins generations and prevents premature cleanup.
- src/orchestrator/projections/integrity.ts fully replays a generation and validates its manifest.
- src/orchestrator/retrieval/contracts.ts defines bounded internal request, result, candidate, explanation, and provider-port types.
- src/orchestrator/retrieval/eligibility.ts applies hard binding, visibility, temporal, status, and freshness predicates.
- src/orchestrator/retrieval/candidates.ts provides exact, FTS5, path/symbol, graph, continuity, and open-work candidate queries.
- src/orchestrator/retrieval/ranking.ts supplies versioned weighted reciprocal-rank fusion, deterministic reranking, conflict grouping, and diversity.
- src/orchestrator/retrieval/service.ts coordinates pinned reads, candidate retrieval, ranking, token budgeting, and redacted explanations.
- src/orchestrator/retrieval/vector-cache.ts defines the optional local vector-cache port and fallback behavior.
- src/orchestrator/retrieval/evaluation.ts computes Recall at 10, MRR, nDCG at 10, citation precision/recall, stale rate, and contamination.
- src/orchestrator/runtime/projection-runtime.ts creates internal-only coordinator and retrieval dependencies; it is not registered by the production MCP composition root.
- tests/projection-*.test.ts and tests/retrieval-*.test.ts test each independent layer.
- tests/fixtures/retrieval-evaluation/v1/corpus.json stores the immutable bilingual evaluation corpus.
- scripts/run-retrieval-evaluation.js runs the corpus and writes only redacted aggregate measurements.

## Task 1: Define strict projection source and fold contracts

**Files:**
- Create: src/orchestrator/projections/contracts.ts
- Create: src/orchestrator/projections/source-event-codec.ts
- Create: src/orchestrator/projections/folds.ts
- Create: tests/projection-source-event-codec.test.ts
- Create: tests/projection-folds.test.ts

**Interfaces:**
- Consumes: StoredEvent from src/orchestrator/contracts/event.ts and canonicalJson from src/orchestrator/serialization/canonical-json.ts.
- Produces: decodeProjectionEvent(event): ProjectionEventDecodeResult and foldProjectionEvent(state, event): ProjectionFoldState.
- Invariant: unknown events are reported as intentionally-unprojected with their event position and type; no payload is guessed or treated as canonical content.

- [ ] **Step 1: Write failing codec and fold tests**

    const decoded = decodeProjectionEvent(lifecycleCheckpointEvent());
    assert.equal(decoded.kind, "projected");
    assert.equal(decoded.event.kind, "checkpoint");

    const unknown = decodeProjectionEvent(eventOfType("UnrecognizedV99"));
    assert.deepEqual(unknown, {
      kind: "unprojected",
      eventPosition: 42n,
      eventType: "UnrecognizedV99",
    });

    assert.throws(
      () => foldProjectionEvent(emptyProjectionFoldState(), malformedSourceEvent()),
      /INTEGRITY_FAILURE/,
    );

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js

Expected: FAIL because the projection modules do not exist.

- [ ] **Step 3: Implement strict contracts, decoder, and pure folds**

    export type ProjectionEventDecodeResult =
      | Readonly<{ kind: "projected"; event: ProjectionEvent }>
      | Readonly<{ kind: "unprojected"; eventPosition: bigint; eventType: string }>;

    export function decodeProjectionEvent(event: StoredEvent): ProjectionEventDecodeResult {
      if (event.eventType === "SessionCheckpointRecorded") return decodeCheckpoint(event);
      if (event.eventType === "MemorySourceRecorded") return decodeMemorySource(event);
      if (event.eventType === "RetrievalFeedbackRecorded") return decodeFeedback(event);
      return Object.freeze({
        kind: "unprojected",
        eventPosition: event.globalPosition,
        eventType: event.eventType,
      });
    }

    export function foldProjectionEvent(
      state: ProjectionFoldState,
      event: ProjectionEvent,
    ): ProjectionFoldState {
      return Object.freeze(applyProjectionFold(state, event));
    }

Validate exact own data, finite byte lengths, UUID-like identifiers already
required by the project codec, allowed status transitions, normalized keys, and
inclusive valid-from/exclusive valid-to semantics. Preserve source event
positions and do not expose payload fields not explicitly allowed by the
projection event union.

- [ ] **Step 4: Run focused tests and typecheck**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js

Expected: PASS with malformed, unknown, future-version, accessor-bearing, and
cross-project source events rejected or classified without side effects.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/projections/contracts.ts src/orchestrator/projections/source-event-codec.ts src/orchestrator/projections/folds.ts tests/projection-source-event-codec.test.ts tests/projection-folds.test.ts
Run: git commit -m "feat: define projection source folds"

## Task 2: Build the independent projection schema and manifest

**Files:**
- Create: src/orchestrator/projections/schema.ts
- Create: src/orchestrator/projections/checksum.ts
- Create: src/orchestrator/projections/manifest.ts
- Create: tests/projection-schema.test.ts
- Create: tests/projection-manifest.test.ts
- Reuse: src/orchestrator/materialization/atomic-artifact-replacer.ts

**Interfaces:**
- Consumes: ProjectionFoldState from Task 1 and AtomicArtifactReplacer.
- Produces: ProjectionManifestV1, createProjectionSchema(connection), and projectionCoreChecksum(rows).
- Invariant: the manifest binds one immutable generation to project, vault, store, schema version, terminal event position/hash, file hash, and named core checksums.

- [ ] **Step 1: Write failing schema and manifest tests**

    const manifest = parseProjectionManifest({
      schemaVersion: 1,
      projectId,
      vaultId,
      storeId,
      generation: 2,
      terminalEventPosition: "17",
      terminalEventHash,
      databaseFile: "projections-1-2.sqlite",
      databaseSha256,
      coreChecksums: { sessionTree: checksum },
      createdAt,
    });
    assert.equal(manifest.generation, 2);
    assert.throws(() => parseProjectionManifest({ ...manifest, projectId: otherProjectId }));

    createProjectionSchema(connection);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM projection_metadata").get()!.n, 1n);

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-schema.test.js dist-test/tests/projection-manifest.test.js

Expected: FAIL because no independent schema or manifest codec exists.

- [ ] **Step 3: Implement schema, checksum, and manifest publication**

    export interface ProjectionManifestV1 {
      readonly schemaVersion: 1;
      readonly projectId: ProjectId;
      readonly vaultId: VaultId;
      readonly storeId: StoreId;
      readonly generation: number;
      readonly terminalEventPosition: string;
      readonly terminalEventHash: string;
      readonly databaseFile: string;
      readonly databaseSha256: string;
      readonly coreChecksums: Readonly<Record<ProjectionName, string>>;
      readonly createdAt: string;
    }

    export function projectionCoreChecksum(
      name: ProjectionName,
      schemaVersion: number,
      projectId: string,
      terminalEventPosition: bigint,
      rows: readonly CanonicalProjectionRow[],
    ): string {
      return sha256Utf8(
        "project-memory/projection-core/v1\n"
        + canonicalJson([name, schemaVersion, projectId, terminalEventPosition.toString(), rows]),
      );
    }

Create strict tables for projection_metadata, session_tree, canonical_items,
tasks_followups, artifacts_files, entity_graph, lexical_chunks, and
retrieval_feedback. Create only FTS5 virtual tables and indexes needed for
bounded candidate queries. Use the existing atomic replacer for the JSON
manifest after verifying file paths are within the projection directory.

- [ ] **Step 4: Run focused tests and static safety checks**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-schema.test.js dist-test/tests/projection-manifest.test.js
Run: git diff --check

Expected: PASS; manifest parsing rejects aliases, symlinks, malformed hashes,
wrong identities, noncanonical positions, and unbounded checksum maps.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/projections/schema.ts src/orchestrator/projections/checksum.ts src/orchestrator/projections/manifest.ts tests/projection-schema.test.ts tests/projection-manifest.test.ts
Run: git commit -m "feat: add immutable projection manifests"

## Task 3: Build, verify, and publish projection generations asynchronously

**Files:**
- Create: src/orchestrator/projections/event-reader.ts
- Create: src/orchestrator/projections/builder.ts
- Create: src/orchestrator/projections/reader-lease.ts
- Create: src/orchestrator/projections/coordinator.ts
- Create: tests/projection-builder.test.ts
- Create: tests/projection-coordinator.test.ts
- Test: tests/lifecycle-command-store.test.ts

**Interfaces:**
- Consumes: Task 1 decoder/folds, Task 2 schema/manifest, SqliteDriver, and the authoritative events table.
- Produces: ProjectionBuildCoordinator.ensurePublished(binding, requiredEventPosition, deadlineMs) and ProjectionReaderLease.
- Invariant: an event commit succeeds or fails without any cross-file projection write; only a verified generation manifest becomes visible to readers.

- [ ] **Step 1: Write failing build and source-transaction isolation tests**

    const result = await coordinator.ensurePublished(binding, 8n, 200);
    assert.equal(result.manifest.terminalEventPosition, "8");

    injectFailure("after-generation-fsync-before-manifest");
    await assert.rejects(() => coordinator.ensurePublished(binding, 9n, 200));
    assert.equal(readAuthoritativeEventCount(eventsConnection), 9n);
    assert.equal(readPublishedManifest().terminalEventPosition, "8");

    assertNoProjectionFileAccessDuring(() => lifecycleCommandStore.execute(command, onNew));

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/lifecycle-command-store.test.js

Expected: FAIL because no snapshot reader, coordinator, generation builder, or
reader lease exists.

- [ ] **Step 3: Implement snapshot reader, immutable builder, coordinator, and leases**

    export interface ProjectionBuildCoordinator {
      ensurePublished(
        binding: ProjectBinding,
        requiredEventPosition: bigint,
        deadlineMs: number,
      ): Promise<PublishedProjectionGeneration>;
    }

    export interface ProjectionReaderLease {
      readonly manifest: ProjectionManifestV1;
      close(): void;
    }

    export async function ensurePublished(
      binding: ProjectBinding,
      requiredEventPosition: bigint,
      deadlineMs: number,
    ): Promise<PublishedProjectionGeneration> {
      const snapshot = await eventReader.openCommittedSnapshot(binding);
      const generation = await builder.build(snapshot);
      await integrity.verify(generation);
      await manifestStore.publish(generation.manifest);
      if (generation.manifestPosition < requiredEventPosition) throw projectionLag();
      return generation;
    }

Use a read-only authoritative snapshot and an independent create-mode
projection database. The coordinator serializes one builder per project,
cleans only known temporary files, and never modifies or attaches the event
store. Pin published generations through leases; delete only retired,
fully-unleased generations. Extend lifecycle-command-store tests to prove its
existing transaction does not construct or touch a derived projection file.

- [ ] **Step 4: Run focused crash, lease, and isolation tests**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/lifecycle-command-store.test.js

Expected: PASS; crashes leave the source event store unchanged, old readers
retain a valid generation, and an unmet deadline returns PROJECTION_LAG.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/projections/event-reader.ts src/orchestrator/projections/builder.ts src/orchestrator/projections/reader-lease.ts src/orchestrator/projections/coordinator.ts tests/projection-builder.test.ts tests/projection-coordinator.test.ts tests/lifecycle-command-store.test.ts
Run: git commit -m "feat: publish replayable projection generations"

## Task 4: Add full projection integrity replay

**Files:**
- Create: src/orchestrator/projections/integrity.ts
- Create: tests/projection-integrity.test.ts
- Modify: src/orchestrator/lifecycle/errors.ts
- Test: tests/lifecycle-contracts.test.ts

**Interfaces:**
- Consumes: published manifest, immutable generation database, Task 1 folds, and Task 2 checksums.
- Produces: ProjectionIntegrityService.verify(binding, manifest): ProjectionIntegrityReport.
- Invariant: full integrity detects missing, extra, reordered, cross-project, noncanonical, and checksum-mismatched derived rows without repairing either database.

- [ ] **Step 1: Write failing integrity tests**

    const report = integrity.verify(binding, manifest);
    assert.equal(report.status, "passed");

    tamperProjectionRow("canonical_items", "project_id", otherProjectId);
    assert.throws(() => integrity.verify(binding, manifest), /INTEGRITY_FAILURE/);

    deleteProjectionRow("lexical_chunks", chunkId);
    assert.throws(() => integrity.verify(binding, manifest), /INTEGRITY_FAILURE/);

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-integrity.test.js dist-test/tests/lifecycle-contracts.test.js

Expected: FAIL because no full replay verifier or projection error contract exists.

- [ ] **Step 3: Implement linear replay and typed failure mapping**

    export class ProjectionIntegrityService {
      verify(binding: ProjectBinding, manifest: ProjectionManifestV1): ProjectionIntegrityReport {
        const replay = replayOrderedEvents(binding, manifest.terminalEventPosition);
        const rows = readOrderedProjectionRows(manifest);
        assertExactProjectionReplay(replay, rows);
        assertManifestChecksums(manifest, rows);
        return Object.freeze({ status: "passed", terminalEventPosition: manifest.terminalEventPosition });
      }
    }

Add PROJECTION_LAG and PROVIDER_UNAVAILABLE only when their safe messages,
retryability, and recovery actions are explicitly defined in lifecycle errors.
Map projection corruption and manifest identity mismatches to
INTEGRITY_FAILURE. The verifier reads each ordered event and expected row once,
does not call providers, and does not perform a repair.

Runtime integrity amendment: production requires Node.js 24.16.0 or newer. Full
projection integrity reads and hashes the exact generation bytes through a
pinned source descriptor, retains that descriptor for unchanged-byte rechecks,
then inspects an isolated in-memory database via
`DatabaseSync.deserialize()`. It never reopens the generation or a scratch copy
by pathname after byte capture. The manifest database hash remains defined over
the raw on-disk bytes; only a private clone used for in-memory inspection may
normalize SQLite WAL header bytes after the raw hash is verified. See the
[Node 24 projection-integrity runtime amendment](../specs/2026-08-23-node-24-projection-integrity-runtime-amendment.md).

- [ ] **Step 4: Run focused tests and complete projection tests**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/projection-schema.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/lifecycle-contracts.test.js

Expected: PASS; every injected derived-state corruption fails closed and
authoritative events remain unchanged.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/projections/integrity.ts src/orchestrator/lifecycle/errors.ts tests/projection-integrity.test.ts tests/lifecycle-contracts.test.ts
Run: git commit -m "feat: verify projection replay integrity"

## Task 5: Implement internal retrieval eligibility and local candidate channels

**Files:**
- Create: src/orchestrator/retrieval/contracts.ts
- Create: src/orchestrator/retrieval/eligibility.ts
- Create: src/orchestrator/retrieval/candidates.ts
- Create: src/orchestrator/retrieval/service.ts
- Create: tests/retrieval-eligibility.test.ts
- Create: tests/retrieval-candidates.test.ts
- Create: tests/retrieval-service.test.ts

**Interfaces:**
- Consumes: pinned ProjectionReaderLease, ProjectBinding, and core projection rows.
- Produces: InternalRetrievalService.retrieve(request): InternalRetrievalResult.
- Invariant: all eligibility predicates run before FTS5, exact, graph, continuity, or open-work channels.

- [ ] **Step 1: Write failing scope and temporal filter tests**

    const result = service.retrieve({
      binding: projectPBinding,
      query: "same-task",
      limit: 10,
      tokenBudget: 1200,
      consistency: { requiredEventPosition: 12n, deadlineMs: 100 },
    });
    assert.deepEqual(result.items.map((item) => item.projectId), [projectPBinding.projectId]);

    assert.equal(
      service.retrieve({ ...request, knownAt: 7n }).items.some((item) => item.knownFromEventPosition > 7n),
      false,
    );

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-eligibility.test.js dist-test/tests/retrieval-candidates.test.js dist-test/tests/retrieval-service.test.js

Expected: FAIL because no internal retrieval request, filter, or candidate repository exists.

- [ ] **Step 3: Implement bounded request, filter, and candidate repository**

    export function isEligible(
      item: RetrievalItem,
      request: InternalRetrievalRequest,
      binding: ProjectBinding,
    ): boolean {
      return item.projectId === binding.projectId
        && workspaceVisible(item, binding, request)
        && branchVisible(item, binding, request)
        && statusVisible(item)
        && temporalVisible(item, request)
        && freshnessVisible(item);
    }

    export class InternalRetrievalService {
      retrieve(request: InternalRetrievalRequest): InternalRetrievalResult {
        const lease = this.projections.pin(request.binding, request.consistency);
        const eligible = this.candidates.collectEligible(lease, request);
        return this.ranker.select(eligible, request, lease.manifest);
      }
    }

Set strict bounds for query bytes, result count, token budget, explain size,
candidate count, and deadline. Use prepared statements and FTS5 only after
eligibility predicates. Implement exact identifier, alias, FTS5, symbol/path,
session checkpoint, and open-follow-up channels. Reject includeGlobal before
opening another store because global promotion does not exist yet.

- [ ] **Step 4: Run focused tests and V1 production-isolation test**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-eligibility.test.js dist-test/tests/retrieval-candidates.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/ci-lifecycle-gates.test.js

Expected: PASS; identical content in other projects, workspaces, and branches
never reaches a candidate channel or result.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/retrieval/contracts.ts src/orchestrator/retrieval/eligibility.ts src/orchestrator/retrieval/candidates.ts src/orchestrator/retrieval/service.ts tests/retrieval-eligibility.test.ts tests/retrieval-candidates.test.ts tests/retrieval-service.test.ts
Run: git commit -m "feat: add scope-safe internal retrieval"

## Task 6: Add deterministic ranking, conflict handling, and redacted explanations

**Files:**
- Create: src/orchestrator/retrieval/ranking.ts
- Create: src/orchestrator/retrieval/explain.ts
- Create: tests/retrieval-ranking.test.ts
- Create: tests/retrieval-explain.test.ts
- Modify: src/orchestrator/retrieval/service.ts

**Interfaces:**
- Consumes: eligible channel candidates from Task 5.
- Produces: fuseCandidates(channels, policy), rerankCandidates(candidates, request), and buildRetrievalExplanation(result).
- Invariant: versioned ranking never changes eligibility; conflict closure filters each member independently and explanations omit secret-bearing input.

- [ ] **Step 1: Write failing rank and explanation tests**

    const fused = fuseCandidates([
      [{ id: "A", rank: 1, channel: "exact" }],
      [{ id: "B", rank: 1, channel: "lexical" }, { id: "A", rank: 2, channel: "lexical" }],
    ], DEFAULT_RANKING_POLICY);
    assert.deepEqual(fused.map((candidate) => candidate.id), ["A", "B"]);

    const explanation = buildRetrievalExplanation(result);
    assert.equal(JSON.stringify(explanation).includes("capability-secret"), false);
    assert.equal(explanation.dropped.byReason.scopeDenied, 1);

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-ranking.test.js dist-test/tests/retrieval-explain.test.js

Expected: FAIL because rank fusion and safe explanation builders do not exist.

- [ ] **Step 3: Implement fusion, reranking, conflict grouping, diversity, and explain output**

    export function weightedRrf(rank: number, weight: number, k = 60): number {
      return weight / (k + rank);
    }

    export function buildRetrievalExplanation(
      result: RankedRetrieval,
    ): RetrievalExplanation {
      return Object.freeze({
        eligibleCount: result.eligibleCount,
        dropped: result.redactedDropCounts,
        channels: result.channelContributions,
        projectionGeneration: result.manifest.generation,
        requiredEventPosition: result.requiredEventPosition.toString(),
        publishedEventPosition: result.publishedEventPosition.toString(),
      });
    }

Freeze policy version, channel weights, temporal decay, rerank feature names,
and diversity limits in a strict internal configuration. Keep every conflict
member that remains eligible; mark truncation and cursor state when the token
budget cannot include the full high-impact set. Do not emit candidate text,
provider inputs, handles, or raw evidence in explanations.

- [ ] **Step 4: Run focused tests**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-eligibility.test.js dist-test/tests/retrieval-candidates.test.js dist-test/tests/retrieval-ranking.test.js dist-test/tests/retrieval-explain.test.js dist-test/tests/retrieval-service.test.js

Expected: PASS; ranking is deterministic, conflicts are surfaced, and
explanations remain bounded and redacted.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/retrieval/ranking.ts src/orchestrator/retrieval/explain.ts src/orchestrator/retrieval/service.ts tests/retrieval-ranking.test.ts tests/retrieval-explain.test.ts
Run: git commit -m "feat: explain V2 retrieval ranking"

## Task 7: Add optional local vector-cache fallback

**Files:**
- Create: src/orchestrator/retrieval/vector-cache.ts
- Create: tests/retrieval-vector-cache.test.ts
- Modify: src/orchestrator/retrieval/contracts.ts
- Modify: src/orchestrator/retrieval/service.ts
- Reuse: src/utils/vector.ts

**Interfaces:**
- Consumes: redacted canonical chunks and an optional LocalVectorProvider.
- Produces: VectorCandidateChannel.search(request, lease) and VectorCacheManifestV1.
- Invariant: provider failures remove only the vector channel; they do not widen scope, alter hard filters, or call an external provider by default.

- [ ] **Step 1: Write failing disabled and fallback tests**

    const disabled = service.retrieve(request);
    assert.equal(disabled.channels.vector.used, false);

    provider.failNext(new Error("offline"));
    const fallback = service.retrieve({ ...request, vector: { enabled: true } });
    assert.equal(fallback.channels.vector.failureCode, "PROVIDER_UNAVAILABLE");
    assert.deepEqual(fallback.items.map((item) => item.projectId), [request.binding.projectId]);

- [ ] **Step 2: Run the focused test to verify it fails**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-vector-cache.test.js

Expected: FAIL because no vector-cache contract or fallback exists.

- [ ] **Step 3: Implement local-only cache and fallback**

    export interface LocalVectorProvider {
      readonly providerId: string;
      readonly model: string;
      embed(text: string): Promise<readonly number[]>;
    }

    export async function searchVectorChannel(
      provider: LocalVectorProvider | undefined,
      request: InternalRetrievalRequest,
    ): Promise<VectorChannelResult> {
      if (provider === undefined) return disabledVectorChannel();
      try {
        return await searchCachedVectors(provider, request);
      } catch {
        return unavailableVectorChannel();
      }
    }

Hash cache rows by source hash, provider, model, chunker version, dimensions,
and output hash. Validate finite dimensions and bounded byte size before
persisting. Keep provider credentials outside every request/result/manifest.
Do not implement an external provider in this subproject.

- [ ] **Step 4: Run focused tests and the retrieval suite**

Run: npm run typecheck
Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-vector-cache.test.js dist-test/tests/retrieval-eligibility.test.js dist-test/tests/retrieval-candidates.test.js dist-test/tests/retrieval-ranking.test.js dist-test/tests/retrieval-service.test.js

Expected: PASS; disabled and failed vectors preserve lexical/exact results and
the same project scope.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/retrieval/vector-cache.ts src/orchestrator/retrieval/contracts.ts src/orchestrator/retrieval/service.ts tests/retrieval-vector-cache.test.ts
Run: git commit -m "feat: add local vector retrieval fallback"

## Task 8: Create the immutable bilingual evaluation harness and internal runtime seam

**Files:**
- Create: src/orchestrator/retrieval/evaluation.ts
- Create: src/orchestrator/runtime/projection-runtime.ts
- Create: scripts/run-retrieval-evaluation.js
- Create: tests/fixtures/retrieval-evaluation/v1/corpus.json
- Create: tests/retrieval-evaluation.test.ts
- Create: tests/projection-runtime.test.ts
- Modify: package.json
- Modify: tests/ci-lifecycle-gates.test.ts

**Interfaces:**
- Consumes: Task 3 coordinator and Task 5-7 internal retrieval service.
- Produces: evaluateRetrieval(corpus, service): RetrievalEvaluationReport and createInternalProjectionRuntime(dependencies).
- Invariant: the runtime seam is internal-only; package scripts may test it but no production MCP controller, schema, service, or route calls it.

- [ ] **Step 1: Write failing corpus, threshold, and isolation tests**

    const report = await evaluateRetrieval(corpus, service);
    assert.equal(report.queryCount, 500);
    assert.equal(report.crossProjectContamination, 0);
    assert.ok(report.recallAt10 >= 0.95);
    assert.ok(report.mrr >= 0.90);
    assert.ok(report.ndcgAt10 >= 0.90);

    assert.equal(productionToolNames().includes("memory_retrievalExplain"), false);
    assert.match(subproject3Script(), /retrieval-evaluation\.test\.js/);

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: npm run test:build
Run: node --test --test-concurrency=1 dist-test/tests/retrieval-evaluation.test.js dist-test/tests/projection-runtime.test.js dist-test/tests/ci-lifecycle-gates.test.js

Expected: FAIL because no corpus, evaluator, internal runtime seam, or
Subproject 3 release script exists.

- [ ] **Step 3: Implement corpus validation, metrics, runtime seam, and test script**

    export function evaluateRetrieval(
      corpus: RetrievalEvaluationCorpusV1,
      service: InternalRetrievalService,
    ): RetrievalEvaluationReport {
      assertCorpusHasExactlyFiveHundredQueries(corpus);
      const outcomes = corpus.queries.map((query) => evaluateOne(query, service));
      return aggregateRetrievalMetrics(outcomes);
    }

Generate the committed corpus deterministically from a fixed fixture seed into
500 concrete JSON cases before commit; it must include at least 50 cases for
each critical class named in the specification. Store judged identifiers,
eligible scope, expected citations, and relevance grades, but no raw evidence
or credentials. Add a test:subproject-3 script that builds, runs all
projection/retrieval tests, runs the evaluation test, and then runs
ci-lifecycle-gates. Extend the CI contract test to prove no V2 retrieval tool
is registered and no protected Version 1 production path changes.

- [ ] **Step 4: Run the complete Subproject 3 verification set**

Run: npm run check:runtime
Run: npm run typecheck
Run: npm run test:build
Run: npm run test:subproject-3
Run: npm test
Run: npm run build
Run: npm run test:build-artifacts
Run: git diff --check

Expected: PASS; the corpus reaches every threshold, the internal runtime
remains unregistered, V1 production routing is unchanged, and all existing
release gates still pass.

- [ ] **Step 5: Commit the task**

Run: git add src/orchestrator/retrieval/evaluation.ts src/orchestrator/runtime/projection-runtime.ts scripts/run-retrieval-evaluation.js tests/fixtures/retrieval-evaluation/v1/corpus.json tests/retrieval-evaluation.test.ts tests/projection-runtime.test.ts package.json tests/ci-lifecycle-gates.test.ts
Run: git commit -m "test: gate V2 retrieval readiness"

## Final Verification and Subproject 3 Exit Review

- [ ] Inspect the full branch diff and confirm every projection change is outside V1 production routes and no .superpowers scratch artifact is staged.
- [ ] Run npm run check:runtime, npm run typecheck, npm test, npm run test:subproject-2, npm run test:subproject-3, npm run build, and npm run test:build-artifacts from a clean linked worktree.
- [ ] Build the same authoritative fixture three times and verify identical terminal positions, logical core checksums, projection rows, and manifest identities.
- [ ] Inject every pre-publish failure point and prove an authoritative event commit stays durable while only an unpublished projection file is removed or retried.
- [ ] Verify a Windows reader lease pins an old generation during a new publish and cleanup never replaces, renames, or deletes an open generation.
- [ ] Verify every project/workspace/branch/session/status/valid-at/known-at/freshness filter before every candidate channel, including conflict closure and vector fallback.
- [ ] Verify zero cross-project contamination, identifier/path recall of 1.00, checkpoint/follow-up/next-action Recall at 10 of 1.00, citation precision/recall at least 0.95, stale active rate at most 0.01, Recall at 10 at least 0.95, MRR at least 0.90, nDCG at 10 at least 0.90, and bitemporal accuracy at least 0.95 on the committed 500-query corpus.
- [ ] Run independent specification, implementation, and security review; resolve every P0/P1, rerun affected tests and complete gates, then record durable lessons with project-memory.
- [ ] Confirm the production composition root still rejects Version 2 lifecycle operations with LIFECYCLE_V2_DISABLED and does not register a Version 2 retrieval tool. Subproject 5 alone may introduce shadow and primary routing.
