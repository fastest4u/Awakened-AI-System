import assert from "node:assert/strict";
import test from "node:test";
import fs, { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executeFullNoteVerifiedRead, executeVerifiedRead, type FullNoteVerifiedReadChildDependencies } from "../src/orchestrator/verified-read/child.js";
import { decodeFullNoteReadBootstrap } from "../src/orchestrator/verified-read/full-note-protocol.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type { FullNoteReadTerminalReplyV1, ReadPhase } from "../src/orchestrator/verified-read/contracts.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";
const lock = ".projection-manifest.publish.lock", manifestFile = "projection-manifest.json";
const literal = "# Literal body-only\r\n\t```ts\n  e\u0301 \u0e44\u0e17\u0e22 \u{1f600}  \n```\n";
// Real authenticated producers/publications, direct executor evidence; compiled same-owner qualification belongs to Task11.
async function fixture(legacy = false) {
  const f = await makeGovernedNoteDomainFixture(), root = realpathSync.native(mkdtempSync(join(tmpdir(), "full-note-child-")));
  const b = f.rootContext.binding;
  const scope: ProjectBinding = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId,
    branchScopeId: f.rootContext.branchScopeId ?? null, branchRef: f.rootContext.workspace.kind === "git" ? f.rootContext.workspace.branchRef : null, sessionId: null };
  const create = () => { if (legacy) { const c = f.command({ provenance: f.sources.child.map(({ kind, identity }) => ({ kind, identity })) });
      return f.service().create(f.prepareCreate(c, f.childContext), f.childContext).response.recordId; }
    const c = f.commandV2({ content: { format: "markdown", body: literal } }); return f.service().createV2(f.prepareCreateV2(c), f.rootContext).response.recordId; };
  const id = create(), otherId = legacy ? id : create();
  const driver = new NodeSqliteDriver({ DatabaseSync }), builder = new ImmutableProjectionBuilder({ driver, projectionDirectory: root });
  const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: f.retained.path });
  const coordinator = new V2ProjectionBuildCoordinator({ builder, eventReader, projectionDirectory: root, schema3: { builder, eventReader } });
  const publish = () => coordinator.ensurePublishedV3(scope, 0n, 15000);
  const stat = lstatSync(root, { bigint: true }), file = lstatSync(f.retained.path, { bigint: true });
  const directory = { canonicalPath: root, device: String(stat.dev), inode: String(stat.ino) };
  const bootstrap = decodeFullNoteReadBootstrap({ version: 4, ids: { requestId: "full", attemptId: "attempt", laneEpoch: "full-note" },
    binding: { projectionBinding: scope, expectedRelease: f.retained.admission.release, controlGeneration: String(f.retained.admission.trusted.generation),
      session: { sessionId: legacy ? f.retained.childAuthority.sessionId : f.retained.rootAuthority.sessionId, minimumEventPosition: "0" }, eventsFile: { path: f.retained.path, device: String(file.dev), inode: String(file.ino) },
      projectionDirectory: directory, executorStateDirectory: directory, deploymentDirectory: directory, compositionEpoch: "full-note" },
    request: { operation: "get-full-note", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters: { id } }, lockToken: "b".repeat(32), remainingMs: 5000 });
  const cwd = process.cwd(); process.chdir(root);
  return { f, root, scope, bootstrap, id, otherId, publish, coordinator,
    stop() { f.retained.admission.control.stop({ identity: f.retained.admission.trusted.identity,
      expectedGeneration: f.retained.admission.trusted.generation, target: "read-only-recovery", reasonCode: "integrity-failure" }); },
    async dispose() { process.chdir(cwd); await f.cleanup(); if (!existsSync(join(root, lock))) rmSync(root, { recursive: true }); else console.error(`Retained unresolved full-note fixture: ${root}`); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function controls(f: Fixture, stage: (phase: ReadPhase) => void = () => {}) {
  let now = 0; const phases: ReadPhase[] = [], controller = new AbortController();
  const deps: FullNoteVerifiedReadChildDependencies = { inspectBuild: () => f.bootstrap.binding.expectedRelease.buildIdentityHash,
    now: () => now, wait: async ms => { now += ms; }, signal: controller.signal,
    emitStage(reply) { assert.equal(reply.version, 4); phases.push(reply.phase); stage(reply.phase); } };
  return { deps, phases, controller, advance(ms: number) { now += ms; } };
}
function refused(reply: FullNoteReadTerminalReplyV1, code: string, cleanup = "complete") {
  assert.equal(reply.kind, "failure"); if (reply.kind !== "failure") assert.fail();
  assert.equal(reply.failure.code, code); assert.equal(reply.failure.cleanup, cleanup); assert.equal("content" in reply, false);
}
test("full_note_closes_before_success queries one immutable captured image", async t => {
  const f = await fixture(); const m = (await f.publish()).manifest;
  let ordinal = 0, imageClose = 0, readerClose = 0, lockClose = 0, postReleaseBodyFetches = 0, query = false;
  const close = DatabaseSync.prototype.close, prepare = DatabaseSync.prototype.prepare, unlink = fs.unlinkSync;
  const closed = t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    const memory = this.prepare("PRAGMA database_list").get()!.file === ""; close.call(this);
    if (query) { if (memory) imageClose = ++ordinal; else readerClose = ++ordinal; }
  });
  const sql = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, source: string) {
    if (lockClose && /governed_notes|canonical_items/u.test(source)) postReleaseBodyFetches++;
    return prepare.call(this, source);
  });
  const released = t.mock.method(fs, "unlinkSync", (path: Parameters<typeof unlink>[0]) => { unlink(path); if (String(path) === lock) lockClose = ++ordinal; }); syncBuiltinESMExports();
  try {
    const c = controls(f, phase => { if (phase === "query") { query = true; assert.equal(readFileSync(lock, "utf8"), "b".repeat(32));
      renameSync(m.databaseFile, "captured-original.sqlite"); writeFileSync(m.databaseFile, "replaced pathname"); } });
    const result = await executeFullNoteVerifiedRead(f.bootstrap, c.deps), success = ++ordinal;
    assert.equal(result.kind, "success"); if (result.kind !== "success") assert.fail();
    assert.equal(result.version, 4); assert.equal(result.receipt.projectionSchemaVersion, 3); assert.equal(result.receipt.operation, "get-full-note");
    assert.equal(result.content.item!.content!.body, literal); assert.equal(result.content.item!.id, f.id);
    assert.ok(Object.isFrozen(result.content.item!.content)); assert.deepEqual(result.closed, { image: true, reader: true, lock: true });
    assert.ok(imageClose > 0 && readerClose > 0 && lockClose > 0 && imageClose < success && readerClose < success && lockClose < success);
    assert.equal(postReleaseBodyFetches, 0); assert.equal(existsSync(lock), false);
    assert.deepEqual(c.phases, ["admission", "projection-wait", "capture", "validate", "query", "revalidate"]);
  } finally { closed.mock.restore(); sql.mock.restore(); released.mock.restore(); syncBuiltinESMExports(); await f.dispose(); }
});
for (const lockedSwap of [false, true]) test(`full_note_waits_for_schema3 same position lockedSwap=${lockedSwap}`, async t => {
  const f = await fixture(true); let restore = () => {};
  try {
    const old = await f.coordinator.ensurePublished(f.scope, 0n, 15000), oldManifest = readFileSync(manifestFile), oldBytes = readFileSync(old.databasePath);
    const current = await f.publish(), currentManifest = readFileSync(manifestFile);
    assert.equal(old.manifest.schemaVersion, 2); assert.equal(current.manifest.schemaVersion, 3);
    assert.equal(old.manifest.terminalEventPosition, current.manifest.terminalEventPosition); assert.notEqual(old.manifest.generation, current.manifest.generation);
    writeFileSync(old.databasePath, oldBytes);
    if (!lockedSwap) writeFileSync(manifestFile, oldManifest);
    else { const open = fs.openSync; let swapped = false;
      const hook = t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => { const handle = Reflect.apply(open, fs, args);
        if (!swapped && String(args[0]) === lock && args[1] === "wx") { swapped = true; writeFileSync(manifestFile, oldManifest); } return handle; });
      restore = () => hook.mock.restore(); syncBuiltinESMExports(); }
    const c = controls(f); let waits = 0;
    c.deps.wait = async ms => { assert.equal(ms, 50); assert.equal(existsSync(lock), false); waits++; c.advance(ms); writeFileSync(manifestFile, currentManifest); };
    const result = await executeFullNoteVerifiedRead(f.bootstrap, c.deps);
    assert.equal(waits, 1); assert.equal(result.kind, "success"); if (result.kind === "success") { assert.equal(result.receipt.projectionSchemaVersion, 3); assert.equal(result.content.item!.bodyAvailability, "absent"); }
  } finally { restore(); syncBuiltinESMExports(); await f.dispose(); }
});
test("schema2 alone refuses full note at original budget while ordinary reads accept actual2 and3", async () => {
  const f = await fixture(true); try {
    await f.coordinator.ensurePublished(f.scope, 0n, 15000);
    for (const schema of [2, 3]) {
      if (schema === 3) await f.publish();
      const c = controls(f), old = { ...f.bootstrap, version: 3 as const, request: { ...f.bootstrap.request, operation: "get-canonical-record" as const } };
      const reply = await executeVerifiedRead(old, { ...c.deps, emitStage() {} }); assert.equal(reply.kind, "success");
      if (reply.kind === "success") assert.equal(Object.keys(reply.receipt).length, 11);
      if (schema === 2) refused(await executeFullNoteVerifiedRead({ ...f.bootstrap, remainingMs: 125 }, controls(f).deps), "PROJECTION_LAG");
    }
  } finally { await f.dispose(); }
});
for (const fault of ["unselected-body", "other-table", "sha", "metadata", "source-anchor", "unsupported-profile", "stale", "image-close", "reader-close", "release", "deadline"] as const) test(`full note captured image and closure refuses ${fault}`, async t => {
  const f = await fixture(); const m = (await f.publish()).manifest; let restore = () => {};
  try {
    if (["unselected-body", "other-table", "metadata", "source-anchor"].includes(fault)) {
      const db = new DatabaseSync(m.databaseFile); try {
        if (fault === "unselected-body") { const body = "unselected tamper", hash = createHash("sha256").update("project-memory/governed-note-body/v1\n").update(JSON.stringify({ body, format: "markdown" })).digest("hex");
          db.prepare("UPDATE governed_notes SET body=?, body_content_hash=? WHERE item_id=?").run(body, hash, f.otherId); }
        else if (fault === "other-table") db.prepare("UPDATE canonical_items SET confidence='high' WHERE item_id=?").run(f.otherId);
        else if (fault === "source-anchor") db.prepare("UPDATE projection_metadata SET terminal_event_hash=?").run("f".repeat(64));
        else db.exec("UPDATE projection_metadata SET generation=123");
      } finally { db.close(); }
      // Raw SHA still passes. Unselected table checksum validation must independently refuse.
      writeFileSync(manifestFile, JSON.stringify({ ...m, ...(fault === "source-anchor" ? { terminalEventHash: "f".repeat(64) } : {}), databaseSha256: createHash("sha256").update(readFileSync(m.databaseFile)).digest("hex") }));
    }
    if (fault === "unsupported-profile") writeFileSync(manifestFile, JSON.stringify({ ...m, schemaVersion: 4 }));
    if (fault === "sha") { const bytes = readFileSync(m.databaseFile); bytes[100] = bytes[100]! ^ 1; writeFileSync(m.databaseFile, bytes); }
    let querying = false;
    if (fault === "image-close" || fault === "reader-close") { const close = DatabaseSync.prototype.close;
      const hook = t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) { const memory = this.prepare("PRAGMA database_list").get()!.file === ""; close.call(this);
        if (querying && ((fault === "image-close") === memory)) throw new Error("actual native close fault"); }); restore = () => hook.mock.restore(); }
    const c = controls(f, phase => { if (phase === "query") { querying = true; if (fault === "stale") f.stop();
      if (fault === "release") writeFileSync(lock, "c".repeat(32)); if (fault === "deadline") c.advance(5000); } });
    const result = await executeFullNoteVerifiedRead(f.bootstrap, c.deps);
    refused(result, fault === "metadata" ? "PROJECTION_SCOPE_MISMATCH" : fault === "stale" ? "FRESH_START_CONTENT_UNVERIFIED" : fault === "release" ? "PROJECTION_PATH_INVALID"
      : fault === "deadline" ? "WORKER_TIMEOUT" : fault.endsWith("close") ? "WORKER_UNAVAILABLE" : "INTEGRITY_FAILURE",
      fault.endsWith("close") || fault === "release" ? "incomplete" : "complete");
  } finally { restore(); await f.dispose(); }
});
for (const phase of ["admission", "projection-wait", "capture", "validate", "query", "revalidate"] as const) test(`full note abort at ${phase} closes native resources`, async () => {
  const f = await fixture(); try { await f.publish(); const c = controls(f, current => { if (current === phase) c.controller.abort(); });
    refused(await executeFullNoteVerifiedRead(f.bootstrap, c.deps), "WORKER_CLOSED"); assert.equal(existsSync(lock), false);
  } finally { await f.dispose(); }
});
test("full note abort while waiting for schema3 owns no publication lock", async () => {
  const f = await fixture(true); try { await f.coordinator.ensurePublished(f.scope, 0n, 15000); const c = controls(f);
    c.deps.wait = async () => { assert.equal(existsSync(lock), false); c.controller.abort(); };
    refused(await executeFullNoteVerifiedRead(f.bootstrap, c.deps), "WORKER_CLOSED");
  } finally { await f.dispose(); }
});
