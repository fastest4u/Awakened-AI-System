import { randomUUID } from "node:crypto";
import { AtomicArtifactReplacer } from "../../src/orchestrator/materialization/atomic-artifact-replacer.js";
import type {
  LifecycleDurableBoundary,
  LifecycleFaultContext,
  LifecycleFaultInjector,
  LifecycleFaultPoint,
} from "../../src/orchestrator/lifecycle/lifecycle-faults.js";

type RecordValue = Record<string, unknown>;
type AtomicBoundary = "temporary-file-write" | "artifact-replace";

interface SelectedFault {
  readonly boundary: AtomicBoundary;
  readonly point: LifecycleFaultPoint;
}

const childId = randomUUID();
let started = false;
let closing = false;
let selectedFault: SelectedFault | null = null;

const ATOMIC_POINTS = Object.freeze({
  "temporary-file-write": new Set<LifecycleFaultPoint>([
    "before-temp-write",
    "after-temp-fsync-before-replace",
  ]),
  "artifact-replace": new Set<LifecycleFaultPoint>(["after-replace-before-ack"]),
});

const FAULT_CONTEXT: LifecycleFaultContext = Object.freeze({
  projectId: "00000000-0000-4000-8000-000000000201" as never,
  sessionId: null,
  workflowId: null,
  commandId: null,
  idempotencyKeyHash: null,
  workId: "task18-atomic-artifact",
  eventPosition: null,
  materializationRevision: "1",
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
  if (typeof observed !== "string" || observed.length === 0 || observed.length > 4_096) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  return observed;
}

function exactFields(value: RecordValue, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
}

function send(value: RecordValue): void {
  if (process.send === undefined) return;
  process.send(value);
}

function requestId(value: RecordValue): string | undefined {
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

function selectFault(payload: RecordValue): SelectedFault {
  exactFields(payload, ["boundary", "point"]);
  const boundary = text(payload, "boundary") as AtomicBoundary;
  const point = text(payload, "point") as LifecycleFaultPoint;
  if (!(boundary in ATOMIC_POINTS) || !ATOMIC_POINTS[boundary].has(point)) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  return Object.freeze({ boundary, point });
}

function replaceArtifact(payload: RecordValue): RecordValue {
  exactFields(payload, ["operation", "durableBase", "targetPath", "tempPath", "content"]);
  if (payload.operation !== "atomic-replace") throw new Error("FIXTURE_PROTOCOL_ERROR");
  const durableBase = text(payload, "durableBase");
  const targetPath = text(payload, "targetPath");
  const tempPath = text(payload, "tempPath");
  const content = text(payload, "content");
  const bytes = Buffer.from(content, "utf8");
  try {
    const replacer = new AtomicArtifactReplacer({ durableBase, faultInjector });
    replacer.cleanup({ targetPath, tempPath });
    replacer.replace({ targetPath, tempPath, bytes, faultContext: FAULT_CONTEXT });
    return Object.freeze({ operation: "atomic-replace", replaced: true });
  } finally {
    bytes.fill(0);
  }
}

function error(value: RecordValue, code: string): void {
  send({ type: "error", requestId: requestId(value), code, message: code });
}

async function handle(value: unknown): Promise<void> {
  const message = record(value);
  const type = message.type;
  const id = requestId(message);
  if (type === "start" && !started && !closing) {
    if (Object.keys(record(message.payload)).length !== 0) return error(message, "FIXTURE_PROTOCOL_ERROR");
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
      error(message, "FIXTURE_PROTOCOL_ERROR");
    }
    return;
  }
  if (type === "mutation" && started && !closing) {
    try {
      send({ type: "result", requestId: id, operation: "mutation", value: replaceArtifact(record(message.payload)) });
    } catch {
      error(message, "FIXTURE_PROTOCOL_ERROR");
    }
    return;
  }
  if (type === "close") {
    closing = true;
    send({ type: "close", requestId: id, childId });
    process.disconnect?.();
    return;
  }
  error(message, "FIXTURE_PROTOCOL_ERROR");
}

let queue = Promise.resolve();
process.on("message", (message: unknown) => {
  queue = queue.then(() => handle(message));
});
process.on("disconnect", () => {
  if (!closing) process.exitCode = 1;
});
send({ type: "ready", childId, pid: process.pid });
