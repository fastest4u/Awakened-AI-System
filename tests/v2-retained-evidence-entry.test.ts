import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { encodePreparedRetainedEvidenceCommand, decodePreparedRetainedEvidenceCommand, decodeRetainedEvidenceWorkerResponse, assertRetainedEvidenceWireSize } from "../src/orchestrator/privacy/retained-evidence-worker-protocol.js";
import { RetainedEvidenceRuntimeFactory, type RetainedEvidenceRuntimeFactoryPort } from "../src/orchestrator/privacy/retained-evidence-runtime.factory.js";
import { ProjectStoreExecutor, type WorkerLike } from "../src/orchestrator/runtime/project-store-executor.js";
import { ProjectStoreWorkerBackend } from "../src/orchestrator/runtime/project-store-worker-backend.js";
import { encodeWorkerBinding, encodeWorkerBindingAssertion, encodeFreshStartContextWire, encodeAppendResultWire, decodeWorkerRequest } from "../src/orchestrator/runtime/worker-protocol.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { bindFreshStartAdmissionContext } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { makeRetainedEvidenceFixture, type RetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { FRESH_NOW, FRESH_IDENTITY } from "./support/fresh-start-fixture.js";
import type { RetainedEvidenceFaultInjector } from "../src/orchestrator/privacy/retained-evidence.service.js";

const WORKER_URL = new URL("./fixtures/project-store-retained-evidence-worker.js", import.meta.url);
function factory(f: RetainedEvidenceFixture, faults?: RetainedEvidenceFaultInjector) {
  return new RetainedEvidenceRuntimeFactory({ provider: f.provider, policy: () => f.policy,
    clock: { now: () => FRESH_NOW, nowMs: () => BigInt(Date.parse(FRESH_NOW)) }, nonceSource: { bytes: randomBytes, uuid: randomUUID },
    ...(faults === undefined ? {} : { faults }) });
}
function prepared(f: RetainedEvidenceFixture, value: unknown) {
  const invocation = f.invocation(value);
  try {
    if (invocation.authorization.kind !== "protected") throw new Error("fixture requires protected proof");
    return { command: invocation.input.command, authorization: invocation.authorization };
  }
  finally { invocation.input.canonicalOriginalBytes.fill(0); }
}
async function openedBackend(f: RetainedEvidenceFixture, runtimeFactory?: RetainedEvidenceRuntimeFactoryPort, deadlineMs = 250) {
  const backend = new ProjectStoreWorkerBackend({ selfUrl: new URL("../src/workers/project-store.worker.js", import.meta.url), executorLeaseMs: 15_000,
    appendRetryDeadlineMs: deadlineMs, trustedFreshStartBuildInspector: () => f.admission.trusted.measuredBuildHash,
    keyProvider: f.lifecycle.broker, ...(runtimeFactory === undefined ? {} : { retainedEvidenceRuntimeFactory: runtimeFactory }) });
  await backend.dispatch({ id: "open", type: "open", binding: encodeWorkerBinding(f.projectContext), freshStart: encodeFreshStartContextWire(f.admission.trusted) });
  return backend;
}
function request(f: RetainedEvidenceFixture, value: unknown) {
  return decodeWorkerRequest({ id: randomUUID(), type: "retained-evidence", binding: encodeWorkerBindingAssertion(f.projectContext),
    prepared: encodePreparedRetainedEvidenceCommand(prepared(f, value)) });
}
async function nativeExecutor(f: RetainedEvidenceFixture, compose = true) {
  const channel = new MessageChannel();
  const worker = new Worker(WORKER_URL, { workerData: { port: channel.port2, policy: f.policy,
    buildHash: f.admission.trusted.measuredBuildHash, compose }, transferList: [channel.port2] });
  const exits: number[] = [];
  const exited = new Promise<number>(resolve => worker.on("exit", code => { exits.push(code); channel.port1.close(); resolve(code); }));
  let sequence = 0;
  channel.port1.on("message", (message: { id: number; family: "evidence" | "capability"; method: string; args: unknown[] }) => {
    let value: unknown;
    try {
      assert.equal(message.id, ++sequence);
      const scope = message.args[0] as { projectId: string; storeId: string };
      assert.equal(scope.projectId, FRESH_IDENTITY.projectId); assert.equal(scope.storeId, FRESH_IDENTITY.storeId);
      const methods = message.family === "evidence" ? ["currentKey", "status", "wrap", "unwrap", "mac"] : ["currentKey", "status", "mac", "verify", "fingerprint", "seal", "open"];
      assert.ok(["evidence", "capability"].includes(message.family) && methods.includes(message.method));
      const target = message.family === "evidence" ? f.provider : f.lifecycle.broker;
      value = Reflect.apply(Reflect.get(target, message.method) as (...args: unknown[]) => unknown, target, message.args);
      channel.port1.postMessage({ id: message.id, ok: true, value });
    } catch { channel.port1.postMessage({ id: message.id, ok: false }); }
    finally {
      for (const arg of message.args) {
        if (arg instanceof Uint8Array) arg.fill(0);
        else if (arg && typeof arg === "object" && "bytes" in arg && arg.bytes instanceof Uint8Array) arg.bytes.fill(0);
      }
      if (value instanceof Uint8Array) value.fill(0);
    }
  });
  const executor = new ProjectStoreExecutor({ workerUrl: WORKER_URL, context: f.projectContext, freshStart: f.admission.trusted,
    maxPending: 128, requestTimeoutMs: 15_000, closeTimeoutMs: 5_000, executorLeaseMs: 15_000, heartbeatIntervalMs: 5_000 },
    { workerFactory: () => worker as WorkerLike });
  try { await executor.open(); } catch (error) { await executor.close(); await exited; throw error; }
  return { executor, exits, async close() { await executor.close(); await exited; assert.equal(exits.length, 1); } };
}

function command(sessionId: string) {
  return { version: 1 as const, commandType: "retain-evidence-batch" as const, commandId: randomUUID(), idempotencyKey: randomUUID(),
    targetSessionId: sessionId, conversationId: randomUUID(), frames: [{ frameId: randomUUID(), ordinal: "0", role: "user" as const,
      category: "user-message" as const, occurredAt: "2026-10-03T00:00:00.000Z", mediaType: "text/plain; charset=utf-8" as const,
      content: "synthetic visible frame", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }] };
}
test("private wire preserves original command and separately protected proof", async () => {
  const fixture = await makeRetainedEvidenceFixture();
  try {
    const original = command(fixture.rootAuthority.sessionId), invocation = fixture.invocation(original);
    try {
      const wire = encodePreparedRetainedEvidenceCommand({ command: invocation.input.command, authorization: invocation.authorization });
      assert.equal(typeof wire.command, "string");
      const decoded = decodePreparedRetainedEvidenceCommand(wire);
      assert.equal(decoded.command.commandId, original.commandId);
      assert.deepEqual(decoded.authorization, invocation.authorization);
    } finally { invocation.input.canonicalOriginalBytes.fill(0); }
  } finally { await fixture.cleanup(); }
});
test("private wire rejects weakened authorization and caller hash", () => {
  const original = command(randomUUID());
  for (const authorization of [ { kind: "initial-authority", authoritySessionId: null, targetSessionId: null, proof: null, approval: null, childBindingGrant: null },
    { kind: "protected", authoritySessionId: original.targetSessionId, targetSessionId: original.targetSessionId, proof: null, approval: null, childBindingGrant: null } ]) {
    assert.throws(() => encodePreparedRetainedEvidenceCommand({ command: original, authorization }), { code: "SESSION_CAPABILITY_INVALID" });
  }
  assert.throws(() => encodePreparedRetainedEvidenceCommand({ command: original, authorization: {}, candidateIntentHash: "a".repeat(64) }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
});

test("private physical text rejects noncanonical, oversized and policy/provider selectors", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const p = prepared(f, command(f.rootAuthority.sessionId)), wire = encodePreparedRetainedEvidenceCommand(p);
    assert.throws(() => decodePreparedRetainedEvidenceCommand({ ...wire, command: ` ${wire.command}` }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
    assert.throws(() => decodePreparedRetainedEvidenceCommand({ ...wire, command: " ".repeat(1_048_577) }), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    for (const key of ["provider", "policy", "candidateIntentHash"]) assert.throws(() => encodePreparedRetainedEvidenceCommand({ ...p, [key]: {} }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
    assert.throws(() => assertRetainedEvidenceWireSize({ value: "x".repeat(4 * 1024 * 1024) }), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    assert.throws(() => decodePreparedRetainedEvidenceCommand({ ...wire, authorization: { ...wire.authorization, targetSessionId: randomUUID() } }), { code: "SESSION_CAPABILITY_INVALID" });
  } finally { await f.cleanup(); }
});
test("decoded private request owns its command text and protected authorization snapshot", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const encoded = encodePreparedRetainedEvidenceCommand(prepared(f, command(f.rootAuthority.sessionId)));
    const wire = { command: encoded.command, authorization: { ...encoded.authorization, proof: { ...encoded.authorization.proof! } } };
    const decoded = decodeWorkerRequest({ id: "r", type: "retained-evidence", binding: encodeWorkerBindingAssertion(f.projectContext), prepared: wire });
    assert.equal(decoded.type, "retained-evidence"); if (decoded.type !== "retained-evidence") throw new Error("wrong lane");
    const expected = decoded.prepared.command;
    wire.command = "{}"; wire.authorization.proof.proofFingerprint = "b".repeat(64);
    assert.ok(decoded.prepared.command === expected);
    assert.notEqual(decoded.prepared.authorization.proof!.proofFingerprint, "b".repeat(64));
  } finally { await f.cleanup(); }
});

test("native private worker dispatch and reopened executor replay preserve exact receipt and ciphertext", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const original = command(f.rootAuthority.sessionId), firstWorker = await nativeExecutor(f);
    let first;
    try { first = await firstWorker.executor.retainEvidence(prepared(f, original)); assert.equal(first.deduplicated, false); }
    finally { await firstWorker.close(); }
    const ciphertext = f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json;
    const reopened = await nativeExecutor(f);
    try {
      const replay = await reopened.executor.retainEvidence(prepared(f, original));
      assert.equal(replay.deduplicated, true); assert.deepEqual(replay.response, first.response); assert.deepEqual(replay.eventIds, first.eventIds);
      assert.equal(f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json, ciphertext);
      assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM retained_evidence_blobs").get()!.n, 1n);
    } finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});
test("12,000-deep valid canonical JSON crosses native private worker and commits one encrypted item", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    let content: unknown = null; for (let index = 0; index < 12_000; index++) content = [content];
    const original = command(f.rootAuthority.sessionId);
    const deep = { ...original, frames: [{ ...original.frames[0]!, mediaType: "application/json", content }] };
    const worker = await nativeExecutor(f);
    try {
      const result = await worker.executor.retainEvidence(prepared(f, deep));
      assert.equal(result.response.commandId, original.commandId); assert.equal(result.response.evidenceIds.length, 1);
      assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM retained_evidence_blobs").get()!.n, 1n);
    } finally { await worker.close(); }
  } finally { await f.cleanup(); }
});
test("missing private composition refuses independently of fixture success", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const before = f.rows(), worker = await nativeExecutor(f, false);
    try { await assert.rejects(worker.executor.retainEvidence(prepared(f, command(f.rootAuthority.sessionId))), { code: "RETAINED_EVIDENCE_UNAVAILABLE" }); }
    finally { await worker.close(); }
    assert.deepEqual(f.rows(), before);
  } finally { await f.cleanup(); }
});
test("complete safe result envelope has an exact 16,384-byte cap and closed failures", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const p = prepared(f, command(f.rootAuthority.sessionId));
    const runtime = factory(f).create({ connection: f.connection, maintenanceFence: new MaintenanceFence(), keyProvider: f.lifecycle.broker });
    const data = encodeAppendResultWire(runtime.execute(p, f.projectContext));
    const overhead = Buffer.byteLength(JSON.stringify({ id: "", ok: true, data }));
    const id = "r".repeat(16_384 - overhead);
    assert.equal(Buffer.byteLength(JSON.stringify({ id, ok: true, data })), 16_384);
    assert.equal(decodeRetainedEvidenceWorkerResponse({ id, ok: true, data }, id, p).ok, true);
    assert.throws(() => decodeRetainedEvidenceWorkerResponse({ id: id + "r", ok: true, data }, id + "r", p), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    for (const error of [{ code: "NATIVE_SECRET", message: "NATIVE_SECRET", details: {} }, { code: "SQLITE_BUSY", message: "unsafe synthetic message", details: {} },
      { code: "SQLITE_BUSY", message: "SQLITE_BUSY", details: { retryable: true } }]) assert.throws(() => decodeRetainedEvidenceWorkerResponse({ id: "r", ok: false, error }, "r", p));
  } finally { await f.cleanup(); }
});
test("backend retries only fully rolled-back primary busy with original input and bounded deadline", async () => {
  const f = await makeRetainedEvidenceFixture();
  let attempts = 0;
  try {
    const before = f.rows();
    const backend = await openedBackend(f, factory(f, { hit(boundary) {
      if (boundary === "before-begin") { attempts++; assert.deepEqual(f.rows(), before); }
      if (boundary === "before-commit" && attempts < 3) throw Object.assign(new Error("synthetic primary busy"), { errcode: 5 });
    } }));
    try {
      const result = await backend.dispatch(request(f, command(f.rootAuthority.sessionId)));
      assert.equal(attempts, 3); assert.ok("response" in result);
      assert.equal(f.rows().retained_evidence_blobs!.length, 1);
    } finally { await backend.close(); }
    const refused = await openedBackend(f, factory(f, { hit(boundary) { if (boundary === "before-begin") attempts++;
      if (boundary === "before-commit") throw Object.assign(new Error("synthetic busy deadline"), { errcode: 5 }); } }), 1);
    const start = attempts;
    try { await assert.rejects(refused.dispatch(request(f, command(f.rootAuthority.sessionId))), { code: "SQLITE_BUSY" }); assert.equal(attempts, start + 1); }
    finally { await refused.close(); }
  } finally { await f.cleanup(); }
});
test("backend never retries after uncertain successful commit and reopens original result", async () => {
  const f = await makeRetainedEvidenceFixture(); let attempts = 0;
  try {
    const original = command(f.rootAuthority.sessionId);
    const backend = await openedBackend(f, factory(f, { hit(boundary) {
      if (boundary === "before-begin") attempts++;
      if (boundary === "after-commit-before-response") throw Object.assign(new Error("synthetic primary busy after commit"), { errcode: 5 });
    } }));
    try { await assert.rejects(backend.dispatch(request(f, original)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: original.commandId, idempotencyKey: original.idempotencyKey } }); assert.equal(attempts, 1); }
    finally { await backend.close(); }
    const reopened = await openedBackend(f, factory(f));
    try { const recovered = await reopened.dispatch(request(f, original)); assert.ok("deduplicated" in recovered && recovered.deduplicated); }
    finally { await reopened.close(); }
    assert.equal(f.rows().retained_evidence_blobs!.length, 1);
  } finally { await f.cleanup(); }
});
test("failed rollback and uncertain native COMMIT never retry and retain original recovery IDs", async () => {
  for (const mode of ["rollback", "commit"] as const) {
    const f = await makeRetainedEvidenceFixture(); let attempts = 0, armed = false;
    try {
      const original = command(f.rootAuthority.sessionId), before = f.rows();
      const baseFactory = factory(f, { hit(boundary) {
        if (boundary === "before-begin") { attempts++; armed = true; }
        if (mode === "rollback" && boundary === "before-commit") throw Object.assign(new Error("synthetic rollback precursor"), { errcode: 5 });
      } });
      const backend = await openedBackend(f, { create(input) {
        const exec = input.connection.exec.bind(input.connection);
        input.connection.exec = sql => {
          if (armed && sql === (mode === "rollback" ? "ROLLBACK" : "COMMIT")) throw new Error("synthetic native boundary failure");
          return exec(sql);
        };
        return baseFactory.create(input);
      } });
      try { await assert.rejects(backend.dispatch(request(f, original)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: original.commandId, idempotencyKey: original.idempotencyKey } }); assert.equal(attempts, 1); }
      finally { await backend.close(); }
      assert.deepEqual(f.rows(), before);
    } finally { await f.cleanup(); }
  }
});
test("trusted factory, provider and native exceptions become nonsecret closed errors with no retry", async () => {
  const f = await makeRetainedEvidenceFixture();
  const marker = "synthetic-exception-message-must-stay-private";
  try {
    await assert.rejects(openedBackend(f, { create() { throw Object.assign(new Error(marker), { code: "NATIVE_SECRET", details: { content: marker } }); } }), { code: "RETAINED_EVIDENCE_UNAVAILABLE", message: "RETAINED_EVIDENCE_UNAVAILABLE" });
    const before = f.rows(); let attempts = 0;
    const backend = await openedBackend(f, factory(f, { hit(boundary) { if (boundary === "before-begin") attempts++; if (boundary === "before-commit") throw new Error(marker); } }));
    try { await assert.rejects(backend.dispatch(request(f, command(f.rootAuthority.sessionId))), { code: "RETAINED_EVIDENCE_UNAVAILABLE", message: "RETAINED_EVIDENCE_UNAVAILABLE" }); assert.equal(attempts, 1); }
    finally { await backend.close(); }
    const old = f.provider.currentKey;
    f.provider.currentKey = () => { throw new Error(marker); };
    const providerBackend = await openedBackend(f, factory(f));
    try { await assert.rejects(providerBackend.dispatch(request(f, command(f.rootAuthority.sessionId))), { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE", message: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" }); }
    finally { f.provider.currentKey = old; await providerBackend.close(); }
    assert.deepEqual(f.rows(), before);
  } finally { await f.cleanup(); }
});
test("shape-valid forged proof cannot grant provider access or durable writes", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const before = f.rows(), currentCalls = f.provider.calls.current, backend = await openedBackend(f, factory(f));
    const p = prepared(f, command(f.rootAuthority.sessionId));
    try {
      const wire = encodePreparedRetainedEvidenceCommand({ ...p, authorization: { ...p.authorization,
        proof: { ...p.authorization.proof!, proofFingerprint: "f".repeat(64) } } });
      await assert.rejects(backend.dispatch(decodeWorkerRequest({ id: "forged", type: "retained-evidence", binding: encodeWorkerBindingAssertion(f.projectContext), prepared: wire })), { code: "SESSION_CAPABILITY_INVALID" });
      assert.equal(f.provider.calls.current, currentCalls); assert.deepEqual(f.rows(), before);
    } finally { await backend.close(); }
  } finally { await f.cleanup(); }
});
test("factory applies actual prepared recovery and disabled fresh-start mutation admission", async () => {
  for (const mode of ["prepared", "read-only-recovery", "disabled"] as const) {
    const f = await makeRetainedEvidenceFixture();
    try {
      const p = prepared(f, command(f.rootAuthority.sessionId));
      f.admission.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: mode === "prepared" ? "disabled" : mode, reasonCode: "privacy-failure" });
      if (mode === "prepared") await f.admission.control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 2n, expectedMode: "disabled", expectedReleaseId: f.admission.release.releaseId,
        nextMode: "prepared", nextRelease: f.admission.release, approvalEnvelope: new Uint8Array([1]) });
      const before = f.rows(), connection = new NodeSqliteDriver({ DatabaseSync }).open(f.path, { mode: "existing", busyTimeoutMs: 1000 });
      try {
        bindFreshStartAdmissionContext(connection, { ...f.admission.trusted, generation: mode === "prepared" ? 3n : 2n });
        const runtime = factory(f).create({ connection, maintenanceFence: new MaintenanceFence(), keyProvider: f.lifecycle.broker });
        assert.throws(() => runtime.execute(p, f.projectContext), { code: "FRESH_START_ADMISSION_DENIED" });
        assert.deepEqual(f.rows(), before);
      } finally { connection.close(); }
    } finally { await f.cleanup(); }
  }
});
