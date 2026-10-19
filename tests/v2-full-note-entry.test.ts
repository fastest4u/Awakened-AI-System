import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createVerifiedReadAdapter, type OwnedReadProcess, type VerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";
import { VerifiedReadOwnershipRepository } from "../src/orchestrator/verified-read/ownership.js";
import type { VerifiedFullNoteReadResultV1, VerifiedReadBinding } from "../src/orchestrator/verified-read/contracts.js";
import type { GetFullNoteRequest } from "../src/orchestrator/verified-read/full-note-contracts.js";
import type { GovernedNoteCommandV1, GovernedNoteCommandV2, GovernedNoteKind, GovernedNoteReceiptV1, GovernedNoteReceiptV2 } from "../src/orchestrator/governed-notes/contracts.js";
import { governedNoteBodyHash } from "../src/orchestrator/governed-notes/body-content.js";
import { parseProjectionManifestV3, type ProjectionManifestV2, type ProjectionManifestV3 } from "../src/orchestrator/projections/manifest-codec.js";
import { publishProjectionManifest } from "../src/orchestrator/projections/manifest.js";
import * as governedFixtures from "./support/governed-note-fixture.js";
import * as nativeFixtures from "./support/v2-native-content-fixture.js";

// ---------------------------------------------------------------------------------------------
// Actual native invocation observation. The real child_process.fork is still invoked; this
// test-local wrapper only records the invoked file/bytes, bootstrap correlation IDs (never the
// lock token), stage/terminal kinds, encoded sizes and the exact handle close.
// ---------------------------------------------------------------------------------------------
type ForkObservation = {
  ordinal: number; path: string; sha256: string; mode: string | null;
  ids: Readonly<{ requestId: string; attemptId: string; laneEpoch: string }> | null;
  stages: string[]; kinds: string[];
  success: Readonly<{ capturedPosition: string; capturedHash: string; bytes: number; metadataBytes: number; afterFailure: boolean }> | null;
  close: Readonly<{ ordinal: number; code: number | null; signal: string | null }> | null;
  stdoutBytes: number; stderrBytes: number; child: ChildProcess; failedAt: number | null;
};
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const childProcessModule = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
const realFork = childProcessModule.fork;
const forks: ForkObservation[] = [];
let closeOrdinal = 0;
childProcessModule.fork = function observedFork(this: unknown, modulePath: string | URL, ...rest: unknown[]): ChildProcess {
  const path = modulePath instanceof URL ? fileURLToPath(modulePath) : String(modulePath);
  const digest = sha256(readFileSync(path));
  const child = (realFork as unknown as (...values: unknown[]) => ChildProcess).call(this, modulePath, ...rest);
  const args = Array.isArray(rest[0]) ? rest[0] as string[] : [];
  const record: ForkObservation = { ordinal: forks.length + 1, path, sha256: digest, mode: args[0] ?? null, ids: null, stages: [], kinds: [],
    success: null, close: null, stdoutBytes: 0, stderrBytes: 0, child, failedAt: null };
  forks.push(record);
  child.on("message", (value: unknown) => {
    const message = value as { kind?: unknown; phase?: unknown; fence?: { capturedPosition?: unknown; capturedHash?: unknown } };
    const kind = typeof message?.kind === "string" ? message.kind : "unknown"; record.kinds.push(kind);
    if (kind === "stage" && typeof message.phase === "string") record.stages.push(message.phase);
    if (kind === "success" && typeof message.fence?.capturedPosition === "string" && typeof message.fence.capturedHash === "string") {
      record.success = Object.freeze({ capturedPosition: message.fence.capturedPosition, capturedHash: message.fence.capturedHash,
        bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
        metadataBytes: Buffer.byteLength(JSON.stringify(value, (key, item: unknown) => key === "body" && typeof item === "string" ? "" : item), "utf8"),
        afterFailure: record.failedAt !== null });
    }
  });
  const send = child.send.bind(child) as (...values: unknown[]) => boolean;
  (child as unknown as { send: (...values: unknown[]) => boolean }).send = (message: unknown, ...more: unknown[]) => {
    const envelope = message as { ids?: { requestId?: unknown; attemptId?: unknown; laneEpoch?: unknown }; binding?: unknown; kind?: unknown };
    if (record.ids === null && envelope && typeof envelope === "object" && envelope.ids && (envelope.binding !== undefined || "directory" in envelope)) {
      const { requestId, attemptId, laneEpoch } = envelope.ids;
      if (typeof requestId === "string" && typeof attemptId === "string" && typeof laneEpoch === "string") record.ids = Object.freeze({ requestId, attemptId, laneEpoch });
    }
    if (envelope?.kind === "cancel" && record.failedAt === null) record.failedAt = performance.now();
    return send(message, ...more);
  };
  child.once("close", (code: number | null, signal: string | null) => { record.close = Object.freeze({ ordinal: ++closeOrdinal, code, signal }); });
  child.stdout?.on("data", (bytes: Buffer) => { record.stdoutBytes += bytes.byteLength; });
  child.stderr?.on("data", (bytes: Buffer) => { record.stderrBytes += bytes.byteLength; });
  return child;
} as typeof childProcessModule.fork;
syncBuiltinESMExports();

// ---------------------------------------------------------------------------------------------
// Compile-safe access to the explicit schema3 fixture producers (missing API is an assertion).
// ---------------------------------------------------------------------------------------------
type EvidenceConfiguration = Readonly<{
  capabilityKeys: readonly Readonly<{ purpose: string; keyId: string; current: boolean; status: string }>[];
  evidenceKeys: readonly Readonly<{ purpose: string; keyId: string; version: string; current: boolean; status: string }>[];
  policy: Readonly<{ policyId: string; policyVersion: string; publicRulesSha256: string }>;
  timing: Readonly<Record<string, number>>;
}>;
type G11Fixture = Awaited<ReturnType<typeof governedFixtures.makeGovernedNoteFixture>> & {
  readonly projectionSchemaVersion: 2 | 3;
  identity(): Readonly<{ runId: string; fixtureId: string }>;
  writerInvocations(): readonly Readonly<{ path: string; sha256: string }>[];
  evidenceConfiguration(): EvidenceConfiguration;
};
type NativeV3 = nativeFixtures.NativeContentFixture & {
  publishV3(): Promise<ProjectionManifestV3>;
  currentManifest(): ProjectionManifestV2 | ProjectionManifestV3;
  eventTail(): Readonly<{ position: string; hash: string | null; count: string }>;
};
async function makeV2(options: Readonly<{ child?: boolean; scenario?: string }> = {}): Promise<G11Fixture> {
  const factory = (governedFixtures as unknown as Record<string, unknown>).makeGovernedNoteFixtureV2;
  assert.equal(typeof factory, "function", "explicit schema3 governed fixture entry makeGovernedNoteFixtureV2 required");
  const fixture = await (factory as (value: unknown) => Promise<G11Fixture>)({ ...options, projectionSchemaVersion: 3 });
  assert.equal(fixture.projectionSchemaVersion, 3);
  return fixture;
}
function asNativeV3(fixture: nativeFixtures.NativeContentFixture): NativeV3 {
  assert.equal(typeof (fixture as Partial<NativeV3>).publishV3, "function", "explicit schema3 native-content publication required");
  return fixture as NativeV3;
}

// ---------------------------------------------------------------------------------------------
// Bounded safe evidence records (stage v2-full-note-entry). One final record per finite case.
// ---------------------------------------------------------------------------------------------
const EVIDENCE_MARKER = "V2_FULL_NOTE_NATIVE_EVIDENCE_V1";
const EVIDENCE_CASES = ["round-trip-session-log-root", "round-trip-insight-root", "round-trip-mistake-root", "round-trip-adr-root",
  "round-trip-insight-child", "escaped-65536-old-route", "same-position-upgrade", "v1-kind-absent", "generic-kind-absent", "v1-recovery-v2",
  "sibling-refused", "ended-refused", "revoked-refused", "ineligible-source-refused", "source-key-unavailable", "captured-image-stable",
  "whole-checksum-refused", "native-deadline", "native-cancel", "native-packing-fault", "late-success-uncertain-cleanup"] as const;
type CaseId = typeof EVIDENCE_CASES[number];
const RECORD_KEYS = ["version", "stage", "caseId", "outcome", "fixture", "write", "read", "upgrade", "identities", "configuration", "observations"];
const BLOCK_KEYS: Record<string, readonly string[]> = {
  fixture: ["runId", "fixtureId", "ownerGeneration", "fixtureResetCount", "retained"],
  write: ["commandId", "idempotencyKey", "operationId", "requestId", "recordId", "sourceEventIds", "receiptVersion", "scope", "terminalPosition", "recoveryDisposition"],
  read: ["ids", "operation", "scope", "imageScope", "selectionSessionId", "requestedId", "recordKind", "bodyAvailability", "requiredPosition", "capturedPosition",
    "capturedHash", "projectionPosition", "projectionHash", "projectionGeneration", "projectionSchemaVersion", "imageSha256", "code", "cleanup", "ownerState"],
  upgrade: ["before", "after", "tailBefore", "tailAfter", "eventAppendCountDelta"],
  identities: ["buildIdentityHash", "writer", "reader", "cleanup"],
  configuration: ["capabilityKeys", "evidenceKeys", "policy", "timing"],
  observations: ["ownerWorkerThreadId", "providerThreadId", "openWriterConnectionCount", "factoryConnectionIdentityCount", "factoryFenceIdentityCount",
    "factoryKeyProviderIdentityCount", "parentProviderRpcCalls", "createPosts", "recoveryPosts", "pairs", "pairHeaderFailures", "safeOutputLeaks", "metricLeaks",
    "logLeaks", "privacyLeaks", "statuses", "workerExits", "workerExitCode", "cleanupDisposition", "adapterReusableAfterDisposition", "imageClosed", "readerClosed",
    "lockClosed", "readClose", "cleanupClose", "detail"],
};
const EVIDENCE_RECORD_LIMIT = 16384, EVIDENCE_AGGREGATE_LIMIT = 131072;
const emittedCases = new Set<CaseId>(); let evidenceAggregateBytes = 0;
type Outcome = "expected-success" | "expected-refusal" | "expected-uncertainty";
type Evidence = { caseId: CaseId; outcome: Outcome; fixture: unknown; write: unknown; read: unknown; upgrade: unknown; identities: unknown; configuration: unknown; observations: unknown };
function emitEvidence(t: TestContext, evidence: Evidence): void {
  const record = { version: 1, stage: "v2-full-note-entry", caseId: evidence.caseId, outcome: evidence.outcome, fixture: evidence.fixture, write: evidence.write,
    read: evidence.read, upgrade: evidence.upgrade, identities: evidence.identities, configuration: evidence.configuration, observations: evidence.observations };
  assert.ok(EVIDENCE_CASES.includes(record.caseId)); assert.equal(emittedCases.has(record.caseId), false, `duplicate evidence ${record.caseId}`);
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  for (const [block, keys] of Object.entries(BLOCK_KEYS)) {
    const value = (record as Record<string, unknown>)[block];
    if (value !== null) assert.deepEqual(Object.keys(value as object), keys, `exact ${block} evidence keys`);
  }
  const json = JSON.stringify(record);
  assert.equal(/[\r\n]/u.test(json), false);
  for (const forbidden of ["fixture_secret", "lockToken", "Literal **markdown**", "seed"]) assert.equal(json.includes(forbidden), false, "private material in evidence");
  const line = `${EVIDENCE_MARKER} ${json}`, bytes = Buffer.byteLength(line, "utf8");
  assert.ok(bytes <= EVIDENCE_RECORD_LIMIT, `evidence record ${record.caseId} ${bytes} bytes`);
  evidenceAggregateBytes += bytes; assert.ok(evidenceAggregateBytes <= EVIDENCE_AGGREGATE_LIMIT, "evidence aggregate bound");
  emittedCases.add(record.caseId); t.diagnostic(line);
}
const scopeOf = (value: object) => { const scope = value as Readonly<Record<string, unknown>>; return { projectId: scope.projectId, vaultId: scope.vaultId, storeId: scope.storeId,
  workspaceId: scope.workspaceId, branchScopeId: scope.branchScopeId, branchRef: scope.branchRef, sessionId: scope.sessionId }; };
function fixtureBlock(f: G11Fixture, retained = false) {
  const id = f.identity();
  return { runId: id.runId, fixtureId: id.fixtureId, ownerGeneration: f.observations().ownerGeneration.toString(), fixtureResetCount: 0, retained };
}
function writeBlock(ids: Readonly<{ commandId: string; idempotencyKey: string }>, receipt: GovernedNoteReceiptV1 | GovernedNoteReceiptV2 | null,
  extra: Readonly<{ operationId?: string; requestId?: string; scope?: object | null; recoveryDisposition?: "committed" | "not-found" | "refused" | "unknown" | null }> = {}) {
  return { commandId: ids.commandId, idempotencyKey: ids.idempotencyKey, operationId: extra.operationId ?? null, requestId: extra.requestId ?? null,
    recordId: receipt?.recordId ?? null, sourceEventIds: receipt ? [...receipt.sourceEventIds] : null, receiptVersion: receipt?.resultVersion ?? null,
    scope: receipt ? scopeOf(receipt.scope) : extra.scope ? scopeOf(extra.scope) : null, terminalPosition: receipt?.terminalPosition ?? null,
    recoveryDisposition: extra.recoveryDisposition ?? null };
}
function readBlock(observation: ForkObservation | null, binding: VerifiedReadBinding, requestedId: string, result: VerifiedFullNoteReadResultV1 | null,
  state: Readonly<{ code: string | null; cleanup: "pending" | "complete" | "incomplete"; ownerState: "available" | "quarantined" | "closed" }>) {
  const item = result?.content.item ?? null;
  return { ids: observation?.ids ? { ...observation.ids } : null, operation: "get-full-note", scope: result ? scopeOf(result.receipt.scope) : null,
    imageScope: scopeOf(binding.projectionBinding), selectionSessionId: result ? result.content.selectionScope.sessionId : null, requestedId,
    recordKind: item ? item.recordKind : null, bodyAvailability: item ? item.bodyAvailability : null,
    requiredPosition: result?.receipt.requiredEventPosition ?? null, capturedPosition: result ? observation?.success?.capturedPosition ?? null : null,
    capturedHash: result ? observation?.success?.capturedHash ?? null : null, projectionPosition: result?.receipt.projectionEventPosition ?? null,
    projectionHash: result?.receipt.projectionEventHash ?? null, projectionGeneration: result?.receipt.projectionGeneration ?? null,
    projectionSchemaVersion: result?.receipt.projectionSchemaVersion ?? null, imageSha256: result?.receipt.imageSha256 ?? null,
    code: state.code, cleanup: state.cleanup, ownerState: state.ownerState };
}
const COMPILED_WRITER = fileURLToPath(new URL("./fixtures/project-store-governed-note-worker.js", import.meta.url));
const COMPILED_HELPER = fileURLToPath(new URL("./fixtures/v2-verified-read-process-fixture.js", import.meta.url));
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const measuredBuild = () => JSON.parse(readFileSync(join(process.cwd(), "dist/v2-build.json"), "utf8")) as { buildIdentityHash: string; artifacts: { path: string; sha256: string }[] };
function writerIdentity(f: G11Fixture) {
  const invocations = f.writerInvocations(); assert.ok(invocations.length >= 1, "actual Worker construction observed");
  const expected = sha256(readFileSync(COMPILED_WRITER));
  for (const invocation of invocations) { assert.ok(samePath(invocation.path, COMPILED_WRITER), "actual writer is the compiled governed fixture worker"); assert.equal(invocation.sha256, expected); }
  return { path: "dist-test/tests/fixtures/project-store-governed-note-worker.js", sha256: invocations[0]!.sha256 };
}
function emittedIdentity(observation: ForkObservation, binding: VerifiedReadBinding, kind: "read" | "cleanup") {
  const name = kind === "read" ? "v2-internal-verified-read.js" : "v2-internal-verified-read-cleanup.js";
  assert.ok(samePath(observation.path, join(binding.deploymentDirectory.canonicalPath, name)), `actual ${kind} entry is the emitted private artifact`);
  const artifact = measuredBuild().artifacts.find(value => value.path === `internal/${name}`)!;
  assert.equal(observation.sha256, artifact.sha256); assert.equal(observation.sha256, sha256(readFileSync(join(process.cwd(), "dist/internal", name))));
  return { path: `dist/internal/${name}`, sha256: observation.sha256 };
}
function helperIdentity(observation: ForkObservation) {
  assert.ok(samePath(observation.path, COMPILED_HELPER)); assert.equal(observation.sha256, sha256(readFileSync(COMPILED_HELPER)));
  return { path: "dist-test/tests/fixtures/v2-verified-read-process-fixture.js", sha256: observation.sha256 };
}
const closeOf = (observation: ForkObservation | null | undefined) => observation?.close ? { ordinal: observation.close.ordinal, code: observation.close.code,
  signal: observation.close.signal, stdoutDrained: true, stderrDrained: true } : null;
function observationsBlock(f: G11Fixture | null, extra: Readonly<{ adapterReusable?: boolean | null; closed?: boolean | null; lockClosed?: boolean | null;
  read?: ForkObservation | null; cleanup?: ForkObservation | null; detail?: unknown }> = {}) {
  const o = f?.observations();
  return { ownerWorkerThreadId: o?.ownerWorkerThreadId ?? null, providerThreadId: o?.providerThreadId ?? null, openWriterConnectionCount: o?.openWriterConnectionCount ?? null,
    factoryConnectionIdentityCount: o?.factoryConnectionIdentityCount ?? null, factoryFenceIdentityCount: o?.factoryFenceIdentityCount ?? null,
    factoryKeyProviderIdentityCount: o?.factoryKeyProviderIdentityCount ?? null, parentProviderRpcCalls: o?.parentProviderRpcCalls ?? null,
    createPosts: o?.createPosts ?? null, recoveryPosts: o?.recoveryPosts ?? null, pairs: o?.pairs ?? null, pairHeaderFailures: o?.pairHeaderFailures ?? null,
    safeOutputLeaks: o?.safeOutputLeaks ?? null, metricLeaks: o?.metricLeaks ?? null, logLeaks: o?.logLeaks ?? null, privacyLeaks: o?.privacyLeaks ?? null,
    statuses: o ? [...o.statuses] : null, workerExits: o?.workerExits ?? null, workerExitCode: o?.workerExitCode ?? null, cleanupDisposition: o?.cleanupDisposition ?? null,
    adapterReusableAfterDisposition: extra.adapterReusable ?? null, imageClosed: extra.closed ?? null, readerClosed: extra.closed ?? null,
    lockClosed: extra.lockClosed ?? extra.closed ?? null, readClose: closeOf(extra.read), cleanupClose: closeOf(extra.cleanup), detail: extra.detail ?? null };
}
function assertWriterHealthy(f: G11Fixture) {
  const o = f.observations();
  assert.equal(o.openWriterConnectionCount, 1); assert.equal(o.factoryConnectionIdentityCount, 1); assert.equal(o.factoryFenceIdentityCount, 1);
  assert.equal(o.factoryKeyProviderIdentityCount, 1); assert.equal(o.parentProviderRpcCalls, 0); assert.equal(o.providerThreadId, o.ownerWorkerThreadId);
  for (const key of ["pairHeaderFailures", "privacyLeaks", "safeOutputLeaks", "metricLeaks", "logLeaks"] as const) assert.equal(o[key], 0, key);
}
function persistedSecretAbsent(binding: VerifiedReadBinding) {
  // Independent raw-byte inspection of durable events/dedup and published images; no rows are exported.
  for (const suffix of ["", "-wal"]) { const path = binding.eventsFile.path + suffix; if (existsSync(path)) assert.equal(readFileSync(path).includes("fixture_secret"), false, "raw secret persisted"); }
  const manifest = JSON.parse(readFileSync(join(binding.projectionDirectory.canonicalPath, "projection-manifest.json"), "utf8")) as { databaseFile: string };
  assert.equal(readFileSync(join(binding.projectionDirectory.canonicalPath, manifest.databaseFile)).includes("fixture_secret"), false, "raw secret projected");
}
const KINDS: readonly GovernedNoteKind[] = ["session-log", "insight", "mistake", "adr"];
const secretBody = (kind: string) => `# ${kind} note\n\nLiteral **markdown** body with marker fixture_secret and \`inline\`.\n\n- [ ] item\n`;
const redactedBody = (kind: string) => `# ${kind} note\n\nLiteral **markdown** body with marker [REDACTED] and \`inline\`.\n\n- [ ] item\n`;
function commandV2(f: G11Fixture, kind: GovernedNoteKind, body = secretBody(kind)): GovernedNoteCommandV2 {
  return { version: 2, operation: "create-governed-note", commandId: randomUUID(), idempotencyKey: randomUUID(), recordKind: kind,
    summary: `g11 ${kind} summary fixture_secret`, confidence: "low", provenance: [{ kind: "retained-evidence", identity: f.sourceId }], content: { format: "markdown", body } };
}
function fullNote(id: string, minimumEventPosition: string, consistency: "session-strong" | "project-strong" = "session-strong", budgetMs = 5000): GetFullNoteRequest {
  return { operation: "get-full-note", consistency, minimumEventPosition, budgetMs, parameters: { id } };
}
const lastFork = (predicate: (value: ForkObservation) => boolean) => [...forks].reverse().find(predicate);
const isRead = (value: ForkObservation) => /v2-internal-verified-read\.js$/u.test(value.path);
const isCleanup = (value: ForkObservation) => /v2-internal-verified-read-cleanup\.js$/u.test(value.path);
async function until(predicate: () => boolean, ms = 5000, label = "owned barrier") {
  const deadline = performance.now() + ms;
  while (!predicate()) { assert.ok(performance.now() < deadline, `${label} not reached`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function closeComplete(adapter: VerifiedReadAdapter, binding: VerifiedReadBinding) {
  const diagnostic = await adapter.close(); assert.equal(diagnostic.cleanup, "complete");
  assert.equal(await new VerifiedReadOwnershipRepository(binding.executorStateDirectory).inspect(), null);
  return diagnostic;
}
function assertFrozenDetached(read: VerifiedFullNoteReadResultV1) {
  for (const value of [read, read.receipt, read.content, read.content.item, read.content.item?.content]) if (value) assert.ok(Object.isFrozen(value));
  if (read.content.item?.content) assert.throws(() => { (read.content.item!.content as { body: string }).body = "mutated"; }, TypeError);
}

test("pure_retrieval_closure_guard_is_causal", async () => {
  // Drive the real build guard owner with the actual measured input set, then remove/add one input at a time.
  const guard = await import(pathToFileURL(join(process.cwd(), "scripts/fresh-start-build.js")).href) as {
    freshStartBuild(outDir: string, inspect: (name: string, bytes: Uint8Array, emitted: boolean) => void): {
      options: { plugins: { setup(build: { onLoad(filter: unknown, handler: (args: { path: string }) => unknown): void }): void }[] };
      accept(result: unknown): void } };
  const closures = { read: JSON.parse(readFileSync(join(process.cwd(), "dist/internal/v2-internal-verified-read.js.closure.json"), "utf8")),
    cleanup: JSON.parse(readFileSync(join(process.cwd(), "dist/internal/v2-internal-verified-read-cleanup.js.closure.json"), "utf8")) };
  const scratch: string[] = [];
  try {
    const attempt = (kind: "read" | "cleanup", mutate: (inputs: Map<string, number>) => void) => {
      // The guard resolves sources relative to outDir/.., so the scratch output must be a direct child of the checkout.
      const outDir = join(process.cwd(), `.g11-closure-guard-${randomUUID()}`); scratch.push(outDir); mkdirSync(outDir);
      const build = guard.freshStartBuild(outDir, () => undefined);
      let onLoad: ((args: { path: string }) => unknown) | undefined;
      build.options.plugins[0]!.setup({ onLoad(_filter, handler) { onLoad = handler; } });
      const closure = closures[kind], output = Object.values(closure.metafile.outputs)[0] as { inputs: Record<string, { bytesInOutput: number }> };
      const inputs = new Map<string, number>(closure.inputs.map((entry: { path: string }) => [entry.path, output.inputs[entry.path]?.bytesInOutput ?? 0]));
      mutate(inputs);
      const metafileInputs: Record<string, { bytes: number; imports: never[] }> = {}, contributions: Record<string, { bytesInOutput: number }> = {};
      for (const [path, contributed] of inputs) {
        const bytes = readFileSync(join(process.cwd(), path)); onLoad!({ path: join(process.cwd(), path) });
        metafileInputs[path] = { bytes: bytes.length, imports: [] }; contributions[path] = { bytesInOutput: contributed };
      }
      const name = kind === "read" ? "internal/v2-internal-verified-read.js" : "internal/v2-internal-verified-read-cleanup.js";
      build.accept({ warnings: [], outputFiles: [{ path: join(outDir, name), contents: new TextEncoder().encode("export {};\n") }],
        metafile: { inputs: metafileInputs, outputs: { [name]: { imports: [], inputs: contributions } } } });
    };
    const refused = { message: "FRESH_START_BUILD_MISMATCH" };
    assert.doesNotThrow(() => attempt("read", () => undefined)); assert.doesNotThrow(() => attempt("cleanup", () => undefined));
    for (const pin of ["verified-read/full-note-query.ts", "verified-read/full-note-protocol.ts", "verified-read/full-note-result.ts", "projections/captured-image-v3.ts", "governed-notes/body-content.ts"]) {
      assert.throws(() => attempt("read", inputs => { inputs.delete(`src/orchestrator/${pin}`); }), refused, `read closure must pin ${pin}`);
      assert.throws(() => attempt("read", inputs => { inputs.set(`src/orchestrator/${pin}`, 0); }), refused, `read closure must emit ${pin}`);
    }
    for (const owner of ["governed-notes/repository.ts", "governed-notes/provenance.repository.ts", "governed-notes/service.ts", "governed-notes/runtime.factory.ts",
      "governed-notes/run.ts", "storage/event-store.ts", "storage/session-authority.repository.ts", "verified-read/supervisor.ts", "runtime/project-store-executor.ts",
      "projections/builder.ts", "projections/coordinator.ts", "retrieval/explain.ts"]) for (const kind of ["read", "cleanup"] as const)
      assert.throws(() => attempt(kind, inputs => { inputs.set(`src/orchestrator/${owner}`, 1); }), refused, `${kind} closure must deny ${owner}`);
    for (const query of ["verified-read/full-note-query.ts", "verified-read/full-note-result.ts", "projections/captured-image-v3.ts"])
      assert.throws(() => attempt("cleanup", inputs => { inputs.set(`src/orchestrator/${query}`, 1); }), refused, `cleanup must stay decoder-only without ${query}`);
  } finally { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); }
});

test("native_full_note_round_trip_four_kinds", { timeout: 300000 }, async t => {
  const f = await makeV2(); let adapter: VerifiedReadAdapter | undefined;
  try {
    const configuration = f.evidenceConfiguration();
    assert.deepEqual(configuration.timing, { requestTimeoutMs: 15000, closeTimeoutMs: 5000, recoveryProofLifetimeMs: 60000, maxPending: 128, executorLeaseMs: 15000,
      heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 15000, sqliteBusyTimeoutMs: 5000, privateReadBudgetMs: 5000 });
    assert.ok(configuration.capabilityKeys.length + configuration.evidenceKeys.length <= 16);
    const created: { kind: GovernedNoteKind; ids: { commandId: string; idempotencyKey: string }; receipt: GovernedNoteReceiptV2 }[] = [];
    for (const kind of KINDS) {
      const command = commandV2(f, kind), ids = { commandId: command.commandId, idempotencyKey: command.idempotencyKey }; // snapshotted before dispatch
      const receipt = await f.run.createV2(f.permit, await f.prepareCreateV2(command));
      assert.equal(receipt.resultVersion, 2); assert.equal(receipt.recordKind, kind); assert.equal(receipt.commandId, ids.commandId);
      assert.equal(receipt.content.contentHash, governedNoteBodyHash({ format: "markdown", body: redactedBody(kind) }));
      assert.equal(receipt.scope.sessionId, f.rootSessionId); created.push({ kind, ids, receipt });
    }
    const v1Command: GovernedNoteCommandV1 = { version: 1, operation: "create-governed-note", commandId: randomUUID(), idempotencyKey: randomUUID(), recordKind: "insight",
      summary: "g11 v1 summary", confidence: "low", provenance: [{ kind: "retained-evidence", identity: f.sourceId }] };
    const v1Receipt = await f.run.create(f.permit, await f.prepareCreate(v1Command)); assert.equal(v1Receipt.resultVersion, 1);
    const recovery = await f.prepareRecoveryV2(v1Command);
    const recoveryIds = { operationId: recovery.request.operationId, requestId: recovery.request.requestId }; // actual mint, before dispatch
    assert.equal(recovery.request.commandId, v1Command.commandId); assert.equal(recovery.request.idempotencyKey, v1Command.idempotencyKey);
    const recovered = await f.run.recoverV2(f.permit, recovery);
    assert.equal(recovered.resultVersion, 2); assert.equal(recovered.outcome, "committed"); if (recovered.outcome !== "committed") throw new Error("expected committed");
    assert.equal(recovered.receipt.resultVersion, 1); assert.equal(recovered.receipt.recordId, v1Receipt.recordId);
    assertWriterHealthy(f);
    const writer = writerIdentity(f);
    // Trusted session minimum = earliest receipt; publication still covers the whole committed stream.
    const binding = await f.verifiedReadBinding(created[0]!.receipt);
    const manifest = parseProjectionManifestV3(JSON.parse(readFileSync(join(binding.projectionDirectory.canonicalPath, "projection-manifest.json"), "utf8")), binding.projectionBinding);
    assert.equal(manifest.schemaVersion, 3); assert.equal(manifest.terminalEventPosition, v1Receipt.terminalPosition);
    persistedSecretAbsent(binding);
    adapter = createVerifiedReadAdapter(binding);
    const expectedScope = { ...binding.projectionBinding, sessionId: f.rootSessionId };
    for (const entry of created) {
      const read = await adapter.queryFullNote(fullNote(entry.receipt.recordId, entry.receipt.terminalPosition));
      const observation = lastFork(isRead)!;
      const actualReadEntrypoint = observation.path, emittedPrivateReadEntrypoint = join(binding.deploymentDirectory.canonicalPath, "v2-internal-verified-read.js");
      assert.ok(samePath(actualReadEntrypoint, emittedPrivateReadEntrypoint));
      const actualWriterEntrypoint = f.writerInvocations()[0]!.path; assert.ok(samePath(actualWriterEntrypoint, COMPILED_WRITER));
      assert.equal(read.content.item!.content!.body, redactedBody(entry.kind));
      assert.equal(read.content.item!.recordKind, entry.kind); assert.equal(read.content.item!.bodyAvailability, "present");
      assert.equal(read.content.item!.content!.contentHash, entry.receipt.content.contentHash);
      assert.equal(read.content.item!.text, `g11 ${entry.kind} summary [REDACTED]`); assert.equal(read.content.item!.status, "candidate");
      assert.equal(read.content.item!.verificationMethod, "governed-note-unverified-v2"); assert.equal(read.content.item!.textKind, "canonical-summary");
      assert.equal(read.content.item!.sourceEventPosition, entry.receipt.terminalPosition); assert.equal(read.content.item!.sessionId, f.rootSessionId);
      assert.ok(BigInt(read.receipt.projectionEventPosition) >= BigInt(entry.receipt.terminalPosition));
      assert.equal(read.receipt.projectionSchemaVersion, 3); assert.equal(read.receipt.operation, "get-full-note");
      assert.deepEqual(scopeOf(read.receipt.scope), scopeOf(expectedScope)); assert.deepEqual(scopeOf(entry.receipt.scope), scopeOf(expectedScope));
      assert.equal(read.content.selectionScope.sessionId, f.rootSessionId); assert.equal(read.receipt.imageSha256, manifest.databaseSha256);
      assert.equal(read.receipt.projectionGeneration, manifest.generation); assert.equal(observation.success?.afterFailure, false);
      assert.equal(JSON.stringify(read).includes("fixture_secret"), false); assertFrozenDetached(read);
      assert.equal(observation.close?.code, 0); assert.deepEqual(observation.stages, ["admission", "projection-wait", "capture", "validate", "query", "revalidate"]);
      emitEvidence(t, { caseId: `round-trip-${entry.kind}-root` as CaseId, outcome: "expected-success", fixture: fixtureBlock(f), write: writeBlock(entry.ids, entry.receipt),
        read: readBlock(observation, binding, entry.receipt.recordId, read, { code: null, cleanup: "complete", ownerState: "available" }), upgrade: null,
        identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: emittedIdentity(observation, binding, "read"), cleanup: null },
        configuration, observations: observationsBlock(f, { adapterReusable: true, closed: true, read: observation }) });
    }
    const v1Read = await adapter.queryFullNote(fullNote(v1Receipt.recordId, v1Receipt.terminalPosition)), v1Observation = lastFork(isRead)!;
    assert.equal(v1Read.content.item!.recordKind, "insight"); assert.equal(v1Read.content.item!.bodyAvailability, "absent"); assert.equal(v1Read.content.item!.content, null);
    assert.equal(v1Read.content.item!.verificationMethod, "governed-note-unverified-v1"); assert.equal(v1Read.receipt.projectionSchemaVersion, 3);
    for (const caseId of ["v1-kind-absent", "v1-recovery-v2"] as const) emitEvidence(t, { caseId, outcome: "expected-success", fixture: fixtureBlock(f),
      write: writeBlock(v1Command, recovered.receipt, caseId === "v1-recovery-v2" ? { ...recoveryIds, recoveryDisposition: "committed" } : {}),
      read: readBlock(v1Observation, binding, v1Receipt.recordId, v1Read, { code: null, cleanup: "complete", ownerState: "available" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: emittedIdentity(v1Observation, binding, "read"), cleanup: null },
      configuration, observations: observationsBlock(f, { adapterReusable: true, closed: true, read: v1Observation }) });
    // Old route on the same schema3 image remains summary-only and old-shaped.
    const old = await adapter.query({ operation: "get-canonical-record", consistency: "session-strong", minimumEventPosition: created[0]!.receipt.terminalPosition, budgetMs: 5000,
      parameters: { id: created[0]!.receipt.recordId } });
    if (old.content.operation !== "get-canonical-record") assert.fail("expected old get"); assert.ok(old.content.item);
    assert.equal(old.content.item.text, "g11 session-log summary [REDACTED]"); for (const key of ["recordKind", "bodyAvailability", "content"]) assert.equal(key in old.content.item, false);
    assert.equal(JSON.stringify(old).includes("Literal **markdown**"), false); assert.ok(lastFork(isRead)!.success!.bytes <= 16384);
    await closeComplete(adapter, binding); adapter = undefined;
    assertWriterHealthy(f);
    // Pre-effect authority/source/key refusals: original IDs retained, no append.
    const refusal = async (caseId: CaseId, command: GovernedNoteCommandV2, act: () => Promise<unknown>, code?: string) => {
      const before = f.observations();
      await assert.rejects(act(), (error: unknown) => { if (code) assert.equal((error as { code?: string }).code, code); return true; });
      const after = f.observations(); assert.equal(after.pairs, before.pairs); assert.equal(after.ownerReusable, true); assert.equal(after.privacyLeaks, 0);
      emitEvidence(t, { caseId, outcome: "expected-refusal", fixture: fixtureBlock(f), write: writeBlock(command, null, { scope: expectedScope }), read: null, upgrade: null,
        identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer: writerIdentity(f), reader: null, cleanup: null },
        configuration: f.evidenceConfiguration(), observations: observationsBlock(f) });
    };
    const ineligible = { ...commandV2(f, "insight"), provenance: [{ kind: "retained-evidence" as const, identity: randomUUID() }] };
    await refusal("ineligible-source-refused", ineligible, async () => f.run.createV2(f.permit, await f.prepareCreateV2(ineligible)), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
    await f.controls({ kind: "evidence-key-status", purpose: "data-key-wrap", ref: { keyId: "g10/data-key-wrap", version: "1" }, status: "revoked" });
    const keyless = commandV2(f, "mistake");
    await refusal("source-key-unavailable", keyless, async () => f.run.createV2(f.permit, await f.prepareCreateV2(keyless)), "GOVERNED_NOTE_KEY_UNAVAILABLE");
    await f.controls({ kind: "evidence-key-status", purpose: "data-key-wrap", ref: { keyId: "g10/data-key-wrap", version: "1" }, status: "available" });
    const revokedCommand = commandV2(f, "adr"), revokedPrepared = await f.prepareCreateV2(revokedCommand);
    await f.controls({ kind: "capability-key-status", purpose: "root-session-handle", keyId: "g10/root-session-handle/1", status: "revoked" });
    const revokedIndex = f.evidenceConfiguration().capabilityKeys.findIndex(key => key.purpose === "root-session-handle");
    assert.equal(f.evidenceConfiguration().capabilityKeys[revokedIndex]!.status, "revoked"); assert.equal(f.observations().statuses[revokedIndex * 2], 2);
    await refusal("revoked-refused", revokedCommand, () => f.run.createV2(f.permit, revokedPrepared));
  } finally { await adapter?.close(); await f.cleanup(); }
});

test("native_full_note_round_trip_four_kinds direct_child_scope_and_real_sibling", { timeout: 240000 }, async t => {
  const f = await makeV2({ child: true, scenario: "full-note-sibling-v2" }); const adapters: VerifiedReadAdapter[] = [];
  try {
    const facts = f.observations().scenario; assert.ok(facts && facts.name === "full-note-sibling-v2", "real worker-local sibling facts required");
    assert.notEqual(facts.siblingSessionId, f.childSessionId); assert.equal(facts.siblingActive, true);
    const command = commandV2(f, "insight"), ids = { commandId: command.commandId, idempotencyKey: command.idempotencyKey };
    const receipt = await f.run.createV2(f.permit, await f.prepareCreateV2(command)); assert.equal(receipt.scope.sessionId, f.childSessionId);
    const binding = await f.verifiedReadBinding(receipt), writer = writerIdentity(f);
    const own = createVerifiedReadAdapter(binding); adapters.push(own);
    const read = await own.queryFullNote(fullNote(receipt.recordId, receipt.terminalPosition)), observation = lastFork(isRead)!;
    assert.equal(read.content.item!.content!.body, redactedBody("insight")); assert.equal(read.content.item!.sessionId, f.childSessionId);
    assert.equal(read.receipt.scope.sessionId, f.childSessionId); assert.equal(read.content.selectionScope.sessionId, f.childSessionId); assertFrozenDetached(read);
    await closeComplete(own, binding);
    emitEvidence(t, { caseId: "round-trip-insight-child", outcome: "expected-success", fixture: fixtureBlock(f), write: writeBlock(ids, receipt),
      read: readBlock(observation, binding, receipt.recordId, read, { code: null, cleanup: "complete", ownerState: "available" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: emittedIdentity(observation, binding, "read"), cleanup: null },
      configuration: f.evidenceConfiguration(), observations: observationsBlock(f, { adapterReusable: true, closed: true, read: observation }) });
    // Real same-store sibling session selection cannot see the direct child's session-scoped note.
    const siblingBinding: VerifiedReadBinding = { ...binding, session: { sessionId: facts.siblingSessionId, minimumEventPosition: receipt.terminalPosition }, compositionEpoch: `${binding.compositionEpoch}-sibling` };
    const sibling = createVerifiedReadAdapter(siblingBinding); adapters.push(sibling);
    const refused = await sibling.queryFullNote(fullNote(receipt.recordId, receipt.terminalPosition)), siblingObservation = lastFork(isRead)!;
    assert.equal(refused.content.item, null); assert.equal(refused.receipt.scope.sessionId, facts.siblingSessionId); assert.equal(refused.receipt.projectionSchemaVersion, 3);
    assert.equal(JSON.stringify(refused).includes("Literal **markdown**"), false);
    await closeComplete(sibling, siblingBinding);
    emitEvidence(t, { caseId: "sibling-refused", outcome: "expected-refusal", fixture: fixtureBlock(f), write: writeBlock(ids, receipt),
      read: readBlock(siblingObservation, siblingBinding, receipt.recordId, refused, { code: null, cleanup: "complete", ownerState: "available" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: emittedIdentity(siblingObservation, siblingBinding, "read"), cleanup: null },
      configuration: f.evidenceConfiguration(), observations: observationsBlock(f, { adapterReusable: true, closed: true, read: siblingObservation }) });
    assertWriterHealthy(f);
  } finally { for (const adapter of adapters) await adapter.close(); await f.cleanup(); }
});

test("native_full_note_round_trip_four_kinds ended_authority_refuses_without_append", { timeout: 240000 }, async t => {
  const f = await makeV2({ child: true, scenario: "full-note-child-terminal-v2" }); let adapter: VerifiedReadAdapter | undefined;
  try {
    const a = commandV2(f, "insight"), receipt = await f.run.createV2(f.permit, await f.prepareCreateV2(a));
    const b = commandV2(f, "adr"), preparedB = await f.prepareCreateV2(b);
    const recovery = await f.prepareRecoveryV2(a), recoveryIds = { operationId: recovery.request.operationId, requestId: recovery.request.requestId };
    const facts = f.observations().scenario; assert.ok(facts && facts.name === "full-note-child-terminal-v2", "real worker-local completion facts required");
    assert.equal(facts.originalCommandId, a.commandId); assert.equal(facts.originalIdempotencyKey, a.idempotencyKey);
    assert.ok(BigInt(facts.terminalPosition) > BigInt(receipt.terminalPosition)); assert.equal(facts.state, "completed");
    const before = f.observations();
    await assert.rejects(f.run.createV2(f.permit, preparedB)); await assert.rejects(f.run.recoverV2(f.permit, recovery));
    assert.equal(f.observations().pairs, before.pairs); assert.equal(f.observations().ownerReusable, true);
    // Consumer publishes through the actual lifecycle terminal position.
    const binding = await f.verifiedReadBinding(receipt);
    const manifest = parseProjectionManifestV3(JSON.parse(readFileSync(join(binding.projectionDirectory.canonicalPath, "projection-manifest.json"), "utf8")), binding.projectionBinding);
    assert.ok(BigInt(manifest.terminalEventPosition) >= BigInt(facts.terminalPosition));
    adapter = createVerifiedReadAdapter(binding);
    const outcome = await adapter.queryFullNote(fullNote(receipt.recordId, facts.terminalPosition)).then(value => value, (error: { code?: string }) => error);
    const observation = lastFork(isRead)!;
    const read = "receipt" in outcome ? outcome as VerifiedFullNoteReadResultV1 : null;
    if (read) { assert.ok(BigInt(read.receipt.projectionEventPosition) >= BigInt(facts.terminalPosition)); assert.equal(read.receipt.projectionSchemaVersion, 3); }
    // Ended authority refuses new effects only; already committed history stays readable at the lifecycle terminal.
    assert.ok(read, "committed note remains readable after child completion"); assert.equal(read.content.item!.content!.body, redactedBody("insight"));
    const diagnostic = await adapter.close(); adapter = undefined; assert.equal(diagnostic.cleanup, "complete");
    emitEvidence(t, { caseId: "ended-refused", outcome: "expected-refusal", fixture: fixtureBlock(f),
      write: writeBlock(a, receipt, { ...recoveryIds, recoveryDisposition: "refused" }),
      read: readBlock(observation, binding, receipt.recordId, read, { code: read ? null : (outcome as { code?: string }).code ?? null, cleanup: "complete", ownerState: "available" }),
      upgrade: null, identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer: writerIdentity(f), reader: emittedIdentity(observation, binding, "read"), cleanup: null },
      configuration: f.evidenceConfiguration(), observations: observationsBlock(f, { adapterReusable: true, closed: read ? true : null, read: observation,
        detail: null }) });
    t.diagnostic(`ended-authority stale B command ${b.commandId} refused before append; read outcome=${read ? "success" : (outcome as { code?: string }).code}`);
  } finally { await adapter?.close(); await f.cleanup(); }
});

test("native_escaped_65536_body_and_old_route_bounds", { timeout: 240000 }, async t => {
  const f = await makeV2(); let adapter: VerifiedReadAdapter | undefined;
  try {
    const body = "x" + "\"\\\t\r\n".repeat(13107); assert.equal(Buffer.byteLength(body, "utf8"), 65536);
    const before = f.observations();
    for (const bad of ["x".repeat(65537), "\u0000x", "x\ud800", " \r\n\t"]) await assert.rejects(f.prepareCreateV2(commandV2(f, "adr", bad)));
    assert.equal(f.observations().pairs, before.pairs);
    const command = { ...commandV2(f, "adr", body), summary: "g11 escaped summary" }, ids = { commandId: command.commandId, idempotencyKey: command.idempotencyKey };
    const receipt = await f.run.createV2(f.permit, await f.prepareCreateV2(command));
    const binding = await f.verifiedReadBinding(receipt); adapter = createVerifiedReadAdapter(binding);
    const read = await adapter.queryFullNote(fullNote(receipt.recordId, receipt.terminalPosition)), observation = lastFork(isRead)!;
    assert.equal(read.content.item!.content!.body, body); assert.equal(read.content.item!.recordKind, "adr");
    const completeReplyBytes = observation.success!.bytes, metadataBytes = observation.success!.metadataBytes;
    assert.ok(completeReplyBytes > 16384 && completeReplyBytes <= 262144, `complete protocol4 envelope ${completeReplyBytes}`);
    assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") <= 131074); assert.ok(metadataBytes <= 65536, `body-free metadata ${metadataBytes}`);
    const old = await adapter.query({ operation: "get-canonical-record", consistency: "session-strong", minimumEventPosition: receipt.terminalPosition, budgetMs: 5000,
      parameters: { id: receipt.recordId } }), oldObservation = lastFork(isRead)!;
    if (old.content.operation !== "get-canonical-record") assert.fail("expected old get");
    assert.equal(old.content.item?.text, "g11 escaped summary"); assert.equal("content" in old.content.item!, false);
    const oldReplyBytes = oldObservation.success!.bytes; assert.ok(oldReplyBytes <= 16384, `old reply ${oldReplyBytes}`);
    await closeComplete(adapter, binding); adapter = undefined;
    emitEvidence(t, { caseId: "escaped-65536-old-route", outcome: "expected-success", fixture: fixtureBlock(f), write: writeBlock(ids, receipt),
      read: readBlock(observation, binding, receipt.recordId, read, { code: null, cleanup: "complete", ownerState: "available" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer: writerIdentity(f), reader: emittedIdentity(observation, binding, "read"), cleanup: null },
      configuration: f.evidenceConfiguration(), observations: observationsBlock(f, { adapterReusable: true, closed: true, read: observation,
        detail: { bodyBytes: Buffer.byteLength(body, "utf8"), completeReplyBytes, metadataBytes, oldReplyBytes } }) });
  } finally { await adapter?.close(); await f.cleanup(); }
});

test("native_same_position_upgrade", { timeout: 120000 }, async t => {
  const base = await nativeFixtures.deployMeasuredNativeFixture(); let adapter: VerifiedReadAdapter | undefined, closed = false, started = false;
  try {
    const f = asNativeV3(base);
    const corpus = await f.appendCorpus(); const before = await f.publish(); assert.equal(before.schemaVersion, 2); started = true;
    const tailBefore = f.eventTail(); assert.equal(tailBefore.position, before.terminalEventPosition); assert.equal(tailBefore.hash, before.terminalEventHash);
    adapter = createVerifiedReadAdapter(f.binding);
    const request = fullNote(corpus.ids.canonical, before.terminalEventPosition, "project-strong");
    // A sufficient-position schema2 image alone never yields full-note success or a summary.
    await assert.rejects(adapter.queryFullNote({ ...request, budgetMs: 1000 }), (error: { code?: string }) => ["PROJECTION_LAG", "WORKER_TIMEOUT"].includes(error.code ?? ""));
    let settled = false; const pending = adapter.queryFullNote(request).finally(() => { settled = true; });
    await until(() => { const current = lastFork(isRead); return !!current && current.stages.includes("projection-wait") && current.ids !== null && current.close === null; }, 3000, "projection wait");
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(settled, false, "sufficient schema2 must keep waiting");
    const after = await f.publishV3(); const tailAfter = f.eventTail();
    assert.equal(after.schemaVersion, 3); assert.notEqual(after.generation, before.generation);
    assert.equal(after.terminalEventPosition, before.terminalEventPosition); assert.equal(after.terminalEventHash, before.terminalEventHash); assert.deepEqual(tailAfter, tailBefore);
    const read = await pending, observation = lastFork(isRead)!;
    assert.equal(read.receipt.projectionSchemaVersion, 3); assert.equal(read.receipt.projectionGeneration, after.generation);
    assert.equal(read.receipt.projectionEventPosition, before.terminalEventPosition); assert.equal(read.receipt.projectionEventHash, before.terminalEventHash);
    assert.equal(read.receipt.imageSha256, after.databaseSha256);
    // Generic (non-governed) canonical item: unknown kind, absent body, separate summary intact.
    assert.equal(read.content.item!.recordKind, null); assert.equal(read.content.item!.bodyAvailability, "absent"); assert.equal(read.content.item!.content, null);
    assert.equal(read.content.item!.text, "native canonical projected summary"); assertFrozenDetached(read);
    closed = (await adapter.close()).cleanup === "complete"; assert.equal(closed, true); adapter = undefined;
    assert.equal(await new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory).inspect(), null);
    const identities = { buildIdentityHash: f.measuredBuildHash, writer: null, reader: emittedIdentity(observation, f.binding, "read"), cleanup: null };
    const readValue = readBlock(observation, f.binding, corpus.ids.canonical, read, { code: null, cleanup: "complete", ownerState: "available" });
    emitEvidence(t, { caseId: "same-position-upgrade", outcome: "expected-success", fixture: null, write: null, read: readValue,
      upgrade: { before: { schemaVersion: before.schemaVersion, generation: before.generation, position: before.terminalEventPosition, eventHash: before.terminalEventHash, imageSha256: before.databaseSha256 },
        after: { schemaVersion: after.schemaVersion, generation: after.generation, position: after.terminalEventPosition, eventHash: after.terminalEventHash, imageSha256: after.databaseSha256 },
        tailBefore: { ...tailBefore }, tailAfter: { ...tailAfter }, eventAppendCountDelta: Number(BigInt(tailAfter.count) - BigInt(tailBefore.count)) },
      identities, configuration: null, observations: observationsBlock(null, { adapterReusable: true, closed: true, read: observation }) });
    emitEvidence(t, { caseId: "generic-kind-absent", outcome: "expected-success", fixture: null, write: null, read: readValue, upgrade: null, identities, configuration: null,
      observations: observationsBlock(null, { adapterReusable: true, closed: true, read: observation }) });
  } finally { const diagnostic = await adapter?.close(); if (closed || !started || diagnostic?.cleanup === "complete") base.cleanup(); else t.diagnostic("Retained same-position native fixture (uncertain read closure)"); }
});

/** Compiled test helper with fixed fault modes; the real emitted child keeps the positive cases. */
function helperAdapter(binding: VerifiedReadBinding, readMode: string, cleanupMode = "cleanup-measured") {
  const ownership = new VerifiedReadOwnershipRepository(binding.executorStateDirectory);
  const adapter = createVerifiedReadAdapter(binding, { ownership, now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms),
    clear: timer => clearTimeout(timer as NodeJS.Timeout), currentEpoch: () => binding.compositionEpoch,
    spawnOwned(kind): OwnedReadProcess {
      const child = childProcessModule.fork(COMPILED_HELPER, [kind === "read" ? readMode : cleanupMode], { cwd: binding.projectionDirectory.canonicalPath, execArgv: [], windowsHide: true,
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}, stdio: ["ignore", "pipe", "pipe", "ipc"] } as ForkOptions);
      const errors = new Set<(error: unknown) => void>(); child.on("error", error => { for (const callback of errors) callback(error); });
      return { get pid() { return child.pid; }, send(value) { child.send(value, error => { if (error) for (const callback of errors) callback(error); }); },
        onMessage(callback) { child.on("message", callback); return () => { child.off("message", callback); }; },
        onExit(callback) { child.on("close", callback); return () => { child.off("close", callback); }; },
        onOutput(callback) { const out = (bytes: Buffer) => callback("stdout", bytes), err = (bytes: Buffer) => callback("stderr", bytes);
          child.stdout!.on("data", out); child.stderr!.on("data", err); return () => { child.stdout!.off("data", out); child.stderr!.off("data", err); }; },
        onError(callback) { errors.add(callback); return () => { errors.delete(callback); }; }, terminate() { child.kill("SIGKILL"); }, unref() { child.unref(); child.channel?.unref(); } };
    } });
  return { adapter, ownership };
}
const isHelper = (mode: string) => (value: ForkObservation) => samePath(value.path, COMPILED_HELPER) && value.mode === mode;
async function allHelpersClosed() { await until(() => forks.filter(value => samePath(value.path, COMPILED_HELPER)).every(value => value.close !== null), 5000, "helper closure"); }

test("native_full_note_deadline_cancel_fault_and_captured_image", { timeout: 300000 }, async t => {
  const f = await makeV2(); const adapters: VerifiedReadAdapter[] = [];
  try {
    const a = commandV2(f, "insight"), receiptA = await f.run.createV2(f.permit, await f.prepareCreateV2(a));
    const b = commandV2(f, "mistake"), receiptB = await f.run.createV2(f.permit, await f.prepareCreateV2(b));
    const binding = await f.verifiedReadBinding(receiptA), projection = binding.projectionDirectory.canonicalPath;
    const lock = join(projection, ".projection-manifest.publish.lock"), writer = writerIdentity(f), configuration = f.evidenceConfiguration();
    for (const [caseId, mode, marker, cancel] of [["native-deadline", "full-note-query-hang", "full-note-query-blocked", false],
      ["native-cancel", "full-note-query-hang", "full-note-query-blocked", true], ["native-packing-fault", "full-note-packing-hang", "full-note-packing-blocked", false]] as const) {
      if (existsSync(join(projection, marker))) unlinkSync(join(projection, marker));
      const { adapter, ownership } = helperAdapter(binding, mode); adapters.push(adapter);
      let ticks = 0; const timer = setInterval(() => ticks++, 10), arrival = performance.now(), abort = new AbortController();
      try {
        const outcome = adapter.queryFullNote(fullNote(receiptA.recordId, receiptA.terminalPosition, "session-strong", 2000), { signal: abort.signal }).then(() => null, (error: { code?: string }) => error.code ?? null);
        await until(() => existsSync(join(projection, marker)), 1900, `${mode} barrier`);
        assert.match(readFileSync(join(projection, marker), "utf8"), /^validated-image-owned-lock-/u);
        if (cancel) abort.abort();
        const code = await outcome; assert.equal(code, cancel ? "WORKER_CLOSED" : "WORKER_TIMEOUT");
        const elapsedMs = Math.round(performance.now() - arrival); assert.ok(elapsedMs <= 3000); assert.ok(ticks >= 5, "parent responsive while child blocked synchronously");
        const diagnostic = await adapter.close(); assert.equal(diagnostic.cleanup, "complete"); assert.equal(diagnostic.code, code);
        const read = lastFork(isHelper(mode))!; await until(() => read.close !== null && !!lastFork(isHelper("cleanup-measured"))?.close, 5000, "exact owned closes");
        const cleanup = lastFork(isHelper("cleanup-measured"))!;
        assert.notEqual(read.close!.code, 0); assert.equal(read.success, null); assert.deepEqual([cleanup.close!.code, cleanup.close!.signal], [0, null]);
        assert.equal(existsSync(lock), false); assert.equal(await ownership.inspect(), null);
        emitEvidence(t, { caseId, outcome: "expected-refusal", fixture: fixtureBlock(f), write: writeBlock(a, receiptA),
          read: readBlock(read, binding, receiptA.recordId, null, { code, cleanup: "complete", ownerState: "closed" }), upgrade: null,
          identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: helperIdentity(read), cleanup: helperIdentity(cleanup) },
          configuration, observations: observationsBlock(f, { adapterReusable: false, lockClosed: !existsSync(lock), read, cleanup,
            detail: { phaseOrdinal: read.stages.length, phase: read.stages.at(-1) ?? null, actualReadBudgetMs: 2000, elapsedMs,
              parentResponsive: ticks >= 5, independentWriterSurvived: f.observations().ownerReusable && f.observations().openWriterConnectionCount === 1 } }) });
      } finally { clearInterval(timer); }
    }
    assertWriterHealthy(f);
    // Same captured image: replacing the named generation after locked capture cannot change the reply.
    const manifest = parseProjectionManifestV3(JSON.parse(readFileSync(join(projection, "projection-manifest.json"), "utf8")), binding.projectionBinding);
    const original = readFileSync(join(projection, manifest.databaseFile)); assert.equal(sha256(original), manifest.databaseSha256);
    const { adapter: capture } = helperAdapter(binding, "full-note-capture-replace"); adapters.push(capture);
    const stable = await capture.queryFullNote(fullNote(receiptA.recordId, receiptA.terminalPosition)), captureRead = lastFork(isHelper("full-note-capture-replace"))!;
    assert.equal(readFileSync(join(projection, "full-note-capture-replaced"), "utf8"), manifest.databaseFile);
    assert.notEqual(sha256(readFileSync(join(projection, manifest.databaseFile))), manifest.databaseSha256, "replacement occurred after capture");
    assert.equal(stable.content.item!.content!.body, redactedBody("insight")); assert.equal(stable.receipt.imageSha256, manifest.databaseSha256);
    assert.equal((await capture.close()).cleanup, "complete"); await allHelpersClosed();
    emitEvidence(t, { caseId: "captured-image-stable", outcome: "expected-success", fixture: fixtureBlock(f), write: writeBlock(a, receiptA),
      read: readBlock(captureRead, binding, receiptA.recordId, stable, { code: null, cleanup: "complete", ownerState: "closed" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: helperIdentity(captureRead), cleanup: null },
      configuration, observations: observationsBlock(f, { adapterReusable: false, closed: true, read: captureRead, detail: { replacementAfterCapture: true, returnedCapturedImage: true } }) });
    // Whole-checksum adversary: unselected governed row changed with a self-consistent body hash, metadata generation and image SHA recomputed,
    // while the governedNotes whole checksum is left stale. Raw SHA verification passes; captured-image validation must refuse.
    const scratch = join(projection, `..`, `g11-tamper-${randomUUID()}.sqlite`); writeFileSync(scratch, original);
    const generation = Math.max(manifest.generation, manifest.highestObservedGeneration) + 1;
    const db = new DatabaseSync(scratch);
    try {
      const tampered = "tampered unselected governed body";
      const changed = db.prepare("UPDATE governed_notes SET body = ?, body_content_hash = ? WHERE item_id = ?").run(tampered, governedNoteBodyHash({ format: "markdown", body: tampered }), receiptB.recordId);
      assert.equal(Number(changed.changes), 1); db.prepare("UPDATE projection_metadata SET generation = ?").run(generation);
    } finally { db.close(); }
    const tamperedBytes = readFileSync(scratch); rmSync(scratch, { force: true });
    const tamperedManifest = { ...manifest, generation, highestObservedGeneration: generation, databaseFile: `projections-3-${generation}.sqlite`, databaseSha256: sha256(tamperedBytes) };
    publishProjectionManifest({ projectionDirectory: projection, manifest: tamperedManifest, expectedBinding: binding.projectionBinding },
      { beforeManifestInstall: { install(directory) { writeFileSync(join(directory, tamperedManifest.databaseFile), tamperedBytes); } } });
    assert.equal(sha256(readFileSync(join(projection, tamperedManifest.databaseFile))), tamperedManifest.databaseSha256, "image SHA recomputed");
    const native = createVerifiedReadAdapter(binding); adapters.push(native);
    await assert.rejects(native.queryFullNote(fullNote(receiptA.recordId, receiptA.terminalPosition)), { code: "INTEGRITY_FAILURE" });
    const checksumRead = lastFork(isRead)!; assert.equal(checksumRead.success, null); assert.ok(checksumRead.stages.includes("validate")); assert.equal(checksumRead.stages.includes("query"), false);
    await closeComplete(native, binding);
    emitEvidence(t, { caseId: "whole-checksum-refused", outcome: "expected-refusal", fixture: fixtureBlock(f), write: writeBlock(b, receiptB),
      read: readBlock(checksumRead, binding, receiptA.recordId, null, { code: "INTEGRITY_FAILURE", cleanup: "complete", ownerState: "closed" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer, reader: emittedIdentity(checksumRead, binding, "read"), cleanup: null },
      configuration, observations: observationsBlock(f, { adapterReusable: false, lockClosed: !existsSync(lock), read: checksumRead, detail: { imageShaRecomputed: true, wholeChecksumMismatch: true } }) });
    assertWriterHealthy(f);
  } finally { for (const adapter of adapters) await adapter.close(); await allHelpersClosed().catch(() => undefined); await f.cleanup(); }
});

test("late_full_note_success_cannot_override_uncertain_cleanup", { timeout: 240000 }, async t => {
  const f = await makeV2(); let adapter: VerifiedReadAdapter | undefined, retained = false;
  try {
    const a = commandV2(f, "session-log"), original = { commandId: a.commandId, idempotencyKey: a.idempotencyKey }; // original IDs before dispatch
    const receipt = await f.run.createV2(f.permit, await f.prepareCreateV2(a));
    const binding = await f.verifiedReadBinding(receipt), projection = binding.projectionDirectory.canonicalPath, writerBefore = f.observations();
    const owned = helperAdapter(binding, "full-note-late-success", "cleanup-hang"); adapter = owned.adapter;
    const helperCount = () => forks.filter(value => samePath(value.path, COMPILED_HELPER)).length, spawnedBefore = helperCount();
    const outcome = adapter.queryFullNote(fullNote(receipt.recordId, receipt.terminalPosition, "session-strong", 1500)).then(() => null, (error: { code?: string }) => error.code ?? null);
    const queued = adapter.queryFullNote(fullNote(receipt.recordId, receipt.terminalPosition, "session-strong", 15000)).then(() => null, (error: { code?: string }) => error.code ?? null);
    await until(() => existsSync(join(projection, "full-note-late-held")), 1400, "late success withheld");
    assert.equal(readFileSync(join(projection, "full-note-late-held"), "utf8"), "success");
    assert.equal(await outcome, "WORKER_TIMEOUT"); const failedAt = performance.now();
    const read = lastFork(isHelper("full-note-late-success"))!;
    await until(() => read.success !== null, 2000, "late success delivered after failure");
    assert.equal(read.success!.afterFailure, true, "success arrived only after the lane failed");
    await until(() => existsSync(join(projection, "cleanup-blocked")), 2500, "cleanup barrier");
    await until(() => adapter!.diagnostic().cleanup === "incomplete", 3000, "cleanup uncertainty");
    const uncertainAfterMs = Math.round(performance.now() - failedAt); assert.ok(uncertainAfterMs <= 3000, `one cleanup deadline ${uncertainAfterMs}`);
    assert.equal(await queued, "WORKER_UNAVAILABLE");
    await assert.rejects(adapter.queryFullNote(fullNote(receipt.recordId, receipt.terminalPosition)), { code: "WORKER_UNAVAILABLE" });
    assert.equal(helperCount(), spawnedBefore + 2, "no replacement owner/process after quarantine");
    const diagnostic = await adapter.close(); assert.equal(diagnostic.cleanup, "incomplete"); assert.equal(diagnostic.code, "WORKER_TIMEOUT");
    const retainedOwnership = await owned.ownership.inspect(); assert.notEqual(retainedOwnership, null, "original read ownership retained");
    retained = true;
    // Read-owner quarantine is not writer uncertainty: the same writer owner/generation stays reusable.
    const writerAfter = f.observations(); assert.equal(writerAfter.ownerReusable, true); assert.equal(writerAfter.ownerGeneration, writerBefore.ownerGeneration);
    assert.equal(writerAfter.createPosts, writerBefore.createPosts); assertWriterHealthy(f);
    const recovery = await f.prepareRecoveryV2(original), recoveryIds = { operationId: recovery.request.operationId, requestId: recovery.request.requestId };
    const recovered = await f.run.recoverV2(f.permit, recovery);
    assert.equal(recovered.outcome, "committed"); if (recovered.outcome !== "committed") throw new Error("expected committed");
    assert.equal(recovered.receipt.recordId, receipt.recordId); assert.equal(recovered.receipt.commandId, original.commandId);
    const cleanup = lastFork(isHelper("cleanup-hang"))!; await until(() => read.close !== null && cleanup.close !== null, 5000, "exact owned closes");
    emitEvidence(t, { caseId: "late-success-uncertain-cleanup", outcome: "expected-uncertainty", fixture: fixtureBlock(f, true),
      write: writeBlock(original, recovered.receipt, { ...recoveryIds, recoveryDisposition: "committed" }),
      read: readBlock(read, binding, receipt.recordId, null, { code: "WORKER_TIMEOUT", cleanup: "incomplete", ownerState: "quarantined" }), upgrade: null,
      identities: { buildIdentityHash: binding.expectedRelease.buildIdentityHash, writer: writerIdentity(f), reader: helperIdentity(read), cleanup: helperIdentity(cleanup) },
      configuration: f.evidenceConfiguration(), observations: observationsBlock(f, { adapterReusable: false, lockClosed: !existsSync(join(projection, ".projection-manifest.publish.lock")),
        read, cleanup, detail: { lateSuccessObserved: true, futureReadRefused: true, originalOwnerRetained: true } }) });
    t.diagnostic("Uncertain late-success read owner retained with its original ownership record; no reset or replacement owner");
  } finally { await adapter?.close(); await allHelpersClosed().catch(() => undefined); await f.cleanup(); if (!retained) t.diagnostic("late-success fixture closed before uncertainty classification"); }
});

test("native_full_note_evidence_inventory_is_exact", () => {
  assert.deepEqual([...emittedCases].sort(), [...EVIDENCE_CASES].sort());
  assert.ok(evidenceAggregateBytes <= EVIDENCE_AGGREGATE_LIMIT);
});
