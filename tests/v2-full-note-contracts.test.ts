import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as wire from "../src/orchestrator/verified-read/wire-data.js";

async function api() {
  const path = "../src/orchestrator/verified-read/full-note-protocol.js";
  const module = await import(path).catch(() => ({})) as Record<string, (value: unknown, session?: unknown) => any>;
  assert.equal(typeof module.decodeGetFullNoteRequest, "function", "dedicated full-note request decoder exists");
  assert.equal(typeof module.decodeNativeFullNoteResult, "function", "dedicated literal-body result decoder exists");
  return module;
}
const id = "11111111-1111-4111-8111-111111111111";
const scope = { projectId: id, workspaceId: "a".repeat(64), branchScopeId: null, branchRef: null, sessionId: null, visibility: "branch" };
function result(body = "# Literal\r\n\t e\u0301 😀  \n") {
  const contentHash = createHash("sha256").update("project-memory/governed-note-body/v1\n").update(JSON.stringify({ body, format: "markdown" })).digest("hex");
  return { operation: "get-full-note", noteBoundsVersion: "v2-full-note-bounds-1", selectionScope: { ...scope }, conflict: null,
    item: { id, kind: "canonical", ...scope, status: "candidate", confidence: "low", verificationMethod: "governed-note-unverified-v2",
      validFrom: null, validTo: null, knownFromEventPosition: "1", sourceEventPosition: "2", textKind: "canonical-summary", text: "Separate summary",
      conflictGroupId: null, supersedingItemId: null, recordKind: "insight", bodyAvailability: "present", content: { format: "markdown", body, contentHash } } };
}
const invalid = { code: "FRESH_START_INPUT_INVALID" };

// Break caught: full-note request accidentally reuses a widened old route, normalizes IDs, or loses trusted minimum validation.
test("full_note_request_exact_shape_and_inherited_domains", async () => {
  const { decodeGetFullNoteRequest: decode } = await api();
  const input = { operation: "get-full-note", consistency: "project-strong", minimumEventPosition: "9007199254740993", budgetMs: 5000, parameters: { id: "  MiXeD e\u0301  " } };
  assert.equal(decode!(input, null).parameters.id, input.parameters.id);
  assert.equal(decode!({ ...input, parameters: { id: "é".repeat(256) } }, null).parameters.id.length, 256);
  for (const change of [{ operation: "get-canonical-record" }, { extra: true }, { budgetMs: -1 }, { budgetMs: 30001 }, { budgetMs: 1.5 },
    { minimumEventPosition: "01" }, { minimumEventPosition: "9223372036854775808" }, { parameters: { id: "é".repeat(256) + "x" } },
    { parameters: { id: "x\n" } }, { parameters: { id: "" } }, { parameters: { id, limit: 1 } }, { parameters: { id, validAt: "2026-10-10" } },
    { parameters: { id, knownAt: "01" } }, { parameters: { id, visibility: "session" } }, { consistency: "session-strong" }]) assert.throws(() => decode!({ ...input, ...change }, null), invalid);
  const session = { sessionId: id, minimumEventPosition: "9007199254740994" };
  assert.throws(() => decode!(input, session), invalid);
  assert.equal(decode!({ ...input, consistency: "session-strong", minimumEventPosition: session.minimumEventPosition }, session).consistency, "session-strong");
  assert.throws(() => decode!(input, { sessionId: id, minimumEventPosition: "0", extra: true }), invalid);
  let calls = 0; const accessor = Object.defineProperty({}, "operation", { enumerable: true, get() { calls++; return "get-full-note"; } });
  assert.throws(() => decode!(accessor, null), invalid); assert.equal(calls, 0);
});

// Break caught: tuple/hash/ordinary-scalar validation is bypassed by the new body path.
test("full_note_result_exact_tuple_literal_hash_and_owned_copy", async () => {
  const { decodeNativeFullNoteResult: decode } = await api();
  for (const recordKind of ["session-log", "insight", "mistake", "adr"]) {
    const input = result(); input.item.recordKind = recordKind;
    const out = decode!(input); assert.equal(out.item.content.body, input.item.content.body); assert.equal(out.item.text, "Separate summary");
    assert.ok(Object.isFrozen(out.item.content)); input.item.content.body = "changed"; assert.notEqual(out.item.content.body, "changed");
  }
  const maximum = result('"'.repeat(65536)); assert.equal(decode!(maximum).item.content.body.length, 65536);
  for (const body of ["", " \r\n\t", "\ud800", "x\u0001", "x\u007f", "x".repeat(65537)]) assert.throws(() => decode!(result(body)), invalid);
  for (const mutate of [(r: ReturnType<typeof result>) => { r.item.content.contentHash = "b".repeat(64); },
    (r: ReturnType<typeof result>) => { r.item.recordKind = "unknown"; }, (r: ReturnType<typeof result>) => { r.item.bodyAvailability = "absent"; },
    (r: ReturnType<typeof result>) => { r.item.text = "x".repeat(2049); }, (r: ReturnType<typeof result>) => { r.item.textKind = "projection-text"; },
    (r: ReturnType<typeof result>) => { Object.assign(r.item, { metadata: { body: "x".repeat(4096) } }); },
    (r: ReturnType<typeof result>) => { Object.assign(r, { operation: "get-canonical-record" }); }]) { const r = result(); mutate(r); assert.throws(() => decode!(r), invalid); }
  const absent = { ...result(), item: { ...result().item, verificationMethod: "committed-event", recordKind: null, bodyAvailability: "absent", content: null } };
  assert.equal(decode!(absent).item.content, null); assert.equal(decode!({ ...result(), item: null }).item, null);
  assert.throws(() => decode!({ ...absent, item: { ...absent.item, verificationMethod: "governed-note-unverified-v2" } }), invalid);
  assert.throws(() => decode!({ ...result(), item: null, conflict: { conflictGroupId: "g", eligibleMemberCount: 1, returnedMemberCount: 1, truncated: false } }), invalid);
  const conflict = { conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, truncated: true };
  assert.equal(decode!({ ...result(), item: { ...result().item, conflictGroupId: "g" }, conflict }).conflict.truncated, true);
  assert.throws(() => decode!({ ...result(), item: { ...result().item, conflictGroupId: "g" }, conflict: { ...conflict, truncated: false } }), invalid);
});

// Break caught: reflective traps run, or dotted property names gain a body scalar exception.
test("full_note_copy_refuses_traps_and_path_spoofing", async () => {
  await api(); const copy = (wire as unknown as Record<string, (x: unknown) => unknown>).copyBoundedFullNoteResultData!;
  assert.equal(typeof copy, "function"); let traps = 0;
  const proxy = new Proxy(result(), { getPrototypeOf() { traps++; throw new Error("trap"); }, ownKeys() { traps++; throw new Error("trap"); }, get() { traps++; throw new Error("trap"); } });
  assert.throws(() => copy(proxy), invalid); assert.equal(traps, 0);
  const nested = result(); nested.item.content = new Proxy(nested.item.content, { ownKeys() { traps++; throw new Error("trap"); } });
  assert.throws(() => copy(nested), invalid); assert.equal(traps, 0);
  const getter = result(); Object.defineProperty(getter.item.content, "body", { enumerable: true, get() { traps++; return "body"; } });
  assert.throws(() => copy(getter), invalid); assert.equal(traps, 0);
  const hidden = result(); Object.defineProperty(hidden, "hidden", { value: "x" }); assert.throws(() => copy(hidden), invalid);
  assert.throws(() => copy({ ...result(), "item.content.body": "x".repeat(4096) }), invalid);
  assert.throws(() => copy({ ...result(), item: { ...result().item, "content.body": "x".repeat(4096) } }), invalid);
  assert.throws(() => copy({ ...result(), item: { ...result().item, content: [result().item.content] } }), invalid);
  assert.throws(() => copy(Object.assign(new Date(), result())), invalid);
});
