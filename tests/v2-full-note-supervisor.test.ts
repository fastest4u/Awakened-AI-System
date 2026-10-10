import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createVerifiedReadAdapter, type OwnedReadProcess } from "../src/orchestrator/verified-read/supervisor.js";
import { VerifiedReadOwnershipRepository } from "../src/orchestrator/verified-read/ownership.js";
import { decodeReadBootstrap } from "../src/orchestrator/verified-read/protocol.js";
import type { CleanupBootstrap, FullNoteReadBootstrapV1, MetadataVerifiedReadRequest } from "../src/orchestrator/verified-read/contracts.js";
import type { GetFullNoteRequest } from "../src/orchestrator/verified-read/full-note-contracts.js";
import { readBootstrap, readReceipt, ownedReadDirectory, READ_HASH } from "./support/v2-verified-read-fixture.js";
const request: GetFullNoteRequest = { operation: "get-full-note", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters: { id: "record" } };
async function until(predicate: () => boolean) { for (let n = 0; n < 300 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), "expected owner barrier"); }
function deferred() { let resolved = false; let resolve!: () => void; const promise = new Promise<void>(done => { resolve = () => { resolved = true; done(); }; }); return { promise, resolve, get resolved() { return resolved; } }; }
class Clock {
  value = 0; timers = new Map<object, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (callback: () => void, ms: number) => { const key = {}; this.timers.set(key, { at: this.value + ms, callback }); return key; };
  clear = (key: unknown) => { this.timers.delete(key as object); };
  advance(ms: number) { this.value += ms; for (const [key, timer] of [...this.timers]) if (timer.at <= this.value) { this.timers.delete(key); timer.callback(); } }
}
class Port implements OwnedReadProcess {
  pid = 123; events = new EventEmitter(); sent: Parameters<OwnedReadProcess["send"]>[0][] = []; kills = 0;
  send(value: Parameters<OwnedReadProcess["send"]>[0]) { this.sent.push(value); }
  private on(name: string, handler: (...args: any[]) => void) { this.events.on(name, handler); return () => { this.events.off(name, handler); }; }
  onMessage = (h: (value: unknown) => void) => this.on("message", h);
  onExit = (h: (code: number | null, signal: string | null) => void) => this.on("close", h);
  onOutput = (h: (stream: "stdout" | "stderr", bytes: Uint8Array) => void) => this.on("output", h);
  onError = (h: (error: unknown) => void) => this.on("error", h);
  terminate() { this.kills++; } unref() {}
  boot() { return this.sent.find(x => "binding" in x) as FullNoteReadBootstrapV1; }
  stages() { for (const phase of ["admission", "projection-wait", "capture", "validate", "query", "revalidate"])
    this.events.emit("message", { version: 4, ids: this.boot().ids, kind: "stage", phase, observedProjectionPosition: "0" }); }
  success(): any {
    const b = this.boot(), body = '"'.repeat(65536), receipt = { ...readReceipt(), operation: "get-full-note", projectionSchemaVersion: 3 };
    const selectionScope = { projectId: receipt.scope.projectId, workspaceId: receipt.scope.workspaceId, branchScopeId: null, branchRef: null, sessionId: null, visibility: "branch" };
    return { version: 4, ids: { ...b.ids }, kind: "success", receipt,
      fence: { controlGeneration: "0", releaseId: receipt.releaseId, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" },
      closed: { image: true, reader: true, lock: true }, content: { operation: "get-full-note", noteBoundsVersion: "v2-full-note-bounds-1", selectionScope, conflict: null,
        item: { id: b.request.parameters?.id ?? "record", kind: "canonical", ...selectionScope, status: "candidate", confidence: "low", verificationMethod: "governed-note-unverified-v2",
          validFrom: null, validTo: null, knownFromEventPosition: "0", sourceEventPosition: "0", textKind: "canonical-summary", text: "Separate summary", conflictGroupId: null, supersedingItemId: null,
          recordKind: "insight", bodyAvailability: "present", content: { format: "markdown", body,
            contentHash: createHash("sha256").update("project-memory/governed-note-body/v1\n").update(JSON.stringify({ body, format: "markdown" })).digest("hex") } } } };
  }
}
async function fixture() {
  const directory = ownedReadDirectory(), clock = new Clock(), ports: Port[] = []; let epoch = "epoch";
  const binding = decodeReadBootstrap({ ...readBootstrap(), binding: { ...readBootstrap().binding, executorStateDirectory: directory } }).binding;
  const ownership = new VerifiedReadOwnershipRepository(directory);
  const adapter = createVerifiedReadAdapter(binding, { ownership, now: clock.now, schedule: clock.schedule, clear: clock.clear, currentEpoch: () => epoch,
    spawnOwned() { const p = new Port(); ports.push(p); return p; } });
  async function cleanupRead() {
    ports[0]!.events.emit("close", 0, null); const cleanup = ports[1];
    if (cleanup) { const b = cleanup.sent[0] as CleanupBootstrap; assert.equal(b.version, 1);
      cleanup.events.emit("message", { version: 1, ids: b.ids, kind: "cleanup", outcome: "absent", cleanup: "complete" }); cleanup.events.emit("close", 0, null); }
    assert.equal((await adapter.close()).cleanup, "complete");
  }
  return { directory, clock, ports, binding, ownership, adapter, cleanupRead, setEpoch(value: string) { epoch = value; },
    async dispose() { const closing = adapter.close(); clock.advance(2100); const d = await closing;
      if (d.cleanup === "complete" && await ownership.inspect() === null) await rm(directory.canonicalPath, { recursive: true });
      else console.error(`Retained uncertain full-note owner fixture: ${directory.canonicalPath}`); } };
}
test("parent full-note candidate waits for native close drain and durable removal", async () => {
  const f = await fixture(), gate = deferred(), reached = deferred(), complete = f.ownership.complete.bind(f.ownership);
  f.ownership.complete = async ids => { reached.resolve(); await gate.promise; return complete(ids); };
  try {
    let delivered = false; const pending = f.adapter.queryFullNote(request); void pending.then(() => { delivered = true; });
    await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!; assert.equal(p.boot().version, 4); p.stages(); const reply = p.success(); p.events.emit("message", reply);
    assert.equal(delivered, false); p.events.emit("exit", 0, null); await new Promise(resolve => setImmediate(resolve)); assert.equal(reached.resolved, false);
    p.events.emit("close", 0, null); await until(() => reached.resolved); assert.equal(delivered, false); assert.notEqual(await f.ownership.inspect(), null);
    reply.content.item.content.body = "mutated after ingress"; gate.resolve(); const out = await pending;
    assert.equal(out.content.item!.content!.body.length, 65536); assert.ok(Object.isFrozen(out.content.item!.content)); assert.equal(await f.ownership.inspect(), null);
  } finally { gate.resolve(); await f.dispose(); }
});
for (const fault of ["old-route", "version", "request-id", "attempt-id", "kind", "operation", "content-operation", "proxy"] as const) test(`parent_correlates_before_large_copy ${fault}`, async t => {
  const f = await fixture(); try {
    const pending = fault === "old-route" ? f.adapter.query({ ...request, operation: "get-canonical-record" }) : f.adapter.queryFullNote(request);
    const rejected = assert.rejects(pending, { code: "WORKER_PROTOCOL_ERROR" }); await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!;
    const reply = p.success(); if (fault === "version") reply.version = 3;
    if (fault === "request-id") reply.ids.requestId = "unknown-current"; if (fault === "attempt-id") reply.ids.attemptId = "other";
    if (fault === "kind") reply.kind = "unsupported"; if (fault === "operation") reply.receipt.operation = "get-canonical-record";
    if (fault === "content-operation") reply.content.operation = "get-canonical-record";
    let traversals = 0, traps = 0; const target = reply.content.item, descriptor = Object.getOwnPropertyDescriptor;
    const mock = t.mock.method(Object, "getOwnPropertyDescriptor", (value: object, key: PropertyKey) => { if (value === target) traversals++; return descriptor(value, key); });
    try { p.events.emit("message", fault === "proxy" ? new Proxy(reply, { ownKeys() { traps++; return []; }, getOwnPropertyDescriptor() { traps++; return undefined; }, getPrototypeOf() { traps++; return null; } }) : reply);
      assert.equal(traversals, 0); assert.equal(traps, 0); } finally { mock.mock.restore(); }
    await rejected; await f.cleanupRead(); assert.equal((await f.adapter.close()).cleanup, "complete");
  } finally { await f.dispose(); }
});
for (const fault of ["scope", "selection", "requested-id", "schema", "hash", "generation", "position", "fence", "closed", "stages", "failure-body", "stage-body", "messages", "stdout", "stderr"] as const) test(`parent full-note independently refuses ${fault}`, async () => {
  const f = await fixture(); try {
    const rejected = assert.rejects(f.adapter.queryFullNote(request), { code: "WORKER_PROTOCOL_ERROR" }); await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!;
    if (fault === "stdout" || fault === "stderr") p.events.emit("output", fault, new Uint8Array(4097));
    else if (fault === "stage-body" || fault === "failure-body") p.events.emit("message", { version: 4, ids: p.boot().ids, kind: fault === "stage-body" ? "stage" : "failure", content: p.success().content });
    else { if (fault !== "stages") p.stages(); const r = p.success();
      if (fault === "scope") r.receipt.scope.workspaceId = "b".repeat(64); if (fault === "selection") r.content.selectionScope.visibility = "project";
      if (fault === "requested-id") r.content.item.id = "substitution"; if (fault === "schema") r.receipt.projectionSchemaVersion = 2;
      if (fault === "hash") r.receipt.projectionEventHash = "b".repeat(64); if (fault === "generation") r.receipt.projectionGeneration = 0;
      if (fault === "position") r.content.item.sourceEventPosition = "1"; if (fault === "fence") r.fence.requiredPosition = "1";
      if (fault === "closed") r.closed.image = false;
      p.events.emit("message", r); if (fault === "messages") { p.events.emit("message", r); p.events.emit("message", r); } }
    await rejected; await f.cleanupRead();
  } finally { await f.dispose(); }
});
for (const fault of ["epoch", "deadline", "removal", "abnormal", "abort"] as const) test(`full note withheld candidate refuses ${fault} at closure`, async () => {
  const f = await fixture(), gate = deferred(), reached = deferred(), complete = f.ownership.complete.bind(f.ownership);
  f.ownership.complete = async ids => { reached.resolve(); await gate.promise; if (fault === "removal") throw new Error("durable removal fault"); return complete(ids); };
  try {
    const controller = new AbortController();
    let delivered = false; const outcome = f.adapter.queryFullNote(request, { signal: controller.signal }).then(x => { delivered = true; return x; }, x => x);
    await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!; p.stages(); p.events.emit("message", p.success()); p.events.emit("close", fault === "abnormal" ? 1 : 0, null);
    if (fault !== "abnormal") { await until(() => reached.resolved); if (fault === "epoch") f.setEpoch("changed"); if (fault === "deadline") f.clock.advance(5000); if (fault === "abort") controller.abort(); }
    gate.resolve(); assert.equal((await outcome).code, fault === "epoch" ? "FRESH_START_ADMISSION_STALE" : fault === "deadline" ? "WORKER_TIMEOUT" : fault === "abort" ? "WORKER_CLOSED" : "WORKER_UNAVAILABLE"); assert.equal(delivered, false);
    if (fault === "removal") assert.notEqual(await f.ownership.inspect(), null);
  } finally { gate.resolve(); await f.dispose(); }
});
test("full note shares queue arrival budget and matching cancel with absorbing cleanup quarantine", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.adapter.queryFullNote({ ...request, budgetMs: 0 }), { code: "WORKER_TIMEOUT" });
    const abort = new AbortController(), active = f.adapter.queryFullNote(request, { signal: abort.signal }).catch(x => x); await until(() => !!f.ports[0]?.boot());
    const queuedAbort = new AbortController(), queued = f.adapter.queryFullNote(request, { signal: queuedAbort.signal }).catch(x => x); queuedAbort.abort(); assert.equal((await queued).code, "WORKER_CLOSED");
    const expired = f.adapter.queryFullNote({ ...request, budgetMs: 50 }).catch(x => x);
    const others = Array.from({ length: 6 }, () => f.adapter.verify(readBootstrap().request as MetadataVerifiedReadRequest).catch(x => x));
    await assert.rejects(f.adapter.queryFullNote(request), { code: "STORE_QUEUE_FULL" }); f.clock.advance(50); assert.equal((await expired).code, "WORKER_TIMEOUT");
    abort.abort(); assert.equal((await active).code, "WORKER_CLOSED"); const p = f.ports[0]!; const cancel = p.sent.find(x => "kind" in x && x.kind === "cancel")!;
    assert.equal(cancel.version, 4); assert.deepEqual(cancel.ids, p.boot().ids); f.clock.advance(100); assert.equal(p.kills, 1);
    f.clock.advance(1900); assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.notEqual(await f.ownership.inspect(), null);
    await Promise.all(others); await assert.rejects(f.adapter.queryFullNote(request), { code: "WORKER_UNAVAILABLE" }); assert.equal(f.ports.length, 1);
  } finally { await f.dispose(); }
});

test("full note startup cancellation waits for the original ownership inspection", async () => {
  const f = await fixture(), gate = deferred(), reached = deferred(), inspect = f.ownership.inspect.bind(f.ownership);
  f.ownership.inspect = async () => { reached.resolve(); await gate.promise; return inspect(); };
  try {
    const abort = new AbortController(), outcome = f.adapter.queryFullNote(request, { signal: abort.signal }).catch(x => x);
    await until(() => reached.resolved); abort.abort(); assert.equal((await outcome).code, "WORKER_CLOSED"); assert.equal(f.ports.length, 0);
    gate.resolve(); assert.equal((await f.adapter.close()).cleanup, "complete"); assert.equal(await inspect(), null);
  } finally { gate.resolve(); await f.dispose(); }
});
test("candidate shutdown cleanup deadline is not renewed by later cancellation", async () => {
  const f = await fixture(); try {
    const abort = new AbortController(), outcome = f.adapter.queryFullNote(request, { signal: abort.signal }).catch(x => x);
    await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!; p.stages(); p.events.emit("message", p.success());
    f.clock.advance(1900); abort.abort(); assert.equal((await outcome).code, "WORKER_CLOSED"); f.clock.advance(100);
    assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.equal(f.adapter.diagnostic().code, "WORKER_CLOSED");
    assert.notEqual(await f.ownership.inspect(), null); p.events.emit("close", 0, null);
    await assert.rejects(f.adapter.queryFullNote(request), { code: "WORKER_UNAVAILABLE" }); assert.equal(f.ports.length, 1);
  } finally { await f.dispose(); }
});
