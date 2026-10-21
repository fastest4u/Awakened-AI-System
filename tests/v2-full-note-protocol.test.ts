import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { decodeFullNoteReadBootstrap, decodeFullNoteReadCancel, decodeFullNoteReadReply } from "../src/orchestrator/verified-read/full-note-protocol.js";
import { decodeReadBootstrap, decodeReadReply, assertReadReplyEnvelope } from "../src/orchestrator/verified-read/protocol.js";
import { readBootstrap, readReceipt, READ_HASH } from "./support/v2-verified-read-fixture.js";
import type { GetFullNoteRequest } from "../src/orchestrator/verified-read/full-note-contracts.js";
const request: GetFullNoteRequest = { operation: "get-full-note", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters: { id: "record" } };
function success(body = '"'.repeat(65536)): any {
  const boot = readBootstrap(), receipt = { ...readReceipt(), operation: "get-full-note", projectionSchemaVersion: 3 };
  const selectionScope = { projectId: receipt.scope.projectId, workspaceId: receipt.scope.workspaceId, branchScopeId: null, branchRef: null, sessionId: null, visibility: "branch" };
  return { version: 4, ids: boot.ids, kind: "success", receipt,
    fence: { controlGeneration: "0", releaseId: receipt.releaseId, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" },
    closed: { image: true, reader: true, lock: true }, content: { operation: "get-full-note", noteBoundsVersion: "v2-full-note-bounds-1", selectionScope, conflict: null,
      item: { id: "record", kind: "canonical", ...selectionScope, status: "candidate", confidence: "low", verificationMethod: "governed-note-unverified-v2",
        validFrom: null, validTo: null, knownFromEventPosition: "0", sourceEventPosition: "0", textKind: "canonical-summary", text: "Separate summary",
        conflictGroupId: null, supersedingItemId: null, recordKind: "insight", bodyAvailability: "present", content: { format: "markdown", body,
          contentHash: createHash("sha256").update("project-memory/governed-note-body/v1\n").update(JSON.stringify({ body, format: "markdown" })).digest("hex") } } } };
}
const invalid = { code: "FRESH_START_INPUT_INVALID" };
test("protocol4_only_admits_full_note", () => {
  const input = { ...readBootstrap(), version: 4, request };
  const out = decodeFullNoteReadBootstrap(input); assert.equal(out.version, 4); assert.equal(out.request.operation, "get-full-note");
  assert.equal(decodeFullNoteReadCancel({ version: 4, ids: out.ids, kind: "cancel" }).version, 4);
  for (const change of [{ version: 3 }, { extra: true }, { request: readBootstrap().request }, { remainingMs: 30001 }]) assert.throws(() => decodeFullNoteReadBootstrap({ ...input, ...change }), invalid);
  assert.throws(() => decodeReadBootstrap(input), invalid);
  assert.throws(() => decodeFullNoteReadCancel({ version: 3, ids: out.ids, kind: "cancel" }), invalid);
  for (const kind of ["stage", "failure"] as const) {
    const value = kind === "stage" ? { version: 4, ids: out.ids, kind, phase: "query", observedProjectionPosition: "0" }
      : { version: 4, ids: out.ids, kind, failure: { code: "INTEGRITY_FAILURE", cleanup: "complete", positions: null } };
    assert.equal(decodeFullNoteReadReply(value, request).kind, kind);
    assert.throws(() => decodeFullNoteReadReply({ ...value, content: success().content }, request), invalid);
    if (kind === "failure") assert.throws(() => decodeFullNoteReadReply({ ...value, failure: { code: "INTEGRITY_FAILURE", cleanup: "complete", positions: null, body: "x".repeat(20000) } }, request), invalid);
  }
});
test("full_note_transport_owns_maximum_body_and_refuses_independent_relationship_forgery", t => {
  const input = success(), out = decodeFullNoteReadReply(input, request); assert.equal(out.kind, "success");
  if (out.kind !== "success") assert.fail();
  assert.equal(out.receipt.projectionSchemaVersion, 3); assert.equal(out.content.item!.content!.body.length, 65536);
  assert.ok(Object.isFrozen(out.content.item!.content)); input.content.item.content.body = "changed"; assert.notEqual(out.content.item!.content!.body, "changed");
  const maximum = success(), bytes = Buffer.byteLength(JSON.stringify(maximum)); maximum.content.item.content.body = "";
  const metadata = Buffer.byteLength(JSON.stringify(maximum)); assert.equal(bytes - metadata, 131072); assert.ok(bytes <= 262144 && metadata <= 65536);
  t.diagnostic(`actual maximum transport bytes=${bytes}; metadata=${metadata}; body JSON=131074; valid 262144 positive is unreachable under conjunctive caps`);
  const mutations: ((r: any) => void)[] = [r => r.version = 3, r => r.receipt.operation = "get-canonical-record", r => r.receipt.projectionSchemaVersion = 2,
    r => r.receipt.projectionGeneration = 0, r => r.receipt.imageSha256 = "bad", r => r.content.operation = "get-canonical-record", r => r.closed.reader = false,
    r => r.content.item.id = "another", r => r.content.item.content.contentHash = "f".repeat(64), r => r.content.item.recordKind = "unknown",
    r => r.content.item.bodyAvailability = "absent", r => r.receipt.scope.body = "x".repeat(20000), r => r.fence.body = "x".repeat(20000), r => r.ids.body = "x".repeat(20000),
    r => r.content.item.text = "x".repeat(2049), r => r.content.conflict = { body: "x".repeat(20000) }, r => r.extra = true];
  for (const mutate of mutations) { const r = success(); mutate(r); assert.throws(() => decodeFullNoteReadReply(r, request), invalid); }
  assert.throws(() => decodeReadReply(success()), invalid);
  for (const total of [262144, 262145]) { const r = success("x"); const overhead = Buffer.byteLength(JSON.stringify(r)) - 1;
    r.content.item.content.body = "x".repeat(total - overhead); assert.equal(Buffer.byteLength(JSON.stringify(r)), total);
    assert.throws(() => decodeFullNoteReadReply(r, request), invalid); }
});
test("family_ids_and_discriminants_refuse_before_body_traversal_or_proxy_reflection", t => {
  const ids = readBootstrap().ids;
  for (const mutate of [(r: any) => r.version = 3, (r: any) => r.ids.attemptId = "other", (r: any) => r.kind = "other",
    (r: any) => r.receipt.operation = "get-canonical-record", (r: any) => r.content.operation = "get-canonical-record"]) {
    const r = success(); mutate(r); const target = r.content.item; let traversals = 0;
    const original = Object.getOwnPropertyDescriptor;
    const mock = t.mock.method(Object, "getOwnPropertyDescriptor", (value: object, key: PropertyKey) => { if (value === target) traversals++; return original(value, key); });
    try { assert.throws(() => assertReadReplyEnvelope(r, 4, ids), invalid); assert.equal(traversals, 0); } finally { mock.mock.restore(); }
  }
  let traps = 0; const proxy = new Proxy(success(), { ownKeys() { traps++; return []; }, getOwnPropertyDescriptor() { traps++; return undefined; }, getPrototypeOf() { traps++; return null; } });
  assert.throws(() => assertReadReplyEnvelope(proxy, 4, ids), invalid); assert.equal(traps, 0);
});
