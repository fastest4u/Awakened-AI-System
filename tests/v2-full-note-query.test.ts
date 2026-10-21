import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { assertCapturedProjectionV3Image } from "../src/orchestrator/projections/captured-image-v3.js";
import { openImmutableProjectionImage } from "../src/orchestrator/projections/immutable-image.js";
import type { ProjectionManifestV3 } from "../src/orchestrator/projections/manifest-codec.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { EventStore, SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import * as databaseCore from "../src/orchestrator/retrieval/database-core.js";
import { buildNativeFullNoteResult } from "../src/orchestrator/verified-read/full-note-result.js";
import { encodedProtocolBytes } from "../src/orchestrator/verified-read/wire-data.js";
import type { FullNoteReadSuccessBaseV1, NativeFullNoteResultV1 } from "../src/orchestrator/verified-read/full-note-contracts.js";
import { command } from "./fixtures/fresh-start-admission-child.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";

type Domain = Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>;
function scope(f: Domain): ProjectBinding { const b = f.rootContext.binding; return { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId,
  workspaceId: b.workspaceId, branchScopeId: f.rootContext.branchScopeId ?? null, branchRef: f.rootContext.workspace.kind === "git" ? f.rootContext.workspace.branchRef : null, sessionId: null }; }
function context(f: Domain, root: string, m: ProjectionManifestV3, id: string) {
  const stat = lstatSync(root, { bigint: true }), file = lstatSync(f.retained.path, { bigint: true });
  const directory = { canonicalPath: root, device: String(stat.dev), inode: String(stat.ino) };
  const binding = { projectionBinding: scope(f), expectedRelease: f.retained.admission.release, controlGeneration: String(f.retained.admission.trusted.generation),
    session: { sessionId: f.retained.rootAuthority.sessionId, minimumEventPosition: "0" }, eventsFile: { path: f.retained.path, device: String(file.dev), inode: String(file.ino) },
    projectionDirectory: directory, executorStateDirectory: directory, deploymentDirectory: directory, compositionEpoch: "full-note" };
  return { request: { operation: "get-full-note", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters: { id } }, binding, remainingMs: 5000,
    receipt: { operation: "get-full-note", projectionSchemaVersion: 3, consistency: "project-strong", scope: scope(f), releaseId: binding.expectedRelease.releaseId,
      controlGeneration: binding.controlGeneration, requiredEventPosition: "0", projectionGeneration: m.generation, projectionEventPosition: m.terminalEventPosition,
      projectionEventHash: m.terminalEventHash, imageSha256: m.databaseSha256, verification: "image-scope-position-and-active-admission" } };
}
function appendCanonical(f: Domain, changes: Record<string, JsonValue> = {}) {
  const id = typeof changes.itemId === "string" ? changes.itemId : randomUUID(), template = command();
  const store = new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(), () => FRESH_NOW);
  store.append({ ...template, context: f.rootContext, commandId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(),
    streamId: `full-note-seed/${randomUUID()}`, expectedStreamVersion: 0n, events: [{ ...template.events[0]!, eventType: "MemorySourceRecorded", eventSchemaVersion: 2,
      visibilityScope: "project", payload: { sourceVersion: 2, binding: scope(f) as unknown as JsonValue, itemId: id, normalizedKey: `generic/${id}`,
        status: "verified", confidence: "high", verificationMethod: "committed-event", validFrom: FRESH_NOW, validTo: null,
        summary: "generic summary", contentHash: "a".repeat(64), conflictGroupId: null, supersedingItemId: null, ...changes } }] }); return id;
}

// All vectors start from a genuine authenticated schema3 publication. Corruption changes the selected eligible relationship only.
test("schema3_full_note_query_contract", async t => {
  const path = "../src/orchestrator/verified-read/full-note-query.js";
  const module = await import(path).catch(() => ({})) as Record<string, (db: DatabaseSync, manifest: unknown, ctx: unknown) => any>;
  assert.equal(typeof module.queryNativeFullNote, "function", "full_note_has_summary_and_literal_body requires the dedicated same-image query");
  const query = module.queryNativeFullNote!;
  const f = await makeGovernedNoteDomainFixture(), root = realpathSync.native(mkdtempSync(join(tmpdir(), "full-note-query-")));
  let db: DatabaseSync | undefined;
  try {
    const body = "# body-only needle\r\n\t```ts\n  e\u0301 é ไทย 😀  \n```\n";
    const notes = (["session-log", "insight", "mistake", "adr"] as const).map(recordKind => {
      const c = f.commandV2({ recordKind, summary: `summary ${recordKind}`, content: { format: "markdown", body } });
      return { recordKind, receipt: f.service().createV2(f.prepareCreateV2(c), f.rootContext).response };
    });
    for (let i = 0; i < 16; i++) { const c = f.commandV2({ summary: `unrelated ${i}` }); f.service().createV2(f.prepareCreateV2(c), f.rootContext); }
    const maximumBody = '"'.repeat(65536), maximumCommand = f.commandV2({ content: { format: "markdown", body: maximumBody } });
    const maximumNote = f.service().createV2(f.prepareCreateV2(maximumCommand), f.rootContext).response;
    const v1 = f.command({ recordKind: "mistake" }), legacy = f.service().create(f.prepareCreate(v1), f.rootContext).response;
    const generic = appendCanonical(f), expired = appendCanonical(f), retracted = appendCanonical(f), erased = appendCanonical(f);
    appendCanonical(f, { itemId: expired, status: "expired" }); appendCanonical(f, { itemId: retracted, status: "retracted" }); appendCanonical(f, { itemId: erased, status: "erased-evidence" });
    const successor = appendCanonical(f), superseded = appendCanonical(f);
    appendCanonical(f, { itemId: superseded, status: "superseded", supersedingItemId: successor });
    const temporal = appendCanonical(f, { validTo: "2026-10-02T00:00:00.000Z" });
    const driver = new NodeSqliteDriver({ DatabaseSync }), builder = new ImmutableProjectionBuilder({ driver, projectionDirectory: root });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: f.retained.path });
    const coordinator = new V2ProjectionBuildCoordinator({ builder, eventReader, projectionDirectory: root, schema3: { builder, eventReader } });
    const published = await coordinator.ensurePublishedV3(scope(f), 0n, 15000), m = published.manifest;
    const bytes = readFileSync(published.databasePath); assert.equal(createHash("sha256").update(bytes).digest("hex"), m.databaseSha256);
    const captured = openImmutableProjectionImage(bytes); try { assertCapturedProjectionV3Image(captured, m); } finally { captured.close(); }
    const mutable = join(root, "selected-corruption.sqlite"); writeFileSync(mutable, bytes); db = new DatabaseSync(mutable);
    const read = (id: string, changes: object = {}) => query(db!, m, { ...context(f, root, m, id), ...changes });
    await t.test("full_note_has_summary_and_literal_body", () => {
      for (const n of notes) { const out = read(n.receipt.recordId); assert.equal(out.operation, "get-full-note"); assert.equal(out.noteBoundsVersion, "v2-full-note-bounds-1");
        assert.equal(out.item.text, `summary ${n.recordKind}`); assert.equal(out.item.textKind, "canonical-summary"); assert.equal(out.item.recordKind, n.recordKind);
        assert.equal(out.item.content.body, body); assert.equal(out.item.content.contentHash, createHash("sha256").update("project-memory/governed-note-body/v1\n").update(JSON.stringify({ body, format: "markdown" })).digest("hex"));
        assert.ok(Object.isFrozen(out.item.content)); }
    });
    await t.test("actual_maximum_body_success_fits_prospective_returnability_reserve", () => {
      const ctx = context(f, root, m, maximumNote.recordId), selected = read(maximumNote.recordId) as NativeFullNoteResultV1;
      const envelopeBase: FullNoteReadSuccessBaseV1 = { version: 4, kind: "success", ids: { requestId: "\u0001".repeat(128), attemptId: "\u0001".repeat(128), laneEpoch: "\u0001".repeat(128) },
        receipt: { ...ctx.receipt, operation: "get-full-note", projectionSchemaVersion: 3, consistency: "project-strong", verification: "image-scope-position-and-active-admission" },
        fence: { controlGeneration: ctx.receipt.controlGeneration, releaseId: ctx.receipt.releaseId, capturedPosition: m.terminalEventPosition,
          capturedHash: m.terminalEventHash, requiredPosition: "0" }, closed: { image: true, reader: true, lock: true } };
      const out = buildNativeFullNoteResult(selected, envelopeBase);
      assert.equal(out.item!.content!.body, maximumBody);
      const empty = { ...out, item: { ...out.item!, content: { ...out.item!.content!, body: "" } } };
      const metadataBytes = encodedProtocolBytes({ ...envelopeBase, content: empty }), successBytes = encodedProtocolBytes({ ...envelopeBase, content: out });
      const prospectiveContent = { ...empty, item: { ...empty.item, knownFromEventPosition: "9223372036854775807", sourceEventPosition: "9223372036854775807" } };
      const reserve = encodedProtocolBytes(prospectiveContent) + encodedProtocolBytes({ ...scope(f), sessionId: f.retained.rootAuthority.sessionId }) + 8192;
      assert.ok(metadataBytes <= reserve && reserve <= 65536); assert.equal(successBytes, metadataBytes + 131072); assert.ok(successBytes <= 262144);
      t.diagnostic(`maximum actual success=${successBytes}; metadata=${metadataBytes}; C+B+8192=${reserve}; body JSON=131074`);
    });
    await t.test("legacy_and_generic_absence_are_distinct", () => {
      assert.equal(read(legacy.recordId).item.recordKind, "mistake"); assert.equal(read(legacy.recordId).item.bodyAvailability, "absent"); assert.equal(read(legacy.recordId).item.content, null);
      assert.equal(read(generic).item.recordKind, null); assert.equal(read(generic).item.content, null);
      for (const id of [randomUUID(), expired, retracted, erased, notes[0]!.receipt.recordId.toUpperCase()]) { const out = read(id); assert.deepEqual([out.item, out.conflict], [null, null]); }
      assert.equal(read(superseded).item.status, "superseded"); assert.equal(read(superseded).item.supersedingItemId, successor);
    });
    await t.test("full_note_scope_temporal_receipt_and_profile_guards", () => {
      const id = notes[0]!.receipt.recordId, ctx = context(f, root, m, id);
      assert.throws(() => query(db!, { ...m, schemaVersion: 2 }, ctx), { code: "INTEGRITY_FAILURE" });
      assert.throws(() => read(id, { remainingMs: 0 }), { code: "WORKER_TIMEOUT" });
      assert.throws(() => read(id, { receipt: { ...ctx.receipt, imageSha256: "b".repeat(64) } }), { code: "INTEGRITY_FAILURE" });
      assert.throws(() => read(id, { binding: { ...ctx.binding, projectionBinding: { ...scope(f), projectId: "wrong" } } }), { code: "PROJECTION_SCOPE_MISMATCH" });
      assert.throws(() => read(id, { receipt: { ...ctx.receipt, scope: { ...scope(f), branchRef: "wrong" } } }), { code: "PROJECTION_SCOPE_MISMATCH" });
      assert.equal(read(id, { binding: { ...ctx.binding, session: { sessionId: f.retained.childAuthority.sessionId, minimumEventPosition: "0" } } }).item, null);
      assert.equal(read(id, { request: { ...ctx.request, parameters: { id, knownAt: "0" } } }).item, null);
      assert.equal(read(temporal, { request: { ...ctx.request, parameters: { id: temporal, validAt: "2026-10-02T00:00:00.000Z" } } }).item, null);
      assert.equal(read(temporal, { request: { ...ctx.request, parameters: { id: temporal, validAt: FRESH_NOW } } }).item.id, temporal);
    });
    await t.test("missing_v2_row_is_integrity", () => {
      const id = notes[0]!.receipt.recordId;
      const mutations: [string, unknown[]][] = [
        ["DELETE FROM governed_notes WHERE item_id = ?", [id]], ["DELETE FROM governed_notes WHERE item_id = ?", [legacy.recordId]],
        ["UPDATE governed_notes SET body = 'changed' WHERE item_id = ?", [id]], ["UPDATE governed_notes SET body_content_hash = ? WHERE item_id = ?", ["b".repeat(64), id]],
        ["UPDATE governed_notes SET record_kind = 'adr' WHERE item_id = ?", [id]], ["UPDATE governed_notes SET source_event_position = source_event_position + 1 WHERE item_id = ?", [id]],
        ["UPDATE governed_notes SET format = NULL, body = NULL, body_content_hash = NULL WHERE item_id = ?", [id]],
        ["UPDATE canonical_items SET normalized_key = 'generic/key' WHERE item_id = ?", [id]],
        ["UPDATE canonical_items SET verification_method = 'committed-event' WHERE item_id = ?", [id]],
        ["UPDATE canonical_items SET verification_method = 'governed-note-unverified-v2' WHERE item_id = ?", [generic]],
        ["UPDATE canonical_items SET normalized_key = 'governed-note/insight/invalid' WHERE item_id = ?", [generic]],
        ["INSERT INTO governed_notes SELECT project_id, ?, record_kind, format, body, body_content_hash, source_event_position FROM governed_notes WHERE item_id = ?", [generic, id]],
      ];
      for (const [sql, parameters] of mutations) {
        db!.exec("SAVEPOINT corruption"); try { db!.prepare(sql).run(...parameters as (string | number | null)[]);
          const target = sql.includes("INSERT") || parameters[0] === generic ? generic : parameters.includes(legacy.recordId) ? legacy.recordId : id;
          assert.throws(() => read(target), { code: "INTEGRITY_FAILURE" }, sql);
        } finally { db!.exec("ROLLBACK TO corruption"); db!.exec("RELEASE corruption"); }
      }
    });
    await t.test("full_note_exact_id_plan_is_indexed", () => {
      const helper = (databaseCore as unknown as Record<string, (db: DatabaseSync, m: ProjectionManifestV3, project: string, id: string) => unknown>).getGovernedNoteFromProjectionDatabase;
      assert.equal(typeof helper, "function");
      const prepare = db!.prepare.bind(db!); const observed: { sql: string; parameters: object; rows: number }[] = [];
      Object.defineProperty(db!, "prepare", { configurable: true, value(sql: string) {
        const statement = prepare(sql); if (/FROM governed_notes/u.test(sql)) {
          const all = statement.all.bind(statement); Object.defineProperty(statement, "all", { value(parameters: Record<string, string>) {
            const rows = all(parameters); observed.push({ sql, parameters, rows: rows.length }); return rows;
          } });
        } return statement;
      } });
      try { assert.ok(helper!(db!, m, scope(f).projectId, notes[0]!.receipt.recordId)); } finally { delete (db as unknown as { prepare?: unknown }).prepare; }
      assert.equal(observed.length, 1); assert.ok(observed[0]!.rows <= 1);
      const plan = prepare(`EXPLAIN QUERY PLAN ${observed[0]!.sql}`).all(observed[0]!.parameters as Record<string, string>);
      assert.ok(plan.some(row => /SEARCH governed_notes.*(INDEX|PRIMARY KEY)/u.test(String(row.detail))), JSON.stringify(plan));
      t.diagnostic(`actual side SQL plan=${JSON.stringify(plan)}; returned rows=${observed[0]!.rows}`);
      assert.equal(helper!(db!, m, "wrong-project", notes[0]!.receipt.recordId), null);
    });
  } finally { db?.close(); await f.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
