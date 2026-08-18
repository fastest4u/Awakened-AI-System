import { createHash, randomUUID } from "node:crypto";
import {
  createTrustedValidationProfileRegistry,
  createValidationAttemptPlans,
  expandValidationAttemptPlan,
} from "../../src/orchestrator/lifecycle/validation-profile.registry.js";
import { ValidationProfileRunner } from "../../src/orchestrator/lifecycle/validation-profile.runner.js";
import type { SourceStateFingerprintV1 } from "../../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type {
  LifecycleDurableBoundary,
  LifecycleFaultContext,
  LifecycleFaultInjector,
  LifecycleFaultPoint,
} from "../../src/orchestrator/lifecycle/lifecycle-faults.js";

type RecordValue = Record<string, unknown>;

interface SelectedFault {
  readonly boundary: "validation-result";
  readonly point: "before-external-start" | "after-external-complete-before-result-commit";
}

const childId = randomUUID();
let started = false;
let closing = false;
let selectedFault: SelectedFault | null = null;

const ATTEMPT_CONTEXT = Object.freeze({
  projectId: "11111111-1111-4111-8111-111111111111",
  vaultId: "22222222-2222-4222-8222-222222222222",
  storeId: "33333333-3333-4333-8333-333333333333",
  workspaceId: "a".repeat(64),
  sessionId: "44444444-4444-4444-8444-444444444444",
  workflowId: "55555555-5555-4555-8555-555555555555",
  workflowGeneration: 1,
  plannedWorkId: "e".repeat(64),
  finalCheckpointId: "66666666-6666-4666-8666-666666666666",
  finalCheckpointFingerprint: "b".repeat(64),
});

const registry = createTrustedValidationProfileRegistry([{
  profileId: "task18-fixture",
  profileVersion: 1,
  executable: process.execPath,
  args: ["--version"],
  cwd: process.cwd(),
  env: {},
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
  runnerId: "99999999-9999-4999-8999-999999999999",
}]);

const attemptPlan = expandValidationAttemptPlan({
  plan: createValidationAttemptPlans({
    ...ATTEMPT_CONTEXT,
    profiles: [{ profileId: "task18-fixture", profileVersion: 1 }],
  }, registry)[0]!,
  context: ATTEMPT_CONTEXT,
  expectedProfileConfigurationHash: registry.resolve("task18-fixture", 1).configurationHash,
}, registry);

const SOURCE_STATE: SourceStateFingerprintV1 = Object.freeze({
  sourceStateScopeVersion: 1 as const,
  workspaceId: ATTEMPT_CONTEXT.workspaceId as SourceStateFingerprintV1["workspaceId"],
  branchRef: null,
  headCommit: null,
  dirtyWorktreeFingerprint: "d".repeat(64),
});

const faultInjector: LifecycleFaultInjector = Object.freeze({
  hit(boundary: LifecycleDurableBoundary, point: LifecycleFaultPoint): void {
    if (selectedFault === null || boundary !== selectedFault.boundary || point !== selectedFault.point) return;
    selectedFault = null;
    process.exit(137);
  },
});

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function text(value: RecordValue, key: string): string {
  const observed = value[key];
  if (typeof observed !== "string" || observed.length > 4_096) throw new Error("FIXTURE_PROTOCOL_ERROR");
  return observed;
}

function send(value: RecordValue): void {
  if (process.send === undefined) return;
  process.send(value);
}

function requestId(value: RecordValue): string | undefined {
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

function selectFault(payload: RecordValue): SelectedFault {
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !Object.hasOwn(payload, "boundary") || !Object.hasOwn(payload, "point")) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const boundary = text(payload, "boundary");
  const point = text(payload, "point");
  if (
    boundary !== "validation-result"
    || (point !== "before-external-start" && point !== "after-external-complete-before-result-commit")
  ) throw new Error("FIXTURE_PROTOCOL_ERROR");
  return Object.freeze({ boundary, point });
}

async function runValidation(payload: RecordValue): Promise<RecordValue> {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || !Object.hasOwn(payload, "output")) throw new Error("FIXTURE_PROTOCOL_ERROR");
  const rawOutput = text(payload, "output");
  const runner = new ValidationProfileRunner({
    registry,
    keyProvider: {
      currentKey: () => ({ keyId: "task18-validation-fingerprint-key" }),
      fingerprint: ({ bytes }: { readonly bytes: Uint8Array }) =>
        createHash("sha256").update(bytes).digest("hex"),
    },
    processRunner: {
      async run() {
        return {
          status: 0,
          stdout: Buffer.from(rawOutput, "utf8"),
          stderr: Buffer.alloc(0),
        };
      },
    },
    faultInjector,
  });
  const result = await runner.run({
    attemptPlan,
    sourceStateAtStart: SOURCE_STATE,
    sourceStateAtCompletion: SOURCE_STATE,
  });
  return Object.freeze({
    status: result.status,
    exitClassification: result.exitClassification,
    contentRetained: false,
    outputFingerprint: result.outputFingerprint,
    resultId: result.resultId,
  });
}

function error(message: RecordValue, code = "FIXTURE_PROTOCOL_ERROR"): void {
  send({ type: "error", requestId: requestId(message), code, message: code });
}

async function handle(value: unknown): Promise<void> {
  const message = record(value);
  const type = message.type;
  const id = requestId(message);
  if (type === "start" && !started && !closing) {
    started = true;
    send({ type: "started", requestId: id, childId });
    return;
  }
  if (type === "fault" && started && !closing) {
    try {
      const selected = selectFault(record(message.payload));
      selectedFault = selected;
      send({ type: "result", requestId: id, operation: "fault", value: { ...selected, armed: true } });
    } catch {
      error(message);
    }
    return;
  }
  if (type === "validation" && started && !closing) {
    try {
      send({ type: "result", requestId: id, operation: "validation", value: await runValidation(record(message.payload)) });
    } catch {
      error(message);
    }
    return;
  }
  if (type === "close") {
    closing = true;
    send({ type: "close", requestId: id, childId });
    process.disconnect?.();
    return;
  }
  error(message);
}

let queue = Promise.resolve();
process.on("message", (message: unknown) => {
  queue = queue.then(() => handle(message));
});
process.on("disconnect", () => {
  if (!closing) process.exitCode = 1;
});
send({ type: "ready", childId, pid: process.pid });
