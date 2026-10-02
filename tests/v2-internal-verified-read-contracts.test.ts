import assert from "node:assert/strict";
import test from "node:test";
import { decodeVerifiedReadRequest, resolveVerifiedReadBudget, decodeVerifiedReadReceipt,
  decodeReadBootstrap, decodeReadCancel, decodeReadReply, decodeCleanupBootstrap,
  decodeCleanupReply, verifiedReadFailure } from "../src/orchestrator/verified-read/protocol.js";
import { READ_UUID, READ_HASH, readRequest, readReceipt, readBootstrap } from "./support/v2-verified-read-fixture.js";
const invalid = { code: "FRESH_START_INPUT_INVALID" };
test("caller defaults and explicit wire budget", () => {
  assert.equal(resolveVerifiedReadBudget("session-strong"), 2000);
  assert.equal(resolveVerifiedReadBudget("project-strong"), 5000);
  assert.equal(resolveVerifiedReadBudget("project-strong", 0), 0);
  for (const budgetMs of [-1, 30001, 0.5, NaN, Infinity]) assert.throws(() => resolveVerifiedReadBudget("project-strong", budgetMs), invalid);
  const { budgetMs: _, ...request } = readRequest();
  assert.throws(() => decodeVerifiedReadRequest(request, null), invalid);
  assert.equal(decodeVerifiedReadRequest({ ...readRequest(), budgetMs: 0 }, null).budgetMs, 0);
  assert.throws(() => decodeVerifiedReadRequest({ operation: "sql", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 30001 }, null), invalid);
});
test("canonical INT64 positions and trusted session minimum", () => {
  for (const minimumEventPosition of ["01", "-1", "1.0", "9223372036854775808", 0, "9".repeat(10000)])
    assert.throws(() => decodeVerifiedReadRequest({ ...readRequest(), minimumEventPosition }, null), invalid);
  assert.equal(decodeVerifiedReadRequest({ ...readRequest(), minimumEventPosition: "9223372036854775807" }, null).minimumEventPosition, "9223372036854775807");
  assert.throws(() => decodeVerifiedReadRequest({ ...readRequest(), consistency: "session-strong" }, null), invalid);
  assert.throws(() => decodeVerifiedReadRequest(readRequest(), { sessionId: READ_UUID, minimumEventPosition: "1" }), invalid);
  assert.equal(decodeVerifiedReadRequest({ ...readRequest(), consistency: "session-strong", minimumEventPosition: "1" }, { sessionId: READ_UUID, minimumEventPosition: "1" }).consistency, "session-strong");
});
test("accessors are not invoked", () => {
  let called = 0;
  const request = { ...readRequest() };
  Object.defineProperty(request, "operation", { enumerable: true, get() { called++; throw Error("secret"); } });
  assert.throws(() => decodeVerifiedReadRequest(request, null), invalid);
  const bootstrap = readBootstrap();
  Object.defineProperty(bootstrap.binding.expectedRelease, "releaseId", { enumerable: true, get() { called++; return READ_UUID; } });
  assert.throws(() => decodeReadBootstrap(bootstrap), invalid);
  assert.deepEqual(verifiedReadFailure(Object.defineProperty({}, "code", { get() { called++; return "PROJECTION_LAG"; } })), { code: "WORKER_UNAVAILABLE", cleanup: "pending", positions: null });
  assert.equal(called, 0);
});
test("exact detached receipt keys and immutable private copies", () => {
  const input = readReceipt(); const receipt = decodeVerifiedReadReceipt(input);
  assert.deepEqual(Object.keys(receipt).sort(), ["operation", "consistency", "scope", "releaseId", "controlGeneration", "requiredEventPosition", "projectionGeneration", "projectionEventPosition", "projectionEventHash", "imageSha256", "verification"].sort());
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.scope));
  input.scope.workspaceId = "b".repeat(64); assert.equal(receipt.scope.workspaceId, READ_HASH);
  for (const change of [{ verification: "production-ready" }, { verification: "recovery-verified" }, { operation: "sql" }, { projectionGeneration: 0 }, { projectionGeneration: -1 }, { projectionGeneration: 2147483648 }, { projectionGeneration: Number.MAX_SAFE_INTEGER + 1 }, { releaseId: "bad" }, { imageSha256: "bad" }])
    assert.throws(() => decodeVerifiedReadReceipt({ ...readReceipt(), ...change }), invalid);
  const bootstrap = readBootstrap(); const copy = decodeReadBootstrap(bootstrap);
  assert.ok(Object.isFrozen(copy.binding) && Object.isFrozen(copy.binding.expectedRelease) && Object.isFrozen(copy.binding.deploymentDirectory));
  bootstrap.binding.deploymentDirectory.canonicalPath = "changed"; assert.equal(copy.binding.deploymentDirectory.canonicalPath, "C:/owned");
});
test("multibyte branch bound", () => {
  assert.equal(decodeVerifiedReadReceipt({ ...readReceipt(), scope: { ...readReceipt().scope, branchRef: "é".repeat(512) } }).scope.branchRef, "é".repeat(512));
  assert.throws(() => decodeVerifiedReadReceipt({ ...readReceipt(), scope: { ...readReceipt().scope, branchRef: "é".repeat(513) } }), invalid);
});
test("no escaped handle/content/credential keys", () => {
  for (const key of ["handle", "content", "credential", "path", "callback", "sql", "imageBytes", "manifest"]) {
    assert.throws(() => decodeVerifiedReadReceipt({ ...readReceipt(), [key]: "secret" }), invalid);
    assert.throws(() => decodeVerifiedReadRequest({ ...readRequest(), [key]: "secret" }, null), invalid);
  }
  for (const value of [[], new Date(), Object.create({ ...readRequest() }), { ...readRequest(), [Symbol("hidden")]: 1 }]) assert.throws(() => decodeVerifiedReadRequest(value, null), invalid);
});
test("per-message limits, opaque IDs and tokens", () => {
  const input = readBootstrap();
  assert.equal(decodeReadBootstrap(input).ids.attemptId, "attempt");
  for (const requestId of ["", "é".repeat(65)]) assert.throws(() => decodeReadCancel({ version: 2, ids: { ...input.ids, requestId }, kind: "cancel" }), invalid);
  assert.equal(decodeReadCancel({ version: 2, ids: { ...input.ids, requestId: "é".repeat(64) }, kind: "cancel" }).kind, "cancel");
  for (const lockToken of ["A".repeat(32), "a".repeat(31)]) assert.throws(() => decodeReadBootstrap({ ...input, lockToken }), invalid);
  assert.throws(() => decodeReadBootstrap({ ...input, binding: { ...input.binding, eventsFile: { ...input.binding.eventsFile, path: "é".repeat(1025) } } }), invalid);
  const huge = readBootstrap(); for (const directory of [huge.binding.projectionDirectory, huge.binding.executorStateDirectory, huge.binding.deploymentDirectory]) directory.canonicalPath = "\\".repeat(2048);
  assert.throws(() => decodeReadBootstrap(huge), invalid);
  assert.throws(() => decodeReadBootstrap({ ...input, binding: { ...input.binding, projectionBinding: { ...input.binding.projectionBinding, sessionId: READ_UUID } } }), invalid);
  for (const remainingMs of [-1, 30001, NaN, Infinity]) assert.throws(() => decodeReadBootstrap({ ...input, remainingMs }), invalid);
  assert.equal(decodeReadBootstrap({ ...input, remainingMs: 0.5 }).remainingMs, 0.5);
  assert.throws(() => decodeReadBootstrap({ ...input, binding: { ...input.binding, compositionEpoch: "é".repeat(65) } }), invalid);
  assert.throws(() => decodeReadReply({ version: 2, ids: input.ids, kind: "stage", phase: "capture", observedProjectionPosition: "x".repeat(16385) }), invalid);
});
test("exact reply, fence and cleanup variants", () => {
  const ids = readBootstrap().ids; const base = { version: 2, ids };
  for (const phase of ["admission", "projection-wait", "capture", "validate", "revalidate"])
    assert.equal(decodeReadReply({ ...base, kind: "stage", phase, observedProjectionPosition: null }).kind, "stage");
  const success = { ...base, kind: "success", receipt: readReceipt(), fence: { controlGeneration: "0", releaseId: READ_UUID, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" }, closed: { image: true, reader: true, lock: true } };
  assert.equal(decodeReadReply(success).kind, "success");
  assert.throws(() => decodeReadReply({ ...success, closed: { image: false, reader: true, lock: true } }), invalid);
  assert.throws(() => decodeReadReply({ ...success, fence: { ...success.fence, capturedPosition: "01" } }), invalid);
  assert.equal(decodeReadReply({ ...base, kind: "failure", failure: { code: "PROJECTION_LAG", cleanup: "incomplete", positions: { required: "1", observed: "0" } } }).kind, "failure");
  assert.throws(() => decodeReadReply({ ...base, kind: "failure", failure: { code: "WORKER_TIMEOUT", cleanup: "pending", positions: { required: "1", observed: null } } }), invalid);
  const cleanup = { ...base, version: 1, directory: readBootstrap().binding.projectionDirectory, lockToken: "a".repeat(32), expectedBuildHash: READ_HASH, remainingMs: 2000 };
  assert.equal(decodeCleanupBootstrap(cleanup).remainingMs, 2000);
  assert.throws(() => decodeCleanupBootstrap({ ...cleanup, remainingMs: 2001 }), invalid);
  for (const outcome of ["released", "absent", "poisoned", "failed"]) assert.equal(decodeCleanupReply({ ...base, version: 1, kind: "cleanup", outcome, cleanup: "complete" }).kind, "cleanup");
  assert.throws(() => decodeCleanupReply({ ...base, version: 1, kind: "cleanup", outcome: "unknown", cleanup: "complete" }), invalid);
  assert.throws(() => decodeReadCancel({ ...base, kind: "cancel", reason: "secret" }), invalid);
  for (const decode of [decodeReadBootstrap, decodeReadCancel, decodeReadReply, decodeCleanupBootstrap, decodeCleanupReply, decodeVerifiedReadReceipt]) {
    assert.throws(() => decode(null), invalid);
    assert.throws(() => decode(Object.defineProperty({}, "kind", { enumerable: true, get() { throw Error("getter invoked"); } })), invalid);
  }
});
test("every approved error mapping and safe unknown fallback", () => {
  const codes = ["FRESH_START_INPUT_INVALID", "FRESH_START_CONTEXT_REQUIRED", "FRESH_START_NOT_INITIALIZED", "FRESH_START_IDENTITY_MISMATCH", "FRESH_START_PATH_INVALID", "FRESH_START_PATH_CHANGED", "FRESH_START_BUILD_MISMATCH", "FRESH_START_SCHEMA_MISMATCH", "FRESH_START_RELEASE_MISMATCH", "FRESH_START_ADMISSION_DENIED", "FRESH_START_CONTENT_UNVERIFIED", "FRESH_START_ADMISSION_STALE", "PROJECTION_LAG", "INTEGRITY_FAILURE", "PROJECTION_SCOPE_MISMATCH", "PROJECTION_PATH_INVALID", "MATERIALIZATION_CONFLICT", "WORKER_TIMEOUT", "WORKER_CLOSED", "STORE_QUEUE_FULL", "WORKER_PROTOCOL_ERROR", "WORKER_UNAVAILABLE"];
  for (const code of codes) {
    assert.equal(verifiedReadFailure({ code, message: "C:/secret" }).code, code);
    assert.equal(verifiedReadFailure(new Error(code)).code, code);
  }
  assert.deepEqual(verifiedReadFailure({ code: "PRIVATE_SECRET", cleanup: "complete", positions: { required: "01", observed: "secret" } }), { code: "WORKER_UNAVAILABLE", cleanup: "pending", positions: null });
});
