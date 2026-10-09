import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { makeGovernedNoteDomainFixture, type GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import type { GovernedNoteService } from "../src/orchestrator/governed-notes/service.js";
import type { PreparedGovernedNoteCreateV2, PreparedGovernedNoteRecoveryV2, GovernedNoteStoredReceiptV2, GovernedNoteRecoveryResultV2, GovernedNoteCommandV2 } from "../src/orchestrator/governed-notes/contracts.js";
import type { AppendResult, AppendCommand, JsonValue, StoredEvent } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { decodeGovernedNoteSourcePayloadV2, decodeGovernedNoteCreatedPayloadV2 } from "../src/orchestrator/governed-notes/codec.js";
import { EventStore, SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { EventAppendTransaction, SqliteEventAppendStatements, governedNotePlannedIds, EventStoreError } from "../src/orchestrator/storage/event-append-transaction.js";
import { GovernedNoteRepository, assertStoredGovernedNoteCorrespondenceAny } from "../src/orchestrator/governed-notes/repository.js";
import { validateGovernedNotePairV2, assertGovernedNoteMember, type GovernedNotePriorV2 } from "../src/orchestrator/governed-notes/pair-validation.js";
import { GovernedNoteProvenanceRepository } from "../src/orchestrator/governed-notes/provenance.repository.js";
import { buildGovernedNoteOriginalCommitmentV2, governedNoteSummaryHash } from "../src/orchestrator/governed-notes/intent.js";
import { governedNoteBodyHash } from "../src/orchestrator/governed-notes/body-content.js";
import { redactGovernedNoteContentV2 } from "../src/orchestrator/privacy/redaction.js";

// Compile-safe missing-API probe: the baseline must fail an assertion, not tsc.
function v2(service: GovernedNoteService) {
  const candidate = service as GovernedNoteService & {
    createV2(input: PreparedGovernedNoteCreateV2, context: ProjectContext): AppendResult<GovernedNoteStoredReceiptV2>;
    recoverV2(input: PreparedGovernedNoteRecoveryV2, context: ProjectContext): GovernedNoteRecoveryResultV2;
  };
  assert.equal(typeof candidate.createV2, "function", "V2 creation must own the authenticated transaction");
  assert.equal(typeof candidate.recoverV2, "function", "V2 recovery must authenticate either stored receipt");
  return candidate;
}
const expiry = (f: GovernedNoteDomainFixtureV1) => new Date(Number(f.clock.nowMs() + 60000n)).toISOString();
function corrupt(f: GovernedNoteDomainFixtureV1, change: () => void) {
  const triggers = f.connection.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  for (const row of triggers) f.connection.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
  f.connection.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  try { change(); } finally { for (const row of triggers) f.connection.exec(String(row.sql)); f.connection.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON"); }
}
function preparedPair(f: GovernedNoteDomainFixtureV1, command: GovernedNoteCommandV2 = f.commandV2()) {
  const context = f.rootContext, handle = f.verifier.verifyCreateV2(f.prepareCreateV2(command), context);
  const authority = f.verifier.revalidateCreate(handle), binding = f.verifier.bindingForCreate(handle);
  const tx = new EventAppendTransaction(f.connection, new SqliteEventAppendStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository());
  const plan = tx.planGovernedNoteIdentityV2(handle, command), ids = governedNotePlannedIds(plan);
  const provenance = new GovernedNoteProvenanceRepository().validate(f.connection, command.provenance, authority, binding, f.provider);
  const redacted = redactGovernedNoteContentV2(command.summary, command.content.body, f.policy);
  const content = { format: "markdown" as const, body: redacted.body }, key = f.provider.currentKey({ projectId: authority.projectId, storeId: authority.storeId }, "original-input-commitment");
  const payload = decodeGovernedNoteCreatedPayloadV2({ formatVersion: 2, witness: { witnessVersion: 2, commandType: "create-governed-note", commandId: command.commandId, idempotencyKey: command.idempotencyKey, ...ids,
    recordKind: command.recordKind, confidence: command.confidence, authority, binding, provenance, policyId: redacted.policyId, policyVersion: redacted.policyVersion,
    originalCommitmentKeyRef: key, originalInputCommitment: buildGovernedNoteOriginalCommitmentV2(command, authority, binding, key, f.provider), summaryContentHash: governedNoteSummaryHash(redacted.summary),
    contentFormat: "markdown", bodyContentHash: governedNoteBodyHash(content), recordedAt: f.clock.now() } });
  const source = { sourceVersion: 3, binding: { ...binding }, item: { itemId: ids.recordId, normalizedKey: `governed-note/${command.recordKind}/${ids.recordId}`, status: "candidate", confidence: command.confidence,
    verificationMethod: "governed-note-unverified-v2", validFrom: f.clock.now(), validTo: null, summary: redacted.summary, contentHash: payload.witness.summaryContentHash,
    conflictGroupId: null, supersedingItemId: null, anchor: null, recordKind: command.recordKind, content: { ...content, contentHash: payload.witness.bodyContentHash } }, followUps: [], artifacts: [], entities: [], aliases: [], edges: [] };
  const header = { occurredAt: f.clock.now(), visibilityScope: "session" as const, sessionId: authority.targetSessionId, parentSessionId: authority.parentSessionId ?? undefined,
    confidence: command.confidence, verificationStatus: "unverified" as const, sourceRefs: [...new Set(provenance.map(p => p.sourceEventId))].sort(), evidenceRefs: [], evidenceDigests: [] };
  const append: AppendCommand<GovernedNoteStoredReceiptV2> = { context, commandId: command.commandId, idempotencyKey: command.idempotencyKey, commandType: "create-governed-note", correlationId: command.commandId, agentId: "governed-note",
    streamId: `governed-note/${authority.targetSessionId}/${ids.recordId}`, streamType: "governed-note", expectedStreamVersion: 0n,
    events: [{ ...header, eventType: "GovernedNoteCreated", eventSchemaVersion: 2, payload: payload as unknown as JsonValue }, { ...header, eventType: "MemorySourceRecorded", eventSchemaVersion: 4, payload: source }], outbox: [],
    publicResponse: { resultVersion: 2, operation: "create-governed-note", commandId: command.commandId, idempotencyKey: command.idempotencyKey, recordId: ids.recordId, recordKind: command.recordKind, status: "candidate", verificationStatus: "unverified",
      scope: { ...binding }, sourceEventIds: [ids.noteEventId, ids.sourceEventId], terminalPosition: "1", content: { format: "markdown", contentHash: payload.witness.bodyContentHash } } };
  return { tx, plan, handle, append, payload, source, command };
}
function independentCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(",")}]`;
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${independentCanonical(r[k])}`).join(",")}}`;
}
const oracle = (domain: string, value: unknown) => createHash("sha256").update(domain + "\n" + independentCanonical(value), "utf8").digest("hex");
function reseal(event: StoredEvent, payload: unknown = JSON.parse(event.payloadJson)): StoredEvent {
  const changed = { ...event, payloadJson: independentCanonical(payload), payloadHash: oracle("project-memory/payload/v1", payload) };
  const { payload: _cache, payloadJson: _json, eventHash: _hash, lifecycleIntentJson: _intent, ...fields } = changed;
  return { ...changed, eventHash: oracle("project-memory/event/v1", { ...fields, globalPosition: String(event.globalPosition), streamVersion: String(event.streamVersion) }) };
}

test("four_kinds_create_exact_inline_pair", async t => {
  let policyReads = 0;
  const f = await makeGovernedNoteDomainFixture({ policy: () => { policyReads++; return f.policy; } }); t.after(f.cleanup);
  const body = '# ไทย 😀\r\n\t```text\n e\u0301  \n```\n';
  for (const recordKind of ["session-log", "insight", "mistake", "adr"] as const) {
    const before = f.rows(), reads = policyReads, command = f.commandV2({ recordKind, content: { format: "markdown", body } });
    const result = v2(f.service()).createV2(f.prepareCreateV2(command), f.rootContext);
    assert.equal(policyReads, reads + 1); assert.equal(f.rows().events, before.events + 2);
    assert.equal(f.rows().dedup, before.dedup + 1); assert.equal(f.rows().outbox, before.outbox);
    assert.equal(result.response.resultVersion, 2); assert.equal("body" in result.response.content, false);
    const rows = f.connection.prepare("SELECT * FROM events WHERE command_id=$c ORDER BY global_position").all({ $c: command.commandId });
    assert.equal(rows[0]!.event_schema_version, 2n); assert.equal(rows[1]!.event_schema_version, 4n);
    assert.equal(rows[1]!.global_position, (rows[0]!.global_position as bigint) + 1n);
    const source = decodeGovernedNoteSourcePayloadV2(JSON.parse(String(rows[1]!.payload_json)));
    assert.equal(source.item.content.body, body); assert.equal(source.item.recordKind, recordKind);
    assert.equal(source.item.summary, "Raw é summary"); assert.equal(source.item.content.contentHash, result.response.content.contentHash);
  }
});

test("v2_replay_and_cross_version_conflict", async t => {
  let refuse = false;
  const f = await makeGovernedNoteDomainFixture({ policy: () => { assert.equal(refuse, false); return f.policy; } }); t.after(f.cleanup);
  const command = f.commandV2({ content: { format: "markdown", body: "fixture_first" } });
  const service = v2(f.service()), first = service.createV2(f.prepareCreateV2(command), f.rootContext), before = f.rowContents();
  refuse = true; f.provider.rotate("original-input-commitment"); f.provider.setStatus("original-input-commitment", "unavailable"); f.provider.setStatus("data-key-wrap", "revoked");
  const replay = service.createV2(f.prepareCreateV2(command), f.rootContext);
  assert.equal(replay.deduplicated, true); assert.deepEqual(replay, { ...first, deduplicated: true }); assert.notEqual(replay.response, first.response);
  for (const changed of [{ ...command, content: { format: "markdown" as const, body: "fixture_second" } }, { ...command, commandId: randomUUID() }])
    assert.throws(() => service.createV2(f.prepareCreateV2(changed), f.rootContext), { code: "IDEMPOTENCY_CONFLICT" });
  const { content: _body, ...legacy } = command;
  assert.throws(() => service.create(f.prepareCreate({ ...legacy, version: 1 }), f.rootContext), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(f.rowContents(), before);
});

test("v2_recovery_authenticates_both_receipts", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const service = v2(f.service());
  const modern = f.commandV2(), legacy = f.command(); service.createV2(f.prepareCreateV2(modern), f.rootContext); service.create(f.prepareCreate(legacy), f.rootContext);
  f.provider.setStatus("data-key-wrap", "revoked"); f.provider.setStatus("original-input-commitment", "unavailable");
  for (const [command, version] of [[modern, 2], [legacy, 1]] as const) {
    const result = service.recoverV2(f.prepareRecoveryV2(command, expiry(f)), f.rootContext);
    assert.equal(result.resultVersion, 2); assert.equal(result.outcome, "committed");
    if (result.outcome === "committed") { assert.equal(result.receipt.resultVersion, version); assert.equal(result.receipt.replay, true); }
  }
  assert.throws(() => service.createV2(f.prepareCreateV2({ ...modern, commandId: legacy.commandId, idempotencyKey: legacy.idempotencyKey }), f.rootContext), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => service.recover(f.prepareRecovery(modern, expiry(f)), f.rootContext), { code: "GOVERNED_NOTE_FORMAT_UNSUPPORTED", message: "GOVERNED_NOTE_FORMAT_UNSUPPORTED", details: {} });
  corrupt(f, () => { f.connection.prepare("UPDATE command_dedup SET response_hash=$hash WHERE command_id=$c").run({ $hash: "0".repeat(64), $c: modern.commandId }); });
  assert.throws(() => service.recover(f.prepareRecovery(modern, expiry(f)), f.rootContext), { code: "INTEGRITY_FAILURE" });
  assert.throws(() => service.createV2(f.prepareCreateV2({ ...modern, idempotencyKey: randomUUID() }), f.rootContext), { code: "INTEGRITY_FAILURE" });
});

test("reserved_v2_cannot_escape_generic_append", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { tx, append } = f.prepareNote(f.prepareCreate(f.command()));
  const store = new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(), f.clock.now);
  for (const normalizedKey of [undefined, 12, "ordinary", "governed-note/forged"]) {
    const forged = { ...append, commandType: "ordinary", streamType: "ordinary", streamId: "ordinary", events: [{ ...append.events[1]!, eventSchemaVersion: 4, payload: { sourceVersion: 3, item: { verificationMethod: "governed-note-unverified-v2", ...(normalizedKey === undefined ? {} : { normalizedKey }) } } }] };
    const before = f.rowContents();
    assert.throws(() => tx.prepare(forged, f.clock.now()), { code: "COMMAND_INVALID" });
    assert.throws(() => store.append(forged), { code: "COMMAND_INVALID" }); assert.equal(f.rowContents(), before);
  }
});

test("precommit_packing_is_atomic", async t => {
  let fail = false;
  const f = await makeGovernedNoteDomainFixture({ policy: () => { if (fail) throw new Error("private-policy-body"); return f.policy; } }); t.after(f.cleanup);
  const service = v2(f.service());
  const body = '\\"'.repeat(32768), command = f.commandV2({ content: { format: "markdown", body } });
  const result = service.createV2(f.prepareCreateV2(command), f.rootContext); assert.equal(result.response.resultVersion, 2);
  const row = f.connection.prepare("SELECT payload_json FROM events WHERE event_id=$id").get({ $id: result.eventIds[1]! })!;
  const stored = decodeGovernedNoteSourcePayloadV2(JSON.parse(String(row.payload_json)));
  assert.equal(stored.item.content.body, body); assert.equal(Buffer.byteLength(JSON.stringify(stored.item.content.body), "utf8"), 131074);
  assert.ok(Buffer.byteLength(String(row.payload_json), "utf8") <= 262144);
  fail = true; const before = f.rowContents();
  assert.throws(() => service.createV2(f.prepareCreateV2(f.commandV2()), f.rootContext), { code: "GOVERNED_NOTE_POLICY_UNAVAILABLE" });
  assert.equal(f.rowContents(), before);
  const pair = preparedPair(f), stable = f.rowContents();
  for (const body of ["x".repeat(65537), "\t".repeat(65536) + "x"]) {
    // Keep all three hash bindings consistent so a stale hash cannot mask a
    // missing body/encoded-envelope limit at the guarded transaction seam.
    const contentHash = oracle("project-memory/governed-note-body/v1", { format: "markdown", body });
    const source = { ...pair.source, item: { ...pair.source.item, content: { ...pair.source.item.content, body, contentHash } } };
    const payload = { ...pair.payload, witness: { ...pair.payload.witness, bodyContentHash: contentHash } };
    const append = { ...pair.append, publicResponse: { ...pair.append.publicResponse, content: { format: "markdown" as const, contentHash } },
      events: [{ ...pair.append.events[0]!, payload: payload as unknown as JsonValue }, { ...pair.append.events[1]!, payload: source }] };
    assert.throws(() => pair.tx.prepareGovernedNoteV2(pair.plan, append, payload)); assert.equal(f.rowContents(), stable);
  }
  // Failure while detaching the response is still inside the mutation transaction.
  fail = false; const detach = EventAppendTransaction.prototype.result;
  EventAppendTransaction.prototype.result = () => { throw new EventStoreError("COMMAND_TOO_LARGE"); };
  try { assert.throws(() => service.createV2(f.prepareCreateV2(f.commandV2()), f.rootContext), { code: "GOVERNED_NOTE_UNAVAILABLE" }); }
  finally { EventAppendTransaction.prototype.result = detach; }
  assert.equal(f.rowContents(), stable);
});

test("v2_rollback_failure_is_absorbing", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const service = v2(f.service()), command = f.commandV2();
  service.createV2(f.prepareCreateV2(command), f.rootContext);
  const ordinary = f.prepareNote(f.prepareCreate(f.command())).append, before = f.rowContents();
  const exec = f.connection.exec.bind(f.connection); let attempts = 0;
  f.connection.exec = sql => { if (sql === "ROLLBACK") { attempts++; throw new Error("private-rollback"); } exec(sql); };
  try { assert.throws(() => service.createV2(f.prepareCreateV2(command), f.rootContext), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } }); assert.equal(attempts, 1); }
  finally { f.connection.exec = exec; exec("ROLLBACK"); }
  assert.throws(() => v2(f.service()).createV2(f.prepareCreateV2(command), f.rootContext), { code: "GOVERNED_NOTE_UNAVAILABLE" });
  const store = new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(), f.clock.now);
  assert.throws(() => store.append({ ...ordinary, commandType: "ordinary", streamType: "ordinary", streamId: "ordinary", events: [{ ...ordinary.events[0]!, eventType: "OpaqueHistoric", payload: {} }], publicResponse: {} }), { code: "GOVERNED_NOTE_UNAVAILABLE", details: {} });
  assert.equal(f.rowContents(), before);
});

test("raw_body_never_persists", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const command = f.commandV2({ summary: "fixture_first summary", content: { format: "markdown", body: "# fixture_second body" } });
  const result = v2(f.service()).createV2(f.prepareCreateV2(command), f.rootContext);
  assert.equal(f.rowContents().includes("fixture_second"), false); assert.equal(f.rowContents().includes("fixture_first"), false);
  assert.equal(JSON.stringify(result.response).includes("body"), false);
  assert.throws(() => v2(f.service()).createV2(f.prepareCreateV2(f.commandV2({ provenance: [{ kind: "source-event", identity: result.eventIds[1]! }] })), f.rootContext), { code: "GOVERNED_NOTE_PROVENANCE_INELIGIBLE" });
});

test("v2_pair_rejects_independently_rehashed_semantic_tampering", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const command = f.commandV2();
  v2(f.service()).createV2(f.prepareCreateV2(command), f.rootContext);
  const prior = new GovernedNoteRepository(f.connection).findGovernedNotePriorAny(command.commandId, command.idempotencyKey) as GovernedNotePriorV2;
  const [note, source] = prior.events, payload = JSON.parse(source.payloadJson) as ReturnType<typeof decodeGovernedNoteSourcePayloadV2>;
  assert.equal(prior.commandHash, oracle("project-memory/governed-note-command/v2", prior.witness));
  assert.equal(payload.item.content.contentHash, oracle("project-memory/governed-note-body/v1", { format: "markdown", body: command.content.body }));
  assertStoredGovernedNoteCorrespondenceAny(f.connection, source); assertGovernedNoteMember(note); assertGovernedNoteMember(source);
  const mutations: Record<string, StoredEvent> = {
    kind: reseal(source, { ...payload, item: { ...payload.item, recordKind: "adr", normalizedKey: `governed-note/adr/${payload.item.itemId}` } }),
    format: reseal(source, { ...payload, item: { ...payload.item, content: { ...payload.item.content, format: "text" } } }),
    body: reseal(source, { ...payload, item: { ...payload.item, content: { ...payload.item.content, body: "changed", contentHash: oracle("project-memory/governed-note-body/v1", { format: "markdown", body: "changed" }) } } }),
    bodyHash: reseal(source, { ...payload, item: { ...payload.item, content: { ...payload.item.content, contentHash: "f".repeat(64) } } }),
    summary: reseal(source, { ...payload, item: { ...payload.item, summary: "changed", contentHash: oracle("project-memory/governed-note-summary/v1", "changed") } }),
    version: reseal({ ...source, eventSchemaVersion: 3 }),
    header: reseal({ ...source, agentId: "ordinary" }),
    position: reseal({ ...source, globalPosition: source.globalPosition + 1n }),
  };
  for (const [name, changed] of Object.entries(mutations)) assert.throws(() => validateGovernedNotePairV2([note, changed], prior.result), { code: "INTEGRITY_FAILURE" }, name);
  for (const receipt of [{ ...prior.result.response, content: { format: "markdown" as const, contentHash: "f".repeat(64) } }, { ...prior.result.response, recordKind: "adr" as const }])
    assert.throws(() => validateGovernedNotePairV2(prior.events, { ...prior.result, response: receipt }), { code: "INTEGRITY_FAILURE" });
  const changedWitness = { ...prior.witness, bodyContentHash: "f".repeat(64) }, changedNote = reseal(note, { formatVersion: 2, witness: changedWitness });
  assert.throws(() => validateGovernedNotePairV2([changedNote, reseal({ ...source, previousGlobalHash: changedNote.eventHash })], prior.result), { code: "INTEGRITY_FAILURE" });
});

test("v2_owned_plan_preparation_append_dedup_and_discard_cannot_be_forged", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const p = preparedPair(f), other = preparedPair(f).tx, before = f.rowContents();
  assert.throws(() => p.tx.planGovernedNoteIdentityV2({ ...p.handle }, p.command));
  assert.throws(() => other.prepareGovernedNoteV2(p.plan, p.append, p.payload));
  assert.throws(() => p.tx.prepareGovernedNote(p.plan, p.append as never, p.payload as never));
  const prepared = p.tx.prepareGovernedNoteV2(p.plan, p.append, p.payload), planned = p.tx.planPrepared(prepared);
  assert.equal(f.rowContents(), before, "planning must not insert stream/branch rows");
  assert.throws(() => p.tx.prepareGovernedNoteV2(p.plan, p.append, p.payload));
  assert.throws(() => other.planPrepared(prepared)); assert.throws(() => p.tx.planPrepared({ ...prepared }));
  assert.throws(() => other.appendPlanned(planned)); assert.throws(() => p.tx.appendPlanned({ ...planned }));
  assert.throws(() => p.tx.findReplay(prepared, null)); assert.throws(() => p.tx.insertDedup(prepared, planned, null));
  p.tx.discardGovernedNote(prepared); assert.throws(() => p.tx.appendPlanned(planned)); assert.throws(() => governedNotePlannedIds(p.plan));
  assert.equal(f.rowContents(), before);
});

test("v2_reserved_markers_prefixes_versions_and_accessors_are_independent", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const { tx, append } = f.prepareNote(f.prepareCreate(f.command()));
  let reads = 0;
  const accessor = { item: { get verificationMethod() { reads++; return "governed-note-unverified-v2"; } } };
  for (const payload of [{ item: { normalizedKey: "governed-note/forged" } }, { sourceVersion: 3 }, { sourceVersion: 5 }, { item: { verificationMethod: "governed-note-unverified-v2" } }, accessor, new Proxy({}, { get() { reads++; return undefined; } })]) {
    const before = f.rowContents();
    assert.throws(() => tx.prepare({ ...append, commandType: "ordinary", streamId: "ordinary", streamType: "ordinary", events: [{ ...append.events[1]!, eventSchemaVersion: 2, payload }] }, f.clock.now()), { code: "COMMAND_INVALID" });
    assert.equal(f.rowContents(), before); assert.equal(reads, 0);
  }
});

test("v2_cannot_replay_through_generic_transaction_after_late_commit", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const p = preparedPair(f);
  const ordinary = { ...p.append, commandType: "ordinary", streamType: "ordinary", streamId: "ordinary", events: [{ ...p.append.events[0]!, eventType: "OpaqueHistoric", payload: {} }], publicResponse: {} };
  const prepared = p.tx.prepare(ordinary, f.clock.now());
  v2(f.service()).createV2(f.prepareCreateV2(p.command), f.rootContext); const before = f.rowContents();
  assert.throws(() => p.tx.findReplay(prepared, null), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => p.tx.planPrepared(prepared), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => p.tx.prepare(ordinary, f.clock.now()), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(f.rowContents(), before);
});

for (const point of ["before-begin", "after-note-event", "after-source-event", "after-dedup", "before-commit", "after-commit-before-response"] as const) test(`v2_atomic_fault_${point}`, async t => {
  let observed = -1, expected = 0;
  const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) { if (p === point) { observed = f.rows().events - expected; throw new Error("raw_fixture_fault_body"); } } } }); t.after(f.cleanup);
  const service = v2(f.service()), command = f.commandV2(), before = f.rowContents(), rows = f.rows(); expected = rows.events;
  assert.throws(() => service.createV2(f.prepareCreateV2(command), f.rootContext), point === "after-commit-before-response"
    ? { code: "COMMAND_OUTCOME_UNKNOWN", message: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } }
    : { code: "GOVERNED_NOTE_UNAVAILABLE", message: "GOVERNED_NOTE_UNAVAILABLE", details: {} });
  assert.equal(observed, point === "before-begin" ? 0 : point === "after-note-event" ? 1 : 2);
  if (point === "after-commit-before-response") {
    assert.equal(f.rows().events, rows.events + 2); assert.equal(f.rows().dedup, rows.dedup + 1);
    const result = service.recoverV2(f.prepareRecoveryV2(command, expiry(f)), f.rootContext); assert.equal(result.outcome, "committed");
    if (result.outcome === "committed") assert.equal(result.receipt.commandId, command.commandId);
  } else assert.equal(f.rowContents(), before);
  assert.equal(f.rowContents().includes("raw_fixture_fault_body"), false);
});

for (const after of [false, true]) test(`v2_commit_ambiguity_${after ? "after" : "before"}_commit`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const command = f.commandV2(), service = v2(f.service()), before = f.rowContents(), exec = f.connection.exec.bind(f.connection);
  f.connection.exec = sql => { if (sql === "COMMIT" && !after) throw new Error("private-before-commit"); exec(sql); if (sql === "COMMIT" && after) throw new Error("private-after-commit"); };
  try { assert.throws(() => service.createV2(f.prepareCreateV2(command), f.rootContext), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } }); }
  finally { f.connection.exec = exec; }
  if (!after) assert.equal(f.rowContents(), before);
  // After COMMIT the cleanup rollback fails: the actual connection stays poisoned.
  if (after) assert.throws(() => v2(f.service()).recoverV2(f.prepareRecoveryV2(command, expiry(f)), f.rootContext), { code: "GOVERNED_NOTE_UNAVAILABLE" });
});

test("v2_direct_child_authority_and_failed_proof_are_atomic", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const service = v2(f.service());
  const child = f.commandV2({ provenance: f.sources.child.map(({ kind, identity }) => ({ kind, identity })) });
  const result = service.createV2(f.prepareCreateV2(child, f.childContext), f.childContext); assert.equal(result.response.scope.sessionId, f.retained.childAuthority.sessionId);
  const next = f.prepareCreateV2(f.commandV2()), before = f.rowContents();
  assert.throws(() => service.createV2({ ...next, command: { ...next.command, content: { format: "markdown", body: "proof no longer matches" } } }, f.rootContext), { code: "SESSION_CAPABILITY_INVALID" });
  assert.equal(f.rowContents(), before);
});

test("v2_recovery_rollback_poison_survives_new_service_and_later_cleanup", async t => {
  let armed = false;
  const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) { if (armed && p === "recovery-before-final-verify") throw new Error("private-recovery-fault"); } } }); t.after(f.cleanup);
  const command = f.commandV2(), service = v2(f.service()); service.createV2(f.prepareCreateV2(command), f.rootContext); armed = true;
  const before = f.rowContents(), exec = f.connection.exec.bind(f.connection); let rollbacks = 0;
  f.connection.exec = sql => { if (sql === "ROLLBACK") { rollbacks++; throw new Error("private-cleanup"); } exec(sql); };
  try { assert.throws(() => service.recoverV2(f.prepareRecoveryV2(command, expiry(f)), f.rootContext), { code: "GOVERNED_NOTE_UNAVAILABLE" }); assert.equal(rollbacks, 1); }
  finally { f.connection.exec = exec; exec("ROLLBACK"); }
  armed = false;
  assert.throws(() => v2(f.service()).recoverV2(f.prepareRecoveryV2(command, expiry(f)), f.rootContext), { code: "GOVERNED_NOTE_UNAVAILABLE" });
  assert.throws(() => v2(f.service()).createV2(f.prepareCreateV2(f.commandV2()), f.rootContext), { code: "GOVERNED_NOTE_UNAVAILABLE" });
  assert.equal(f.rowContents(), before);
});
