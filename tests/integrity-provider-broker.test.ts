import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { afterEach, test } from "node:test";
import type {
  ProjectBinding,
  ProjectContext,
} from "../src/orchestrator/identity/contracts.js";
import { deriveNonGitWorkspaceId } from "../src/orchestrator/identity/git-workspace.resolver.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import {
  ProjectStoreWorkerBackend,
  ProjectStoreWorkerBackendError,
  type IntegrityWorkerLike,
} from "../src/orchestrator/runtime/project-store-worker-backend.js";
import {
  MAX_INTEGRITY_PROVIDER_INPUT_BYTES,
  WorkerProtocolError,
  decodeIntegrityProviderRequestWire,
  decodeIntegrityProviderResponseWire,
  encodeWorkerBinding,
  encodeWorkerBindingAssertion,
} from "../src/orchestrator/runtime/worker-protocol.js";
import { WorkerIntegrityProviderClient } from "../src/orchestrator/runtime/worker-integrity-provider-client.js";
import { DefaultProjectStoreBootstrapService } from "../src/orchestrator/storage/project-store-bootstrap.service.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";

const WORKER_URL = new URL("../src/workers/project-store.worker.js", import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function projectContext(): Promise<ProjectContext> {
  const root = canonicalMkdtemp("integrity-provider-broker-");
  roots.push(root);
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  const initialized = await new DefaultProjectStoreBootstrapService().initialize({
    projectRoot,
    vaultRoot,
  });
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: projectRoot,
    workspaceId: deriveNonGitWorkspaceId(
      initialized.descriptor.projectId,
      initialized.descriptor.vaultId,
    ),
  };
  const withoutPrivate: Omit<
    ProjectBinding,
    "contextFingerprint" | "projectBindingId" | "establishedAt"
  > = {
    generation: 1,
    source: "explicit-cli",
    projectId: initialized.descriptor.projectId,
    vaultId: initialized.descriptor.vaultId,
    storeId: initialized.manifest.storeId,
    workspaceId: workspace.workspaceId,
    clientNamespace: "codex",
    clientInstanceId: "broker-test",
    actorRole: "primary",
    projectRoot,
    vaultRoot,
    descriptorPath: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: initialized.route,
    workspace,
  };
  const binding: ProjectBinding = {
    ...withoutPrivate,
    projectBindingId: randomUUID(),
    contextFingerprint: computeProjectContextFingerprint(withoutPrivate),
    establishedAt: new Date().toISOString(),
  };
  return { binding, workspace, checkedAt: new Date().toISOString() };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

class BrokerChild extends EventEmitter implements IntegrityWorkerLike {
  readonly posted: unknown[] = [];
  readonly termination = deferred<number>();
  terminateCalls = 0;

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.termination.promise;
  }
}

class ThrowingFingerprintProvider extends DeterministicCapabilityKeyProvider {
  override fingerprint(
    ...parameters: Parameters<DeterministicCapabilityKeyProvider["fingerprint"]>
  ): string {
    super.fingerprint(...parameters);
    throw new Error("provider-secret-canary");
  }
}

class MalformedFingerprintProvider extends DeterministicCapabilityKeyProvider {
  override fingerprint(
    ...parameters: Parameters<DeterministicCapabilityKeyProvider["fingerprint"]>
  ): string {
    super.fingerprint(...parameters);
    return "A".repeat(64);
  }
}

class DetachingFingerprintProvider extends DeterministicCapabilityKeyProvider {
  override fingerprint(
    ...parameters: Parameters<DeterministicCapabilityKeyProvider["fingerprint"]>
  ): string {
    const fingerprint = super.fingerprint(...parameters);
    const [input] = parameters;
    structuredClone(input.bytes, { transfer: [input.bytes.buffer as ArrayBuffer] });
    return fingerprint;
  }
}

class FillTamperingFingerprintProvider extends DeterministicCapabilityKeyProvider {
  override fingerprint(
    ...parameters: Parameters<DeterministicCapabilityKeyProvider["fingerprint"]>
  ): string {
    const fingerprint = super.fingerprint(...parameters);
    const [input] = parameters;
    input.bytes.fill = (() => {
      throw new Error("provider-fill-secret-canary");
    }) as typeof input.bytes.fill;
    return fingerprint;
  }
}

function captureOwnedUint8Arrays<T>(operation: () => T): {
  readonly result: T;
  readonly allocations: Uint8Array[];
} {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array")!;
  const OriginalUint8Array = Uint8Array;
  const allocations: Uint8Array[] = [];
  const CapturingUint8Array = new Proxy(OriginalUint8Array, {
    construct(target, argumentsList, newTarget) {
      const value = Reflect.construct(target, argumentsList, newTarget) as Uint8Array;
      if (typeof argumentsList[0] === "number") allocations.push(value);
      return value;
    },
  });
  Object.defineProperty(globalThis, "Uint8Array", {
    ...descriptor,
    value: CapturingUint8Array,
  });
  try {
    return { result: operation(), allocations };
  } finally {
    Object.defineProperty(globalThis, "Uint8Array", descriptor);
  }
}

function emptyReport(mode: "quick" | "full"): Record<string, unknown> {
  return {
    ok: true,
    mode,
    projectId: "",
    storeId: "",
    firstGlobalPosition: "0",
    lastGlobalPosition: "0",
    eventsVerified: 0,
    streamsVerified: 0,
    commandsVerified: 0,
    schemaFingerprint: "a".repeat(64),
    terminalEventHash: "0".repeat(64),
    issues: [],
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

function rejectsProtocol(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => error instanceof WorkerProtocolError);
}

test("integrity provider broker preserves backend ownership and strict request correlation", async (context) => {
  const channels: MessageChannel[] = [];
  context.after(() => {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
  });
  const astralKeyId = "🔐".repeat(128);
  const statusRequest = {
    type: "integrity-provider-request",
    integrityRequestId: "integrity-1",
    providerRequestId: "provider-1",
    operation: "status",
    keyId: astralKeyId,
  } as const;
  assert.deepEqual(decodeIntegrityProviderRequestWire(statusRequest), statusRequest);
  rejectsProtocol(() => decodeIntegrityProviderRequestWire({
    ...statusRequest,
    keyId: `${astralKeyId}x`,
  }));

  const fingerprintBytes = new Uint8Array([1, 2, 3, 4]);
  const fingerprintRequest = {
    type: "integrity-provider-request",
    integrityRequestId: "integrity-1",
    providerRequestId: "provider-2",
    operation: "fingerprint",
    keyId: "historical-key",
    bytes: fingerprintBytes,
  } as const;
  assert.deepEqual(decodeIntegrityProviderRequestWire(fingerprintRequest), fingerprintRequest);
  for (const bytes of [
    new Uint8Array(0),
    new Uint8Array(MAX_INTEGRITY_PROVIDER_INPUT_BYTES + 1),
    new Uint8Array(new ArrayBuffer(4), 1, 2),
    new DataView(new ArrayBuffer(4)),
  ]) {
    rejectsProtocol(() => decodeIntegrityProviderRequestWire({
      ...fingerprintRequest,
      bytes,
    }));
  }
  if (typeof SharedArrayBuffer === "function") {
    rejectsProtocol(() => decodeIntegrityProviderRequestWire({
      ...fingerprintRequest,
      bytes: new Uint8Array(new SharedArrayBuffer(4)),
    }));
  }

  const statusResponse = {
    type: "integrity-provider-response",
    integrityRequestId: "integrity-1",
    providerRequestId: "provider-1",
    operation: "status",
    ok: true,
    status: "available",
  } as const;
  assert.deepEqual(decodeIntegrityProviderResponseWire(statusResponse), statusResponse);
  const fingerprintResponse = {
    type: "integrity-provider-response",
    integrityRequestId: "integrity-1",
    providerRequestId: "provider-2",
    operation: "fingerprint",
    ok: true,
    fingerprint: "a".repeat(64),
  } as const;
  assert.deepEqual(decodeIntegrityProviderResponseWire(fingerprintResponse), fingerprintResponse);
  rejectsProtocol(() => decodeIntegrityProviderResponseWire({
    ...fingerprintResponse,
    fingerprint: "A".repeat(64),
  }));
  rejectsProtocol(() => decodeIntegrityProviderResponseWire({
    type: "integrity-provider-response",
    integrityRequestId: "integrity-1",
    providerRequestId: "provider-2",
    operation: "fingerprint",
    ok: false,
    code: "INTEGRITY_FAILURE",
    details: { canary: "provider-secret" },
  }));

  const channel = new MessageChannel();
  channels.push(channel);
  const posted: unknown[] = [];
  channel.port2.on("message", (value: unknown) => posted.push(value));
  const client = new WorkerIntegrityProviderClient(channel.port1, "integrity-1", "full");
  const pendingStatus = client.status("historical-key");
  await new Promise<void>((resolve) => channel.port2.once("message", () => resolve()));
  const postedStatus = decodeIntegrityProviderRequestWire(posted[0]);
  assert.equal(postedStatus.operation, "status");
  client.accept({
    type: "integrity-provider-response",
    integrityRequestId: postedStatus.integrityRequestId,
    providerRequestId: postedStatus.providerRequestId,
    operation: "status",
    ok: true,
    status: "available",
  });
  assert.equal(await pendingStatus, "available");

  const source = Buffer.from([9, 8, 7]);
  const pendingFingerprint = client.fingerprint("historical-key", source);
  await new Promise<void>((resolve) => channel.port2.once("message", () => resolve()));
  const postedFingerprint = decodeIntegrityProviderRequestWire(posted[1]);
  assert.equal(postedFingerprint.operation, "fingerprint");
  assert.deepEqual([...postedFingerprint.bytes], [9, 8, 7]);
  assert.deepEqual([...source], [9, 8, 7]);
  client.accept({
    type: "integrity-provider-response",
    integrityRequestId: postedFingerprint.integrityRequestId,
    providerRequestId: postedFingerprint.providerRequestId,
    operation: "fingerprint",
    ok: true,
    fingerprint: "b".repeat(64),
  });
  assert.equal(await pendingFingerprint, "b".repeat(64));
  const missingStatus = client.status("missing-key");
  await new Promise<void>((resolve) => channel.port2.once("message", () => resolve()));
  const missingStatusRequest = decodeIntegrityProviderRequestWire(posted[2]);
  client.accept({
    type: "integrity-provider-response",
    integrityRequestId: missingStatusRequest.integrityRequestId,
    providerRequestId: missingStatusRequest.providerRequestId,
    operation: "status",
    ok: false,
    code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
  });
  await assert.rejects(
    missingStatus,
    (error: unknown) => (error as { code?: unknown }).code
      === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
  );

  const invalidKeyClient = new WorkerIntegrityProviderClient({
    postMessage(): void {
      assert.fail("invalid key must fail before posting");
    },
  } as Pick<typeof channel.port1, "postMessage">, "invalid-key-copy", "full");
  const invalidKeyCopy = captureOwnedUint8Arrays(() => invalidKeyClient.fingerprint(
    "x".repeat(129),
    new Uint8Array([6, 5, 4]),
  ));
  await assert.rejects(
    invalidKeyCopy.result,
    (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR",
  );
  assert.deepEqual([...invalidKeyCopy.allocations.at(-1)!], [0, 0, 0]);

  const concurrentPosts: unknown[] = [];
  const concurrentClient = new WorkerIntegrityProviderClient({
    postMessage(value: unknown): void { concurrentPosts.push(value); },
  } as Pick<typeof channel.port1, "postMessage">, "concurrent-copy", "full");
  const concurrentPending = concurrentClient.status("historical-key");
  const concurrentCopy = captureOwnedUint8Arrays(() => concurrentClient.fingerprint(
    "historical-key",
    new Uint8Array([3, 2, 1]),
  ));
  await assert.rejects(
    concurrentCopy.result,
    (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR",
  );
  assert.equal(concurrentPosts.length, 1);
  assert.deepEqual([...concurrentCopy.allocations.at(-1)!], [0, 0, 0]);
  concurrentClient.dispose(new Error("test complete"));
  await assert.rejects(concurrentPending, /test complete/);

  let throwingPortBytes: Uint8Array | undefined;
  const throwingPortClient = new WorkerIntegrityProviderClient({
    postMessage(value: unknown): void {
      throwingPortBytes = (value as { bytes?: Uint8Array }).bytes;
      throw new Error("port-secret-canary");
    },
  } as Pick<typeof channel.port1, "postMessage">, "throwing-port-copy", "full");
  await assert.rejects(
    throwingPortClient.fingerprint("historical-key", new Uint8Array([8, 6, 4, 2])),
    (error: unknown) => (
      (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR"
      && !String((error as Error).message).includes("port-secret-canary")
    ),
  );
  assert.deepEqual([...(throwingPortBytes ?? [])], [0, 0, 0, 0]);

  let attachedPortBytes: Uint8Array | undefined;
  const attachedPortClient = new WorkerIntegrityProviderClient({
    postMessage(value: unknown): void {
      attachedPortBytes = (value as { bytes?: Uint8Array }).bytes;
    },
  } as Pick<typeof channel.port1, "postMessage">, "attached-port-copy", "full");
  const attachedPending = attachedPortClient.fingerprint(
    "historical-key",
    new Uint8Array([1, 3, 5, 7]),
  );
  assert.deepEqual([...(attachedPortBytes ?? [])], [0, 0, 0, 0]);
  attachedPortClient.dispose(new Error("test complete"));
  await assert.rejects(attachedPending, /test complete/);

  channel.port1.close();
  channel.port2.close();

  const contextFixture = await projectContext();
  const provider = new DeterministicCapabilityKeyProvider();
  const child = new BrokerChild();
  let observedWorkerData: Record<string, unknown> | undefined;
  const backend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 15_000,
    appendRetryDeadlineMs: 10_000,
    keyProvider: provider,
    integrityWorkerFactory(_url, options) {
      observedWorkerData = options.workerData;
      return child;
    },
  });
  await backend.dispatch({
    id: "open-broker-owner",
    type: "open",
    binding: encodeWorkerBinding(contextFixture),
  });
  const full = backend.dispatch({
    id: "full-broker-owner",
    type: "fullIntegrity",
    binding: encodeWorkerBindingAssertion(contextFixture),
  });
  assert.deepEqual(Object.keys(observedWorkerData ?? {}).sort(), ["binding", "role"]);
  assert.equal(JSON.stringify(observedWorkerData).includes("evidence-fingerprint"), false);
  assert.equal(JSON.stringify(observedWorkerData).includes("historical-key"), false);

  child.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-broker-owner",
    providerRequestId: "provider-status",
    operation: "status",
    keyId: "test-evidence-fingerprint-key-v1",
  });
  await turn();
  assert.deepEqual(child.posted.at(-1), {
    type: "integrity-provider-response",
    integrityRequestId: "full-broker-owner",
    providerRequestId: "provider-status",
    operation: "status",
    ok: true,
    status: "available",
  });
  assert.deepEqual(provider.calls.at(-1), {
    operation: "status",
    projectId: contextFixture.binding.projectId,
    storeId: contextFixture.binding.storeId,
    purpose: "evidence-fingerprint",
    keyId: "test-evidence-fingerprint-key-v1",
    domain: null,
    byteLength: null,
  });

  const transferred = new Uint8Array([7, 6, 5, 4]);
  child.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-broker-owner",
    providerRequestId: "provider-fingerprint",
    operation: "fingerprint",
    keyId: "historical-key",
    bytes: transferred,
  });
  await turn();
  assert.equal(
    decodeIntegrityProviderResponseWire(child.posted.at(-1)).operation,
    "fingerprint",
  );
  assert.deepEqual(provider.calls.at(-1), {
    operation: "fingerprint",
    projectId: contextFixture.binding.projectId,
    storeId: contextFixture.binding.storeId,
    purpose: "evidence-fingerprint",
    keyId: "historical-key",
    domain: "pm-evidence-coverage-v1",
    byteLength: 4,
  });
  assert.deepEqual([...transferred], [0, 0, 0, 0]);
  assert.deepEqual([...provider.fingerprintInputs.at(-1)!], [0, 0, 0, 0]);

  child.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-broker-owner",
    providerRequestId: "provider-unavailable",
    operation: "status",
    keyId: "missing-key",
  });
  await turn();
  assert.deepEqual(child.posted.at(-1), {
    type: "integrity-provider-response",
    integrityRequestId: "full-broker-owner",
    providerRequestId: "provider-unavailable",
    operation: "status",
    ok: false,
    code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
  });

  const terminal = {
    ...emptyReport("full"),
    projectId: contextFixture.binding.projectId,
    storeId: contextFixture.binding.storeId,
  };
  child.emit("message", { id: "full-broker-owner", ok: true, data: terminal });
  child.emit("exit", 0);
  assert.deepEqual(await full, terminal);
  await backend.close();

  const legacyContext = await projectContext();
  const unusedProvider = new DeterministicCapabilityKeyProvider();
  const legacyBackend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 15_000,
    appendRetryDeadlineMs: 10_000,
    keyProvider: unusedProvider,
  });
  await legacyBackend.dispatch({
    id: "open-real-legacy",
    type: "open",
    binding: encodeWorkerBinding(legacyContext),
  });
  const legacyReport = await legacyBackend.dispatch({
    id: "full-real-legacy",
    type: "fullIntegrity",
    binding: encodeWorkerBindingAssertion(legacyContext),
  });
  assert.equal((legacyReport as { ok: boolean }).ok, true);
  assert.deepEqual(unusedProvider.calls, []);
  await legacyBackend.close();

  const providerFailures = [
    {
      name: "missing",
      provider: undefined,
      operation: "fingerprint" as const,
      code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
    },
    {
      name: "throwing",
      provider: new ThrowingFingerprintProvider(),
      operation: "fingerprint" as const,
      code: "INTEGRITY_FAILURE",
    },
    {
      name: "malformed",
      provider: new MalformedFingerprintProvider(),
      operation: "fingerprint" as const,
      code: "INTEGRITY_FAILURE",
    },
  ];
  for (const providerFailure of providerFailures) {
    const failureContext = await projectContext();
    const failureChild = new BrokerChild();
    const failureBackend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      ...(providerFailure.provider === undefined
        ? {}
        : { keyProvider: providerFailure.provider }),
      integrityWorkerFactory: () => failureChild,
    });
    await failureBackend.dispatch({
      id: `open-${providerFailure.name}`,
      type: "open",
      binding: encodeWorkerBinding(failureContext),
    });
    const failureIntegrity = failureBackend.dispatch({
      id: `full-${providerFailure.name}`,
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(failureContext),
    });
    const failureBytes = new Uint8Array([4, 3, 2, 1]);
    failureChild.emit("message", {
      type: "integrity-provider-request",
      integrityRequestId: `full-${providerFailure.name}`,
      providerRequestId: `provider-${providerFailure.name}`,
      operation: "fingerprint",
      keyId: "historical-key",
      bytes: failureBytes,
    });
    await turn();
    const failureResponse = failureChild.posted.at(-1);
    assert.deepEqual(failureResponse, {
      type: "integrity-provider-response",
      integrityRequestId: `full-${providerFailure.name}`,
      providerRequestId: `provider-${providerFailure.name}`,
      operation: providerFailure.operation,
      ok: false,
      code: providerFailure.code,
    });
    assert.equal(JSON.stringify(failureResponse).includes("provider-secret-canary"), false);
    assert.deepEqual([...failureBytes], [0, 0, 0, 0]);
    failureChild.emit("message", {
      id: `full-${providerFailure.name}`,
      ok: false,
      error: {
        code: providerFailure.code,
        message: providerFailure.code,
        details: {},
      },
    });
    await turn();
    failureChild.termination.resolve(1);
    await assert.rejects(
      failureIntegrity,
      (error: unknown) => error instanceof ProjectStoreWorkerBackendError
        && error.code === providerFailure.code
        && Object.keys(error.details).length === 0,
    );
    await failureBackend.close();
  }
});

test("integrity provider broker terminates malformed concurrent or out-of-order traffic", async (context) => {
  const channel = new MessageChannel();
  context.after(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const posted: unknown[] = [];
  channel.port2.on("message", (value: unknown) => posted.push(value));
  const client = new WorkerIntegrityProviderClient(channel.port1, "integrity-2", "full");
  const status = client.status("historical-key");
  await new Promise<void>((resolve) => channel.port2.once("message", () => resolve()));
  const request = decodeIntegrityProviderRequestWire(posted[0]);

  await assert.rejects(
    client.fingerprint("historical-key", new Uint8Array([1])),
    (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR",
  );
  assert.equal(posted.length, 1);
  assert.throws(() => client.accept({
    type: "integrity-provider-response",
    integrityRequestId: "wrong-integrity-id",
    providerRequestId: request.providerRequestId,
    operation: "status",
    ok: true,
    status: "available",
  }), (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR");
  await assert.rejects(
    status,
    (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR",
  );
  await assert.rejects(
    client.status("historical-key"),
    (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR",
  );

  const quickPosted: unknown[] = [];
  const quick = new WorkerIntegrityProviderClient({
    postMessage(value: unknown): void { quickPosted.push(value); },
  } as Pick<typeof channel.port1, "postMessage">, "integrity-quick", "quick");
  await assert.rejects(
    quick.fingerprint("historical-key", new Uint8Array([1])),
    (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR",
  );
  assert.deepEqual(quickPosted, []);
  const quickStatus = quick.status("historical-key");
  quick.dispose(new Error("child closed"));
  await assert.rejects(quickStatus, /child closed/);
  assert.throws(() => quick.accept({
    type: "integrity-provider-response",
    integrityRequestId: "integrity-quick",
    providerRequestId: "late",
    operation: "status",
    ok: true,
    status: "available",
  }), (error: unknown) => (error as { code?: unknown }).code === "WORKER_PROTOCOL_ERROR");

  channel.port1.close();
  channel.port2.close();

  const concurrentContext = await projectContext();
  const concurrentChild = new BrokerChild();
  const concurrentBackend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 15_000,
    appendRetryDeadlineMs: 10_000,
    keyProvider: new DeterministicCapabilityKeyProvider(),
    integrityWorkerFactory: () => concurrentChild,
  });
  await concurrentBackend.dispatch({
    id: "open-concurrent-provider",
    type: "open",
    binding: encodeWorkerBinding(concurrentContext),
  });
  const concurrentIntegrity = concurrentBackend.dispatch({
    id: "full-concurrent-provider",
    type: "fullIntegrity",
    binding: encodeWorkerBindingAssertion(concurrentContext),
  });
  concurrentChild.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-concurrent-provider",
    providerRequestId: "first",
    operation: "status",
    keyId: "test-evidence-fingerprint-key-v1",
  });
  concurrentChild.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-concurrent-provider",
    providerRequestId: "concurrent",
    operation: "status",
    keyId: "test-evidence-fingerprint-key-v1",
  });
  await turn();
  assert.equal(concurrentChild.terminateCalls, 1);
  let closeSettled = false;
  const concurrentClose = concurrentBackend.close().finally(() => { closeSettled = true; });
  await turn();
  assert.equal(closeSettled, false);
  concurrentChild.termination.resolve(1);
  await assert.rejects(
    concurrentIntegrity,
    (error: unknown) => error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_PROTOCOL_ERROR"
      && Object.keys(error.details).length === 0,
  );
  await concurrentClose;

  const outOfOrderContext = await projectContext();
  const outOfOrderChild = new BrokerChild();
  const outOfOrderBackend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 15_000,
    appendRetryDeadlineMs: 10_000,
    integrityWorkerFactory: () => outOfOrderChild,
  });
  await outOfOrderBackend.dispatch({
    id: "open-out-of-order-provider",
    type: "open",
    binding: encodeWorkerBinding(outOfOrderContext),
  });
  const outOfOrderIntegrity = outOfOrderBackend.dispatch({
    id: "full-out-of-order-provider",
    type: "fullIntegrity",
    binding: encodeWorkerBindingAssertion(outOfOrderContext),
  });
  const outOfOrderBytes = new Uint8Array([9, 7, 5, 3]);
  outOfOrderChild.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-out-of-order-provider",
    providerRequestId: "wrong-order",
    operation: "fingerprint",
    keyId: "historical-key",
    bytes: outOfOrderBytes,
    unexpected: true,
  });
  await turn();
  assert.equal(outOfOrderChild.terminateCalls, 1);
  assert.deepEqual([...outOfOrderBytes], [0, 0, 0, 0]);
  outOfOrderChild.termination.resolve(1);
  await assert.rejects(
    outOfOrderIntegrity,
    (error: unknown) => error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_PROTOCOL_ERROR",
  );
  await outOfOrderBackend.close();

  const replayObservations: Array<{
    readonly operation: "status" | "fingerprint";
    readonly terminationBeforeCleanup: number;
    readonly providerCallCount: number;
    readonly firstReplayBytes: Uint8Array;
    readonly secondReplayBytes: Uint8Array;
  }> = [];
  for (const operation of ["status", "fingerprint"] as const) {
    const replayContext = await projectContext();
    const replayChild = new BrokerChild();
    const replayProvider = new DeterministicCapabilityKeyProvider();
    const replayBackend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      keyProvider: replayProvider,
      integrityWorkerFactory: () => replayChild,
    });
    await replayBackend.dispatch({
      id: `open-${operation}-replay`,
      type: "open",
      binding: encodeWorkerBinding(replayContext),
    });
    const replayIntegrity = replayBackend.dispatch({
      id: `full-${operation}-replay`,
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(replayContext),
    });
    const firstReplayBytes = new Uint8Array([1, 2, 3]);
    const secondReplayBytes = new Uint8Array([4, 5, 6]);
    const providerMessage = (bytes: Uint8Array) => operation === "status"
      ? {
          type: "integrity-provider-request",
          integrityRequestId: `full-${operation}-replay`,
          providerRequestId: "sequential-replay-id",
          operation,
          keyId: "test-evidence-fingerprint-key-v1",
        }
      : {
          type: "integrity-provider-request",
          integrityRequestId: `full-${operation}-replay`,
          providerRequestId: "sequential-replay-id",
          operation,
          keyId: "historical-key",
          bytes,
        };
    replayChild.emit("message", providerMessage(firstReplayBytes));
    await turn();
    replayChild.emit("message", providerMessage(secondReplayBytes));
    await turn();
    const terminationBeforeCleanup = replayChild.terminateCalls;
    const providerCallCount = replayProvider.calls.filter(
      (call) => call.operation === operation,
    ).length;
    if (terminationBeforeCleanup === 0) {
      replayChild.emit("messageerror", new Error("test cleanup"));
      await turn();
    }
    replayChild.termination.resolve(1);
    await assert.rejects(
      replayIntegrity,
      (error: unknown) => error instanceof ProjectStoreWorkerBackendError
        && error.code === "WORKER_PROTOCOL_ERROR"
        && Object.keys(error.details).length === 0,
    );
    await replayBackend.close();

    replayObservations.push({
      operation,
      terminationBeforeCleanup,
      providerCallCount,
      firstReplayBytes,
      secondReplayBytes,
    });
  }

  for (const hostileCase of [
    {
      name: "detach",
      provider: new DetachingFingerprintProvider(),
      expectedFingerprintOk: false,
    },
    {
      name: "fill-tamper",
      provider: new FillTamperingFingerprintProvider(),
      expectedFingerprintOk: true,
    },
  ]) {
    const hostileContext = await projectContext();
    const hostileChild = new BrokerChild();
    const hostileBackend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      keyProvider: hostileCase.provider,
      integrityWorkerFactory: () => hostileChild,
    });
    await hostileBackend.dispatch({
      id: `open-hostile-${hostileCase.name}`,
      type: "open",
      binding: encodeWorkerBinding(hostileContext),
    });
    const hostileIntegrity = hostileBackend.dispatch({
      id: `full-hostile-${hostileCase.name}`,
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(hostileContext),
    });
    const unhandled: unknown[] = [];
    const captureUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", captureUnhandled);
    let outcome = "pending";
    try {
      hostileChild.emit("message", {
        type: "integrity-provider-request",
        integrityRequestId: `full-hostile-${hostileCase.name}`,
        providerRequestId: `fingerprint-${hostileCase.name}`,
        operation: "fingerprint",
        keyId: "historical-key",
        bytes: new Uint8Array([9, 8, 7, 6]),
      });
      await turn();
      await turn();
      const fingerprintResponse = hostileChild.posted.at(-1);

      hostileChild.emit("message", {
        type: "integrity-provider-request",
        integrityRequestId: `full-hostile-${hostileCase.name}`,
        providerRequestId: `status-after-${hostileCase.name}`,
        operation: "status",
        keyId: "test-evidence-fingerprint-key-v1",
      });
      await turn();
      await turn();
      const statusResponse = hostileChild.posted.at(-1);
      const terminationBeforeCleanup = hostileChild.terminateCalls;

      if (terminationBeforeCleanup === 0) {
        hostileChild.emit("message", {
          id: `full-hostile-${hostileCase.name}`,
          ok: true,
          data: {
            ...emptyReport("full"),
            projectId: hostileContext.binding.projectId,
            storeId: hostileContext.binding.storeId,
          },
        });
        hostileChild.emit("exit", 0);
        await hostileIntegrity;
        outcome = "resolved";
      } else {
        hostileChild.termination.resolve(1);
        outcome = await hostileIntegrity.then(
          () => "resolved",
          (error: unknown) => error instanceof ProjectStoreWorkerBackendError
            ? error.code
            : "unknown",
        );
      }
      await hostileBackend.close();
      await turn();

      assert.equal(terminationBeforeCleanup, 0, hostileCase.name);
      assert.equal(outcome, "resolved", hostileCase.name);
      assert.deepEqual(
        fingerprintResponse,
        hostileCase.expectedFingerprintOk
          ? {
              type: "integrity-provider-response",
              integrityRequestId: `full-hostile-${hostileCase.name}`,
              providerRequestId: `fingerprint-${hostileCase.name}`,
              operation: "fingerprint",
              ok: true,
              fingerprint: (fingerprintResponse as { fingerprint?: string }).fingerprint,
            }
          : {
              type: "integrity-provider-response",
              integrityRequestId: `full-hostile-${hostileCase.name}`,
              providerRequestId: `fingerprint-${hostileCase.name}`,
              operation: "fingerprint",
              ok: false,
              code: "INTEGRITY_FAILURE",
            },
      );
      if (hostileCase.expectedFingerprintOk) {
        assert.match(
          (fingerprintResponse as { fingerprint: string }).fingerprint,
          /^[0-9a-f]{64}$/,
        );
        assert.deepEqual(
          [...hostileCase.provider.fingerprintInputs.at(-1)!],
          [0, 0, 0, 0],
        );
      }
      assert.deepEqual(statusResponse, {
        type: "integrity-provider-response",
        integrityRequestId: `full-hostile-${hostileCase.name}`,
        providerRequestId: `status-after-${hostileCase.name}`,
        operation: "status",
        ok: true,
        status: "available",
      });
      assert.equal(
        JSON.stringify([fingerprintResponse, statusResponse]).includes("secret-canary"),
        false,
      );
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
      if (outcome === "pending") {
        if (hostileChild.terminateCalls === 0) {
          hostileChild.emit("messageerror", new Error("test cleanup"));
          await turn();
        }
        hostileChild.termination.resolve(1);
        await Promise.allSettled([hostileIntegrity, hostileBackend.close()]);
      }
    }
  }

  for (const observation of replayObservations) {
    assert.equal(
      observation.terminationBeforeCleanup,
      1,
      observation.operation,
    );
    assert.equal(observation.providerCallCount, 1, observation.operation);
    if (observation.operation === "fingerprint") {
      assert.deepEqual([...observation.firstReplayBytes], [0, 0, 0]);
      assert.deepEqual([...observation.secondReplayBytes], [0, 0, 0]);
    }
  }

  const prematureTerminalContext = await projectContext();
  const prematureTerminalChild = new BrokerChild();
  const prematureTerminalBackend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 15_000,
    appendRetryDeadlineMs: 10_000,
    keyProvider: new DeterministicCapabilityKeyProvider(),
    integrityWorkerFactory: () => prematureTerminalChild,
  });
  await prematureTerminalBackend.dispatch({
    id: "open-premature-terminal",
    type: "open",
    binding: encodeWorkerBinding(prematureTerminalContext),
  });
  const prematureTerminalIntegrity = prematureTerminalBackend.dispatch({
    id: "full-premature-terminal",
    type: "fullIntegrity",
    binding: encodeWorkerBindingAssertion(prematureTerminalContext),
  });
  prematureTerminalChild.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-premature-terminal",
    providerRequestId: "provider-pending",
    operation: "status",
    keyId: "test-evidence-fingerprint-key-v1",
  });
  prematureTerminalChild.emit("message", {
    id: "full-premature-terminal",
    ok: true,
    data: {
      ...emptyReport("full"),
      projectId: prematureTerminalContext.binding.projectId,
      storeId: prematureTerminalContext.binding.storeId,
    },
  });
  await turn();
  assert.equal(prematureTerminalChild.terminateCalls, 1);
  prematureTerminalChild.termination.resolve(1);
  await assert.rejects(
    prematureTerminalIntegrity,
    (error: unknown) => error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_PROTOCOL_ERROR",
  );
  await prematureTerminalBackend.close();

  const postTerminalContext = await projectContext();
  const postTerminalChild = new BrokerChild();
  const postTerminalProvider = new DeterministicCapabilityKeyProvider();
  const postTerminalBackend = new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 15_000,
    appendRetryDeadlineMs: 10_000,
    keyProvider: postTerminalProvider,
    integrityWorkerFactory: () => postTerminalChild,
  });
  await postTerminalBackend.dispatch({
    id: "open-post-terminal-provider",
    type: "open",
    binding: encodeWorkerBinding(postTerminalContext),
  });
  const postTerminalIntegrity = postTerminalBackend.dispatch({
    id: "full-post-terminal-provider",
    type: "fullIntegrity",
    binding: encodeWorkerBindingAssertion(postTerminalContext),
  });
  postTerminalChild.emit("message", {
    id: "full-post-terminal-provider",
    ok: true,
    data: {
      ...emptyReport("full"),
      projectId: postTerminalContext.binding.projectId,
      storeId: postTerminalContext.binding.storeId,
    },
  });
  postTerminalChild.emit("message", {
    type: "integrity-provider-request",
    integrityRequestId: "full-post-terminal-provider",
    providerRequestId: "after-terminal",
    operation: "status",
    keyId: "test-evidence-fingerprint-key-v1",
  });
  await turn();
  const postTerminalCalls = postTerminalProvider.calls.length;
  assert.equal(postTerminalChild.terminateCalls, 1);
  postTerminalChild.termination.resolve(1);
  await assert.rejects(
    postTerminalIntegrity,
    (error: unknown) => error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_PROTOCOL_ERROR"
      && Object.keys(error.details).length === 0,
  );
  assert.equal(postTerminalCalls, 0);
  await postTerminalBackend.close();
});
