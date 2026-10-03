import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { assertRetainedByteLimit, decodeRetainEvidenceBatch, decodeRetainedEvidenceReceipt, RetainedEvidenceError } from "../src/orchestrator/privacy/evidence-contracts.js";

const invalid = { code: "RETAINED_EVIDENCE_INPUT_INVALID" };
const limit = { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" };
const unsupported = { code: "RETAINED_EVIDENCE_FORMAT_UNSUPPORTED" };
function id(n = 1) { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`; }
function frame(n = 0) {
  return { frameId: id(n + 10), ordinal: String(n), role: "user", category: "user-message", occurredAt: "2026-10-02T01:02:03.004Z", mediaType: "text/plain; charset=utf-8", content: "bounded visible text" as unknown, previousFrameId: n === 0 ? null : id(n + 9), toolCorrelationId: null as string | null, artifactHashes: [] as string[] };
}
function command(count = 1) { return { version: 1, commandType: "retain-evidence-batch", commandId: id(1), idempotencyKey: id(2), targetSessionId: id(3), conversationId: id(4), frames: Array.from({ length: count }, (_, n) => frame(n)) }; }
function receipt() { return { resultVersion: 1, operation: "retain-evidence-batch", retentionFormat: "redacted-encrypted-v1", targetSessionId: id(3), conversationId: id(4), commandId: id(1), idempotencyKey: id(2), evidenceIds: [id(9)], eventPosition: "1", finalStreamVersion: "1" }; }
function sizedBatch(bytes: number) {
  const value = command(17);
  value.frames.forEach(f => { f.content = ""; });
  let remaining = bytes - Buffer.byteLength(canonicalJson(value));
  for (const f of value.frames) { const length = Math.min(65_536, remaining); f.content = "x".repeat(length); remaining -= length; }
  assert.equal(remaining, 0, "fixture fits individual frame caps");
  assert.equal(Buffer.byteLength(canonicalJson(value)), bytes, "fixture has exact measured bytes");
  return value;
}

test("seven command fields and ten frame fields produce an owned frozen canonical snapshot", () => {
  const value = command(); const expected = canonicalJson(value);
  const decoded = decodeRetainEvidenceBatch(value);
  assert.equal(decoded.canonicalOriginalBytes.toString("utf8"), expected);
  assert.equal(Object.keys(decoded.command).length, 7); assert.equal(Object.keys(decoded.command.frames[0]!).length, 10);
  assert.ok(Object.isFrozen(decoded.command)); assert.ok(Object.isFrozen(decoded.command.frames)); assert.ok(Object.isFrozen(decoded.command.frames[0]));
  value.frames[0]!.content = "changed"; assert.equal(decoded.command.frames[0]!.content, "bounded visible text");
  decoded.canonicalOriginalBytes.fill(0);
});
test("extra and missing command/frame fields and empty batches refuse", () => {
  assert.throws(() => decodeRetainEvidenceBatch({ ...command(), policy: {} }), invalid);
  const missing = command() as Record<string, unknown>; delete missing.commandId; assert.throws(() => decodeRetainEvidenceBatch(missing), invalid);
  const extraFrame = command(); Object.assign(extraFrame.frames[0]!, { extra: true }); assert.throws(() => decodeRetainEvidenceBatch(extraFrame), invalid);
  const missingFrame = command(); delete (missingFrame.frames[0] as Record<string, unknown>).content; assert.throws(() => decodeRetainEvidenceBatch(missingFrame), invalid);
  assert.throws(() => decodeRetainEvidenceBatch(command(0)), invalid);
});
test("all roles and categories enforce role and explicit correlation contracts", () => {
  const cases = [["user-message", "user"], ["user-correction", "user"], ["assistant-message", "assistant"], ["child-report", "assistant"], ["tool-input", "tool"], ["tool-output", "tool"], ["artifact-reference", "user"], ["retrieval-feedback", "assistant"]];
  for (const [category, role] of cases) {
    const value = command(); Object.assign(value.frames[0]!, { category, role, toolCorrelationId: category!.startsWith("tool-") ? id(50) : null });
    // A nonzero first ordinal may refer to accepted history; authoritative resolution comes later.
    if (category === "tool-output") Object.assign(value.frames[0]!, { ordinal: "9", previousFrameId: id(8) });
    assert.equal(decodeRetainEvidenceBatch(value).command.frames[0]!.category, category);
    if (category !== "artifact-reference" && category !== "retrieval-feedback") { Object.assign(value.frames[0]!, { role: role === "user" ? "assistant" : "user" }); assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
  }
  for (const role of ["user", "assistant", "tool"]) { const value = command(); Object.assign(value.frames[0]!, { role, category: "artifact-reference" }); assert.doesNotThrow(() => decodeRetainEvidenceBatch(value)); }
  for (const category of ["tool-input", "tool-output"]) { const value = command(); Object.assign(value.frames[0]!, { role: "tool", category }); assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
  const value = command(); value.frames[0]!.toolCorrelationId = id(50); assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
  value.frames[0]!.toolCorrelationId = undefined as unknown as null; assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
});
test("within-batch predecessors ordinals identities and observable tool ordering are contiguous", () => {
  assert.equal(decodeRetainEvidenceBatch(command(2)).command.frames.length, 2);
  for (const mutation of [ { ordinal: "2" }, { previousFrameId: null }, { previousFrameId: id(70) }, { frameId: id(10) } ]) { const value = command(2); Object.assign(value.frames[1]!, mutation); assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
  const tools = command(2); tools.frames.forEach((f, n) => Object.assign(f, { role: "tool", category: n === 0 ? "tool-input" : "tool-output", toolCorrelationId: id(50) }));
  assert.doesNotThrow(() => decodeRetainEvidenceBatch(tools)); tools.frames.reverse(); Object.assign(tools.frames[0]!, { ordinal: "0", previousFrameId: null }); Object.assign(tools.frames[1]!, { ordinal: "1", previousFrameId: tools.frames[0]!.frameId }); assert.throws(() => decodeRetainEvidenceBatch(tools), invalid);
  const continued = command(); Object.assign(continued.frames[0]!, { ordinal: "9223372036854775807", previousFrameId: id(99) }); assert.doesNotThrow(() => decodeRetainEvidenceBatch(continued));
  Object.assign(continued.frames[0]!, { previousFrameId: null }); assert.throws(() => decodeRetainEvidenceBatch(continued), invalid);
});
test("selectors are canonical UUIDv4 and ordinals/timestamps retain historical strictness", () => {
  for (const field of ["commandId", "idempotencyKey", "targetSessionId", "conversationId"]) { for (const bad of [id().replace("4000", "5000"), id(0xabcdef).toUpperCase(), null]) { assert.throws(() => decodeRetainEvidenceBatch({ ...command(), [field]: bad }), invalid); } }
  for (const bad of ["01", "-1", "9223372036854775808", "9".repeat(1000)]) { const value = command(); value.frames[0]!.ordinal = bad; assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
  for (const bad of ["2026-02-30T00:00:00.000Z", "2026-10-02T01:02:03Z"]) { const value = command(); value.frames[0]!.occurredAt = bad; assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
  const value = command(); value.frames[0]!.frameId = id().replace("4000", "1000"); assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
});
test("unsupported command/version/media reject and media content types stay exact", () => {
  assert.throws(() => decodeRetainEvidenceBatch({ ...command(), version: 2 }), unsupported);
  assert.throws(() => decodeRetainEvidenceBatch({ ...command(), commandType: "record-evidence-batch" }), unsupported);
  const value = command(); value.frames[0]!.mediaType = "image/png"; assert.throws(() => decodeRetainEvidenceBatch(value), unsupported);
  value.frames[0]!.mediaType = "text/plain; charset=utf-8"; value.frames[0]!.content = {}; assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
});
test("hostile shape is rejected before value access", () => {
  let accesses = 0;
  const getter = command(); Object.defineProperty(getter.frames[0], "content", { enumerable: true, get() { accesses++; throw new Error("must not read"); } });
  const arrayGetter = command(); Object.defineProperty(arrayGetter.frames, "0", { enumerable: true, get() { accesses++; throw new Error("must not read"); } });
  const proxy = new Proxy(command(), { ownKeys() { accesses++; throw new Error("must not inspect proxy"); }, get() { accesses++; throw new Error("must not read proxy"); } });
  const nestedProxy = command(); nestedProxy.frames[0]!.mediaType = "application/json"; nestedProxy.frames[0]!.content = proxy;
  for (const value of [getter, arrayGetter, proxy, nestedProxy]) assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
  assert.equal(accesses, 0, "no accessor/proxy work can run before rejection");
  const sparse = command(); delete sparse.frames[0]; assert.throws(() => decodeRetainEvidenceBatch(sparse), invalid);
  const prototype = command(); Object.setPrototypeOf(prototype, { inherited: true }); assert.throws(() => decodeRetainEvidenceBatch(prototype), invalid);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const hidden = Object.defineProperty({}, "x", { value: 1, enumerable: false });
  for (const content of [cyclic, hidden, new Date(), { [Symbol("hidden")]: 1 }, { x: undefined }, NaN, "\ud800", { "\udfff": true }, { x: "\udfff" }]) { const value = command(); Object.assign(value.frames[0]!, { mediaType: "application/json", content }); assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
});
test("iterative JSON accounting accepts bounded deep/wide data and refuses oversized shapes", () => {
  let deep: unknown = null; for (let n = 0; n < 12_000; n++) deep = [deep];
  const value = command(); Object.assign(value.frames[0]!, { mediaType: "application/json", content: deep });
  assert.equal(Buffer.byteLength(decodeRetainEvidenceBatch(value).canonicalOriginalBytes) > 24_000, true);
  let oversized: unknown = null; for (let n = 0; n < 33_000; n++) oversized = [oversized];
  value.frames[0]!.content = oversized; assert.throws(() => decodeRetainEvidenceBatch(value), limit);
  value.frames[0]!.content = Array.from({ length: 14_000 }, () => null); assert.throws(() => decodeRetainEvidenceBatch(value), limit);
  value.frames[0]!.content = Array.from({ length: 10_000 }, () => null); assert.doesNotThrow(() => decodeRetainEvidenceBatch(value));
  const nullRecord = Object.assign(Object.create(null), { z: -0, a: "ok" }); value.frames[0]!.content = nullRecord;
  assert.equal(decodeRetainEvidenceBatch(value).canonicalOriginalBytes.toString(), canonicalJson(value));
});
test("64 frames accept and 65 frames refuse without truncation", () => { assert.equal(decodeRetainEvidenceBatch(command(64)).command.frames.length, 64); assert.throws(() => decodeRetainEvidenceBatch(command(65)), limit); });
test("65,536 frame UTF-8 bytes accept and 65,537 refuse", () => {
  const value = command(); value.frames[0]!.content = "🙂".repeat(16_384); assert.equal(Buffer.byteLength(value.frames[0]!.content as string), 65_536); assert.doesNotThrow(() => decodeRetainEvidenceBatch(value));
  value.frames[0]!.content += "x"; assert.throws(() => decodeRetainEvidenceBatch(value), limit);
  Object.assign(value.frames[0]!, { mediaType: "application/json", content: "x".repeat(65_534) }); assert.doesNotThrow(() => decodeRetainEvidenceBatch(value)); value.frames[0]!.content += "x"; assert.throws(() => decodeRetainEvidenceBatch(value), limit);
});
test("1,048,576 canonical batch bytes accept and 1,048,577 refuse", () => { assert.equal(Buffer.byteLength(decodeRetainEvidenceBatch(sizedBatch(1_048_576)).canonicalOriginalBytes), 1_048_576); assert.throws(() => decodeRetainEvidenceBatch(sizedBatch(1_048_577)), limit); });
test("32 unique hashes accept and 33 or duplicate/noncanonical hashes refuse", () => {
  const value = command(); value.frames[0]!.artifactHashes = Array.from({ length: 32 }, (_, n) => n.toString(16).padStart(64, "0")); assert.equal(decodeRetainEvidenceBatch(value).command.frames[0]!.artifactHashes.length, 32);
  value.frames[0]!.artifactHashes.push("f".repeat(64)); assert.throws(() => decodeRetainEvidenceBatch(value), limit);
  for (const hashes of [["a".repeat(64), "a".repeat(64)], ["A".repeat(64)], ["abc"]]) { value.frames[0]!.artifactHashes = hashes; assert.throws(() => decodeRetainEvidenceBatch(value), invalid); }
});
test("receipt is a closed frozen selector-only envelope", () => {
  const decoded = decodeRetainedEvidenceReceipt(receipt()); assert.equal(decoded.retentionFormat, "redacted-encrypted-v1"); assert.ok(Object.isFrozen(decoded.evidenceIds));
  for (const addition of [{ plaintext: "visible" }, { manifest: [] }, { productionReady: true }]) assert.throws(() => decodeRetainedEvidenceReceipt({ ...receipt(), ...addition }), invalid);
  assert.throws(() => decodeRetainedEvidenceReceipt({ ...receipt(), resultVersion: 2 }), unsupported);
  assert.throws(() => decodeRetainedEvidenceReceipt({ ...receipt(), evidenceIds: [id(9), id(9)] }), invalid);
  assert.throws(() => decodeRetainedEvidenceReceipt({ ...receipt(), eventPosition: "9223372036854775808" }), invalid);
});
test("byte guard refuses invalid accounting and errors contain only closed safe codes", () => {
  assert.doesNotThrow(() => assertRetainedByteLimit(16_384, 16_384)); assert.throws(() => assertRetainedByteLimit(16_385, 16_384), limit);
  for (const bytes of [NaN, Infinity, -1, 0.1]) assert.throws(() => assertRetainedByteLimit(bytes, 16_384), invalid);
  assert.equal(new RetainedEvidenceError("COMMAND_OUTCOME_UNKNOWN").message, "COMMAND_OUTCOME_UNKNOWN");
  assert.equal(new RetainedEvidenceError("untrusted-native-message" as never).message, "RETAINED_EVIDENCE_UNAVAILABLE");
});
test("closed errors preserve admission SQLite and safe recovery identities without native details", () => {
  for (const code of ["FRESH_START_ADMISSION_DENIED", "FRESH_START_ADMISSION_STALE", "SQLITE_BUSY", "MAINTENANCE_QUIESCING"]) assert.equal(new RetainedEvidenceError(code as never).code, code);
  const ErrorWithRecovery = RetainedEvidenceError as unknown as new (code: "COMMAND_OUTCOME_UNKNOWN", details: unknown) => RetainedEvidenceError & { readonly details: Readonly<Record<string, string>> };
  const error = new ErrorWithRecovery("COMMAND_OUTCOME_UNKNOWN", { commandId: id(1), idempotencyKey: id(2), message: "native-sensitive-detail", cause: new Error("native-sensitive-detail") });
  assert.deepEqual(error.details, { commandId: id(1), idempotencyKey: id(2) }); assert.ok(Object.isFrozen(error.details)); assert.equal(JSON.stringify(error).includes("native-sensitive-detail"), false);
  assert.deepEqual(new ErrorWithRecovery("COMMAND_OUTCOME_UNKNOWN", { commandId: "malformed" }).details, {});
});
test("a continued batch cannot name its own or a later frame as its external predecessor", () => {
  for (const predecessor of [id(10), id(11)]) {
    const value = command(2); Object.assign(value.frames[0]!, { ordinal: "8", previousFrameId: predecessor }); value.frames[1]!.ordinal = "9";
    assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
  }
});
test("revoked proxies refuse with closed errors at command frame array and JSON seams", () => {
  const revocable = Proxy.revocable({}, {}); revocable.revoke();
  assert.throws(() => decodeRetainEvidenceBatch(revocable.proxy), invalid);
  const value = command(); value.frames = revocable.proxy as never; assert.throws(() => decodeRetainEvidenceBatch(value), invalid);
  const nested = command(); nested.frames[0] = revocable.proxy as never; assert.throws(() => decodeRetainEvidenceBatch(nested), invalid);
  const content = command(); Object.assign(content.frames[0]!, { mediaType: "application/json", content: revocable.proxy }); assert.throws(() => decodeRetainEvidenceBatch(content), invalid);
});
test("wide JSON key accounting stops with the size code before copying", () => {
  const value = command(); Object.assign(value.frames[0]!, { mediaType: "application/json", content: { ["x".repeat(65_531)]: null, z: null } }); assert.throws(() => decodeRetainEvidenceBatch(value), limit);
  value.frames[0]!.content = Object.fromEntries(Array.from({ length: 65_536 }, (_, n) => [String(n), null])); assert.throws(() => decodeRetainEvidenceBatch(value), limit);
});
