import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { decodeVerifiedReadRequest, decodeReadBootstrap, decodeReadReply, decodeReadCancel,
  decodeCleanupBootstrap, decodeVerifiedReadReceipt, verifiedReadFailure } from "../src/orchestrator/verified-read/protocol.js";
import { READ_UUID, READ_HASH, readBootstrap, readReceipt, ownedReadDirectory } from "./support/v2-verified-read-fixture.js";
import { executeVerifiedRead } from "../src/orchestrator/verified-read/child.js";
import { createVerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";

const invalid = { code: "FRESH_START_INPUT_INVALID" };
const ranking = "retrieval-ranking-v2-shadow-fixed-units";
const bounds = "v2-native-content-bounds-1";
type ContentApi = {
  decodeNativeContentResult(value: unknown): unknown;
  assertNativeContentMatchesRequest(content: unknown, request: unknown, binding: unknown, receipt: unknown): void;
};
type WireApi = { copyBoundedProtocolData(value: unknown, maximum: 8192 | 16384): unknown; encodedProtocolBytes(value: unknown): number };
async function load<T>(name: string): Promise<T> {
  let found: unknown;
  try { found = await import(`../src/orchestrator/verified-read/${name}.js`); }
  catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.ok(found, `${name} must export the bounded native content implementation`);
  return found as T;
}
function request(operation = "search-projected-content", parameters: unknown = { query: "needle" }) {
  return { operation, consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters };
}
function selectionScope() {
  return { projectId: READ_UUID, workspaceId: READ_HASH, branchScopeId: null, branchRef: null, sessionId: null, visibility: "branch" };
}
function item() {
  return { id: "Case-ID ", kind: "canonical", projectId: READ_UUID, workspaceId: READ_HASH,
    branchScopeId: null, branchRef: null, sessionId: null, visibility: "branch", status: "superseded",
    confidence: "high", verificationMethod: "asserted", validFrom: null, validTo: null,
    knownFromEventPosition: "1", sourceEventPosition: "2", textKind: "canonical-summary", text: "projected summary",
    conflictGroupId: null as string | null, supersedingItemId: "successor" as string | null };
}
function searchItem() { return { ...item(), channels: ["exact"], selectionReason: "exact" }; }
function search() {
  return { operation: "search-projected-content", selectionScope: selectionScope(), rankingPolicyVersion: ranking,
    contentBoundsVersion: bounds, items: [searchItem()], conflicts: [] as { conflictGroupId: string; eligibleMemberCount: number; returnedMemberCount: number; highImpact: boolean; truncated: boolean }[],
    candidateBounded: false, selectionTruncated: false, byteBounded: false };
}
function get() { return { operation: "get-canonical-record", selectionScope: selectionScope(), item: item(),
  conflict: null as null | { conflictGroupId: string; eligibleMemberCount: number; returnedMemberCount: number; truncated: boolean } }; }
function receipt(operation = "search-projected-content") { return { ...readReceipt(), operation, projectionEventPosition: "3" }; }
function reply(content: unknown = search()) {
  return { version: 2, ids: readBootstrap().ids, kind: "success", receipt: receipt(),
    fence: { controlGeneration: "0", releaseId: READ_UUID, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" },
    closed: { image: true, reader: true, lock: true }, content };
}
function paddedEnvelope(value: ReturnType<typeof readBootstrap>, target: number) {
  const seed = structuredClone(value); seed.version = 2;
  const paths = [seed.binding.eventsFile, seed.binding.projectionDirectory, seed.binding.executorStateDirectory, seed.binding.deploymentDirectory];
  seed.binding.eventsFile.path = "x";
  for (const directory of paths.slice(1)) (directory as { canonicalPath: string }).canonicalPath = "x";
  let needed = target - Buffer.byteLength(JSON.stringify(seed));
  for (const entry of paths) {
    const take = Math.min(2047, Math.floor(needed / 2));
    const text = "x" + "\\".repeat(take); needed -= take * 2;
    if ("path" in entry) entry.path = text; else entry.canonicalPath = text;
  }
  if (needed === 1) seed.binding.deploymentDirectory.canonicalPath += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(seed)), target);
  return seed;
}

// Catches skipped pre/post-normalization limits, ID normalization and caller authority injection.
test("unicode_and_complete_bootstrap_bounds", () => {
  const decoded = decodeVerifiedReadRequest(request("search-projected-content", { query: "  Ｎｅｅｄｌｅ  " }), null) as unknown as { parameters: { query: string; limit: number } };
  assert.deepEqual(decoded.parameters, { query: "Needle", limit: 5 });
  for (const limit of [1, 10]) assert.equal((decodeVerifiedReadRequest(request(undefined, { query: "x", limit }), null) as unknown as { parameters: { limit: number } }).parameters.limit, limit);
  for (const limit of [0, 11, 1.5, null]) assert.throws(() => decodeVerifiedReadRequest(request(undefined, { query: "x", limit }), null), invalid);
  for (const query of [" ", "x\u0000", "x\n", "x".repeat(1025), "é".repeat(513), "ﷺ".repeat(100)])
    assert.throws(() => decodeVerifiedReadRequest(request(undefined, { query }), null), invalid);
  assert.equal((decodeVerifiedReadRequest(request(undefined, { query: "é".repeat(512) }), null) as unknown as { parameters: { query: string } }).parameters.query, "é".repeat(512));
  for (const id of ["Case-ID ", "é".repeat(256)]) assert.equal((decodeVerifiedReadRequest(request("get-canonical-record", { id }), null) as unknown as { parameters: { id: string } }).parameters.id, id);
  for (const id of ["", "é".repeat(257), "x\r"]) assert.throws(() => decodeVerifiedReadRequest(request("get-canonical-record", { id }), null), invalid);
  for (const parameters of [{ query: "x", validAt: "2026-10-01" }, { query: "x", validAt: "2026-02-30T00:00:00.000Z" },
    { query: "x", knownAt: "01" }, { query: "x", knownAt: "9223372036854775808" }, { query: "x", visibility: "session" },
    { query: "x", sessionId: READ_UUID }, { query: "x", sql: "SELECT secret" }, { query: "x", limit: undefined }])
    assert.throws(() => decodeVerifiedReadRequest(request(undefined, parameters), null), invalid);
  const trusted = { sessionId: READ_UUID, minimumEventPosition: "0" };
  assert.doesNotThrow(() => decodeVerifiedReadRequest(request(undefined, { query: "x", visibility: "session", validAt: "2026-10-01T00:00:00.000Z", knownAt: "9223372036854775807" }), trusted));
  assert.equal(decodeReadBootstrap(paddedEnvelope(readBootstrap(), 8192)).version, 2);
  assert.throws(() => decodeReadBootstrap(paddedEnvelope(readBootstrap(), 8193)), invalid);
  // NFKC expansion must not move a normalized outgoing bootstrap past the complete-envelope cap.
  assert.throws(() => decodeReadBootstrap(paddedEnvelope({ ...readBootstrap(), request: request(undefined, { query: "㍿" }) }, 8192)), invalid);
  const bootstrap = { ...readBootstrap(), version: 2, request: request(undefined, { query: "x".repeat(1024) }) };
  for (const directory of [bootstrap.binding.projectionDirectory, bootstrap.binding.executorStateDirectory, bootstrap.binding.deploymentDirectory]) directory.canonicalPath = "\\".repeat(1400);
  assert.throws(() => decodeReadBootstrap(bootstrap), invalid);
});

// Catches getters/iteration, array holes and omission of each independent copying bound.
test("strict_v2_variants_and_dense_arrays", async () => {
  const wire = await load<WireApi>("wire-data"); const api = await load<ContentApi>("content-protocol");
  let getterCalls = 0, toJSONCalls = 0;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { getterCalls++; return "secret"; } });
  const jsonHook = { toJSON() { toJSONCalls++; return {}; } };
  for (const value of [accessor, jsonHook, new Date(), Object.create({}), { [Symbol("s")]: 1 }]) assert.throws(() => wire.copyBoundedProtocolData(value, 8192), invalid);
  const arrayAccessor = Object.defineProperty([1], "0", { enumerable: true, get() { getterCalls++; return 1; } });
  for (const value of [new Array(1), arrayAccessor, Object.assign([1], { extra: 2 }), Object.assign([1], { [Symbol("s")]: 1 }), Object.setPrototypeOf([1], null), Array(65).fill(0)])
    assert.throws(() => wire.copyBoundedProtocolData(value, 8192), invalid);
  assert.equal(getterCalls, 0); assert.equal(toJSONCalls, 0);
  assert.equal((wire.copyBoundedProtocolData(Array(64).fill(0), 8192) as unknown[]).length, 64);
  const containers = (n: number) => [Array.from({ length: 63 }, () => ({})), Array.from({ length: n - 66 }, () => ({}))];
  assert.doesNotThrow(() => wire.copyBoundedProtocolData(containers(128), 8192));
  assert.throws(() => wire.copyBoundedProtocolData(containers(129), 8192), invalid);
  const nested = (depth: number): unknown => depth === 0 ? {} : { nested: nested(depth - 1) };
  assert.doesNotThrow(() => wire.copyBoundedProtocolData(nested(8), 8192));
  assert.throws(() => wire.copyBoundedProtocolData(nested(9), 8192), invalid);
  assert.doesNotThrow(() => wire.copyBoundedProtocolData({ text: "é".repeat(1024) }, 8192));
  assert.throws(() => wire.copyBoundedProtocolData({ text: "é".repeat(1024) + "x" }, 8192), invalid);
  assert.doesNotThrow(() => wire.copyBoundedProtocolData(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [String(i), 0])), 8192));
  assert.throws(() => wire.copyBoundedProtocolData(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), 0])), 8192), invalid);
  for (const maximum of [8192, 16384] as const) {
    const texts = Array(maximum === 8192 ? 4 : 8).fill("\\".repeat(1020));
    texts[0] += "x".repeat(maximum - Buffer.byteLength(JSON.stringify(texts)));
    assert.equal(wire.encodedProtocolBytes(wire.copyBoundedProtocolData(texts, maximum)), maximum);
    texts[0] += "x"; assert.throws(() => wire.copyBoundedProtocolData(texts, maximum), invalid);
  }
  for (const wrong of [1, 3, "2"]) {
    assert.throws(() => decodeReadBootstrap({ ...readBootstrap(), version: wrong }), invalid);
    assert.throws(() => decodeReadReply({ ...reply(), version: wrong }), invalid);
    assert.throws(() => decodeReadCancel({ version: wrong, ids: readBootstrap().ids, kind: "cancel" }), invalid);
  }
  assert.equal(decodeReadCancel({ version: 2, ids: readBootstrap().ids, kind: "cancel" }).version, 2);
  assert.equal(decodeReadReply({ version: 2, ids: readBootstrap().ids, kind: "stage", phase: "query", observedProjectionPosition: "3" }).kind, "stage");
  assert.equal(decodeCleanupBootstrap({ version: 1, ids: readBootstrap().ids, directory: readBootstrap().binding.projectionDirectory, lockToken: "a".repeat(32), expectedBuildHash: READ_HASH, remainingMs: 2000 }).version, 1);
  for (const change of [{ items: Array(11).fill(searchItem()) }, { conflicts: Array(65).fill({ conflictGroupId: "g", eligibleMemberCount: 1, returnedMemberCount: 0, highImpact: false, truncated: true }) },
    { items: [{ ...searchItem(), channels: Array(8).fill("exact") }] }, { items: [{ ...searchItem(), channels: ["exact", "exact"] }] }, { items: [{ ...searchItem(), channels: ["sql"] }] },
    { items: [{ ...searchItem(), channels: ["lexical"], selectionReason: "exact" }] }]) assert.throws(() => api.decodeNativeContentResult({ ...search(), ...change }), invalid);
  const copy = api.decodeNativeContentResult(search()) as ReturnType<typeof search>;
  assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.items) && Object.isFrozen(copy.items[0].channels));
  assert.doesNotThrow(() => api.decodeNativeContentResult({ ...search(), items: Array.from({ length: 10 }, (_, i) => ({ ...searchItem(), id: String(i) })) }));
  assert.doesNotThrow(() => api.decodeNativeContentResult({ ...search(), items: [], conflicts: Array.from({ length: 64 }, (_, i) => ({ conflictGroupId: String(i), eligibleMemberCount: 1, returnedMemberCount: 0, highImpact: false, truncated: true })) }));
  assert.doesNotThrow(() => api.decodeNativeContentResult({ ...search(), items: [{ ...searchItem(), channels: ["exact", "alias", "lexical", "symbol-path", "session-checkpoint", "open-follow-up", "conflict-closure"] }] }));
  for (const malformed of [new Array(1), arrayAccessor, Object.assign([searchItem()], { extra: "secret" }), Object.assign([searchItem()], { [Symbol("hidden")]: 1 }), Object.setPrototypeOf([searchItem()], null)])
    assert.throws(() => api.decodeNativeContentResult({ ...search(), items: malformed }), invalid);
  assert.equal(getterCalls, 0); assert.equal(toJSONCalls, 0);
});

// Catches a fabricated metadata success and scope/identity/count/position substitutions.
test("content_relationships_and_metadata_shape", async () => {
  const api = await load<ContentApi>("content-protocol");
  const binding = readBootstrap().binding;
  const match = (content: unknown, req: unknown = request(), rec: unknown = receipt(), bound: unknown = binding) => api.assertNativeContentMatchesRequest(api.decodeNativeContentResult(content), req, bound, rec);
  assert.doesNotThrow(() => match(search()));
  assert.doesNotThrow(() => match(get(), request("get-canonical-record", { id: "Case-ID " }), receipt("get-canonical-record")));
  const metadata = reply(); const { content: _, ...withoutContent } = metadata;
  assert.equal(decodeReadReply({ ...withoutContent, receipt: readReceipt() }).kind, "success");
  assert.deepEqual(Object.keys(decodeVerifiedReadReceipt(readReceipt())).sort(), ["operation", "consistency", "scope", "releaseId", "controlGeneration", "requiredEventPosition", "projectionGeneration", "projectionEventPosition", "projectionEventHash", "imageSha256", "verification"].sort());
  assert.throws(() => decodeReadReply({ ...metadata, receipt: readReceipt() }), invalid);
  assert.throws(() => decodeReadReply(withoutContent), invalid);
  assert.throws(() => decodeReadReply({ ...metadata, content: get() }), invalid);
  assert.equal(decodeReadReply(metadata).kind, "success");
  for (const field of ["projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility"] as const)
    assert.throws(() => match({ ...search(), selectionScope: { ...selectionScope(), [field]: field === "visibility" ? "workspace" : field === "branchRef" ? "other" : "22222222-2222-4222-8222-222222222222" } }), invalid);
  for (const change of [{ projectId: READ_HASH }, { workspaceId: "b".repeat(64) }, { branchScopeId: READ_UUID }, { branchRef: "other" }, { visibility: "session", sessionId: READ_UUID },
    { status: "retracted" }, { status: "expired" }, { status: "erased-evidence" }, { knownFromEventPosition: "3", sourceEventPosition: "2" }, { sourceEventPosition: "4" },
    { knownFromEventPosition: "01" }, { sourceEventPosition: "9223372036854775808" }, { textKind: "projection-text" }])
    assert.throws(() => match({ ...search(), items: [{ ...searchItem(), ...change }] }), invalid);
  assert.throws(() => match({ ...search(), items: [searchItem(), searchItem()] }), invalid);
  assert.throws(() => match({ ...search(), items: [searchItem(), { ...searchItem(), id: "other" }] }, request(undefined, { query: "x", limit: 1 })), invalid);
  assert.throws(() => match(search(), request(), receipt("get-canonical-record")), invalid);
  assert.throws(() => match({ ...search(), rankingPolicyVersion: "invented" }), invalid);
  assert.throws(() => match({ ...search(), contentBoundsVersion: "invented" }), invalid);
  assert.throws(() => match({ ...get(), item: { ...item(), id: "successor" } }, request("get-canonical-record", { id: "Case-ID " }), receipt("get-canonical-record")), invalid);
  assert.throws(() => match({ ...get(), item: { ...item(), kind: "lexical", textKind: "projection-text" } }, request("get-canonical-record", { id: "Case-ID " }), receipt("get-canonical-record")), invalid);
  const grouped = { ...search(), items: [{ ...searchItem(), conflictGroupId: "g" }], conflicts: [{ conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, highImpact: false, truncated: true }] };
  assert.doesNotThrow(() => match(grouped));
  for (const conflicts of [[], [grouped.conflicts[0], grouped.conflicts[0]], [{ ...grouped.conflicts[0], returnedMemberCount: 0 }], [{ ...grouped.conflicts[0], eligibleMemberCount: 0 }], [{ ...grouped.conflicts[0], truncated: false }]])
    assert.throws(() => match({ ...grouped, conflicts }), invalid);
  const groupGet = { ...get(), item: { ...item(), conflictGroupId: "g" }, conflict: { conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, truncated: true } };
  assert.doesNotThrow(() => match(groupGet, request("get-canonical-record", { id: "Case-ID " }), receipt("get-canonical-record")));
  for (const conflict of [null, { ...groupGet.conflict, conflictGroupId: "other" }, { ...groupGet.conflict, eligibleMemberCount: 0 }, { ...groupGet.conflict, returnedMemberCount: 0 }, { ...groupGet.conflict, truncated: false }])
    assert.throws(() => match({ ...groupGet, conflict }, request("get-canonical-record", { id: "Case-ID " }), receipt("get-canonical-record")), invalid);
  assert.throws(() => api.decodeNativeContentResult({ ...get(), item: null, conflict: groupGet.conflict }), invalid);
  assert.throws(() => match(search(), request(undefined, { query: "x", knownAt: "1" })), invalid);
  const timed = { ...search(), items: [{ ...searchItem(), validFrom: "2026-10-01T00:00:00.000Z", validTo: "2026-10-02T00:00:00.000Z" }] };
  assert.doesNotThrow(() => match(timed, request(undefined, { query: "x", validAt: "2026-10-01T00:00:00.000Z" })));
  assert.throws(() => match(timed, request(undefined, { query: "x", validAt: "2026-10-02T00:00:00.000Z" })), invalid);
  const sessionBinding = { ...binding, session: { sessionId: READ_UUID, minimumEventPosition: "0" } };
  const sessionResult = { ...search(), selectionScope: { ...selectionScope(), sessionId: READ_UUID, visibility: "session" }, items: [{ ...searchItem(), sessionId: READ_UUID, visibility: "session" }] };
  assert.doesNotThrow(() => match(sessionResult, request(), receipt(), sessionBinding));
  assert.throws(() => match(sessionResult, request(undefined, { query: "x", visibility: "branch" }), receipt(), sessionBinding), invalid);
  assert.deepEqual(verifiedReadFailure({ code: "V2_CONTENT_RESULT_TOO_LARGE", message: "query ID text C:/runtime token SELECT secret" }), { code: "V2_CONTENT_RESULT_TOO_LARGE", cleanup: "pending", positions: null });
  try { decodeVerifiedReadRequest(request(undefined, { query: "secret\nID C:/runtime token SELECT text" }), null); assert.fail(); }
  catch (error) { assert.equal((error as Error).message, "FRESH_START_INPUT_INVALID"); }
});

for (const operation of ["search-projected-content", "get-canonical-record"] as const) {
  const foreignSession = "22222222-2222-4222-8222-222222222222";
  for (const scenario of [
    { name: "bound foreign project", bound: true, sessionId: foreignSession, visibility: "project" },
    { name: "bound foreign branch", bound: true, sessionId: foreignSession, visibility: "branch" },
    { name: "sessionless foreign project", bound: false, sessionId: foreignSession, visibility: "project" },
    { name: "sessionless foreign branch", bound: false, sessionId: foreignSession, visibility: "branch" },
    { name: "bound trusted project", bound: true, sessionId: READ_UUID, visibility: "project" },
    { name: "bound trusted branch", bound: true, sessionId: READ_UUID, visibility: "branch" },
    { name: "bound null session", bound: true, sessionId: null, visibility: "session" },
    { name: "sessionless null session", bound: false, sessionId: null, visibility: "session" },
    { name: "bound foreign session", bound: true, sessionId: foreignSession, visibility: "session" },
  ]) {
    test(`item_session direct rejects ${operation} ${scenario.name}`, async () => {
      const api = await load<ContentApi>("content-protocol");
      const binding = { ...readBootstrap().binding, session: scenario.bound ? { sessionId: READ_UUID, minimumEventPosition: "0" } : null };
      const scope = { ...selectionScope(), sessionId: binding.session?.sessionId ?? null, visibility: scenario.bound ? "session" : "branch" };
      const forged = operation === "search-projected-content"
        ? { ...search(), selectionScope: scope, items: [{ ...searchItem(), sessionId: scenario.sessionId, visibility: scenario.visibility }] }
        : { ...get(), selectionScope: scope, item: { ...item(), sessionId: scenario.sessionId, visibility: scenario.visibility } };
      const req = request(operation, operation === "search-projected-content" ? { query: "needle" } : { id: "Case-ID " });
      assert.equal(receipt(operation).scope.sessionId, null); // Project-strong receipt does not erase trusted selection authority.
      const decoded = api.decodeNativeContentResult(forged); // No malformed envelope or exact-ID substitution masks the boundary.
      assert.throws(() => api.assertNativeContentMatchesRequest(decoded, req, binding, receipt(operation)), invalid);
    });
  }
  for (const scenario of [
    { name: "bound trusted session", bound: true, sessionId: READ_UUID, visibility: "session" },
    { name: "bound null project", bound: true, sessionId: null, visibility: "project" },
    { name: "bound null branch", bound: true, sessionId: null, visibility: "branch" },
    { name: "sessionless null project", bound: false, sessionId: null, visibility: "project" },
    { name: "sessionless null branch", bound: false, sessionId: null, visibility: "branch" },
  ]) {
    test(`item_session direct accepts ${operation} ${scenario.name}`, async () => {
      const api = await load<ContentApi>("content-protocol");
      const binding = { ...readBootstrap().binding, session: scenario.bound ? { sessionId: READ_UUID, minimumEventPosition: "0" } : null };
      const scope = { ...selectionScope(), sessionId: binding.session?.sessionId ?? null, visibility: scenario.bound ? "session" : "branch" };
      const content = operation === "search-projected-content"
        ? { ...search(), selectionScope: scope, items: [{ ...searchItem(), sessionId: scenario.sessionId, visibility: scenario.visibility }] }
        : { ...get(), selectionScope: scope, item: { ...item(), sessionId: scenario.sessionId, visibility: scenario.visibility } };
      assert.doesNotThrow(() => api.assertNativeContentMatchesRequest(content,
        request(operation, operation === "search-projected-content" ? { query: "needle" } : { id: "Case-ID " }), binding, receipt(operation)));
    });
  }
}

test("complete_reply_escaped_byte_boundary", async () => {
  const api = await load<ContentApi>("content-protocol");
  const content = { ...search(), items: Array.from({ length: 7 }, (_, i) => ({ ...searchItem(), id: String(i), text: "" })) };
  const envelope = reply(content);
  let needed = 16384 - Buffer.byteLength(JSON.stringify(envelope));
  for (const candidate of content.items) { const take = Math.min(2048, Math.floor(needed / 2)); candidate.text = "\\".repeat(take); needed -= take * 2; }
  if (needed === 1) content.items[6].text += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(envelope)), 16384);
  assert.doesNotThrow(() => decodeReadReply(envelope));
  assert.doesNotThrow(() => api.decodeNativeContentResult(content));
  content.items[6].text += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(envelope)), 16385);
  assert.throws(() => decodeReadReply(envelope), invalid);
});

test("decoded content requires fixed build admission and metadata verify still refuses content", async () => {
  for (const input of [request(), request("get-canonical-record", { id: "Case-ID " })]) {
    const bootstrap = decodeReadBootstrap({ ...readBootstrap(), version: 2, request: input });
    const terminal = await executeVerifiedRead(bootstrap, { now: () => 0, signal: new AbortController().signal,
      inspectBuild() { return "b".repeat(64); },
      async wait() { throw new Error("build refusal must not wait"); },
      emitStage() { throw new Error("build refusal must not emit stages"); } });
    assert.deepEqual(terminal, { version: 2, ids: bootstrap.ids, kind: "failure",
      failure: { code: "FRESH_START_BUILD_MISMATCH", cleanup: "complete", positions: null } });
    const directory = ownedReadDirectory();
    try {
      const adapter = createVerifiedReadAdapter({ ...bootstrap.binding, executorStateDirectory: directory });
      await assert.rejects(adapter.verify(bootstrap.request as unknown as Parameters<typeof adapter.verify>[0]), invalid);
      assert.equal(adapter.diagnostic().pendingCount, 0);
      assert.equal((await adapter.close()).cleanup, "complete");
    } finally { rmSync(directory.canonicalPath, { recursive: true, force: true }); }
  }
});
