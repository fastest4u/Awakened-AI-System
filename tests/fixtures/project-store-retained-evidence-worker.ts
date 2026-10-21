import { randomBytes, randomUUID } from "node:crypto";
import { isMainThread, parentPort, workerData, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { CapabilityKeyProvider } from "../../src/orchestrator/lifecycle/authority/capability-key-provider.js";
import type { EvidenceKeyProvider } from "../../src/orchestrator/privacy/evidence-key-provider.js";
import { RetainedEvidenceRuntimeFactory } from "../../src/orchestrator/privacy/retained-evidence-runtime.factory.js";
import type { TrustedRedactionPolicyV1 } from "../../src/orchestrator/privacy/redaction.js";
import { ProjectStoreWorkerBackend } from "../../src/orchestrator/runtime/project-store-worker-backend.js";
import { ProjectStoreWorkerRuntime } from "../../src/orchestrator/runtime/project-store-worker-runtime.js";
import { FRESH_NOW } from "../support/fresh-start-fixture.js";

// Synthetic, separately scoped providers live in the parent; this fixture transports operations, never keys.
if (!isMainThread) {
  const data = workerData as { port: MessagePort; policy: TrustedRedactionPolicyV1; buildHash: string; compose: boolean };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let sequence = 0;
  const rpc = (family: "capability" | "evidence", method: string, args: unknown[]): unknown => {
    const id = ++sequence, deadline = Date.now() + 15_000;
    data.port.postMessage({ id, family, method, args });
    while (Date.now() < deadline) {
      const response = receiveMessageOnPort(data.port)?.message as { id: number; ok: boolean; value: unknown } | undefined;
      if (response) {
        if (response.id !== id || !response.ok) throw new Error("synthetic provider refused");
        return response.value;
      }
      Atomics.wait(pause, 0, 0, 1);
    }
    throw new Error("synthetic provider deadline elapsed");
  };
  const capabilityProvider = Object.fromEntries(["currentKey", "status", "mac", "verify", "fingerprint", "seal", "open"].map(method =>
    [method, (...args: unknown[]) => rpc("capability", method, args)])) as unknown as CapabilityKeyProvider;
  const evidenceProvider = Object.fromEntries(["currentKey", "status", "wrap", "unwrap", "mac"].map(method =>
    [method, (...args: unknown[]) => rpc("evidence", method, args)])) as unknown as EvidenceKeyProvider;
  const policy = Object.freeze({ ...data.policy, rules: Object.freeze(data.policy.rules.map(rule => Object.freeze(rule))) });
  const backend = new ProjectStoreWorkerBackend({ selfUrl: new URL("../../src/workers/project-store.worker.js", import.meta.url),
    executorLeaseMs: 15_000, appendRetryDeadlineMs: 250, trustedFreshStartBuildInspector: () => data.buildHash,
    ...(data.compose ? { keyProvider: capabilityProvider, retainedEvidenceRuntimeFactory: new RetainedEvidenceRuntimeFactory({
      provider: evidenceProvider, policy: () => policy, clock: { now: () => FRESH_NOW, nowMs: () => BigInt(Date.parse(FRESH_NOW)) },
      nonceSource: { bytes: randomBytes, uuid: randomUUID } }) } : {}) });
  const runtime = new ProjectStoreWorkerRuntime({ backend, heartbeatIntervalMs: 5_000,
    scheduler: { setInterval: (callback, milliseconds) => setInterval(callback, milliseconds), clearInterval: handle => clearInterval(handle as NodeJS.Timeout) },
    port: { postMessage: value => parentPort!.postMessage(value), close: () => { data.port.close(); parentPort!.close(); } } });
  parentPort!.on("message", value => runtime.receive(value));
}
