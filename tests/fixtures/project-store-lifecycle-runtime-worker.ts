import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  parentPort,
  receiveMessageOnPort,
  workerData,
  MessagePort,
} from "node:worker_threads";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import type { SourceStateFingerprintV1 } from "../../src/orchestrator/lifecycle/contracts/checkpoint.js";
import {
  CapabilityService,
  CHILD_BINDING_GRANT_DOMAIN,
  type RootOrChildAuthorityMaterial,
} from "../../src/orchestrator/lifecycle/capability.service.js";
import {
  AuthorityMaterialAdapter,
  type PrivateAuthorityChannel,
} from "../../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { EncryptedPendingAuthorizationStore } from "../../src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.js";
import { createCapabilityProof } from "../../src/orchestrator/lifecycle/authority/capability-codec.js";
import { buildLifecycleIntentWitness } from "../../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import type {
  LifecycleDurableBoundary,
  LifecycleFaultInjector,
  LifecycleFaultPoint,
} from "../../src/orchestrator/lifecycle/lifecycle-faults.js";
import { connectionBoundEvidenceCoverage } from "../../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { LifecycleWorkerRuntimeFactory } from "../../src/orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import type { SessionEndCoordinator } from "../../src/orchestrator/lifecycle/session-end.coordinator.js";
import { createTrustedValidationProfileRegistry } from "../../src/orchestrator/lifecycle/validation-profile.registry.js";
import { ProjectStoreWorkerBackend } from "../../src/orchestrator/runtime/project-store-worker-backend.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
  type WorkerLike,
} from "../../src/orchestrator/runtime/project-store-executor.js";
import {
  encodeWorkerBinding,
  encodeWorkerBindingAssertion,
} from "../../src/orchestrator/runtime/worker-protocol.js";
import { ChildTransferRepository } from "../../src/orchestrator/storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../../src/orchestrator/storage/evidence-coverage.repository.js";
import { LifecycleApprovalRepository } from "../../src/orchestrator/storage/lifecycle-approval.repository.js";
import { SessionAuthorityRepository } from "../../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../../src/orchestrator/storage/session-lease.repository.js";
import { SqliteLifecycleProjectionRepository } from "../../src/orchestrator/storage/lifecycle-projection.repository.js";

type RecordValue = Record<string, unknown>;

const WORKER_URL = new URL("../../src/workers/project-store.worker.js", import.meta.url);
const MAX_RPC_BYTES = 4 * 1024 * 1024;
const SLEEPER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const EVENT_APPEND_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
  "after-write-before-commit",
  "after-commit-before-response",
]);
const TEMPORARY_FILE_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-temp-write",
  "after-temp-fsync-before-replace",
]);
const ARTIFACT_REPLACE_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "after-replace-before-ack",
]);
const MATERIALIZATION_ACK_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
  "after-write-before-commit",
]);
const WORKFLOW_CREATE_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
]);
const FINAL_CHECKPOINT_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
  "after-write-before-commit",
]);
const OUTBOX_INSERT_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
]);
const WORKFLOW_PHASE_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
  "after-write-before-commit",
  "after-commit-before-response",
]);
const OUTBOX_CLAIM_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
  "after-write-before-commit",
  "after-commit-before-response",
]);
const RESPONSE_DELIVERY_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "after-commit-before-response",
]);
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const VALIDATION_REGISTRY = createTrustedValidationProfileRegistry([{
  profileId: "default",
  profileVersion: 1,
  executable: process.execPath,
  args: ["--version"],
  cwd: process.cwd(),
  env: {},
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
  runnerId: "99999999-9999-4999-8999-999999999998",
}]);

if (parentPort === null) throw new Error("TASK18_RUNTIME_PARENT_REQUIRED");

function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return value as RecordValue;
}

function text(value: RecordValue, key: string): string {
  const observed = value[key];
  if (typeof observed !== "string" || observed.length === 0) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return observed;
}

function unsignedDecimal(value: RecordValue, key: string, minimum = 0n): string {
  const observed = text(value, key);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(observed)) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  const numeric = BigInt(observed);
  if (numeric < minimum || numeric > SQLITE_INT64_MAX) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return observed;
}

function boolean(value: RecordValue, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return value[key] as boolean;
}

function bytes(value: RecordValue, key: string): Buffer {
  const encoded = text(value, key);
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded)) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength > MAX_RPC_BYTES || decoded.toString("base64url") !== encoded) {
    decoded.fill(0);
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return decoded;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/u.test((error as { readonly code: string }).code)) {
    return (error as { readonly code: string }).code;
  }
  if (error instanceof Error && /^TASK18_[A-Z0-9_]{1,63}$/u.test(error.message)) {
    return error.message;
  }
  return "TASK18_RUNTIME_FAILURE";
}

interface RuntimeWorkerData {
  readonly context: ProjectContext;
  readonly childContext: ProjectContext;
  readonly keyPort: MessagePort;
}

interface SelectedFault {
  readonly boundary: LifecycleDurableBoundary;
  readonly point: LifecycleFaultPoint;
}

interface ActiveRoot {
  readonly sessionId: string;
  readonly ownerGeneration: string;
  readonly material: Extract<RootOrChildAuthorityMaterial, { readonly kind: "root" }>;
}

interface ActiveChild {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly capabilityGeneration: string;
  readonly material: Extract<RootOrChildAuthorityMaterial, { readonly kind: "child" }>;
}

let selectedFault: SelectedFault | null = null;
let deferResponseDeliveryFault = false;
let activeRoot: ActiveRoot | null = null;
const activeChildren = new Map<string, ActiveChild>();
let primarySessionEndCoordinator: SessionEndCoordinator | null = null;

function exactFields(value: RecordValue, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
}

function selectedFixtureFault(value: RecordValue): SelectedFault {
  exactFields(value, ["boundary", "point"]);
  const boundary = text(value, "boundary") as LifecycleDurableBoundary;
  const point = text(value, "point") as LifecycleFaultPoint;
  const allowed = boundary === "event-append"
    ? EVENT_APPEND_FAULT_POINTS
    : boundary === "temporary-file-write"
      ? TEMPORARY_FILE_FAULT_POINTS
      : boundary === "artifact-replace"
        ? ARTIFACT_REPLACE_FAULT_POINTS
        : boundary === "materialization-ack"
          ? MATERIALIZATION_ACK_FAULT_POINTS
          : boundary === "workflow-create"
            ? WORKFLOW_CREATE_FAULT_POINTS
            : boundary === "final-checkpoint"
              ? FINAL_CHECKPOINT_FAULT_POINTS
              : boundary === "outbox-insert"
                ? OUTBOX_INSERT_FAULT_POINTS
                : boundary === "workflow-phase"
                  ? WORKFLOW_PHASE_FAULT_POINTS
                : boundary === "outbox-claim"
                  ? OUTBOX_CLAIM_FAULT_POINTS
                  : boundary === "response-delivery"
                    ? RESPONSE_DELIVERY_FAULT_POINTS
          : null;
  if (allowed === null || !allowed.has(point)) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return Object.freeze({ boundary, point });
}

const fixtureFaultInjector: LifecycleFaultInjector = Object.freeze({
  hit(boundary: LifecycleDurableBoundary, point: LifecycleFaultPoint): void {
    if (deferResponseDeliveryFault && boundary === "response-delivery") return;
    if (selectedFault === null || boundary !== selectedFault.boundary || point !== selectedFault.point) return;
    selectedFault = null;
    process.exit(137);
  },
});

function data(): RuntimeWorkerData {
  const observed = record(workerData);
  if (!(observed.keyPort instanceof MessagePort)) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const context = observed.context as ProjectContext;
  const childContext = observed.childContext as ProjectContext;
  if (
    context.binding.projectId !== childContext.binding.projectId
    || context.binding.storeId !== childContext.binding.storeId
    || childContext.binding.actorRole !== "untrusted"
    || childContext.binding.clientInstanceId === context.binding.clientInstanceId
  ) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return { context, childContext, keyPort: observed.keyPort };
}

class SyncCapabilityKeyProviderProxy {
  #sequence = 0;

  constructor(private readonly keyPort: MessagePort) {}

  currentKey(scope: RecordValue, purpose: string): { readonly keyId: string } {
    const result = this.#request({ operation: "currentKey", ...scope, purpose });
    return Object.freeze({ keyId: text(result, "keyId") });
  }

  status(scope: RecordValue, purpose: string, keyId: string): "available" | "revoked" | "unavailable" {
    const status = text(this.#request({ operation: "status", ...scope, purpose, keyId }), "status");
    if (status !== "available" && status !== "revoked" && status !== "unavailable") {
      throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
    }
    return status;
  }

  mac(input: RecordValue): Uint8Array {
    const bytesInput = input.bytes;
    if (!(bytesInput instanceof Uint8Array)) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
    const copy = Buffer.from(bytesInput);
    try {
      const result = this.#request({
        operation: "mac",
        projectId: text(input, "projectId"),
        storeId: text(input, "storeId"),
        purpose: text(input, "purpose"),
        keyId: text(input, "keyId"),
        domain: text(input, "domain"),
        bytes: copy.toString("base64url"),
      });
      return bytes(result, "bytes");
    } finally { copy.fill(0); }
  }

  verify(input: RecordValue): boolean {
    const bytesInput = input.bytes;
    const macInput = input.mac;
    if (!(bytesInput instanceof Uint8Array) || !(macInput instanceof Uint8Array)) {
      throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
    }
    const copiedBytes = Buffer.from(bytesInput);
    const copiedMac = Buffer.from(macInput);
    try {
      return boolean(this.#request({
        operation: "verify",
        projectId: text(input, "projectId"),
        storeId: text(input, "storeId"),
        purpose: text(input, "purpose"),
        keyId: text(input, "keyId"),
        domain: text(input, "domain"),
        bytes: copiedBytes.toString("base64url"),
        mac: copiedMac.toString("base64url"),
      }), "valid");
    } finally { copiedBytes.fill(0); copiedMac.fill(0); }
  }

  fingerprint(input: RecordValue): string {
    const inputBytes = input.bytes;
    if (!(inputBytes instanceof Uint8Array)) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
    const copy = Buffer.from(inputBytes);
    try {
      return text(this.#request({
        operation: "fingerprint",
        projectId: text(input, "projectId"),
        storeId: text(input, "storeId"),
        purpose: text(input, "purpose"),
        keyId: text(input, "keyId"),
        domain: text(input, "domain"),
        bytes: copy.toString("base64url"),
      }), "value");
    } finally { copy.fill(0); }
  }

  seal(input: RecordValue): RecordValue {
    const inputBytes = input.bytes;
    if (!(inputBytes instanceof Uint8Array)) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
    const copy = Buffer.from(inputBytes);
    try {
      return record(this.#request({
        operation: "seal",
        projectId: text(input, "projectId"),
        storeId: text(input, "storeId"),
        purpose: text(input, "purpose"),
        keyId: text(input, "keyId"),
        domain: text(input, "domain"),
        bytes: copy.toString("base64url"),
      }).sealed);
    } finally { copy.fill(0); }
  }

  open(input: RecordValue): Uint8Array {
    const sealed = record(input.sealed);
    return bytes(this.#request({
      operation: "open",
      projectId: text(input, "projectId"),
      storeId: text(input, "storeId"),
      purpose: text(input, "purpose"),
      keyId: text(input, "keyId"),
      domain: text(input, "domain"),
      sealed,
    }), "bytes");
  }

  #request(payload: RecordValue): RecordValue {
    const requestId = `task18-key-${++this.#sequence}`;
    this.keyPort.postMessage({ type: "key-request", requestId, payload });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const received = receiveMessageOnPort(this.keyPort);
      if (received !== undefined) {
        const message = record(received.message);
        if (message.type !== "key-response" || text(message, "requestId") !== requestId) {
          throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
        }
        const response = record(message.payload);
        if (response.ok === false) {
          const failure = new Error(text(response, "code")) as Error & { code: string };
          failure.code = text(response, "code");
          throw failure;
        }
        if (response.ok !== true) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
        return record(response.result);
      }
      if (Date.now() >= deadline) throw new Error("TASK18_KEY_RESPONSE_TIMEOUT");
      Atomics.wait(SLEEPER, 0, 0, 1);
    }
  }
}

function createLifecycleRuntimeFactory(
  capturePrimarySessionEndCoordinator = false,
): LifecycleWorkerRuntimeFactory {
  return new LifecycleWorkerRuntimeFactory({
    clock: { now: () => new Date().toISOString(), nowMs: () => BigInt(Date.now()) },
    identitySource: { uuid: () => randomUUID(), bytes: (length: number) => randomBytes(length) },
    integrity: { assertQuickHealthy: () => undefined },
    ...(capturePrimarySessionEndCoordinator
      ? { validationProfileRegistry: VALIDATION_REGISTRY }
      : {}),
    resumeSourceState: { captureCurrent: (context) => sourceState(context) },
    checkpointSourceStateProvider: {
      capture: async (active) => sourceState(active),
      captureForCheckpoint: (active) => sourceState(active),
      captureForFinalization: (active) => sourceState(active),
    },
    checkpointSourceStateScopeResolver: {
      resolve: (_connection, active) => ({
        scopeVersion: 1,
        descriptorPath: active.binding.descriptorPath,
        storeRoot: active.binding.storeRoute.storeRoot,
        privateStateRoot: active.binding.projectRoot,
        exactMaterializationTargets: [], exactCommittedTempPaths: [],
      }),
    },
    childBindingFingerprint: (target) => (
      target.clientInstanceId === active.childContext.binding.clientInstanceId
        ? active.childContext.binding.contextFingerprint
        : null
    ),
    faultInjector: fixtureFaultInjector,
    repositories: {
      authority: () => new SessionAuthorityRepository(),
      leases: () => new SessionLeaseRepository(),
      approvals: () => new LifecycleApprovalRepository(),
      transfers: () => new ChildTransferRepository(),
      coverage: (provider) => new EvidenceCoverageRepository(provider),
      projection: (connection) => new SqliteLifecycleProjectionRepository(connection),
    },
    transactionFacades: {
      command: ({ connection, authority, leases, approvals, transfers, coverage }) => {
        const extendedAuthority = authority as typeof authority & {
          nextGlobalPosition(current: unknown): bigint;
          loadEvents(current: unknown, record: unknown): readonly unknown[];
        };
        return {
          authority: {
            get: (projectId: string, sessionId: string) => authority.get(connection, projectId, sessionId),
            insertRoot: (input: unknown) => authority.insertRoot(connection, input as never),
            insertChild: (input: unknown) => authority.insertChild(connection, input as never),
            compareAndSwap: (input: unknown) => authority.compareAndSwap(connection, input as never),
            listSafeResumeCandidates: (input: unknown) => authority.listSafeResumeCandidates(connection, input as never),
            listNonterminalRootContinuityOwners: (input: unknown) =>
              authority.listNonterminalRootContinuityOwners(connection, input as never),
            listNonterminalChildren: (projectId: string, rootSessionId: string) =>
              authority.listNonterminalChildren(connection, projectId, rootSessionId),
            listNonterminalChildEndingScopeProjectionsBounded: (
              projectId: string,
              rootSessionId: string,
              limit: number,
            ) => authority.listNonterminalChildEndingScopeProjectionsBounded(
              connection,
              projectId,
              rootSessionId,
              limit,
            ),
            rootContinuityKey: (value: unknown) => authority.rootContinuityKey(connection, value as never),
            latestCheckpoint: (value: unknown) => authority.latestCheckpoint(connection, value as never),
            nextGlobalPosition: () => extendedAuthority.nextGlobalPosition(connection),
            loadEvents: (value: unknown) => extendedAuthority.loadEvents(connection, value),
            requireFoldMatch: (value: unknown) => authority.requireFoldMatch(connection, value as never),
            markCheckpointRequired: (input: unknown) => authority.markCheckpointRequired(connection, input as never),
            updateCheckpointIndex: (input: unknown) => authority.updateCheckpointIndex(connection, input as never),
            clearCheckpointRequired: (input: unknown) => authority.clearCheckpointRequired(connection, input as never),
          },
          leases: {
            current: (projectId: string, sessionId: string) => leases.current(connection, projectId, sessionId),
            isExpired: (value: unknown, now: bigint) => leases.isExpired(value as never, now),
            insertGeneration: (input: unknown) => leases.insertGeneration(connection, input as never),
            renewCurrent: (input: unknown) => leases.renewCurrent(connection, input as never),
            releaseCurrent: (input: unknown) => leases.releaseCurrent(connection, input as never),
          },
          approvals: { consume: (input: unknown) => approvals.consume(connection, input as never) },
          transfers: {
            get: (projectId: string, ticketId: string) => transfers.get(connection, projectId, ticketId),
            findCreatedEventPosition: (projectId: string, ticketId: string) =>
              transfers.findCreatedEventPosition(connection, projectId, ticketId),
            listUnclaimedEndingScopeProjectionsBySourceRoot: (
              projectId: string, rootSessionId: string, limit: number,
            ) => transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
              connection, projectId, rootSessionId, limit,
            ),
            insert: (input: unknown) => transfers.insert(connection, input as never),
            claim: (input: unknown) => transfers.claim(connection, input as never),
          },
          coverage: connectionBoundEvidenceCoverage(connection, coverage),
          workflows: {}, validation: {}, outbox: {},
        } as never;
      },
      operational: () => ({ workflows: {}, outbox: {} } as never),
    },
    ...(capturePrimarySessionEndCoordinator ? {
      onSessionEndCoordinatorCreated: (coordinator: SessionEndCoordinator) => {
        primarySessionEndCoordinator = coordinator;
      },
    } : {}),
  });
}

const active = data();
const provider = new SyncCapabilityKeyProviderProxy(active.keyPort);
const backend = new ProjectStoreWorkerBackend({
  selfUrl: WORKER_URL,
  executorLeaseMs: 20_000,
  appendRetryDeadlineMs: 10_000,
  keyProvider: provider as never,
  lifecycleRuntimeFactory: createLifecycleRuntimeFactory(true),
});

const childBackend = new ProjectStoreWorkerBackend({
  selfUrl: WORKER_URL,
  executorLeaseMs: 20_000,
  appendRetryDeadlineMs: 10_000,
  keyProvider: provider as never,
  lifecycleRuntimeFactory: createLifecycleRuntimeFactory(),
});

/** Bridges the real executor protocol to an in-process store backend without
 * replacing either the executor or its authority adapter. */
class BackendProtocolWorker extends EventEmitter {
  #terminated = false;

  constructor(private readonly delegate: ProjectStoreWorkerBackend) {
    super();
  }

  postMessage(value: unknown): void {
    void this.#dispatch(value);
  }

  async terminate(): Promise<number> {
    if (!this.#terminated) {
      this.#terminated = true;
      this.emit("exit", 0);
    }
    return 0;
  }

  async #dispatch(value: unknown): Promise<void> {
    if (this.#terminated) return;
    const request = record(value);
    const requestId = text(request, "id");
    try {
      this.emit("message", {
        id: requestId,
        ok: true,
        data: await this.delegate.dispatch(value as never),
      });
    } catch (error) {
      const code = errorCode(error);
      this.emit("message", {
        id: requestId,
        ok: false,
        error: { code, message: code, details: {} },
      });
    }
  }
}

class RecordingPrivateAuthorityChannel implements PrivateAuthorityChannel {
  delivered = false;

  #isPrimary(target: { readonly actorRole: string; readonly clientInstanceId: string }): boolean {
    return target.actorRole === "primary"
      && target.clientInstanceId === active.context.binding.clientInstanceId;
  }

  isAttached(target: { readonly actorRole: "primary" | "untrusted"; readonly clientInstanceId: string }): boolean {
    return this.#isPrimary(target);
  }

  isLocalTarget(target: { readonly actorRole: "primary" | "untrusted"; readonly clientInstanceId: string }): boolean {
    return this.#isPrimary(target);
  }

  async deliverLocal(): Promise<void> {
    this.delivered = true;
  }

  async routeDescriptor(): Promise<void> {
    throw new Error("TASK18_UNEXPECTED_DESCRIPTOR_ROUTE");
  }
}

function privatePendingStore(): EncryptedPendingAuthorizationStore {
  const privateStateRoot = resolve(active.context.binding.projectRoot, "..", "task18-host-private");
  mkdirSync(privateStateRoot, { recursive: true });
  return new EncryptedPendingAuthorizationStore({
    privateStateRoot,
    scope: {
      projectId: active.context.binding.projectId,
      storeId: active.context.binding.storeId,
    },
    keyProvider: provider as never,
  });
}

async function executorRootStart(payload: RecordValue): Promise<RecordValue> {
  const wire = rootStart(payload);
  const preparedSource = record(wire.prepared);
  const command = preparedSource.command;
  const pending = privatePendingStore();
  const channel = new RecordingPrivateAuthorityChannel();
  const adapter = new AuthorityMaterialAdapter({
    pendingStore: pending,
    keyProvider: provider as never,
    capabilityService: capabilityService(),
    channel,
    clock: { nowMs: () => BigInt(Date.now()) },
    nonceSource: { uuid: () => randomUUID() },
  });
  const identity = {
    projectId: active.context.binding.projectId,
    commandId: text(record(command), "commandId"),
    idempotencyKey: text(record(command), "idempotencyKey"),
  };
  const trustedContext = {
    context: active.context,
    authoritySessionId: null,
    targetSessionId: null,
    capabilityKind: null,
    capabilityGeneration: null,
    authorityTarget: {
      actorRole: "primary" as const,
      clientInstanceId: active.context.binding.clientInstanceId,
    },
    targetBindingFingerprint: null,
  };
  const requirePendingReplay = payload.requirePendingReplay === true;
  const prepared = requirePendingReplay
    ? await adapter.resumePending(identity, trustedContext)
    : await adapter.prepare(command as never, { kind: "initial-authority" }, trustedContext);
  const executorBackend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 20_000,
    appendRetryDeadlineMs: 10_000,
    keyProvider: provider as never,
    lifecycleRuntimeFactory: createLifecycleRuntimeFactory(),
  });
  const executor = new ProjectStoreExecutor({
    workerUrl: WORKER_URL,
    context: active.context,
    maxPending: DEFAULT_MAX_PENDING,
    requestTimeoutMs: 15_000,
    closeTimeoutMs: 5_000,
    executorLeaseMs: 20_000,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  }, {
    workerFactory: () => new BackendProtocolWorker(executorBackend) as unknown as WorkerLike,
    authorityMaterialAdapter: adapter,
    lifecycleFaultInjector: fixtureFaultInjector,
  });
  try {
    deferResponseDeliveryFault = true;
    await executor.open();
    deferResponseDeliveryFault = false;
    const execution = await executor.executeLifecycleMutation(prepared as never);
    const remaining = await pending.get(identity.projectId, identity.commandId, identity.idempotencyKey);
    if (remaining !== null) throw new Error("TASK18_PENDING_RECORD_RETAINED");
    return {
      operation: "root-start",
      nestedContractVersion: null,
      result: { kind: "success", publicResult: execution.publicResult },
      authorityMaterialDelivered: channel.delivered,
      resumedPending: requirePendingReplay,
      pendingRecordDeleted: true,
    };
  } finally {
    deferResponseDeliveryFault = false;
    await executor.close().catch(() => undefined);
  }
}

function rootStart(payload: RecordValue): RecordValue {
  const continuityKey = text(payload, "continuityKey");
  const idempotencyKey = text(payload, "idempotencyKey");
  const command = {
    commandType: "root-start" as const,
    commandId: payload.commandId === undefined ? randomUUID() : text(payload, "commandId"),
    idempotencyKey,
    agentId: "task18-fixture",
    expectedProjectId: active.context.binding.projectId,
    expectedVaultId: active.context.binding.vaultId,
    expectedWorkspaceId: active.context.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.context),
    continuityKey,
    resumePolicy: "new" as const,
  };
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: command.commandId,
    projectId: active.context.binding.projectId,
    vaultId: active.context.binding.vaultId,
    storeId: active.context.binding.storeId,
    workspaceId: active.context.binding.workspaceId,
    clientNamespace: active.context.binding.clientNamespace,
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: active.context.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: active.context.binding.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  return {
    kind: "semantic",
    operation: "root-start",
    prepared: {
      command,
      candidateIntentHash,
      authorization: {
        kind: "initial-authority",
        authoritySessionId: null,
        targetSessionId: null,
        proof: null,
        approval: null,
        childBindingGrant: null,
      },
    },
  };
}

type FixtureCapabilityKind = "root-session-handle" | "child-session-handle";

interface ProtectedSemanticAuthorization {
  readonly authoritySessionId: string;
  readonly targetSessionId: string;
  readonly capabilityKind: FixtureCapabilityKind;
  readonly capabilityGeneration: string;
  readonly material: RootOrChildAuthorityMaterial;
  readonly targetActorRole?: "primary" | "untrusted";
  readonly targetClientInstanceId?: string;
  readonly childBindingGrant?: RecordValue | null;
  readonly proofNonce?: string;
}

function capabilityService(): CapabilityService {
  return new CapabilityService({
    keyProvider: provider as never,
    clock: { nowMs: () => BigInt(Date.now()) },
    nonceSource: { uuid: () => randomUUID(), bytes: (length: number) => randomBytes(length) },
  });
}

function actorRole(context: ProjectContext): "primary" | "untrusted" {
  return context.binding.actorRole === "untrusted" ? "untrusted" : "primary";
}

function expectedBranchRef(context: ProjectContext): string | null {
  return context.workspace.kind === "git" ? context.workspace.branchRef : null;
}

function sourceState(context: ProjectContext): SourceStateFingerprintV1 {
  return Object.freeze({
    sourceStateScopeVersion: 1,
    workspaceId: context.binding.workspaceId,
    branchRef: expectedBranchRef(context),
    headCommit: null,
    dirtyWorktreeFingerprint: "0".repeat(64),
  });
}

function protectedSemanticOperation(
  context: ProjectContext,
  operation: string,
  command: RecordValue,
  authorization: ProtectedSemanticAuthorization,
): RecordValue {
  const presentingActorRole = actorRole(context);
  const targetActorRole = authorization.targetActorRole ?? presentingActorRole;
  const targetClientInstanceId = authorization.targetClientInstanceId
    ?? context.binding.clientInstanceId;
  const candidateIntentHash = buildLifecycleIntentWitness(command as never, {
    authorizationKind: "protected",
    authorizationSessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId,
    clientNamespace: context.binding.clientNamespace,
    capabilityKind: authorization.capabilityKind,
    capabilityGeneration: authorization.capabilityGeneration,
    presentingActorRole,
    presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole,
    targetClientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  } as never).intentHash;
  const proof = createCapabilityProof(authorization.material.handle, {
    proofVersion: 1,
    target: "semantic-command",
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId,
    clientNamespace: context.binding.clientNamespace,
    authoritySessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    presentingActorRole,
    presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole,
    targetClientInstanceId,
    capabilityKind: authorization.capabilityKind,
    capabilityGeneration: authorization.capabilityGeneration,
    commandId: text(command, "commandId"),
    idempotencyKey: text(command, "idempotencyKey"),
    intentHash: candidateIntentHash,
    proofNonce: authorization.proofNonce ?? randomUUID(),
  } as never);
  return Object.freeze({
    kind: "semantic",
    operation,
    prepared: {
      command,
      candidateIntentHash,
      authorization: {
        kind: "protected",
        authoritySessionId: authorization.authoritySessionId,
        targetSessionId: authorization.targetSessionId,
        proof,
        approval: null,
        childBindingGrant: authorization.childBindingGrant ?? null,
      },
    },
  });
}

async function executeProtectedSemantic(
  targetBackend: ProjectStoreWorkerBackend,
  context: ProjectContext,
  operation: string,
  command: RecordValue,
  authorization: ProtectedSemanticAuthorization,
): Promise<RecordValue> {
  const response = await targetBackend.dispatch({
    id: randomUUID(),
    type: "lifecycle",
    binding: encodeWorkerBindingAssertion(context),
    operation: protectedSemanticOperation(context, operation, command, authorization) as never,
  });
  return record(response);
}

function rootCheckpointCommand(root: ActiveRoot): RecordValue {
  return Object.freeze({
    commandType: "record-checkpoint",
    commandId: randomUUID(),
    idempotencyKey: `task18-root-checkpoint/${randomUUID()}`,
    agentId: "task18-primary-agent",
    expectedProjectId: active.context.binding.projectId,
    expectedVaultId: active.context.binding.vaultId,
    expectedWorkspaceId: active.context.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.context),
    sessionId: root.sessionId,
    expectedStreamVersion: "1",
    expectedBaseEventPosition: "1",
    draft: {
      checkpointVersion: 2,
      taskSummary: "Task 18 root checkpoint before a process session-end request",
      completedItems: [],
      inProgressItems: [],
      blockers: [],
      nextActions: [],
      decisions: [],
      assumptions: [],
      unresolvedConflicts: [],
      filesTouched: [],
      artifactReferences: [],
      sourceReferences: [],
      commandResults: [],
      testResults: [],
      materialClaims: [],
    },
  });
}

async function recordRootCheckpoint(): Promise<RecordValue> {
  const root = activeRoot;
  if (root === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const response = await executeProtectedSemantic(
    backend,
    active.context,
    "record-checkpoint",
    rootCheckpointCommand(root),
    {
      authoritySessionId: root.sessionId,
      targetSessionId: root.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: root.ownerGeneration,
      material: root.material,
    },
  );
  return Object.freeze({
    operation: "record-root-checkpoint",
    result: Object.freeze({ kind: "success", publicResult: workerPublicResult(response) }),
  });
}

interface SessionEndRequest {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly proofNonce: string;
}

function sessionEndRequest(payload: RecordValue): SessionEndRequest {
  exactFields(payload, ["operation", "commandId", "idempotencyKey", "proofNonce"]);
  if (payload.operation !== "request-session-end") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return Object.freeze({
    commandId: text(payload, "commandId"),
    idempotencyKey: text(payload, "idempotencyKey"),
    proofNonce: text(payload, "proofNonce"),
  });
}

function requestSessionEndCommand(root: ActiveRoot, request: SessionEndRequest): RecordValue {
  return Object.freeze({
    commandType: "request-session-end",
    commandId: request.commandId,
    idempotencyKey: request.idempotencyKey,
    agentId: "task18-primary-agent",
    expectedProjectId: active.context.binding.projectId,
    expectedVaultId: active.context.binding.vaultId,
    expectedWorkspaceId: active.context.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.context),
    request: {
      requestVersion: 2,
      sessionId: root.sessionId,
      childEndPolicy: "suspend-and-carry-forward",
      finalCheckpoint: {
        checkpointVersion: 2,
        taskSummary: "Task 18 final checkpoint requested by the current root proof",
        completedItems: [],
        inProgressItems: [],
        blockers: [],
        nextActions: [],
        decisions: [],
        assumptions: [],
        unresolvedConflicts: [],
        filesTouched: [],
        artifactReferences: [],
        sourceReferences: [],
        commandResults: [],
        testResults: [],
        materialClaims: [],
      },
      validationProfileIds: [],
      requestedQualityThreshold: 1,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
}

async function requestSessionEnd(payload: RecordValue): Promise<RecordValue> {
  const root = activeRoot;
  if (root === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const request = sessionEndRequest(payload);
  const command = requestSessionEndCommand(root, request);
  const response = await executeProtectedSemantic(
    backend,
    active.context,
    "request-session-end",
    command,
    {
      authoritySessionId: root.sessionId,
      targetSessionId: root.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: root.ownerGeneration,
      material: root.material,
      proofNonce: request.proofNonce,
    },
  );
  return Object.freeze({
    operation: "request-session-end",
    result: Object.freeze({ kind: "success", publicResult: workerPublicResult(response) }),
  });
}

interface SealSessionEndRequest {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly proofNonce: string;
  readonly workflowId: string;
  readonly expectedStreamVersion: string;
}

function sealSessionEndRequest(
  payload: RecordValue,
  operation: "seal-session-end" | "unchanged-session-end" = "seal-session-end",
): SealSessionEndRequest {
  exactFields(payload, [
    "operation",
    "commandId",
    "idempotencyKey",
    "proofNonce",
    "workflowId",
    "expectedStreamVersion",
  ]);
  if (payload.operation !== operation) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return Object.freeze({
    commandId: text(payload, "commandId"),
    idempotencyKey: text(payload, "idempotencyKey"),
    proofNonce: text(payload, "proofNonce"),
    workflowId: text(payload, "workflowId"),
    expectedStreamVersion: unsignedDecimal(payload, "expectedStreamVersion", 1n),
  });
}

function sealSessionEndCommand(
  root: ActiveRoot,
  request: SealSessionEndRequest,
  evidenceWindowAction: "seal" | "unchanged" = "seal",
): RecordValue {
  return Object.freeze({
    commandType: "amend-session-end",
    commandId: request.commandId,
    idempotencyKey: request.idempotencyKey,
    agentId: "task18-primary-agent",
    expectedProjectId: active.context.binding.projectId,
    expectedVaultId: active.context.binding.vaultId,
    expectedWorkspaceId: active.context.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.context),
    sessionId: root.sessionId,
    workflowId: request.workflowId,
    expectedStreamVersion: request.expectedStreamVersion,
    amendment: {
      amendmentVersion: 2,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: null,
      evidenceWindowAction,
    },
  });
}

async function sealSessionEnd(payload: RecordValue): Promise<RecordValue> {
  const root = activeRoot;
  if (root === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const request = sealSessionEndRequest(payload);
  const response = await executeProtectedSemantic(
    backend,
    active.context,
    "amend-session-end",
    sealSessionEndCommand(root, request),
    {
      authoritySessionId: root.sessionId,
      targetSessionId: root.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: root.ownerGeneration,
      material: root.material,
      proofNonce: request.proofNonce,
    },
  );
  return Object.freeze({
    operation: "seal-session-end",
    result: Object.freeze({ kind: "success", publicResult: workerPublicResult(response) }),
  });
}

async function unchangedSessionEnd(payload: RecordValue): Promise<RecordValue> {
  const root = activeRoot;
  if (root === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const request = sealSessionEndRequest(payload, "unchanged-session-end");
  const response = await executeProtectedSemantic(
    backend,
    active.context,
    "amend-session-end",
    sealSessionEndCommand(root, request, "unchanged"),
    {
      authoritySessionId: root.sessionId,
      targetSessionId: root.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: root.ownerGeneration,
      material: root.material,
      proofNonce: request.proofNonce,
    },
  );
  return Object.freeze({
    operation: "unchanged-session-end",
    result: Object.freeze({ kind: "success", publicResult: workerPublicResult(response) }),
  });
}

function driveSessionEndRequest(payload: RecordValue): {
  readonly ownerId: string;
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
} {
  exactFields(payload, ["operation", "ownerId", "observedNowMs", "leaseDurationMs"]);
  if (payload.operation !== "drive-session-end") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return Object.freeze({
    ownerId: text(payload, "ownerId"),
    observedNowMs: BigInt(unsignedDecimal(payload, "observedNowMs")),
    leaseDurationMs: BigInt(unsignedDecimal(payload, "leaseDurationMs", 1n)),
  });
}

function safeSessionEndDriveResult(value: unknown): RecordValue {
  const result = record(value);
  const status = record(result.status);
  return Object.freeze({
    action: text(result, "action"),
    phase: text(status, "phase"),
    workflowId: text(status, "workflowId"),
  });
}

function driveSessionEnd(payload: RecordValue): RecordValue {
  const coordinator = primarySessionEndCoordinator;
  if (coordinator === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const request = driveSessionEndRequest(payload);
  let result: ReturnType<SessionEndCoordinator["driveOnce"]>;
  try {
    result = coordinator.driveOnce({
      context: active.context,
      ownerId: request.ownerId,
      observedNowMs: request.observedNowMs,
      leaseDurationMs: request.leaseDurationMs,
    });
  } catch (error) {
    const diagnosticSource = error instanceof Error
      ? `${error.name}\n${error.message}\n${error.stack ?? ""}`
      : "";
    const sqliteMarker = [
      "OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID",
      "FINAL_CHECKPOINT_V4_INVALID",
      "LIFECYCLE_EVENT_VERSION_INVALID",
      "WORKFLOW_EVIDENCE_STATE_INVALID",
      "WORKFLOW_LIFECYCLE_INVALID",
      "WORKFLOW_GENERATION_INVALID",
      "COMMAND_AUTHORIZATION_INVALID",
    ].find((marker) => diagnosticSource.includes(marker)) ?? "UNKNOWN";
    const locations = error instanceof Error
      ? [...(error.stack?.matchAll(/(?:session-end\.coordinator|lifecycle-command\.store|event-append-transaction)\.js:(\d+):\d+/gu) ?? [])]
        .map((match) => match[1])
        .filter((line): line is string => line !== undefined)
        .slice(0, 3)
      : [];
    const code = `TASK18_DRIVE_${sqliteMarker}_${locations.join("_") || "UNKNOWN"}`;
    const tagged = new Error(code) as Error & { code: string };
    tagged.code = code;
    throw tagged;
  }
  if (result === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return Object.freeze({
    operation: "drive-session-end",
    result: Object.freeze({ kind: "success", publicResult: safeSessionEndDriveResult(result) }),
  });
}

function safeOutboxClaim(value: unknown): RecordValue {
  if (value === null) throw new Error("TASK18_OUTBOX_CLAIM_NONE");
  const claim = record(value);
  return Object.freeze({
    targetKey: text(claim, "targetKey"),
    materializationRevision: unsignedDecimal(claim, "materializationRevision", 1n),
    artifactPath: text(claim, "artifactPath"),
    ownerId: text(claim, "ownerId"),
    claimToken: unsignedDecimal(claim, "claimToken", 1n),
    claimExpiresAt: text(claim, "claimExpiresAt"),
  });
}

function safeOutboxMaterialization(value: unknown): RecordValue {
  const result = record(value);
  const status = text(result, "status");
  if (status !== "completed" && status !== "superseded-after-completion") {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return Object.freeze({
    status,
    targetKey: text(result, "targetKey"),
    artifactPath: text(result, "artifactPath"),
    materializationRevision: unsignedDecimal(result, "materializationRevision", 1n),
    acknowledged: boolean(result, "acknowledged"),
  });
}

async function claimNextOutbox(payload: RecordValue): Promise<RecordValue> {
  exactFields(payload, ["operation", "workId", "ownerId", "observedNowMs", "ttlMs"]);
  if (payload.operation !== "outbox-claim-next") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const response = await backend.dispatch({
    id: randomUUID(),
    type: "lifecycle",
    binding: encodeWorkerBindingAssertion(active.context),
    operation: {
      kind: "fenced",
      operation: "outbox-claim-next",
      input: {
        operation: "outbox-claim-next",
        workId: text(payload, "workId"),
        ownerId: text(payload, "ownerId"),
        observedNowMs: unsignedDecimal(payload, "observedNowMs"),
        ttlMs: unsignedDecimal(payload, "ttlMs", 1n),
      },
    } as never,
  });
  return Object.freeze({
    operation: "outbox-claim-next",
    result: Object.freeze({ kind: "success", publicResult: safeOutboxClaim(workerFencedResult(record(response)))}),
  });
}

async function materializeOutbox(payload: RecordValue): Promise<RecordValue> {
  exactFields(payload, [
    "operation", "workId", "ownerId", "fencingToken", "targetKey", "materializationRevision",
  ]);
  if (payload.operation !== "outbox-materialize") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  let response: RecordValue;
  try {
    response = record(await backend.dispatch({
      id: randomUUID(),
      type: "lifecycle",
      binding: encodeWorkerBindingAssertion(active.context),
      operation: {
        kind: "fenced",
        operation: "outbox-materialize",
        input: {
          operation: "outbox-materialize",
          workId: text(payload, "workId"),
          ownerId: text(payload, "ownerId"),
          fencingToken: unsignedDecimal(payload, "fencingToken", 1n),
          targetKey: text(payload, "targetKey"),
          materializationRevision: unsignedDecimal(payload, "materializationRevision", 1n),
        },
      } as never,
    }));
  } catch (error) {
    const locations = error instanceof Error
      ? [...(error.stack?.matchAll(/(?:compatibility-log\.materializer|lifecycle-outbox\.repository|lifecycle-operational\.store|lifecycle-worker-runtime)\.js:(\d+):\d+/gu) ?? [])]
        .map((match) => match[1])
        .filter((line): line is string => line !== undefined)
        .slice(0, 3)
      : [];
    const code = `TASK18_MATERIALIZE_${locations.join("_") || "UNKNOWN"}`;
    const tagged = new Error(code) as Error & { code: string };
    tagged.code = code;
    throw tagged;
  }
  return Object.freeze({
    operation: "outbox-materialize",
    result: Object.freeze({ kind: "success", publicResult: safeOutboxMaterialization(workerFencedResult(response))}),
  });
}

function workerExecution(response: RecordValue): RecordValue {
  return record(response.result);
}

function workerFencedResult(response: RecordValue): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(response, "result");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  return descriptor.value;
}

function workerPublicResult(response: RecordValue): RecordValue {
  const execution = workerExecution(response);
  if (execution.kind !== "success") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return record(execution.publicResult);
}

function childBindingGrant(root: ActiveRoot): RecordValue {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const claims = {
    grantVersion: 1,
    grantId: randomUUID(),
    projectId: active.context.binding.projectId,
    storeId: active.context.binding.storeId,
    parentSessionId: root.sessionId,
    targetActorRole: "untrusted" as const,
    targetClientInstanceId: active.childContext.binding.clientInstanceId,
    issuedAt,
    expiresAt,
    bindingFingerprint: active.childContext.binding.contextFingerprint,
  };
  const bytesToAuthenticate = Buffer.from(canonicalJson(claims), "utf8");
  let mac: Uint8Array | undefined;
  try {
    const keyId = provider.currentKey({
      projectId: claims.projectId,
      storeId: claims.storeId,
    }, "child-binding-grant").keyId;
    mac = provider.mac({
      projectId: claims.projectId,
      storeId: claims.storeId,
      purpose: "child-binding-grant",
      keyId,
      domain: CHILD_BINDING_GRANT_DOMAIN,
      bytes: bytesToAuthenticate,
    });
    return Object.freeze({ ...claims, mac: Buffer.from(mac).toString("base64url") });
  } finally {
    bytesToAuthenticate.fill(0);
    mac?.fill(0);
  }
}

async function forkDirectChild(root: ActiveRoot): Promise<ActiveChild> {
  const command = {
    commandType: "fork-child",
    commandId: randomUUID(),
    idempotencyKey: `task18-direct-child/${randomUUID()}`,
    agentId: "task18-primary-agent",
    expectedProjectId: active.context.binding.projectId,
    expectedVaultId: active.context.binding.vaultId,
    expectedWorkspaceId: active.context.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.context),
    parentSessionId: root.sessionId,
    expectedStreamVersion: "1",
    assignment: {
      assignmentId: randomUUID(),
      summary: "Task 18 direct untrusted child workflow",
      scope: "task18/direct-child",
    },
    directAccessRequested: true,
  };
  const response = await executeProtectedSemantic(backend, active.context, "fork-child", command, {
    authoritySessionId: root.sessionId,
    targetSessionId: root.sessionId,
    capabilityKind: "root-session-handle",
    capabilityGeneration: root.ownerGeneration,
    material: root.material,
    targetActorRole: "untrusted",
    targetClientInstanceId: active.childContext.binding.clientInstanceId,
    childBindingGrant: childBindingGrant(root),
  });
  const execution = workerExecution(response);
  const publicResult = workerPublicResult(response);
  const authorityMaterial = record(execution.authorityMaterial);
  if (
    authorityMaterial.status !== "current"
    || authorityMaterial.descriptor === null
    || authorityMaterial.target === null
  ) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const material = capabilityService().reconstructForTarget(
    authorityMaterial.descriptor as never,
    authorityMaterial.target as never,
  );
  if (material.kind !== "child") {
    material.handle.destroy();
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  const child = Object.freeze({
    sessionId: text(publicResult, "childSessionId"),
    parentSessionId: text(publicResult, "parentSessionId"),
    capabilityGeneration: text(authorityMaterial, "capabilityGeneration"),
    material,
  });
  activeChildren.set(child.sessionId, child);
  return child;
}

function childReportCommand(child: ActiveChild): RecordValue {
  return Object.freeze({
    commandType: "record-child-report",
    commandId: randomUUID(),
    idempotencyKey: `task18-child-report/${randomUUID()}`,
    agentId: "task18-child-agent",
    expectedProjectId: active.childContext.binding.projectId,
    expectedVaultId: active.childContext.binding.vaultId,
    expectedWorkspaceId: active.childContext.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.childContext),
    parentSessionId: child.parentSessionId,
    childSessionId: child.sessionId,
    childAuthorAgentId: "task18-child-agent",
    expectedStreamVersion: "1",
    report: {
      reportVersion: 1,
      outcomeSummary: "Task 18 child completed the bounded workflow",
      findings: [{
        summary: "Child report is scoped to its own direct binding",
        evidenceReferences: ["task18-direct-child-evidence"],
        confidence: "high",
      }],
      proposedDecisions: [],
      filesObservedOrChanged: [],
      verificationPerformed: [],
      openFollowUps: [],
      blockers: [],
      evidenceFingerprints: [{
        fingerprintSchemaVersion: 1,
        fingerprintKeyId: "task18-child-evidence-key",
        fingerprintDomain: "pm-evidence-frame-v1",
        fingerprint: "a".repeat(64),
      }],
    },
  });
}

function childProposalCommand(child: ActiveChild, reportId: string): RecordValue {
  return Object.freeze({
    commandType: "propose-child-completion",
    commandId: randomUUID(),
    idempotencyKey: `task18-child-proposal/${randomUUID()}`,
    agentId: "task18-child-agent",
    expectedProjectId: active.childContext.binding.projectId,
    expectedVaultId: active.childContext.binding.vaultId,
    expectedWorkspaceId: active.childContext.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.childContext),
    childSessionId: child.sessionId,
    expectedStreamVersion: "2",
    reportId,
  });
}

function childCompletionCommand(root: ActiveRoot, child: ActiveChild, reportId: string): RecordValue {
  return Object.freeze({
    commandType: "complete-child-session",
    commandId: randomUUID(),
    idempotencyKey: `task18-child-completion/${randomUUID()}`,
    agentId: "task18-primary-agent",
    expectedProjectId: active.context.binding.projectId,
    expectedVaultId: active.context.binding.vaultId,
    expectedWorkspaceId: active.context.binding.workspaceId,
    expectedBranchRef: expectedBranchRef(active.context),
    parentSessionId: root.sessionId,
    childSessionId: child.sessionId,
    expectedStreamVersion: "3",
    reportId,
  });
}

async function runChildWorkflow(): Promise<RecordValue> {
  const root = activeRoot;
  if (root === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const child = await forkDirectChild(root);
  try {
    const report = workerPublicResult(await executeProtectedSemantic(
      childBackend,
      active.childContext,
      "record-child-report",
      childReportCommand(child),
      {
        authoritySessionId: child.sessionId,
        targetSessionId: child.sessionId,
        capabilityKind: "child-session-handle",
        capabilityGeneration: child.capabilityGeneration,
        material: child.material,
        targetActorRole: "untrusted",
        targetClientInstanceId: active.childContext.binding.clientInstanceId,
      },
    ));
    const reportId = text(report, "reportId");
    const proposed = workerPublicResult(await executeProtectedSemantic(
      childBackend,
      active.childContext,
      "propose-child-completion",
      childProposalCommand(child, reportId),
      {
        authoritySessionId: child.sessionId,
        targetSessionId: child.sessionId,
        capabilityKind: "child-session-handle",
        capabilityGeneration: child.capabilityGeneration,
        material: child.material,
        targetActorRole: "untrusted",
        targetClientInstanceId: active.childContext.binding.clientInstanceId,
      },
    ));
    const completed = workerPublicResult(await executeProtectedSemantic(
      backend,
      active.context,
      "complete-child-session",
      childCompletionCommand(root, child, reportId),
      {
        authoritySessionId: root.sessionId,
        targetSessionId: child.sessionId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: root.ownerGeneration,
        material: root.material,
      },
    ));
    return Object.freeze({
      operation: "child-workflow",
      parentSessionId: root.sessionId,
      childSessionId: child.sessionId,
      rootOwnerGeneration: root.ownerGeneration,
      rootState: "active",
      childState: text(completed, "state"),
      reported: report.operation === "record-child-report",
      proposed: proposed.operation === "propose-child-completion",
      completed: completed.operation === "complete-child-session",
    });
  } finally {
    activeChildren.delete(child.sessionId);
    child.material.handle.destroy();
  }
}

function destroyActiveRoot(): void {
  if (activeRoot === null) return;
  activeRoot.material.handle.destroy();
  activeRoot.material.resumeToken?.destroy();
  activeRoot = null;
}

function destroyActiveChildren(): void {
  for (const child of activeChildren.values()) child.material.handle.destroy();
  activeChildren.clear();
}

function rememberActiveRoot(value: unknown): void {
  const response = record(value);
  const execution = record(response.result);
  const publicResult = record(execution.publicResult);
  const authorityMaterial = record(execution.authorityMaterial);
  if (
    response.operation !== "root-start"
    || execution.kind !== "success"
    || authorityMaterial.status !== "current"
    || authorityMaterial.descriptor === null
    || authorityMaterial.target === null
  ) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const capabilities = new CapabilityService({
    keyProvider: provider as never,
    clock: { nowMs: () => BigInt(Date.now()) },
    nonceSource: { uuid: () => randomUUID(), bytes: (length: number) => randomBytes(length) },
  });
  const material = capabilities.reconstructForTarget(
    authorityMaterial.descriptor as never,
    authorityMaterial.target as never,
  );
  if (material.kind !== "root") {
    material.handle.destroy();
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  destroyActiveRoot();
  activeRoot = Object.freeze({
    sessionId: text(publicResult, "sessionId"),
    ownerGeneration: text(publicResult, "ownerGeneration"),
    material,
  });
}

interface ForkChildrenRequest {
  readonly count: number;
  readonly commandId: string | null;
  readonly idempotencyKey: string | null;
  readonly assignmentId: string | null;
  readonly proofNonce: string | null;
}

function forkChildrenRequest(payload: RecordValue): ForkChildrenRequest {
  const hasStableIdentity = ["commandId", "idempotencyKey", "assignmentId", "proofNonce"]
    .some((key) => Object.hasOwn(payload, key));
  exactFields(payload, hasStableIdentity
    ? ["operation", "count", "commandId", "idempotencyKey", "assignmentId", "proofNonce"]
    : ["operation", "count"]);
  if (payload.operation !== "fork-children" || !Number.isSafeInteger(payload.count)
    || Number(payload.count) < 1 || Number(payload.count) > 32) {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  const count = Number(payload.count);
  if (!hasStableIdentity) {
    return Object.freeze({ count, commandId: null, idempotencyKey: null, assignmentId: null, proofNonce: null });
  }
  if (count !== 1) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  return Object.freeze({
    count,
    commandId: text(payload, "commandId"),
    idempotencyKey: text(payload, "idempotencyKey"),
    assignmentId: text(payload, "assignmentId"),
    proofNonce: text(payload, "proofNonce"),
  });
}

async function forkChildren(payload: RecordValue): Promise<RecordValue> {
  const root = activeRoot;
  if (root === null) throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  const request = forkChildrenRequest(payload);
  let childCount = 0;
  for (let index = 0; index < request.count; index += 1) {
    const command = {
      commandType: "fork-child" as const,
      commandId: request.commandId ?? randomUUID(),
      idempotencyKey: request.idempotencyKey ?? `task18-fork-${index}`,
      agentId: "task18-fixture",
      expectedProjectId: active.context.binding.projectId,
      expectedVaultId: active.context.binding.vaultId,
      expectedWorkspaceId: active.context.binding.workspaceId,
      expectedBranchRef: expectedBranchRef(active.context),
      parentSessionId: root.sessionId,
      expectedStreamVersion: "1",
      assignment: {
        assignmentId: request.assignmentId ?? randomUUID(),
        summary: `task18 child ${index}`,
        scope: `task18/child/${index}`,
      },
      directAccessRequested: false,
    };
    const assertions = {
      authorizationKind: "protected" as const,
      authorizationSessionId: root.sessionId,
      targetSessionId: root.sessionId,
      projectId: active.context.binding.projectId,
      vaultId: active.context.binding.vaultId,
      storeId: active.context.binding.storeId,
      workspaceId: active.context.binding.workspaceId,
      clientNamespace: active.context.binding.clientNamespace,
      capabilityKind: "root-session-handle" as const,
      capabilityGeneration: root.ownerGeneration,
      presentingActorRole: "primary" as const,
      presentingClientInstanceId: active.context.binding.clientInstanceId,
      targetActorRole: "primary" as const,
      targetClientInstanceId: active.context.binding.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    };
    const candidateIntentHash = buildLifecycleIntentWitness(command as never, assertions as never).intentHash;
    const proof = createCapabilityProof(root.material.handle, {
      proofVersion: 1,
      target: "semantic-command",
      projectId: active.context.binding.projectId,
      vaultId: active.context.binding.vaultId,
      storeId: active.context.binding.storeId,
      workspaceId: active.context.binding.workspaceId,
      clientNamespace: active.context.binding.clientNamespace,
      authoritySessionId: root.sessionId,
      targetSessionId: root.sessionId,
      presentingActorRole: "primary",
      presentingClientInstanceId: active.context.binding.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: active.context.binding.clientInstanceId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: root.ownerGeneration,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: candidateIntentHash,
      proofNonce: request.proofNonce ?? randomUUID(),
    } as never);
    const response = await backend.dispatch({
      id: randomUUID(),
      type: "lifecycle",
      binding: encodeWorkerBindingAssertion(active.context),
      operation: {
        kind: "semantic",
        operation: "fork-child",
        prepared: {
          command,
          candidateIntentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: root.sessionId,
            targetSessionId: root.sessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      } as never,
    });
    const worker = record(record(response).result);
    const publicResult = record(worker.publicResult);
    if (worker.kind !== "success" || worker.operation !== undefined && worker.operation !== "fork-child") {
      throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
    }
    text(publicResult, "childSessionId");
    childCount += 1;
  }
  return Object.freeze({
    operation: "fork-children",
    childCount,
    parentSessionId: root.sessionId,
    rootOwnerGeneration: root.ownerGeneration,
  });
}

function safeRootStartResult(value: unknown): RecordValue {
  const response = record(value);
  const result = record(response.result);
  if (response.operation !== "root-start" || result.kind !== "success") {
    throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
  }
  const publicResult = record(result.publicResult);
  exactFields(publicResult, [
    "resultVersion", "project", "sessionId", "ownerGeneration", "continuityKey",
    "state", "resumedFromSessionId", "latestCheckpointEventPosition", "eventPosition",
    "handleIssued", "resumeTokenIssued", "contextPackUnavailable",
  ]);
  const project = record(publicResult.project);
  exactFields(project, ["projectId", "vaultId", "storeId", "workspaceId", "clientNamespace"]);
  return {
    operation: "root-start",
    nestedContractVersion: response.nestedContractVersion === null ? null : null,
    result: {
      kind: "success",
      publicResult: {
        resultVersion: publicResult.resultVersion,
        project: {
          projectId: project.projectId,
          vaultId: project.vaultId,
          storeId: project.storeId,
          workspaceId: project.workspaceId,
          clientNamespace: project.clientNamespace,
        },
        sessionId: publicResult.sessionId,
        ownerGeneration: publicResult.ownerGeneration,
        continuityKey: publicResult.continuityKey,
        state: publicResult.state,
        resumedFromSessionId: publicResult.resumedFromSessionId,
        latestCheckpointEventPosition: publicResult.latestCheckpointEventPosition,
        eventPosition: publicResult.eventPosition,
        handleIssued: publicResult.handleIssued,
        resumeTokenIssued: publicResult.resumeTokenIssued,
        contextPackUnavailable: publicResult.contextPackUnavailable,
      },
    },
  };
}

let queue = Promise.resolve();
parentPort.on("message", (message: unknown) => {
  queue = queue.then(async () => {
    const request = record(message);
    const requestId = text(request, "requestId");
    try {
      switch (request.type) {
        case "open":
          await backend.dispatch({ id: randomUUID(), type: "open", binding: encodeWorkerBinding(active.context) });
          await childBackend.dispatch({
            id: randomUUID(),
            type: "open",
            binding: encodeWorkerBinding(active.childContext),
          });
          parentPort!.postMessage({ type: "result", requestId, value: { opened: true } });
          return;
        case "root-start": {
          const response = await backend.dispatch({
            id: randomUUID(),
            type: "lifecycle",
            binding: encodeWorkerBindingAssertion(active.context),
            operation: rootStart(record(request.payload)) as never,
          });
          rememberActiveRoot(response);
          parentPort!.postMessage({ type: "result", requestId, value: safeRootStartResult(response) });
          return;
        }
        case "executor-root-start": {
          const value = await executorRootStart(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "fork-children": {
          const value = await forkChildren(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "record-root-checkpoint": {
          const payload = record(request.payload);
          exactFields(payload, ["operation"]);
          if (payload.operation !== "record-root-checkpoint") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
          const value = await recordRootCheckpoint();
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "request-session-end": {
          const value = await requestSessionEnd(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "seal-session-end": {
          const value = await sealSessionEnd(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "unchanged-session-end": {
          const value = await unchangedSessionEnd(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "drive-session-end": {
          const value = driveSessionEnd(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "outbox-claim-next": {
          const value = await claimNextOutbox(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "outbox-materialize": {
          const value = await materializeOutbox(record(request.payload));
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "child-workflow": {
          const payload = record(request.payload);
          exactFields(payload, ["operation"]);
          if (payload.operation !== "child-workflow") throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
          const value = await runChildWorkflow();
          parentPort!.postMessage({ type: "result", requestId, value });
          return;
        }
        case "fault": {
          const selected = selectedFixtureFault(record(request.payload));
          selectedFault = selected;
          parentPort!.postMessage({
            type: "result",
            requestId,
            value: { boundary: selected.boundary, point: selected.point, armed: true },
          });
          return;
        }
        case "close":
          destroyActiveChildren();
          destroyActiveRoot();
          await childBackend.close();
          await backend.close();
          active.keyPort.close();
          parentPort!.postMessage({ type: "result", requestId, value: { closed: true } });
          parentPort!.close();
          return;
        default:
          throw new Error("TASK18_RUNTIME_PROTOCOL_ERROR");
      }
    } catch (error) {
      parentPort!.postMessage({ type: "error", requestId, code: errorCode(error) });
    }
  });
});

parentPort.postMessage({ type: "ready" });
