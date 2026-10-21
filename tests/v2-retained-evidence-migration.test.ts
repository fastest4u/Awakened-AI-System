import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION, PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { freshStore, FRESH_NOW } from "./support/fresh-start-fixture.js";

function schemaEight() {
  const root = mkdtempSync(join(tmpdir(), "retained-upgrade-")), connection = new NodeSqliteDriver({ DatabaseSync }).open(join(root, "events.sqlite"), { mode: "create", busyTimeoutMs: 1000 });
  const context = { binding: FRESH_IDENTITY } as ProjectContext;
  new MigrationRunner().apply(connection, PROJECT_STORE_MIGRATIONS.slice(0, 8), FRESH_NOW, { kind: "bootstrap-empty", beforeMigration(c, migration) {
    if (migration.version === 3) {
      c.prepare("INSERT INTO project_meta VALUES(1,$p,$v,$s,2,$at)").run({ $p: FRESH_IDENTITY.projectId, $v: FRESH_IDENTITY.vaultId, $s: FRESH_IDENTITY.storeId, $at: FRESH_NOW });
      c.exec("INSERT INTO maintenance_state VALUES(1,0,'idle',NULL,0,NULL,NULL)");
      new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(c, context);
    }
    if (migration.version === 4) new SqliteSessionEndEffectiveStateMigrationPreflight().assertEligible(c, context);
  } });
  return { connection, cleanup() { connection.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("a genuine schema-8 prefix upgrades only migration 9 preserving nonempty historical event bytes and checksums", async () => {
  const source = await makeRetainedEvidenceFixture(), old = schemaEight();
  try {
    const template = prepare(source).event;
    const event = { ...template, globalPosition: 1n, streamVersion: 1n, streamId: "old-empty-evidence", streamType: "test", eventType: "OneRecorded",
      visibilityScope: "project", sessionId: null, parentSessionId: null, payload: { one: 1 }, payloadJson: '{"one":1}', payloadHash: payloadHash({ one: 1 }),
      evidenceRefs: [], evidenceDigests: [], previousGlobalHash: "0".repeat(64), eventHash: "" } as StoredEvent;
    const { payload: _payload, payloadJson: _json, eventHash: _hash, ...envelope } = event;
    const final = { ...event, eventHash: eventHash({ ...envelope, globalPosition: "1", streamVersion: "1" }) };
    old.connection.prepare("INSERT INTO streams VALUES($p,'old-empty-evidence','test',0,$at,$at)").run({ $p: FRESH_IDENTITY.projectId, $at: FRESH_NOW });
    seedEvent(old.connection, final);
    const checksums = old.connection.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const events = old.connection.prepare("SELECT * FROM events ORDER BY global_position").all();
    assert.equal(old.connection.prepare("SELECT schema_version FROM project_meta").get()!.schema_version, 8n);
    assert.deepEqual(new MigrationRunner().apply(old.connection, PROJECT_STORE_MIGRATIONS, FRESH_NOW, { kind: "explicit-upgrade", expectedAppliedVersion: 8, beforeMigration: () => undefined }), [9]);
    assert.equal(old.connection.prepare("SELECT schema_version FROM project_meta").get()!.schema_version, 9n);
    assert.deepEqual(old.connection.prepare("SELECT * FROM schema_migrations WHERE version <= 8 ORDER BY version").all(), checksums);
    assert.deepEqual(old.connection.prepare("SELECT * FROM events ORDER BY global_position").all(), events);
    assert.equal(old.connection.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { old.cleanup(); source.cleanup(); }
});
function blobRow(bundle: RetainedEvidenceCommitV1): Record<string, string | bigint | number> {
  const i = bundle.items[0]!, b = i.binding, e = bundle.event;
  return { project_id: b.projectId, vault_id: b.vaultId, store_id: b.storeId, evidence_id: b.evidenceId, event_id: b.eventId, event_position: e.globalPosition, command_id: e.commandId,
    idempotency_key: e.idempotencyKey, item_index: 0, target_session_id: b.targetSessionId, conversation_id: b.conversationId, frame_id: b.frameId, ordinal: BigInt(i.frame.ordinal), encrypted_item_json: canonicalJson(i) };
}
function insertRow(connection: SqliteConnection, table: string, row: Record<string, string | bigint | number>, replace = false): void {
  connection.prepare(`INSERT ${replace ? "OR REPLACE " : ""}INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(key => `$${key}`).join(",")})`)
    .run(Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value])) as SqliteParams);
}
// Each invalid probe starts from a valid row in a fresh caller transaction: no collision can mask its CHECK boundary.
test("SQL required encrypted JSON scalars are NULL-total and foreign event scope refuses specifically", async () => {
  const f = await makeRetainedEvidenceFixture();
  try { const bundle = prepare(f), good = blobRow(bundle);
    const probe = (row: typeof good, expected?: RegExp) => {
      f.connection.exec("BEGIN IMMEDIATE");
      try { seedEvent(f.connection, bundle.event); if (expected) assert.throws(() => insertRow(f.connection, "retained_evidence_blobs", row), expected); else insertRow(f.connection, "retained_evidence_blobs", row); }
      finally { f.connection.exec("ROLLBACK"); }
    };
    probe(good);
    for (const key of ["formatVersion", "algorithm", "nonce", "tag", "ciphertext", "wrappedKey", "ciphertextHash", "wrappedKeyHash", "keyedFingerprint"]) {
      probe({ ...good, encrypted_item_json: canonicalJson({ ...bundle.items[0], [key]: null }) }, /CHECK constraint failed/);
    }
    for (const key of ["projectId", "vaultId", "storeId", "evidenceId", "eventId", "targetSessionId", "conversationId", "frameId"]) {
      probe({ ...good, encrypted_item_json: canonicalJson({ ...bundle.items[0], binding: { ...bundle.items[0]!.binding, [key]: null } }) }, /CHECK constraint failed/);
    }
    probe({ ...good, encrypted_item_json: canonicalJson({ ...bundle.items[0], frame: { ...bundle.items[0]!.frame, ordinal: null } }) }, /CHECK constraint failed/);
    for (const path of ["binding.formatVersion", "binding.mediaType", "binding.policyId", "binding.policyVersion", "frame.role", "frame.category", "frame.occurredAt", "frame.mediaType", "frame.artifactHashes",
      "wrapKeyRef", "wrapKeyRef.keyId", "wrapKeyRef.version", "fingerprintKeyRef", "fingerprintKeyRef.keyId", "fingerprintKeyRef.version",
      "wrappedKey.formatVersion", "wrappedKey.algorithm", "wrappedKey.keyRef", "wrappedKey.keyRef.keyId", "wrappedKey.keyRef.version", "wrappedKey.nonce", "wrappedKey.ciphertext", "wrappedKey.tag"]) {
      const changed = JSON.parse(canonicalJson(bundle.items[0])) as Record<string, unknown>;
      const parts = path.split("."); let cursor = changed;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
      cursor[parts.at(-1)!] = null;
      probe({ ...good, encrypted_item_json: canonicalJson(changed) }, /CHECK constraint failed/);
    }
    const foreignEventId = randomUUID(), foreignProjectId = randomUUID();
    probe({ ...good, event_id: foreignEventId, encrypted_item_json: canonicalJson({ ...bundle.items[0], binding: { ...bundle.items[0]!.binding, eventId: foreignEventId } }) }, /RETAINED_EVIDENCE_CORRESPONDENCE/);
    probe({ ...good, project_id: foreignProjectId, encrypted_item_json: canonicalJson({ ...bundle.items[0], binding: { ...bundle.items[0]!.binding, projectId: foreignProjectId } }) }, /RETAINED_EVIDENCE_CORRESPONDENCE/);
  } finally { f.cleanup(); }
});
test("SQL ordinal frame and command collision boundaries refuse every immutable insertion and replacement", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const bundle = prepare(f), good = blobRow(bundle); f.connection.exec("BEGIN IMMEDIATE");
    try {
      seedEvent(f.connection, bundle.event); insertRow(f.connection, "retained_evidence_blobs", good);
      const frameId = randomUUID(), evidenceId = randomUUID(), changed = { ...bundle.items[0]!, binding: { ...bundle.items[0]!.binding, frameId, evidenceId }, frame: { ...bundle.items[0]!.frame, frameId } };
      const row = { ...good, evidence_id: evidenceId, frame_id: frameId, item_index: 1, encrypted_item_json: canonicalJson(changed) };
      assert.throws(() => insertRow(f.connection, "retained_evidence_blobs", row), /RETAINED_EVIDENCE_IMMUTABLE/);
      assert.throws(() => insertRow(f.connection, "retained_evidence_blobs", row, true), /RETAINED_EVIDENCE_IMMUTABLE/);
      assert.throws(() => insertRow(f.connection, "retained_evidence_blobs", { ...row, item_index: 0 }), /RETAINED_EVIDENCE_IMMUTABLE/);
      assert.throws(() => insertRow(f.connection, "retained_evidence_blobs", { ...good, evidence_id: evidenceId }), /RETAINED_EVIDENCE_IMMUTABLE/);
    } finally { f.connection.exec("ROLLBACK"); }
  } finally { f.cleanup(); }
});


import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import type { SqliteConnection, SqliteParams } from "../src/orchestrator/storage/sqlite-driver.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import { SqliteSessionEndEffectiveStateMigrationPreflight } from "../src/orchestrator/storage/session-end-effective-state-migration-preflight.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { FRESH_IDENTITY } from "./support/fresh-start-fixture.js";
import type { RetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { assertRetainedEvidenceCommitBundle, RetainedEvidenceRepository, type RetainedEvidenceCommitV1, type RetainedStreamHeadV1 } from "../src/orchestrator/privacy/retained-evidence.repository.js";
import { buildRetainedEvidenceIntent, retainedEvidenceIntentHash } from "../src/orchestrator/privacy/retained-evidence-intent.js";
import { sealEvidenceItem } from "../src/orchestrator/privacy/evidence-envelope.js";
import { redactEvidence } from "../src/orchestrator/privacy/redaction.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { eventHash, payloadHash, responseHash } from "../src/orchestrator/crypto/event-hash.js";
import { assertRetainedEvidenceBundle, assertRetainedStoredEvent, type RetainedEvidenceStoredResultV1 } from "../src/orchestrator/privacy/retained-evidence-codec.js";

// Mutation caught: items-only accounting excludes the additional durable event witness/metadata.
test("complete commit budget includes canonical event metadata authorization and head with real sealed bodies", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    assert.doesNotThrow(() => assertRetainedEvidenceCommitBundle(prepare(f)));
    const frameIds = Array.from({ length: 64 }, () => randomUUID());
    const admitted = decodeRetainEvidenceBatch({ version: 1, commandType: "retain-evidence-batch", commandId: randomUUID(), idempotencyKey: randomUUID(),
      targetSessionId: f.rootAuthority.sessionId, conversationId: randomUUID(), frames: frameIds.map((frameId, n) => ({ frameId, ordinal: String(n), role: "user", category: "user-message",
        occurredAt: FRESH_NOW, mediaType: "text/plain; charset=utf-8", content: "fixture_a ".repeat(64), previousFrameId: n === 0 ? null : frameIds[n - 1], toolCorrelationId: null, artifactHashes: [] })) });
    const policy = Object.freeze({ ...f.policy, rules: Object.freeze([Object.freeze({ kind: "token" as const, prefix: "fixture_", ruleId: "😀".repeat(75) })]) });
    const bundle = prepare({ ...f, policy }, admitted);
    assert.doesNotThrow(() => assertRetainedEvidenceBundle(bundle.items), "valid encrypted item array fits its accepted budget");
    const before = f.rows();
    assert.throws(() => assertRetainedEvidenceCommitBundle(bundle), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    assert.throws(() => f.repository.insertCommitted(bundle), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    assert.deepEqual(f.rows(), before);
  } finally { f.cleanup(); }
});

function input(f: RetainedEvidenceFixture, frames: { ordinal: string; previousFrameId: string | null; frameId?: string; category?: string; toolCorrelationId?: string | null }[] = [{ ordinal: "0", previousFrameId: null }], targetSessionId: string = f.rootAuthority.sessionId, conversationId: string = randomUUID()) {
  return decodeRetainEvidenceBatch({ version: 1, commandType: "retain-evidence-batch", commandId: randomUUID(), idempotencyKey: randomUUID(), targetSessionId, conversationId,
    frames: frames.map(frame => ({ frameId: frame.frameId ?? randomUUID(), ordinal: frame.ordinal, previousFrameId: frame.previousFrameId, role: frame.category?.startsWith("tool-") ? "tool" : "user",
      category: frame.category ?? "user-message", occurredAt: FRESH_NOW, mediaType: "text/plain; charset=utf-8", content: "owned fixture_token", toolCorrelationId: frame.toolCorrelationId ?? null, artifactHashes: [] })) });
}
function prepare(f: RetainedEvidenceFixture, admitted = input(f), expectedHead: RetainedStreamHeadV1 | null = null): RetainedEvidenceCommitV1 {
  try {
    const c = admitted.command, authority = f.authoritySnapshot(c.targetSessionId);
    const scope = { projectId: FRESH_IDENTITY.projectId, storeId: FRESH_IDENTITY.storeId };
    const witness = buildRetainedEvidenceIntent(admitted, authority, f.policy, { originalCommitmentKeyRef: f.provider.currentKey(scope, "original-input-commitment"), fingerprintKeyRef: f.provider.currentKey(scope, "redacted-content-fingerprint") }, f.provider);
    const eventId = randomUUID();
    const items = redactEvidence(admitted, f.policy).frames.map(frame => sealEvidenceItem({ formatVersion: 1, ...FRESH_IDENTITY, evidenceId: randomUUID(), eventId,
      targetSessionId: c.targetSessionId, conversationId: c.conversationId, frameId: frame.frameId, mediaType: frame.mediaType, policyId: f.policy.policyId, policyVersion: f.policy.policyVersion }, frame, f.provider));
    const payload = { formatVersion: 1 as const, witness, items: items.map(({ formatVersion: _v, algorithm: _a, nonce: _n, tag: _t, ciphertext: _c, wrappedKey: _k, ...metadata }) => metadata) };
    const tail = f.connection.prepare("SELECT global_position, event_hash FROM events ORDER BY global_position DESC LIMIT 1").get()!;
    const version = f.connection.prepare("SELECT current_version FROM streams WHERE project_id = $p AND stream_id = $s").get({ $p: FRESH_IDENTITY.projectId, $s: `session/${c.targetSessionId}` })!.current_version as bigint;
    const event = { ...FRESH_IDENTITY, globalPosition: (tail.global_position as bigint) + 1n, eventId, workspaceId: authority.workspaceId, branchScopeId: null, branchRef: null,
      streamId: `session/${c.targetSessionId}`, streamType: "session", streamVersion: version + 1n, eventType: "EvidenceBatchRetained", eventSchemaVersion: 1,
      sessionId: c.targetSessionId, parentSessionId: authority.parentSessionId, actorRole: authority.presentingActorRole, agentId: "synthetic-fixture",
      clientInstanceId: authority.presentingClientInstanceId, correlationId: c.conversationId, causationId: null, commandId: c.commandId, idempotencyKey: c.idempotencyKey,
      commandEventIndex: 0, occurredAt: FRESH_NOW, recordedAt: FRESH_NOW, visibilityScope: "session", confidence: "high", verificationStatus: "verified",
      sourceRefs: [], evidenceRefs: items.map(i => i.binding.evidenceId), evidenceDigests: items.map(i => ({ ciphertextHash: i.ciphertextHash, keyedFingerprint: i.keyedFingerprint })),
      payload, payloadJson: canonicalJson(payload), payloadHash: payloadHash(payload), previousGlobalHash: tail.event_hash as string, eventHash: "" };
    const { payload: _payload, payloadJson: _json, eventHash: _hash, ...envelope } = event;
    event.eventHash = eventHash({ ...envelope, globalPosition: event.globalPosition.toString(), streamVersion: event.streamVersion.toString() });
    assertRetainedStoredEvent(event as unknown as StoredEvent);
    const last = c.frames.at(-1)!;
    return { event: event as unknown as StoredEvent, items, authorization: authority, expectedHead,
      nextHead: { targetSessionId: c.targetSessionId, conversationId: c.conversationId, lastFrameId: last.frameId, lastOrdinal: last.ordinal, version: expectedHead === null ? "1" : String(BigInt(expectedHead.version) + 1n) } };
  } finally { admitted.canonicalOriginalBytes.fill(0); }
}
// Schema/repository setup only: does not exercise protected retained append (Task 4).
function seedEvent(connection: SqliteConnection, event: StoredEvent): void {
  const mapping = { globalPosition: "global_position", eventId: "event_id", projectId: "project_id", vaultId: "vault_id", storeId: "store_id", workspaceId: "workspace_id",
    branchScopeId: "branch_scope_id", branchRef: "branch_ref", streamId: "stream_id", streamType: "stream_type", streamVersion: "stream_version", eventType: "event_type",
    eventSchemaVersion: "event_schema_version", sessionId: "session_id", parentSessionId: "parent_session_id", actorRole: "actor_role", agentId: "agent_id", clientInstanceId: "client_instance_id",
    correlationId: "correlation_id", causationId: "causation_id", commandId: "command_id", idempotencyKey: "idempotency_key", commandEventIndex: "command_event_index",
    occurredAt: "occurred_at", recordedAt: "recorded_at", visibilityScope: "visibility_scope", confidence: "confidence", verificationStatus: "verification_status",
    payloadJson: "payload_json", payloadHash: "payload_hash", previousGlobalHash: "previous_global_hash", eventHash: "event_hash" } as const;
  const params: SqliteParams = {};
  for (const [key] of Object.entries(mapping)) params[`$${key}`] = event[key as keyof typeof mapping];
  const fields = Object.values(mapping), values = Object.keys(mapping).map(key => `$${key}`);
  for (const [key, value] of [["source_refs_json", event.sourceRefs], ["evidence_refs_json", event.evidenceRefs], ["evidence_digests_json", event.evidenceDigests]] as const) {
    fields.push(key as typeof fields[number]); values.push(`$${key}`); params[`$${key}`] = canonicalJson(value);
  }
  connection.prepare(`INSERT INTO events(${fields.join(",")}) VALUES(${values.join(",")})`).run(params);
  connection.prepare("UPDATE streams SET current_version = $v WHERE project_id = $p AND stream_id = $s").run({ $v: event.streamVersion, $p: event.projectId, $s: event.streamId });
}
function storedResult(bundle: RetainedEvidenceCommitV1): RetainedEvidenceStoredResultV1 {
  const e = bundle.event, w = assertRetainedStoredEvent(e)!.witness;
  return { eventIds: [e.eventId], firstGlobalPosition: String(e.globalPosition), lastGlobalPosition: String(e.globalPosition), finalStreamVersion: String(e.streamVersion),
    response: { resultVersion: 1, operation: "retain-evidence-batch", retentionFormat: "redacted-encrypted-v1", targetSessionId: w.targetSessionId, conversationId: w.conversationId,
      commandId: w.commandId, idempotencyKey: w.idempotencyKey, evidenceIds: bundle.items.map(i => i.binding.evidenceId), eventPosition: String(e.globalPosition), finalStreamVersion: String(e.streamVersion) } };
}
function seedDedup(connection: SqliteConnection, bundle: RetainedEvidenceCommitV1, change: Partial<{ commandId: string; idempotencyKey: string; eventId: string; position: bigint }> = {}): void {
  const e = bundle.event, result = storedResult(bundle);
  connection.prepare(`INSERT INTO command_dedup(project_id, command_id, idempotency_key, command_type, command_hash, workspace_head_commit, outbox_order_json, state,
    first_global_position, last_global_position, final_stream_version, event_ids_json, response_json, response_hash, committed_at)
    VALUES($p,$c,$i,'retain-evidence-batch',$h,NULL,'[]','committed',$pos,$pos,$v,$ids,$r,$rh,$at)`).run({
    $p: e.projectId, $c: change.commandId ?? e.commandId, $i: change.idempotencyKey ?? e.idempotencyKey, $h: retainedEvidenceIntentHash(assertRetainedStoredEvent(e)!.witness),
    $pos: change.position ?? e.globalPosition, $v: e.streamVersion, $ids: canonicalJson([change.eventId ?? e.eventId]), $r: canonicalJson(result), $rh: responseHash(result), $at: FRESH_NOW,
  });
}
function commit(f: RetainedEvidenceFixture, bundle: RetainedEvidenceCommitV1, repository = f.repository): void {
  f.connection.exec("BEGIN IMMEDIATE");
  try { seedEvent(f.connection, bundle.event); repository.insertCommitted(bundle); seedDedup(f.connection, bundle); f.connection.exec("COMMIT"); }
  catch (error) { f.connection.exec("ROLLBACK"); throw error; }
}
// Mutations caught: missing compound writes/join, wrong ordering/CAS, observer displacement or hidden transaction.
test("repository inserts on the caller transaction and observes actual blob head authorization boundaries", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const bundle = prepare(f), observations: unknown[] = [];
    const repository = new RetainedEvidenceRepository(f.connection, (boundary, commandId, idempotencyKey) => observations.push([boundary, commandId, idempotencyKey,
      ...["retained_evidence_blobs", "retained_evidence_stream_heads", "retained_evidence_command_authorizations"].map(t => f.connection.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n)]));
    commit(f, bundle, repository);
    assert.deepEqual(observations.map(o => (o as unknown[]).filter((_, i) => i !== 1 && i !== 2)), [["after-blobs", 1n, 0n, 0n], ["after-head", 1n, 1n, 0n], ["after-auth", 1n, 1n, 1n]]);
    for (const observed of observations as unknown[][]) assert.deepEqual(observed.slice(1, 3), [bundle.event.commandId, bundle.event.idempotencyKey]);
    assert.deepEqual(repository.readHead(bundle.nextHead.targetSessionId, bundle.nextHead.conversationId), bundle.nextHead);
    repository.assertCorrespondence(bundle.event);
    const prior = repository.findPrior(bundle.event.commandId, bundle.event.idempotencyKey)!;
    assert.deepEqual(prior.authorization, bundle.authorization); assert.deepEqual(prior.result, storedResult(bundle));
    assert.equal(prior.commandHash, retainedEvidenceIntentHash(prior.witness));
    assert.throws(() => repository.findPrior(randomUUID(), bundle.event.idempotencyKey), { code: "IDEMPOTENCY_CONFLICT" });
    const before = f.rows(); f.reopen(); assert.deepEqual(f.rows(), before);
    assert.deepEqual(repository.findPrior(bundle.event.commandId, bundle.event.idempotencyKey)!.result, prior.result);
    const material = f.lifecycle.capabilities.reconstructForTarget(f.childAuthority.descriptor, f.childAuthority.target);
    try { assert.equal(material.kind, "child"); } finally { material.handle.destroy(); }
    assert.ok(!JSON.stringify(f.rows(), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value).includes("fixture_token"));
  } finally { f.cleanup(); }
});
test("ordering requires the exact committed predecessor successor and scoped preceding tool input", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const correlation = randomUUID(), admitted = input(f, [{ ordinal: "0", previousFrameId: null, category: "tool-input", toolCorrelationId: correlation }]);
    const bundle = prepare(f, admitted); commit(f, bundle);
    const head = f.repository.readHead(bundle.nextHead.targetSessionId, bundle.nextHead.conversationId)!;
    for (const [ordinal, predecessor] of [["2", head.lastFrameId], ["1", randomUUID()]] as const) {
      const bad = input(f, [{ ordinal, previousFrameId: predecessor }], head.targetSessionId, head.conversationId);
      try { assert.throws(() => f.repository.assertCanContinue(bad, head), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" }); } finally { bad.canonicalOriginalBytes.fill(0); }
    }
    const continuation = input(f, [{ ordinal: "1", previousFrameId: head.lastFrameId, category: "tool-output", toolCorrelationId: correlation }], head.targetSessionId, head.conversationId);
    try { assert.doesNotThrow(() => f.repository.assertCanContinue(continuation, head)); } finally { continuation.canonicalOriginalBytes.fill(0); }
    const missing = input(f, [{ ordinal: "1", previousFrameId: head.lastFrameId, category: "tool-output", toolCorrelationId: randomUUID() }], head.targetSessionId, head.conversationId);
    try { assert.throws(() => f.repository.assertCanContinue(missing, head), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" }); } finally { missing.canonicalOriginalBytes.fill(0); }
    const duplicate = input(f, [{ ordinal: "0", previousFrameId: null, frameId: head.lastFrameId }], head.targetSessionId, head.conversationId);
    try { assert.throws(() => f.repository.assertCanContinue(duplicate, head), { code: "RETAINED_EVIDENCE_FRAME_CONFLICT" }); } finally { duplicate.canonicalOriginalBytes.fill(0); }
    const next = prepare(f, input(f, [{ ordinal: "1", previousFrameId: head.lastFrameId }], head.targetSessionId, head.conversationId), head);
    commit(f, next); assert.equal(f.repository.readHead(head.targetSessionId, head.conversationId)!.version, "2");
    const stale = prepare(f, input(f, [{ ordinal: "1", previousFrameId: head.lastFrameId }], head.targetSessionId, head.conversationId), head);
    const before = f.rows(); assert.throws(() => commit(f, stale), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" }); assert.deepEqual(f.rows(), before);
    const other = prepare(f, input(f, undefined, f.childAuthority.sessionId)); commit(f, other);
    assert.deepEqual(f.repository.readHead(other.nextHead.targetSessionId, other.nextHead.conversationId), other.nextHead);
    const otherConversation = prepare(f, input(f)); commit(f, otherConversation);
    for (const target of [other.nextHead, otherConversation.nextHead]) {
      const value = input(f, [{ ordinal: "1", previousFrameId: target.lastFrameId, category: "tool-output", toolCorrelationId: correlation }], target.targetSessionId, target.conversationId);
      try { assert.throws(() => f.repository.assertCanContinue(value, target), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" }); } finally { value.canonicalOriginalBytes.fill(0); }
    }
    const frameId = randomUUID(), batchCorrelation = randomUUID();
    const sameBatch = input(f, [{ ordinal: "0", previousFrameId: null, frameId, category: "tool-input", toolCorrelationId: batchCorrelation },
      { ordinal: "1", previousFrameId: frameId, category: "tool-output", toolCorrelationId: batchCorrelation }]);
    try { assert.doesNotThrow(() => f.repository.assertCanContinue(sameBatch, null)); } finally { sameBatch.canonicalOriginalBytes.fill(0); }
  } finally { f.cleanup(); }
});
test("observer failure belongs to the transaction owner and rolls back all repository rows", async () => {
  const f = await makeRetainedEvidenceFixture();
  try { const before = f.rows(), bundle = prepare(f); const fault = new Error("synthetic fixture fault");
    const repository = new RetainedEvidenceRepository(f.connection, boundary => { if (boundary === "after-head") throw fault; });
    assert.throws(() => commit(f, bundle, repository), error => error === fault); assert.deepEqual(f.rows(), before);
  } finally { f.cleanup(); }
});
// Mutation caught: absent deferred keys or scoped event/dedup correspondence accepts an orphan/foreign relation.
test("deferred command keys permit event blobs head authorization dedup order but refuse orphan commit", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const before = f.rows(), bundle = prepare(f); f.connection.exec("BEGIN IMMEDIATE");
    seedEvent(f.connection, bundle.event); f.repository.insertCommitted(bundle);
    assert.throws(() => f.connection.exec("COMMIT"), /FOREIGN KEY constraint failed/);
    f.connection.exec("ROLLBACK"); assert.deepEqual(f.rows(), before);
    f.connection.exec("BEGIN IMMEDIATE"); seedEvent(f.connection, bundle.event); f.repository.insertCommitted(bundle);
    assert.throws(() => seedDedup(f.connection, bundle, { commandId: randomUUID() }), /RETAINED_EVIDENCE_CORRESPONDENCE/);
    assert.throws(() => seedDedup(f.connection, bundle, { eventId: randomUUID() }), /RETAINED_EVIDENCE_CORRESPONDENCE/);
    f.connection.exec("ROLLBACK");
    commit(f, bundle); assert.equal(f.connection.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { f.cleanup(); }
});
test("immutable blobs authorization and their authoritative bindings refuse update delete and replacement", async () => {
  const f = await makeRetainedEvidenceFixture();
  try { const bundle = prepare(f); commit(f, bundle); const before = f.rows();
    for (const table of ["retained_evidence_blobs", "retained_evidence_command_authorizations"]) {
      assert.throws(() => f.connection.exec(`UPDATE ${table} SET command_id = command_id`), /RETAINED_EVIDENCE_IMMUTABLE/);
      assert.throws(() => f.connection.exec(`DELETE FROM ${table}`), /RETAINED_EVIDENCE_IMMUTABLE/);
      assert.throws(() => f.connection.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /RETAINED_EVIDENCE_IMMUTABLE/);
    }
    assert.throws(() => f.connection.exec("INSERT OR REPLACE INTO events SELECT * FROM events WHERE event_type = 'EvidenceBatchRetained'"), /RETAINED_EVIDENCE_IMMUTABLE/);
    assert.throws(() => f.connection.exec("INSERT OR REPLACE INTO command_dedup SELECT * FROM command_dedup WHERE command_type = 'retain-evidence-batch'"), /RETAINED_EVIDENCE_IMMUTABLE/);
    assert.deepEqual(f.rows(), before);
  } finally { f.cleanup(); }
});

import { makeRetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { decodeRetainEvidenceBatch } from "../src/orchestrator/privacy/evidence-contracts.js";

// Mutation caught: repository accepts a nonzero first ordinal or fails closed on a valid first frame.
test("repository accepts only ordinal zero and null predecessor at an empty head", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const frame = { frameId: "00000000-0000-4000-8000-000000000010", ordinal: "0", role: "user", category: "user-message", occurredAt: FRESH_NOW,
      mediaType: "text/plain; charset=utf-8", content: "synthetic visible content", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] };
    const raw = { version: 1, commandType: "retain-evidence-batch", commandId: "00000000-0000-4000-8000-000000000011", idempotencyKey: "00000000-0000-4000-8000-000000000012",
      targetSessionId: f.rootAuthority.sessionId, conversationId: "00000000-0000-4000-8000-000000000013", frames: [frame] };
    const first = decodeRetainEvidenceBatch(raw);
    const wrong = decodeRetainEvidenceBatch({ ...raw, frames: [{ ...frame, ordinal: "1", previousFrameId: "00000000-0000-4000-8000-000000000009" }] });
    try {
      assert.doesNotThrow(() => f.repository.assertCanContinue(first, null));
      assert.throws(() => f.repository.assertCanContinue(wrong, null), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" });
    } finally { first.canonicalOriginalBytes.fill(0); wrong.canonicalOriginalBytes.fill(0); }
  } finally { f.cleanup(); }
});

// Mutation caught: registry/migration omitted; qualified owned store remains at schema 8.
test("schema 8 upgrades additively to retained schema 9 without rewriting historical rows", () => {
  const f = freshStore();
  try {
    const checksums = f.connection.prepare("SELECT * FROM schema_migrations WHERE version <= 8 ORDER BY version").all();
    const events = f.connection.prepare("SELECT * FROM events ORDER BY global_position").all();
    assert.equal(CURRENT_PROJECT_STORE_SCHEMA_VERSION, 9);
    assert.equal(PROJECT_STORE_MIGRATIONS.at(-1)?.name, "retained-evidence");
    assert.deepEqual(new MigrationRunner().apply(f.connection, PROJECT_STORE_MIGRATIONS, FRESH_NOW, { kind: "explicit-upgrade", expectedAppliedVersion: 9, beforeMigration: () => undefined }), []);
    assert.equal(f.connection.prepare("SELECT schema_version FROM project_meta").get()!.schema_version, 9n);
    assert.deepEqual(f.connection.prepare("SELECT * FROM schema_migrations WHERE version <= 8 ORDER BY version").all(), checksums);
    assert.deepEqual(f.connection.prepare("SELECT * FROM events ORDER BY global_position").all(), events);
    assert.equal(f.connection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('retained_evidence_blobs','retained_evidence_stream_heads','retained_evidence_command_authorizations')").get()!.n, 3n);
  } finally { f.cleanup(); }
});
