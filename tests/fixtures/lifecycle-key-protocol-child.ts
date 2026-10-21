import { randomUUID } from "node:crypto";

type RecordValue = Record<string, unknown>;

const childId = randomUUID();
const pendingKeyResponses = new Map<string, (value: RecordValue) => void>();
let scope: { readonly projectId: string; readonly storeId: string } | undefined;
let started = false;
let closing = false;

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function string(value: RecordValue, key: string): string {
  const observed = value[key];
  if (typeof observed !== "string" || observed.length === 0) throw new Error("FIXTURE_PROTOCOL_ERROR");
  return observed;
}

function requestId(value: RecordValue): string | undefined {
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

function send(value: RecordValue): void {
  if (process.send === undefined) throw new Error("FIXTURE_IPC_UNAVAILABLE");
  process.send(value);
}

function error(value: RecordValue, code: string): void {
  send({ type: "error", requestId: requestId(value), code, message: code });
}

function keyRequest(payload: RecordValue, id = randomUUID()): Promise<RecordValue> {
  send({ type: "key-request", requestId: id, payload });
  return new Promise<RecordValue>((resolve) => pendingKeyResponses.set(id, resolve));
}

function keyResponseCode(response: RecordValue): string {
  if (response.ok === true) return "ok";
  if (response.ok === false && typeof response.code === "string") return response.code;
  throw new Error("FIXTURE_PROTOCOL_ERROR");
}

async function probe(value: RecordValue): Promise<RecordValue> {
  if (scope === undefined) throw new Error("FIXTURE_PROTOCOL_ERROR");
  const payload = record(value.payload);
  const operation = string(payload, "operation");
  const base = {
    operation: "currentKey",
    projectId: scope.projectId,
    storeId: scope.storeId,
    purpose: "root-session-handle",
  };
  switch (operation) {
    case "wrong-scope": {
      const response = await keyRequest({ ...base, projectId: `${scope.projectId}-wrong` });
      return { code: keyResponseCode(response) };
    }
    case "extra-field": {
      const response = await keyRequest({ ...base, canary: "TASK18_PROTOCOL_CANARY" });
      return { code: keyResponseCode(response) };
    }
    case "duplicate": {
      const id = randomUUID();
      const first = await keyRequest(base, id);
      const second = await keyRequest(base, id);
      return { first: keyResponseCode(first), second: keyResponseCode(second) };
    }
    case "forged-key-response":
      send({
        type: "key-response",
        requestId: randomUUID(),
        payload: { ok: true, result: { keyId: "forged" } },
      });
      return { accepted: false };
    default:
      throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
}

async function handle(value: unknown): Promise<void> {
  const message = record(value);
  if (message.type === "key-response") {
    const id = requestId(message);
    if (id === undefined) return;
    const resolve = pendingKeyResponses.get(id);
    if (resolve === undefined) return;
    pendingKeyResponses.delete(id);
    resolve(record(message.payload));
    return;
  }
  if (message.type === "start" && !started && !closing) {
    const payload = record(message.payload);
    scope = Object.freeze({ projectId: string(payload, "projectId"), storeId: string(payload, "storeId") });
    started = true;
    send({
      type: "started",
      requestId: requestId(message),
      childId,
      payload: {
        projectId: typeof payload.announcedProjectId === "string"
          ? payload.announcedProjectId
          : scope.projectId,
        storeId: scope.storeId,
      },
    });
    return;
  }
  if (message.type === "mutation" && started && !closing) {
    try {
      send({ type: "result", requestId: requestId(message), operation: "mutation", value: await probe(message) });
    } catch (failure) {
      error(message, failure instanceof Error ? failure.message : "FIXTURE_PROTOCOL_ERROR");
    }
    return;
  }
  if (message.type === "close") {
    closing = true;
    send({ type: "close", requestId: requestId(message), childId });
    process.disconnect?.();
    return;
  }
  error(message, "FIXTURE_PROTOCOL_ERROR");
}

let queue = Promise.resolve();
process.on("message", (message: unknown) => {
  if (record(message).type === "key-response") {
    void handle(message);
    return;
  }
  queue = queue.then(() => handle(message));
});
process.on("disconnect", () => {
  if (!closing) process.exitCode = 1;
});

send({ type: "ready", childId, pid: process.pid });
