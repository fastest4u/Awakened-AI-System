import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";
import { EventAppendTransaction, SqliteEventAppendStatements } from "../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { governedNotePlannedIds } from "../src/orchestrator/storage/event-append-transaction.js";
import { GovernedNoteRepository, assertStoredGovernedNoteCorrespondence } from "../src/orchestrator/governed-notes/repository.js";
import { validateGovernedNotePair, decodeGovernedNoteDedupRowV1, assertGovernedNoteDedupCorrespondence } from "../src/orchestrator/governed-notes/pair-validation.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { decodeProjectionEvent, decodeProjectionEventV1 } from "../src/orchestrator/projections/source-event-codec.js";
import { openCommittedProjectionEventSnapshot } from "../src/orchestrator/projections/event-reader.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { EventIntegrityService } from "../src/orchestrator/integrity/event-integrity.service.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import type { StoredEvent, JsonValue } from "../src/orchestrator/contracts/event.js";
import type { GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";

type Fixture = GovernedNoteDomainFixtureV1;
function independentCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(",")}]`;
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${independentCanonical(r[k])}`).join(",")}}`;
}
const oracle = (domain: string, value: unknown) => createHash("sha256").update(Buffer.from(domain + "\n" + independentCanonical(value), "utf8")).digest("hex");
function rehash(event: StoredEvent): StoredEvent {
  const { payload: _p, payloadJson: _j, eventHash: _h, lifecycleIntentJson: _l, ...fields } = event;
  return { ...event, eventHash: oracle("project-memory/event/v1", { ...fields, globalPosition: String(event.globalPosition), streamVersion: String(event.streamVersion) }) };
}
function setup(f: Fixture, child = false) {
  const context = child ? f.childContext : f.rootContext;
  const command = f.command({ provenance: (child ? f.sources.child : f.sources.root).map(({ kind, identity }) => ({ kind, identity })) });
  return { ...f.prepareNote(f.prepareCreate(command, context), context), command };
}
function commit(f: Fixture, input = setup(f)) {
  const prepared = input.tx.prepareGovernedNote(input.plan, input.append, input.payload);
  const before = f.rows(), planned = input.tx.planPrepared(prepared);
  assert.deepEqual(f.rows(), before, "planning is inspect-only");
  f.connection.exec("BEGIN IMMEDIATE");
  try {
    const batch = input.tx.appendPlanned(planned); input.tx.insertDedup(prepared, batch, null); f.connection.exec("COMMIT");
    return { ...input, prepared, planned, batch, prior: new GovernedNoteRepository(f.connection).findGovernedNotePrior(input.command.commandId, input.command.idempotencyKey)! };
  } catch (error) { f.connection.exec("ROLLBACK"); throw error; }
}
function snapshot(f: Fixture) { return Object.fromEntries(["events", "command_dedup", "streams", "outbox"].map(table => [table, f.connection.prepare(`SELECT * FROM ${table}`).all()])); }
function corrupt(f: Fixture, fn: () => void) {
  const triggers = f.connection.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  for (const t of triggers) f.connection.exec(`DROP TRIGGER "${String(t.name).replaceAll('"', '""')}"`);
  f.connection.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  try { fn(); } finally { for (const t of triggers) f.connection.exec(String(t.sql)); f.connection.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON"); }
}
function report(f: Fixture, mode: "quick" | "full" | "range", event: StoredEvent) {
  const b = f.rootContext.binding;
  writeFileSync(b.descriptorPath, JSON.stringify({ schemaVersion: 1, projectId: b.projectId, vaultId: b.vaultId, createdAt: f.clock.now() }));
  writeFileSync(b.storeRoute.storeManifestPath, JSON.stringify({ schemaVersion: 1, projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, createdAt: f.clock.now(), lastIntegrity: { status: "never" } }));
  const s = new EventIntegrityService(f.connection);
  return mode === "quick" ? s.quickCheck(f.rootContext) : mode === "full" ? s.fullCheck(f.rootContext) : s.verifyRange(f.rootContext, event.globalPosition, event.globalPosition);
}
const binding = (f: Fixture) => ({ projectId: f.rootContext.binding.projectId, vaultId: f.rootContext.binding.vaultId, storeId: f.rootContext.binding.storeId, workspaceId: f.rootContext.binding.workspaceId, sessionId: null, branchScopeId: null, branchRef: null });
const readSnapshot = (f: Fixture) => openCommittedProjectionEventSnapshot(binding(f), { driver: new NodeSqliteDriver({ DatabaseSync }), eventStorePath: f.retained.path });

for (const child of [false, true]) test(`guarded pair has exact durable layout before first insert (${child ? "child" : "root"})`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const accepted = commit(f, setup(f, child));
  const { events, result, witness: w } = accepted.prior;
  assert.equal(events[1].globalPosition, events[0].globalPosition + 1n);
  assert.deepEqual(events.map(e => e.commandEventIndex), [0, 1]); assert.deepEqual(events.map(e => e.streamVersion), [1n, 2n]);
  assert.equal(result.response.terminalPosition, String(events[1].globalPosition));
  assert.equal(accepted.prior.commandHash, oracle("project-memory/governed-note-command/v1", w));
  assert.equal(w.summaryContentHash, oracle("project-memory/governed-note-summary/v1", accepted.source.item.summary));
  assert.equal(accepted.prior.responseHash, oracle("project-memory/response/v1", result));
  const speculative = f.prepareNote(f.prepareCreate(accepted.command, child ? f.childContext : f.rootContext), child ? f.childContext : f.rootContext);
  assert.notEqual(speculative.ids.recordId, w.recordId);
  assert.equal(new GovernedNoteRepository(f.connection).findGovernedNotePrior(w.commandId, w.idempotencyKey)!.result.response.recordId, w.recordId);
  for (const e of events) {
    assert.equal(e.payloadHash, oracle("project-memory/payload/v1", JSON.parse(e.payloadJson)));
    const { payload: _p, payloadJson: _j, eventHash: _h, lifecycleIntentJson: _l, ...fields } = e;
    assert.equal(e.eventHash, oracle("project-memory/event/v1", { ...fields, globalPosition: String(e.globalPosition), streamVersion: String(e.streamVersion) }));
  }
  const row = f.connection.prepare("SELECT * FROM command_dedup WHERE command_id=$c").get({ $c: w.commandId })!;
  assert.equal(row.outbox_order_json, "[]"); assertGovernedNoteDedupCorrespondence(accepted.prior, decodeGovernedNoteDedupRowV1(row));
  assert.equal(decodeProjectionEvent(events[0]).kind, "unprojected"); assert.equal(decodeProjectionEvent(events[1]).kind, "projected");
  assert.throws(() => decodeProjectionEventV1(events[1]));
  const before = { ...f.provider.calls };
  for (const mode of ["quick", "full", "range"] as const) assert.deepEqual(report(f, mode, events[0]).issues, [], mode);
  assert.deepEqual(f.provider.calls, before);
  const snapshot = readSnapshot(f);
  try {
    const built = await new ImmutableProjectionBuilder({ driver: new NodeSqliteDriver({ DatabaseSync }), projectionDirectory: join(f.retained.root, "note-projections"), now: f.clock.now }).buildV2(snapshot, 1);
    const db = new DatabaseSync(built.temporaryDatabasePath, { readOnly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM canonical_items WHERE status='candidate'").get()!.n, 1); } finally { db.close(); }
  } finally { snapshot.close(); }
});

test("generic prepare replay planning append and dedup refuse reserved family", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const input = setup(f), { tx, plan, append, payload, handle } = input;
  const other = new EventAppendTransaction(f.connection, new SqliteEventAppendStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository());
  const before = snapshot(f);
  assert.throws(() => tx.planGovernedNoteIdentity({ ...handle }, input.command));
  assert.throws(() => other.prepareGovernedNote(plan, append, payload)); assert.throws(() => governedNotePlannedIds({ ...plan }));
  for (const change of [{ commandType: "create-governed-note", streamType: "ordinary", streamId: "ordinary" }, { commandType: "ordinary", streamType: "governed-note", streamId: "ordinary" }, { commandType: "ordinary", streamType: "ordinary", streamId: "governed-note/other" }]) assert.throws(() => tx.prepare({ ...append, ...change }, f.clock.now()));
  assert.throws(() => tx.prepare({ ...append, commandType: "ordinary", streamType: "ordinary", streamId: "ordinary", events: [{ ...append.events[1]!, payload: { item: { verificationMethod: "governed-note-unverified-v1" } } }] }, f.clock.now()));
  const prepared = tx.prepareGovernedNote(plan, append, payload), planned = tx.planPrepared(prepared);
  assert.throws(() => tx.prepareGovernedNote(plan, append, payload)); assert.throws(() => tx.planPrepared({ ...prepared })); assert.throws(() => other.planPrepared(prepared));
  assert.throws(() => tx.appendPlanned({ ...planned })); assert.throws(() => other.appendPlanned(planned)); assert.throws(() => tx.findReplay(prepared, null));
  assert.throws(() => tx.insertDedup(prepared, planned, null));
  tx.discardGovernedNote(prepared); assert.throws(() => tx.appendPlanned(planned)); assert.throws(() => governedNotePlannedIds(plan));
  assert.deepEqual(snapshot(f), before);
  const next = setup(f), ordinary = { ...append, commandId: next.command.commandId, idempotencyKey: next.command.idempotencyKey, commandType: "ordinary", streamType: "ordinary", streamId: "ordinary", events: [{ ...append.events[0]!, eventType: "OpaqueHistoric", payload: {} }], publicResponse: {} };
  const generic = tx.prepare(ordinary, f.clock.now()), accepted = commit(f, next);
  const after = snapshot(f); assert.throws(() => tx.prepare(ordinary, f.clock.now())); assert.throws(() => tx.planPrepared(generic)); assert.throws(() => tx.findReplay(generic, null)); assert.throws(() => tx.findLifecycleReplay({ context: f.rootContext, commandId: accepted.command.commandId, idempotencyKey: accepted.command.idempotencyKey, authoritativeIntentHash: "0".repeat(64), replayExpectation: {} as never })); assert.deepEqual(snapshot(f), after);
});

test("pair validation ignores mutable cache and rejects every malformed pair or result", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const { prior } = commit(f), [a, b] = prior.events;
  assert.deepEqual(validateGovernedNotePair([{ ...a, payload: { ignored: true } }, { ...b, payload: { ignored: true } }], prior.result), prior.witness);
  for (const events of [[], [a], [b, a], [a, b, b], [a, { ...b, globalPosition: b.globalPosition + 1n }], [a, { ...b, commandEventIndex: 0 }], [a, { ...b, streamVersion: 1n }], [a, { ...b, eventId: randomUUID() }], [a, { ...b, branchScopeId: randomUUID() as never }], [a, { ...b, payloadJson: b.payloadJson + " " }], [a, { ...b, lifecycleIntentJson: "{}" }]]) assert.throws(() => validateGovernedNotePair(events, prior.result));
  for (const response of [{ ...prior.result.response, terminalPosition: String(a.globalPosition) }, { ...prior.result.response, recordKind: "adr" as const }, { ...prior.result.response, sourceEventIds: [b.eventId, a.eventId] as [string, string] }, { ...prior.result.response, scope: { ...prior.result.response.scope, sessionId: randomUUID() } }]) assert.throws(() => validateGovernedNotePair(prior.events, { ...prior.result, response }));
  for (const key of ["command_hash", "response_hash", "event_ids_json", "outbox_order_json", "state", "command_type", "response_json", "committed_at", "authorization_approval_id", "internal_claim_token", "workspace_head_commit"]) {
    const row = f.connection.prepare("SELECT * FROM command_dedup WHERE command_id=$c").get({ $c: prior.witness.commandId })!;
    assert.throws(() => assertGovernedNoteDedupCorrespondence(prior, decodeGovernedNoteDedupRowV1({ ...row, [key]: "wrong" })), key);
  }
  const changes: Partial<StoredEvent>[] = [{ eventId: randomUUID() }, { commandId: randomUUID() }, { idempotencyKey: randomUUID() }, { streamId: "governed-note/foreign" }, { streamType: "ordinary" }, { streamVersion: 3n }, { commandEventIndex: 0 }, { eventSchemaVersion: 2 }, { workspaceId: "f".repeat(64) as never }, { branchRef: "foreign" }, { sessionId: randomUUID() }, { parentSessionId: randomUUID() }, { actorRole: "untrusted" }, { clientInstanceId: "foreign" }, { agentId: "foreign" }, { correlationId: randomUUID() }, { causationId: randomUUID() }, { occurredAt: "2026-01-01T00:00:00.000Z" }, { recordedAt: "2026-01-01T00:00:00.000Z" }, { visibilityScope: "project" }, { confidence: "high" }, { verificationStatus: "verified" }, { sourceRefs: [] }, { evidenceRefs: [randomUUID()] }, { evidenceDigests: [{ ciphertextHash: "a".repeat(64), keyedFingerprint: "b".repeat(64) }] }];
  for (const change of changes) assert.throws(() => validateGovernedNotePair([a, rehash({ ...b, ...change })], prior.result), Object.keys(change).join());
  const source = JSON.parse(b.payloadJson);
  for (const item of [{ ...source.item, summary: "changed" }, { ...source.item, status: "verified" }, { ...source.item, verificationMethod: "ordinary" }, { ...source.item, validTo: a.recordedAt }, { ...source.item, anchor: "hidden" }, { ...source.item, normalizedKey: "governed-note/adr/" + prior.witness.recordId }, { ...source.item, itemId: randomUUID() }]) {
    const payload = { ...source, item }, e = rehash({ ...b, payloadJson: canonicalJson(payload), payloadHash: oracle("project-memory/payload/v1", payload) });
    assert.throws(() => validateGovernedNotePair([a, e], prior.result));
  }
});

test("all guarded payload receipt and budget failures precede stream insertion", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const mutations = [(a: ReturnType<typeof setup>["append"]) => ({ ...a, publicResponse: { ...a.publicResponse, recordKind: "adr" as const } }), (a: ReturnType<typeof setup>["append"]) => ({ ...a, events: [a.events[0]!] }), (a: ReturnType<typeof setup>["append"]) => ({ ...a, events: [...a.events, a.events[1]!] }), (a: ReturnType<typeof setup>["append"]) => ({ ...a, events: [{ ...a.events[0]!, evidenceRefs: [randomUUID()] }, a.events[1]!] }), (a: ReturnType<typeof setup>["append"]) => ({ ...a, events: [a.events[0]!, { ...a.events[1]!, payload: { padding: "x".repeat(4194305) } }] }), (a: ReturnType<typeof setup>["append"]) => ({ ...a, outbox: [{ targetKey: "wrong", kind: "wrong", eventIndex: 0, payload: {} }] })];
  for (const mutate of mutations) { const input = setup(f), before = snapshot(f); assert.throws(() => input.tx.prepareGovernedNote(input.plan, mutate(input.append), input.payload)); assert.deepEqual(snapshot(f), before); }
});

for (const mutation of ["missing-note", "missing-source", "missing-dedup", "dedup-only", "predecessor", "source-hash", "note-hash", "source-binding", "dedup-state", "dedup-response", "dedup-auth", "physical-outbox", "foreign-outbox", "foreign-identity"] as const) test(`range and rebuild cannot skip reserved companion: ${mutation}`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const { prior } = commit(f), [note, source] = prior.events;
  corrupt(f, () => {
    const params = { $c: note.commandId };
    if (mutation === "missing-note" || mutation === "missing-source") f.connection.prepare("DELETE FROM events WHERE event_id=$e").run({ $e: mutation === "missing-note" ? note.eventId : source.eventId });
    else if (mutation === "missing-dedup") f.connection.prepare("DELETE FROM command_dedup WHERE command_id=$c").run(params);
    else if (mutation === "dedup-only") f.connection.prepare("DELETE FROM events WHERE command_id=$c").run(params);
    else if (mutation === "predecessor") f.connection.prepare("DELETE FROM events WHERE global_position=$p").run({ $p: note.globalPosition - 1n });
    else if (mutation === "source-hash" || mutation === "note-hash") f.connection.prepare("UPDATE events SET event_hash=$h WHERE event_id=$e").run({ $h: "0".repeat(64), $e: mutation === "note-hash" ? note.eventId : source.eventId });
    else if (mutation === "source-binding") { const changed = rehash({ ...source, workspaceId: "f".repeat(64) as never }); f.connection.prepare("UPDATE events SET workspace_id=$w,event_hash=$h WHERE event_id=$e").run({ $w: changed.workspaceId, $h: changed.eventHash, $e: source.eventId }); }
    else if (mutation === "dedup-state") f.connection.prepare("UPDATE command_dedup SET state='pending' WHERE command_id=$c").run(params);
    else if (mutation === "dedup-response") f.connection.prepare("UPDATE command_dedup SET response_json=response_json || ' ' WHERE command_id=$c").run(params);
    else if (mutation === "dedup-auth") f.connection.prepare("UPDATE command_dedup SET authorization_approval_id=$a WHERE command_id=$c").run({ ...params, $a: randomUUID() });
    else if (mutation === "foreign-identity") f.connection.prepare("UPDATE events SET idempotency_key=$i WHERE event_id=$e").run({ $i: randomUUID(), $e: source.eventId });
    else f.connection.prepare("INSERT INTO outbox(project_id,event_position,target_key,kind,payload_json,content_hash,status,attempt_count,created_at,updated_at) VALUES($p,$pos,'illegal','illegal','{}',$h,'pending',0,$at,$at)").run({ $p: mutation === "foreign-outbox" ? randomUUID() : note.projectId, $pos: source.globalPosition, $h: "0".repeat(64), $at: note.recordedAt });
  });
  const before = snapshot(f), calls = { ...f.provider.calls };
  assert.throws(() => new GovernedNoteRepository(f.connection).findGovernedNotePrior(note.commandId, note.idempotencyKey));
  assert.throws(() => assertStoredGovernedNoteCorrespondence(f.connection, note));
  if (mutation !== "dedup-only") {
    for (const member of [note, source]) if (!(mutation === "missing-note" && member === note || mutation === "missing-source" && member === source)) {
      const checked = report(f, "range", member); assert.equal(checked.ok, false, mutation); assert.ok(checked.issues.some(i => i.code === "EVENT_HASH_MISMATCH" || i.code === "COMMAND_METADATA_MISMATCH"), mutation);
    }
    assert.throws(() => { const s = readSnapshot(f); try { [...s.events()]; } finally { s.close(); } });
    if (mutation === "source-binding") await assert.rejects(async () => { const s = readSnapshot(f); try { await new ImmutableProjectionBuilder({ driver: new NodeSqliteDriver({ DatabaseSync }), projectionDirectory: join(f.retained.root, "corrupt-rebuild"), now: f.clock.now }).buildV2(s, 1); } finally { s.close(); } });
  }
  assert.deepEqual(snapshot(f), before); assert.deepEqual(f.provider.calls, calls);
});

test("absence requires both tables empty and existing unrelated opaque payload remains untouched", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const repository = new GovernedNoteRepository(f.connection);
  assert.equal(repository.findGovernedNotePrior(randomUUID(), randomUUID()), null);
  const ordinary = new EventAppendTransaction(f.connection, new SqliteEventAppendStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository());
  const prepared = ordinary.prepare({ context: f.rootContext, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "ordinary", correlationId: randomUUID(), agentId: "ordinary", streamType: "ordinary", streamId: "opaque-history", expectedStreamVersion: 0n, events: [{ eventType: "OpaqueUnknown", eventSchemaVersion: 99, occurredAt: f.clock.now(), visibilityScope: "project", confidence: "low", verificationStatus: "unverified", sourceRefs: [], evidenceRefs: [], evidenceDigests: [], payload: { nested: { untouched: ["historic", "bytes"] } } }], outbox: [], publicResponse: {} }, f.clock.now());
  f.connection.exec("BEGIN IMMEDIATE");
  try { const batch = ordinary.appendPlanned(ordinary.planPrepared(prepared)); ordinary.insertDedup(prepared, batch, null); f.connection.exec("COMMIT"); } catch (e) { f.connection.exec("ROLLBACK"); throw e; }
  const opaque = f.connection.prepare("SELECT * FROM events WHERE event_type='OpaqueUnknown'").get();
  const { prior } = commit(f); let touches = 0;
  const payload = Object.create(null) as Record<string, unknown>; Object.defineProperty(payload, "secret", { get() { touches++; throw new Error(); }, enumerable: true }); payload.cycle = payload;
  const event = { ...prior.events[0], streamType: "ordinary", streamId: "ordinary", eventType: "OpaqueUnknown", payloadJson: "opaque", payload } as StoredEvent;
  assert.equal(decodeProjectionEvent(event).kind, "unprojected"); assert.equal(touches, 0);
  const s = readSnapshot(f); try { const all = [...s.events()]; assert.equal(all.filter(e => e.eventType === "OpaqueUnknown").length, 1); } finally { s.close(); }
  assert.deepEqual(f.connection.prepare("SELECT * FROM events WHERE event_type='OpaqueUnknown'").get(), opaque);
  assert.throws(() => repository.findGovernedNotePrior(prior.witness.commandId, randomUUID()), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => repository.findGovernedNotePrior(randomUUID(), prior.witness.idempotencyKey), { code: "IDEMPOTENCY_CONFLICT" });
  const second = commit(f).prior;
  assert.throws(() => repository.findGovernedNotePrior(prior.witness.commandId, second.witness.idempotencyKey), { code: "IDEMPOTENCY_CONFLICT" });
});

for (const damaged of [false, true]) test(`lifecycle replay authenticates committed note companions: corrupt=${damaged}`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const accepted = commit(f);
  const { checkpointId: _i, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e, createdAt: _at, creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = checkpointFixture();
  await f.retained.lifecycle.checkpoint(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor, draft as unknown as JsonValue);
  if (damaged) corrupt(f, () => { f.connection.prepare("UPDATE events SET payload_hash=$h WHERE event_id=$e").run({ $h: "0".repeat(64), $e: accepted.ids.sourceEventId }); });
  const incoming = { ...f.rootContext, binding: { ...f.rootContext.binding, clientInstanceId: "governed-note-new-owner" } }; incoming.binding.contextFingerprint = computeProjectContextFingerprint(incoming.binding);
  const issues: unknown[] = [];
  const replay = new LifecycleIntegrityService(f.connection).fullCheckAsync(f.rootContext, { add: (...args: unknown[]) => { issues.push(args); } });
  if (damaged) await assert.rejects(replay, { code: "INTEGRITY_FAILURE" });
  else { await replay; assert.deepEqual(issues, []); const resumed = await f.retained.lifecycle.resumeAfterExpiry(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor, incoming); assert.ok(resumed.authorityMaterial.descriptor); }
});

test("generic prepare refuses reserved governed note family before mutation", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const tx = new EventAppendTransaction(f.connection, new SqliteEventAppendStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository());
    const before = f.rows();
    assert.throws(() => tx.prepare({ context: f.rootContext, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "create-governed-note", correlationId: randomUUID(), agentId: "governed-note", streamId: "governed-note/reserved", streamType: "governed-note", expectedStreamVersion: 0n, events: [{ eventType: "GovernedNoteCreated", eventSchemaVersion: 1, occurredAt: f.clock.now(), visibilityScope: "session", sessionId: f.retained.rootAuthority.sessionId, confidence: "low", verificationStatus: "unverified", sourceRefs: [], evidenceRefs: [], evidenceDigests: [], payload: {} }], outbox: [], publicResponse: {} }, f.clock.now()));
    assert.deepEqual(f.rows(), before);
  } finally { await f.cleanup(); }
});
