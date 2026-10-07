import assert from "node:assert/strict";
import test from "node:test";
import { decodeVerifiedReadRequest, decodeReadBootstrap, decodeReadReply } from "../src/orchestrator/verified-read/protocol.js";
import { copyBoundedProtocolData } from "../src/orchestrator/verified-read/wire-data.js";
import { READ_UUID, READ_HASH, readBootstrap, readReceipt } from "./support/v2-verified-read-fixture.js";

const invalid = { code: "FRESH_START_INPUT_INVALID" };
const req = (operation: string, parameters: unknown = {}) => ({ operation, parameters,
  consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000 });

// Catches refusing private workflow operations and failing to supply bounded page defaults.
test("workflow_exact_parameters_and_results", () => {
  const value = decodeVerifiedReadRequest(req("list-canonical-records"), null) as unknown as { parameters: { limit: number } };
  assert.equal(value.parameters.limit, 5);
  for (const operation of ["list-canonical-records", "recent-canonical-records", "follow-up-radar"]) {
    for (const limit of [1, 10]) assert.doesNotThrow(() => decodeVerifiedReadRequest(req(operation, { limit }), null));
    for (const limit of [0, 11, 1.5]) assert.throws(() => decodeVerifiedReadRequest(req(operation, { limit }), null), invalid);
  }
  for (const key of ["limit", "tokenBudget", "cursor", "sessionId", "path", "sql"])
    assert.throws(() => decodeVerifiedReadRequest(req("build-context-pack", { query: "native", [key]: 10 }), null), invalid);
  assert.doesNotThrow(() => decodeVerifiedReadRequest(req("build-context-pack", { query: "native" }), null));
});

// Catches invoking descriptor accessors and accepting malformed Unicode at the wire boundary.
test("workflow_descriptor_and_whole_envelope_bounds", () => {
  let getterInvocations = 0;
  const getter = Object.defineProperty({}, "limit", { enumerable: true, get() { getterInvocations++; return 5; } });
  assert.throws(() => decodeVerifiedReadRequest(req("list-canonical-records", getter), null), invalid);
  assert.equal(getterInvocations, 0);
  for (const value of ["\ud800", { "\ud800": 0 }]) assert.throws(() => copyBoundedProtocolData(value, 8192), invalid);
  assert.throws(() => decodeVerifiedReadRequest(req("build-context-pack", { query: "\ud800" }), null), invalid);
  assert.throws(() => decodeVerifiedReadRequest(req("list-canonical-records", { cursor: "\udfff" }), null), invalid);
});

async function api() {
  let loaded: unknown;
  try { loaded = await import(`../src/orchestrator/verified-read/${"workflow-protocol"}.js`); }
  catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.ok(loaded, "workflow decoder must accept strict private results");
  return loaded as { decodeNativeWorkflowResult(value: unknown): unknown;
    decodeNativeWorkflowParameters(operation: string, value: unknown, session: unknown): { limit?: number; query?: string };
    assertNativeWorkflowMatchesRequest(content: unknown, request: unknown, binding: unknown, receipt: unknown): void };
}
const scope = () => ({ projectId: READ_UUID, workspaceId: READ_HASH, branchScopeId: null, branchRef: null, sessionId: null, visibility: "branch" });
const item = (id = "a") => ({ id, kind: "canonical", ...scope(), status: "verified", confidence: "high", verificationMethod: "asserted",
  validFrom: null, validTo: null, knownFromEventPosition: "1", sourceEventPosition: "2", textKind: "canonical-summary", text: "native",
  conflictGroupId: null, supersedingItemId: null });
const page = (operation = "list-canonical-records") => ({ operation, selectionScope: scope(), workflowBoundsVersion: "v2-native-read-workflow-bounds-1",
  order: operation === "list-canonical-records" ? "item-id-binary-asc" : "source-event-position-desc-id-binary-asc",
  items: [{ item: item(), conflict: null }], hasMore: false, nextCursor: null, byteBounded: false });
const context = () => ({ operation: "build-context-pack", selectionScope: scope(), workflowBoundsVersion: "v2-native-read-workflow-bounds-1",
  rankingPolicyVersion: "retrieval-ranking-v2-shadow-fixed-units", items: [{ ...item(), channels: ["exact"], selectionReason: "exact" }], conflicts: [], followUps: [],
  candidateBounded: false, selectionTruncated: false, byteBounded: false });

// Catches intrinsic shape/order/count lies independently of immutable-authority checks.
test("workflow_results_reject_intrinsic_lies_and_freeze_detached_data", async () => {
  const decoder = await api();
  for (const operation of ["list-canonical-records", "recent-canonical-records"]) {
    const source = page(operation);
    const decoded = decoder.decodeNativeWorkflowResult(source) as ReturnType<typeof page>;
    assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.items) && Object.isFrozen(decoded.items[0].item));
    source.items[0].item.text = "mutated"; assert.equal(decoded.items[0].item.text, "native");
    for (const change of [{ order: "caller" }, { hasMore: true }, { nextCursor: "cursor" }, { items: [source.items[0], source.items[0]] },
      { items: new Array(1) }, { extra: 1 }, { items: [{ item: { ...item(), kind: "follow-up", textKind: "projection-text" }, conflict: null }] }])
      assert.throws(() => decoder.decodeNativeWorkflowResult({ ...source, ...change }), invalid);
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...source, items: [], hasMore: true, nextCursor: "cursor" }), invalid);
    const grouped = { item: { ...item(), conflictGroupId: "g" }, conflict: { conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, truncated: true } };
    assert.doesNotThrow(() => decoder.decodeNativeWorkflowResult({ ...source, items: [grouped] }));
    for (const conflict of [null, { ...grouped.conflict, conflictGroupId: "other" }, { ...grouped.conflict, returnedMemberCount: 2 }, { ...grouped.conflict, truncated: false }])
      assert.throws(() => decoder.decodeNativeWorkflowResult({ ...source, items: [{ ...grouped, conflict }] }), invalid);
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...source, items: [
      { ...grouped, conflict: { ...grouped.conflict, eligibleMemberCount: 1, truncated: false } },
      { ...grouped, item: { ...grouped.item, id: "b" }, conflict: { ...grouped.conflict, eligibleMemberCount: 1, truncated: false } },
    ] }), invalid);
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...source, items: [grouped,
      { ...grouped, item: { ...grouped.item, id: "b" }, conflict: { ...grouped.conflict, eligibleMemberCount: 3 } },
    ] }), invalid);
  }
  assert.doesNotThrow(() => decoder.decodeNativeWorkflowResult(context()));
  for (const change of [{ items: Array.from({ length: 11 }, (_, i) => ({ ...context().items[0], id: String(i) })) },
    { items: [context().items[0], context().items[0]] }, { followUps: [item()] }, { followUps: [{ ...item(), kind: "follow-up", textKind: "projection-text", status: "verified" }] }])
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...context(), ...change }), invalid);
});

// Catches applying a cap to content alone, missing escaped JSON overhead or wider workflow arrays.
test("workflow_full_bootstrap_terminal_and_independent_copy_limits", async () => {
  const decoder = await api();
  assert.equal(decoder.decodeNativeWorkflowParameters("list-canonical-records", {}, null).limit, 5);
  assert.throws(() => decoder.decodeNativeWorkflowParameters("build-context-pack", { query: "native", limit: 10 }, null), invalid);
  assert.equal(decoder.decodeNativeWorkflowParameters("build-context-pack", { query: " Ｎａｔｉｖｅ " }, null).query, "Native");
  for (const query of [" ", "x\n", "é".repeat(513), "ﷺ".repeat(100)])
    assert.throws(() => decoder.decodeNativeWorkflowParameters("build-context-pack", { query }, null), invalid);
  const bootstrapAt = (target: number) => {
    const seed = structuredClone({ ...readBootstrap(), request: req("list-canonical-records", { limit: 5 }) });
    const paths = [seed.binding.eventsFile, seed.binding.projectionDirectory, seed.binding.executorStateDirectory, seed.binding.deploymentDirectory];
    seed.binding.eventsFile.path = "x";
    for (const path of paths.slice(1)) (path as { canonicalPath: string }).canonicalPath = "x";
    let needed = target - Buffer.byteLength(JSON.stringify(seed));
    for (const path of paths) {
      const take = Math.min(2047, Math.floor(needed / 2)); const padding = "x" + "\\".repeat(take); needed -= take * 2;
      if ("path" in path) path.path = padding; else path.canonicalPath = padding;
    }
    if (needed === 1) seed.binding.deploymentDirectory.canonicalPath += "x";
    assert.equal(Buffer.byteLength(JSON.stringify(seed)), target); return seed;
  };
  assert.equal(decodeReadBootstrap(bootstrapAt(8192)).version, 2);
  assert.throws(() => decodeReadBootstrap(bootstrapAt(8193)), invalid);
  const content = { ...page(), items: Array.from({ length: 7 }, (_, i) => ({ item: { ...item(String(i)), text: "" }, conflict: null })) };
  const terminal = { version: 2, ids: readBootstrap().ids, kind: "success", content,
    receipt: { ...readReceipt(), operation: "list-canonical-records", projectionEventPosition: "3" },
    fence: { controlGeneration: "0", releaseId: READ_UUID, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" },
    closed: { image: true, reader: true, lock: true } };
  let needed = 16384 - Buffer.byteLength(JSON.stringify(terminal));
  for (const entry of content.items) { const take = Math.min(2048, Math.floor(needed / 2)); entry.item.text = "\\".repeat(take); needed -= take * 2; }
  if (needed === 1) content.items[6].item.text += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(terminal)), 16384);
  assert.doesNotThrow(() => decodeReadReply(terminal));
  content.items[6].item.text += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(terminal)), 16385);
  assert.throws(() => decodeReadReply(terminal), invalid);
  const containers = (n: number) => [Array.from({ length: 63 }, () => ({})), Array.from({ length: n - 66 }, () => ({}))];
  assert.doesNotThrow(() => copyBoundedProtocolData(containers(128), 8192));
  assert.throws(() => copyBoundedProtocolData(containers(129), 8192), invalid);
  const nested = (n: number): unknown => n === 0 ? {} : { child: nested(n - 1) };
  assert.doesNotThrow(() => copyBoundedProtocolData(nested(8), 8192));
  assert.throws(() => copyBoundedProtocolData(nested(9), 8192), invalid);
  for (const maximum of [8192, 16384] as const) {
    const values = Array(maximum === 8192 ? 4 : 8).fill("\\".repeat(1020));
    values[0] += "x".repeat(maximum - Buffer.byteLength(JSON.stringify(values)));
    assert.doesNotThrow(() => copyBoundedProtocolData(values, maximum));
    values[0] += "x"; assert.throws(() => copyBoundedProtocolData(values, maximum), invalid);
  }
  assert.doesNotThrow(() => copyBoundedProtocolData(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [String(i), 0])), 8192));
  assert.throws(() => copyBoundedProtocolData(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), 0])), 8192), invalid);
  assert.doesNotThrow(() => copyBoundedProtocolData("é".repeat(1024), 8192));
  assert.throws(() => copyBoundedProtocolData("é".repeat(1024) + "x", 8192), invalid);
  for (const operation of ["list-canonical-records", "recent-canonical-records", "follow-up-radar"])
    for (const cursor of ["x".repeat(2049), "", "x\n", 0]) assert.throws(() => decodeVerifiedReadRequest(req(operation, { cursor }), null), invalid);
  for (const operation of ["list-canonical-records", "recent-canonical-records", "follow-up-radar", "build-context-pack"]) {
    const parameters = operation === "build-context-pack" ? { query: "é".repeat(512), validAt: "2026-10-01T00:00:00.000Z", knownAt: "9223372036854775807" }
      : { cursor: "é".repeat(1024), limit: 10, validAt: "2026-10-01T00:00:00.000Z", knownAt: "9223372036854775807" };
    const valid = decodeVerifiedReadRequest(req(operation, parameters), null);
    assert.ok(Buffer.byteLength(JSON.stringify(valid)) <= 8192);
    assert.throws(() => decodeVerifiedReadRequest({ ...req(operation, parameters), padding: Array(5).fill("\\".repeat(1024)) }, null), invalid);
  }
});

test("workflow_context_combined_count_conflicts_and_bound_session_radar", async () => {
  const decoder = await api();
  const sessionScope = { ...scope(), sessionId: READ_UUID, visibility: "session" };
  const follow = (id: string, status = "open") => ({ ...item(id), kind: "follow-up", textKind: "projection-text", status, visibility: "session", sessionId: READ_UUID });
  const radar = { ...page("follow-up-radar"), selectionScope: sessionScope, items: [follow("a"), follow("b", "blocked")] };
  const binding = { ...readBootstrap().binding, session: { sessionId: READ_UUID, minimumEventPosition: "0" } };
  const match = (value: unknown, operation: string, parameters: unknown = {}, bound: unknown = binding) => decoder.assertNativeWorkflowMatchesRequest(value,
    req(operation, parameters), bound, { ...readReceipt(), operation, projectionEventPosition: "3" });
  assert.doesNotThrow(() => match(radar, "follow-up-radar"));
  assert.throws(() => decoder.decodeNativeWorkflowResult({ ...context(), selectionScope: sessionScope, followUps: [follow("b"), follow("a")] }), invalid);
  assert.doesNotThrow(() => match({ ...radar, items: [], selectionScope: scope() }, "follow-up-radar", {}, readBootstrap().binding));
  for (const change of [{ kind: "canonical", textKind: "canonical-summary" }, { status: "active" }, { status: "verified" }, { sessionId: null }, { sessionId: "22222222-2222-4222-8222-222222222222" }, { visibility: "branch" }])
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...radar, items: [{ ...follow("a"), ...change }] }), invalid);
  assert.throws(() => match(radar, "follow-up-radar", { visibility: "branch" }), invalid);
  const combined = { ...context(), selectionScope: sessionScope, items: Array.from({ length: 5 }, (_, i) => ({ ...context().items[0], id: String(i) })),
    followUps: Array.from({ length: 5 }, (_, i) => follow(String(i))) };
  assert.doesNotThrow(() => match(combined, "build-context-pack", { query: "native" }));
  assert.throws(() => decoder.decodeNativeWorkflowResult({ ...combined, followUps: [...combined.followUps, follow("z")] }), invalid);
  const rankedFollow = { ...follow("a"), channels: ["open-follow-up"], selectionReason: "open-follow-up" };
  assert.throws(() => decoder.decodeNativeWorkflowResult({ ...combined, items: [rankedFollow], followUps: [follow("a")] }), invalid);
  const grouped = { ...context(), items: [{ ...context().items[0], conflictGroupId: "g" }],
    conflicts: [{ conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, highImpact: true, truncated: true }] };
  assert.doesNotThrow(() => decoder.decodeNativeWorkflowResult(grouped));
  for (const conflicts of [[], [grouped.conflicts[0], grouped.conflicts[0]], [{ ...grouped.conflicts[0], returnedMemberCount: 0 }], [{ ...grouped.conflicts[0], truncated: false }]])
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...grouped, conflicts }), invalid);
  for (const operation of ["recent-canonical-records", "follow-up-radar"]) {
    const entries = operation === "follow-up-radar" ? [follow("b"), { ...follow("a"), sourceEventPosition: "1" }]
      : [{ item: item("b"), conflict: null }, { item: { ...item("a"), sourceEventPosition: "1" }, conflict: null }];
    const ordered = { ...page(operation), ...(operation === "follow-up-radar" ? { selectionScope: sessionScope } : {}), items: entries };
    assert.doesNotThrow(() => decoder.decodeNativeWorkflowResult(ordered));
    assert.throws(() => decoder.decodeNativeWorkflowResult({ ...ordered, items: [...entries].reverse() }), invalid);
  }
});

test("workflow_shared_data_decoders_and_dispatch_never_read_accessors", async () => {
  const data = await import(`../src/orchestrator/verified-read/${"content-data-protocol"}.js`) as {
    decodeNativeContentItem(value: unknown, search: boolean): unknown;
    decodeNativeContentConflict(value: unknown, search: boolean): unknown;
    decodeNativeSelectionScope(value: unknown): unknown;
  };
  const content = await import(`../src/orchestrator/verified-read/${"content-protocol"}.js`) as {
    assertNativeContentMatchesRequest(value: unknown, request: unknown, binding: unknown, receipt: unknown): void;
  };
  let getterInvocations = 0;
  const getter = (source: object, key: string) => Object.defineProperty(source, key, { enumerable: true, get() { getterInvocations++; return "a"; } });
  assert.throws(() => data.decodeNativeContentItem(getter(item(), "id"), false), invalid);
  assert.throws(() => data.decodeNativeContentConflict(getter({ conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, truncated: true }, "conflictGroupId"), false), invalid);
  assert.throws(() => data.decodeNativeSelectionScope(getter(scope(), "projectId")), invalid);
  assert.throws(() => content.assertNativeContentMatchesRequest(getter(page(), "operation"), req("list-canonical-records"), readBootstrap().binding,
    { ...readReceipt(), operation: "list-canonical-records" }), invalid);
  assert.equal(getterInvocations, 0);
});

test("workflow_results_reject_authority_limit_and_eligibility_lies", async () => {
  const decoder = await api(); const bound = readBootstrap().binding;
  const match = (value: unknown, parameters: unknown = {}, binding: unknown = bound) => decoder.assertNativeWorkflowMatchesRequest(value,
    req("list-canonical-records", parameters), binding, { ...readReceipt(), operation: "list-canonical-records", projectionEventPosition: "3" });
  assert.doesNotThrow(() => match(page()));
  for (const key of ["projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility"])
    assert.throws(() => match({ ...page(), selectionScope: { ...scope(), [key]: key === "visibility" ? "project" : "22222222-2222-4222-8222-222222222222" } }), invalid);
  for (const change of [{ sourceEventPosition: "4" }, { knownFromEventPosition: "3" }, { status: "retracted" }, { sessionId: READ_UUID }, { validFrom: "2026-10-02T00:00:00.000Z" }])
    assert.throws(() => match({ ...page(), items: [{ item: { ...item(), ...change }, conflict: null }] }, { knownAt: "2", validAt: "2026-10-01T00:00:00.000Z" }), invalid);
  assert.throws(() => match({ ...page(), items: [{ item: item("a"), conflict: null }, { item: item("b"), conflict: null }] }, { limit: 1 }), invalid);
  assert.throws(() => match({ ...page(), items: [{ item: item("b"), conflict: null }, { item: item("a"), conflict: null }] }), invalid);
});

// Catches caller scope injection and allowing session visibility without a bound session.
test("workflow_request_scope_and_order_lies", () => {
  assert.throws(() => decodeVerifiedReadRequest(req("follow-up-radar", { visibility: "session" }), null), invalid);
  for (const key of ["projectId", "sessionId", "ranker", "budget", "order", "sql"])
    assert.throws(() => decodeVerifiedReadRequest(req("list-canonical-records", { [key]: "caller" }), null), invalid);
  assert.doesNotThrow(() => decodeVerifiedReadRequest(req("follow-up-radar"), null));
});
