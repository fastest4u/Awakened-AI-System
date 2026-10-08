import assert from "node:assert/strict";
import test from "node:test";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";
import { encodePreparedGovernedNoteCreateV1, encodePreparedGovernedNoteRecoveryV1 } from "../src/orchestrator/governed-notes/codec.js";
import { decodeWorkerRequest, decodeWorkerResponse, encodeWorkerBindingAssertion, encodeAppendResultWire } from "../src/orchestrator/runtime/worker-protocol.js";

test("canonical transport exceeds scalar cap without bypassing semantic limits", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const prepared = f.prepareCreate(f.command({ summary: "x".repeat(2048) }));
    const wire = encodePreparedGovernedNoteCreateV1(prepared);
    assert.ok(Buffer.byteLength(wire.command) > 2048);
    const decoded = decodeWorkerRequest({ id: "create", type: "governed-note-create", binding: encodeWorkerBindingAssertion(f.rootContext), prepared: wire });
    assert.equal(decoded.type, "governed-note-create");
    assert.throws(() => encodePreparedGovernedNoteCreateV1({ ...prepared, command: { ...prepared.command, summary: "x".repeat(2049) } }));
  } finally { await f.cleanup(); }
});

test("recovery is a stock independently decoded worker request", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const prepared = f.prepareRecovery(f.command(), new Date(Number(f.clock.nowMs() + 60000n)).toISOString());
    const decoded = decodeWorkerRequest({ id: "recover", type: "governed-note-recover", binding: encodeWorkerBindingAssertion(f.rootContext), prepared: encodePreparedGovernedNoteRecoveryV1(prepared) });
    assert.equal(decoded.type, "governed-note-recover");
  } finally { await f.cleanup(); }
});

test("generic append compatibility cannot bypass governed receipt validation or correlated cap", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command());
    const data = encodeAppendResultWire(f.service().create(p, f.rootContext));
    const request = { ...req(f, p), id: "r" };
    assert.throws(() => decodeWorkerResponse({ id: "r", ok: true, data: { ...data, response: { ...data.response as object, replay: true } } }, request));
    const oversized = { ...request, id: "x".repeat(16384) };
    assert.throws(() => decodeWorkerResponse({ id: oversized.id, ok: true, data }, oversized));
  } finally { await f.cleanup(); }
});

import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ProjectStoreExecutor, type WorkerLike, type ExecutorScheduler } from "../src/orchestrator/runtime/project-store-executor.js";
import { ProjectStoreWorkerBackend, type ProjectStoreWorkerBackendOptions } from "../src/orchestrator/runtime/project-store-worker-backend.js";
import { ProjectStoreWorkerRuntime } from "../src/orchestrator/runtime/project-store-worker-runtime.js";
import { encodeWorkerBinding, encodeFreshStartContextWire, decodeWorkerResponseForRequest, type WorkerRequest } from "../src/orchestrator/runtime/worker-protocol.js";
import { GovernedNoteRuntimeFactory, type GovernedNoteRuntimeFactoryOptions } from "../src/orchestrator/governed-notes/runtime.factory.js";
import { GovernedNoteError, GOVERNED_NOTE_ERROR_CODES, isRecoveryIdErrorCode } from "../src/orchestrator/governed-notes/errors.js";
import { decodeGovernedNoteCreateSuccessV1, decodeGovernedNoteRecoverySuccessV1, decodeGovernedNoteWorkerResponse, type GovernedNoteWorkerRequest } from "../src/orchestrator/governed-notes/worker-protocol.js";
import type { GovernedNoteRecoveryIdsV1, PreparedGovernedNoteCreateV1, PreparedGovernedNoteRecoveryV1, GovernedNoteRuntimeFactoryPort } from "../src/orchestrator/governed-notes/contracts.js";
import type { GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import type { RetainedEvidenceRuntimeCreateInput } from "../src/orchestrator/privacy/retained-evidence-runtime.factory.js";

const SELF = new URL("../src/workers/project-store.worker.js", import.meta.url);
const SECRET = "private-provider-exception-do-not-copy";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
class Scheduler implements ExecutorScheduler {
  readonly timers = new Map<object, { callback: () => void; delay: number }>();
  setTimeout(callback: () => void, delay: number) { const handle = {}; this.timers.set(handle, { callback, delay }); return handle; }
  clearTimeout(handle: object) { this.timers.delete(handle); }
  fire() { const entry = this.timers.entries().next().value; assert.ok(entry); this.timers.delete(entry[0]); entry[1].callback(); }
}
class FakeWorker extends EventEmitter implements WorkerLike {
  posted: WorkerRequest[] = []; terminateCalls = 0; throwOnPost = false;
  termination = deferred<number>();
  postMessage(value: unknown) { if (this.throwOnPost) throw new Error(SECRET); this.posted.push(value as WorkerRequest); }
  terminate() { this.terminateCalls++; return this.termination.promise; }
  respond(request: WorkerRequest, data: unknown) { this.emit("message", { id: request.id, ok: true, data }); }
}
async function parent(f: GovernedNoteDomainFixtureV1, maxPending = 128) {
  const worker = new FakeWorker(), scheduler = new Scheduler();
  const executor = new ProjectStoreExecutor({ workerUrl: SELF, context: f.rootContext, maxPending, requestTimeoutMs: 15000, closeTimeoutMs: 5000,
    executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 15000 }, { workerFactory: () => worker, scheduler, randomId: randomUUID });
  const opened = executor.open(), request = worker.posted.at(-1)!;
  worker.respond(request, { ...encodeWorkerBindingAssertion(f.rootContext), executorId: randomUUID() }); await opened;
  return { executor, worker, scheduler, async dispose() { worker.emit("exit", 1); worker.termination.resolve(1); await executor.close(); } };
}
function ids(p: PreparedGovernedNoteCreateV1): GovernedNoteRecoveryIdsV1 { return { commandId: p.command.commandId, idempotencyKey: p.command.idempotencyKey }; }
function recovery(f: GovernedNoteDomainFixtureV1, p: PreparedGovernedNoteCreateV1) { return f.prepareRecovery(ids(p), new Date(Number(f.clock.nowMs() + 60000n)).toISOString()); }
function req(f: GovernedNoteDomainFixtureV1, p: PreparedGovernedNoteCreateV1 | PreparedGovernedNoteRecoveryV1): GovernedNoteWorkerRequest {
  const value = "command" in p ? { type: "governed-note-create", prepared: encodePreparedGovernedNoteCreateV1(p) } : { type: "governed-note-recover", prepared: encodePreparedGovernedNoteRecoveryV1(p) };
  return decodeWorkerRequest({ id: randomUUID(), binding: encodeWorkerBindingAssertion(f.rootContext), ...value }) as GovernedNoteWorkerRequest;
}
function factory(f: GovernedNoteDomainFixtureV1, options: Partial<GovernedNoteRuntimeFactoryOptions> = {}) {
  return new GovernedNoteRuntimeFactory({ provider: f.provider, policy: () => f.policy, clock: f.clock, nonceSource: { uuid: randomUUID, bytes: randomBytes }, ...options });
}
async function backend(f: GovernedNoteDomainFixtureV1, runtimeFactory?: GovernedNoteRuntimeFactoryPort, extra: Partial<ProjectStoreWorkerBackendOptions> = {}) {
  const b = new ProjectStoreWorkerBackend({ selfUrl: SELF, executorLeaseMs: 15000, appendRetryDeadlineMs: 15000,
    trustedFreshStartBuildInspector: () => f.retained.admission.trusted.measuredBuildHash, keyProvider: f.retained.lifecycle.broker,
    ...(runtimeFactory ? { governedNoteRuntimeFactory: runtimeFactory } : {}), ...extra });
  await b.dispatch({ id: "open", type: "open", binding: encodeWorkerBinding(f.rootContext), freshStart: encodeFreshStartContextWire(f.retained.admission.trusted) });
  return b;
}
function safe(code: string, details: object = {}) { return (error: unknown) => {
  assert.ok(error instanceof Error && "code" in error && "details" in error);
  assert.equal(error.code, code); assert.equal(error.message, code); assert.deepEqual(error.details, details);
  assert.ok(!JSON.stringify(error).includes(SECRET)); return true;
}; }

test("malformed prepared and full queue post nothing", async () => {
  const f = await makeGovernedNoteDomainFixture(), h = await parent(f, 1);
  try {
    const p = f.prepareCreate(f.command()), posts = h.worker.posted.length;
    await assert.rejects(h.executor.createGovernedNote({ ...p, authorization: { ...p.authorization, proof: null } } as never), safe("GOVERNED_NOTE_INPUT_INVALID"));
    assert.equal(h.worker.posted.length, posts);
    const pending = h.executor.createGovernedNote(p); void pending.catch(() => undefined);
    assert.equal(h.worker.posted.length, posts + 1);
    await assert.rejects(h.executor.createGovernedNote(p), safe("STORE_QUEUE_FULL"));
    await assert.rejects(h.executor.recoverGovernedNoteResult(recovery(f, p)), safe("STORE_QUEUE_FULL"));
    assert.equal(h.worker.posted.length, posts + 1);
    h.scheduler.fire(); await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
  } finally { await h.dispose(); await f.cleanup(); }
});

for (const recover of [false, true]) test(`${recover ? "recovery" : "posted create"} timeout settles before deferred termination with exact outcome`, async () => {
  const f = await makeGovernedNoteDomainFixture(), h = await parent(f);
  try {
    const p = f.prepareCreate(f.command()), pending = recover ? h.executor.recoverGovernedNoteResult(recovery(f, p)) : h.executor.createGovernedNote(p);
    void pending.catch(() => undefined);
    assert.deepEqual([...h.scheduler.timers.values()].map(t => t.delay), [15000]);
    h.scheduler.fire();
    await assert.rejects(pending, safe(recover ? "WORKER_UNAVAILABLE" : "COMMAND_OUTCOME_UNKNOWN", recover ? {} : ids(p)));
    assert.equal(h.worker.terminateCalls, 1); assert.equal(h.executor.canReuse(), false);
    const posts = h.worker.posted.length;
    await assert.rejects(h.executor.createGovernedNote(p)); assert.equal(h.worker.posted.length, posts);
  } finally { await h.dispose(); await f.cleanup(); }
});

test("wrong correlation operation IDs or oversized success poisons posted create", async t => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), data = encodeAppendResultWire(f.service().create(p, f.rootContext));
    for (const mode of ["correlation", "operation", "command", "idempotency", "extra", "oversize", "unsafe-error", "replacement-error", "messageerror", "exit"] as const) await t.test(mode, async () => {
      const h = await parent(f);
      try {
        const pending = h.executor.createGovernedNote(p); void pending.catch(() => undefined);
        const request = h.worker.posted.at(-1)!;
        const changed = { ...data, response: { ...data.response as object } } as typeof data;
        const receipt = changed.response as Record<string, unknown>;
        if (mode === "operation") receipt.operation = "recover-governed-note-result";
        if (mode === "command") receipt.commandId = randomUUID();
        if (mode === "idempotency") receipt.idempotencyKey = randomUUID();
        if (mode === "extra") receipt.replay = false;
        if (mode === "oversize") receipt.scope = { ...(receipt.scope as object), branchRef: "x".repeat(16384) };
        if (mode === "messageerror") h.worker.emit("messageerror", new Error(SECRET));
        else if (mode === "exit") h.worker.emit("exit", 2);
        else if (mode.endsWith("error")) h.worker.emit("message", { id: request.id, ok: false, error: { code: mode === "unsafe-error" ? "SQLITE_BUSY" : "COMMAND_OUTCOME_UNKNOWN", message: mode === "unsafe-error" ? SECRET : "COMMAND_OUTCOME_UNKNOWN", details: mode === "unsafe-error" ? {} : { commandId: randomUUID(), idempotencyKey: randomUUID() } } });
        else h.worker.emit("message", { id: mode === "correlation" ? "wrong" : request.id, ok: true, data: changed });
        await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
        assert.equal(h.executor.canReuse(), false);
      } finally { await h.dispose(); }
    });
  } finally { await f.cleanup(); }
});

test("both response decoders enforce complete correlated cap and exact operation and original IDs", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), data = encodeAppendResultWire(f.service().create(p, f.rootContext));
    const base = req(f, p), overhead = Buffer.byteLength(JSON.stringify({ id: "", ok: true, data }));
    const request = { ...base, id: "r".repeat(16384 - overhead) };
    const envelope = { id: request.id, ok: true, data };
    assert.equal(Buffer.byteLength(JSON.stringify(envelope)), 16384);
    assert.equal(decodeWorkerResponse(envelope, request).ok, true); assert.equal(decodeWorkerResponseForRequest(envelope, request).ok, true);
    for (const decode of [(v: unknown) => decodeWorkerResponse(v, { ...request, id: request.id + "r" }), (v: unknown) => decodeWorkerResponseForRequest(v, { ...request, id: request.id + "r" })]) assert.throws(() => decode({ ...envelope, id: request.id + "r" }));
    const other = { commandId: randomUUID(), idempotencyKey: randomUUID() };
    assert.throws(() => decodeGovernedNoteCreateSuccessV1(data, other));
    const recovered = f.service().recover(recovery(f, p), f.rootContext), recoveryRequest = req(f, recovery(f, p));
    assert.equal(decodeWorkerResponse({ id: recoveryRequest.id, ok: true, data: recovered }, recoveryRequest).ok, true);
    for (const decode of [decodeWorkerResponse, decodeWorkerResponseForRequest]) {
      assert.throws(() => decode({ id: base.id, ok: true, data: recovered }, base));
      assert.throws(() => decode({ id: recoveryRequest.id, ok: true, data }, recoveryRequest));
      assert.throws(() => decode({ id: "wrong-correlation", ok: true, data }, base));
      for (const field of ["commandId", "idempotencyKey", "operation"] as const) {
        const changed = { ...data, response: { ...data.response as object, [field]: field === "operation" ? "unrelated-operation" : randomUUID() } };
        assert.throws(() => decode({ id: base.id, ok: true, data: changed }, base));
      }
    }
    assert.throws(() => decodeWorkerResponseForRequest({ id: base.id, ok: true, data: recovered }, base));
    assert.throws(() => decodeWorkerResponseForRequest({ id: recoveryRequest.id, ok: true, data }, recoveryRequest));
    assert.throws(() => decodeGovernedNoteRecoverySuccessV1(recovered, other));
    if (recovered.outcome !== "committed") assert.fail("missing committed result");
    assert.throws(() => decodeGovernedNoteRecoverySuccessV1({ ...recovered, receipt: { ...recovered.receipt, replay: false } }, ids(p)));
    const absent = { resultVersion: 1, operation: "recover-governed-note-result", outcome: "not-found", ...ids(p) };
    assert.throws(() => decodeGovernedNoteRecoverySuccessV1(absent, other));
  } finally { await f.cleanup(); }
});

test("safe errors require exact message details and original IDs", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), request = req(f, p);
    assert.equal(GOVERNED_NOTE_ERROR_CODES.length, 41);
    for (const code of GOVERNED_NOTE_ERROR_CODES) {
      const details = isRecoveryIdErrorCode(code) ? ids(p) : {};
      const envelope = { id: request.id, ok: false, error: { code, message: code, details } };
      assert.equal(decodeGovernedNoteWorkerResponse(envelope, request).ok, false);
      assert.throws(() => decodeGovernedNoteWorkerResponse({ ...envelope, error: { ...envelope.error, message: SECRET } }, request));
      assert.throws(() => decodeGovernedNoteWorkerResponse({ ...envelope, error: { ...envelope.error, details: { ...details, retryable: true } } }, request));
      if (isRecoveryIdErrorCode(code)) for (const bad of [{}, { commandId: p.command.commandId }, { commandId: randomUUID(), idempotencyKey: p.command.idempotencyKey }]) assert.throws(() => decodeGovernedNoteWorkerResponse({ ...envelope, error: { ...envelope.error, details: bad } }, request));
    }
  } finally { await f.cleanup(); }
});

test("pre-post post-failure closed and rebound paths are sanitized and never invent cancellation", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command());
    for (const mode of ["post", "closed", "rebound"] as const) {
      const h = await parent(f);
      try {
        let prior: Promise<unknown> | undefined;
        if (mode === "post") { prior = h.executor.createGovernedNote(p); void prior.catch(() => undefined); h.worker.throwOnPost = true; }
        if (mode === "closed") { h.worker.emit("exit", 0); }
        if (mode === "rebound") { h.worker.termination.resolve(1); await h.executor.invalidateForRebind(f.rootContext); }
        const before = h.worker.posted.length;
        await assert.rejects(h.executor.createGovernedNote(p), safe(mode === "rebound" ? "PROJECT_BINDING_REQUIRED" : "WORKER_UNAVAILABLE"));
        assert.equal(h.worker.posted.length, before);
        if (prior) await assert.rejects(prior, safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
      } finally { await h.dispose(); }
    }
  } finally { await f.cleanup(); }
});

test("healthy create and detached recovery delivery preserve results even after proof expiry", async () => {
  const f = await makeGovernedNoteDomainFixture(), h = await parent(f);
  try {
    const p = f.prepareCreate(f.command({ summary: "x".repeat(2048) })), stored = f.service().create(p, f.rootContext);
    const before = h.worker.posted.length, pending = h.executor.createGovernedNote(p);
    assert.equal(h.worker.posted.length, before + 1);
    h.worker.respond(h.worker.posted.at(-1)!, encodeAppendResultWire(stored));
    const result = await pending; assert.deepEqual(result, stored); assert.equal("replay" in result.response, false);
    const r = recovery(f, p), detached = f.service().recover(r, f.rootContext), recovering = h.executor.recoverGovernedNoteResult(r);
    f.clock.advance(60001n); h.worker.respond(h.worker.posted.at(-1)!, detached);
    assert.deepEqual(await recovering, detached); assert.equal(h.executor.canReuse(), true);
  } finally { await h.dispose(); await f.cleanup(); }
});

test("all factories share one exact connection fence and key provider; nonce source allocates actual planned IDs", async () => {
  const f = await makeGovernedNoteDomainFixture();
  const inputs: RetainedEvidenceRuntimeCreateInput[] = [], allocated: string[] = [];
  const actual = factory(f, { nonceSource: { bytes: randomBytes, uuid: () => { const id = randomUUID(); allocated.push(id); return id; } } });
  const b = await backend(f, { create(input) { inputs.push(input); return actual.create(input); } }, {
    lifecycleRuntimeFactory: { create(input) { inputs.push(input); return { async execute() { throw new Error("unsupported lifecycle operation"); }, dispose() {} }; } },
    retainedEvidenceRuntimeFactory: { create(input) { inputs.push(input); return { execute() { throw new Error("unsupported retained operation"); } }; } },
  });
  try {
    assert.equal(inputs.length, 3);
    for (const input of inputs) { assert.strictEqual(input.connection, inputs[0]!.connection); assert.strictEqual(input.maintenanceFence, inputs[0]!.maintenanceFence); assert.strictEqual(input.keyProvider, f.retained.lifecycle.broker); }
    assert.notStrictEqual(inputs[0]!.connection, f.connection);
    assert.equal(inputs[0]!.connection.prepare("PRAGMA busy_timeout").get()!.timeout, 5000n);
    const p = f.prepareCreate(f.command()), before = f.rows(), result = await b.dispatch(req(f, p));
    assert.ok("response" in result);
    const receipt = result.response as { recordId: string; sourceEventIds: string[] };
    assert.deepEqual([receipt.recordId, ...receipt.sourceEventIds].sort(), [...allocated].sort()); assert.equal(allocated.length, 3);
    assert.equal(f.rows().events - before.events, 2); assert.equal(f.rows().dedup - before.dedup, 1); assert.equal(f.rows().outbox, before.outbox);
    const rows = f.rowContents(), recovered = await b.dispatch(req(f, recovery(f, p)));
    assert.ok("outcome" in recovered && recovered.outcome === "committed"); assert.equal(recovered.receipt.replay, true);
    assert.equal(f.rowContents(), rows);
  } finally { await b.close(); await f.cleanup(); }
});

test("missing governed factory refuses without write; closed and rebound backend failures have empty details", async () => {
  const f = await makeGovernedNoteDomainFixture(), b = await backend(f);
  try {
    const p = f.prepareCreate(f.command()), request = req(f, p), before = f.rowContents();
    await assert.rejects(b.dispatch(request), safe("GOVERNED_NOTE_UNAVAILABLE"));
    await assert.rejects(b.dispatch(req(f, recovery(f, p))), safe("GOVERNED_NOTE_UNAVAILABLE"));
    await assert.rejects(b.dispatch({ ...request, binding: { ...request.binding, bindingGeneration: request.binding.bindingGeneration + 1 } }), safe("PROJECT_BINDING_REQUIRED"));
    assert.equal(f.rowContents(), before);
    await b.close(); await assert.rejects(b.dispatch(request), safe("WORKER_CLOSED"));
  } finally { await b.close(); await f.cleanup(); }
});

test("factory exceptions are unavailable and disclose no provider text", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try { const before = f.rowContents(); await assert.rejects(backend(f, { create() { throw new Error(SECRET); } }), safe("GOVERNED_NOTE_UNAVAILABLE")); assert.equal(f.rowContents(), before); }
  finally { await f.cleanup(); }
});

for (const source of ["policy", "currentKey", "status", "mac", "capability-verify", "capability-status"] as const) test(`worker-local ${source} exception is sanitized`, async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command());
    let calls = 0;
    const proxy = <T extends object>(target: T, method: string): T => new Proxy(target, { get(object, key) {
      if (key === method) return () => { calls++; throw new Error(SECRET); };
      const value: unknown = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
    } });
    const cap = source.startsWith("capability-");
    const b = await backend(f, factory(f, source === "policy" ? { policy: () => { calls++; throw new Error(SECRET); } } : cap ? {} : { provider: proxy(f.provider, source) }),
      cap ? { keyProvider: proxy(f.retained.lifecycle.broker, source.slice("capability-".length)) } : {});
    try {
      const before = f.rowContents();
      let result: unknown;
      try { result = await b.dispatch(req(f, p)); } catch (error) { result = error; }
      assert.ok(calls > 0);
      { assert.ok(result instanceof GovernedNoteError); assert.equal(result.message, result.code); assert.ok(!JSON.stringify(result).includes(SECRET)); assert.ok(GOVERNED_NOTE_ERROR_CODES.includes(result.code)); assert.deepEqual(result.details, isRecoveryIdErrorCode(result.code) ? ids(p) : {}); assert.equal(f.rowContents(), before); }
    } finally { await b.close(); }
  } finally { await f.cleanup(); }
});

test("classified observed BEGIN busy retries in place before later FIFO request", async () => {
  const f = await makeGovernedNoteDomainFixture();
  const calls: string[] = []; let attempted = 0, busy: unknown;
  const actual = factory(f);
  const b = await backend(f, { create(input) {
    const exec = input.connection.exec.bind(input.connection);
    input.connection.exec = sql => {
      if (sql === "BEGIN IMMEDIATE" && attempted > 0) {
        attempted++;
        if (attempted === 2) {
          f.connection.exec("BEGIN IMMEDIATE");
          try { return exec(sql); } catch (error) { busy = error; throw error; }
          finally { f.connection.exec("ROLLBACK"); }
        }
      }
      return exec(sql);
    };
    const runtime = actual.create(input);
    return { create(p, context) { calls.push("create"); return runtime.create(p, context); }, recover(p, context) { calls.push("recover"); return runtime.recover(p, context); } };
  } });
  const output: unknown[] = [], runtime = new ProjectStoreWorkerRuntime({ backend: b, port: { postMessage(v) { output.push(v); }, close() {} }, scheduler: { setInterval() { return {}; }, clearInterval() {} }, heartbeatIntervalMs: 5000 });
  try {
    const p = f.prepareCreate(f.command()), a = req(f, p), r = req(f, recovery(f, p));
    attempted = 1;
    runtime.receive(a); runtime.receive(r);
    for (let i = 0; i < 100 && output.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(busy && typeof busy === "object" && "errcode" in busy && busy.errcode === 5);
    assert.equal(attempted, 3); assert.deepEqual(calls, ["create", "create", "recover"]);
    assert.equal(output.length, 2);
    assert.equal(decodeWorkerResponseForRequest(output[0], a).ok, true); assert.equal(decodeWorkerResponseForRequest(output[1], r).ok, true);
  } finally { await b.close(); await f.cleanup(); }
});

for (const point of ["before-begin", "after-note-event", "before-commit", "after-commit-before-response"] as const) test(`raw busy at ${point} never retries`, async () => {
  const f = await makeGovernedNoteDomainFixture(); let attempts = 0;
  const b = await backend(f, factory(f, { faults: { inject(hit) { if (hit === "before-begin") attempts++; if (hit === point) throw Object.assign(new Error(SECRET), { errcode: 5 }); } } }));
  try {
    const p = f.prepareCreate(f.command()), before = f.rows();
    await assert.rejects(b.dispatch(req(f, p)), safe(point === "after-commit-before-response" ? "COMMAND_OUTCOME_UNKNOWN" : "GOVERNED_NOTE_UNAVAILABLE", point === "after-commit-before-response" ? ids(p) : {}));
    assert.equal(attempts, 1);
    assert.equal(f.rows().events - before.events, point === "after-commit-before-response" ? 2 : 0);
  } finally { await b.close(); await f.cleanup(); }
});

test("possible COMMIT never retries and preserves original IDs", async () => {
  const f = await makeGovernedNoteDomainFixture(); let attempts = 0, armed = false;
  const actual = factory(f, { faults: { inject(point) { if (point === "before-begin") attempts++; if (point === "before-commit") armed = true; } } });
  const b = await backend(f, { create(input) {
    const exec = input.connection.exec.bind(input.connection);
    input.connection.exec = sql => { if (armed && sql === "COMMIT") { exec(sql); throw Object.assign(new Error(SECRET), { errcode: 5 }); } return exec(sql); };
    return actual.create(input);
  } });
  try {
    const p = f.prepareCreate(f.command()), before = f.rows();
    await assert.rejects(b.dispatch(req(f, p)), safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
    assert.equal(attempts, 1); assert.equal(f.rows().events - before.events, 2);
  } finally { await b.close(); await f.cleanup(); }
});

test("FIFO consumes R while retry budget starts after dequeue and late work is not reported cancelled", async () => {
  const f = await makeGovernedNoteDomainFixture(), h = await parent(f);
  const gate = deferred<void>(), entered = deferred<void>(); const calls: string[] = []; let nowCalls = 0;
  const originalNow = Date.now;
  const b = await backend(f, factory(f));
  const rt = new ProjectStoreWorkerRuntime({ backend: { dispatch: async request => {
    calls.push(request.type);
    if (request.type === "ping") { entered.resolve(); await gate.promise; return { nodeVersion: "24.2.0", sqliteVersion: "3.50.0", walSafe: true }; }
    return b.dispatch(request);
  }, heartbeat: () => b.heartbeat(), close: () => b.close(), quiesceAndClose: (...args) => b.quiesceAndClose(...args), quiesceObservedAndClose: lease => b.quiesceObservedAndClose(lease) },
  port: { postMessage(value) { const v = value as { id: string }; if (v.id !== "gate") h.worker.emit("message", value); }, close() {} },
  scheduler: { setInterval() { return {}; }, clearInterval() {} }, heartbeatIntervalMs: 5000 });
  try {
    const p = f.prepareCreate(f.command()), before = f.rows();
    rt.receive({ id: "gate", type: "ping" }); await entered.promise;
    Date.now = () => { nowCalls++; return 1000000; };
    const pending = h.executor.createGovernedNote(p); void pending.catch(() => undefined);
    rt.receive(h.worker.posted.at(-1)!); await turn();
    assert.deepEqual(calls, ["ping"]); assert.equal(nowCalls, 0);
    h.scheduler.fire(); await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
    assert.equal(h.worker.terminateCalls, 1); assert.equal(f.rows().events, before.events);
    gate.resolve(); await turn(); await turn();
    assert.deepEqual(calls, ["ping", "governed-note-create"]); assert.ok(nowCalls >= 1);
    assert.equal(f.rows().events - before.events, 2); assert.equal(h.executor.canReuse(), false);
  } finally { Date.now = originalNow; gate.resolve(); await b.close(); await h.dispose(); await f.cleanup(); }
});

test("early quiescing and backend raw errors emit only closed bounded governed failures", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command());
    for (const mode of ["closing", "quiescing", "raw", "binding"] as const) {
      const output: unknown[] = [], gate = deferred<void>(); let dispatched = 0;
      const runtime = new ProjectStoreWorkerRuntime({ backend: {
        async dispatch() { dispatched++; throw Object.assign(new Error(SECRET), { code: mode === "binding" ? "PROJECT_BINDING_REQUIRED" : "SECRET_NATIVE", details: { generation: 2, secret: SECRET } }); },
        async heartbeat() { return { mode: "idle" }; }, async close() { await gate.promise; },
        async quiesceAndClose() { await gate.promise; return { executorId: "e", epoch: "1", fencingToken: "1" }; },
        async quiesceObservedAndClose() { throw new Error("unsupported"); },
      }, port: { postMessage(value) { output.push(value); }, close() {} }, scheduler: { setInterval() { return {}; }, clearInterval() {} }, heartbeatIntervalMs: 5000 });
      const request = req(f, p);
      if (mode === "closing") runtime.receive({ id: "close", type: "close" });
      if (mode === "quiescing") runtime.receive({ id: "q", type: "quiesce", binding: request.binding, lease: { epoch: "1", fencingToken: "1", ownerId: "owner", leaseExpiresAt: "2026-10-10T00:00:00.000Z" } });
      runtime.receive(request); await turn();
      const response = decodeWorkerResponseForRequest(output.find(v => (v as { id: string }).id === request.id), request);
      assert.equal(response.ok, false); if (response.ok) assert.fail();
      assert.equal(response.error.code, mode === "binding" ? "PROJECT_BINDING_REQUIRED" : mode === "raw" ? "GOVERNED_NOTE_UNAVAILABLE" : "MAINTENANCE_QUIESCING");
      assert.deepEqual(response.error.details, {}); assert.ok(!JSON.stringify(output).includes(SECRET));
      assert.equal(dispatched, mode === "raw" || mode === "binding" ? 1 : 0);
      gate.resolve(); await turn();
    }
  } finally { await f.cleanup(); }
});

test("posted integrity refusal is unknown and poisons original create identity", async () => {
  const f = await makeGovernedNoteDomainFixture(), h = await parent(f);
  try {
    const p = f.prepareCreate(f.command()), pending = h.executor.createGovernedNote(p);
    const request = h.worker.posted.at(-1)!;
    h.worker.emit("message", { id: request.id, ok: false, error: { code: "INTEGRITY_FAILURE", message: "INTEGRITY_FAILURE", details: {} } });
    await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p))); assert.equal(h.executor.canReuse(), false);
  } finally { await h.dispose(); await f.cleanup(); }
});

test("receipt scope must match outer binding and authorized session before parent delivery", async t => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), data = encodeAppendResultWire(f.service().create(p, f.rootContext));
    for (const field of ["projectId", "vaultId", "storeId", "workspaceId", "sessionId", "branchRef", "branchScopeId"] as const) await t.test(field, async () => {
      const h = await parent(f);
      try {
        const pending = h.executor.createGovernedNote(p), receipt = data.response as Record<string, unknown>;
        h.worker.respond(h.worker.posted.at(-1)!, { ...data, response: { ...receipt, scope: { ...receipt.scope as object, [field]: field === "workspaceId" ? "a".repeat(64) : randomUUID() } } });
        await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p))); assert.equal(h.executor.canReuse(), false);
      } finally { await h.dispose(); }
    });
  } finally { await f.cleanup(); }
});

import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
test("worker independently rejects noncanonical semantic overflow and authorization overflow without backend dispatch", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), wire = encodePreparedGovernedNoteCreateV1(p);
    const oversize = { ...p.command, summary: '"'.repeat(2048), provenance: Array.from({ length: 64 }, () => ({ kind: "retained-evidence", identity: randomUUID() })) };
    assert.ok(Buffer.byteLength(canonicalJson(oversize)) > 8192);
    for (const prepared of [{ ...wire, command: " " + wire.command }, { ...wire, command: canonicalJson(oversize) },
      { ...wire, authorization: { ...wire.authorization, proof: { ...wire.authorization.proof!, proofFingerprint: "x".repeat(16385) } } }]) {
      let dispatches = 0; const out: unknown[] = [];
      const runtime = new ProjectStoreWorkerRuntime({ backend: { async dispatch() { dispatches++; throw new Error("unexpected dispatch"); }, async close() {}, async heartbeat() { return { mode: "idle" }; }, async quiesceAndClose() { throw new Error("unsupported"); }, async quiesceObservedAndClose() { throw new Error("unsupported"); } },
        port: { postMessage(v) { out.push(v); }, close() {} }, scheduler: { setInterval() { return {}; }, clearInterval() {} }, heartbeatIntervalMs: 5000 });
      runtime.receive({ id: "invalid", type: "governed-note-create", binding: encodeWorkerBindingAssertion(f.rootContext), prepared }); await turn();
      assert.equal(dispatches, 0); assert.deepEqual(out, [{ id: "unknown", ok: false, error: { code: "WORKER_PROTOCOL_ERROR", message: "WORKER_PROTOCOL_ERROR", details: {} } }]);
    }
  } finally { await f.cleanup(); }
});

test("admitted original identity survives caller mutation and safe typed pre-effect refusal stays healthy", async () => {
  const f = await makeGovernedNoteDomainFixture(), h = await parent(f);
  try {
    const p = f.prepareCreate(f.command()), mutable = structuredClone(p) as { command: { -readonly [K in keyof typeof p.command]: typeof p.command[K] }; authorization: typeof p.authorization }, pending = h.executor.createGovernedNote(mutable);
    mutable.command.commandId = randomUUID(); mutable.command.idempotencyKey = randomUUID();
    h.scheduler.fire(); await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
  } finally { await h.dispose(); }
  const healthy = await parent(f);
  try {
    const p = f.prepareCreate(f.command()), pending = healthy.executor.createGovernedNote(p);
    healthy.worker.emit("message", { id: healthy.worker.posted.at(-1)!.id, ok: false, error: { code: "SQLITE_BUSY", message: "SQLITE_BUSY", details: {} } });
    await assert.rejects(pending, safe("SQLITE_BUSY")); assert.equal(healthy.executor.canReuse(), true);
  } finally { await healthy.dispose(); await f.cleanup(); }
});

test("not-found recovery returns exact original IDs and malformed recovery never becomes mutation ambiguity", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), r = recovery(f, p), before = f.rowContents(), detached = f.service().recover(r, f.rootContext);
    assert.deepEqual(detached, { resultVersion: 1, operation: "recover-governed-note-result", outcome: "not-found", ...ids(p) });
    assert.equal(f.rowContents(), before);
    for (const malformed of [false, true]) {
      const h = await parent(f);
      try {
        const pending = h.executor.recoverGovernedNoteResult(r);
        h.worker.respond(h.worker.posted.at(-1)!, malformed ? { ...detached, commandId: randomUUID() } : detached);
        if (malformed) { await assert.rejects(pending, safe("WORKER_PROTOCOL_ERROR")); assert.equal(h.executor.canReuse(), false); }
        else { assert.deepEqual(await pending, detached); assert.equal(h.executor.canReuse(), true); }
      } finally { await h.dispose(); }
    }
  } finally { await f.cleanup(); }
});

test("worker validates successful runtime return before transport and preserves create uncertainty", async () => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), output: unknown[] = [];
    const runtime = new ProjectStoreWorkerRuntime({ backend: { async dispatch() { return {} as never; }, async close() {}, async heartbeat() { return { mode: "idle" }; }, async quiesceAndClose() { throw new Error("unsupported"); }, async quiesceObservedAndClose() { throw new Error("unsupported"); } },
      port: { postMessage(v) { output.push(v); }, close() {} }, scheduler: { setInterval() { return {}; }, clearInterval() {} }, heartbeatIntervalMs: 5000 });
    const request = req(f, p); runtime.receive(request); await turn();
    assert.deepEqual(output, [{ id: request.id, ok: false, error: { code: "COMMAND_OUTCOME_UNKNOWN", message: "COMMAND_OUTCOME_UNKNOWN", details: ids(p) } }]);
  } finally { await f.cleanup(); }
});

test("generic decoding never invokes accessors or proxy traps", () => {
  let reads = 0;
  const accessor = (key: string) => Object.defineProperty({}, key, { enumerable: true, get() { reads++; return "recover-governed-note-result"; } });
  for (const data of [accessor("operation"), accessor("response"), { response: accessor("operation") }, new Proxy({}, { getOwnPropertyDescriptor() { reads++; throw new Error(SECRET); } })]) {
    assert.throws(() => decodeWorkerResponse({ id: "hostile", ok: true, data }));
    assert.equal(reads, 0);
  }
});

import type { AppendCommand, JsonValue } from "../src/orchestrator/contracts/event.js";
function ordinaryAppend(f: GovernedNoteDomainFixtureV1, response: JsonValue): AppendCommand<JsonValue> {
  return { context: f.rootContext, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "business.record", correlationId: randomUUID(), agentId: "ordinary-client",
    expectedStreamVersion: 0n, streamId: "business:records", streamType: "business", events: [{ eventType: "BusinessRecordCreated", eventSchemaVersion: 1,
      occurredAt: f.clock.now(), visibilityScope: "project", confidence: "high", verificationStatus: "verified", payload: { accepted: true }, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }],
    outbox: [], publicResponse: response };
}
function ordinaryResult(response: JsonValue) {
  return { deduplicated: false, firstGlobalPosition: "1", lastGlobalPosition: "1", finalStreamVersion: "1", eventIds: [randomUUID()], response, responseHash: "a".repeat(64) };
}
const ordinaryResponses: readonly (readonly [string, JsonValue])[] = [
  ["colliding fields", { recordId: "business-id", sourceEventIds: [] }],
  ["governed create operation literal", { resultVersion: 1, operation: "create-governed-note", recordId: "business-id", sourceEventIds: [] }],
  ["governed recovery operation literal", { resultVersion: 1, operation: "recover-governed-note-result", outcome: "not-found", recordId: "business-id", sourceEventIds: [] }],
  ["ordinary response exceeds governed cap", { operation: "create-governed-note", recordId: "business-id", sourceEventIds: [], message: "x".repeat(16384) }],
  ["nested collision", { response: { recordId: "business-id", sourceEventIds: [] } }],
  ["array", [{ operation: "create-governed-note", recordId: "business-id", sourceEventIds: [] }]],
  ["null", null], ["scalar", "create-governed-note"],
];
test("ordinary arbitrary append JSON remains valid in generic and request-specific decoding", async t => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    for (const [name, response] of ordinaryResponses) {
      const command = ordinaryAppend(f, response), h = await parent(f);
      try {
        const pending = h.executor.append(command); void pending.catch(() => undefined);
        const request = h.worker.posted.at(-1)!, envelope = { id: request.id, ok: true, data: ordinaryResult(response) };
        await t.test(`${name}: request-specific`, () => assert.deepEqual(decodeWorkerResponseForRequest(envelope, request), envelope));
        await t.test(`${name}: generic default`, () => assert.deepEqual(decodeWorkerResponse(envelope), envelope));
        h.worker.emit("exit", 1); await assert.rejects(pending);
      } finally { await h.dispose(); }
    }
  } finally { await f.cleanup(); }
});
test("ordinary append receipt field collisions do not poison the parent owner", async t => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    for (const [name, response] of ordinaryResponses) await t.test(name, async () => {
      const h = await parent(f);
      try {
        const command = ordinaryAppend(f, response), pending = h.executor.append(command), data = ordinaryResult(response);
        h.worker.respond(h.worker.posted.at(-1)!, data);
        const actual = await pending;
        assert.deepEqual(actual.response, response); assert.equal(actual.firstGlobalPosition, 1n); assert.deepEqual(actual.eventIds, data.eventIds);
        assert.equal(h.executor.canReuse(), true); assert.equal(h.worker.terminateCalls, 0);
      } finally { await h.dispose(); }
    });
  } finally { await f.cleanup(); }
});
test("outer envelope proxies are rejected before any generic or parent correlation trap", async t => {
  const f = await makeGovernedNoteDomainFixture();
  try {
    const p = f.prepareCreate(f.command()), data = encodeAppendResultWire(f.service().create(p, f.rootContext));
    for (const boundary of ["generic", "parent"] as const) await t.test(boundary, async () => {
      const h = await parent(f); let traps = 0;
      try {
        const pending = h.executor.createGovernedNote(p), request = h.worker.posted.at(-1)!;
        const proxy = new Proxy({ id: request.id, ok: true, data }, {
          getPrototypeOf() { traps++; throw new Error(SECRET); },
          getOwnPropertyDescriptor() { traps++; throw new Error(SECRET); },
        });
        if (boundary === "generic") { assert.throws(() => decodeWorkerResponse(proxy)); h.worker.emit("exit", 1); }
        else h.worker.emit("message", proxy);
        await assert.rejects(pending, safe("COMMAND_OUTCOME_UNKNOWN", ids(p)));
        assert.equal(traps, 0); assert.equal(h.executor.canReuse(), false);
      } finally { await h.dispose(); }
    });
  } finally { await f.cleanup(); }
});
