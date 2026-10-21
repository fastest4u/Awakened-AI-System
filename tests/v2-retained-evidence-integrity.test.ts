import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { makeRetainedEvidenceFixture, type RetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { EventIntegrityService } from "../src/orchestrator/integrity/event-integrity.service.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import { authenticateStoredEvent } from "../src/orchestrator/integrity/stored-event-authenticator.js";
import { RetainedEvidenceReader, type RetainedEvidenceReadInvocationV1 } from "../src/orchestrator/privacy/retained-evidence-reader.js";
import { retainedEvidenceIntentHash } from "../src/orchestrator/privacy/retained-evidence-intent.js";
import { assertRetainedStoredEvent, retainedEvidenceIntentHash as pureWitnessHash, retainedEvidenceCipherHash, retainedEvidenceWrapHash, verifyRetainedEvidenceTransport } from "../src/orchestrator/privacy/retained-evidence-codec.js";
import { createCapabilityProof } from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import { commandHash, payloadHash, eventHash } from "../src/orchestrator/crypto/event-hash.js";
import { retainedEvidenceReadProofTarget, type VerifiedRetainedEvidenceAuthority } from "../src/orchestrator/privacy/retained-evidence-authority.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { join } from "node:path";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { decodeProjectionEvent, decodeProjectionEventV1 } from "../src/orchestrator/projections/source-event-codec.js";
import { openCommittedProjectionEventSnapshot } from "../src/orchestrator/projections/event-reader.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { RetainEvidenceBatchCommandV1 } from "../src/orchestrator/privacy/evidence-contracts.js";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import { SessionAuthorityRepository } from "../src/orchestrator/storage/session-authority.repository.js";

type Authorizer = RetainedEvidenceFixture["childAuthority"];
const batch = (f: RetainedEvidenceFixture, target: string = f.rootAuthority.sessionId): RetainEvidenceBatchCommandV1 => ({ version: 1, commandType: "retain-evidence-batch",
  commandId: randomUUID(), idempotencyKey: randomUUID(), targetSessionId: target, conversationId: randomUUID(),
  frames: [{ frameId: randomUUID(), ordinal: "0", role: "user", category: "user-message", occurredAt: FRESH_NOW,
    mediaType: "text/plain; charset=utf-8", content: "visible fixture_alpha", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }] });
function retain(f: RetainedEvidenceFixture, command = batch(f), authorizer: Authorizer = f.rootAuthority) {
  const result = f.service().retain(f.invocation(command, authorizer));
  const prior = f.repository.findPrior(command.commandId, command.idempotencyKey)!;
  return { result, event: prior.event, evidenceId: result.response.evidenceIds[0]!, command };
}
function readInvocation(f: RetainedEvidenceFixture, evidenceId: string, targetSessionId: string = f.rootAuthority.sessionId, authorizer: Authorizer = f.rootAuthority,
  expiresAt = new Date(Date.parse(FRESH_NOW) + 60_000).toISOString(), context = authorizer.target.actorRole === "primary" ? f.projectContext : f.childContext): RetainedEvidenceReadInvocationV1 {
  const b = context.binding;
  const operationId = randomUUID(), requestId = randomUUID(), proofNonce = randomUUID();
  const row = new SessionAuthorityRepository().get(f.connection, b.projectId, authorizer.sessionId)!;
  const principal = { presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId };
  const selectors = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace,
    evidenceId, targetSessionId, authoritySessionId: authorizer.sessionId, ...principal, operationId, requestId, expiresAt };
  const material = f.lifecycle.capabilities.reconstructForTarget(authorizer.descriptor, authorizer.target);
  try {
    const proof = createCapabilityProof(material.handle, { proofVersion: 1, target: "bounded-operation", operationType: "read-retained-evidence", operationId, requestId,
      operationHash: commandHash({ proofPurpose: "read-retained-evidence/v1", ...selectors }), authoritySessionId: authorizer.sessionId,
      targetSessionId, ...principal, capabilityGeneration: (row.ownerGeneration ?? row.childCapabilityGeneration)!.toString(), proofNonce, expiresAt });
    return { context, operationId, requestId, evidenceId, targetSessionId, expiresAt, authorization: { kind: "bounded-operation", authoritySessionId: authorizer.sessionId as never,
      targetSessionId: targetSessionId as never, proof, audience: principal } };
  } finally { material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
}
const reader = (f: RetainedEvidenceFixture) => new RetainedEvidenceReader({ connection: f.connection, authority: f.retainedAuthority, provider: f.provider });
function rawMutation(f: RetainedEvidenceFixture, mutate: () => void): void {
  const triggers = f.connection.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all();
  for (const trigger of triggers) f.connection.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
  f.connection.exec("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF");
  try { mutate(); } finally {
    for (const trigger of triggers) f.connection.exec(trigger.sql as string);
    f.connection.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  }
}
const report = (f: RetainedEvidenceFixture, mode: "quick" | "full" | "range", event: StoredEvent) => {
  const b = f.projectContext.binding;
  writeFileSync(b.descriptorPath, JSON.stringify({ schemaVersion: 1, projectId: b.projectId, vaultId: b.vaultId, createdAt: FRESH_NOW }));
  writeFileSync(b.storeRoute.storeManifestPath, JSON.stringify({ schemaVersion: 1, projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, createdAt: FRESH_NOW, lastIntegrity: { status: "never" } }));
  const service = new EventIntegrityService(f.connection);
  return mode === "quick" ? service.quickCheck(f.projectContext) : mode === "full" ? service.fullCheck(f.projectContext) : service.verifyRange(f.projectContext, event.globalPosition, event.globalPosition);
};

// A generic command reconstruction or provider-MAC dependency must fail this real mixed chain.
test("mixed chain reconstructs retained witness without provider", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); });
  const { event } = retain(f); const w = assertRetainedStoredEvent(event)!.witness;
  const expected = createHash("sha256").update("project-memory/retained-evidence-command/v1\n" + canonicalJson(w)).digest("hex");
  assert.equal(retainedEvidenceIntentHash(w), expected);
  assert.equal(pureWitnessHash(w), expected);
  const before = { ...f.provider.calls };
  for (const mode of ["quick", "full", "range"] as const) assert.deepEqual(report(f, mode, event).issues, []);
  assert.deepEqual(f.provider.calls, before);
  authenticateStoredEvent(event, { expectedPosition: event.globalPosition, previousEventHash: event.previousGlobalHash });
});

// Empty serialization remains the original published SHA-256 vector.
test("legacy empty hash vectors remain identical", () => {
  assert.equal(payloadHash({ z: -0, a: ["ไทย", 3, true, null], nested: { b: 2, a: 1 } }), "392e7a273f8bf98f2d6aed8b485f468dc1fc649056ee8b648a628011f7cad2d9");
  assert.equal(canonicalJson({ evidenceRefs: [], evidenceDigests: [] }), '{"evidenceDigests":[],"evidenceRefs":[]}');
});

test("retained event advances projection without canonical content", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); });
  const { event } = retain(f);
  const b = f.projectContext.binding;
  const binding = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, sessionId: null, branchScopeId: null, branchRef: null };
  const snapshot = openCommittedProjectionEventSnapshot(binding, { driver: new NodeSqliteDriver({ DatabaseSync }), eventStorePath: f.path });
  try {
    const retained = [...snapshot.events()].filter(e => e.eventType === "EvidenceBatchRetained");
    assert.equal(retained.length, 1);
    for (const decode of [decodeProjectionEvent, decodeProjectionEventV1]) assert.deepEqual(decode(retained[0]!), { kind: "unprojected", eventPosition: event.globalPosition, eventType: "EvidenceBatchRetained" });
    assert.equal(snapshot.terminalEventPosition, event.globalPosition);
  } finally { snapshot.close(); }
  const fresh = openCommittedProjectionEventSnapshot(binding, { driver: new NodeSqliteDriver({ DatabaseSync }), eventStorePath: f.path });
  try {
    const built = await new ImmutableProjectionBuilder({ driver: new NodeSqliteDriver({ DatabaseSync }), projectionDirectory: join(f.root, "projections"), now: () => FRESH_NOW }).buildV2(fresh, 1);
    assert.equal(built.manifest.terminalEventPosition, String(event.globalPosition));
    const image = new DatabaseSync(built.temporaryDatabasePath, { readOnly: true });
    try { assert.equal(image.prepare("SELECT count(*) AS n FROM canonical_items").get()!.n, 0); } finally { image.close(); }
  } finally { fresh.close(); }
});

test("historical unknown remains unprojected without inspecting opaque payload", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); });
  const { event } = retain(f); let touches = 0;
  const payload = Object.create(null) as Record<string, unknown>; Object.defineProperty(payload, "secret", { get() { touches++; throw new Error("must not inspect"); }, enumerable: true }); payload.cycle = payload;
  const unknown = { ...event, globalPosition: 42n, eventType: "UnrecognizedV99", evidenceRefs: [], evidenceDigests: [], payload, payloadJson: "uninspected" } as StoredEvent;
  assert.deepEqual(decodeProjectionEvent(unknown), { kind: "unprojected", eventPosition: 42n, eventType: "UnrecognizedV99" }); assert.equal(touches, 0);
});

test("retained version and ref mismatch refuse even when otherwise unprojected", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { event } = retain(f);
  for (const altered of [{ ...event, eventSchemaVersion: 2 }, { ...event, evidenceRefs: [randomUUID()] }, { ...event, evidenceDigests: [] }]) {
    assert.throws(() => decodeProjectionEvent(altered), /INTEGRITY_FAILURE/);
    assert.throws(() => authenticateStoredEvent(altered, { expectedPosition: altered.globalPosition, previousEventHash: altered.previousGlobalHash }), /INTEGRITY_FAILURE/);
  }
});

for (const tamper of ["missing", "swapped", "ciphertext", "wrap", "head", "authorization", "result"] as const) test(`${tamper} stored correspondence refuses in quick/full/range`, async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { event } = retain(f);
  const read = readInvocation(f, event.evidenceRefs[0]!);
  const triggers = f.connection.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all();
  f.connection.exec("PRAGMA ignore_check_constraints=ON");
  if (tamper === "head") { f.connection.exec("DROP TRIGGER retained_evidence_head_update"); f.connection.prepare("UPDATE retained_evidence_stream_heads SET last_ordinal=last_ordinal+1").run(); }
  else if (tamper === "result") { f.connection.exec("DROP TRIGGER command_dedup_no_update"); f.connection.prepare("UPDATE command_dedup SET response_hash=$h WHERE command_id=$c").run({ $h: "0".repeat(64), $c: event.commandId }); }
  else if (tamper === "authorization") {
    f.connection.exec("DROP TRIGGER retained_evidence_command_authorizations_no_update");
    f.connection.prepare("UPDATE retained_evidence_command_authorizations SET authorization_json='{}'").run();
  } else {
    f.connection.exec("DROP TRIGGER retained_evidence_blobs_no_update");
    if (tamper === "missing") { f.connection.exec("DROP TRIGGER retained_evidence_blobs_no_delete; PRAGMA foreign_keys=OFF"); f.connection.prepare("DELETE FROM retained_evidence_blobs").run(); }
    else {
      const row = f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!;
      const item = JSON.parse(row.encrypted_item_json as string);
      if (tamper === "swapped") item.binding.evidenceId = randomUUID();
      else if (tamper === "ciphertext") item.ciphertext = Buffer.from("different encrypted bytes").toString("base64url");
      else item.wrappedKey.tag = Buffer.alloc(16).toString("base64url");
      f.connection.prepare("UPDATE retained_evidence_blobs SET encrypted_item_json=$j").run({ $j: canonicalJson(item) });
    }
  }
  for (const trigger of triggers) if (!f.connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=$n").get({ $n: trigger.name! })) f.connection.exec(trigger.sql as string);
  f.connection.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  const before = { ...f.provider.calls };
  for (const mode of ["quick", "full", "range"] as const) {
    const checked = report(f, mode, event); assert.equal(checked.ok, false, mode);
    assert.ok(checked.issues.some(issue => issue.code === "EVENT_HASH_MISMATCH" || issue.code === "COMMAND_METADATA_MISMATCH"), `${tamper}/${mode} must fail retained correspondence`);
    assert.equal(checked.issues.some(issue => issue.code === "SCHEMA_FINGERPRINT_MISMATCH"), false);
  }
  assert.throws(() => reader(f).read(read));
  assert.deepEqual(f.provider.calls, before);
});

for (const entitlement of ["root-self", "root-child", "child-self"] as const) test(`authorized ${entitlement} returns only redacted content without original submission`, async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); });
  const target = entitlement === "root-self" ? f.rootAuthority.sessionId : f.childAuthority.sessionId;
  const authorizer = entitlement === "child-self" ? f.childAuthority : f.rootAuthority;
  const accepted = retain(f, batch(f, target), authorizer);
  const returned = reader(f).read(readInvocation(f, accepted.evidenceId, target, authorizer));
  assert.equal(returned.content, "visible [REDACTED]"); assert.equal(returned.manifest.length, 1);
  assert.equal(JSON.stringify(returned).includes("fixture_alpha"), false);
});

test("historical authorized reads survive head continuation and native connection reopen", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const first = retain(f);
  const next = { ...first.command, commandId: randomUUID(), idempotencyKey: randomUUID(), frames: [{ ...first.command.frames[0]!, frameId: randomUUID(), ordinal: "1", previousFrameId: first.command.frames[0]!.frameId }] };
  retain(f, next); f.provider.rotate("data-key-wrap"); f.provider.rotate("redacted-content-fingerprint"); f.reopen();
  assert.equal(reader(f).read(readInvocation(f, first.evidenceId)).content, "visible [REDACTED]");
  for (const mode of ["quick", "full", "range"] as const) assert.equal(report(f, mode, first.event).ok, true);
});

test("exact selector and scope proof fences refuse swapped evidence, principals and expired proof", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const first = retain(f), second = retain(f);
  const signed = readInvocation(f, first.evidenceId);
  const changes = [{ ...signed, evidenceId: second.evidenceId }, { ...signed, requestId: randomUUID() }, { ...signed, operationId: randomUUID() },
    { ...signed, targetSessionId: f.childAuthority.sessionId }, { ...signed, expiresAt: new Date(Date.parse(FRESH_NOW) + 30_000).toISOString() },
    ...["projectId", "vaultId", "storeId", "workspaceId", "clientNamespace", "clientInstanceId"].map(field => ({ ...signed, context: { ...signed.context, binding: { ...signed.context.binding, [field]: field === "workspaceId" ? "0".repeat(64) : randomUUID() } } }))];
  for (const changed of changes) assert.throws(() => reader(f).read(changed));
  assert.throws(() => reader(f).read(readInvocation(f, first.evidenceId, f.rootAuthority.sessionId, f.rootAuthority, FRESH_NOW)));
  assert.throws(() => reader(f).read(readInvocation(f, first.evidenceId, f.rootAuthority.sessionId, f.rootAuthority, new Date(Date.parse(FRESH_NOW) + 120_001).toISOString())));
  assert.throws(() => reader(f).read(readInvocation(f, first.evidenceId, f.rootAuthority.sessionId, f.childAuthority)));
});

for (const purpose of ["data-key-wrap", "redacted-content-fingerprint"] as const) test(`historical ${purpose} revoked or missing refuses safely`, async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { evidenceId } = retain(f);
  f.provider.rotate(purpose); f.provider.setStatus(purpose, "revoked", "1");
  assert.throws(() => reader(f).read(readInvocation(f, evidenceId)), { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" });
  f.provider.forget(purpose, "1"); assert.throws(() => reader(f).read(readInvocation(f, evidenceId)), { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" });
});

test("native/provider exceptions expose only closed safe reader failures", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { evidenceId } = retain(f);
  f.provider.unwrap = () => { throw new Error("fixture_alpha private native error"); };
  assert.throws(() => reader(f).read(readInvocation(f, evidenceId)), error => {
    assert.equal((error as { code: string }).code, "INTEGRITY_FAILURE"); assert.doesNotMatch(JSON.stringify(error), /fixture_alpha|native error|cause/); return true;
  });
});

test("retained stream leaves session state/version and lifecycle replay unchanged", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); });
  const authority = new SessionAuthorityRepository(), before = authority.get(f.connection, f.projectContext.binding.projectId, f.rootAuthority.sessionId)!;
  const { event } = retain(f); const after = authority.get(f.connection, f.projectContext.binding.projectId, f.rootAuthority.sessionId)!;
  assert.deepEqual(after, before); assert.equal(event.streamType, "retained-evidence");
  const issues: unknown[] = []; const sink = { add: (...args: unknown[]) => { issues.push(args); } };
  await new LifecycleIntegrityService(f.connection).fullCheckAsync(f.projectContext, sink); assert.deepEqual(issues, []);
});

test("pure transport formulas preserve exact immutable canonical strings independently", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { event } = retain(f);
  const item = JSON.parse(f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json as string);
  const material = { formatVersion: item.formatVersion, algorithm: item.algorithm, binding: item.binding, frame: item.frame, wrapKeyRef: item.wrapKeyRef,
    fingerprintKeyRef: item.fingerprintKeyRef, nonce: item.nonce, tag: item.tag, ciphertext: item.ciphertext };
  assert.equal(retainedEvidenceCipherHash(item), createHash("sha256").update(canonicalJson(material)).digest("hex"));
  assert.equal(retainedEvidenceWrapHash(item.wrappedKey), createHash("sha256").update(canonicalJson(item.wrappedKey)).digest("hex"));
  assert.equal(verifyRetainedEvidenceTransport(item).ciphertextHash, assertRetainedStoredEvent(event)!.items[0]!.ciphertextHash);
  assert.throws(() => verifyRetainedEvidenceTransport({ ...item, ciphertext: Buffer.from("changed").toString("base64url") }), { code: "INTEGRITY_FAILURE" });
});

// Hand-authored canonical witness bytes, independent of decoder/builders/provider randomness.
const FIXED_WITNESS_JSON = "{\"authority\":{\"authorizationSessionId\":\"00000000-0000-4000-8000-000000000001\",\"authorizingCapabilityGeneration\":null,\"authorizingOwnerGeneration\":\"1\",\"capabilityKind\":\"root-session-handle\",\"clientNamespace\":\"fixed\",\"parentSessionId\":null,\"presentingActorRole\":\"primary\",\"presentingClientInstanceId\":\"fixed\",\"projectId\":\"00000000-0000-4000-8000-000000000001\",\"rootOwnerGeneration\":\"1\",\"rootSessionId\":\"00000000-0000-4000-8000-000000000001\",\"storeId\":\"00000000-0000-4000-8000-000000000001\",\"targetActorRole\":\"primary\",\"targetCapabilityGeneration\":null,\"targetClientInstanceId\":\"fixed\",\"targetOwnerGeneration\":\"1\",\"targetSessionId\":\"00000000-0000-4000-8000-000000000001\",\"vaultId\":\"00000000-0000-4000-8000-000000000001\",\"workspaceId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"commandId\":\"00000000-0000-4000-8000-000000000001\",\"commandType\":\"retain-evidence-batch\",\"conversationId\":\"00000000-0000-4000-8000-000000000001\",\"fingerprintKeyRef\":{\"keyId\":\"fixed\",\"version\":\"1\"},\"frames\":[{\"artifactHashes\":[],\"category\":\"user-message\",\"frameId\":\"00000000-0000-4000-8000-000000000001\",\"mediaType\":\"text/plain; charset=utf-8\",\"occurredAt\":\"2026-10-02T00:00:00.000Z\",\"ordinal\":\"0\",\"previousFrameId\":null,\"role\":\"user\",\"toolCorrelationId\":null}],\"idempotencyKey\":\"00000000-0000-4000-8000-000000000001\",\"originalCommitmentKeyRef\":{\"keyId\":\"fixed\",\"version\":\"1\"},\"originalInputCommitment\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"policyId\":\"fixed\",\"policyVersion\":\"1\",\"targetSessionId\":\"00000000-0000-4000-8000-000000000001\",\"witnessVersion\":1}";
test("stable witness hash pins the exact domain, canonical material and old exported API", () => {
  const witness = JSON.parse(FIXED_WITNESS_JSON);
  assert.equal(canonicalJson(witness), FIXED_WITNESS_JSON);
  assert.equal(pureWitnessHash(witness), "829cae1c4dd4e15b7825f08e34098a05daaee576048f8b147a0b8c27faeeef30");
  assert.equal(retainedEvidenceIntentHash(witness), "829cae1c4dd4e15b7825f08e34098a05daaee576048f8b147a0b8c27faeeef30");
});

test("genuine read handle cannot prepare writes or authorize another evidence identity", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const accepted = retain(f);
  const invocation = readInvocation(f, accepted.evidenceId), handle = f.retainedAuthority.verifyRead(invocation);
  assert.throws(() => f.events.planRetainedEvidenceIdentity(handle as unknown as VerifiedRetainedEvidenceAuthority, accepted.command), { code: "SESSION_CAPABILITY_INVALID" });
  assert.throws(() => f.retainedAuthority.revalidateRead(handle, randomUUID(), f.authoritySnapshot()), { code: "SESSION_CAPABILITY_INVALID" });
  const target = retainedEvidenceReadProofTarget(invocation, "1", invocation.authorization.proof.proofNonce);
  const actual = f.lifecycle.capabilities.reconstructForTarget(f.rootAuthority.descriptor, f.rootAuthority.target);
  try { assert.deepEqual(createCapabilityProof(actual.handle, target), invocation.authorization.proof); }
  finally { actual.handle.destroy(); if (actual.kind === "root") actual.resumeToken?.destroy(); }
});

test("read authority cannot authorize a second native connection even to the same store", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const accepted = retain(f);
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(f.path, { mode: "existing", busyTimeoutMs: 1000 });
  try {
    const foreign = new RetainedEvidenceReader({ connection, authority: f.retainedAuthority, provider: f.provider });
    assert.throws(() => foreign.read(readInvocation(f, accepted.evidenceId)), { code: "SESSION_CAPABILITY_INVALID" });
  } finally { connection.close(); }
});

test("direct child cannot read sibling or root and root cannot replace recorded child authorizer", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); });
  const sibling = await f.lifecycle.forkChild(f.rootAuthority.sessionId, f.rootAuthority.descriptor);
  const own = retain(f, batch(f, f.childAuthority.sessionId), f.childAuthority), other = retain(f, batch(f, sibling.sessionId)), root = retain(f);
  const before = { ...f.provider.calls };
  for (const invocation of [readInvocation(f, other.evidenceId, sibling.sessionId, f.childAuthority), readInvocation(f, root.evidenceId, f.rootAuthority.sessionId, f.childAuthority),
    readInvocation(f, own.evidenceId, f.childAuthority.sessionId, f.rootAuthority)]) assert.throws(() => reader(f).read(invocation));
  assert.deepEqual(f.provider.calls, before);
});

test("native SQLite failure returns a closed error without native text or partial bytes", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const accepted = retain(f), invocation = readInvocation(f, accepted.evidenceId);
  f.connection.close();
  try { assert.throws(() => reader(f).read(invocation), error => {
    assert.equal((error as { code: string }).code, "INTEGRITY_FAILURE"); assert.doesNotMatch(JSON.stringify(error), /fixture_alpha|closed|SQLite|cause/); return true;
  }); } finally { f.reopen(); }
});

test("real ownership resume rejects stale proof and current new-generation proof for old evidence", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const accepted = retain(f), stale = readInvocation(f, accepted.evidenceId);
  const { checkpointId: _i, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e, createdAt: _at,
    creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = checkpointFixture();
  await f.lifecycle.checkpoint(f.rootAuthority.sessionId, f.rootAuthority.descriptor, draft as unknown as JsonValue);
  const incoming = { ...f.projectContext, binding: { ...f.projectContext.binding, clientInstanceId: "retained-reader-incoming" } };
  incoming.binding.contextFingerprint = computeProjectContextFingerprint(incoming.binding);
  const resumed = await f.lifecycle.resumeAfterExpiry(f.rootAuthority.sessionId, f.rootAuthority.descriptor, incoming);
  const next = { sessionId: f.rootAuthority.sessionId, descriptor: resumed.authorityMaterial.descriptor, target: { actorRole: "primary" as const, clientInstanceId: incoming.binding.clientInstanceId } };
  const row = new SessionAuthorityRepository().get(f.connection, incoming.binding.projectId, next.sessionId)!;
  const currentRead = readInvocation(f, accepted.evidenceId, next.sessionId, next, new Date(Date.parse(row.rootHandleIssuedAt!) + 60_000).toISOString(), incoming);
  assert.doesNotThrow(() => f.retainedAuthority.verifyRead(currentRead));
  const before = { ...f.provider.calls }; assert.throws(() => reader(f).read(stale)); assert.throws(() => reader(f).read(currentRead)); assert.deepEqual(f.provider.calls, before);
});

for (const failure of ["bad-key", "fingerprint"] as const) test(`authenticated private read ${failure} returns no partial content`, async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { evidenceId } = retain(f);
  if (failure === "bad-key") f.provider.unwrap = () => Buffer.alloc(32);
  else f.provider.mac = () => Buffer.alloc(32);
  assert.throws(() => reader(f).read(readInvocation(f, evidenceId)), error => {
    assert.equal((error as { code: string }).code, "INTEGRITY_FAILURE"); assert.doesNotMatch(JSON.stringify(error), /fixture_alpha|visible|manifest|cause/); return true;
  });
});

for (const body of [{ content: "changed redacted content", manifest: [] }, { content: "visible [REDACTED]", manifest: [{ ruleId: "synthetic-token", startByte: 9, endByte: 2 }] }]) test(`authenticated encrypted body/manifest refuses before content return: ${body.manifest.length}`, async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(async () => { await f.cleanup(); }); const { event, evidenceId } = retain(f);
  const item = JSON.parse(f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json as string);
  const aad = Buffer.from(canonicalJson(item.binding)), key = f.provider.unwrap({ projectId: event.projectId, storeId: event.storeId }, item.wrappedKey, aad), nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
    item.ciphertext = Buffer.concat([cipher.update(canonicalJson(body)), cipher.final()]).toString("base64url"); item.tag = cipher.getAuthTag().toString("base64url"); item.nonce = nonce.toString("base64url");
    item.ciphertextHash = retainedEvidenceCipherHash(item);
  } finally { key.fill(0); }
  const payload = JSON.parse(event.payloadJson); payload.items[0].ciphertextHash = item.ciphertextHash;
  const modified = { ...event, payloadJson: canonicalJson(payload), payloadHash: payloadHash(payload), evidenceDigests: [{ ...event.evidenceDigests[0]!, ciphertextHash: item.ciphertextHash }] };
  const { payload: _cache, payloadJson: _json, eventHash: _hash, lifecycleIntentJson: _li, ...hashFields } = modified;
  const nextHash = eventHash({ ...hashFields, globalPosition: String(event.globalPosition), streamVersion: String(event.streamVersion) });
  rawMutation(f, () => {
    f.connection.prepare("UPDATE retained_evidence_blobs SET encrypted_item_json=$j").run({ $j: canonicalJson(item) });
    f.connection.prepare("UPDATE events SET payload_json=$j,payload_hash=$p,event_hash=$h,evidence_digests_json=$d WHERE event_id=$e").run({ $j: modified.payloadJson, $p: modified.payloadHash, $h: nextHash, $d: canonicalJson(modified.evidenceDigests), $e: event.eventId });
  });
  // Metadata correspondence intentionally cannot claim GCM/HMAC plaintext meaning.
  assert.equal(report(f, "range", modified).ok, true);
  assert.throws(() => reader(f).read(readInvocation(f, evidenceId)), error => {
    assert.equal((error as { code: string }).code, "INTEGRITY_FAILURE"); assert.doesNotMatch(JSON.stringify(error), /fixture_alpha|changed redacted|visible|manifest|cause/); return true;
  });
});
