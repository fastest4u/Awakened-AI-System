import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm, readFile, stat } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createVerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";
import { VerifiedReadOwnershipRepository } from "../src/orchestrator/verified-read/ownership.js";
import { decodeReadBootstrap } from "../src/orchestrator/verified-read/protocol.js";
import type { VerifiedContentReadRequest, VerifiedContentReadResult } from "../src/orchestrator/verified-read/content-contracts.js";
import type { ReadBootstrap, ReadCancel, CleanupBootstrap, MetadataVerifiedReadRequest } from "../src/orchestrator/verified-read/contracts.js";
import { ownedReadDirectory, readBootstrap, readReceipt, READ_HASH } from "./support/v2-verified-read-fixture.js";
import { nativeGetRequest, nativeSearchRequest, makeNativeContentFixture, NATIVE_SESSION } from "./support/v2-native-content-fixture.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) { for (let i = 0; i < 300 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), "expected barrier reached"); }
function deferred() { let resolved = false; let resolve!: () => void; const promise = new Promise<void>(done => { resolve = () => { resolved = true; done(); }; }); return { promise, resolve, get resolved() { return resolved; } }; }
class Clock {
  value = 0; timers = new Map<object, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (callback: () => void, ms: number) => { const timer = {}; this.timers.set(timer, { at: this.value + ms, callback }); return timer; };
  clear = (timer: unknown) => { this.timers.delete(timer as object); };
  advance(ms: number, fire = true) { this.value += ms; if (fire) for (const [key, t] of [...this.timers]) if (t.at <= this.value) { this.timers.delete(key); t.callback(); } }
}
class Port {
  pid = 123; events = new EventEmitter(); sent: (ReadBootstrap | CleanupBootstrap | ReadCancel)[] = []; kills = 0;
  send(value: ReadBootstrap | CleanupBootstrap | ReadCancel) { this.sent.push(value); }
  private on(name: string, handler: (...args: any[]) => void) { this.events.on(name, handler); return () => { this.events.off(name, handler); }; }
  onMessage = (h: (value: unknown) => void) => this.on("message", h);
  onExit = (h: (code: number | null, signal: string | null) => void) => this.on("exit", h);
  onOutput = (h: (stream: "stdout" | "stderr", bytes: Uint8Array) => void) => this.on("output", h);
  onError = (h: (error: unknown) => void) => this.on("error", h);
  terminate() { this.kills++; } unref() {}
  boot() { return this.sent.find(x => "binding" in x) as ReadBootstrap; }
  stages() { for (const phase of ["admission", "projection-wait", "capture", "validate", ...(this.boot().request.operation === "verify-published-view" ? [] : ["query"]), "revalidate"])
    this.events.emit("message", { version: 3, ids: this.boot().ids, kind: "stage", phase, observedProjectionPosition: null }); }
  success(): any {
    const b = this.boot(); const receipt = { ...readReceipt(), operation: b.request.operation, consistency: b.request.consistency };
    const selectionScope = { projectId: b.binding.projectionBinding.projectId, workspaceId: b.binding.projectionBinding.workspaceId,
      branchScopeId: null, branchRef: null, sessionId: b.binding.session?.sessionId ?? null,
      visibility: b.binding.session ? "session" : "branch" };
    const item = { id: b.request.operation === "get-canonical-record" ? b.request.parameters.id : "record", kind: "canonical",
      ...selectionScope, sessionId: null, visibility: "project", status: "verified", confidence: "high", verificationMethod: "committed-event",
      validFrom: null, validTo: null, knownFromEventPosition: "0", sourceEventPosition: "0", textKind: "canonical-summary",
      text: "projected summary", conflictGroupId: null, supersedingItemId: null };
    let content: any = b.request.operation === "get-canonical-record" ? { operation: b.request.operation, selectionScope, item, conflict: null }
      : { operation: b.request.operation, selectionScope, rankingPolicyVersion: "retrieval-ranking-v2-shadow-fixed-units",
        contentBoundsVersion: "v2-native-content-bounds-1", items: [{ ...item, channels: ["exact"], selectionReason: "exact" }],
        conflicts: [], candidateBounded: false, selectionTruncated: false, byteBounded: false };
    if (b.request.operation === "list-canonical-records" || b.request.operation === "recent-canonical-records") content = {
      operation: b.request.operation, selectionScope, workflowBoundsVersion: "v2-native-read-workflow-bounds-1",
      order: b.request.operation === "list-canonical-records" ? "item-id-binary-asc" : "source-event-position-desc-id-binary-asc",
      items: [{ item, conflict: null }], hasMore: false, nextCursor: null, byteBounded: false };
    if (b.request.operation === "follow-up-radar") content = { operation: b.request.operation, selectionScope,
      workflowBoundsVersion: "v2-native-read-workflow-bounds-1", order: "source-event-position-desc-id-binary-asc",
      items: [{ ...item, kind: "follow-up", status: "open", verificationMethod: "open-follow-up", sessionId: selectionScope.sessionId, visibility: "session", textKind: "projection-text" }],
      hasMore: false, nextCursor: null, byteBounded: false };
    if (b.request.operation === "build-context-pack") content = { operation: b.request.operation, selectionScope,
      rankingPolicyVersion: "retrieval-ranking-v2-shadow-fixed-units", workflowBoundsVersion: "v2-native-read-workflow-bounds-1",
      items: [{ ...item, channels: ["exact"], selectionReason: "exact" }], conflicts: [], followUps: [],
      candidateBounded: false, selectionTruncated: false, byteBounded: false };
    return { version: 3, ids: b.ids, kind: "success", receipt,
      fence: { controlGeneration: "0", releaseId: b.binding.expectedRelease.releaseId, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" },
      closed: { image: true, reader: true, lock: true }, ...(b.request.operation === "verify-published-view" ? {} : { content }) };
  }
}
async function fixture(boundSession = true) {
  const directory = ownedReadDirectory(); const clock = new Clock(); const ports: Port[] = []; let epoch = "epoch";
  const binding = decodeReadBootstrap({ ...readBootstrap(), binding: { ...readBootstrap().binding, executorStateDirectory: directory,
    session: boundSession ? { sessionId: NATIVE_SESSION, minimumEventPosition: "0" } : null } }).binding;
  const ownership = new VerifiedReadOwnershipRepository(directory);
  const adapter = createVerifiedReadAdapter(binding, { ownership, now: clock.now, schedule: clock.schedule, clear: clock.clear,
    currentEpoch: () => epoch, spawnOwned() { const port = new Port(); ports.push(port); return port; } });
  // Dynamic API check keeps the initial RED compile-successful against the pre-integration interface.
  const query = (request: VerifiedContentReadRequest, options?: { signal?: AbortSignal }): Promise<VerifiedContentReadResult> => {
    const method = (adapter as unknown as { query?: (r: VerifiedContentReadRequest, o?: { signal?: AbortSignal }) => Promise<VerifiedContentReadResult> }).query;
    assert.equal(typeof method, "function", "owned lane must export query"); return method!(request, options);
  };
  return { directory, clock, ports, ownership, adapter, query, binding, setEpoch: (value: string) => { epoch = value; },
    async dispose() {
      const close = adapter.close(); clock.advance(2100); const diagnostic = await close;
      if (diagnostic.cleanup === "complete" && await ownership.inspect() === null) await rm(directory.canonicalPath, { recursive: true, force: true });
      else console.error(`Retained uncertain deterministic ownership fixture: ${directory.canonicalPath}`);
    } };
}
test("content_candidate_waits_for_exit_and_record_absence", async t => {
  const f = await fixture(); const gate = deferred(), reached = deferred();
  const target = join(f.directory.canonicalPath, "verified-read-owner.json"), unlink = fsPromises.unlink;
  const mock = t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof unlink>[0]) => {
    if (String(path) === target) { reached.resolve(); await gate.promise; } await unlink(path);
  }); syncBuiltinESMExports();
  try {
    let settled = false; const request = nativeGetRequest("record"); const pending = f.query(request);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await until(() => !!f.ports[0]?.boot()); const child = f.ports[0]!; child.stages(); child.events.emit("message", child.success());
    await turn(); assert.equal(settled, false);
    child.events.emit("exit", 0, null); await until(() => reached.resolved); assert.equal(settled, false);
    assert.equal(JSON.parse(await readFile(target, "utf8")).state, "complete");
    const competing = new VerifiedReadOwnershipRepository(f.directory);
    const record = (await competing.inspect())!; const { state: _state, pid: _pid, ...intent } = record;
    await assert.rejects(competing.begin({ ...intent, supervisorId: "competitor" }), { code: "WORKER_UNAVAILABLE" });
    gate.resolve(); const result = await pending;
    assert.equal(result.content.operation, request.operation); assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.content), true); assert.equal(await f.ownership.inspect(), null);
  } finally { gate.resolve(); mock.mock.restore(); syncBuiltinESMExports(); await f.dispose(); }
});
for (const fault of ["session-scope", "get-id", "get-kind", "operation", "position", "count", "limit", "phase", "duplicate", "too-many"] as const) {
  test(fault === "session-scope" ? "supervisor_rejects_session_scope_lie" : fault === "get-id" ? "supervisor_rejects_get_substitution" : `supervisor rejects independent ${fault} forgery`, async () => {
    const f = await fixture(); try {
      const search = fault === "count" || fault === "limit"; const pending = f.query(search ? nativeSearchRequest({ parameters: { query: "native", limit: 1 } }) : nativeGetRequest("record"));
      const rejected = assert.rejects(pending, { code: "WORKER_PROTOCOL_ERROR" }); await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!;
      if (fault !== "phase") p.stages(); const r = p.success(); assert.equal(r.receipt.scope.sessionId, null);
      if (fault === "session-scope") r.content.selectionScope.sessionId = null;
      if (fault === "get-id") r.content.item.id = "sibling";
      if (fault === "get-kind") { r.content.item.kind = "artifact"; r.content.item.textKind = "projection-text"; }
      if (fault === "operation") {
        // An intrinsically valid alternate operation must reach supervisor request correlation.
        r.receipt.operation = "search-projected-content";
        r.content = { operation: "search-projected-content", selectionScope: r.content.selectionScope,
          rankingPolicyVersion: "retrieval-ranking-v2-shadow-fixed-units", contentBoundsVersion: "v2-native-content-bounds-1",
          items: [], conflicts: [], candidateBounded: false, selectionTruncated: false, byteBounded: false };
      }
      if (fault === "position") r.content.item.sourceEventPosition = "1";
      if (fault === "count") { r.content.items[0].conflictGroupId = "group"; r.content.conflicts = [{ conflictGroupId: "group", eligibleMemberCount: 2, returnedMemberCount: 0, highImpact: false, truncated: true }]; }
      if (fault === "limit") r.content.items.push({ ...r.content.items[0], id: "second" });
      p.events.emit("message", r);
      if (fault === "duplicate") p.events.emit("message", r);
      if (fault === "too-many") { p.events.emit("message", { ...r, kind: "stage", phase: "revalidate" }); p.events.emit("message", r); }
      await rejected;
      assert.doesNotMatch(JSON.stringify(f.adapter.diagnostic()), /projected summary|sibling|record|native|lockToken|canonicalPath/u);
    } finally { await f.dispose(); }
  });
}
for (const operation of ["search-projected-content", "get-canonical-record"] as const) {
  const foreignSession = "22222222-2222-4222-8222-222222222222";
  for (const scenario of [
    { name: "bound foreign project", bound: true, sessionId: foreignSession, visibility: "project" },
    { name: "bound foreign branch", bound: true, sessionId: foreignSession, visibility: "branch" },
    { name: "sessionless foreign project", bound: false, sessionId: foreignSession, visibility: "project" },
    { name: "sessionless foreign branch", bound: false, sessionId: foreignSession, visibility: "branch" },
    { name: "bound trusted project", bound: true, sessionId: NATIVE_SESSION, visibility: "project" },
    { name: "bound trusted branch", bound: true, sessionId: NATIVE_SESSION, visibility: "branch" },
    { name: "bound null session", bound: true, sessionId: null, visibility: "session" },
    { name: "sessionless null session", bound: false, sessionId: null, visibility: "session" },
    { name: "bound foreign session", bound: true, sessionId: foreignSession, visibility: "session" },
  ]) {
    test(`item_session supervisor rejects ${operation} ${scenario.name}`, async () => {
      const f = await fixture(scenario.bound);
      try {
        const pending = f.query(operation === "search-projected-content" ? nativeSearchRequest() : nativeGetRequest("record"));
        const rejected = assert.rejects(pending, { code: "WORKER_PROTOCOL_ERROR" });
        await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!; p.stages();
        const reply = p.success(); assert.equal(reply.receipt.scope.sessionId, null);
        assert.equal(reply.content.selectionScope.sessionId, scenario.bound ? NATIVE_SESSION : null);
        const value = operation === "search-projected-content" ? reply.content.items[0] : reply.content.item;
        value.sessionId = scenario.sessionId; value.visibility = scenario.visibility;
        p.events.emit("message", reply); p.events.emit("exit", 0, null);
        // Complete the exact owned cleanup after the refused read exit; no uncertainty/timeout masks rejection.
        const cleanup = f.ports[1];
        if (cleanup) {
          const boot = cleanup.sent[0] as CleanupBootstrap;
          cleanup.events.emit("message", { version: 1, ids: boot.ids, kind: "cleanup", outcome: "absent", cleanup: "complete" });
          cleanup.events.emit("exit", 0, null);
        }
        await rejected;
        assert.equal((await f.adapter.close()).cleanup, "complete");
        assert.equal(await f.ownership.inspect(), null);
      } finally { await f.dispose(); }
    });
  }
  for (const scenario of [
    { name: "bound trusted session", bound: true, sessionId: NATIVE_SESSION, visibility: "session" },
    { name: "bound null project", bound: true, sessionId: null, visibility: "project" },
    { name: "bound null branch", bound: true, sessionId: null, visibility: "branch" },
    { name: "sessionless null project", bound: false, sessionId: null, visibility: "project" },
    { name: "sessionless null branch", bound: false, sessionId: null, visibility: "branch" },
  ]) {
    test(`item_session supervisor accepts ${operation} ${scenario.name}`, async () => {
      const f = await fixture(scenario.bound);
      try {
        const pending = f.query(operation === "search-projected-content" ? nativeSearchRequest() : nativeGetRequest("record"));
        await until(() => !!f.ports[0]?.boot()); const p = f.ports[0]!; p.stages(); const reply = p.success();
        assert.equal(reply.receipt.scope.sessionId, null);
        const value = operation === "search-projected-content" ? reply.content.items[0] : reply.content.item;
        value.sessionId = scenario.sessionId; value.visibility = scenario.visibility;
        p.events.emit("message", reply); p.events.emit("exit", 0, null);
        const result = await pending;
        assert.equal(result.content.selectionScope.sessionId, scenario.bound ? NATIVE_SESSION : null);
        assert.equal(f.ports.length, 1); assert.equal(await f.ownership.inspect(), null);
      } finally { await f.dispose(); }
    });
  }
}

test("original_budget_and_cleanup_preserve_primary_failure", async () => {
  for (const primary of ["WORKER_TIMEOUT", "INTEGRITY_FAILURE", "V2_CONTENT_CURSOR_STALE"] as const) {
    const f = await fixture(); try {
      const outcome = f.query({ ...(primary === "V2_CONTENT_CURSOR_STALE" ? workflowRequest("list-canonical-records") : nativeGetRequest("record")), budgetMs: 1000 }).catch(cause => cause);
      await until(() => !!f.ports[0]?.boot()); const child = f.ports[0]!;
      if (primary === "WORKER_TIMEOUT") { child.stages(); f.clock.advance(1000); child.events.emit("message", child.success()); }
      else child.events.emit("message", { version: 3, ids: child.boot().ids, kind: "failure", failure: { code: primary, cleanup: "incomplete", positions: null } });
      assert.equal((await outcome).code, primary); f.clock.advance(2000);
      assert.equal(f.adapter.diagnostic().code, primary); assert.equal(f.adapter.diagnostic().cleanup, "incomplete");
      assert.equal(f.ports.length, 1); assert.equal(await f.ownership.inspect() !== null, true);
    } finally { await f.dispose(); }
  }
});
test("epoch change during ownership closure rejects exact validated content candidate", async () => {
  const f = await fixture(); const gate = deferred(), reached = deferred(), complete = f.ownership.complete.bind(f.ownership);
  f.ownership.complete = async ids => { reached.resolve(); await gate.promise; return complete(ids); };
  try {
    const outcome = f.query(nativeGetRequest("record")).catch(cause => cause); await until(() => !!f.ports[0]?.boot());
    const p = f.ports[0]!; p.stages(); p.events.emit("message", p.success()); p.events.emit("exit", 0, null); await until(() => reached.resolved);
    f.setEpoch("changed"); gate.resolve(); assert.equal((await outcome).code, "FRESH_START_ADMISSION_STALE");
  } finally { gate.resolve(); await f.dispose(); }
});
test("shared metadata and content queue retains arrival budget, zero budget and queued cancellation", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.query({ ...nativeGetRequest("record"), budgetMs: 0 }), { code: "WORKER_TIMEOUT" }); assert.equal(f.ports.length, 0);
    const first = f.adapter.verify(readBootstrap().request as MetadataVerifiedReadRequest); await until(() => !!f.ports[0]?.boot());
    const cancel = new AbortController(); const queued = f.query(nativeGetRequest("record"), { signal: cancel.signal }).catch(cause => cause); cancel.abort();
    assert.equal((await queued).code, "WORKER_CLOSED");
    const expired = f.query({ ...nativeGetRequest("record"), budgetMs: 100 }).catch(cause => cause);
    const others = Array.from({ length: 6 }, () => f.query(nativeGetRequest("record")).catch(cause => cause));
    await assert.rejects(f.query(nativeGetRequest("record")), { code: "STORE_QUEUE_FULL" });
    f.clock.advance(100, false); const p = f.ports[0]!; p.stages(); p.events.emit("message", p.success()); p.events.emit("exit", 0, null); await first;
    assert.equal((await expired).code, "WORKER_TIMEOUT"); assert.equal(f.ports.length, 1);
    f.clock.advance(5000); await Promise.all(others);
  } finally { await f.dispose(); }
});

// Real blocked SQL lives solely in a disposable fixture process after genuine image/lock validation.
test("actual blocked native query preserves parent responsiveness, exact exits and unrelated writer", { timeout: 15000 }, async () => {
  const f = await makeNativeContentFixture(); let closed = false; let adapter: ReturnType<typeof createVerifiedReadAdapter> | undefined;
  const executable = fileURLToPath(new URL("./fixtures/v2-verified-read-process-fixture.js", import.meta.url));
  const children: ChildProcess[] = [], exits: { kind: string; code: number | null; signal: string | null }[] = [];
  let activeChildren = 0, activeReadOrCleanupChildrenMaximum = 0;
  const spawn = (kind: string) => {
    const child = fork(executable, [kind], { cwd: f.binding.projectionDirectory.canonicalPath, execArgv: [],
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {},
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] } as ForkOptions);
    children.push(child); if (kind !== "writer") activeReadOrCleanupChildrenMaximum = Math.max(activeReadOrCleanupChildrenMaximum, ++activeChildren);
    child.once("exit", (code, signal) => { exits.push({ kind, code, signal }); if (kind !== "writer") activeChildren--; }); return child;
  };
  const exists = async (name: string) => { try { await stat(join(f.binding.projectionDirectory.canonicalPath, name)); return true; } catch { return false; } };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, ms = 3000) => { const deadline = performance.now() + ms;
    while (!await predicate()) { assert.ok(performance.now() < deadline, "real process barrier inconclusive"); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const writer = spawn("writer");
  try {
    await waitFor(() => exists("writer-ready"));
    const writerBytes = await readFile(join(f.binding.projectionDirectory.canonicalPath, "independent-writer.sqlite"));
    adapter = createVerifiedReadAdapter(f.binding, { ownership: new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory),
      now: () => performance.now(), schedule: (cb, ms) => setTimeout(cb, ms), clear: timer => clearTimeout(timer as NodeJS.Timeout),
      currentEpoch: () => f.binding.compositionEpoch, spawnOwned(kind) {
        const child = spawn(kind === "read" ? "query-hang" : "cleanup"); const errors = new Set<(error: unknown) => void>();
        child.on("error", cause => { for (const callback of errors) callback(cause); });
        return { get pid() { return child.pid; }, send(value) { child.send(value, cause => { if (cause) for (const cb of errors) cb(cause); }); },
          onMessage(cb) { child.on("message", cb); return () => { child.off("message", cb); }; },
          onExit(cb) { child.on("close", cb); return () => { child.off("close", cb); }; },
          onOutput(cb) { const out = (bytes: Buffer) => cb("stdout", bytes), err = (bytes: Buffer) => cb("stderr", bytes);
            child.stdout!.on("data", out); child.stderr!.on("data", err); return () => { child.stdout!.off("data", out); child.stderr!.off("data", err); }; },
          onError(cb) { errors.add(cb); return () => { errors.delete(cb); }; }, terminate() { child.kill("SIGKILL"); }, unref() { child.unref(); child.channel?.unref(); } };
      } });
    const method = (adapter as unknown as { query?: (r: VerifiedContentReadRequest) => Promise<VerifiedContentReadResult> }).query;
    assert.equal(typeof method, "function", "native query must use the owned supervisor");
    const arrival = performance.now(); let ticks = 0; const ticker = setInterval(() => ticks++, 10);
    try {
      const outcome = method!({ ...nativeGetRequest("abcdefab-cdef-4abc-8abc-abcdefabcdef"), budgetMs: 2000 }).catch(cause => cause);
      await waitFor(() => exists("query-blocked"), 1800);
      assert.equal(await readFile(join(f.binding.projectionDirectory.canonicalPath, "query-blocked"), "utf8"), "validated-image-owned-lock-fixed-canonical-query");
      assert.equal(typeof (await new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory).inspect())?.pid, "number");
      assert.equal(await exists(".projection-manifest.publish.lock"), true);
      assert.equal((await outcome).code, "WORKER_TIMEOUT"); assert.ok(performance.now() - arrival <= 3000); assert.ok(ticks >= 5);
      const diagnostic = await adapter.close(); closed = diagnostic.cleanup === "complete";
      assert.equal(diagnostic.cleanup, "complete"); assert.equal(activeReadOrCleanupChildrenMaximum, 1);
      assert.equal(exits.filter(x => x.kind === "query-hang").length, 1);
      assert.deepEqual(exits.find(x => x.kind === "cleanup"), { kind: "cleanup", code: 0, signal: null });
      const unrelatedWriterKilled = exits.some(x => x.kind === "writer"); assert.equal(unrelatedWriterKilled, false); assert.equal(writer.exitCode, null);
      assert.deepEqual(await readFile(join(f.binding.projectionDirectory.canonicalPath, "independent-writer.sqlite")), writerBytes);
      assert.equal(await exists(".projection-manifest.publish.lock"), false);
      assert.equal(await new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory).inspect(), null);
    } finally { clearInterval(ticker); }
    writer.send("stop"); await waitFor(() => exits.some(x => x.kind === "writer"));
    assert.deepEqual(exits.find(x => x.kind === "writer"), { kind: "writer", code: 0, signal: null });
    console.log(`native query closure exits=${JSON.stringify(exits)} readOrCleanupMaximum=${activeReadOrCleanupChildrenMaximum} ownershipAbsent=true writerSurvived=true`);
  } finally {
    await adapter?.close(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
    if (closed || !adapter) f.cleanup(); else console.error(`Retained uncertain native query fixture: ${f.root}`);
  }
});

const workflowOperations = ["list-canonical-records", "recent-canonical-records", "follow-up-radar", "build-context-pack"] as const;
function workflowRequest(operation: typeof workflowOperations[number]): VerifiedContentReadRequest {
  return { operation, consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000,
    parameters: operation === "build-context-pack" ? { query: "native" } : { limit: 5 } } as VerifiedContentReadRequest;
}
for (const operation of workflowOperations) test(`workflow_candidate_waits_for_owned_completion ${operation}`, { timeout: 20000 }, async t => {
  const f = await fixture(); const gate = deferred(), reached = deferred();
  const target = join(f.directory.canonicalPath, "verified-read-owner.json"), unlink = fsPromises.unlink;
  const mock = t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof unlink>[0]) => {
    if (String(path) === target) { reached.resolve(); await gate.promise; } await unlink(path);
  }); syncBuiltinESMExports();
  try {
    let contentReleased = false; let candidateFailure: unknown; const pending = f.query(workflowRequest(operation)); void pending.then(() => { contentReleased = true; }, error => { candidateFailure = error; });
    await until(() => !!f.ports[0]?.boot()); const child = f.ports[0]!; child.stages(); child.events.emit("message", child.success());
    await turn(); assert.equal(candidateFailure, undefined, `nominal workflow refused: ${String(candidateFailure)}`); assert.equal(contentReleased, false); child.events.emit("exit", 0, null); await until(() => reached.resolved);
    assert.equal(contentReleased, false); assert.notEqual(JSON.parse(await readFile(target, "utf8")), null);
    gate.resolve(); const result = await pending; assert.equal(result.content.operation, operation);
    assert.equal(result.receipt.scope.sessionId, null); assert.equal(result.content.selectionScope.sessionId, NATIVE_SESSION);
    assert.equal(await f.ownership.inspect(), null);
  } finally { gate.resolve(); mock.mock.restore(); syncBuiltinESMExports(); await f.dispose(); }
});
for (const operation of workflowOperations) for (const fault of ["selection", "cursor", "kind", "order", "status", "position"] as const) {
  test(`workflow supervisor rejects ${operation} ${fault}`, { timeout: 20000 }, async () => {
    const f = await fixture(); try {
      const pending = f.query(workflowRequest(operation)); const rejected = assert.rejects(pending, { code: "WORKER_PROTOCOL_ERROR" });
      await until(() => !!f.ports[0]?.boot()); const child = f.ports[0]!; child.stages(); const reply = child.success();
      if (fault === "selection") reply.content.selectionScope.sessionId = null;
      if (fault === "cursor") reply.content.nextCursor = "malformed";
      if (fault === "order") reply.content.order = "wrong-order";
      const item = operation === "list-canonical-records" || operation === "recent-canonical-records" ? reply.content.items[0].item : reply.content.items[0];
      if (fault === "kind") item.kind = "artifact";
      if (fault === "status") item.status = "retracted";
      if (fault === "position") item.sourceEventPosition = "1";
      child.events.emit("message", reply); child.events.emit("exit", 0, null);
      const cleanup = f.ports[1]; if (cleanup) { const boot = cleanup.sent[0] as CleanupBootstrap;
        cleanup.events.emit("message", { version: 1, ids: boot.ids, kind: "cleanup", outcome: "absent", cleanup: "complete" }); cleanup.events.emit("exit", 0, null); }
      await rejected;
    } finally { await f.dispose(); }
  });
}

for (const operation of workflowOperations) for (const fault of ["epoch", "late", "removal"] as const) test(`workflow candidate refuses ${operation} ${fault} at owned closure`, { timeout: 20000 }, async t => {
  const f = await fixture(); const gate = deferred(), reached = deferred();
  const target = join(f.directory.canonicalPath, "verified-read-owner.json"), unlink = fsPromises.unlink;
  const mock = t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof unlink>[0]) => {
    if (String(path) === target) { reached.resolve(); await gate.promise; if (fault === "removal") throw new Error("owned removal failed"); }
    await unlink(path);
  }); syncBuiltinESMExports();
  try {
    let contentReleased = false; const outcome = f.query(workflowRequest(operation)).then(result => { contentReleased = true; return result; }, error => error);
    await until(() => !!f.ports[0]?.boot()); const child = f.ports[0]!; child.stages(); child.events.emit("message", child.success());
    assert.equal(contentReleased, false); child.events.emit("exit", 0, null); await until(() => reached.resolved);
    if (fault === "epoch") f.setEpoch("changed");
    if (fault === "late") f.clock.advance(5000);
    gate.resolve(); assert.equal((await outcome).code, fault === "epoch" ? "FRESH_START_ADMISSION_STALE" : fault === "late" ? "WORKER_TIMEOUT" : "WORKER_UNAVAILABLE");
    assert.equal(contentReleased, false);
    if (fault === "removal") { assert.notEqual(await f.ownership.inspect(), null); assert.equal(f.adapter.diagnostic().cleanup, "incomplete"); }
  } finally { gate.resolve(); mock.mock.restore(); syncBuiltinESMExports(); await f.dispose(); }
});
