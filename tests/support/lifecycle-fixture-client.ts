import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ProjectBindingService } from "../../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../../src/orchestrator/runtime/project-store-identity-probe.js";
import type {
  CapabilityKeyPurpose,
  LifecycleTestKeyBroker,
  SealedValueV1,
} from "./lifecycle-test-key-broker.js";

export type LifecycleFixtureJsonPrimitive = null | boolean | number | string;
export type LifecycleFixtureJsonValue =
  | LifecycleFixtureJsonPrimitive
  | readonly LifecycleFixtureJsonValue[]
  | { readonly [key: string]: LifecycleFixtureJsonValue };

export const LIFECYCLE_FIXTURE_BARRIER_NAMES = [
  "ready",
  "start",
  "binding",
  "open",
  "started",
  "mutation",
  "bounded",
  "query",
  "validation",
  "fault",
  "key-request",
  "key-response",
  "barrier-arm",
  "barrier-reached",
  "barrier-release",
  "result",
  "error",
  "close",
] as const;

export type LifecycleFixtureBarrierName = typeof LIFECYCLE_FIXTURE_BARRIER_NAMES[number];
export type LifecycleFixtureBarrierTarget = "mutation" | "bounded" | "query" | "validation" | "fault";
export type LifecycleFixtureRequestBarrier =
  | "start"
  | "binding"
  | "open"
  | LifecycleFixtureBarrierTarget
  | "barrier-arm"
  | "barrier-release";
type LifecycleFixtureResultRequest = Exclude<LifecycleFixtureRequestBarrier, "start">;

interface LifecycleFixturePayloadMessage<T extends LifecycleFixtureRequestBarrier> {
  readonly type: T;
  readonly requestId: string;
  readonly payload?: LifecycleFixtureJsonValue;
}

export interface LifecycleFixtureReadyMessage {
  readonly type: "ready";
  readonly childId: string;
  readonly pid: number;
  readonly payload?: LifecycleFixtureJsonValue;
}

export type LifecycleFixtureStartMessage = LifecycleFixturePayloadMessage<"start">;
export type LifecycleFixtureBindingMessage = LifecycleFixturePayloadMessage<"binding">;
export type LifecycleFixtureOpenMessage = LifecycleFixturePayloadMessage<"open">;
export type LifecycleFixtureStartedMessage = {
  readonly type: "started";
  readonly requestId: string;
  readonly childId: string;
  readonly payload?: LifecycleFixtureJsonValue;
};
export type LifecycleFixtureMutationMessage = LifecycleFixturePayloadMessage<"mutation">;
export type LifecycleFixtureBoundedMessage = LifecycleFixturePayloadMessage<"bounded">;
export type LifecycleFixtureQueryMessage = LifecycleFixturePayloadMessage<"query">;
export type LifecycleFixtureValidationMessage = LifecycleFixturePayloadMessage<"validation">;
export type LifecycleFixtureFaultMessage = LifecycleFixturePayloadMessage<"fault">;
export interface LifecycleFixtureKeyRequestMessage {
  readonly type: "key-request";
  readonly requestId: string;
  readonly payload: LifecycleFixtureJsonValue;
}
export interface LifecycleFixtureKeyResponseMessage {
  readonly type: "key-response";
  readonly requestId: string;
  readonly payload: LifecycleFixtureJsonValue;
}
export interface LifecycleFixtureBarrierArmMessage {
  readonly type: "barrier-arm";
  readonly requestId: string;
  readonly payload: { readonly name: LifecycleFixtureBarrierTarget; readonly barrierId: string };
}
export interface LifecycleFixtureBarrierReleaseMessage {
  readonly type: "barrier-release";
  readonly requestId: string;
  readonly payload: { readonly barrierId: string };
}
export interface LifecycleFixtureBarrierReachedMessage {
  readonly type: "barrier-reached";
  /** The request ID of the held lifecycle command. */
  readonly requestId: string;
  readonly payload: { readonly name: LifecycleFixtureBarrierTarget; readonly barrierId: string };
}
export type LifecycleFixtureResultMessage = {
  readonly type: "result";
  readonly requestId: string;
  readonly operation: LifecycleFixtureResultRequest;
  readonly value: LifecycleFixtureJsonValue;
};
export type LifecycleFixtureErrorMessage = {
  readonly type: "error";
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
};
export interface LifecycleFixtureCloseMessage {
  readonly type: "close";
  readonly requestId: string;
}
export interface LifecycleFixtureCloseAcknowledgementMessage {
  readonly type: "close";
  readonly requestId: string;
  readonly childId: string;
}

export interface LifecycleFixtureHeldBarrier {
  readonly name: LifecycleFixtureBarrierTarget;
  readonly barrierId: string;
  reached(): Promise<LifecycleFixtureBarrierReachedMessage>;
  release(): Promise<void>;
}

export type LifecycleFixtureParentMessage =
  | LifecycleFixtureStartMessage
  | LifecycleFixtureBindingMessage
  | LifecycleFixtureOpenMessage
  | LifecycleFixtureMutationMessage
  | LifecycleFixtureBoundedMessage
  | LifecycleFixtureQueryMessage
  | LifecycleFixtureValidationMessage
  | LifecycleFixtureFaultMessage
  | LifecycleFixtureKeyResponseMessage
  | LifecycleFixtureBarrierArmMessage
  | LifecycleFixtureBarrierReleaseMessage
  | LifecycleFixtureCloseMessage;

export type LifecycleFixtureChildMessage =
  | LifecycleFixtureReadyMessage
  | LifecycleFixtureStartedMessage
  | LifecycleFixtureKeyRequestMessage
  | LifecycleFixtureBarrierReachedMessage
  | LifecycleFixtureResultMessage
  | LifecycleFixtureErrorMessage
  | LifecycleFixtureCloseAcknowledgementMessage;

export type LifecycleFixtureMessage = LifecycleFixtureParentMessage | LifecycleFixtureChildMessage;

export interface LifecycleFixtureExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type LifecycleFixtureKeyOperation =
  | "currentKey"
  | "status"
  | "mac"
  | "verify"
  | "fingerprint"
  | "seal"
  | "open";

/**
 * Sanitized parent-side record of a provider RPC.  It deliberately retains
 * only routing metadata and sizes; inputs, MACs, and sealed values are never
 * retained by the fixture client.
 */
export interface LifecycleFixtureKeyRequestAudit {
  readonly requestId: string;
  readonly operation: LifecycleFixtureKeyOperation;
  readonly projectId: string;
  readonly storeId: string;
  readonly purpose: CapabilityKeyPurpose;
  readonly keyId: string | null;
  readonly inputByteLength: number | null;
  readonly authenticationByteLength: number | null;
  readonly hasSealedValue: boolean;
}

export interface LifecycleFixtureTransportDescription {
  readonly serialization: "json";
  readonly shell: false;
  /** A process fixture is deliberately not a worker-thread transport. */
  readonly workerData: undefined;
}

/**
 * Parent-established routing scope for the parent-owned key broker.  A child
 * fixture can request keys for this scope but can never establish or replace
 * it through an IPC payload.
 */
export interface LifecycleFixtureKeyScope {
  readonly projectId: string;
  readonly storeId: string;
}

export interface LifecycleFixtureClientOptions {
  readonly fixturePath: string | URL;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Diagnostic watchdog for a stuck barrier; never drives fixture correctness. */
  readonly timeoutMs?: number;
  /** Diagnostic watchdog used only while cleaning up a stuck process. */
  readonly cleanupTimeoutMs?: number;
  /** Parent-only broker; raw key material never enters the forked fixture. */
  readonly keyBroker?: LifecycleTestKeyBroker;
  /**
   * Parent-established scope for a synthetic fixture.  Real project starts
   * derive this independently from their trusted roots before opening.
   */
  readonly keyScope?: LifecycleFixtureKeyScope;
  /**
   * Test-owned byte patterns to scan for in stderr without retaining stderr
   * content. Every query must name a pattern registered here.
   */
  readonly stderrCanaries?: readonly string[];
}

interface Waiter<T extends LifecycleFixtureChildMessage = LifecycleFixtureChildMessage> {
  readonly predicate: (message: LifecycleFixtureChildMessage) => message is T;
  readonly label: string;
  readonly pendingRequestId: string | undefined;
  readonly resolve: (message: T) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface StderrCanaryProbe {
  readonly canary: string;
  readonly bytes: Buffer;
  readonly prefix: readonly number[];
}

interface StderrCanaryWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

type LifecycleFixtureCorrelatedChildMessage = Exclude<
  LifecycleFixtureChildMessage,
  LifecycleFixtureReadyMessage | LifecycleFixtureKeyRequestMessage
>;

type LifecycleFixturePendingRequestType = Exclude<
  LifecycleFixtureParentMessage["type"],
  "key-response"
>;

interface LifecycleFixturePendingRequest {
  readonly type: LifecycleFixturePendingRequestType;
}

function isCorrelatedChildMessage(
  message: LifecycleFixtureChildMessage,
): message is LifecycleFixtureCorrelatedChildMessage {
  return message.type !== "ready" && message.type !== "key-request";
}

function isPendingResultRequest(
  type: LifecycleFixturePendingRequestType,
): type is LifecycleFixtureResultRequest {
  return type !== "start" && type !== "close";
}

function isPendingBarrierTarget(
  type: LifecycleFixturePendingRequestType,
): type is LifecycleFixtureBarrierTarget {
  return type === "mutation" || type === "bounded" || type === "query"
    || type === "validation" || type === "fault";
}

function responseContractFailure(
  message: LifecycleFixtureCorrelatedChildMessage,
  pending: LifecycleFixturePendingRequest,
): string | undefined {
  if (message.type === "error") return undefined;
  if (message.type === "started") {
    return pending.type === "start" ? undefined : "an unexpected started response";
  }
  if (message.type === "close") {
    return pending.type === "close" ? undefined : "an unexpected close response";
  }
  if (message.type === "barrier-reached") {
    if (!isPendingBarrierTarget(pending.type)) return "an unexpected barrier-reached response";
    return message.payload.name === pending.type
      ? undefined
      : `an unexpected barrier target: expected ${pending.type}, received ${message.payload.name}`;
  }
  if (!isPendingResultRequest(pending.type)) return "an unexpected result response";
  return message.operation === pending.type
    ? undefined
    : `an unexpected result operation: expected ${pending.type}, received ${message.operation}`;
}

function completesIssuedRequest(message: LifecycleFixtureCorrelatedChildMessage): boolean {
  return message.type !== "barrier-reached";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const PROJECT_STORE_WORKER_URL = new URL("../../src/workers/project-store.worker.js", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isProjectStartPayload(value: LifecycleFixtureJsonValue | undefined): value is Record<string, LifecycleFixtureJsonValue> {
  return isRecord(value)
    && typeof value.projectRoot === "string" && value.projectRoot.length > 0
    && typeof value.vaultRoot === "string" && value.vaultRoot.length > 0
    && typeof value.clientInstanceId === "string" && value.clientInstanceId.length > 0;
}

function normalizeKeyScope(scope: LifecycleFixtureKeyScope | undefined): LifecycleFixtureKeyScope | undefined {
  if (scope === undefined) return undefined;
  const projectId = typeof scope.projectId === "string" ? scope.projectId.trim() : "";
  const storeId = typeof scope.storeId === "string" ? scope.storeId.trim() : "";
  if (!projectId || !storeId) throw new TypeError("fixture key scope requires non-empty projectId and storeId");
  return Object.freeze({ projectId, storeId });
}

function kmpPrefix(bytes: Uint8Array): readonly number[] {
  const prefix = new Array<number>(bytes.length).fill(0);
  let matched = 0;
  for (let index = 1; index < bytes.length; index += 1) {
    while (matched > 0 && bytes[index] !== bytes[matched]) matched = prefix[matched - 1]!;
    if (bytes[index] === bytes[matched]) matched += 1;
    prefix[index] = matched;
  }
  return Object.freeze(prefix);
}

function normalizeStderrCanaries(value: readonly string[] | undefined): readonly StderrCanaryProbe[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError("stderrCanaries must be an array of strings");
  const seen = new Set<string>();
  const probes = value.map((canary) => {
    if (typeof canary !== "string" || canary.length === 0 || canary.length > 1_024 || seen.has(canary)) {
      throw new TypeError("stderrCanaries must contain distinct bounded non-empty strings");
    }
    seen.add(canary);
    const bytes = Buffer.from(canary, "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > 4_096) {
      bytes.fill(0);
      throw new TypeError("stderr canary byte length is invalid");
    }
    return Object.freeze({ canary, bytes, prefix: kmpPrefix(bytes) });
  });
  return Object.freeze(probes);
}

function advanceStderrCanary(
  probe: StderrCanaryProbe,
  matchedBefore: number,
  chunk: Uint8Array,
): number {
  let matched = matchedBefore;
  for (const byte of chunk) {
    while (matched > 0 && byte !== probe.bytes[matched]) matched = probe.prefix[matched - 1]!;
    if (byte === probe.bytes[matched]) matched += 1;
    if (matched === probe.bytes.length) return matched;
  }
  return matched;
}

async function establishParentKeyScope(
  payload: Record<string, LifecycleFixtureJsonValue>,
): Promise<LifecycleFixtureKeyScope> {
  const projectRoot = payload.projectRoot;
  const vaultRoot = payload.vaultRoot;
  const clientInstanceId = payload.clientInstanceId;
  if (
    typeof projectRoot !== "string"
    || typeof vaultRoot !== "string"
    || typeof clientInstanceId !== "string"
  ) {
    throw new TypeError("fixture project start payload is missing trusted binding roots");
  }
  const service = new ProjectBindingService({
    identityProbe: new WorkerProjectStoreIdentityProbe({ workerUrl: PROJECT_STORE_WORKER_URL }),
  });
  const resolution = await service.establish({
    source: "explicit-cli",
    projectRoot,
    vaultRoot,
    clientNamespace: "task18-fixture-parent-key-broker",
    clientInstanceId,
    actorRole: "primary",
    generation: 1,
  });
  if (!resolution.ok) {
    throw new Error(`fixture parent key scope binding failed: ${resolution.code}`);
  }
  return Object.freeze({
    projectId: resolution.binding.projectId,
    storeId: resolution.binding.storeId,
  });
}

function jsonFailure(path: string): Error {
  return new TypeError(`lifecycle fixture payload must be JSON at ${path}`);
}

function assertJsonValue(value: unknown, path: string, active: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw jsonFailure(path);
  }
  if (typeof value !== "object") throw jsonFailure(path);
  if (active.has(value)) throw jsonFailure(`${path} (cycle)`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, active));
      return;
    }
    if (!isRecord(value)) throw jsonFailure(path);
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

export function assertLifecycleFixtureJson(value: unknown): asserts value is LifecycleFixtureJsonValue {
  assertJsonValue(value, "$", new Set<object>());
}

function isBarrierName(value: unknown): value is LifecycleFixtureBarrierName {
  return typeof value === "string"
    && (LIFECYCLE_FIXTURE_BARRIER_NAMES as readonly string[]).includes(value);
}

function isBarrierTarget(value: unknown): value is LifecycleFixtureBarrierTarget {
  return value === "mutation" || value === "bounded" || value === "query"
    || value === "validation" || value === "fault";
}

function isRequestBarrier(value: unknown): value is LifecycleFixtureRequestBarrier {
  return value === "start" || value === "binding" || value === "open" || isBarrierTarget(value)
    || value === "barrier-arm" || value === "barrier-release";
}

function isResultRequest(value: unknown): value is LifecycleFixtureResultRequest {
  return value === "binding" || value === "open" || isBarrierTarget(value)
    || value === "barrier-arm" || value === "barrier-release";
}

function protocolRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    assertLifecycleFixtureJson(value);
  } catch {
    return undefined;
  }
  return isRecord(value) ? value : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPayloadCommand(value: Record<string, unknown>, type: LifecycleFixtureRequestBarrier): boolean {
  return value.type === type
    && hasExactKeys(value, ["type", "requestId"], ["payload"])
    && isNonemptyString(value.requestId);
}

function isBarrierArmPayload(value: unknown): value is LifecycleFixtureBarrierArmMessage["payload"] {
  return isRecord(value)
    && hasExactKeys(value, ["name", "barrierId"])
    && isBarrierTarget(value.name)
    && isNonemptyString(value.barrierId);
}

function isBarrierReleasePayload(value: unknown): value is LifecycleFixtureBarrierReleaseMessage["payload"] {
  return isRecord(value)
    && hasExactKeys(value, ["barrierId"])
    && isNonemptyString(value.barrierId);
}

export function isLifecycleFixtureParentMessage(value: unknown): value is LifecycleFixtureParentMessage {
  const observed = protocolRecord(value);
  if (observed === undefined || !isBarrierName(observed.type)) return false;
  if (isRequestBarrier(observed.type)) {
    if (observed.type === "barrier-arm") {
      return hasExactKeys(observed, ["type", "requestId", "payload"])
        && isNonemptyString(observed.requestId)
        && isBarrierArmPayload(observed.payload);
    }
    if (observed.type === "barrier-release") {
      return hasExactKeys(observed, ["type", "requestId", "payload"])
        && isNonemptyString(observed.requestId)
        && isBarrierReleasePayload(observed.payload);
    }
    return isPayloadCommand(observed, observed.type);
  }
  if (observed.type === "key-response") {
    return hasExactKeys(observed, ["type", "requestId", "payload"])
      && isNonemptyString(observed.requestId);
  }
  return observed.type === "close"
    && hasExactKeys(observed, ["type", "requestId"])
    && isNonemptyString(observed.requestId);
}

export function isLifecycleFixtureChildMessage(value: unknown): value is LifecycleFixtureChildMessage {
  const observed = protocolRecord(value);
  if (observed === undefined || !isBarrierName(observed.type)) return false;
  switch (observed.type) {
    case "ready":
      return hasExactKeys(observed, ["type", "childId", "pid"], ["payload"])
        && isNonemptyString(observed.childId)
        && Number.isSafeInteger(observed.pid)
        && Number(observed.pid) > 0;
    case "started":
      return hasExactKeys(observed, ["type", "requestId", "childId"], ["payload"])
        && isNonemptyString(observed.requestId)
        && isNonemptyString(observed.childId);
    case "result":
      return hasExactKeys(observed, ["type", "requestId", "operation", "value"])
        && isNonemptyString(observed.requestId)
        && isResultRequest(observed.operation);
    case "error":
      return hasExactKeys(observed, ["type", "requestId", "code", "message"])
        && isNonemptyString(observed.requestId)
        && isNonemptyString(observed.code)
        && isNonemptyString(observed.message);
    case "key-request":
      return hasExactKeys(observed, ["type", "requestId", "payload"])
        && isNonemptyString(observed.requestId);
    case "barrier-reached":
      return hasExactKeys(observed, ["type", "requestId", "payload"])
        && isNonemptyString(observed.requestId)
        && isBarrierArmPayload(observed.payload);
    case "close":
      return hasExactKeys(observed, ["type", "requestId", "childId"])
        && isNonemptyString(observed.requestId)
        && isNonemptyString(observed.childId);
    default:
      return false;
  }
}

export function assertLifecycleFixtureParentMessage(value: unknown): asserts value is LifecycleFixtureParentMessage {
  if (!isLifecycleFixtureParentMessage(value)) {
    throw new TypeError("fixture IPC requires a strict parent fixture message");
  }
}

export function assertLifecycleFixtureChildMessage(value: unknown): asserts value is LifecycleFixtureChildMessage {
  if (!isLifecycleFixtureChildMessage(value)) {
    throw new TypeError("fixture IPC requires a strict child fixture message");
  }
}

function requestMessage(
  type: LifecycleFixtureRequestBarrier,
  requestId: string,
  payload: LifecycleFixtureJsonValue | undefined,
): LifecycleFixtureParentMessage {
  return {
    type,
    requestId,
    ...(payload === undefined ? {} : { payload }),
  } as LifecycleFixtureParentMessage;
}

function keyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("fixture key request must be an object");
  return value;
}

function keyString(value: Record<string, unknown>, key: string): string {
  const observed = value[key];
  if (
    typeof observed !== "string"
    || observed.length === 0
    || observed.length > MAX_FIXTURE_KEY_TEXT_CHARS
    || observed.includes("\0")
  ) {
    throw new TypeError(`fixture key request ${key} is invalid`);
  }
  return observed;
}

function keyBytes(value: Record<string, unknown>, key: string): Buffer {
  const encoded = keyString(value, key);
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded)) throw new TypeError("fixture key bytes are invalid");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength > MAX_FIXTURE_KEY_INPUT_BYTES || bytes.toString("base64url") !== encoded) {
    bytes.fill(0);
    throw new RangeError("fixture key bytes are invalid");
  }
  return bytes;
}

function keyErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/u.test((error as { readonly code: string }).code)) {
    return (error as { readonly code: string }).code;
  }
  return "FIXTURE_KEY_BROKER_ERROR";
}

const MAX_FIXTURE_KEY_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_FIXTURE_KEY_TEXT_CHARS = 16 * 1024;
const FIXTURE_KEY_OPERATIONS = [
  "currentKey", "status", "mac", "verify", "fingerprint", "seal", "open",
] as const satisfies readonly LifecycleFixtureKeyOperation[];
const FIXTURE_KEY_PURPOSES = new Set<CapabilityKeyPurpose>([
  "root-session-handle",
  "root-resume-token",
  "child-session-handle",
  "child-binding-grant",
  "continuity-index",
  "evidence-fingerprint",
  "validation-output-fingerprint",
  "materialization-fingerprint",
  "recovery-approval",
  "abandonment-approval",
  "pending-authorization-encryption",
]);

interface ParsedFixtureKeyRequest {
  readonly operation: LifecycleFixtureKeyOperation;
  readonly scope: { readonly projectId: string; readonly storeId: string };
  readonly purpose: CapabilityKeyPurpose;
  readonly keyId: string | null;
  readonly domain: string | null;
  readonly input: Buffer | null;
  readonly authentication: Buffer | null;
  readonly sealed: SealedValueV1 | null;
}

function exactKeyFields(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new TypeError("fixture key request has unexpected fields");
  }
}

function keyOperation(value: unknown): LifecycleFixtureKeyOperation {
  if (typeof value !== "string" || !(FIXTURE_KEY_OPERATIONS as readonly string[]).includes(value)) {
    throw new TypeError("fixture key operation is invalid");
  }
  return value as LifecycleFixtureKeyOperation;
}

function keyPurpose(value: Record<string, unknown>): CapabilityKeyPurpose {
  const purpose = keyString(value, "purpose");
  if (!FIXTURE_KEY_PURPOSES.has(purpose as CapabilityKeyPurpose)) {
    throw new TypeError("fixture key request purpose is invalid");
  }
  return purpose as CapabilityKeyPurpose;
}

function keySealed(value: unknown, expectedKeyId: string): SealedValueV1 {
  const sealed = keyRecord(value);
  exactKeyFields(sealed, ["version", "keyId", "algorithm", "nonce", "ciphertext", "tag"]);
  if (sealed.version !== 1 || keyString(sealed, "keyId") !== expectedKeyId
    || keyString(sealed, "algorithm") !== "aes-256-gcm") {
    throw new TypeError("fixture sealed value is invalid");
  }
  return Object.freeze({
    version: 1,
    keyId: expectedKeyId,
    algorithm: "aes-256-gcm",
    nonce: keyString(sealed, "nonce"),
    ciphertext: keyString(sealed, "ciphertext"),
    tag: keyString(sealed, "tag"),
  });
}

function parseFixtureKeyRequest(value: LifecycleFixtureJsonValue | undefined): ParsedFixtureKeyRequest {
  const request = keyRecord(value);
  const operation = keyOperation(request.operation);
  const expected = operation === "currentKey"
    ? ["operation", "projectId", "storeId", "purpose"]
    : operation === "status"
      ? ["operation", "projectId", "storeId", "purpose", "keyId"]
      : operation === "verify"
        ? ["operation", "projectId", "storeId", "purpose", "keyId", "domain", "bytes", "mac"]
        : operation === "open"
          ? ["operation", "projectId", "storeId", "purpose", "keyId", "domain", "sealed"]
          : ["operation", "projectId", "storeId", "purpose", "keyId", "domain", "bytes"];
  exactKeyFields(request, expected);
  const scope = Object.freeze({ projectId: keyString(request, "projectId"), storeId: keyString(request, "storeId") });
  const purpose = keyPurpose(request);
  const keyId = operation === "currentKey" ? null : keyString(request, "keyId");
  const domain = operation === "currentKey" || operation === "status" ? null : keyString(request, "domain");
  let input: Buffer | null = null;
  let authentication: Buffer | null = null;
  try {
    if (operation === "mac" || operation === "verify" || operation === "fingerprint" || operation === "seal") {
      input = keyBytes(request, "bytes");
    }
    if (operation === "verify") authentication = keyBytes(request, "mac");
    const sealed = operation === "open" ? keySealed(request.sealed, keyId!) : null;
    return Object.freeze({ operation, scope, purpose, keyId, domain, input, authentication, sealed });
  } catch (error) {
    input?.fill(0);
    authentication?.fill(0);
    throw error;
  }
}

function keyRequestAudit(
  requestId: string,
  request: ParsedFixtureKeyRequest,
): LifecycleFixtureKeyRequestAudit {
  return Object.freeze({
    requestId,
    operation: request.operation,
    projectId: request.scope.projectId,
    storeId: request.scope.storeId,
    purpose: request.purpose,
    keyId: request.keyId,
    inputByteLength: request.input?.byteLength ?? null,
    authenticationByteLength: request.authentication?.byteLength ?? null,
    hasSealedValue: request.sealed !== null,
  });
}

function fixtureKeyError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function zeroizeParsedKeyRequest(request: ParsedFixtureKeyRequest): void {
  request.input?.fill(0);
  request.authentication?.fill(0);
}

function brokerResponse(
  broker: LifecycleTestKeyBroker,
  value: LifecycleFixtureJsonValue | undefined,
  requestId: string,
  expectedScope: { readonly projectId: string; readonly storeId: string } | undefined,
): { readonly payload: LifecycleFixtureJsonValue; readonly audit: LifecycleFixtureKeyRequestAudit } {
  const request = parseFixtureKeyRequest(value);
  if (expectedScope === undefined) {
    zeroizeParsedKeyRequest(request);
    throw fixtureKeyError("FIXTURE_KEY_SCOPE_UNBOUND");
  }
  if (
    request.scope.projectId !== expectedScope.projectId
    || request.scope.storeId !== expectedScope.storeId
  ) {
    zeroizeParsedKeyRequest(request);
    throw fixtureKeyError("FIXTURE_KEY_SCOPE_MISMATCH");
  }
  const audit = keyRequestAudit(requestId, request);
  try {
    switch (request.operation) {
      case "currentKey":
        return { payload: { ok: true, result: { keyId: broker.currentKey(request.scope, request.purpose).keyId } }, audit };
      case "status":
        return { payload: { ok: true, result: { status: broker.status(request.scope, request.purpose, request.keyId!) } }, audit };
      case "mac": {
        const output = broker.mac({
          ...request.scope, purpose: request.purpose, keyId: request.keyId!, domain: request.domain!, bytes: request.input!,
        } as never);
        try {
          return {
            payload: { ok: true, result: { bytes: Buffer.from(output).toString("base64url") } },
            audit,
          };
        } finally { output.fill(0); }
      }
      case "verify": {
        return {
          payload: { ok: true, result: { valid: broker.verify({
            ...request.scope, purpose: request.purpose, keyId: request.keyId!, domain: request.domain!,
            bytes: request.input!, mac: request.authentication!,
          } as never) } },
          audit,
        };
      }
      case "fingerprint": {
        return {
          payload: { ok: true, result: { value: broker.fingerprint({
            ...request.scope, purpose: request.purpose, keyId: request.keyId!, domain: request.domain!, bytes: request.input!,
          } as never) } },
          audit,
        };
      }
      case "seal": {
        const sealed = broker.seal({
          ...request.scope, purpose: request.purpose, keyId: request.keyId!, domain: request.domain!, bytes: request.input!,
        } as never);
        return {
          payload: { ok: true, result: { sealed: {
            version: sealed.version,
            keyId: sealed.keyId,
            algorithm: sealed.algorithm,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            tag: sealed.tag,
          } } },
          audit,
        };
      }
      case "open": {
        const opened = broker.open({
          ...request.scope, purpose: request.purpose, keyId: request.keyId!, domain: request.domain!, sealed: request.sealed!,
        } as never);
        try { return { payload: { ok: true, result: { bytes: Buffer.from(opened).toString("base64url") } }, audit }; }
        finally { opened.fill(0); }
      }
      default:
        throw new TypeError("fixture key operation is invalid");
    }
  } catch (error) {
    return { payload: { ok: false, code: keyErrorCode(error) }, audit };
  } finally {
    zeroizeParsedKeyRequest(request);
  }
}

function toFixturePath(path: string | URL): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LifecycleFixtureClient {
  readonly child: ChildProcess;
  readonly transport: LifecycleFixtureTransportDescription = Object.freeze({
    serialization: "json",
    shell: false,
    workerData: undefined,
  });
  readonly stderr: string[] = [];
  readonly #timeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #messages: LifecycleFixtureChildMessage[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #exitPromise: Promise<LifecycleFixtureExit>;
  readonly #disconnectPromise: Promise<void>;
  #resolveExit!: (exit: LifecycleFixtureExit) => void;
  #resolveDisconnect!: () => void;
  #exit: LifecycleFixtureExit | undefined;
  #disconnect = false;
  #readyMessage: LifecycleFixtureReadyMessage | undefined;
  #readyPromise: Promise<LifecycleFixtureReadyMessage> | undefined;
  #closePromise: Promise<LifecycleFixtureCloseAcknowledgementMessage> | undefined;
  #disposed = false;
  readonly #keyBroker: LifecycleTestKeyBroker | undefined;
  readonly #handledKeyRequestIds = new Set<string>();
  readonly #pendingRequests = new Map<string, LifecycleFixturePendingRequest>();
  readonly #retiredRequestIds = new Set<string>();
  readonly #keyRequestAudit: LifecycleFixtureKeyRequestAudit[] = [];
  readonly #stderrCanaryProbes: readonly StderrCanaryProbe[];
  readonly #stderrCanaryProgress = new Map<string, number>();
  readonly #stderrCanaryHits = new Set<string>();
  readonly #stderrCanaryWaiters = new Map<string, StderrCanaryWaiter[]>();
  #keyScope: LifecycleFixtureKeyScope | undefined;

  constructor(options: LifecycleFixtureClientOptions) {
    this.#timeoutMs = positiveTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#cleanupTimeoutMs = positiveTimeout(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "cleanupTimeoutMs",
    );
    this.#keyBroker = options.keyBroker;
    this.#keyScope = normalizeKeyScope(options.keyScope);
    this.#stderrCanaryProbes = normalizeStderrCanaries(options.stderrCanaries);
    for (const probe of this.#stderrCanaryProbes) this.#stderrCanaryProgress.set(probe.canary, 0);
    const args = [...(options.args ?? [])];
    args.forEach((argument) => {
      if (typeof argument !== "string") throw new TypeError("fixture args must be strings");
    });
    if (this.#keyBroker !== undefined && (args.length !== 0 || options.env !== undefined)) {
      throw new TypeError("broker-backed fixture forbids argv and environment injection");
    }
    const inheritedSafeEnvironment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "NODE_PATH"] as const) {
      const value = process.env[key];
      if (value !== undefined) inheritedSafeEnvironment[key] = value;
    }
    const forkOptions = {
      cwd: options.cwd,
      env: options.env === undefined ? inheritedSafeEnvironment : { ...options.env },
      serialization: "json",
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    } as ForkOptions;
    this.child = fork(toFixturePath(options.fixturePath), args, forkOptions);
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#observeStderr(chunk);
    });
    this.#exitPromise = new Promise<LifecycleFixtureExit>((resolve) => { this.#resolveExit = resolve; });
    this.#disconnectPromise = new Promise<void>((resolve) => { this.#resolveDisconnect = resolve; });
    this.child.on("message", (message: unknown) => {
      if (!isLifecycleFixtureChildMessage(message)) {
        this.#failPendingRequests(this.#failure("fixture sent an invalid child fixture message"));
      } else if (message.type === "key-request") {
        this.#handleKeyRequest(message);
      } else {
        const pending = isCorrelatedChildMessage(message)
          ? this.#pendingRequests.get(message.requestId)
          : undefined;
        if (isCorrelatedChildMessage(message) && pending === undefined) {
          this.#failPendingRequests(this.#failure("fixture sent an uncorrelated child fixture message"));
          return;
        }
        if (isCorrelatedChildMessage(message) && pending !== undefined) {
          const failure = responseContractFailure(message, pending);
          if (failure !== undefined) {
            this.#failPendingRequests(this.#failure(`fixture sent ${failure}`));
            return;
          }
          if (completesIssuedRequest(message)) this.#pendingRequests.delete(message.requestId);
        }
        this.#push(message);
      }
    });
    this.child.on("disconnect", () => {
      this.#disconnect = true;
      this.#resolveDisconnect();
    });
    this.child.on("error", (error: Error) => {
      this.#failPendingRequests(this.#failure(`fixture process error: ${errorText(error)}`));
    });
    this.child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      this.#resolveExit(this.#exit);
      this.#failPendingRequests(this.#failure(`fixture exited before barrier: ${code ?? signal ?? "unknown"}`));
    });
  }

  get exit(): LifecycleFixtureExit | undefined {
    return this.#exit;
  }

  get disconnected(): boolean {
    return this.#disconnect;
  }

  get keyRequestAudit(): readonly LifecycleFixtureKeyRequestAudit[] {
    return this.#keyRequestAudit;
  }

  stderrCanaryDetected(canary: string): boolean {
    this.#assertRegisteredStderrCanary(canary);
    return this.#stderrCanaryHits.has(canary);
  }

  waitForStderrCanary(canary: string): Promise<void> {
    this.#assertRegisteredStderrCanary(canary);
    if (this.#stderrCanaryHits.has(canary)) return Promise.resolve();
    if (this.#exit !== undefined) return Promise.reject(this.#failure(`exited before stderr canary ${canary}`));
    return new Promise<void>((resolve, reject) => {
      const waiter: StderrCanaryWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = this.#stderrCanaryWaiters.get(canary);
          if (waiters !== undefined) {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            if (waiters.length === 0) this.#stderrCanaryWaiters.delete(canary);
          }
          reject(this.#failure(`stderr canary ${canary} timed out`));
        }, this.#timeoutMs),
      };
      const waiters = this.#stderrCanaryWaiters.get(canary) ?? [];
      waiters.push(waiter);
      this.#stderrCanaryWaiters.set(canary, waiters);
    });
  }

  async ready(): Promise<LifecycleFixtureReadyMessage> {
    if (this.#readyMessage !== undefined) return this.#readyMessage;
    this.#readyPromise ??= this.waitFor("ready", "ready").then((ready) => {
      this.#readyMessage = ready;
      return ready;
    });
    return this.#readyPromise;
  }

  waitFor<K extends LifecycleFixtureChildMessage["type"]>(
    barrier: K,
    label?: string,
    pendingRequestId?: string,
  ): Promise<Extract<LifecycleFixtureChildMessage, { readonly type: K }>>;
  waitFor<T extends LifecycleFixtureChildMessage>(
    predicate: (message: LifecycleFixtureChildMessage) => message is T,
    label?: string,
    pendingRequestId?: string,
  ): Promise<T>;
  waitFor(
    barrierOrPredicate: LifecycleFixtureChildMessage["type"]
      | ((message: LifecycleFixtureChildMessage) => boolean),
    label = typeof barrierOrPredicate === "string" ? barrierOrPredicate : "fixture barrier",
    pendingRequestId?: string,
  ): Promise<LifecycleFixtureChildMessage> {
    const predicate: (message: LifecycleFixtureChildMessage) => message is LifecycleFixtureChildMessage =
      typeof barrierOrPredicate === "string"
        ? (message): message is LifecycleFixtureChildMessage => message.type === barrierOrPredicate
        : (message): message is LifecycleFixtureChildMessage => barrierOrPredicate(message);
    const queuedIndex = this.#messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.#messages.splice(queuedIndex, 1)[0]!);
    if (this.#exit !== undefined) return Promise.reject(this.#failure(`exited before ${label}`));
    return new Promise<LifecycleFixtureChildMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        label,
        pendingRequestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          const failure = this.#failure(`${label} barrier timed out`);
          if (waiter.pendingRequestId === undefined) {
            this.#failPendingRequests(failure);
          } else {
            this.#retirePendingRequest(waiter.pendingRequestId);
          }
          reject(failure);
        }, this.#timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  send(message: LifecycleFixtureParentMessage): void {
    assertLifecycleFixtureParentMessage(message);
    assertLifecycleFixtureJson(message);
    if (this.#disposed || !this.child.connected) {
      throw this.#failure("fixture IPC is not connected");
    }
    const expectsResponse = message.type !== "key-response";
    if (expectsResponse) {
      if (this.#retiredRequestIds.has(message.requestId)) {
        throw this.#failure(`fixture request ID is retired: ${message.requestId}`);
      }
      if (this.#pendingRequests.has(message.requestId)) {
        throw this.#failure(`fixture request ID is already in flight: ${message.requestId}`);
      }
      this.#pendingRequests.set(message.requestId, { type: message.type });
    }
    try {
      this.child.send(message);
    } catch (error) {
      if (expectsResponse) this.#retirePendingRequest(message.requestId);
      throw error;
    }
  }

  sendBarrier(
    type: LifecycleFixtureRequestBarrier,
    payload?: LifecycleFixtureJsonValue,
    requestId = randomUUID(),
  ): string {
    const message = requestMessage(type, requestId, payload);
    this.send(message);
    return requestId;
  }

  async request(
    type: LifecycleFixtureResultRequest,
    payload?: LifecycleFixtureJsonValue,
  ): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    const requestId = this.sendBarrier(type, payload);
    return this.waitFor(
      (message): message is LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage =>
        (message.type === "error" && message.requestId === requestId)
        || (message.type === "result" && message.requestId === requestId && message.operation === type),
      `${type}:${requestId}`,
      requestId,
    );
  }

  async start(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureStartedMessage | LifecycleFixtureErrorMessage> {
    await this.ready();
    if (isProjectStartPayload(payload)) {
      const binding = await this.binding(payload);
      if (binding.type === "error") return binding;
      if (this.#keyBroker !== undefined && this.#keyScope === undefined) {
        this.#keyScope = await establishParentKeyScope(payload);
      }
      const opened = await this.open();
      if (opened.type === "error") return opened;
      return this.#start();
    }
    return this.#start(payload);
  }

  #start(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureStartedMessage | LifecycleFixtureErrorMessage> {
    const requestId = this.sendBarrier("start", payload);
    return this.waitFor(
      (message): message is LifecycleFixtureStartedMessage | LifecycleFixtureErrorMessage =>
        (message.type === "started" && message.requestId === requestId)
        || (message.type === "error" && message.requestId === requestId),
      `start:${requestId}`,
      requestId,
    );
  }

  binding(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("binding", payload);
  }

  open(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("open", payload);
  }

  mutation(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("mutation", payload);
  }

  bounded(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("bounded", payload);
  }

  query(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("query", payload);
  }

  validation(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("validation", payload);
  }

  fault(payload?: LifecycleFixtureJsonValue): Promise<LifecycleFixtureResultMessage | LifecycleFixtureErrorMessage> {
    return this.request("fault", payload);
  }

  async holdBarrier(name: LifecycleFixtureBarrierTarget): Promise<LifecycleFixtureHeldBarrier> {
    const barrierId = randomUUID();
    const armed = await this.request("barrier-arm", { name, barrierId });
    if (armed.type === "error") throw this.#failure(`barrier arm failed: ${armed.code}`);
    if (
      !isRecord(armed.value)
      || armed.value.armed !== true
      || armed.value.name !== name
      || armed.value.barrierId !== barrierId
    ) {
      throw this.#failure("fixture returned an invalid barrier arm acknowledgement");
    }
    let reached: Promise<LifecycleFixtureBarrierReachedMessage> | undefined;
    let released: Promise<void> | undefined;
    return Object.freeze({
      name,
      barrierId,
      reached: () => {
        reached ??= this.waitFor(
          (message): message is LifecycleFixtureBarrierReachedMessage =>
            message.type === "barrier-reached"
            && message.payload.name === name
            && message.payload.barrierId === barrierId,
          `barrier:${name}:${barrierId}`,
        );
        return reached;
      },
      release: () => {
        released ??= this.#releaseBarrier(barrierId);
        return released;
      },
    });
  }

  async close(): Promise<LifecycleFixtureCloseAcknowledgementMessage> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#cooperativeClose();
    return this.#closePromise;
  }

  async dispose(): Promise<void> {
    if (this.#disposed && this.#exit !== undefined) return;
    try {
      if (this.#exit === undefined) await this.close();
    } catch (error) {
      await this.forceCleanup();
      throw error;
    } finally {
      this.#disposed = true;
    }
  }

  async forceCleanup(): Promise<LifecycleFixtureExit | undefined> {
    this.#disposed = true;
    if (this.#exit !== undefined) return this.#exit;
    const failures: unknown[] = [];
    const waitForExit = async (label: string): Promise<LifecycleFixtureExit | undefined> => {
      try {
        return await this.#waitBounded(this.#exitPromise, label);
      } catch (error) {
        failures.push(error);
        return this.#exit;
      }
    };
    const waitForDisconnect = async (): Promise<void> => {
      try {
        await this.#waitBounded(this.#disconnectPromise, "fixture disconnect cleanup");
      } catch (error) {
        failures.push(error);
      }
    };
    if (this.child.connected) {
      try {
        this.child.disconnect();
      } catch (error) {
        failures.push(error);
      }
      await waitForDisconnect();
    }
    const afterDisconnect = await waitForExit("fixture disconnect exit cleanup");
    if (afterDisconnect !== undefined) return afterDisconnect;
    try {
      this.child.kill();
    } catch (error) {
      failures.push(error);
    }
    const afterKill = await waitForExit("fixture kill cleanup");
    if (afterKill !== undefined) return afterKill;
    try {
      this.child.kill("SIGKILL");
    } catch (error) {
      failures.push(error);
    }
    const afterForcedKill = await waitForExit("fixture forced kill cleanup");
    if (afterForcedKill !== undefined) return afterForcedKill;
    throw new AggregateError(failures, "fixture forced cleanup could not confirm termination");
  }

  async #cooperativeClose(): Promise<LifecycleFixtureCloseAcknowledgementMessage> {
    if (this.#exit !== undefined) {
      throw this.#failure("fixture exited before cooperative close");
    }
    const requestId = randomUUID();
    this.send({ type: "close", requestId });
    try {
      const closed = await this.waitFor(
        (message): message is LifecycleFixtureCloseAcknowledgementMessage | LifecycleFixtureErrorMessage =>
          (message.type === "close" || message.type === "error")
          && message.requestId === requestId,
        "close",
        requestId,
      );
      if (closed.type === "error") {
        throw this.#failure(`fixture close failed: ${closed.code}`);
      }
      if (this.child.connected) this.child.disconnect();
      await this.#waitBounded(this.#disconnectPromise, "fixture disconnect");
      const exit = await this.#waitBounded(this.#exitPromise, "fixture exit");
      if (exit.code !== 0 || exit.signal !== null) {
        throw this.#failure(`fixture closed with ${exit.code ?? exit.signal ?? "unknown"}`);
      }
      return closed;
    } catch (error) {
      try {
        await this.forceCleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "fixture cooperative close and cleanup failed");
      }
      throw error;
    }
  }

  async #releaseBarrier(barrierId: string): Promise<void> {
    const released = await this.request("barrier-release", { barrierId });
    if (released.type === "error") throw this.#failure(`barrier release failed: ${released.code}`);
    if (
      !isRecord(released.value)
      || released.value.released !== true
      || released.value.barrierId !== barrierId
    ) {
      throw this.#failure("fixture returned an invalid barrier release acknowledgement");
    }
  }

  async #waitBounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(this.#failure(`${label} timed out`)), this.#cleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #push(message: LifecycleFixtureChildMessage): void {
    const waiterIndex = this.#waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex < 0) {
      this.#messages.push(message);
      return;
    }
    const waiter = this.#waiters.splice(waiterIndex, 1)[0]!;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #observeStderr(chunk: Buffer | string): void {
    const byteLength = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    if (this.stderr.length < 32) this.stderr.push(`[stderr:${byteLength}]`);
    const owned = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : null;
    const bytes: Uint8Array = owned ?? (chunk as Buffer);
    try {
      for (const probe of this.#stderrCanaryProbes) {
        if (this.#stderrCanaryHits.has(probe.canary)) continue;
        const matched = advanceStderrCanary(
          probe,
          this.#stderrCanaryProgress.get(probe.canary) ?? 0,
          bytes,
        );
        this.#stderrCanaryProgress.set(probe.canary, matched);
        if (matched !== probe.bytes.length) continue;
        this.#stderrCanaryHits.add(probe.canary);
        for (const waiter of this.#stderrCanaryWaiters.get(probe.canary) ?? []) {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.#stderrCanaryWaiters.delete(probe.canary);
      }
    } finally {
      owned?.fill(0);
    }
  }

  #assertRegisteredStderrCanary(canary: string): void {
    if (typeof canary !== "string" || !this.#stderrCanaryProgress.has(canary)) {
      throw new TypeError("stderr canary was not registered for this fixture client");
    }
  }

  #handleKeyRequest(message: LifecycleFixtureKeyRequestMessage): void {
    const requestId = message.requestId;
    let payload: LifecycleFixtureJsonValue;
    if (this.#keyBroker === undefined) {
      payload = { ok: false, code: "FIXTURE_KEY_BROKER_UNAVAILABLE" };
    } else if (this.#handledKeyRequestIds.has(requestId)) {
      payload = { ok: false, code: "FIXTURE_KEY_REQUEST_DUPLICATE" };
    } else {
      this.#handledKeyRequestIds.add(requestId);
      try {
        const response = brokerResponse(this.#keyBroker, message.payload, requestId, this.#keyScope);
        this.#keyRequestAudit.push(response.audit);
        payload = response.payload;
      } catch (error) {
        payload = { ok: false, code: keyErrorCode(error) };
      }
    }
    try {
      this.send({ type: "key-response", requestId, payload });
    } catch {
      // The child exit/close path reports the real fixture failure to waiters.
    }
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #failPendingRequests(error: Error): void {
    for (const requestId of this.#pendingRequests.keys()) this.#retiredRequestIds.add(requestId);
    this.#pendingRequests.clear();
    this.#rejectWaiters(error);
    for (const waiters of this.#stderrCanaryWaiters.values()) {
      for (const waiter of waiters) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#stderrCanaryWaiters.clear();
  }

  #retirePendingRequest(requestId: string): void {
    if (this.#pendingRequests.delete(requestId)) this.#retiredRequestIds.add(requestId);
  }

  #failure(message: string): Error {
    return new Error(message);
  }
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
