import { strict as assert } from "node:assert";
import { it } from "node:test";
import { EventStore, SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import { FreshStartControlPlane } from "../src/orchestrator/fresh-start/fresh-start-control-plane.js";
import { DENY_FRESH_START_PROMOTION } from "../src/orchestrator/fresh-start/operator-approval.js";
import { freshStore, freshGenesis, freshRelease, FRESH_IDENTITY, FRESH_NOW } from "./support/fresh-start-fixture.js";
import { command } from "./fixtures/fresh-start-admission-child.js";
import { randomUUID } from "node:crypto";
import { FreshStartAdmissionGuard, bindFreshStartAdmissionContext } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { TrustedFreshStartEvidenceVerifier, TrustedOperatorApprovalVerifier } from "../src/orchestrator/fresh-start/operator-approval.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { LifecycleOperationalStore } from "../src/orchestrator/lifecycle/lifecycle-operational.store.js";
import { decodeWorkerRequest, decodeWorkerResponseForRequest, encodeWorkerBinding } from "../src/orchestrator/runtime/worker-protocol.js";
import { context } from "./fixtures/fresh-start-admission-child.js";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectStoreWorkerBackend } from "../src/orchestrator/runtime/project-store-worker-backend.js";
import { ProjectStoreExecutor } from "../src/orchestrator/runtime/project-store-executor.js";
import { EventAppendTransaction } from "../src/orchestrator/storage/event-append-transaction.js";
import { LifecycleCommandStore } from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { lifecycleEnvelope } from "./fixtures/fresh-start-admission-child.js";

function child(path: string, mode: string, gate: string) {
  const process = fork(fileURLToPath(new URL("./fixtures/fresh-start-admission-child.js", import.meta.url)), [path, mode, gate], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const queue: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let failure: Error | undefined;
  process.on("message", value => { queue.push(value as Record<string, unknown>); waiters.splice(0).forEach(w => w()); });
  process.on("error", error => { failure = error; waiters.splice(0).forEach(w => w()); });
  process.on("exit", code => { if (code !== 0) failure = new Error(`child exit ${code}`); waiters.splice(0).forEach(w => w()); });
  return { process, async message(type: string) {
    const until = Date.now() + 15000;
    for (;;) {
      if (failure) throw failure;
      const index = queue.findIndex(item => item.type === type || item.type === "error");
      if (index !== -1) return queue.splice(index, 1)[0]!;
      if (Date.now() >= until) throw new Error(`child timeout waiting for ${type}`);
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
  } };
}
async function closeChild(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child failed to exit")), 5000);
    process.once("exit", () => { clearTimeout(timer); resolve(); }); process.kill();
  });
}

for (const kind of ["generic", "lifecycle"]) it(`a ${kind} request admitted in another process is refused after the recovery fence`, async () => {
  const fixture = await active(); let owned: ReturnType<typeof child> | undefined;
  try {
    const path = fixture.connection.prepare("PRAGMA database_list").get()?.file as string;
    owned = child(path, `stale-${kind}`, join(dirname(path), "release"));
    assert.equal((await owned.message("admitted")).type, "admitted");
    const stopped = fixture.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    owned.process.send("continue");
    assert.equal((await owned.message("error")).code, "FRESH_START_ADMISSION_STALE");
    assert.equal(stopped.recoveryPosition, 0n);
    assert.equal(fixture.connection.prepare("SELECT count(*) AS n FROM events").get()?.n, 0n);
  } finally { if (owned) await closeChild(owned.process); fixture.cleanup(); }
});

it("recovery waits for a real held writer and records its committed tail", async () => {
  const fixture = await active(); const owned: ReturnType<typeof child>[] = [];
  try {
    const path = fixture.connection.prepare("PRAGMA database_list").get()?.file as string;
    const gate = join(dirname(path), "release-writer");
    const writer = child(path, "writer", gate); owned.push(writer);
    await writer.message("admitted"); writer.process.send("continue");
    assert.equal((await writer.message("writer-held")).type, "writer-held");
    const stopper = child(path, "stop", gate); owned.push(stopper);
    assert.deepEqual(await stopper.message("contention-observed"), { type: "contention-observed", boundary: "BEGIN IMMEDIATE", nativeErrcode: 5 });
    assert.equal(fixture.connection.prepare("SELECT generation FROM fresh_start_control_state").get()?.generation, 1n);
    writeFileSync(gate, "release");
    const committed = await writer.message("result");
    assert.equal(committed.type, "result"); assert.equal(committed.position, "1");
    // The fixture retries only after the holder's actual commit, not on a timed guess.
    stopper.process.send("retry-stop");
    const stopped = await stopper.message("result");
    assert.equal(stopped.type, "result"); assert.equal(stopped.position, "1");
    assert.equal(stopped.hash, fixture.connection.prepare("SELECT event_hash FROM events").get()?.event_hash);
  } finally { for (const item of owned) await closeChild(item.process); fixture.cleanup(); }
});

for (const variant of ["valid", "missing-inspector", "missing-context", "missing-receipt", "wrong-schema", "wrong-build", "wrong-release", "stale-generation"] as const) it(`worker opening independently checks fresh context: ${variant}`, async () => {
  const fixture = variant === "missing-receipt" ? freshStore() : await active(variant === "wrong-schema" ? { ...release, schemaIdentityHash: "b".repeat(64) } : release);
  const path = fixture.connection.prepare("PRAGMA database_list").get()?.file as string;
  const backend = new ProjectStoreWorkerBackend({ selfUrl: new URL("../src/workers/project-store.worker.js", import.meta.url), executorLeaseMs: 15000, appendRetryDeadlineMs: 1000,
    ...(variant === "missing-inspector" ? {} : { trustedFreshStartBuildInspector: () => variant === "wrong-build" ? "b".repeat(64) : "a".repeat(64) }) });
  try {
    const request = decodeWorkerRequest({ id: "open", type: "open", binding: encodeWorkerBinding(context(dirname(path), path)), ...(variant === "missing-context" ? {} : { freshStart: {
      ...trusted, generation: variant === "stale-generation" ? "0" : "1", releaseId: variant === "wrong-release" ? randomUUID() : release.releaseId } }) });
    if (variant === "valid") {
      const result = await backend.dispatch(request);
      assert.equal((result as { freshStart: { generation: string } }).freshStart.generation, "1");
    } else await assert.rejects(backend.dispatch(request), { code: ({ "missing-inspector": "FRESH_START_CONTEXT_REQUIRED", "missing-context": "FRESH_START_CONTEXT_REQUIRED", "missing-receipt": "FRESH_START_NOT_INITIALIZED", "wrong-schema": "FRESH_START_SCHEMA_MISMATCH", "wrong-build": "FRESH_START_BUILD_MISMATCH", "wrong-release": "FRESH_START_RELEASE_MISMATCH", "stale-generation": "FRESH_START_ADMISSION_STALE" } as const)[variant] });
  } finally { await backend.close(); fixture.cleanup(); }
});

const release = freshRelease({ schemaIdentityHash: expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS) });
const trusted = { identity: FRESH_IDENTITY, releaseId: release.releaseId, measuredBuildHash: release.buildIdentityHash, generation: 1n };
it("the lifecycle authority callback remains fenced with an injected append-port policy", async () => {
  const fixture = await active();
  try {
    fixture.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    class InjectedPort extends EventAppendTransaction { override assertAppendAllowed(): void {} }
    const events = new InjectedPort(fixture.connection, new SqliteEventStoreStatements(fixture.connection), new MaintenanceFence(), new BranchScopeRepository());
    const store = new LifecycleCommandStore({ connection: fixture.connection, events, projectionWriter: { append: () => undefined },
      transaction: () => { throw new Error("authority must remain unreachable"); } });
    assert.throws(() => store.execute(lifecycleEnvelope(), () => { throw new Error("callback must remain unreachable"); }), { code: "FRESH_START_ADMISSION_STALE" });
  } finally { fixture.cleanup(); }
});
async function active(installedRelease = release) {
  const fixture = freshStore();
  const repository = new SqliteFreshStartRepository(fixture.connection);
  repository.transact(FRESH_IDENTITY, tx => tx.install(freshGenesis(), installedRelease));
  const approvals = new TrustedOperatorApprovalVerifier(async (_bytes, requestDigest) => ({ identity: FRESH_IDENTITY,
    approvalId: randomUUID(), nonceDigest: randomUUID().replaceAll("-", "").repeat(2), actorFingerprint: "2".repeat(64), requestDigest, evidenceDigest: release.evidenceDigest }));
  const control = new FreshStartControlPlane(repository, approvals, new TrustedFreshStartEvidenceVerifier(async value => value));
  await control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 0n, expectedMode: "prepared", expectedReleaseId: installedRelease.releaseId, nextMode: "active", nextRelease: installedRelease, approvalEnvelope: new Uint8Array([1]) });
  bindFreshStartAdmissionContext(fixture.connection, trusted);
  const store = new EventStore(fixture.connection, new SqliteEventStoreStatements(fixture.connection), new MaintenanceFence(), new BranchScopeRepository(), () => FRESH_NOW);
  return { ...fixture, repository, control, store };
}

it("the shipped worker refuses a fresh opening without a trusted deployment inspector", async () => {
  const fixture = await active();
  const path = fixture.connection.prepare("PRAGMA database_list").get()?.file as string;
  const executor = new ProjectStoreExecutor({ workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
    context: context(dirname(path), path), freshStart: trusted, maxPending: 4, requestTimeoutMs: 10000,
    closeTimeoutMs: 5000, executorLeaseMs: 15000, heartbeatIntervalMs: 5000 });
  try { await assert.rejects(executor.open(), { code: "FRESH_START_CONTEXT_REQUIRED" }); }
  finally { await executor.close().catch(() => undefined); fixture.cleanup(); }
});

it("declared-fresh stores cannot fall back to legacy behavior when the receipt is missing", () => {
  const fixture = freshStore();
  try {
    bindFreshStartAdmissionContext(fixture.connection, trusted);
    const store = new EventStore(fixture.connection, new SqliteEventStoreStatements(fixture.connection), new MaintenanceFence(), new BranchScopeRepository(), () => FRESH_NOW);
    assert.throws(() => store.append(command()), { code: "FRESH_START_NOT_INITIALIZED" });
    assert.equal(fixture.connection.prepare("SELECT count(*) AS n FROM events").get()?.n, 0n);
  } finally { fixture.cleanup(); }
});

it("legacy stores without either receipt or fresh declaration keep their append behavior", () => {
  const fixture = freshStore();
  try {
    const store = new EventStore(fixture.connection, new SqliteEventStoreStatements(fixture.connection), new MaintenanceFence(), new BranchScopeRepository(), () => FRESH_NOW);
    assert.equal(store.append(command()).lastGlobalPosition, 1n);
  } finally { fixture.cleanup(); }
});

for (const mismatch of ["identity", "release", "build", "generation", "schema"] as const) it(`transaction admission refuses mismatched ${mismatch}`, async () => {
  const fixture = await active(mismatch === "schema" ? { ...release, schemaIdentityHash: "b".repeat(64) } : release);
  try {
    const guard = new FreshStartAdmissionGuard(fixture.connection);
    const changed = { ...trusted, identity: mismatch === "identity" ? { ...FRESH_IDENTITY, projectId: randomUUID() as typeof FRESH_IDENTITY.projectId } : FRESH_IDENTITY,
      releaseId: mismatch === "release" ? randomUUID() : trusted.releaseId, measuredBuildHash: mismatch === "build" ? "b".repeat(64) : trusted.measuredBuildHash,
      generation: mismatch === "generation" ? 0n : 1n, operation: "semantic-mutation" as const };
    fixture.connection.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => guard.assertMutationAllowed(changed), { code: { identity: "FRESH_START_IDENTITY_MISMATCH", release: "FRESH_START_RELEASE_MISMATCH", build: "FRESH_START_BUILD_MISMATCH", generation: "FRESH_START_ADMISSION_STALE", schema: "FRESH_START_SCHEMA_MISMATCH" }[mismatch] }); }
    finally { fixture.connection.exec("ROLLBACK"); }
  } finally { fixture.cleanup(); }
});

it("operator recovery captures a populated committed tail in its own writer transaction", async () => {
  const fixture = await active();
  try {
    fixture.store.append(command());
    const state = await fixture.control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 1n, expectedMode: "active", expectedReleaseId: release.releaseId,
      nextMode: "read-only-recovery", nextRelease: release, approvalEnvelope: new Uint8Array([1]) });
    assert.equal(state.recoveryPosition, 1n);
    assert.equal(state.recoveryHash, fixture.connection.prepare("SELECT event_hash FROM events").get()?.event_hash);
  } finally { fixture.cleanup(); }
});

it("a real committed command can recover after stop, but cannot append a second result", async () => {
  const fixture = await active();
  try {
    const committed = fixture.store.append(command());
    const last = fixture.connection.prepare("SELECT event_hash FROM events ORDER BY global_position DESC LIMIT 1").get();
    const stopped = fixture.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    assert.equal(stopped.recoveryPosition, 1n); assert.equal(stopped.recoveryHash, last?.event_hash);
    const replay = fixture.store.append(command());
    assert.equal(replay.deduplicated, true); assert.deepEqual(replay.eventIds, committed.eventIds);
    assert.throws(() => fixture.store.append({ ...command(), commandId: randomUUID(), idempotencyKey: "fresh:second" }), { code: "FRESH_START_ADMISSION_STALE" });
    assert.equal(fixture.connection.prepare("SELECT count(*) AS n FROM command_dedup").get()?.n, 1n);
    assert.throws(() => new FreshStartAdmissionGuard(fixture.connection).assertRequestAllowed({ ...trusted, generation: 2n, operation: "content-read" }), { code: "FRESH_START_CONTENT_UNVERIFIED" });
  } finally { fixture.cleanup(); }
});

it("recovery operational leases cannot smuggle authority or materialization through their facade", async () => {
  const fixture = await active();
  try {
    fixture.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
    const operational = new LifecycleOperationalStore({ connection: fixture.connection,
      transaction: () => ({ workflows: { renew: () => null, advanceEventlessPhase: () => { throw new Error("authority callback must not run"); } } as never, outbox: {} }) });
    const work = { kind: "workflow" as const, projectId: FRESH_IDENTITY.projectId, workflowId: randomUUID(), workflowGeneration: 1n, operation: "renew" as const, ownerId: randomUUID(), claimToken: 1n };
    assert.equal(operational.execute(work, tx => tx.workflows.renew({} as never)).publicResult, null);
    assert.throws(() => operational.execute(work, tx => tx.workflows.advanceEventlessPhase({} as never)), { code: "FRESH_START_ADMISSION_STALE" });
    assert.throws(() => operational.execute({ ...work, operation: "advance-eventless" }, () => undefined), { code: "FRESH_START_ADMISSION_STALE" });
  } finally { fixture.cleanup(); }
});

it("opening codec accepts private context and rejects noncanonical generations and uncorrelated responses", () => {
  const wire = { ...trusted, generation: "1" };
  const raw = { id: "open-one", type: "open", binding: encodeWorkerBinding(context()), freshStart: wire };
  const request = decodeWorkerRequest(raw);
  assert.throws(() => decodeWorkerRequest({ ...raw, freshStart: { ...wire, generation: "01" } }), { code: "WORKER_PROTOCOL_INVALID" });
  for (const generation of ["-1", "1.0", "9223372036854775808", 1]) assert.throws(() => decodeWorkerRequest({ ...raw, freshStart: { ...wire, generation } }), { code: "WORKER_PROTOCOL_INVALID" });
  assert.throws(() => decodeWorkerRequest({ ...raw, freshStart: { ...wire, bypass: true } }), { code: "WORKER_PROTOCOL_INVALID" });
  const data = { projectId: FRESH_IDENTITY.projectId, vaultId: FRESH_IDENTITY.vaultId, storeId: FRESH_IDENTITY.storeId,
    bindingGeneration: 1, contextFingerprint: context().binding.contextFingerprint, executorId: "executor", freshStart: { ...wire, eventPosition: "0", eventHash: "0".repeat(64) } };
  assert.doesNotThrow(() => decodeWorkerResponseForRequest({ id: "open-one", ok: true, data }, request));
  assert.throws(() => decodeWorkerResponseForRequest({ id: "open-one", ok: true, data: { ...data, freshStart: { ...data.freshStart, releaseId: randomUUID() } } }, request), { code: "WORKER_PROTOCOL_INVALID" });
  for (const changed of [{ generation: "2" }, { measuredBuildHash: "b".repeat(64) }, { identity: { ...wire.identity, storeId: randomUUID() } }, { eventPosition: "01" }, { eventHash: "invalid" }, { bypass: true }]) {
    assert.throws(() => decodeWorkerResponseForRequest({ id: "open-one", ok: true, data: { ...data, freshStart: { ...data.freshStart, ...changed } } }, request), { code: "WORKER_PROTOCOL_INVALID" });
  }
});

it("installed fresh stores refuse production generic appends without trusted admission", () => {
  const fixture = freshStore();
  try {
    const repository = new SqliteFreshStartRepository(fixture.connection);
    repository.transact(FRESH_IDENTITY, tx => tx.install(freshGenesis(), freshRelease()));
    const store = new EventStore(fixture.connection, new SqliteEventStoreStatements(fixture.connection), new MaintenanceFence(), new BranchScopeRepository(), () => FRESH_NOW);
    assert.throws(() => store.append(command()), { code: "FRESH_START_CONTEXT_REQUIRED" });
    assert.equal(fixture.connection.prepare("SELECT count(*) AS n FROM events").get()?.n, 0n);
  } finally { fixture.cleanup(); }
});

it("automatic stop captures the real empty-store recovery fence", () => {
  const fixture = freshStore();
  try {
    const repository = new SqliteFreshStartRepository(fixture.connection);
    repository.transact(FRESH_IDENTITY, tx => tx.install(freshGenesis(), freshRelease()));
    const control = new FreshStartControlPlane(repository, DENY_FRESH_START_PROMOTION, DENY_FRESH_START_PROMOTION);
    const state = control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 0n, target: "disabled", reasonCode: "integrity-failure" });
    assert.equal(state.recoveryPosition, 0n);
    assert.equal(state.recoveryHash, "0".repeat(64));
  } finally { fixture.cleanup(); }
});
