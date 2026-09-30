import { strict as assert } from "node:assert";
import { it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { createSyntheticExpectedManifest, type SyntheticExpectedManifest } from "./support/host-boundary-probe-manifest.js";
import { verifySyntheticHostObservations, SYNTHETIC_PROBE_LIMITS, type SyntheticProbeLimits } from "./support/host-boundary-probe-verifier.js";

const manifest = createSyntheticExpectedManifest();
const foreign = "90000000-0000-4000-8000-000000000001";
const changed = (index: number, patch: object): readonly unknown[] => manifest.frames.map((frame, i) => i === index ? { ...frame, ...patch } : frame);
const expectReason = (observations: unknown, reason: string) => assert.deepEqual(verifySyntheticHostObservations(manifest, observations), { ok: false, reason });

it("baseline proves all eleven independent identities", () => {
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames), { ok: true, uniqueFrameCount: 11 });
});
it("identical duplicate preserves eleven unique frames", () => {
  assert.deepEqual(verifySyntheticHostObservations(manifest, [...manifest.frames, { ...manifest.frames[2]! }]), { ok: true, uniqueFrameCount: 11 });
});
it("changed hash for same ID rejects delivery conflict", () => expectReason([...manifest.frames, { ...manifest.frames[2]!, contentHash: "f".repeat(64) }], "payload-changed"));
it("missing interior remains missing after reordinaling", () => expectReason(manifest.frames.filter((_, i) => i !== 5).map((frame, i) => ({ ...frame, ordinal: String(i) })), "missing-frame"));
it("missing entire child category remains missing after reordinaling", () => expectReason(manifest.frames.filter(f => f.category !== "child-report").map((frame, i) => ({ ...frame, ordinal: String(i) })), "missing-frame"));
it("missing final response fails completeness", () => expectReason(manifest.frames.slice(0, -1), "missing-frame"));
it("extra late identity is unexpected", () => expectReason([...manifest.frames, { ...manifest.frames[10]!, frameId: foreign }], "unexpected-frame"));
it("reordered observations reject first occurrence order", () => expectReason([manifest.frames[1], manifest.frames[0], ...manifest.frames.slice(2)], "order-mismatch"));
it("wrong predecessor rejects order", () => expectReason(changed(3, { previousFrameId: foreign }), "order-mismatch"));
it("supplied ordinal cannot hide wrong order", () => expectReason(changed(3, { ordinal: "4" }), "order-mismatch"));
for (const field of ["projectId", "workspaceId", "sessionId", "childId"] as const) {
  it(`foreign ${field} rejects attribution`, () => expectReason(changed(4, { [field]: foreign }), "scope-mismatch"));
}
it("unmatched tool result correlation is rejected", () => expectReason(changed(3, { correlationId: null }), "correlation-mismatch"));
it("changed paired tool correlation is rejected", () => expectReason(manifest.frames.map((frame, i) => i === 2 || i === 3 ? { ...frame, correlationId: foreign } : frame), "correlation-mismatch"));
it("single same-ID changed hash rejects payload", () => expectReason(changed(3, { contentHash: "f".repeat(64) }), "payload-changed"));
it("single same-ID altered category rejects payload", () => expectReason(changed(3, { category: "reference" }), "payload-changed"));
it("duplicate deliveries cannot hide missing identity", () => expectReason([...manifest.frames.slice(0, -1), manifest.frames[0]], "missing-frame"));

for (const [label, patch] of [
  ["unknown category", { category: "hidden-reasoning" }],
  ["uppercase UUID", { projectId: foreign.toUpperCase().replace("9000", "ABCD") }],
  ["malformed frame UUID", { frameId: "bad" }],
  ["numeric session", { sessionId: 1 }],
  ["malformed child UUID", { childId: "bad" }],
  ["malformed correlation", { correlationId: "bad" }],
  ["malformed predecessor", { previousFrameId: "bad" }],
  ["leading-zero ordinal", { ordinal: "01" }],
  ["overflow ordinal", { ordinal: "9223372036854775808" }],
  ["negative ordinal", { ordinal: "-1" }],
  ["numeric ordinal", { ordinal: 1 }],
  ["uppercase hash", { contentHash: "F".repeat(64) }],
  ["short hash", { contentHash: "a".repeat(63) }],
  ["extra field", { content: "synthetic" }],
] as const) it(`rejects ${label} scalar/shape`, () => expectReason(changed(0, patch), "input-invalid"));

for (const [label, input] of [
  ["non-array", {}], ["null", null], ["sparse", new Array(11)],
  ["exotic frame", [new Date()]], ["null frame", [null]],
  ["symbol field", [{ ...manifest.frames[0], [Symbol("extra")]: 1 }]],
  ["array property", Object.assign([...manifest.frames], { extra: 1 })],
  ["exotic array", Object.setPrototypeOf([...manifest.frames], null)],
  ["nonenumerable frame field", [Object.defineProperty({ ...manifest.frames[0] }, "ordinal", { value: "0", enumerable: false })]],
] as const) it(`rejects ${label} observation shape`, () => expectReason(input, "input-invalid"));

it("caller frame getter is never executed", () => {
  let calls = 0;
  const frame = Object.defineProperty({ ...manifest.frames[0] }, "ordinal", { enumerable: true, get() { calls++; throw new Error("getter executed"); } });
  expectReason([frame], "input-invalid");
  assert.equal(calls, 0);
});
it("caller array getter is never executed", () => {
  let calls = 0;
  const frames = Object.defineProperty([...manifest.frames], "0", { enumerable: true, get() { calls++; throw new Error("getter executed"); } });
  expectReason(frames, "input-invalid");
  assert.equal(calls, 0);
});
it("hostile expected getter is never executed", () => {
  let calls = 0;
  const expected = Object.defineProperty({}, "frames", { enumerable: true, get() { calls++; throw new Error("getter executed"); } });
  assert.deepEqual(verifySyntheticHostObservations(expected as SyntheticExpectedManifest, manifest.frames), { ok: false, reason: "input-invalid" });
  assert.equal(calls, 0);
});

const badExpected: readonly [string, unknown][] = [
  ["empty", { manifestVersion: 1, frames: [] }],
  ["version", { ...manifest, manifestVersion: 2 }],
  ["extra", { ...manifest, extra: 1 }],
  ["sparse", { ...manifest, frames: new Array(11) }],
  ["oversized sparse", { ...manifest, frames: new Array(0xffffffff) }],
  ["duplicate identity", { ...manifest, frames: [...manifest.frames, manifest.frames[0]] }],
  ["ordinal gap", { ...manifest, frames: changed(0, { ordinal: "1" }) }],
  ["missing category", { ...manifest, frames: changed(5, { category: "assistant-message" }) }],
  ["early final", { ...manifest, frames: changed(0, { category: "final-assistant" }) }],
  ["wrong predecessor", { ...manifest, frames: changed(2, { previousFrameId: foreign }) }],
  ["unpaired tool", { ...manifest, frames: changed(3, { correlationId: foreign }) }],
  ["null tool correlation", { ...manifest, frames: changed(2, { correlationId: null }) }],
  ["non-tool correlation", { ...manifest, frames: changed(0, { correlationId: foreign }) }],
  ["root alias child", { ...manifest, frames: changed(4, { sessionId: manifest.frames[0]!.sessionId }) }],
  ["foreign project", { ...manifest, frames: changed(5, { projectId: foreign }) }],
  ["foreign root session", { ...manifest, frames: changed(5, { sessionId: foreign }) }],
];
for (const [label, expected] of badExpected) it(`invalid expected manifest: ${label}`, () => {
  assert.deepEqual(verifySyntheticHostObservations(expected as SyntheticExpectedManifest, manifest.frames), { ok: false, reason: "input-invalid" });
});
for (const field of ["maxObservations", "maxFrameCanonicalBytes", "maxTotalCanonicalBytes"] as const) {
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, SYNTHETIC_PROBE_LIMITS[field] + 1, "1", null]) {
    it(`invalid trusted limit ${field}=${String(value)}`, () => {
      assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, { ...SYNTHETIC_PROBE_LIMITS, [field]: value } as SyntheticProbeLimits), { ok: false, reason: "input-invalid" });
    });
  }
}
it("trusted limits getter is never executed", () => {
  let calls = 0;
  const limits = Object.defineProperty({ ...SYNTHETIC_PROBE_LIMITS }, "maxObservations", { enumerable: true, get() { calls++; return 64; } });
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, limits), { ok: false, reason: "input-invalid" });
  assert.equal(calls, 0);
});
it("limits reject additional fields", () => {
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, { ...SYNTHETIC_PROBE_LIMITS, extra: 1 } as SyntheticProbeLimits), { ok: false, reason: "input-invalid" });
});
it("64 deliveries including duplicates pass; 65 exceed count", () => {
  const frames = [...manifest.frames, ...Array.from({ length: 53 }, () => manifest.frames[0]!)];
  assert.deepEqual(verifySyntheticHostObservations(manifest, frames), { ok: true, uniqueFrameCount: 11 });
  expectReason([...frames, manifest.frames[0]], "limit-exceeded");
});
it("huge sparse count rejects before array key allocation", () => expectReason(new Array(0xffffffff), "limit-exceeded"));
it("tightened count is an observation limit, not invalid expected fixture", () => {
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, { ...SYNTHETIC_PROBE_LIMITS, maxObservations: 10 }), { ok: false, reason: "limit-exceeded" });
});
it("canonical frame and complete array byte boundaries are inclusive", () => {
  const n = Math.max(...manifest.frames.map(f => Buffer.byteLength(canonicalJson(f), "utf8")));
  const m = Buffer.byteLength(canonicalJson(manifest.frames), "utf8");
  const limits = { ...SYNTHETIC_PROBE_LIMITS, maxFrameCanonicalBytes: n, maxTotalCanonicalBytes: m };
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, limits), { ok: true, uniqueFrameCount: 11 });
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, { ...limits, maxFrameCanonicalBytes: n - 1 }), { ok: false, reason: "limit-exceeded" });
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames, { ...limits, maxTotalCanonicalBytes: m - 1 }), { ok: false, reason: "limit-exceeded" });
  assert.deepEqual(verifySyntheticHostObservations(manifest, [...manifest.frames, manifest.frames[0]], limits), { ok: false, reason: "limit-exceeded" });
});
it("manifest and every frame are frozen against caller mutation", () => {
  assert.throws(() => Object.assign(manifest.frames[0]!, { contentHash: "f".repeat(64) }), TypeError);
  assert.throws(() => (manifest.frames as unknown[]).push(manifest.frames[0]), TypeError);
  assert.throws(() => Object.assign(manifest, { manifestVersion: 2 }), TypeError);
  assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames), { ok: true, uniqueFrameCount: 11 });
});
