import { Worker } from "node:worker_threads";

const MINIMUM_NODE_VERSION = "22.22.3";
const MINIMUM_SQLITE_VERSION = "3.51.3";
const REQUEST_TIMEOUT_MS = 10_000;
const WORKER_URL = new URL("../dist/workers/project-store.worker.js", import.meta.url);

function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} must be a stable numeric x.y.z version, received ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const observed = parseStableVersion(left, "observed version");
  const minimum = parseStableVersion(right, "minimum version");
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] !== minimum[index]) return Math.sign(observed[index] - minimum[index]);
  }
  return 0;
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exact(value, expectedKeys, label) {
  const observed = record(value, label);
  const actualKeys = Object.keys(observed).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length
    || actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has an invalid shape`);
  }
  return observed;
}

function assertJson(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error(`${label} must contain only JSON-safe values`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertJson(item, label, ancestors));
    ancestors.delete(value);
    return;
  }
  const object = record(value, label);
  Object.values(object).forEach((item) => assertJson(item, label, ancestors));
  ancestors.delete(value);
}

function decodeResponse(value, expectedId, decodeData) {
  const response = record(value, "worker response");
  const keys = response.ok === false ? ["id", "ok", "error"] : ["id", "ok", "data"];
  exact(response, keys, "worker response");
  if (response.id !== expectedId) throw new Error(`Unexpected worker response id ${String(response.id)}`);
  if (response.ok === false) {
    const failure = exact(response.error, ["code", "message", "details"], "worker failure");
    if (typeof failure.code !== "string" || typeof failure.message !== "string") {
      throw new Error("Worker failure code and message must be strings");
    }
    const details = record(failure.details, "worker failure details");
    assertJson(details, "worker failure details");
    throw new Error(`Worker request failed: ${failure.code}: ${failure.message}`);
  }
  if (response.ok !== true) throw new Error("Worker response ok must be a boolean");
  return decodeData(response.data);
}

function decodePing(value) {
  const ping = exact(value, ["nodeVersion", "sqliteVersion", "walSafe"], "ping response");
  if (typeof ping.nodeVersion !== "string" || typeof ping.sqliteVersion !== "string") {
    throw new Error("Ping response versions must be strings");
  }
  if (ping.walSafe !== true) throw new Error("Worker did not confirm a WAL-safe SQLite runtime");
  if (compareVersions(ping.nodeVersion, MINIMUM_NODE_VERSION) < 0) {
    throw new Error(`Worker Node ${ping.nodeVersion} is below ${MINIMUM_NODE_VERSION}`);
  }
  if (compareVersions(ping.sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
    throw new Error(`Worker SQLite ${ping.sqliteVersion} is below ${MINIMUM_SQLITE_VERSION}`);
  }
  return ping;
}

function decodeClose(value) {
  const closed = exact(value, ["closed"], "close response");
  if (closed.closed !== true) throw new Error("Worker did not acknowledge close");
  return closed;
}

async function main() {
  const worker = new Worker(WORKER_URL, {
    workerData: {
      role: "store",
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
      appendRetryDeadlineMs: 15_000,
    },
  });
  const pending = new Map();
  let exited = false;
  let lifecycleFailure;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function fail(error) {
    lifecycleFailure ??= error instanceof Error ? error : new Error(String(error));
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(lifecycleFailure);
      pending.delete(id);
    }
  }

  worker.on("message", (value) => {
    try {
      const envelope = record(value, "worker message");
      if (typeof envelope.id !== "string") throw new Error("Unexpected unsolicited worker message");
      const request = pending.get(envelope.id);
      if (!request) throw new Error(`Unexpected worker response id ${envelope.id}`);
      const result = decodeResponse(value, envelope.id, request.decodeData);
      clearTimeout(request.timer);
      pending.delete(envelope.id);
      request.resolve(result);
    } catch (error) {
      fail(error);
    }
  });
  worker.on("messageerror", () => fail(new Error("Worker emitted an unreadable message")));
  worker.on("error", (error) => fail(error));
  worker.on("exit", (code) => {
    exited = true;
    if (code !== 0) fail(new Error(`Worker exited abnormally with code ${code}`));
    if (pending.size > 0) fail(new Error("Worker exited before replying to every request"));
    resolveExit(code);
  });

  function request(id, type, decodeData) {
    if (lifecycleFailure) return Promise.reject(lifecycleFailure);
    if (exited) return Promise.reject(new Error("Worker has already exited"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker ${type} request timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { decodeData, reject, resolve, timer });
      try {
        worker.postMessage({ id, type });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function waitForExit() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker did not exit after close acknowledgement")),
        REQUEST_TIMEOUT_MS,
      );
      exitPromise.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  let ping;
  try {
    ping = await request("smoke-ping", "ping", decodePing);
    await request("smoke-close", "close", decodeClose);
    const exitCode = await waitForExit();
    if (lifecycleFailure) throw lifecycleFailure;
    if (exitCode !== 0) throw new Error(`Worker exited abnormally with code ${exitCode}`);
  } finally {
    if (!exited) await worker.terminate();
  }

  process.stdout.write(`Worker artifact OK: Node ${ping.nodeVersion}, SQLite ${ping.sqliteVersion}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
