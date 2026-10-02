import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, stat } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ReadBootstrap, ReadCancel, CleanupBootstrap, VerifiedReadRequest, VerifiedReadReceipt, VerifiedReadDiagnostic, VerifiedReadBinding } from "../src/orchestrator/verified-read/contracts.js";
import { readBootstrap, readReceipt, ownedReadDirectory, READ_HASH } from "./support/v2-verified-read-fixture.js";

class Clock {
  value = 0; timers = new Map<object, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (callback: () => void, ms: number) => { const timer = {}; this.timers.set(timer, { at: this.value + ms, callback }); return timer; };
  clear = (timer: unknown) => { this.timers.delete(timer as object); };
  advance(ms: number, deliver = true) { this.value += ms; if (deliver) this.fire(); }
  fire() { for (const [key, timer] of [...this.timers]) if (timer.at <= this.value) { this.timers.delete(key); timer.callback(); } }
}
class ProcessPort {
  pid = 123; events = new EventEmitter(); sent: (ReadBootstrap | ReadCancel | CleanupBootstrap)[] = []; terminations = 0; unrefs = 0;
  send(value: ReadBootstrap | ReadCancel | CleanupBootstrap) { this.sent.push(value); }
  onMessage = (handler: (value: unknown) => void) => this.on("message", handler);
  onExit = (handler: (code: number | null, signal: string | null) => void) => this.on("exit", handler);
  onOutput = (handler: (stream: "stdout" | "stderr", bytes: Uint8Array) => void) => this.on("output", handler);
  onError = (handler: (error: unknown) => void) => this.on("error", handler);
  private on(name: string, handler: (...args: any[]) => void) { this.events.on(name, handler); return () => { this.events.off(name, handler); }; }
  terminate() { this.terminations++; }
  unref() { this.unrefs++; }
  bootstrap() { return this.sent.find(value => "binding" in value) as ReadBootstrap; }
  stages() { for (const phase of ["admission", "projection-wait", "capture", "validate", "revalidate"]) this.events.emit("message", { version: 2, ids: this.bootstrap().ids, kind: "stage", phase, observedProjectionPosition: null }); }
  success() { const boot = this.bootstrap(); return { version: 2, ids: boot.ids, kind: "success", receipt: { ...readReceipt(), consistency: boot.request.consistency },
    fence: { controlGeneration: "0", releaseId: boot.binding.expectedRelease.releaseId, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" }, closed: { image: true, reader: true, lock: true } }; }
}
type Adapter = { verify(request: VerifiedReadRequest, options?: { signal?: AbortSignal }): Promise<VerifiedReadReceipt>; diagnostic(): VerifiedReadDiagnostic; close(): Promise<VerifiedReadDiagnostic> };
async function modules() {
  const paths = ["../src/orchestrator/verified-read/supervisor.js", "../src/orchestrator/verified-read/ownership.js"];
  const values: any[] = [];
  for (const path of paths) { try { values.push(await import(path)); } catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; values.push({}); } }
  assert.equal(typeof values[0].createVerifiedReadAdapter, "function", "responsive supervisor must exist");
  return { create: values[0].createVerifiedReadAdapter as (binding: VerifiedReadBinding, dependencies: any) => Adapter, Repository: values[1].VerifiedReadOwnershipRepository };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), "expected async operation reached"); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(realClock = false) {
  const { create, Repository } = await modules(); const directory = ownedReadDirectory(); const clock = new Clock(); const processes: ProcessPort[] = []; const kinds: string[] = [];
  if (realClock) { clock.now = () => performance.now(); clock.schedule = (callback, ms) => setTimeout(callback, ms); clock.clear = timer => clearTimeout(timer as NodeJS.Timeout); }
  const binding = { ...readBootstrap().binding, executorStateDirectory: directory } as VerifiedReadBinding;
  const ownership = new Repository(directory); let epoch = "epoch";
  const adapter = create(binding, { ownership, now: clock.now, schedule: clock.schedule, clear: clock.clear, currentEpoch: () => epoch,
    spawnOwned(kind: string) { const child = new ProcessPort(); kinds.push(kind); processes.push(child); return child; } });
  return { adapter, ownership, clock, processes, kinds, binding, setEpoch: (value: string) => { epoch = value; },
    request: readBootstrap().request as VerifiedReadRequest, async dispose() { const closing = adapter.close(); clock.advance(2100); await closing; await rm(directory.canonicalPath, { recursive: true, force: true }); } };
}
test("zero budget launches nothing and eight unsettled requests include the active request", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.adapter.verify({ ...f.request, budgetMs: 0 }), { code: "WORKER_TIMEOUT" }); assert.equal(f.processes.length, 0);
    const pending = Array.from({ length: 8 }, () => f.adapter.verify(f.request).catch(error => error));
    await assert.rejects(f.adapter.verify(f.request), { code: "STORE_QUEUE_FULL" });
    assert.equal(f.adapter.diagnostic().pendingCount, 8); f.clock.advance(5000); await Promise.all(pending);
  } finally { await f.dispose(); }
});
for (const operation of ["inspect", "begin", "observeChild", "complete"]) test(`late ${operation} completion cannot succeed, spawn a replacement or unquarantine`, async () => {
  const f = await fixture(); const gate = deferred(); const reached = deferred(); const original = f.ownership[operation].bind(f.ownership);
  f.ownership[operation] = async (...args: unknown[]) => { const result = await original(...args); reached.resolve(); await gate.promise; return result; };
  try {
    const pending = f.adapter.verify({ ...f.request, budgetMs: 2000 }); const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
    if (operation === "complete") { await until(() => !!f.processes[0]?.bootstrap()); f.processes[0]!.stages(); f.processes[0]!.events.emit("message", f.processes[0]!.success()); f.processes[0]!.events.emit("exit", 0, null); }
    await reached.promise; f.clock.advance(2000); await rejected; f.clock.advance(2000); assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
    const count = f.processes.length; gate.resolve(); await turn(); await turn(); assert.equal(f.processes.length, count);
    await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" }); assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
  } finally { gate.resolve(); await f.dispose(); }
});
test("delayed timer delivery cannot admit a valid terminal after the monotonic deadline", async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify({ ...f.request, budgetMs: 2000 }); const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); f.clock.advance(2000, false);
    child.events.emit("message", child.success()); await rejected; assert.equal(f.adapter.diagnostic().cleanup, "pending");
    f.clock.advance(100); assert.equal(child.terminations, 1); assert.equal(f.kinds.length, 1);
    f.clock.advance(1900); assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.equal(child.unrefs, 1);
  } finally { await f.dispose(); }
});
test("success waits for normal actual exit and async record closure with a final epoch check", async () => {
  const f = await fixture(); const gate = deferred(); const original = f.ownership.complete.bind(f.ownership); let closing = false;
  f.ownership.complete = async (...args: unknown[]) => { closing = true; await gate.promise; return original(...args); };
  try {
    let settled = false; const pending = f.adapter.verify(f.request); void pending.then(() => { settled = true; }, () => { settled = true; });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); child.events.emit("message", child.success()); await turn(); assert.equal(settled, false);
    child.events.emit("exit", 0, null); await until(() => closing); assert.equal(settled, false);
    f.setEpoch("new-epoch"); gate.resolve(); await assert.rejects(pending, { code: "FRESH_START_ADMISSION_STALE" });
  } finally { gate.resolve(); await f.dispose(); }
});
for (const deliverTimer of [true, false]) test(`normal success delayed actual exit expires its own cleanup window (timer ${deliverTimer})`, async () => {
  const f = await fixture();
  try {
    let settlements = 0; const outcome = f.adapter.verify({ ...f.request, budgetMs: 10000 }).then(value => { settlements++; return value; }, cause => { settlements++; return cause; });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!;
    child.stages(); child.events.emit("message", child.success()); f.clock.advance(2001, deliverTimer);
    if (!deliverTimer) child.events.emit("exit", 0, null);
    await turn(); assert.equal(settlements, 1, "normal shutdown must settle at its fixed cleanup limit, before the longer response limit");
    assert.equal((await outcome).code, "WORKER_UNAVAILABLE"); assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
    child.events.emit("exit", 0, null); f.clock.advance(10000); await turn(); assert.equal(settlements, 1);
    await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" });
  } finally { await f.dispose(); }
});
test("normal success held actual ownership unlink expires before longer response and late removal only permits a fresh adapter", async t => {
  const f = await fixture(); const { create, Repository } = await modules();
  const target = join(f.binding.executorStateDirectory.canonicalPath, "verified-read-owner.json");
  const reached = deferred(), release = deferred(), removed = deferred(); const unlink = fsPromises.unlink; let held = false;
  const wrapper = t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof unlink>[0]) => {
    if (String(path) === target && !held) { held = true; reached.resolve(); await release.promise; await unlink(path); removed.resolve(); }
    else await unlink(path);
  }); syncBuiltinESMExports();
  try {
    let settlements = 0; const outcome = f.adapter.verify({ ...f.request, budgetMs: 10000 }).then(value => { settlements++; return value; }, cause => { settlements++; return cause; });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!;
    child.stages(); child.events.emit("message", child.success()); child.events.emit("exit", 0, null);
    await reached.promise; f.clock.advance(2001); await turn();
    assert.equal(settlements, 1, "held native unlink must not borrow the longer response budget");
    assert.equal((await outcome).code, "WORKER_UNAVAILABLE"); assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
    assert.equal(JSON.parse(await readFile(target, "utf8")).state, "complete");
    release.resolve(); await removed.promise; assert.equal(await f.ownership.inspect(), null);
    assert.equal(settlements, 1); await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" });
    const processes: ProcessPort[] = []; const fresh = create(f.binding, { ownership: new Repository(f.binding.executorStateDirectory), now: f.clock.now,
      schedule: f.clock.schedule, clear: f.clock.clear, currentEpoch: () => "epoch", spawnOwned() { const port = new ProcessPort(); processes.push(port); return port; } });
    const next = fresh.verify({ ...f.request, budgetMs: 10000 }); await until(() => !!processes[0]?.bootstrap());
    processes[0]!.stages(); processes[0]!.events.emit("message", processes[0]!.success()); processes[0]!.events.emit("exit", 0, null);
    assert.equal((await next).projectionGeneration, 1); assert.equal((await fresh.close()).cleanup, "complete");
    assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
  } finally { release.resolve(); if (held) await removed.promise; await f.ownership.inspect().catch(() => undefined); wrapper.mock.restore(); syncBuiltinESMExports(); await f.dispose(); }
});
test("timely normal shutdown and real ownership removal succeed within the cleanup window", async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify({ ...f.request, budgetMs: 10000 }); await until(() => !!f.processes[0]?.bootstrap());
    const child = f.processes[0]!; child.stages(); child.events.emit("message", child.success()); f.clock.advance(1999);
    child.events.emit("exit", 0, null); assert.equal((await pending).projectionGeneration, 1);
    assert.equal(await f.ownership.inspect(), null); assert.equal(f.adapter.diagnostic().cleanup, "complete");
  } finally { await f.dispose(); }
});
for (const cancel of [false, true]) test(`normal cleanup window is not reset by later ${cancel ? "cancellation" : "response expiry"}`, async () => {
  const f = await fixture(); const controller = new AbortController(); try {
    const outcome = f.adapter.verify({ ...f.request, budgetMs: cancel ? 10000 : 1500 }, { signal: controller.signal }).catch(cause => cause);
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!;
    child.stages(); child.events.emit("message", child.success()); f.clock.advance(1500); if (cancel) controller.abort();
    assert.equal((await outcome).code, cancel ? "WORKER_CLOSED" : "WORKER_TIMEOUT");
    f.clock.advance(500); assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.equal(child.terminations, 1);
  } finally { await f.dispose(); }
});
for (const phase of ["admission", "projection-wait", "capture"]) for (const deliverTimer of [true, false]) test(`parent expiry classifies ${phase} with timer ${deliverTimer}`, async () => {
  const f = await fixture(); try {
    const outcome = f.adapter.verify({ ...f.request, budgetMs: 2000, minimumEventPosition: "5" }).catch(cause => cause);
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!;
    child.events.emit("message", { version: 2, ids: child.bootstrap().ids, kind: "stage", phase: "admission", observedProjectionPosition: null });
    if (phase !== "admission") child.events.emit("message", { version: 2, ids: child.bootstrap().ids, kind: "stage", phase: "projection-wait", observedProjectionPosition: "3" });
    if (phase === "capture") child.events.emit("message", { version: 2, ids: child.bootstrap().ids, kind: "stage", phase: "capture", observedProjectionPosition: "5" });
    f.clock.advance(2000, deliverTimer); if (!deliverTimer) child.events.emit("message", child.success());
    assert.equal((await outcome).code, phase === "projection-wait" ? "PROJECTION_LAG" : "WORKER_TIMEOUT");
    assert.equal(f.adapter.diagnostic().positions, null, "stage observation cannot supply the missing authoritative required tail");
  } finally { await f.dispose(); }
});
for (const fault of ["missing-close", "stage-order", "unknown-id", "duplicate", "stdout", "stderr", "abnormal-exit", "late-output", "late-message", "async-error"]) test(`refuses ${fault} without success`, async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify(f.request); const rejected = assert.rejects(pending); await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!;
    if (fault !== "stage-order") child.stages(); const success = child.success();
    if (fault === "missing-close") child.events.emit("message", { ...success, closed: { image: true, reader: true, lock: false } });
    else if (fault === "unknown-id") child.events.emit("message", { ...success, ids: { ...success.ids, requestId: "unknown" } });
    else if (fault === "stdout" || fault === "stderr") child.events.emit("output", fault, new Uint8Array(4097));
    else if (fault === "async-error") child.events.emit("error", new Error("spawn/send"));
    else { child.events.emit("message", success); if (fault === "duplicate") child.events.emit("message", success);
      child.events.emit("exit", fault === "abnormal-exit" ? 1 : 0, null);
      if (fault === "late-output") child.events.emit("output", "stderr", new Uint8Array(4097));
      if (fault === "late-message") child.events.emit("message", { broken: true }); }
    await rejected;
  } finally { await f.dispose(); }
});
test("valid success closes ownership and old closed-lane traffic cannot poison the next request", async () => {
  const f = await fixture(); try {
    const first = f.adapter.verify(f.request); await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); const old = child.success(); child.events.emit("message", old); child.events.emit("exit", 0, null);
    assert.equal((await first).projectionGeneration, 1); assert.equal(await f.ownership.inspect(), null);
    const next = f.adapter.verify(f.request); await until(() => !!f.processes[1]?.bootstrap()); const second = f.processes[1]!;
    second.events.emit("message", old); second.events.emit("message", { ...old, ids: { ...old.ids, laneEpoch: "old-epoch" } });
    second.stages(); second.events.emit("message", second.success()); second.events.emit("exit", 0, null); await next;
  } finally { await f.dispose(); }
});
test("captured fence retains a requested minimum beyond the captured tail", async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify({ ...f.request, minimumEventPosition: "5" });
    const observed = pending.then(value => value, cause => cause);
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); const base = child.success();
    child.events.emit("message", { ...base, receipt: { ...base.receipt, requiredEventPosition: "5", projectionEventPosition: "5" }, fence: { ...base.fence, requiredPosition: "5" } });
    child.events.emit("exit", 0, null);
    assert.equal((await observed).requiredEventPosition, "5");
  } finally { await f.dispose(); }
});
test("failed read retains its capacity slot until actual cleanup proof", async () => {
  const f = await fixture(); try {
    const controller = new AbortController(); const active = f.adapter.verify(f.request, { signal: controller.signal }); const rejected = assert.rejects(active, { code: "WORKER_CLOSED" });
    await until(() => !!f.processes[0]?.bootstrap()); controller.abort(); await rejected;
    const queued = Array.from({ length: 7 }, () => f.adapter.verify(f.request).catch(cause => cause));
    const overflow = f.adapter.verify(f.request).catch(cause => cause); assert.equal(f.adapter.diagnostic().pendingCount, 8);
    f.clock.advance(2000); assert.equal((await overflow).code, "STORE_QUEUE_FULL"); await Promise.all(queued);
  } finally { await f.dispose(); }
});
test("queued request keeps its arrival deadline when its timer delivery is delayed", async () => {
  const f = await fixture(); try {
    const first = f.adapter.verify(f.request); const second = f.adapter.verify({ ...f.request, budgetMs: 2000 }); const rejected = assert.rejects(second, { code: "WORKER_TIMEOUT" });
    await until(() => !!f.processes[0]?.bootstrap()); f.clock.advance(2000, false); const child = f.processes[0]!;
    child.stages(); child.events.emit("message", child.success()); child.events.emit("exit", 0, null); await first; await rejected; assert.equal(f.processes.length, 1);
  } finally { await f.dispose(); }
});
test("late asynchronous record closure is checked against real arrival time and cannot publish success", async () => {
  const f = await fixture(true); const gate = deferred(); const reached = deferred(); const original = f.ownership.complete.bind(f.ownership);
  f.ownership.complete = async (...args: unknown[]) => { reached.resolve(); await gate.promise; return original(...args); };
  try {
    let successes = 0; const arrival = performance.now(); const pending = f.adapter.verify({ ...f.request, budgetMs: 300 }); void pending.then(() => successes++, () => undefined);
    const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); child.events.emit("message", child.success()); child.events.emit("exit", 0, null);
    await reached.promise; await rejected; assert.ok(performance.now() - arrival <= 1300); gate.resolve(); await until(() => f.adapter.diagnostic().cleanup === "complete");
    assert.equal(successes, 0); assert.equal(f.processes.length, 1); assert.equal(await f.ownership.inspect(), null);
  } finally { gate.resolve(); await f.dispose(); }
});
test("actual late unlink permits a fresh owner while old adapter keeps quarantine and its primary timeout", { timeout: 5000 }, async t => {
  const f = await fixture(); const { Repository } = await modules(); const target = join(f.binding.executorStateDirectory.canonicalPath, "verified-read-owner.json");
  const reached = deferred(); const gate = deferred(); const actualUnlink = fsPromises.unlink; let held = false;
  const wrapper = t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof actualUnlink>[0]) => {
    if (String(path) === target && !held) { held = true; reached.resolve(); await gate.promise; }
    await actualUnlink(path);
  });
  syncBuiltinESMExports();
  try {
    let successes = 0; const pending = f.adapter.verify({ ...f.request, budgetMs: 2000 });
    const outcome = pending.then(value => { successes++; return value; }, cause => cause as Error & { code: string });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); child.events.emit("message", child.success()); child.events.emit("exit", 0, null);
    await reached.promise; const published = JSON.parse(await readFile(target, "utf8")); assert.equal(published.state, "complete");
    f.clock.advance(2000); assert.equal((await outcome as { code: string }).code, "WORKER_TIMEOUT"); f.clock.advance(2000);
    assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
    const fresh = new Repository(f.binding.executorStateDirectory); const { state: _state, pid: _pid, ...oldIntent } = published;
    const replacementIntent = { ...oldIntent, supervisorId: "fresh-supervisor", ids: { ...published.ids, attemptId: "fresh-attempt" } };
    await assert.rejects(fresh.begin(replacementIntent), { code: "WORKER_UNAVAILABLE" });
    gate.resolve(); assert.equal(await f.ownership.inspect(), null); await fresh.begin(replacementIntent); const bytes = await readFile(target);
    await assert.rejects(f.ownership.complete(child.bootstrap().ids), { code: "WORKER_UNAVAILABLE" });
    assert.deepEqual(await readFile(target), bytes); assert.equal((await fresh.inspect()).ids.attemptId, "fresh-attempt");
    assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" });
    assert.equal(successes, 0); assert.equal((await outcome as { code: string }).code, "WORKER_TIMEOUT"); assert.equal(f.processes.length, 1);
  } finally {
    gate.resolve(); await f.ownership.inspect().catch(() => undefined); wrapper.mock.restore(); syncBuiltinESMExports(); await f.dispose();
  }
});
test("failure after durable intent publication retains restart denial and launches nothing", async () => {
  const f = await fixture(); const original = f.ownership.begin.bind(f.ownership);
  f.ownership.begin = async (...args: unknown[]) => { await original(...args); throw new Error("after intent sync"); };
  try {
    await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" }); assert.equal(f.processes.length, 0);
    assert.equal((await f.ownership.inspect()).state, "launch-intent"); assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
    await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" });
  } finally { await f.dispose(); }
});
test("existing complete record quarantines the supervisor without launching or modifying ownership", async () => {
  const f = await fixture(); const path = join(f.binding.executorStateDirectory.canonicalPath, "verified-read-owner.json");
  const bytes = JSON.stringify({ schemaVersion: 1, bindingFingerprint: READ_HASH, buildHash: READ_HASH, supervisorId: "crashed-supervisor",
    ids: readBootstrap().ids, lockToken: "a".repeat(32), state: "complete", pid: 4321 });
  try {
    await fsPromises.writeFile(path, bytes); await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" });
    assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.equal(f.adapter.diagnostic().pendingCount, 1);
    assert.equal(f.processes.length, 0); assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" }); assert.equal(await readFile(path, "utf8"), bytes);
  } finally { await f.dispose(); }
});
for (const cause of ["timeout", "undelivered timeout", "cancellation", "epoch"] as const) test(`existing ownership after ${cause} retains quarantine with primary ${cause === "timeout" || cause === "cancellation" ? "already settled" : "discovered on return"}`, async () => {
  const f = await fixture(); const path = join(f.binding.executorStateDirectory.canonicalPath, "verified-read-owner.json");
  const bytes = JSON.stringify({ schemaVersion: 1, bindingFingerprint: READ_HASH, buildHash: READ_HASH, supervisorId: "prior-supervisor",
    ids: readBootstrap().ids, lockToken: "a".repeat(32), state: "complete", pid: 4321 });
  const reached = deferred(); const gate = deferred(); const inspect = f.ownership.inspect.bind(f.ownership);
  f.ownership.inspect = async () => { const record = await inspect(); assert.equal(record?.state, "complete"); reached.resolve(); await gate.promise; return record; };
  const controller = new AbortController(); const expected = cause === "timeout" || cause === "undelivered timeout" ? "WORKER_TIMEOUT" : cause === "cancellation" ? "WORKER_CLOSED" : "FRESH_START_ADMISSION_STALE";
  try {
    await fsPromises.writeFile(path, bytes);
    let settled = false;
    const outcome = f.adapter.verify({ ...f.request, budgetMs: 2000 }, { signal: controller.signal })
      .then(value => { settled = true; return value; }, error => { settled = true; return error as { code: string }; });
    await reached.promise;
    if (cause === "timeout") { f.clock.advance(2000); assert.equal((await outcome as { code: string }).code, expected); f.clock.advance(500); }
    else if (cause === "undelivered timeout") f.clock.advance(2500, false);
    else { f.clock.advance(500); if (cause === "cancellation") { controller.abort(); assert.equal((await outcome as { code: string }).code, expected); } else f.setEpoch("changed-epoch"); }
    await turn(); assert.equal(settled, cause === "timeout" || cause === "cancellation");
    gate.resolve(); assert.equal((await outcome as { code: string }).code, expected);
    await until(() => f.adapter.diagnostic().cleanup !== "pending");
    assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.equal(f.adapter.diagnostic().pendingCount, 1);
    assert.equal(f.adapter.diagnostic().code, expected); assert.equal(f.processes.length, 0); assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(f.adapter.verify(f.request), { code: "WORKER_UNAVAILABLE" });
    assert.equal((await outcome as { code: string }).code, expected); assert.equal(await readFile(path, "utf8"), bytes);
  } finally { gate.resolve(); await f.dispose(); }
});
test("cleanup terminal without actual exit retains evidence at the original single cleanup deadline", async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify({ ...f.request, budgetMs: 2000 }); const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
    await until(() => !!f.processes[0]?.bootstrap()); f.clock.advance(2000); await rejected; f.clock.advance(1500);
    f.processes[0]!.events.emit("exit", null, "SIGKILL"); await until(() => f.processes.length === 2);
    const cleanup = f.processes[1]!; const bootstrap = cleanup.sent[0] as CleanupBootstrap; assert.equal(bootstrap.remainingMs, 500);
    cleanup.events.emit("message", { version: 1, ids: bootstrap.ids, kind: "cleanup", outcome: "released", cleanup: "complete" });
    const closing = f.adapter.close(); f.clock.advance(500); assert.equal((await closing).cleanup, "incomplete"); assert.equal(cleanup.terminations, 1);
    cleanup.events.emit("exit", 0, null); await turn(); assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); assert.equal(f.kinds.length, 2);
    assert.notEqual(await f.ownership.inspect(), null);
  } finally { await f.dispose(); }
});
for (const fault of ["oversized-payload", "unknown-malformed", "mismatched-fence", "wrong-scope", "matching-position-wrong-hash"]) test(`bounded receipt validator refuses ${fault}`, async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify(f.request); const rejected = assert.rejects(pending, { code: "WORKER_PROTOCOL_ERROR" });
    await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!; child.stages(); const reply = child.success();
    if (fault === "oversized-payload") child.events.emit("message", { ...reply, extra: "x".repeat(16385) });
    else if (fault === "unknown-malformed") child.events.emit("message", { ids: reply.ids });
    else if (fault === "mismatched-fence") child.events.emit("message", { ...reply, fence: { ...reply.fence, requiredPosition: "1" } });
    else if (fault === "wrong-scope") child.events.emit("message", { ...reply, receipt: { ...reply.receipt, scope: { ...reply.receipt.scope, workspaceId: "b".repeat(64) } } });
    else child.events.emit("message", { ...reply, fence: { ...reply.fence, capturedHash: "b".repeat(64) } });
    await rejected;
  } finally { await f.dispose(); }
});
test("4096 bytes per separate child stream remain admissible without retaining raw output", async () => {
  const f = await fixture(); try {
    const pending = f.adapter.verify(f.request); await until(() => !!f.processes[0]?.bootstrap()); const child = f.processes[0]!;
    for (const stream of ["stdout", "stderr"]) { child.events.emit("output", stream, new Uint8Array(2048)); child.events.emit("output", stream, new Uint8Array(2048)); }
    child.stages(); child.events.emit("message", child.success()); child.events.emit("exit", 0, null); await pending; assert.equal(f.adapter.diagnostic().cleanup, "complete");
  } finally { await f.dispose(); }
});
test("abort before bootstrap launches nothing; cancellation after bootstrap keeps one slot until actual cleanup exit", async () => {
  const f = await fixture(); try {
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.adapter.verify(f.request, { signal: cancelled.signal }), { code: "WORKER_CLOSED" }); assert.equal(f.processes.length, 0);
    const controller = new AbortController(); const pending = f.adapter.verify(f.request, { signal: controller.signal }); const rejected = assert.rejects(pending, { code: "WORKER_CLOSED" });
    await until(() => !!f.processes[0]?.bootstrap()); controller.abort(); await rejected; const child = f.processes[0]!;
    assert.equal((child.sent.at(-1) as ReadCancel).kind, "cancel"); f.clock.advance(100); assert.equal(child.terminations, 1); assert.equal(f.kinds.length, 1);
    child.events.emit("exit", null, "SIGKILL"); await until(() => f.processes.length === 2); assert.deepEqual(f.kinds, ["read", "cleanup"]);
    const cleanup = f.processes[1]!; const boot = cleanup.sent[0] as CleanupBootstrap;
    cleanup.events.emit("message", { version: 1, ids: boot.ids, kind: "cleanup", outcome: "released", cleanup: "complete" });
    assert.equal(f.adapter.diagnostic().cleanup, "pending"); cleanup.events.emit("exit", 0, null); await until(() => f.adapter.diagnostic().cleanup === "complete");
    assert.equal(await f.ownership.inspect(), null);
  } finally { await f.dispose(); }
});

test("native synchronous owned-lock hang expires responsively, observes both exact exits and preserves independent writer", { timeout: 12000 }, async () => {
  const { create, Repository } = await modules(); const directory = ownedReadDirectory();
  const executable = fileURLToPath(new URL("./fixtures/v2-verified-read-process-fixture.js", import.meta.url));
  const children: ChildProcess[] = []; const exits: { kind: string; code: number | null; signal: string | null }[] = []; const kinds: string[] = [];
  const spawn = (kind: string) => {
    const child = fork(executable, [kind], { cwd: directory.canonicalPath, execArgv: [], env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {},
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] } as ForkOptions);
    children.push(child); child.once("exit", (code, signal) => { exits.push({ kind, code, signal }); }); return child;
  };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, maximum: number) => { const deadline = performance.now() + maximum;
    while (!await predicate()) { if (performance.now() >= deadline) assert.fail("native operation/exit observation inconclusive"); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const exists = async (name: string) => { try { await stat(join(directory.canonicalPath, name)); return true; } catch { return false; } };
  const writer = spawn("writer"); let adapter: Adapter | undefined;
  try {
    await waitFor(() => exists("writer-ready"), 2000); const writerBytes = await readFile(join(directory.canonicalPath, "independent-writer.sqlite"));
    const binding = { ...readBootstrap().binding, executorStateDirectory: directory, projectionDirectory: directory } as VerifiedReadBinding;
    adapter = create(binding, { ownership: new Repository(directory), now: () => performance.now(), schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clear: (timer: NodeJS.Timeout) => clearTimeout(timer), currentEpoch: () => "epoch", spawnOwned(kind: string) {
        kinds.push(kind); const child = spawn(kind === "read" ? "read-hang" : "cleanup"); const failures = new Set<(error: unknown) => void>();
        child.on("error", cause => { for (const callback of failures) callback(cause); });
        return { get pid() { return child.pid; }, send(value: unknown) { child.send(value as object, cause => { if (cause) for (const callback of failures) callback(cause); }); },
          onMessage(callback: (value: unknown) => void) { child.on("message", callback); return () => { child.off("message", callback); }; },
          onExit(callback: (code: number | null, signal: string | null) => void) { child.on("close", callback); return () => { child.off("close", callback); }; },
          onOutput(callback: (stream: string, bytes: Buffer) => void) { const out = (bytes: Buffer) => callback("stdout", bytes); const err = (bytes: Buffer) => callback("stderr", bytes);
            child.stdout!.on("data", out); child.stderr!.on("data", err); return () => { child.stdout!.off("data", out); child.stderr!.off("data", err); }; },
          onError(callback: (error: unknown) => void) { failures.add(callback); return () => { failures.delete(callback); }; }, terminate() { child.kill("SIGKILL"); }, unref() { child.unref(); child.channel?.unref(); } };
      } });
    const arrival = performance.now(); let ticks = 0; const ticker = setInterval(() => ticks++, 10);
    const pending = adapter.verify({ ...readBootstrap().request, budgetMs: 2000 } as VerifiedReadRequest);
    const rejected = assert.rejects(pending, { code: "WORKER_TIMEOUT" });
    try {
      await waitFor(() => exists("read-blocked"), 2000);
      assert.equal(await readFile(join(directory.canonicalPath, "read-blocked"), "utf8"), "owned-lock-acquired-before-synchronous-wait");
      await rejected; assert.ok(performance.now() - arrival <= 3000, "2000ms response budget plus at most 1000ms observation allowance"); assert.ok(ticks >= 5);
      const cleanupStart = performance.now(); const diagnostic = await adapter.close();
      assert.ok(performance.now() - cleanupStart <= 3000, "fixed cleanup budget plus scheduling allowance"); assert.equal(diagnostic.cleanup, "complete", "inconclusive cleanup is failure");
      assert.deepEqual(kinds, ["read", "cleanup"]);
      assert.equal(exits.filter(value => value.kind === "read-hang").length, 1);
      assert.deepEqual(exits.find(value => value.kind === "cleanup"), { kind: "cleanup", code: 0, signal: null });
      assert.equal(exits.some(value => value.kind === "writer"), false); assert.equal(writer.exitCode, null);
      assert.deepEqual(await readFile(join(directory.canonicalPath, "independent-writer.sqlite")), writerBytes);
      assert.equal(await exists(".projection-manifest.publish.lock"), false); assert.equal(await new Repository(directory).inspect(), null);
    } finally { clearInterval(ticker); }
    writer.send("stop"); await waitFor(() => exits.some(value => value.kind === "writer"), 2000);
    assert.deepEqual(exits.find(value => value.kind === "writer"), { kind: "writer", code: 0, signal: null });
  } finally {
    await adapter?.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null), 2000);
    await rm(directory.canonicalPath, { recursive: true, force: true });
  }
});
