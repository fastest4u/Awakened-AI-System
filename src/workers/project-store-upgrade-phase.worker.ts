import { parentPort, workerData } from "node:worker_threads";
import { StoreManifestRepository } from "../orchestrator/identity/store-manifest.repository.js";
import { runIntegrityChild } from "../orchestrator/runtime/project-store-worker-backend.js";
import {
  decodeIntegrityReport,
  decodeWorkerBinding,
  encodeWorkerBindingAssertion,
} from "../orchestrator/runtime/worker-protocol.js";

type PhaseConfig =
  | { phase: "full-integrity"; binding: unknown }
  | {
      phase: "manifest-prepare";
      binding: unknown;
      report: unknown;
      preparationId: string;
    };

function invalid(): never {
  throw new Error("WORKER_PROTOCOL_ERROR");
}

function config(value: unknown): PhaseConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    record.phase === "full-integrity"
    && keys.length === 2
    && keys[0] === "binding"
    && keys[1] === "phase"
  ) {
    return { phase: "full-integrity", binding: record.binding };
  }
  if (
    record.phase === "manifest-prepare"
    && keys.length === 4
    && keys[0] === "binding"
    && keys[1] === "phase"
    && keys[2] === "preparationId"
    && keys[3] === "report"
    && typeof record.preparationId === "string"
  ) {
    return {
      phase: "manifest-prepare",
      binding: record.binding,
      report: record.report,
      preparationId: record.preparationId,
    };
  }
  invalid();
}

function safeCode(error: unknown): string {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)
        ? error.message
        : "STORE_UNAVAILABLE";
    }
    const code = Reflect.get(error, "code");
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
      ? code
      : "STORE_UNAVAILABLE";
  } catch {
    return "STORE_UNAVAILABLE";
  }
}

if (parentPort === null) throw new Error("WORKER_PARENT_PORT_REQUIRED");
const parent = parentPort;

void (async () => {
  const phase = config(workerData);
  const context = decodeWorkerBinding(phase.binding);
  if (phase.phase === "full-integrity") {
    return runIntegrityChild(context, {
      id: "upgrade-postcommit-integrity",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(context),
    });
  }
  const report = decodeIntegrityReport(phase.report);
  return new StoreManifestRepository().prepareIntegrity(context.binding.storeRoute, {
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
  }, {
    ok: report.ok,
    schemaFingerprint: report.schemaFingerprint,
    terminalEventHash: report.terminalEventHash,
  }, phase.preparationId);
})().then((data) => {
  parent.postMessage({ ok: true, data });
}).catch((error: unknown) => {
  parent.postMessage({ ok: false, error: { code: safeCode(error) } });
}).finally(() => parent.close());
