import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { ImmutableProjectionBuilder, foldProjectionSnapshotV3 } from "../src/orchestrator/projections/builder.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { assertCapturedProjectionV3Image } from "../src/orchestrator/projections/captured-image-v3.js";
import { openImmutableProjectionImage } from "../src/orchestrator/projections/immutable-image.js";
import type { ProjectionManifestV2, ProjectionManifestV3 } from "../src/orchestrator/projections/manifest-codec.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { EventStore, SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { validateInternalRetrievalRequest } from "../src/orchestrator/retrieval/contracts.js";
import { V2SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/v2-candidates.js";
import { collectNativeRankedQuery } from "../src/orchestrator/verified-read/content-ranking.js";
import { queryNativeContent, type NativeQueryCandidate, type NativeQueryContext } from "../src/orchestrator/verified-read/content-query.js";
import { buildNativeContentResult } from "../src/orchestrator/verified-read/content-result.js";
import type { NativeContentResult, VerifiedContentReadRequest } from "../src/orchestrator/verified-read/content-contracts.js";
import type { ReadSuccessBase, VerifiedReadBinding } from "../src/orchestrator/verified-read/contracts.js";
import { assertNativeContentMatchesRequest } from "../src/orchestrator/verified-read/content-protocol.js";
import { assertWorkflowCursorMatches, decodeWorkflowCursor, encodeWorkflowCursor } from "../src/orchestrator/verified-read/workflow-cursor.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { encodedProtocolBytes } from "../src/orchestrator/verified-read/wire-data.js";
import { command } from "./fixtures/fresh-start-admission-child.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";

type RichManifest = ProjectionManifestV2 | ProjectionManifestV3;
type Domain = Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>;
const query = queryNativeContent;
const driver = new NodeSqliteDriver({ DatabaseSync });
function scope(f: Domain): ProjectBinding {
  const b = f.rootContext.binding;
  return { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId,
    branchScopeId: f.rootContext.branchScopeId ?? null, branchRef: f.rootContext.workspace.kind === "git" ? f.rootContext.workspace.branchRef : null, sessionId: null };
}
function request(operation: VerifiedContentReadRequest["operation"], parameters: object = {}): VerifiedContentReadRequest {
  return { operation, consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000,
    parameters: operation === "search-projected-content" || operation === "build-context-pack" ? { query: "summaryneedle", ...parameters } : parameters } as VerifiedContentReadRequest;
}
function context(f: Domain, root: string, m: RichManifest, req: VerifiedContentReadRequest, sessionId: string = f.retained.rootAuthority.sessionId): NativeQueryContext {
  const stat = lstatSync(root, { bigint: true }), file = lstatSync(f.retained.path, { bigint: true });
  const directory = { canonicalPath: root, device: String(stat.dev), inode: String(stat.ino) };
  const binding: VerifiedReadBinding = { projectionBinding: scope(f), expectedRelease: f.retained.admission.release,
    controlGeneration: String(f.retained.admission.trusted.generation), session: { sessionId, minimumEventPosition: "0" },
    eventsFile: { path: f.retained.path, device: String(file.dev), inode: String(file.ino) }, projectionDirectory: directory,
    executorStateDirectory: directory, deploymentDirectory: directory, compositionEpoch: "summary-regression" };
  return { request: req, binding, remainingMs: 5000, receipt: { operation: req.operation, consistency: req.consistency,
    scope: scope(f), releaseId: binding.expectedRelease.releaseId, controlGeneration: binding.controlGeneration,
    requiredEventPosition: "0", projectionGeneration: m.generation, projectionEventPosition: m.terminalEventPosition,
    projectionEventHash: m.terminalEventHash, imageSha256: m.databaseSha256, verification: "image-scope-position-and-active-admission" } };
}
function base(ctx: NativeQueryContext): ReadSuccessBase {
  return { version: 3, kind: "success", ids: { requestId: "summary-request", attemptId: "summary-attempt", laneEpoch: "summary-epoch" },
    receipt: ctx.receipt, fence: { controlGeneration: ctx.binding.controlGeneration, releaseId: ctx.receipt.releaseId,
      capturedPosition: ctx.receipt.projectionEventPosition, capturedHash: ctx.receipt.projectionEventHash, requiredPosition: "0" },
    closed: { image: true, reader: true, lock: true } };
}
function detached(f: Domain, root: string, db: DatabaseSync, m: RichManifest, req: VerifiedContentReadRequest, sessionId: string = f.retained.rootAuthority.sessionId): NativeContentResult {
  const ctx = context(f, root, m, req, sessionId), envelopeBase = base(ctx);
  assert.equal(Object.keys(ctx.receipt).length, 11);
  let candidate: NativeQueryCandidate | undefined;
  assert.doesNotThrow(() => { candidate = query(db, m, ctx); }, "ordinary rich query accepts the actual captured profile");
  const result = buildNativeContentResult(candidate!, envelopeBase);
  assert.ok(encodedProtocolBytes({ ...envelopeBase, content: result }) <= 16384);
  assertNativeContentMatchesRequest(result, req, ctx.binding, ctx.receipt);
  return result;
}
function capture(published: { databasePath: string; manifest: RichManifest }) {
  const bytes = readFileSync(published.databasePath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), published.manifest.databaseSha256);
  const db = openImmutableProjectionImage(bytes);
  if (published.manifest.schemaVersion === 3) assertCapturedProjectionV3Image(db, published.manifest);
  return db;
}
function publication(f: Domain, root: string) {
  const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory: root });
  const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: f.retained.path });
  return new V2ProjectionBuildCoordinator({ builder, eventReader, projectionDirectory: root, schema3: { builder, eventReader } });
}
function appendCanonical(f: Domain, changes: Record<string, JsonValue> = {}) {
  const id = typeof changes.itemId === "string" ? changes.itemId : randomUUID(), b = scope(f), template = command();
  const store = new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(), () => FRESH_NOW);
  const result = store.append({ ...template, context: f.rootContext, commandId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(),
    streamId: `summary-seed/${randomUUID()}`, expectedStreamVersion: 0n, events: [{ ...template.events[0]!, eventType: "MemorySourceRecorded", eventSchemaVersion: 2,
      visibilityScope: "project", payload: { sourceVersion: 2, binding: b as unknown as JsonValue, itemId: id, normalizedKey: `summary/${id}`,
        status: "verified", confidence: "high", verificationMethod: "committed-event", validFrom: FRESH_NOW, validTo: null,
        summary: "summaryneedle generic", contentHash: "a".repeat(64), conflictGroupId: null, supersedingItemId: null, ...changes } }] });
  return { id, position: result.lastGlobalPosition.toString() };
}
async function checkpoint(f: Domain) {
  const b = f.rootContext.binding, sessionId = f.retained.rootAuthority.sessionId;
  const stream = f.connection.prepare("SELECT current_version FROM streams WHERE stream_id = $id").get({ $id: `session/${sessionId}` })!.current_version;
  const tail = f.connection.prepare("SELECT MAX(global_position) AS p FROM events").get()!.p;
  await f.retained.protectedLifecycle({ commandType: "record-checkpoint", commandId: randomUUID(), idempotencyKey: randomUUID(), agentId: "summary-fixture",
    expectedProjectId: b.projectId, expectedVaultId: b.vaultId, expectedWorkspaceId: b.workspaceId, expectedBranchRef: scope(f).branchRef,
    sessionId, expectedStreamVersion: String(stream), expectedBaseEventPosition: String(tail), draft: { checkpointVersion: 1,
      taskSummary: "summaryneedle checkpointneedle", completedItems: [], inProgressItems: [{ summary: "summaryneedle open followup", confidence: "high" }],
      blockers: [{ summary: "summaryneedle blocked followup", confidence: "medium" }], nextActions: [], decisions: [], assumptions: [],
      unresolvedConflicts: [], filesTouched: [], artifactReferences: [], sourceReferences: [], commandResults: [], testResults: [], materialClaims: [] } }, sessionId);
  return { beforeStream: String(stream), afterStream: String(f.connection.prepare("SELECT current_version FROM streams WHERE stream_id = $id").get({ $id: `session/${sessionId}` })!.current_version) };
}
async function historical(f: Domain) {
  const generic = appendCanonical(f, { itemId: "f1111111-1111-4111-8111-111111111111" });
  const temporal = appendCanonical(f, { validTo: "2026-10-02T00:00:00.000Z" });
  const group = randomUUID(), conflictA = appendCanonical(f, { conflictGroupId: group, normalizedKey: "summary:conflict", status: "conflicted" });
  const conflictB = appendCanonical(f, { conflictGroupId: group, status: "provisional" });
  const successor = appendCanonical(f, { itemId: "01111111-1111-4111-8111-111111111111" }), superseded = appendCanonical(f);
  appendCanonical(f, { itemId: superseded.id, status: "superseded", supersedingItemId: successor.id });
  const retracted = appendCanonical(f);
  appendCanonical(f, { itemId: retracted.id, status: "retracted" });
  await checkpoint(f);
  // Frozen schema2 accounts session-bound material stream versions historically.
  // Genuine child lifecycle version1 admits this V1 note's independent source version2.
  const cmd = f.command({ summary: "summaryneedle historical governed", provenance: f.sources.child.map(({ kind, identity }) => ({ kind, identity })) });
  const governed = f.service().create(f.prepareCreate(cmd, f.childContext), f.childContext).response;
  return { generic, temporal, conflictA, conflictB, group, successor, superseded, retracted, governed };
}

// Break caught: schema3 takes legacy checkpoint/alias SQL, loses summary channels, or leaks body into old replies.
test("ordinary_schema3_text_and_ranking_are_summary_only", async () => {
  const f = await makeGovernedNoteDomainFixture(), root = realpathSync.native(mkdtempSync(join(tmpdir(), "summary-profile-")));
  try {
    const corpus = await historical(f), c = publication(f, root), p2 = await c.ensurePublished(scope(f), 0n, 15000), db2 = capture(p2);
    try {
      const p3 = await c.ensurePublishedV3(scope(f), 0n, 15000), db3 = capture(p3);
      try {
        assert.equal(p3.manifest.terminalEventPosition, p2.manifest.terminalEventPosition);
        assert.equal(p3.manifest.terminalEventHash, p2.manifest.terminalEventHash);
        assert.notEqual(p3.manifest.generation, p2.manifest.generation);
        assert.notEqual(p3.manifest.databaseSha256, p2.manifest.databaseSha256);
        for (const sessionId of [f.retained.rootAuthority.sessionId, f.retained.childAuthority.sessionId]) for (const req of [request("search-projected-content"), request("get-canonical-record", { id: corpus.governed.recordId }),
          request("list-canonical-records", { limit: 10 }), request("recent-canonical-records", { limit: 10 }),
          request("build-context-pack"), request("follow-up-radar", { limit: 10 })]) {
          const expected = detached(f, root, db2, p2.manifest, req, sessionId), actual = detached(f, root, db3, p3.manifest, req, sessionId);
          assert.deepEqual(actual, expected, req.operation);
        }
        const childGet = detached(f, root, db3, p3.manifest, request("get-canonical-record", { id: corpus.governed.recordId }), f.retained.childAuthority.sessionId);
        if (childGet.operation !== "get-canonical-record") throw new Error("get expected");
        assert.equal(childGet.item!.id, corpus.governed.recordId); assert.equal(childGet.item!.text, "summaryneedle historical governed");
        assert.equal(childGet.item!.status, "candidate"); assert.equal(childGet.item!.verificationMethod, "governed-note-unverified-v1");
        const childSearch = detached(f, root, db3, p3.manifest, request("search-projected-content", { query: `governed-note/insight/${corpus.governed.recordId}` }), f.retained.childAuthority.sessionId);
        if (childSearch.operation !== "search-projected-content") throw new Error("search expected");
        assert.deepEqual(childSearch.items.map(item => item.id), [corpus.governed.recordId]);
      } finally { db3.close(); }
    } finally { db2.close(); }
    const bodyTerm = "bodyonlyuniqueterm", body = `# ${bodyTerm}\n` + "literal markdown text\n".repeat(1000);
    assert.ok(Buffer.byteLength(body) > 16384 && Buffer.byteLength(body) <= 65536);
    const commandV2 = f.commandV2({ summary: "summaryneedle separate v2 note", content: { format: "markdown", body } });
    const lifecycleBefore = f.connection.prepare("SELECT current_version FROM streams WHERE stream_id = $id").get({ $id: `session/${f.retained.rootAuthority.sessionId}` })!.current_version;
    const note = f.service().createV2(f.prepareCreateV2(commandV2), f.rootContext).response;
    assert.equal(f.connection.prepare("SELECT current_version FROM streams WHERE stream_id = $id").get({ $id: `session/${f.retained.rootAuthority.sessionId}` })!.current_version, lifecycleBefore);
    const laterCheckpoint = await checkpoint(f);
    assert.equal(BigInt(laterCheckpoint.afterStream), BigInt(laterCheckpoint.beforeStream) + 1n);
    const snapshot = await new SqliteProjectionEventReader({ driver, eventStorePath: f.retained.path }).openCommittedSnapshotV3(scope(f));
    try {
      const replay = foldProjectionSnapshotV3(snapshot);
      assert.equal(replay.sessionTree.find(row => row.sessionId === f.retained.rootAuthority.sessionId)!.latestStreamVersion.toString(), laterCheckpoint.afterStream);
    } finally { snapshot.close(); }
    const requiredTail = BigInt(String(f.connection.prepare("SELECT MAX(global_position) AS p FROM events").get()!.p));
    const p3 = await c.ensurePublishedV3(scope(f), requiredTail, 15000), db = capture(p3);
    try {
      assert.equal(db.prepare("SELECT body FROM governed_notes WHERE item_id=?").get(note.recordId)!.body, body);
      for (const table of ["canonical_items", "lexical_chunks", "lexical_chunks_fts"]) {
        assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all(), (_, value: unknown) => typeof value === "bigint" ? String(value) : value).includes(bodyTerm), false);
      }
      const outputs = [request("search-projected-content"), request("get-canonical-record", { id: note.recordId }), request("list-canonical-records", { limit: 10 }),
        request("recent-canonical-records", { limit: 10 }), request("build-context-pack"), request("follow-up-radar", { limit: 10 })]
        .map(req => detached(f, root, db, p3.manifest, req));
      assert.equal(JSON.stringify(outputs).includes(bodyTerm), false);
      assert.equal(JSON.stringify(outputs).includes('"body"'), false);
      assert.equal(JSON.stringify(outputs).includes('"recordKind"'), false);
      assert.equal(JSON.stringify(outputs).includes('"content"'), false);
      const get = outputs[1]!; assert.equal(get.operation, "get-canonical-record");
      if (get.operation !== "get-canonical-record") throw new Error("get expected");
      assert.equal(get.item!.text, "summaryneedle separate v2 note");
      assert.equal(get.item!.status, "candidate"); assert.equal(get.item!.verificationMethod, "governed-note-unverified-v2");
      const summarySearch = detached(f, root, db, p3.manifest, request("search-projected-content", { query: "separate v2 note" }));
      if (summarySearch.operation !== "search-projected-content") throw new Error("search expected");
      assert.ok(summarySearch.items.some(item => item.id === note.recordId && item.text === "summaryneedle separate v2 note"));
      const onlyBody = detached(f, root, db, p3.manifest, request("search-projected-content", { query: bodyTerm }));
      assert.equal(onlyBody.operation, "search-projected-content");
      if (onlyBody.operation !== "search-projected-content") throw new Error("search expected");
      assert.deepEqual(onlyBody.items, []);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); await f.cleanup(); }
});

// Break caught: schema3 nullable rich rows, temporal/session eligibility, conflict closure, and deterministic ties regress.
test("schema3_uses_rich_columns", async () => {
  const f = await makeGovernedNoteDomainFixture(), root = realpathSync.native(mkdtempSync(join(tmpdir(), "summary-rich-")));
  try {
    const corpus = await historical(f), c = publication(f, root), p = await c.ensurePublishedV3(scope(f), 0n, 15000), db = capture(p);
    try {
      const get = (id: string, filters: object = {}, sessionId: string = f.retained.rootAuthority.sessionId) => query(db, p.manifest, context(f, root, p.manifest, request("get-canonical-record", { id, ...filters }), sessionId));
      const generic = get(corpus.generic.id); assert.equal(generic.operation, "get-canonical-record");
      if (generic.operation !== "get-canonical-record") throw new Error("get expected");
      assert.deepEqual([generic.lookup.item!.sessionId, generic.lookup.item!.validTo, generic.lookup.item!.conflictGroupId, generic.lookup.item!.supersedingItemId, generic.lookup.item!.anchor], [null, null, null, null, null]);
      assert.equal(generic.lookup.item!.summary, "summaryneedle generic");
      for (const [filters, want] of [[{ validAt: FRESH_NOW }, true], [{ validAt: "2026-10-02T00:00:00.000Z" }, false],
        [{ validAt: "2026-01-01T00:00:00.000Z" }, false], [{ knownAt: String(BigInt(corpus.temporal.position) - 1n) }, false], [{ knownAt: corpus.temporal.position }, true]] as const) {
        const result = get(corpus.temporal.id, filters); if (result.operation !== "get-canonical-record") throw new Error("get expected");
        assert.equal(result.lookup.item !== null, want);
      }
      const governed = get(corpus.governed.recordId, {}, f.retained.childAuthority.sessionId); if (governed.operation !== "get-canonical-record") throw new Error("get expected");
      assert.equal(governed.lookup.item!.sessionId, f.retained.childAuthority.sessionId);
      const project = get(corpus.governed.recordId, { visibility: "project" }); if (project.operation !== "get-canonical-record") throw new Error("get expected");
      assert.equal(project.lookup.item, null);
      const conflict = query(db, p.manifest, context(f, root, p.manifest, request("search-projected-content", { query: "summary:conflict" })));
      if (conflict.operation !== "search-projected-content") throw new Error("search expected");
      assert.deepEqual(new Set(conflict.rankedCandidates.map(v => v.item!.id)), new Set([corpus.conflictA.id, corpus.conflictB.id]));
      assert.equal(conflict.conflictGroups[0]!.eligibleMemberCount, 2);
      const ck = query(db, p.manifest, context(f, root, p.manifest, request("search-projected-content", { query: "checkpointneedle" })));
      if (ck.operation !== "search-projected-content") throw new Error("search expected");
      assert.ok(ck.rankedCandidates.some(v => v.item!.kind === "checkpoint" && v.item!.sessionId === f.retained.rootAuthority.sessionId && v.contributions.some(x => x.channel === "session-checkpoint")));
      const all = query(db, p.manifest, context(f, root, p.manifest, request("search-projected-content")));
      if (all.operation !== "search-projected-content") throw new Error("search expected");
      assert.equal(all.rankedCandidates.some(v => v.item!.id === corpus.superseded.id), true); // Existing ordinary search includes superseded candidates.
      assert.equal(all.rankedCandidates.some(v => v.item!.id === corpus.retracted.id), false);
      const superseded = get(corpus.superseded.id); if (superseded.operation !== "get-canonical-record") throw new Error("get expected");
      assert.equal(superseded.lookup.item!.status, "superseded"); assert.equal(superseded.lookup.item!.supersedingItemId, corpus.successor.id);
      const denied = get(corpus.retracted.id); if (denied.operation !== "get-canonical-record") throw new Error("get expected");
      assert.equal(denied.lookup.item, null);
      const page = query(db, p.manifest, context(f, root, p.manifest, request("list-canonical-records", { limit: 2 })));
      if (page.operation !== "list-canonical-records") throw new Error("list expected");
      const expectedVisibleIds = [corpus.generic.id, corpus.temporal.id, corpus.conflictA.id, corpus.conflictB.id, corpus.successor.id, corpus.superseded.id].sort();
      assert.deepEqual(page.page.items.map(entry => entry.item.id), expectedVisibleIds.slice(0, 2)); assert.equal(page.page.hasMore, true);
      const tieIds = [corpus.generic.id, corpus.successor.id].sort();
      assert.deepEqual(all.rankedCandidates.filter(v => tieIds.includes(v.item!.id)).map(v => v.item!.id), tieIds);
      const internal = validateInternalRetrievalRequest({ binding: scope(f), sessionId: f.retained.rootAuthority.sessionId, visibility: "session",
        query: "checkpointneedle", limit: 10, candidateLimit: 64, tokenBudget: 2048, consistency: { requiredEventPosition: 0n, deadlineMs: 5000 } });
      const collected = new V2SqliteRetrievalCandidateRepository().collectEligible({ database: db, manifest: p.manifest, close() {} }, internal);
      assert.ok(collected.channels.some(ch => ch.channel === "session-checkpoint" && ch.candidates.length > 0));
      assert.throws(() => Reflect.apply(collectNativeRankedQuery, undefined, [db, { ...p.manifest, schemaVersion: 1 }, { eligibility: internal, query: "summaryneedle", limit: 5, requiredEventPosition: "0", remainingMs: 5000 }]), { code: "INTEGRITY_FAILURE" });
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); await f.cleanup(); }
});

// Break caught: hardcoded schema2 cursors, omitted image/selection binding, or limit erroneously invalidates continuation.
test("same_position_schema_upgrade_invalidates_cursor", async () => {
  const f = await makeGovernedNoteDomainFixture(), root = realpathSync.native(mkdtempSync(join(tmpdir(), "summary-cursor-")));
  try {
    await historical(f); const c = publication(f, root), p2 = await c.ensurePublished(scope(f), 0n, 15000), db2 = capture(p2);
    try {
      const first2 = detached(f, root, db2, p2.manifest, request("list-canonical-records", { limit: 1 }));
      if (first2.operation !== "list-canonical-records") throw new Error("list expected");
      const cursor2 = first2.nextCursor!; assert.equal(decodeWorkflowCursor(cursor2).schemaVersion, 2);
      const p3 = await c.ensurePublishedV3(scope(f), 0n, 15000), db3 = capture(p3);
      try {
        assert.equal(p2.manifest.terminalEventPosition, p3.manifest.terminalEventPosition);
        assert.equal(p2.manifest.terminalEventHash, p3.manifest.terminalEventHash);
        const first3 = detached(f, root, db3, p3.manifest, request("list-canonical-records", { limit: 1 }));
        if (first3.operation !== "list-canonical-records") throw new Error("list expected");
        const cursor3 = first3.nextCursor!, decoded = decodeWorkflowCursor(cursor3);
        assert.equal(decoded.version, 1); assert.equal(decoded.schemaVersion, 3);
        assert.equal(decoded.projectionGeneration, p3.manifest.generation); assert.equal(decoded.imageSha256, p3.manifest.databaseSha256);
        for (const [db, m, cursor] of [[db3, p3.manifest, cursor2], [db2, p2.manifest, cursor3]] as const)
          assert.throws(() => query(db, m, context(f, root, m, request("list-canonical-records", { cursor }))), { code: "V2_CONTENT_CURSOR_STALE" });
        for (const filters of [{ visibility: "project" }, { validAt: FRESH_NOW }, { knownAt: p3.manifest.terminalEventPosition }])
          assert.throws(() => query(db3, p3.manifest, context(f, root, p3.manifest, request("list-canonical-records", { cursor: cursor3, ...filters }))), { code: "V2_CONTENT_CURSOR_STALE" });
        const changedSession = context(f, root, p3.manifest, request("list-canonical-records", { cursor: cursor3 }));
        assert.throws(() => query(db3, p3.manifest, { ...changedSession, binding: { ...changedSession.binding, session: { sessionId: f.retained.childAuthority.sessionId, minimumEventPosition: "0" } } }), { code: "V2_CONTENT_CURSOR_STALE" });
        const second = detached(f, root, db3, p3.manifest, request("list-canonical-records", { cursor: cursor3, limit: 10 }));
        if (second.operation !== "list-canonical-records") throw new Error("list expected");
        assert.ok(second.items.every(entry => entry.item.id > decoded.lastId));
        for (const change of [{ schemaVersion: 2 }, { projectionGeneration: decoded.projectionGeneration + 1 }, { imageSha256: "9".repeat(64) }])
          assert.throws(() => assertWorkflowCursorMatches(decoded, { ...decoded, ...change } as Parameters<typeof assertWorkflowCursorMatches>[1]), { code: "V2_CONTENT_CURSOR_STALE" });
        for (const schemaVersion of [1, 4, "3", null]) {
          const malformed = Buffer.from(canonicalJson({ ...decoded, schemaVersion })).toString("base64url");
          assert.throws(() => decodeWorkflowCursor(malformed), { code: "FRESH_START_INPUT_INVALID" });
        }
        assert.equal(encodeWorkflowCursor(decoded), cursor3);
      } finally { db3.close(); }
    } finally { db2.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); await f.cleanup(); }
});
