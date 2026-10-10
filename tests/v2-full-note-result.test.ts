import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as wire from "../src/orchestrator/verified-read/wire-data.js";

async function api() {
  const path = "../src/orchestrator/verified-read/full-note-result.js";
  const module = await import(path).catch(() => ({})) as Record<string, (candidate: unknown, base: unknown) => any>;
  assert.equal(typeof module.buildNativeFullNoteResult, "function", "whole full-note success budget builder exists"); return module.buildNativeFullNoteResult!;
}
const uuid = "11111111-1111-4111-8111-111111111111", hash = "a".repeat(64);
const scope = { projectId: uuid, vaultId: uuid, storeId: uuid, workspaceId: hash, branchScopeId: null, branchRef: null, sessionId: null };
function candidate(body: string) {
  const contentHash = createHash("sha256").update("project-memory/governed-note-body/v1\n").update(JSON.stringify({ body, format: "markdown" })).digest("hex");
  const { vaultId: _vault, storeId: _store, ...selection } = scope;
  return { operation: "get-full-note", noteBoundsVersion: "v2-full-note-bounds-1", selectionScope: { ...selection, visibility: "branch" }, conflict: null,
    item: { ...selection, id: uuid, kind: "canonical", visibility: "branch", status: "candidate", confidence: "low", verificationMethod: "governed-note-unverified-v2",
      validFrom: null, validTo: null, knownFromEventPosition: "1", sourceEventPosition: "2", textKind: "canonical-summary", text: "summary", conflictGroupId: null,
      supersedingItemId: null, recordKind: "insight", bodyAvailability: "present", content: { format: "markdown", body, contentHash } } };
}
function base() { return { version: 4, kind: "success", ids: { requestId: "r", attemptId: "a", laneEpoch: "e" },
  receipt: { operation: "get-full-note", projectionSchemaVersion: 3, consistency: "project-strong", scope: { ...scope }, releaseId: uuid,
    controlGeneration: "1", requiredEventPosition: "2", projectionGeneration: 1, projectionEventPosition: "2", projectionEventHash: hash, imageSha256: hash,
    verification: "image-scope-position-and-active-admission" },
  fence: { controlGeneration: "1", releaseId: uuid, capturedPosition: "2", capturedHash: hash, requiredPosition: "2" }, closed: { image: true, reader: true, lock: true } }; }

// Break caught: measuring only inner content, stripping supplied base bytes, or allowing old envelope lanes.
test("whole_success_budget_not_only_body", async () => {
  const build = await api(), input = candidate('"'.repeat(65536)), b = base(), out = build(input, b);
  const bytes = wire.encodedProtocolBytes({ ...b, content: out });
  const metadata = wire.encodedProtocolBytes({ ...b, content: { ...out, item: { ...out.item, content: { ...out.item.content, body: "" } } } });
  assert.ok(bytes > 131074 && bytes <= 262144); assert.ok(metadata <= 65536); assert.equal(bytes, metadata + 131072);
  assert.equal(out.item.content.body, input.item.content.body); assert.ok(Object.isFrozen(out.item.content));
  for (const bad of [{ ...b, version: 3 }, { ...b, kind: "stage" }, { ...b, receipt: { ...b.receipt, operation: "get-canonical-record" } },
    { ...b, receipt: { ...b.receipt, projectionSchemaVersion: 2 } }, { ...b, ids: { ...b.ids, requestId: "x".repeat(2049) } },
    { ...b, extra: "x" }, { ...b, closed: { ...b.closed, lock: false } }]) assert.throws(() => build(input, bad), { code: "V2_CONTENT_RESULT_TOO_LARGE" });
  let calls = 0; const accessor = Object.defineProperty(base(), "ids", { enumerable: true, get() { calls++; return b.ids; } });
  assert.throws(() => build(input, accessor), { code: "V2_CONTENT_RESULT_TOO_LARGE" }); assert.equal(calls, 0);
  const proxy = new Proxy(base(), { ownKeys() { calls++; throw new Error("trap"); } });
  assert.throws(() => build(input, proxy), { code: "V2_CONTENT_RESULT_TOO_LARGE" }); assert.equal(calls, 0);
});

// Conjunctive limits make a valid 262144-byte positive impossible. These measured malformed boundaries must refuse, never clip.
test("measured_total_metadata_and_historical_boundaries_are_strict", async () => {
  const build = await api(); const copy = (wire as unknown as Record<string, (x: unknown) => unknown>).copyBoundedFullNoteSuccessData!;
  for (const target of [65536, 65537, 262144, 262145]) {
    const envelope = { ...base(), content: candidate("body"), padding: "" };
    envelope.padding = "x".repeat(target - wire.encodedProtocolBytes(envelope));
    assert.equal(wire.encodedProtocolBytes(envelope), target);
    assert.throws(() => copy(envelope), { code: "FRESH_START_INPUT_INVALID" });
    const { content, ...oversizedBase } = envelope; assert.throws(() => build(content, oversizedBase), { code: "V2_CONTENT_RESULT_TOO_LARGE" });
  }
  const old = { values: Array.from({ length: 8 }, () => "x".repeat(2000)), padding: "" };
  old.padding = "x".repeat(16384 - wire.encodedProtocolBytes(old));
  assert.equal(wire.encodedProtocolBytes(old), 16384); assert.doesNotThrow(() => wire.copyBoundedProtocolData(old, 16384));
  old.padding += "x"; assert.equal(wire.encodedProtocolBytes(old), 16385); assert.throws(() => wire.copyBoundedProtocolData(old, 16384));
  assert.throws(() => wire.copyBoundedProtocolData({ ...base(), content: candidate("x".repeat(4096)) }, 16384));
});
