import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fork, type ForkOptions } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Socket } from "node:net";
import type { CleanupBootstrap, CleanupReply, ReadBootstrap, ReadCancel, ReadMessageIds, ReadPhase, ReadReply,
  VerifiedReadBinding, VerifiedReadDiagnostic, VerifiedReadFailureCode, VerifiedReadReceipt, VerifiedReadRequest } from "./contracts.js";
import { decodeCleanupReply, decodeReadBootstrap, decodeReadReply, decodeVerifiedReadRequest, verifiedReadFailure } from "./protocol.js";
import { VerifiedReadOwnershipRepository } from "./ownership.js";

export interface OwnedReadProcess {
  readonly pid: number | undefined;
  send(envelope: ReadBootstrap | CleanupBootstrap | ReadCancel): void;
  onMessage(handler: (value: unknown) => void): () => void;
  /** Native ports deliver only after actual exit AND IPC/stdio drainage. terminate is never exit evidence. */
  onExit(handler: (code: number | null, signal: string | null) => void): () => void;
  onOutput(handler: (stream: "stdout" | "stderr", bytes: Uint8Array) => void): () => void;
  onError(handler: (error: unknown) => void): () => void;
  terminate(): void;
  unref(): void;
}
export interface VerifiedReadSupervisorDependencies {
  ownership: VerifiedReadOwnershipRepository;
  now(): number;
  schedule(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
  currentEpoch(): string;
  spawnOwned(kind: "read" | "cleanup"): OwnedReadProcess;
}
export interface VerifiedReadAdapter {
  verify(request: VerifiedReadRequest, options?: { signal?: AbortSignal }): Promise<VerifiedReadReceipt>;
  diagnostic(): VerifiedReadDiagnostic;
  close(): Promise<VerifiedReadDiagnostic>;
}
const PHASES: ReadPhase[] = ["admission", "projection-wait", "capture", "validate", "revalidate"];
const CLEANUP_MS = 2000;
function error(code: VerifiedReadFailureCode) { return Object.assign(new Error(code), { code }); }
function matches(a: ReadMessageIds, b: ReadMessageIds): boolean { return a.requestId === b.requestId && a.attemptId === b.attemptId && a.laneEpoch === b.laneEpoch; }
type ProcessState = { port: OwnedReadProcess; kind: "read" | "cleanup"; exited: boolean; normal: boolean; terminated: boolean;
  listeners: (() => void)[]; stdout: number; stderr: number; messages: number; stage: number; terminal?: ReadReply | CleanupReply };
type Lane = { sequence: number; ids: ReadMessageIds; request: VerifiedReadRequest; deadline: number; token: string;
  resolve(value: VerifiedReadReceipt): void; reject(reason: unknown): void; settled: boolean; responseTimer?: unknown; abort?: () => void;
  phase: VerifiedReadDiagnostic["phase"]; code: VerifiedReadFailureCode | null; positions: VerifiedReadDiagnostic["positions"];
  inFlight: number; started: boolean; recordOwned: boolean; recordClosed: boolean; recordClosing: boolean;
  read?: ProcessState; cleanupChild?: ProcessState; cleanupStarted?: number; cleanupTimer?: unknown; graceTimer?: unknown;
  incomplete: boolean; done: boolean };

async function proveDeployment(binding: VerifiedReadBinding): Promise<void> {
  const directory = binding.deploymentDirectory; const before = await lstat(directory.canonicalPath, { bigint: true });
  const canonical = await realpath(directory.canonicalPath);
  const equal = process.platform === "win32" ? canonical.toLowerCase() === directory.canonicalPath.toLowerCase() : canonical === directory.canonicalPath;
  if (!before.isDirectory() || before.isSymbolicLink() || !equal || String(before.dev) !== directory.device || String(before.ino) !== directory.inode) throw error("FRESH_START_PATH_CHANGED");
  for (const name of ["v2-internal-verified-read.js", "v2-internal-verified-read-cleanup.js"]) {
    const stat = await lstat(join(canonical, name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw error("FRESH_START_PATH_CHANGED");
  }
  const after = await lstat(directory.canonicalPath, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) throw error("FRESH_START_PATH_CHANGED");
}
function nativeProcess(binding: VerifiedReadBinding, kind: "read" | "cleanup"): OwnedReadProcess {
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === "win32") for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const entry = join(binding.deploymentDirectory.canonicalPath, kind === "read" ? "v2-internal-verified-read.js" : "v2-internal-verified-read-cleanup.js");
  const options = { execPath: process.execPath, execArgv: [], cwd: binding.projectionDirectory.canonicalPath,
    env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" } as ForkOptions;
  const child = fork(entry, [], options);
  const errors = new Set<(value: unknown) => void>();
  child.on("error", value => { for (const handler of errors) handler(value); });
  let actual: { code: number | null; signal: string | null } | undefined;
  child.once("exit", (code, signal) => { actual = { code, signal }; });
  return {
    get pid() { return child.pid; },
    send(envelope) { child.send(envelope, sendError => { if (sendError) for (const handler of errors) handler(sendError); }); },
    onMessage(handler) { child.on("message", handler); return () => { child.off("message", handler); }; },
    onExit(handler) { const closed = () => { if (actual) handler(actual.code, actual.signal); else for (const onError of errors) onError(error("WORKER_UNAVAILABLE")); };
      child.on("close", closed); return () => { child.off("close", closed); }; },
    onOutput(handler) { const stdout = (bytes: Buffer) => handler("stdout", bytes); const stderr = (bytes: Buffer) => handler("stderr", bytes);
      child.stdout!.on("data", stdout); child.stderr!.on("data", stderr);
      return () => { child.stdout!.off("data", stdout); child.stderr!.off("data", stderr); child.stdout!.resume(); child.stderr!.resume(); }; },
    onError(handler) { errors.add(handler); return () => { errors.delete(handler); }; },
    terminate() { child.kill("SIGKILL"); },
    unref() { child.unref(); child.channel?.unref(); (child.stdout as Socket | null)?.unref(); (child.stderr as Socket | null)?.unref(); },
  };
}

/** Private composition factory. All response work, including initial ownership inspection, shares arrival time. */
export function createVerifiedReadAdapter(input: VerifiedReadBinding, dependencies?: VerifiedReadSupervisorDependencies): VerifiedReadAdapter {
  // The existing descriptor-first decoder bounds copying and never invokes caller accessors/toJSON.
  const binding = decodeReadBootstrap({ version: 1, ids: { requestId: "copy", attemptId: "copy", laneEpoch: "copy" }, binding: input,
    request: { operation: "verify-published-view", consistency: "project-strong", minimumEventPosition: "9223372036854775807", budgetMs: 0 },
    lockToken: "0".repeat(32), remainingMs: 0 }).binding;
  const deps: VerifiedReadSupervisorDependencies = dependencies ?? { ownership: new VerifiedReadOwnershipRepository(binding.executorStateDirectory),
    now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms), clear: timer => clearTimeout(timer as NodeJS.Timeout),
    currentEpoch: () => binding.compositionEpoch, spawnOwned: kind => nativeProcess(binding, kind) };
  const supervisorId = randomUUID(); const fingerprint = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const queue: Lane[] = []; let active: Lane | undefined; let sequence = 0; let closedThrough = 0; let closing = false; let quarantine = false;
  let last: VerifiedReadDiagnostic = { attemptId: null, phase: "idle", code: null, cleanup: "complete", pendingCount: 0, positions: null };
  const closeWaiters: ((value: VerifiedReadDiagnostic) => void)[] = [];
  const count = () => queue.filter(lane => !lane.settled).length + (active ? 1 : 0);
  const diagnostic = (): VerifiedReadDiagnostic => Object.freeze({ ...(active ? { attemptId: active.ids.attemptId, phase: active.phase,
    code: active.code, cleanup: active.incomplete ? "incomplete" as const : "pending" as const, positions: active.positions } : last), pendingCount: count() });
  function notifyClosed() { if (closing && (!active || active.incomplete)) { const value = diagnostic(); for (const resolve of closeWaiters.splice(0)) resolve(value); } }
  function settle(lane: Lane, failure?: VerifiedReadFailureCode, receipt?: VerifiedReadReceipt) {
    if (lane.settled) return; lane.settled = true; deps.clear(lane.responseTimer); lane.abort?.();
    if (failure) { lane.code ??= failure; lane.reject(error(failure)); } else lane.resolve(receipt!);
  }
  function stopProcess(state: ProcessState | undefined) {
    if (!state || state.exited || state.terminated) return; state.terminated = true;
    try { state.port.terminate(); } catch { /* Only an observed exit can complete this branch. */ }
  }
  function detach(state: ProcessState | undefined, unref = false) {
    if (!state) return; for (const remove of state.listeners.splice(0)) remove(); if (unref && !state.exited) { try { state.port.unref(); } catch { /* retained */ } }
  }
  function expireCleanup(lane: Lane) {
    if (lane.done || lane.incomplete) return;
    lane.incomplete = true; quarantine = true; lane.phase = "cleanup"; deps.clear(lane.graceTimer); deps.clear(lane.cleanupTimer);
    stopProcess(lane.read); stopProcess(lane.cleanupChild); detach(lane.read, true); detach(lane.cleanupChild, true);
    if (lane.recordOwned && !lane.recordClosed) void deps.ownership.retainIncomplete(lane.ids).catch(() => undefined);
    for (const waiting of queue.splice(0)) settle(waiting, "WORKER_UNAVAILABLE"); notifyClosed();
  }
  function cleanupLive(lane: Lane): boolean {
    if (lane.done || lane.incomplete) return false;
    if (lane.cleanupStarted !== undefined && deps.now() - lane.cleanupStarted >= CLEANUP_MS) { expireCleanup(lane); return false; }
    return true;
  }
  function finish(lane: Lane, receipt?: VerifiedReadReceipt) {
    if (!cleanupLive(lane)) return;
    if (receipt && !eligible(lane)) return;
    lane.done = true; deps.clear(lane.cleanupTimer); deps.clear(lane.graceTimer); detach(lane.read); detach(lane.cleanupChild);
    if (receipt) settle(lane, undefined, receipt);
    closedThrough = Math.max(closedThrough, lane.sequence);
    last = { attemptId: lane.ids.attemptId, phase: closing ? "closed" : "idle", code: lane.code, cleanup: "complete", pendingCount: 0, positions: lane.positions };
    if (active === lane) active = undefined; notifyClosed(); pump();
  }
  function fail(lane: Lane, failure: VerifiedReadFailureCode) {
    if (lane.done || lane.incomplete) return; settle(lane, failure);
    if (active !== lane) { const index = queue.indexOf(lane); if (index !== -1) queue.splice(index, 1); return; }
    if (lane.cleanupStarted === undefined) {
      lane.cleanupStarted = deps.now(); lane.phase = "cleanup";
      lane.cleanupTimer = deps.schedule(() => expireCleanup(lane), CLEANUP_MS);
      if (lane.read && !lane.read.exited) {
        try { lane.read.port.send({ version: 1, ids: lane.ids, kind: "cancel" }); } catch { /* grace/terminate still apply */ }
        lane.graceTimer = deps.schedule(() => { if (cleanupLive(lane)) stopProcess(lane.read); }, 100);
      }
    }
    progressCleanup(lane);
  }
  function eligible(lane: Lane): boolean {
    if (lane.done || lane.incomplete || lane.settled) return false;
    if (deps.now() >= lane.deadline) { fail(lane, "WORKER_TIMEOUT"); return false; }
    if (deps.currentEpoch() !== lane.ids.laneEpoch) { fail(lane, "FRESH_START_ADMISSION_STALE"); return false; }
    return true;
  }
  async function closeRecord(lane: Lane, receipt?: VerifiedReadReceipt) {
    if (lane.recordClosing || lane.inFlight || !cleanupLive(lane)) return;
    lane.recordClosing = true; lane.inFlight++;
    try {
      if (lane.recordOwned && !lane.recordClosed) { await deps.ownership.complete(lane.ids); lane.recordClosed = true; }
      lane.inFlight--; lane.recordClosing = false;
      if (!cleanupLive(lane)) return;
      if (receipt && !lane.settled) { if (eligible(lane)) finish(lane, receipt); }
      else finish(lane);
    } catch { lane.inFlight--; lane.recordClosing = false; if (!lane.settled) fail(lane, "WORKER_UNAVAILABLE"); expireCleanup(lane); }
  }
  function oldLane(value: unknown): boolean {
    // Bounded identity peek only. Decoder handles all current/unknown traffic; no growing closed-ID cache.
    try {
      if (!value || typeof value !== "object") return false;
      const idsValue = Object.getOwnPropertyDescriptor(value, "ids"); if (!idsValue || !("value" in idsValue) || !idsValue.value || typeof idsValue.value !== "object") return false;
      const field = (key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(idsValue.value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; };
      const epoch = field("laneEpoch"); if (typeof epoch === "string" && epoch.length <= 128 && epoch !== binding.compositionEpoch) return true;
      const id = field("requestId"); if (typeof id !== "string" || id.length > 128 || !id.startsWith(`${supervisorId}:`)) return false;
      const suffix = id.slice(supervisorId.length + 1); if (!/^[1-9][0-9]{0,15}$/u.test(suffix)) return false;
      return Number(suffix) <= closedThrough;
    } catch { return false; }
  }
  function validateSuccess(lane: Lane, reply: Extract<ReadReply, { kind: "success" }>) {
    const { receipt, fence } = reply; const scope = { ...binding.projectionBinding, sessionId: lane.request.consistency === "session-strong" ? binding.session?.sessionId ?? null : null };
    const required = [BigInt(fence.capturedPosition), BigInt(lane.request.minimumEventPosition), BigInt(binding.session?.minimumEventPosition ?? "0")]
      .reduce((left, right) => left > right ? left : right);
    if (receipt.consistency !== lane.request.consistency || Object.keys(scope).some(key => scope[key as keyof typeof scope] !== receipt.scope[key as keyof typeof scope])
      || receipt.releaseId !== binding.expectedRelease.releaseId || receipt.controlGeneration !== binding.controlGeneration
      || fence.releaseId !== receipt.releaseId || fence.controlGeneration !== receipt.controlGeneration || fence.requiredPosition !== receipt.requiredEventPosition
      || BigInt(receipt.projectionEventPosition) < required || BigInt(fence.requiredPosition) !== required
      || (receipt.projectionEventPosition === fence.capturedPosition && receipt.projectionEventHash !== fence.capturedHash)) throw error("WORKER_PROTOCOL_ERROR");
  }
  function observe(lane: Lane, port: OwnedReadProcess, kind: "read" | "cleanup"): ProcessState {
    const state: ProcessState = { port, kind, exited: false, normal: false, terminated: false, listeners: [], stdout: 0, stderr: 0, messages: 0, stage: 0 };
    state.listeners.push(port.onMessage(value => {
      if (!cleanupLive(lane) || oldLane(value)) return;
      if (kind === "read" && !lane.settled && !eligible(lane)) return;
      try {
        if (++state.messages > 8) throw error("WORKER_PROTOCOL_ERROR");
        const reply = kind === "read" ? decodeReadReply(value) : decodeCleanupReply(value);
        if (!matches(reply.ids, lane.ids) || state.terminal || state.exited) throw error("WORKER_PROTOCOL_ERROR");
        if (reply.kind === "stage") {
          if (PHASES[state.stage++] !== reply.phase) throw error("WORKER_PROTOCOL_ERROR");
          if (!lane.settled) lane.phase = reply.phase;
        } else {
          state.terminal = reply;
          if (reply.kind === "success") { if (state.stage !== PHASES.length) throw error("WORKER_PROTOCOL_ERROR"); validateSuccess(lane, reply); }
          if (reply.kind === "failure") { lane.positions = reply.failure.positions; fail(lane, reply.failure.code); }
          if (reply.kind === "cleanup" && (reply.cleanup !== "complete" || !["released", "absent"].includes(reply.outcome))) expireCleanup(lane);
        }
      } catch { if (!lane.settled) fail(lane, "WORKER_PROTOCOL_ERROR"); else if (kind === "cleanup") expireCleanup(lane); }
    }));
    state.listeners.push(port.onOutput((stream, bytes) => {
      if (!cleanupLive(lane)) return;
      state[stream] = Math.min(4097, state[stream] + bytes.byteLength);
      if (state[stream] > 4096) { if (!lane.settled) fail(lane, "WORKER_PROTOCOL_ERROR"); else if (kind === "cleanup") expireCleanup(lane); }
    }));
    state.listeners.push(port.onError(() => { if (!cleanupLive(lane)) return; if (!lane.settled) fail(lane, "WORKER_UNAVAILABLE"); else if (kind === "cleanup") expireCleanup(lane); }));
    state.listeners.push(port.onExit((code, signal) => {
      if (!cleanupLive(lane) || state.exited) return;
      state.exited = true; state.normal = code === 0 && signal === null;
      if (kind === "read" && !lane.settled) {
        if (!eligible(lane)) return;
        if (!state.normal || state.terminal?.kind !== "success") fail(lane, "WORKER_UNAVAILABLE");
        else void closeRecord(lane, state.terminal.receipt);
      } else if (kind === "cleanup" && (!state.normal || state.terminal?.kind !== "cleanup")) expireCleanup(lane);
      else progressCleanup(lane);
    }));
    return state;
  }
  function progressCleanup(lane: Lane) {
    if (lane.cleanupStarted === undefined || !cleanupLive(lane) || lane.inFlight || lane.recordClosing) return;
    if (lane.read && !lane.read.exited) return;
    if (!lane.read || lane.recordClosed) { void closeRecord(lane); return; }
    if (!lane.cleanupChild) {
      try {
        const port = deps.spawnOwned("cleanup"); lane.cleanupChild = observe(lane, port, "cleanup");
        if (!cleanupLive(lane)) return;
        port.send({ version: 1, ids: lane.ids, directory: binding.projectionDirectory, lockToken: lane.token,
          expectedBuildHash: binding.expectedRelease.buildIdentityHash, remainingMs: Math.max(0, CLEANUP_MS - (deps.now() - lane.cleanupStarted)) });
      } catch { expireCleanup(lane); }
      return;
    }
    const cleanup = lane.cleanupChild;
    if (cleanup.exited && cleanup.normal && cleanup.terminal?.kind === "cleanup" && cleanup.terminal.cleanup === "complete") void closeRecord(lane);
  }
  async function start(lane: Lane) {
    lane.started = true; lane.phase = "startup";
    try {
      lane.inFlight++; const existing = await deps.ownership.inspect(); lane.inFlight--;
      // Retained ownership must quarantine even when the response settled while inspection was pending.
      // Do not let the generic ineligible/no-child path label someone else's record positively closed.
      if (existing) {
        if (!lane.settled) settle(lane, deps.now() >= lane.deadline ? "WORKER_TIMEOUT"
          : deps.currentEpoch() !== lane.ids.laneEpoch ? "FRESH_START_ADMISSION_STALE" : "WORKER_UNAVAILABLE");
        expireCleanup(lane); return;
      }
      if (!eligible(lane)) { progressCleanup(lane); return; }
      lane.inFlight++;
      await deps.ownership.begin({ schemaVersion: 1, bindingFingerprint: fingerprint, buildHash: binding.expectedRelease.buildIdentityHash,
        supervisorId, ids: lane.ids, lockToken: lane.token }); lane.recordOwned = true; lane.inFlight--;
      if (!eligible(lane)) { progressCleanup(lane); return; }
      if (!dependencies) { lane.inFlight++; await proveDeployment(binding); lane.inFlight--; if (!eligible(lane)) { progressCleanup(lane); return; } }
      const port = deps.spawnOwned("read"); lane.read = observe(lane, port, "read");
      if (!eligible(lane)) return;
      if (port.pid === undefined) throw error("WORKER_UNAVAILABLE");
      lane.inFlight++; await deps.ownership.observeChild(lane.ids, port.pid); lane.inFlight--;
      if (!eligible(lane)) { progressCleanup(lane); return; }
      port.send({ version: 1, ids: lane.ids, binding, request: lane.request, lockToken: lane.token, remainingMs: Math.max(0, lane.deadline - deps.now()) });
    } catch (cause) {
      lane.inFlight = Math.max(0, lane.inFlight - 1);
      // Failed durable operations can have published before rejecting. Preserve that uncertainty.
      // Do not run the no-child cleanup fast path before latching quarantine for unknown ownership.
      if (!lane.read) { settle(lane, verifiedReadFailure(cause).code); expireCleanup(lane); }
      else { if (!lane.settled) fail(lane, verifiedReadFailure(cause).code); progressCleanup(lane); }
    }
  }
  function pump() {
    if (active || closing || quarantine) return;
    const lane = queue.shift(); if (!lane) return;
    if (!eligible(lane)) { pump(); return; } active = lane; void start(lane);
  }
  return Object.freeze({
    diagnostic,
    verify(value: VerifiedReadRequest, options?: { signal?: AbortSignal }): Promise<VerifiedReadReceipt> {
      const arrival = deps.now();
      return new Promise((resolve, reject) => {
        let request: VerifiedReadRequest;
        try { request = decodeVerifiedReadRequest(value, binding.session); } catch { reject(error("FRESH_START_INPUT_INVALID")); return; }
        if (deps.now() >= arrival + request.budgetMs) { reject(error("WORKER_TIMEOUT")); return; }
        if (closing || options?.signal?.aborted) { reject(error("WORKER_CLOSED")); return; }
        if (quarantine) { reject(error("WORKER_UNAVAILABLE")); return; }
        if (count() >= 8) { reject(error("STORE_QUEUE_FULL")); return; }
        const number = ++sequence; const lane: Lane = { sequence: number, ids: Object.freeze({ requestId: `${supervisorId}:${number}`, attemptId: randomUUID(), laneEpoch: binding.compositionEpoch }),
          request, deadline: arrival + request.budgetMs, token: randomBytes(16).toString("hex"), resolve, reject, settled: false,
          phase: "queue", code: null, positions: null, inFlight: 0, started: false, recordOwned: false, recordClosed: false, recordClosing: false, incomplete: false, done: false };
        lane.responseTimer = deps.schedule(() => fail(lane, "WORKER_TIMEOUT"), Math.max(0, lane.deadline - deps.now()));
        if (options?.signal) { const signal = options.signal; const abort = () => fail(lane, "WORKER_CLOSED"); signal.addEventListener("abort", abort, { once: true }); lane.abort = () => signal.removeEventListener("abort", abort); }
        queue.push(lane); pump();
      });
    },
    close(): Promise<VerifiedReadDiagnostic> {
      closing = true; for (const lane of queue.splice(0)) settle(lane, "WORKER_CLOSED");
      if (active && !active.settled) fail(active, "WORKER_CLOSED");
      if (!active || active.incomplete) { last = { ...last, phase: "closed" }; return Promise.resolve(diagnostic()); }
      return new Promise(resolve => { closeWaiters.push(resolve); notifyClosed(); });
    },
  });
}
