import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { encodePreparedRetainedEvidenceCommand, decodePreparedRetainedEvidenceCommand, decodeRetainedEvidenceWorkerResponse, assertRetainedEvidenceWireSize } from "../src/orchestrator/privacy/retained-evidence-worker-protocol.js";
import { RetainedEvidenceRuntimeFactory, type RetainedEvidenceRuntimeFactoryPort } from "../src/orchestrator/privacy/retained-evidence-runtime.factory.js";
import { ProjectStoreExecutor, type WorkerLike } from "../src/orchestrator/runtime/project-store-executor.js";
import { ProjectStoreWorkerBackend } from "../src/orchestrator/runtime/project-store-worker-backend.js";
import { encodeWorkerBinding, encodeWorkerBindingAssertion, encodeFreshStartContextWire, encodeAppendResultWire, decodeWorkerRequest } from "../src/orchestrator/runtime/worker-protocol.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { bindFreshStartAdmissionContext } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { makeRetainedEvidenceFixture, type RetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { FRESH_NOW, FRESH_IDENTITY } from "./support/fresh-start-fixture.js";
import type { RetainedEvidenceFaultInjector } from "../src/orchestrator/privacy/retained-evidence.service.js";
import { classifyCoverageOnlyVerificationTerminalActionV1, deriveEffectiveQualityPolicyV1 } from "../src/orchestrator/lifecycle/session-end-policy.js";
import { openEvidenceItem } from "../src/orchestrator/privacy/evidence-envelope.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import { context as storeContext } from "./fixtures/fresh-start-admission-child.js";

const WORKER_URL = new URL("./fixtures/project-store-retained-evidence-worker.js", import.meta.url);
function factory(f: RetainedEvidenceFixture, faults?: RetainedEvidenceFaultInjector) {
  return new RetainedEvidenceRuntimeFactory({ provider: f.provider, policy: () => f.policy,
    clock: { now: () => FRESH_NOW, nowMs: () => BigInt(Date.parse(FRESH_NOW)) }, nonceSource: { bytes: randomBytes, uuid: randomUUID },
    ...(faults === undefined ? {} : { faults }) });
}
function prepared(f: RetainedEvidenceFixture, value: unknown) {
  const invocation = f.invocation(value);
  try {
    if (invocation.authorization.kind !== "protected") throw new Error("fixture requires protected proof");
    return { command: invocation.input.command, authorization: invocation.authorization };
  }
  finally { invocation.input.canonicalOriginalBytes.fill(0); }
}
async function openedBackend(f: RetainedEvidenceFixture, runtimeFactory?: RetainedEvidenceRuntimeFactoryPort, deadlineMs = 250) {
  const backend = new ProjectStoreWorkerBackend({ selfUrl: new URL("../src/workers/project-store.worker.js", import.meta.url), executorLeaseMs: 15_000,
    appendRetryDeadlineMs: deadlineMs, trustedFreshStartBuildInspector: () => f.admission.trusted.measuredBuildHash,
    keyProvider: f.lifecycle.broker, ...(runtimeFactory === undefined ? {} : { retainedEvidenceRuntimeFactory: runtimeFactory }) });
  await backend.dispatch({ id: "open", type: "open", binding: encodeWorkerBinding(f.projectContext), freshStart: encodeFreshStartContextWire(f.admission.trusted) });
  return backend;
}
function request(f: RetainedEvidenceFixture, value: unknown) {
  return decodeWorkerRequest({ id: randomUUID(), type: "retained-evidence", binding: encodeWorkerBindingAssertion(f.projectContext),
    prepared: encodePreparedRetainedEvidenceCommand(prepared(f, value)) });
}
async function nativeExecutor(f: RetainedEvidenceFixture, compose = true, options: { loseAcknowledgement?: boolean; observeReply?: (value: unknown) => void; output?: (stream: "stdout" | "stderr", bytes: Buffer) => void } = {}) {
  const channel = new MessageChannel();
  const worker = new Worker(WORKER_URL, { workerData: { port: channel.port2, policy: f.policy,
    buildHash: f.admission.trusted.measuredBuildHash, compose }, transferList: [channel.port2], stdout: true, stderr: true });
  worker.stdout.on("data", bytes => { options.output?.("stdout", Buffer.from(bytes)); });
  worker.stderr.on("data", bytes => { options.output?.("stderr", Buffer.from(bytes)); });
  const exits: number[] = [];
  const exited = new Promise<number>(resolve => worker.on("exit", code => { exits.push(code); channel.port1.close(); resolve(code); }));
  let sequence = 0;
  channel.port1.on("message", (message: { id: number; family: "evidence" | "capability"; method: string; args: unknown[] }) => {
    let value: unknown;
    try {
      assert.equal(message.id, ++sequence);
      const scope = message.args[0] as { projectId: string; storeId: string };
      assert.equal(scope.projectId, FRESH_IDENTITY.projectId); assert.equal(scope.storeId, FRESH_IDENTITY.storeId);
      const methods = message.family === "evidence" ? ["currentKey", "status", "wrap", "unwrap", "mac"] : ["currentKey", "status", "mac", "verify", "fingerprint", "seal", "open"];
      assert.ok(["evidence", "capability"].includes(message.family) && methods.includes(message.method));
      const target = message.family === "evidence" ? f.provider : f.lifecycle.broker;
      value = Reflect.apply(Reflect.get(target, message.method) as (...args: unknown[]) => unknown, target, message.args);
      channel.port1.postMessage({ id: message.id, ok: true, value });
    } catch { channel.port1.postMessage({ id: message.id, ok: false }); }
    finally {
      for (const arg of message.args) {
        if (arg instanceof Uint8Array) arg.fill(0);
        else if (arg && typeof arg === "object" && "bytes" in arg && arg.bytes instanceof Uint8Array) arg.bytes.fill(0);
      }
      if (value instanceof Uint8Array) value.fill(0);
    }
  });
  let retainedId: string | undefined;
  const proxy: WorkerLike = {
    postMessage(value) { if ((value as any)?.type === "retained-evidence") retainedId = (value as any).id; worker.postMessage(value); },
    terminate: () => worker.terminate(),
    on(event: any, listener: any) {
      if (event === "message") worker.on("message", value => {
        if (value.id === retainedId) {
          options.observeReply?.(value);
          if (options.loseAcknowledgement && value.ok === true) { void worker.terminate(); return; }
        }
        listener(value);
      });
      else worker.on(event, listener);
      return this;
    },
  };
  const executor = new ProjectStoreExecutor({ workerUrl: WORKER_URL, context: f.projectContext, freshStart: f.admission.trusted,
    maxPending: 128, requestTimeoutMs: 15_000, closeTimeoutMs: 5_000, executorLeaseMs: 15_000, heartbeatIntervalMs: 5_000 },
    { workerFactory: () => proxy });
  try { await executor.open(); } catch (error) { await executor.close(); await exited; throw error; }
  return { executor, exits, async close() { await executor.close(); await exited; assert.equal(exits.length, 1); } };
}

function command(sessionId: string) {
  return { version: 1 as const, commandType: "retain-evidence-batch" as const, commandId: randomUUID(), idempotencyKey: randomUUID(),
    targetSessionId: sessionId, conversationId: randomUUID(), frames: [{ frameId: randomUUID(), ordinal: "0", role: "user" as const,
      category: "user-message" as const, occurredAt: "2026-10-03T00:00:00.000Z", mediaType: "text/plain; charset=utf-8" as const,
      content: "synthetic visible frame", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }] };
}
test("private wire preserves original command and separately protected proof", async () => {
  const fixture = await makeRetainedEvidenceFixture();
  try {
    const original = command(fixture.rootAuthority.sessionId), invocation = fixture.invocation(original);
    try {
      const wire = encodePreparedRetainedEvidenceCommand({ command: invocation.input.command, authorization: invocation.authorization });
      assert.equal(typeof wire.command, "string");
      const decoded = decodePreparedRetainedEvidenceCommand(wire);
      assert.equal(decoded.command.commandId, original.commandId);
      assert.deepEqual(decoded.authorization, invocation.authorization);
    } finally { invocation.input.canonicalOriginalBytes.fill(0); }
  } finally { await fixture.cleanup(); }
});

// Catches acknowledgement loss being mistaken for rollback or replaced on restart.
test("compiled private composition retains and reopens synthetic batch", async t => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const original = command(f.rootAuthority.sessionId); let observed: any;
    const first = await nativeExecutor(f, true, { loseAcknowledgement: true, observeReply: value => { observed = value; } });
    try { await assert.rejects(first.executor.retainEvidence(prepared(f, original)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: original.commandId, idempotencyKey: original.idempotencyKey } }); }
    finally { await first.close(); }
    assert.ok(observed?.ok === true, "successful native commit reply was not observed");
    const accepted = observed.data, rows = f.rows();
    for (const purpose of ["data-key-wrap", "original-input-commitment", "redacted-content-fingerprint"] as const) f.provider.rotate(purpose);
    f.reopen(); const second = await nativeExecutor(f);
    try {
      const reopened = await second.executor.retainEvidence(prepared(f, original));
      assert.deepEqual(reopened.response, accepted.response); assert.deepEqual(reopened.eventIds, accepted.eventIds);
      assert.equal(reopened.deduplicated, true); assert.deepEqual(f.rows(), rows);
    } finally { await second.close(); }
    const policy = deriveEffectiveQualityPolicyV1({ trustedProfiles: [{ profileId: "retained-acceptance", profileVersion: 1, required: true, weight: 1 }], optionalProfiles: [], requestedProfileIds: [],
      requestedQualityThreshold: 0, trustedMinimumQualityThreshold: 0, trustedRequireFullEvidence: true,
      requestedRequireFullEvidence: false, trustedRequireMaterialization: false, requestedRequireMaterialization: false });
    assert.equal(policy.requireFullEvidence, true);
    assert.throws(() => classifyCoverageOnlyVerificationTerminalActionV1(policy, { action: "record-verification-passed" }), { code: "EVIDENCE_CAPTURE_INCOMPLETE" });
    t.diagnostic(JSON.stringify({ scope: "synthetic-native-retained-reopen", workerExits: [...first.exits, ...second.exits], strictPolicyRefused: true }));
  } finally { await f.cleanup(); }
});

test("fixed retained runner rejects unknown groups before compiler or build", async () => {
  const url = new URL("../../scripts/run-v2-retained-evidence.js", import.meta.url);
  let module: any;
  try { module = await import(url.href); } catch (error) { if ((error as any).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof module?.runRetainedEvidenceGate, "function", "fixed retained acceptance runner is absent");
  assert.equal(await module.runRetainedEvidenceGate({ group: "unknown" }), 1);
  const result = spawnSync(process.execPath, [fileURLToPath(url), "--group", "unknown"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /RETAINED_EVIDENCE_ARGUMENTS_INVALID/);
});

const nestedSpecSummary = ["✔ nested fixture (1ms)", "ℹ tests 1", "ℹ suites 0", "ℹ pass 1", "ℹ fail 0",
  "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 2", ""].join("\n");
const outerSpecSummary = ["✔ outer fixture (3ms)", "ℹ tests 7", "ℹ suites 2", "ℹ pass 4", "ℹ fail 0",
  "ℹ cancelled 0", "ℹ skipped 2", "ℹ todo 1", "ℹ duration_ms 12.25", ""].join("\n");

test("fixed retained runner selects the final outer spec summary after forwarded nested summaries", async () => {
  const { parseFinalSpecCounts } = await import(new URL("../../scripts/run-v2-retained-evidence.js", import.meta.url).href);
  const output = nestedSpecSummary + nestedSpecSummary + outerSpecSummary;
  for (const stdout of [output, output.replaceAll("\n", "\r\n")]) {
    assert.deepEqual(parseFinalSpecCounts(stdout), { tests: 7, suites: 2, pass: 4, fail: 0, cancelled: 0, skipped: 2, todo: 1 });
  }
});

test("fixed retained runner never falls back to a nested summary when the final footer is incomplete", async () => {
  const { parseFinalSpecCounts } = await import(new URL("../../scripts/run-v2-retained-evidence.js", import.meta.url).href);
  const cases = [
    ["missing", "✔ outer fixture (3ms)\n"],
    ["partial", "✔ outer fixture (3ms)\nℹ tests 7\nℹ suites 2\n"],
    ["truncated terminator", outerSpecSummary.slice(0, -1)],
    ["missing duration", outerSpecSummary.replace("ℹ duration_ms 12.25\n", "")],
    ["malformed count", outerSpecSummary.replace("ℹ tests 7", "ℹ tests unknown")],
    ["reordered fields", outerSpecSummary.replace("ℹ suites 2\nℹ pass 4", "ℹ pass 4\nℹ suites 2")],
    ["duplicate field", outerSpecSummary.replace("ℹ pass 4", "ℹ pass 4\nℹ pass 4")],
    ["duplicate opener", outerSpecSummary.replace("ℹ tests 7", "ℹ tests 7\nℹ tests 7")],
    ["adjacent conflicting footers", nestedSpecSummary + outerSpecSummary.replace("✔ outer fixture (3ms)\n", "")],
    ["trailing fragment", outerSpecSummary + "ℹ tests"],
    ["trailing result", outerSpecSummary + "✔ unfinished outer fixture (4ms)\n"]
  ];
  for (const [name, footer] of cases) assert.deepEqual(parseFinalSpecCounts(nestedSpecSummary + footer), {}, name);
});

test("fixed retained runner refuses unsafe or contradictory spec counts", async () => {
  const { parseFinalSpecCounts } = await import(new URL("../../scripts/run-v2-retained-evidence.js", import.meta.url).href);
  const cases = [
    ["wrong disposition total", outerSpecSummary.replace("ℹ tests 7", "ℹ tests 8")],
    ["unsafe tests", outerSpecSummary.replace("ℹ tests 7", "ℹ tests 9007199254740992")],
    ["unsafe suites", outerSpecSummary.replace("ℹ suites 2", "ℹ suites 9007199254740992")],
    ["negative count", outerSpecSummary.replace("ℹ cancelled 0", "ℹ cancelled -1")],
    ["fractional count", outerSpecSummary.replace("ℹ skipped 2", "ℹ skipped 2.5")],
    ["noncanonical count", outerSpecSummary.replace("ℹ pass 4", "ℹ pass 04")],
    ["nonfinite duration", outerSpecSummary.replace("ℹ duration_ms 12.25", "ℹ duration_ms Infinity")],
    ["contradictory failure appendix", outerSpecSummary + "\n✖ failing tests:\n\ntest at fixture.js:1:1\n✖ failed fixture\n"]
  ];
  for (const [name, stdout] of cases) assert.deepEqual(parseFinalSpecCounts(stdout), {}, name);
});

test("fixed retained runner keeps coherent failure counts without merging a later summary fragment", async () => {
  const { parseFinalSpecCounts } = await import(new URL("../../scripts/run-v2-retained-evidence.js", import.meta.url).href);
  const failed = ["✖ outer fixture (3ms)", "ℹ tests 4", "ℹ suites 1", "ℹ pass 1", "ℹ fail 1", "ℹ cancelled 1",
    "ℹ skipped 1", "ℹ todo 0", "ℹ duration_ms 8.5", "", "✖ failing tests:", "", "test at fixture.js:1:1",
    "✖ failed fixture", "  Error: fixture failure", ""].join("\n");
  assert.deepEqual(parseFinalSpecCounts(nestedSpecSummary + failed), { tests: 4, suites: 1, pass: 1, fail: 1, cancelled: 1, skipped: 1, todo: 0 });
  assert.deepEqual(parseFinalSpecCounts(nestedSpecSummary + failed + "ℹ tests 8\n"), {});
});

const encodeObserved = (value: unknown) => Buffer.from(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item));
function scanSurfaces(surfaces: readonly Buffer[], needles: readonly Buffer[], sources: readonly unknown[] = surfaces): boolean {
  assert.equal(sources.length, surfaces.length, "every observation requires its actual source identity");
  const streams = new Map<unknown, Buffer[]>();
  surfaces.forEach((bytes, index) => {
    const chunks = streams.get(sources[index]);
    if (chunks) chunks.push(bytes); else streams.set(sources[index], [bytes]);
  });
  for (const chunks of streams.values()) {
    // Only successive observations of this same source are reassembled. A row,
    // file snapshot or reply has its own identity, never a fabricated mixed stream.
    const joined = Buffer.concat(chunks);
    try { if (needles.some(needle => joined.includes(needle))) return false; }
    finally { joined.fill(0); }
  }
  return true;
}
function dataKeyNeedles(key: Buffer): Buffer[] {
  const typed = new Uint8Array(key);
  try { return [Buffer.from(key), Buffer.from(key.toString("hex")), Buffer.from(key.toString("base64")), Buffer.from(key.toString("base64url")),
    encodeObserved([...key]), encodeObserved(typed)]; }
  finally { typed.fill(0); }
}

test("secrecy scanner detects split originals and key encodings within interleaved streams", () => {
  const original = Buffer.from(`private-${randomUUID()}`), key = randomBytes(32), needles = [original, ...dataKeyNeedles(key)];
  const encodedKey = Buffer.from(key.toString("base64url"));
  const surfaces = [Buffer.from(original.subarray(0, 9)), Buffer.from("unrelated"), Buffer.from(original.subarray(9)),
    Buffer.from(encodedKey.subarray(0, 7)), Buffer.from("another-stream"), Buffer.from(encodedKey.subarray(7))];
  try {
    assert.equal(scanSurfaces(surfaces.slice(0, 3), needles, ["stdout-A", "stderr-B", "stdout-A"]), false, "split original escaped its actual stream");
    assert.equal(scanSurfaces(surfaces.slice(3), needles, ["stderr-C", "stdout-D", "stderr-C"]), false, "split encoded key escaped its actual stream");
    assert.equal(scanSurfaces([surfaces[0]!, surfaces[2]!], needles, ["separate-A", "separate-B"]), true, "unrelated streams must not be joined");
  } finally { for (const bytes of [original, key, encodedKey, ...needles, ...surfaces]) bytes.fill(0); }
});

test("secrecy scanner detects actual Uint8Array JSON directly and nested", () => {
  const key = randomBytes(32), needles = dataKeyNeedles(key), bytes = new Uint8Array(key);
  const direct = encodeObserved(bytes), nested = encodeObserved({ envelope: { data: bytes } });
  try {
    assert.equal(scanSurfaces([direct], needles), false, "typed-array object serialization escaped scanning");
    assert.equal(scanSurfaces([nested], needles), false, "nested typed-array object serialization escaped scanning");
  } finally { for (const value of [key, bytes, direct, nested, ...needles]) value.fill(0); }
});
function durableSurfaces(f: RetainedEvidenceFixture) {
  const tables = f.connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const rows = tables.map(row => encodeObserved(f.connection.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()));
  const files: Buffer[] = [], names: string[] = [];
  function visit(root: string) {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false, "unexpected link in owned storage");
      const path = join(root, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) { files.push(readFileSync(path)); names.push(item.name); }
      else assert.fail("unexpected owned storage entry");
    }
  }
  visit(f.root);
  assert.ok(tables.some(row => row.name === "outbox"));
  assert.ok(names.includes("events.sqlite") && names.includes("events.sqlite-wal"), "live database and WAL must be scanned before close");
  return { buffers: [...rows, ...files], tables: tables.length, files: files.length };
}

// Catches plaintext durable writes, error interpolation, losing ciphertext/key leaks,
// and provider exceptions escaping the real private/native boundaries.
test("synthetic originals absent from durable and output surfaces", async t => {
  const f = await makeRetainedEvidenceFixture(), surfaces: Buffer[] = [], dataKeys: Buffer[] = [];
  const sources: unknown[] = [];
  const observe = (bytes: Buffer, source: unknown = Symbol()) => { surfaces.push(bytes); sources.push(source); };
  const secret = `fixture_${randomBytes(20).toString("hex")}`, original = `visible-${randomUUID()} ${secret}`;
  const needles: Buffer[] = [Buffer.from(secret), Buffer.from(original)];
  const wrap = f.provider.wrap.bind(f.provider), unwrap = f.provider.unwrap.bind(f.provider);
  let wrapped = 0, unwrapped = 0, providerFailure = false, snapshots = 0, tableCount = 0, fileCount = 0;
  f.provider.wrap = (...args) => { dataKeys.push(Buffer.from(args[2])); wrapped++; if (providerFailure) throw new Error(secret); return wrap(...args); };
  f.provider.unwrap = (...args) => { const value = unwrap(...args); dataKeys.push(Buffer.from(value)); unwrapped++; return value; };
  const value = () => { const result = command(f.rootAuthority.sessionId); result.frames[0]!.content = original; return result; };
  const snapshot = () => { const durable = durableSurfaces(f); durable.buffers.forEach(bytes => observe(bytes)); snapshots++; tableCount = durable.tables; fileCount += durable.files; };
  const observeError = (error: unknown) => { const value = error as any; observe(encodeObserved({ name: value.name, message: value.message, code: value.code, details: value.details, stack: value.stack })); return true; };
  const stdout = process.stdout.write, stderr = process.stderr.write;
  // Preserve node:test's private transport; observation must not swallow its records.
  process.stdout.write = function (this: typeof process.stdout, chunk: any, ...args: any[]) {
    observe(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)), "parent-stdout");
    return Reflect.apply(stdout, this, [chunk, ...args]);
  } as typeof stdout;
  process.stderr.write = function (this: typeof process.stderr, chunk: any, ...args: any[]) {
    observe(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)), "parent-stderr");
    return Reflect.apply(stderr, this, [chunk, ...args]);
  } as typeof stderr;
  try {
    const native = await nativeExecutor(f, true, { output: (stream, bytes) => observe(bytes, `successful-native-${stream}`), observeReply: reply => observe(encodeObserved(reply)) });
    try { observe(encodeObserved(await native.executor.retainEvidence(prepared(f, value())))); }
    finally { await native.close(); }
    snapshot();
    const item = JSON.parse(String(f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json));
    const redacted = openEvidenceItem(item.binding, item, f.provider);
    assert.ok(!String(redacted.content).includes(secret), "authenticated content still contains synthetic credential");
    // A native provider failure still uses the parent provider's actual wrap boundary.
    providerFailure = true;
    const failed = await nativeExecutor(f, true, { output: (stream, bytes) => observe(bytes, `failed-native-${stream}`), observeReply: reply => observe(encodeObserved(reply)) });
    try { await assert.rejects(failed.executor.retainEvidence(prepared(f, value())), observeError); }
    finally { await failed.close(); providerFailure = false; }
    snapshot();
    let armed = false;
    const baseFactory = factory(f, { hit(boundary) { if (boundary === "before-begin") armed = true; } });
    const backend = await openedBackend(f, { create(input) {
      const exec = input.connection.exec.bind(input.connection);
      input.connection.exec = sql => { if (armed && sql === "COMMIT") throw new Error(secret); return exec(sql); };
      return baseFactory.create(input);
    } });
    try { await assert.rejects(backend.dispatch(request(f, value())), observeError); }
    finally { await backend.close(); }
    snapshot();
    const raced = value(), a = f.prepareWorker(raced); await a.reached;
    const b = f.prepareWorker(raced); await b.reached;
    a.release(); const accepted = await a.result; b.release(); const replay = await b.result;
    assert.ok(accepted.ok && replay.ok, "native race did not complete");
    if (accepted.ok && replay.ok) assert.deepEqual(accepted.value.response, replay.value.response);
    observe(encodeObserved(accepted)); observe(encodeObserved(replay)); snapshot();
    assert.deepEqual(f.workerExits, [0, 0]);
    // Scan actual generated human report bytes as well as actual native/process output.
    const report = join(process.cwd(), "docs/superpowers/reports/2026-10-02-v2-retained-evidence-acceptance.md");
    if (existsSync(report)) observe(readFileSync(report));
    assert.ok(wrapped >= 5 && unwrapped === 1, "actual wrap/unwrap DATA-key observations missing");
    for (const key of dataKeys) needles.push(...dataKeyNeedles(key));
    // Negative control proves the scanner rejects an observed buffer carrying a key or original.
    assert.equal(scanSurfaces([needles[1]!], needles), false);
    assert.equal(scanSurfaces([dataKeys[0]!], needles), false);
    assert.equal(scanSurfaces(surfaces, needles, sources), true, "synthetic private bytes found in observed surface");
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr;
    for (const bytes of [...dataKeys, ...needles, ...surfaces]) bytes.fill(0);
    await f.cleanup();
  }
  t.diagnostic(JSON.stringify({ scope: "raw-storage-all-tables-outbox-WAL-output-errors-report", snapshots, tableCount, fileCount, wrapped, unwrapped, observations: surfaces.length, raceWorkerExits: f.workerExits }));
});

test("shared fixed-stage runner observes actual native output and refuses overlapping output ownership", { skip: process.platform !== "win32" }, async t => {
  const module = await import(new URL("../../scripts/run-v2-internal-verified-read.js", import.meta.url).href);
  assert.equal(typeof module.runFixedStages, "function");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "retained-gate-"))), identity = lstatSync(root, { bigint: true });
  const receipts: any[] = [], output: Buffer[] = []; let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const stages = () => [["probe", ["-e", "process.stdout.write('observed-native-output');process.stderr.write('observed-native-error')"]]];
  const run = module.runFixedStages({ root, maximumMs: 30000, timeoutMs: 30000, profile: "fixture", stages,
    beforeStages: async () => { entered(); await held; }, forwardOutput: false,
    observeOutput: (_stage: string, _kind: string, bytes: Buffer) => output.push(Buffer.from(bytes)), observeStage: (value: unknown) => receipts.push(value) });
  try {
    await started;
    assert.equal(await module.runFixedStages({ root, maximumMs: 30000, timeoutMs: 30000, profile: "fixture", stages }), 1);
    const retained = await import(new URL("../../scripts/run-v2-retained-evidence.js", import.meta.url).href);
    assert.equal(await retained.runRetainedEvidenceGate({ root }), 1);
    assert.equal(receipts.length, 0); release(); assert.equal(await run, 0);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].nativeCode, 0); assert.equal(receipts[0].cleanup, "complete");
    assert.equal(receipts[0].closure, "windows-job-active-zero");
    assert.ok(Buffer.concat(output).includes(Buffer.from("observed-native-output")));
    assert.ok(Buffer.concat(output).includes(Buffer.from("observed-native-error")));
    assert.equal(existsSync(join(root, ".fresh-start-foundation.lock")), false);
    t.diagnostic(JSON.stringify({ scope: "shared-fixed-stages", nativeCode: receipts[0].nativeCode, closure: receipts[0].closure, outputBytes: Buffer.concat(output).length }));
    const failedReceipts: any[] = [], failedDecoder = new StringDecoder("utf8");
    let failedStdout = "", decodedChunks = 0;
    const nestedOutput = nestedSpecSummary + nestedSpecSummary + outerSpecSummary;
    const failedCode = await module.runFixedStages({ root, maximumMs: 30000, timeoutMs: 30000, profile: "fixture", forwardOutput: false,
      stages: () => [["native-failure", ["-e", `process.stdout.write(${JSON.stringify(nestedOutput)});process.exitCode=17`]],
        ["must-not-run", ["-e", "process.exitCode=0"]]],
      observeOutput: (_stage: string, kind: string, bytes: Buffer) => {
        if (kind === "stdout") for (let offset = 0; offset < bytes.length; offset++) {
          // Rechunk real captured native bytes deterministically, including the
          // multibyte spec markers, through the decoder used by the receipt path.
          failedStdout += failedDecoder.write(bytes.subarray(offset, offset + 1)); decodedChunks++;
        }
      },
      observeStage: (value: unknown) => failedReceipts.push(value) });
    failedStdout += failedDecoder.end();
    assert.equal(decodedChunks, Buffer.byteLength(nestedOutput));
    assert.deepEqual(retained.parseFinalSpecCounts(failedStdout),
      { tests: 7, suites: 2, pass: 4, fail: 0, cancelled: 0, skipped: 2, todo: 1 });
    assert.equal(failedCode, 17); assert.equal(failedReceipts.length, 1); assert.equal(failedReceipts[0].nativeCode, 17);
    assert.equal(failedReceipts[0].cleanup, "complete"); assert.equal(failedReceipts[0].closure, "windows-job-active-zero");
    assert.equal(existsSync(join(root, ".fresh-start-foundation.lock")), false);
    t.diagnostic(JSON.stringify({ scope: "chunked-passing-counts-native-failure", decodedChunks,
      nativeCode: failedReceipts[0].nativeCode, closure: failedReceipts[0].closure }));
  } finally {
    release(); await run;
    const current = lstatSync(root, { bigint: true });
    if (!existsSync(join(root, ".fresh-start-foundation.lock")) && current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink()) rmSync(root, { recursive: true });
  }
});

// This is the real measured prepared deployment, never the synthetic active fixture.
test("compiled prepared service remains status only", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "retained-prepared-"))), identity = lstatSync(root, { bigint: true });
  const vault = join(root, "vault"), archive = join(root, "archive"), releaseId = randomUUID(), outputs: Buffer[] = [];
  const build = JSON.parse(readFileSync(join(process.cwd(), "dist/v2-build.json"), "utf8"));
  for (const artifact of build.artifacts) assert.equal(createHash("sha256").update(readFileSync(join(process.cwd(), "dist", artifact.path))).digest("hex"), artifact.sha256);
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const env = { ...process.env, MEMORY_PROJECT_ROOT: root, MEMORY_V2_VAULT_PATH: vault, MEMORY_V1_ARCHIVE_PATH: archive, MEMORY_V2_RELEASE_ID: releaseId };
  mkdirSync(archive);
  writeFileSync(join(root, "release.json"), JSON.stringify({ initializationId: randomUUID(), release: { profileVersion: 1, releaseId,
    buildIdentityHash: build.buildIdentityHash, schemaIdentityHash: "f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1",
    configurationHash: hash({ projectRoot: root, v2VaultRoot: vault, v1ArchiveRoot: archive, releaseId }),
    capabilityManifestHash: hash({ profile: "fresh-start", version: 1, tools: ["memory_v2Status"], content: "unavailable" }),
    recoveryPolicyHash: hash({ profile: "fresh-start", version: 1, productionReady: false, promotion: "closed" }),
    evidenceDigest: hash({ purpose: "retained-prepared-admission" }), createdAt: new Date().toISOString() } }));
  const admin = (operation: string) => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "dist/v2-admin.js"), operation, "--project-root", root,
      "--v2-vault-root", vault, "--v1-archive-root", archive, "--release-manifest", join(root, "release.json")], { env, encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(result.error, undefined, "measured admin did not close"); outputs.push(Buffer.from(result.stdout), Buffer.from(result.stderr)); return result;
  };
  let allClosed = true;
  try {
    const initialized = admin("initialize-fresh"); assert.equal(initialized.status, 0, "measured preparation failed");
    const status = JSON.parse(initialized.stdout); assert.equal(status.mode, "prepared"); assert.equal(status.productionReady, false);
    const promotion = admin("activate"); assert.equal(promotion.status, 1); assert.match(promotion.stderr, /FRESH_START_RELEASE_NOT_READY/);
    const child = spawn(process.execPath, [join(process.cwd(), "dist/v2.js")], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    allClosed = false;
    const closed = new Promise<number | null>(resolve => child.once("close", code => { allClosed = true; resolve(code); }));
    let pending = "", sequence = 0; const replies = new Map<number, (value: any) => void>();
    child.stderr.on("data", bytes => outputs.push(Buffer.from(bytes)));
    child.stdout.on("data", bytes => {
      outputs.push(Buffer.from(bytes)); pending += bytes.toString("utf8");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { const value = JSON.parse(line); replies.get(value.id)?.(value); } catch { child.kill(); }
      }
    });
    async function call(method: string, params: unknown) {
      const id = ++sequence; let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await new Promise<any>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("measured protocol deadline")), 15000);
        replies.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }); } finally { clearTimeout(timer); replies.delete(id); }
    }
    let childCode: number | null;
    try {
      await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "retained-acceptance", version: "1" } });
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const publicTools = (await call("tools/list", {})).result.tools.map((tool: any) => tool.name);
      assert.deepEqual(publicTools, ["memory_v2Status"]);
      const publicStatus = JSON.parse((await call("tools/call", { name: "memory_v2Status", arguments: {} })).result.content[0].text);
      assert.equal(publicStatus.productionReady, false); assert.deepEqual(publicStatus, status);
      for (const name of ["retain-evidence-batch", "memory_sessionEnd", "memory_v2Activate"])
        assert.equal((await call("tools/call", { name, arguments: {} })).error.data.code, "FRESH_START_RELEASE_NOT_READY");
    } finally {
      child.stdin.end(); const timer = setTimeout(() => child.kill(), 3000);
      try { childCode = await closed; } finally { clearTimeout(timer); }
    }
    assert.equal(childCode, 0, "measured service did not close cleanly");
    const path = join(vault, ".memory-mcp/v2/events.sqlite"), context = storeContext(join(vault, ".memory-mcp/v2"), path);
    const scope = { projectId: status.projectId, vaultId: status.vaultId, storeId: status.storeId };
    Object.assign(context.binding, scope); context.binding.contextFingerprint = computeProjectContextFingerprint(context.binding);
    const worker = new Worker(pathToFileURL(join(process.cwd(), "dist/workers/project-store.worker.js")), { workerData: { role: "store", executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 1000 }, stdout: true, stderr: true });
    allClosed = false;
    worker.stdout.on("data", bytes => outputs.push(Buffer.from(bytes))); worker.stderr.on("data", bytes => outputs.push(Buffer.from(bytes)));
    const exit = once(worker, "exit"); let workerCode: number;
    try {
      const reply = once(worker, "message"), timer = setTimeout(() => { void worker.terminate(); }, 15000);
      worker.postMessage({ id: "open", type: "open", binding: encodeWorkerBinding(context), freshStart: { identity: scope, releaseId, generation: "0", measuredBuildHash: build.buildIdentityHash } });
      let response: any; try { [response] = await Promise.race([reply, exit.then(() => { throw new Error("measured worker exited before refusal"); })]); } finally { clearTimeout(timer); }
      outputs.push(encodeObserved(response)); assert.equal(response.ok, false); assert.equal(response.error.code, "FRESH_START_ADMISSION_DENIED");
    } finally { await worker.terminate(); [workerCode] = await exit; allClosed = true; }
    assert.ok(outputs.every(bytes => !bytes.includes(Buffer.from(root))), "measured output disclosed owned path");
    t.diagnostic(JSON.stringify({ scope: "measured-prepared-status-refusal", buildIdentityHash: build.buildIdentityHash, childCode, workerCode,
      workerTermination: "intentional-after-admission-refusal", desktopQualification: "nine-rows-unverified" }));
  } finally {
    for (const bytes of outputs) bytes.fill(0);
    const current = lstatSync(root, { bigint: true });
    assert.ok(allClosed && current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink(), "prepared cleanup unconfirmed; preserving owned root");
    rmSync(root, { recursive: true });
  }
});
test("private wire rejects weakened authorization and caller hash", () => {
  const original = command(randomUUID());
  for (const authorization of [ { kind: "initial-authority", authoritySessionId: null, targetSessionId: null, proof: null, approval: null, childBindingGrant: null },
    { kind: "protected", authoritySessionId: original.targetSessionId, targetSessionId: original.targetSessionId, proof: null, approval: null, childBindingGrant: null } ]) {
    assert.throws(() => encodePreparedRetainedEvidenceCommand({ command: original, authorization }), { code: "SESSION_CAPABILITY_INVALID" });
  }
  assert.throws(() => encodePreparedRetainedEvidenceCommand({ command: original, authorization: {}, candidateIntentHash: "a".repeat(64) }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
});

test("private physical text rejects noncanonical, oversized and policy/provider selectors", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const p = prepared(f, command(f.rootAuthority.sessionId)), wire = encodePreparedRetainedEvidenceCommand(p);
    assert.throws(() => decodePreparedRetainedEvidenceCommand({ ...wire, command: ` ${wire.command}` }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
    assert.throws(() => decodePreparedRetainedEvidenceCommand({ ...wire, command: " ".repeat(1_048_577) }), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    for (const key of ["provider", "policy", "candidateIntentHash"]) assert.throws(() => encodePreparedRetainedEvidenceCommand({ ...p, [key]: {} }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
    assert.throws(() => assertRetainedEvidenceWireSize({ value: "x".repeat(4 * 1024 * 1024) }), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    assert.throws(() => decodePreparedRetainedEvidenceCommand({ ...wire, authorization: { ...wire.authorization, targetSessionId: randomUUID() } }), { code: "SESSION_CAPABILITY_INVALID" });
  } finally { await f.cleanup(); }
});
test("decoded private request owns its command text and protected authorization snapshot", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const encoded = encodePreparedRetainedEvidenceCommand(prepared(f, command(f.rootAuthority.sessionId)));
    const wire = { command: encoded.command, authorization: { ...encoded.authorization, proof: { ...encoded.authorization.proof! } } };
    const decoded = decodeWorkerRequest({ id: "r", type: "retained-evidence", binding: encodeWorkerBindingAssertion(f.projectContext), prepared: wire });
    assert.equal(decoded.type, "retained-evidence"); if (decoded.type !== "retained-evidence") throw new Error("wrong lane");
    const expected = decoded.prepared.command;
    wire.command = "{}"; wire.authorization.proof.proofFingerprint = "b".repeat(64);
    assert.ok(decoded.prepared.command === expected);
    assert.notEqual(decoded.prepared.authorization.proof!.proofFingerprint, "b".repeat(64));
  } finally { await f.cleanup(); }
});
test("private request preserves canonical UUID1-5 for every existing scope identity", async t => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const wire = encodePreparedRetainedEvidenceCommand(prepared(f, command(f.rootAuthority.sessionId)));
    const scopes = [
      [1, "abcdefab-1234-1234-8123-123456789abc"],
      [2, "abcdefab-1234-2234-8123-123456789abc"],
      [3, "abcdefab-1234-3234-8123-123456789abc"],
      [4, "abcdefab-1234-4234-8123-123456789abc"],
      [5, "abcdefab-1234-5234-8123-123456789abc"],
    ] as const;
    for (const field of ["projectId", "vaultId", "storeId"] as const) {
      for (const [version, identity] of scopes) await t.test(`${field} UUIDv${version}`, () => {
        const binding = { ...encodeWorkerBindingAssertion(f.projectContext), [field]: identity };
        const decoded = decodeWorkerRequest({ id: "compatibility", type: "retained-evidence", binding, prepared: wire });
        assert.equal(decoded.type, "retained-evidence");
        if (decoded.type !== "retained-evidence") throw new Error("wrong lane");
        assert.equal(decoded.binding[field], identity);
        assert.equal(decoded.prepared.authorization.proof!.proofFingerprint, wire.authorization.proof!.proofFingerprint);
      });
    }
  } finally { await f.cleanup(); }
});
test("private request still refuses malformed scopes and non-v4 new selectors", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const p = prepared(f, command(f.rootAuthority.sessionId)), wire = encodePreparedRetainedEvidenceCommand(p);
    for (const field of ["projectId", "vaultId", "storeId"] as const) {
      for (const identity of ["not-a-uuid", "ABCDEFAB-1234-5234-8123-123456789ABC", "abcdefab-1234-0234-8123-123456789abc",
        "abcdefab-1234-6234-8123-123456789abc", "abcdefab-1234-5234-7123-123456789abc", " abcdefab-1234-5234-8123-123456789abc"]) {
        assert.throws(() => decodeWorkerRequest({ id: "invalid-scope", type: "retained-evidence",
          binding: { ...encodeWorkerBindingAssertion(f.projectContext), [field]: identity }, prepared: wire }), { code: "WORKER_PROTOCOL_INVALID" });
      }
    }
    for (const identity of ["abcdefab-1234-1234-8123-123456789abc", "abcdefab-1234-2234-8123-123456789abc",
      "abcdefab-1234-3234-8123-123456789abc", "abcdefab-1234-5234-8123-123456789abc"]) {
      for (const field of ["commandId", "idempotencyKey", "targetSessionId", "conversationId"] as const) {
        assert.throws(() => encodePreparedRetainedEvidenceCommand({ ...p, command: { ...p.command, [field]: identity } }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
      }
      for (const field of ["frameId", "previousFrameId", "toolCorrelationId"] as const) {
        const frame = { ...p.command.frames[0]!, [field]: identity,
          ...(field === "previousFrameId" ? { ordinal: "1" } : {}),
          ...(field === "toolCorrelationId" ? { role: "tool", category: "tool-input" } : {}) };
        assert.throws(() => encodePreparedRetainedEvidenceCommand({ ...p, command: { ...p.command, frames: [frame] } }), { code: "RETAINED_EVIDENCE_INPUT_INVALID" });
      }
      assert.throws(() => encodePreparedRetainedEvidenceCommand({ ...p, authorization: { ...p.authorization, authoritySessionId: identity } }), { code: "SESSION_CAPABILITY_INVALID" });
      assert.throws(() => encodePreparedRetainedEvidenceCommand({ ...p, authorization: { ...p.authorization,
        proof: { ...p.authorization.proof!, proofNonce: identity } } }), { code: "SESSION_CAPABILITY_INVALID" });
    }
  } finally { await f.cleanup(); }
});

test("native private worker dispatch and reopened executor replay preserve exact receipt and ciphertext", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const original = command(f.rootAuthority.sessionId), firstWorker = await nativeExecutor(f);
    let first;
    try { first = await firstWorker.executor.retainEvidence(prepared(f, original)); assert.equal(first.deduplicated, false); }
    finally { await firstWorker.close(); }
    const ciphertext = f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json;
    const reopened = await nativeExecutor(f);
    try {
      const replay = await reopened.executor.retainEvidence(prepared(f, original));
      assert.equal(replay.deduplicated, true); assert.deepEqual(replay.response, first.response); assert.deepEqual(replay.eventIds, first.eventIds);
      assert.equal(f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs").get()!.encrypted_item_json, ciphertext);
      assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM retained_evidence_blobs").get()!.n, 1n);
    } finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});
test("12,000-deep valid canonical JSON crosses native private worker and commits one encrypted item", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    let content: unknown = null; for (let index = 0; index < 12_000; index++) content = [content];
    const original = command(f.rootAuthority.sessionId);
    const deep = { ...original, frames: [{ ...original.frames[0]!, mediaType: "application/json", content }] };
    const worker = await nativeExecutor(f);
    try {
      const result = await worker.executor.retainEvidence(prepared(f, deep));
      assert.equal(result.response.commandId, original.commandId); assert.equal(result.response.evidenceIds.length, 1);
      assert.equal(f.connection.prepare("SELECT COUNT(*) AS n FROM retained_evidence_blobs").get()!.n, 1n);
    } finally { await worker.close(); }
  } finally { await f.cleanup(); }
});
test("missing private composition refuses independently of fixture success", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const before = f.rows(), worker = await nativeExecutor(f, false);
    try { await assert.rejects(worker.executor.retainEvidence(prepared(f, command(f.rootAuthority.sessionId))), { code: "RETAINED_EVIDENCE_UNAVAILABLE" }); }
    finally { await worker.close(); }
    assert.deepEqual(f.rows(), before);
  } finally { await f.cleanup(); }
});
test("complete safe result envelope has an exact 16,384-byte cap and closed failures", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const p = prepared(f, command(f.rootAuthority.sessionId));
    const runtime = factory(f).create({ connection: f.connection, maintenanceFence: new MaintenanceFence(), keyProvider: f.lifecycle.broker });
    const data = encodeAppendResultWire(runtime.execute(p, f.projectContext));
    const overhead = Buffer.byteLength(JSON.stringify({ id: "", ok: true, data }));
    const id = "r".repeat(16_384 - overhead);
    assert.equal(Buffer.byteLength(JSON.stringify({ id, ok: true, data })), 16_384);
    assert.equal(decodeRetainedEvidenceWorkerResponse({ id, ok: true, data }, id, p).ok, true);
    assert.throws(() => decodeRetainedEvidenceWorkerResponse({ id: id + "r", ok: true, data }, id + "r", p), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
    for (const error of [{ code: "NATIVE_SECRET", message: "NATIVE_SECRET", details: {} }, { code: "SQLITE_BUSY", message: "unsafe synthetic message", details: {} },
      { code: "SQLITE_BUSY", message: "SQLITE_BUSY", details: { retryable: true } }]) assert.throws(() => decodeRetainedEvidenceWorkerResponse({ id: "r", ok: false, error }, "r", p));
  } finally { await f.cleanup(); }
});
test("backend retries only fully rolled-back primary busy with original input and bounded deadline", async () => {
  const f = await makeRetainedEvidenceFixture();
  let attempts = 0;
  try {
    const before = f.rows();
    const backend = await openedBackend(f, factory(f, { hit(boundary) {
      if (boundary === "before-begin") { attempts++; assert.deepEqual(f.rows(), before); }
      if (boundary === "before-commit" && attempts < 3) throw Object.assign(new Error("synthetic primary busy"), { errcode: 5 });
    } }));
    try {
      const result = await backend.dispatch(request(f, command(f.rootAuthority.sessionId)));
      assert.equal(attempts, 3); assert.ok("response" in result);
      assert.equal(f.rows().retained_evidence_blobs!.length, 1);
    } finally { await backend.close(); }
    const refused = await openedBackend(f, factory(f, { hit(boundary) { if (boundary === "before-begin") attempts++;
      if (boundary === "before-commit") throw Object.assign(new Error("synthetic busy deadline"), { errcode: 5 }); } }), 1);
    const start = attempts;
    try { await assert.rejects(refused.dispatch(request(f, command(f.rootAuthority.sessionId))), { code: "SQLITE_BUSY" }); assert.equal(attempts, start + 1); }
    finally { await refused.close(); }
  } finally { await f.cleanup(); }
});
test("backend never retries after uncertain successful commit and reopens original result", async () => {
  const f = await makeRetainedEvidenceFixture(); let attempts = 0;
  try {
    const original = command(f.rootAuthority.sessionId);
    const backend = await openedBackend(f, factory(f, { hit(boundary) {
      if (boundary === "before-begin") attempts++;
      if (boundary === "after-commit-before-response") throw Object.assign(new Error("synthetic primary busy after commit"), { errcode: 5 });
    } }));
    try { await assert.rejects(backend.dispatch(request(f, original)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: original.commandId, idempotencyKey: original.idempotencyKey } }); assert.equal(attempts, 1); }
    finally { await backend.close(); }
    const reopened = await openedBackend(f, factory(f));
    try { const recovered = await reopened.dispatch(request(f, original)); assert.ok("deduplicated" in recovered && recovered.deduplicated); }
    finally { await reopened.close(); }
    assert.equal(f.rows().retained_evidence_blobs!.length, 1);
  } finally { await f.cleanup(); }
});
test("failed rollback and uncertain native COMMIT never retry and retain original recovery IDs", async () => {
  for (const mode of ["rollback", "commit"] as const) {
    const f = await makeRetainedEvidenceFixture(); let attempts = 0, armed = false;
    try {
      const original = command(f.rootAuthority.sessionId), before = f.rows();
      const baseFactory = factory(f, { hit(boundary) {
        if (boundary === "before-begin") { attempts++; armed = true; }
        if (mode === "rollback" && boundary === "before-commit") throw Object.assign(new Error("synthetic rollback precursor"), { errcode: 5 });
      } });
      const backend = await openedBackend(f, { create(input) {
        const exec = input.connection.exec.bind(input.connection);
        input.connection.exec = sql => {
          if (armed && sql === (mode === "rollback" ? "ROLLBACK" : "COMMIT")) throw new Error("synthetic native boundary failure");
          return exec(sql);
        };
        return baseFactory.create(input);
      } });
      try { await assert.rejects(backend.dispatch(request(f, original)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: original.commandId, idempotencyKey: original.idempotencyKey } }); assert.equal(attempts, 1); }
      finally { await backend.close(); }
      assert.deepEqual(f.rows(), before);
    } finally { await f.cleanup(); }
  }
});
test("trusted factory, provider and native exceptions become nonsecret closed errors with no retry", async () => {
  const f = await makeRetainedEvidenceFixture();
  const marker = "synthetic-exception-message-must-stay-private";
  try {
    await assert.rejects(openedBackend(f, { create() { throw Object.assign(new Error(marker), { code: "NATIVE_SECRET", details: { content: marker } }); } }), { code: "RETAINED_EVIDENCE_UNAVAILABLE", message: "RETAINED_EVIDENCE_UNAVAILABLE" });
    const before = f.rows(); let attempts = 0;
    const backend = await openedBackend(f, factory(f, { hit(boundary) { if (boundary === "before-begin") attempts++; if (boundary === "before-commit") throw new Error(marker); } }));
    try { await assert.rejects(backend.dispatch(request(f, command(f.rootAuthority.sessionId))), { code: "RETAINED_EVIDENCE_UNAVAILABLE", message: "RETAINED_EVIDENCE_UNAVAILABLE" }); assert.equal(attempts, 1); }
    finally { await backend.close(); }
    const old = f.provider.currentKey;
    f.provider.currentKey = () => { throw new Error(marker); };
    const providerBackend = await openedBackend(f, factory(f));
    try { await assert.rejects(providerBackend.dispatch(request(f, command(f.rootAuthority.sessionId))), { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE", message: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" }); }
    finally { f.provider.currentKey = old; await providerBackend.close(); }
    assert.deepEqual(f.rows(), before);
  } finally { await f.cleanup(); }
});
test("shape-valid forged proof cannot grant provider access or durable writes", async () => {
  const f = await makeRetainedEvidenceFixture();
  try {
    const before = f.rows(), currentCalls = f.provider.calls.current, backend = await openedBackend(f, factory(f));
    const p = prepared(f, command(f.rootAuthority.sessionId));
    try {
      const wire = encodePreparedRetainedEvidenceCommand({ ...p, authorization: { ...p.authorization,
        proof: { ...p.authorization.proof!, proofFingerprint: "f".repeat(64) } } });
      await assert.rejects(backend.dispatch(decodeWorkerRequest({ id: "forged", type: "retained-evidence", binding: encodeWorkerBindingAssertion(f.projectContext), prepared: wire })), { code: "SESSION_CAPABILITY_INVALID" });
      assert.equal(f.provider.calls.current, currentCalls); assert.deepEqual(f.rows(), before);
    } finally { await backend.close(); }
  } finally { await f.cleanup(); }
});
test("factory applies actual prepared recovery and disabled fresh-start mutation admission", async () => {
  for (const mode of ["prepared", "read-only-recovery", "disabled"] as const) {
    const f = await makeRetainedEvidenceFixture();
    try {
      const p = prepared(f, command(f.rootAuthority.sessionId));
      f.admission.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: mode === "prepared" ? "disabled" : mode, reasonCode: "privacy-failure" });
      if (mode === "prepared") await f.admission.control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 2n, expectedMode: "disabled", expectedReleaseId: f.admission.release.releaseId,
        nextMode: "prepared", nextRelease: f.admission.release, approvalEnvelope: new Uint8Array([1]) });
      const before = f.rows(), connection = new NodeSqliteDriver({ DatabaseSync }).open(f.path, { mode: "existing", busyTimeoutMs: 1000 });
      try {
        bindFreshStartAdmissionContext(connection, { ...f.admission.trusted, generation: mode === "prepared" ? 3n : 2n });
        const runtime = factory(f).create({ connection, maintenanceFence: new MaintenanceFence(), keyProvider: f.lifecycle.broker });
        assert.throws(() => runtime.execute(p, f.projectContext), { code: "FRESH_START_ADMISSION_DENIED" });
        assert.deepEqual(f.rows(), before);
      } finally { connection.close(); }
    } finally { await f.cleanup(); }
  }
});
