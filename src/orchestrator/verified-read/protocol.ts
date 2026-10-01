import { decodeFreshStartRelease, FreshStartError } from "../fresh-start/contracts.js";
import { isProjectionProjectStoreIdentity, type ProjectBinding } from "../projections/contracts.js";
import type { ProjectionDirectoryIdentity } from "../projections/stable-directory.js";
import type { CleanupBootstrap, CleanupReply, ReadBootstrap, ReadCancel, ReadCleanupState,
  ReadFailurePositions, ReadFence, ReadMessageIds, ReadPhase, ReadReply, TrustedReadSession,
  VerifiedReadBinding, VerifiedReadFailure, VerifiedReadFailureCode, VerifiedReadReceipt, VerifiedReadRequest } from "./contracts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const INT64_MAX = "9223372036854775807";
const SCOPE_KEYS = ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"];
const PHASES: readonly ReadPhase[] = ["admission", "projection-wait", "capture", "validate", "revalidate"];
const CODES: readonly VerifiedReadFailureCode[] = [
  "FRESH_START_INPUT_INVALID", "FRESH_START_CONTEXT_REQUIRED", "FRESH_START_NOT_INITIALIZED",
  "FRESH_START_IDENTITY_MISMATCH", "FRESH_START_PATH_INVALID", "FRESH_START_PATH_CHANGED",
  "FRESH_START_BUILD_MISMATCH", "FRESH_START_SCHEMA_MISMATCH", "FRESH_START_RELEASE_MISMATCH",
  "FRESH_START_ADMISSION_DENIED", "FRESH_START_CONTENT_UNVERIFIED", "FRESH_START_ADMISSION_STALE",
  "PROJECTION_LAG", "INTEGRITY_FAILURE", "PROJECTION_SCOPE_MISMATCH", "PROJECTION_PATH_INVALID",
  "MATERIALIZATION_CONFLICT", "WORKER_TIMEOUT", "WORKER_CLOSED", "STORE_QUEUE_FULL",
  "WORKER_PROTOCOL_ERROR", "WORKER_UNAVAILABLE",
];
function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }

/** Descriptor-first copy with a running canonical JSON byte count. No caller toJSON/getter is called.
 * Strings, depth, record count and keys are bounded before serialization or recursive allocation. */
function bounded(value: unknown, maximumBytes: number): unknown {
  let bytes = 0;
  let records = 0;
  const charge = (amount: number): void => { bytes += amount; if (bytes > maximumBytes) invalid(); };
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null) { charge(4); return null; }
    if (typeof input === "string") {
      if (input.length > 2048 || Buffer.byteLength(input, "utf8") > 2048) invalid();
      charge(Buffer.byteLength(JSON.stringify(input), "utf8")); return input;
    }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) invalid(); charge(String(input).length); return input;
    }
    if (typeof input !== "object" || depth > 8 || ++records > 128) invalid();
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 32) invalid();
    charge(2 + Math.max(0, keys.length - 1));
    const descriptors: [string, PropertyDescriptor][] = [];
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 128) invalid();
      charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      descriptors.push([key, descriptor]);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of descriptors) result[key] = copy(descriptor.value, depth + 1);
    return Object.freeze(result);
  };
  try { return copy(value, 0); } catch { return invalid(); }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null) invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) invalid();
  return value;
}
function uuid(value: unknown): string { const result = text(value, 36); if (!UUID.test(result)) invalid(); return result; }
function hash(value: unknown): string { const result = text(value, 64); if (!HASH.test(result)) invalid(); return result; }
function position(value: unknown): string {
  if (typeof value !== "string" || value.length > 19 || !/^(0|[1-9][0-9]*)$/u.test(value)
    || (value.length === 19 && value > INT64_MAX)) invalid();
  return value;
}
function consistency(value: unknown): VerifiedReadRequest["consistency"] {
  if (value !== "session-strong" && value !== "project-strong") invalid(); return value;
}
export function resolveVerifiedReadBudget(mode: VerifiedReadRequest["consistency"], budgetMs?: number): number {
  consistency(mode);
  if (budgetMs === undefined) return mode === "session-strong" ? 2000 : 5000;
  if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > 30000) invalid();
  return budgetMs;
}
function session(value: unknown): TrustedReadSession | null {
  if (value === null) return null;
  const source = record(value, ["sessionId", "minimumEventPosition"]);
  return Object.freeze({ sessionId: uuid(source.sessionId), minimumEventPosition: position(source.minimumEventPosition) });
}
function request(value: unknown, trustedSession: TrustedReadSession | null): VerifiedReadRequest {
  const source = record(value, ["operation", "consistency", "minimumEventPosition", "budgetMs"]);
  if (source.operation !== "verify-published-view" || typeof source.budgetMs !== "number") invalid();
  const mode = consistency(source.consistency);
  const minimum = position(source.minimumEventPosition);
  if (mode === "session-strong" && trustedSession === null) invalid();
  if (trustedSession !== null && BigInt(minimum) < BigInt(trustedSession.minimumEventPosition)) invalid();
  return Object.freeze({ operation: "verify-published-view", consistency: mode, minimumEventPosition: minimum,
    budgetMs: resolveVerifiedReadBudget(mode, source.budgetMs) });
}
export function decodeVerifiedReadRequest(value: unknown, trustedSession: TrustedReadSession | null): VerifiedReadRequest {
  return request(bounded(value, 8192), session(bounded(trustedSession, 8192)));
}
function scope(value: unknown, image: boolean): ProjectBinding {
  const source = record(value, SCOPE_KEYS);
  for (const key of ["projectId", "vaultId", "storeId"]) if (!isProjectionProjectStoreIdentity(source[key])) invalid();
  const branchScopeId = source.branchScopeId === null ? null : uuid(source.branchScopeId);
  const branchRef = source.branchRef === null ? null : text(source.branchRef, 1024);
  const sessionId = source.sessionId === null ? null : uuid(source.sessionId);
  if (image && sessionId !== null) invalid();
  return Object.freeze({ projectId: source.projectId, vaultId: source.vaultId, storeId: source.storeId,
    workspaceId: hash(source.workspaceId), branchScopeId, branchRef, sessionId }) as ProjectBinding;
}
function directory(value: unknown): ProjectionDirectoryIdentity {
  const source = record(value, ["canonicalPath", "device", "inode"]);
  return Object.freeze({ canonicalPath: text(source.canonicalPath, 2048), device: text(source.device, 128), inode: text(source.inode, 128) });
}
function ids(value: unknown): ReadMessageIds {
  const source = record(value, ["requestId", "attemptId", "laneEpoch"]);
  return Object.freeze({ requestId: text(source.requestId, 128), attemptId: text(source.attemptId, 128), laneEpoch: text(source.laneEpoch, 128) });
}
function version(value: unknown): 1 { if (value !== 1) invalid(); return 1; }
function token(value: unknown): string { const result = text(value, 32); if (!/^[0-9a-f]{32}$/u.test(result)) invalid(); return result; }
function remaining(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) invalid(); return value;
}
function binding(value: unknown): VerifiedReadBinding {
  const source = record(value, ["projectionBinding", "expectedRelease", "controlGeneration", "session", "eventsFile",
    "projectionDirectory", "executorStateDirectory", "deploymentDirectory", "compositionEpoch"]);
  const projectionBinding = scope(source.projectionBinding, true);
  const expectedRelease = decodeFreshStartRelease(source.expectedRelease);
  for (const key of ["projectId", "vaultId", "storeId"] as const) if (projectionBinding[key] !== expectedRelease[key]) invalid();
  const events = record(source.eventsFile, ["path", "device", "inode"]);
  return Object.freeze({ projectionBinding, expectedRelease, controlGeneration: position(source.controlGeneration),
    session: session(source.session), eventsFile: Object.freeze({ path: text(events.path, 2048), device: text(events.device, 128), inode: text(events.inode, 128) }),
    projectionDirectory: directory(source.projectionDirectory), executorStateDirectory: directory(source.executorStateDirectory),
    deploymentDirectory: directory(source.deploymentDirectory), compositionEpoch: text(source.compositionEpoch, 128) });
}
export function decodeReadBootstrap(value: unknown): ReadBootstrap {
  const source = record(bounded(value, 8192), ["version", "ids", "binding", "request", "lockToken", "remainingMs"]);
  const bound = binding(source.binding);
  return Object.freeze({ version: version(source.version), ids: ids(source.ids), binding: bound,
    request: request(source.request, bound.session), lockToken: token(source.lockToken), remainingMs: remaining(source.remainingMs, 30000) });
}
export function decodeReadCancel(value: unknown): ReadCancel {
  const source = record(bounded(value, 16384), ["version", "ids", "kind"]);
  if (source.kind !== "cancel") invalid();
  return Object.freeze({ version: version(source.version), ids: ids(source.ids), kind: "cancel" });
}
function receipt(value: unknown): VerifiedReadReceipt {
  const source = record(value, ["operation", "consistency", "scope", "releaseId", "controlGeneration", "requiredEventPosition",
    "projectionGeneration", "projectionEventPosition", "projectionEventHash", "imageSha256", "verification"]);
  if (source.operation !== "verify-published-view" || source.verification !== "image-scope-position-and-active-admission"
    || typeof source.projectionGeneration !== "number" || !Number.isSafeInteger(source.projectionGeneration)
    || source.projectionGeneration < 1 || source.projectionGeneration > 2147483647) invalid();
  const mode = consistency(source.consistency);
  const boundScope = scope(source.scope, false);
  if (mode === "session-strong" && boundScope.sessionId === null) invalid();
  return Object.freeze({ operation: "verify-published-view", consistency: mode, scope: boundScope,
    releaseId: uuid(source.releaseId), controlGeneration: position(source.controlGeneration), requiredEventPosition: position(source.requiredEventPosition),
    projectionGeneration: source.projectionGeneration, projectionEventPosition: position(source.projectionEventPosition),
    projectionEventHash: hash(source.projectionEventHash), imageSha256: hash(source.imageSha256), verification: "image-scope-position-and-active-admission" });
}
export function decodeVerifiedReadReceipt(value: unknown): VerifiedReadReceipt { return receipt(bounded(value, 16384)); }
function fence(value: unknown): ReadFence {
  const source = record(value, ["controlGeneration", "releaseId", "capturedPosition", "capturedHash", "requiredPosition"]);
  return Object.freeze({ controlGeneration: position(source.controlGeneration), releaseId: uuid(source.releaseId),
    capturedPosition: position(source.capturedPosition), capturedHash: hash(source.capturedHash), requiredPosition: position(source.requiredPosition) });
}
function cleanup(value: unknown): ReadCleanupState {
  if (value !== "pending" && value !== "complete" && value !== "incomplete") invalid(); return value;
}
function positions(value: unknown): ReadFailurePositions | null {
  if (value === null) return null;
  const source = record(value, ["required", "observed"]);
  return Object.freeze({ required: position(source.required), observed: source.observed === null ? null : position(source.observed) });
}
function failure(value: unknown): VerifiedReadFailure {
  const source = record(value, ["code", "cleanup", "positions"]);
  if (!CODES.includes(source.code as VerifiedReadFailureCode)) invalid();
  const safePositions = positions(source.positions);
  if (source.code !== "PROJECTION_LAG" && safePositions !== null) invalid();
  return Object.freeze({ code: source.code as VerifiedReadFailureCode, cleanup: cleanup(source.cleanup), positions: safePositions });
}
export function decodeReadReply(value: unknown): ReadReply {
  const input = bounded(value, 16384);
  if (typeof input !== "object" || input === null) invalid();
  const kind = (input as Record<string, unknown>).kind;
  if (kind === "stage") {
    const source = record(input, ["version", "ids", "kind", "phase", "observedProjectionPosition"]);
    if (!PHASES.includes(source.phase as ReadPhase)) invalid();
    return Object.freeze({ version: version(source.version), ids: ids(source.ids), kind,
      phase: source.phase as ReadPhase, observedProjectionPosition: source.observedProjectionPosition === null ? null : position(source.observedProjectionPosition) });
  }
  if (kind === "success") {
    const source = record(input, ["version", "ids", "kind", "receipt", "fence", "closed"]);
    const closed = record(source.closed, ["image", "reader", "lock"]);
    if (closed.image !== true || closed.reader !== true || closed.lock !== true) invalid();
    return Object.freeze({ version: version(source.version), ids: ids(source.ids), kind, receipt: receipt(source.receipt), fence: fence(source.fence),
      closed: Object.freeze({ image: true, reader: true, lock: true }) });
  }
  if (kind === "failure") {
    const source = record(input, ["version", "ids", "kind", "failure"]);
    return Object.freeze({ version: version(source.version), ids: ids(source.ids), kind, failure: failure(source.failure) });
  }
  return invalid();
}
export function decodeCleanupBootstrap(value: unknown): CleanupBootstrap {
  const source = record(bounded(value, 8192), ["version", "ids", "directory", "lockToken", "expectedBuildHash", "remainingMs"]);
  return Object.freeze({ version: version(source.version), ids: ids(source.ids), directory: directory(source.directory),
    lockToken: token(source.lockToken), expectedBuildHash: hash(source.expectedBuildHash), remainingMs: remaining(source.remainingMs, 2000) });
}
export function decodeCleanupReply(value: unknown): CleanupReply {
  const source = record(bounded(value, 16384), ["version", "ids", "kind", "outcome", "cleanup"]);
  if (source.kind !== "cleanup" || !["released", "absent", "poisoned", "failed"].includes(source.outcome as string)
    || (source.cleanup !== "complete" && source.cleanup !== "incomplete")) invalid();
  return Object.freeze({ version: version(source.version), ids: ids(source.ids), kind: "cleanup",
    outcome: source.outcome as CleanupReply["outcome"], cleanup: source.cleanup });
}
/** Underlying exceptions are reduced to whitelisted scalar data, never serialized. */
export function verifiedReadFailure(error: unknown): VerifiedReadFailure {
  const fallback = Object.freeze({ code: "WORKER_UNAVAILABLE", cleanup: "pending", positions: null } as const);
  try {
    if (typeof error !== "object" || error === null) return fallback;
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const rawCode = own("code");
    const code = rawCode === undefined ? own("message") : rawCode;
    if (!CODES.includes(code as VerifiedReadFailureCode)) return fallback;
    let safePositions: ReadFailurePositions | null = null;
    if (code === "PROJECTION_LAG") {
      try { safePositions = positions(bounded(own("positions") ?? null, 256)); } catch { /* omit malformed diagnostics */ }
    }
    const rawCleanup = own("cleanup");
    const state = rawCleanup === "complete" || rawCleanup === "incomplete" ? rawCleanup : "pending";
    return Object.freeze({ code: code as VerifiedReadFailureCode, cleanup: state, positions: safePositions });
  } catch { return fallback; }
}
