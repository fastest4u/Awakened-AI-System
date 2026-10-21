import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { PendingEvent, StoredEvent, JsonValue } from "../src/orchestrator/contracts/event.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { assertRetainedByteLimit, boundedRetainedJson, decodeRetainEvidenceBatch, RetainedEvidenceError } from "../src/orchestrator/privacy/evidence-contracts.js";
import { redactEvidence, type TrustedRedactionPolicyV1 } from "../src/orchestrator/privacy/redaction.js";
import { sealEvidenceItem, openEvidenceItem, type EvidenceItemBindingV1, type EncryptedEvidenceItemV1 } from "../src/orchestrator/privacy/evidence-envelope.js";
import type { EvidenceKeyProvider, EvidenceKeyPurpose, EvidenceKeyRefV1, EvidenceKeyScope, WrappedEvidenceKeyV1 } from "../src/orchestrator/privacy/evidence-key-provider.js";
import { buildRetainedEvidenceIntent, retainedEvidenceIntentHash, type RetainedEvidenceAuthoritySnapshotV1 } from "../src/orchestrator/privacy/retained-evidence-intent.js";
import { assertRetainedEvidenceBundle, assertRetainedStoredEvent, decodeEvidenceBatchRetainedPayload, decodeEvidenceItemBinding, decodeEvidenceKeyRef, decodeEncryptedEvidenceItem, decodeRetainedEvidenceAuthority, decodeRetainedEvidenceIntentWitness, decodeRetainedEvidenceStoredResult, decodeWrappedEvidenceKey, type EvidenceBatchRetainedPayloadV1 } from "../src/orchestrator/privacy/retained-evidence-codec.js";

const integrity = { code: "INTEGRITY_FAILURE" };
const unavailable = { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" };
const unsupported = { code: "RETAINED_EVIDENCE_FORMAT_UNSUPPORTED" };
const limit = { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" };
function id(n: number) { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`; }
// Actual trusted identity shapes from tests/support/fresh-start-fixture.ts:39-41.
const genuineScope = { projectId: "11111111-1111-4111-8111-111111111111", vaultId: "22222222-2222-4222-8222-222222222222", storeId: "33333333-3333-4333-8333-333333333333" };
const scope = { projectId: genuineScope.projectId, storeId: genuineScope.storeId };
const ref = (purpose: EvidenceKeyPurpose, version = "1"): EvidenceKeyRefV1 => ({ keyId: `synthetic:${purpose}`, version });
const policy: TrustedRedactionPolicyV1 = Object.freeze({ policyId: "synthetic-policy", policyVersion: "1", rules: Object.freeze([Object.freeze({ kind: "token", ruleId: "synthetic-token", prefix: "fixture_" })]) });
const authority: RetainedEvidenceAuthoritySnapshotV1 = {
  ...scope, vaultId: genuineScope.vaultId, workspaceId: "d".repeat(64), clientNamespace: "synthetic-client",
  presentingActorRole: "primary", presentingClientInstanceId: "synthetic-instance", targetActorRole: "primary", targetClientInstanceId: "synthetic-instance",
  authorizationSessionId: id(3), targetSessionId: id(3), parentSessionId: null,
  rootSessionId: id(3), rootOwnerGeneration: "1",
  authorizingOwnerGeneration: "1", authorizingCapabilityGeneration: null, targetOwnerGeneration: "1", targetCapabilityGeneration: null, capabilityKind: "root-session-handle",
};
const keys = { originalCommitmentKeyRef: ref("original-input-commitment"), fingerprintKeyRef: ref("redacted-content-fingerprint") };
function command(content: unknown = "visible fixture_alpha", count = 1) {
  return { version: 1, commandType: "retain-evidence-batch", commandId: id(1), idempotencyKey: id(2), targetSessionId: id(3), conversationId: id(4), frames: Array.from({ length: count }, (_, n) => ({ frameId: id(n + 10), ordinal: String(n), role: "user", category: "user-message", occurredAt: "2026-10-02T01:02:03.004Z", mediaType: "text/plain; charset=utf-8", content, previousFrameId: n === 0 ? null : id(n + 9), toolCorrelationId: null, artifactHashes: [] })) };
}
function binding(n = 0): EvidenceItemBindingV1 { return { formatVersion: 1, ...scope, vaultId: authority.vaultId, evidenceId: id(n + 100), eventId: id(200), targetSessionId: id(3), conversationId: id(4), frameId: id(n + 10), mediaType: "text/plain; charset=utf-8", policyId: policy.policyId, policyVersion: policy.policyVersion }; }
/** Trusted synthetic local provider: distinct purpose keys, scope/ref checks and real authenticated wrapping/MAC. */
class SyntheticProvider implements EvidenceKeyProvider {
  denied = new Set<string>(); failure: string | null = null; currentVersion = "1"; returnedKeys: Uint8Array[] = []; macOutputs: Uint8Array[] = [];
  private readonly material = new Map<EvidenceKeyPurpose, Buffer>([["data-key-wrap", Buffer.alloc(32, 1)], ["original-input-commitment", Buffer.alloc(32, 2)], ["redacted-content-fingerprint", Buffer.alloc(32, 3)]]);
  private scoped(s: EvidenceKeyScope) { return s.projectId === scope.projectId && s.storeId === scope.storeId; }
  currentKey(s: EvidenceKeyScope, p: EvidenceKeyPurpose): EvidenceKeyRefV1 { if (this.failure === "current") throw new Error("synthetic-provider-private-handle"); if (!this.scoped(s)) throw new Error("foreign"); return ref(p, this.currentVersion); }
  status(s: EvidenceKeyScope, p: EvidenceKeyPurpose, r: EvidenceKeyRefV1): "available" | "revoked" | "unavailable" { if (this.failure === "status") throw new Error("synthetic-provider-private-handle"); return this.denied.has(p) ? "revoked" : this.scoped(s) && r.keyId === ref(p).keyId && ["1", "2"].includes(r.version) ? "available" : "unavailable"; }
  private key(s: EvidenceKeyScope, p: EvidenceKeyPurpose, r: EvidenceKeyRefV1) { if (this.status(s, p, r) !== "available") throw new Error("unavailable"); return this.material.get(p)!; }
  wrap(s: EvidenceKeyScope, r: EvidenceKeyRefV1, data: Uint8Array, aad: Uint8Array): WrappedEvidenceKeyV1 {
    if (this.failure === "wrap") throw new Error("synthetic-provider-private-handle");
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key(s, "data-key-wrap", r), nonce, { authTagLength: 16 }); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return { formatVersion: 1, keyRef: { ...r }, algorithm: "AES-256-GCM", nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  }
  unwrap(s: EvidenceKeyScope, wrapped: WrappedEvidenceKeyV1, aad: Uint8Array): Uint8Array {
    if (this.failure === "unwrap") throw new Error("synthetic-provider-private-handle");
    const cipher = createDecipheriv("aes-256-gcm", this.key(s, "data-key-wrap", wrapped.keyRef), Buffer.from(wrapped.nonce, "base64url"), { authTagLength: 16 }); cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(wrapped.tag, "base64url"));
    const first = cipher.update(Buffer.from(wrapped.ciphertext, "base64url"));
    try { const key = Buffer.concat([first, cipher.final()]); this.returnedKeys.push(key); return key; } finally { first.fill(0); }
  }
  mac(s: EvidenceKeyScope, p: "original-input-commitment" | "redacted-content-fingerprint", r: EvidenceKeyRefV1, domain: string, bytes: Uint8Array): Uint8Array {
    if (this.failure === "mac") throw new Error("synthetic-provider-private-handle");
    const result = createHmac("sha256", this.key(s, p, r)).update(domain).update("\n").update(bytes).digest(); this.macOutputs.push(result); return result;
  }
}
function fixture(content: unknown = "visible fixture_alpha", count = 1) { const input = decodeRetainEvidenceBatch(command(content, count)); const provider = new SyntheticProvider(); const frames = redactEvidence(input, policy).frames; const frame = frames[0]!; return { input, provider, frame, frames }; }
function changed(bytes: string): string { const b = Buffer.from(bytes, "base64url"); b[0] = b[0]! ^ 1; return b.toString("base64url"); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function metadata(item: EncryptedEvidenceItemV1) { const { binding: b, frame, wrapKeyRef, fingerprintKeyRef, ciphertextHash, wrappedKeyHash, keyedFingerprint } = item; return { binding: b, frame, wrapKeyRef, fingerprintKeyRef, ciphertextHash, wrappedKeyHash, keyedFingerprint }; }
function payloadFixture(count = 1) {
  const f = fixture(undefined, count); try { const witness = buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider); const items = f.frames.map((frame, n) => sealEvidenceItem(binding(n), frame, f.provider)); return { provider: f.provider, item: items[0]!, payload: { formatVersion: 1 as const, witness, items: items.map(metadata) } }; } finally { f.input.canonicalOriginalBytes.fill(0); }
}
function stored(payload: EvidenceBatchRetainedPayloadV1): StoredEvent {
  return linked({ globalPosition: 1n, eventId: id(200), projectId: scope.projectId as StoredEvent["projectId"], vaultId: authority.vaultId as StoredEvent["vaultId"], storeId: scope.storeId as StoredEvent["storeId"], workspaceId: authority.workspaceId as StoredEvent["workspaceId"], branchScopeId: null, branchRef: null, streamId: id(3), streamType: "session", streamVersion: 1n, eventType: "EvidenceBatchRetained", eventSchemaVersion: 1, sessionId: id(3), parentSessionId: null, actorRole: "primary", agentId: "synthetic-agent", clientInstanceId: "synthetic-instance", correlationId: id(4), causationId: null, commandId: id(1), idempotencyKey: id(2), commandEventIndex: 0, occurredAt: "2026-10-02T01:02:03.004Z", recordedAt: "2026-10-02T01:02:03.004Z", visibilityScope: "session", confidence: "high", verificationStatus: "verified", sourceRefs: [], evidenceRefs: [], evidenceDigests: [], payload, payloadJson: canonicalJson(payload), payloadHash: "0".repeat(64), previousGlobalHash: "0".repeat(64), eventHash: "0".repeat(64) }, payload);
}
function linked(event: StoredEvent, payload: EvidenceBatchRetainedPayloadV1): StoredEvent {
  // Local retained branch seam; do not relax the global legacy empty-evidence StoredEvent type.
  return { ...event, evidenceRefs: payload.items.map(item => item.binding.evidenceId), evidenceDigests: payload.items.map(item => ({ ciphertextHash: item.ciphertextHash, keyedFingerprint: item.keyedFingerprint })) } as unknown as StoredEvent;
}
test("trusted scope UUIDs follow existing versions while workspace hashes and new UUIDv4 selectors remain distinct", () => {
  const b = { ...binding(), ...genuineScope }; const a = { ...authority, ...genuineScope };
  assert.deepEqual(decodeEvidenceItemBinding(b), b); assert.deepEqual(decodeRetainedEvidenceAuthority(a), a);
  for (const field of ["projectId", "vaultId", "storeId"] as const) {
    for (const version of [1, 2, 3, 4, 5]) { const value = `abcdefab-cdef-${version}123-8123-abcdefabcdef`; assert.equal(decodeEvidenceItemBinding({ ...b, [field]: value })[field], value); assert.equal(decodeRetainedEvidenceAuthority({ ...a, [field]: value })[field], value); }
    for (const value of ["a".repeat(64), "abcdefab-cdef-6123-8123-abcdefabcdef", "ABCDEFAB-CDEF-4123-8123-ABCDEFABCDEF", "abcdefab-cdef-4123-7123-abcdefabcdef", null]) { assert.throws(() => decodeEvidenceItemBinding({ ...b, [field]: value }), unsupported); assert.throws(() => decodeRetainedEvidenceAuthority({ ...a, [field]: value }), unsupported); }
  }
  assert.throws(() => decodeRetainedEvidenceAuthority({ ...a, workspaceId: genuineScope.projectId }), unsupported);
  for (const field of ["evidenceId", "eventId", "targetSessionId", "conversationId", "frameId"] as const) assert.throws(() => decodeEvidenceItemBinding({ ...b, [field]: "abcdefab-cdef-1123-8123-abcdefabcdef" }), unsupported);
});
test("retained events require exact ordered evidence refs and digest pairs while legacy events require emptiness", () => {
  const f = payloadFixture(2); const event = linked(stored(f.payload), f.payload);
  assert.deepEqual(assertRetainedStoredEvent(event), f.payload);
  const refs = f.payload.items.map(item => item.binding.evidenceId); const digests = f.payload.items.map(item => ({ ciphertextHash: item.ciphertextHash, keyedFingerprint: item.keyedFingerprint }));
  for (const evidenceRefs of [undefined, [], refs.slice(1), [...refs].reverse(), [id(999), refs[1]], [...refs, id(999)], [null, refs[1]], { 0: refs[0], 1: refs[1] }]) assert.throws(() => assertRetainedStoredEvent({ ...event, evidenceRefs } as unknown as StoredEvent), integrity);
  for (const evidenceDigests of [undefined, [], digests.slice(1), [...digests].reverse(), [...digests, digests[0]], [{ ...digests[0], ciphertextHash: "f".repeat(64) }, digests[1]], [{ ...digests[0], keyedFingerprint: "f".repeat(64) }, digests[1]], [{ ...digests[0], wrappedKeyHash: f.payload.items[0]!.wrappedKeyHash }, digests[1]], [{ ciphertextHash: digests[0]!.ciphertextHash }, digests[1]], [null, digests[1]]]) assert.throws(() => assertRetainedStoredEvent({ ...event, evidenceDigests } as unknown as StoredEvent), integrity);
  let invoked = false; const accessor = [{ get ciphertextHash() { invoked = true; return digests[0]!.ciphertextHash; }, keyedFingerprint: digests[0]!.keyedFingerprint }, digests[1]];
  assert.throws(() => assertRetainedStoredEvent({ ...event, evidenceDigests: accessor } as unknown as StoredEvent), integrity); assert.equal(invoked, false);
  assert.equal(assertRetainedStoredEvent({ ...event, eventType: "Other", evidenceRefs: [], evidenceDigests: [] }), null);
  assert.throws(() => assertRetainedStoredEvent({ ...event, eventType: "Other" }), integrity);
});

// Break caught: key/nonce reuse or retaining a cleartext wrapper instead of AES-GCM ciphertext.
test("each item uses independent data key and nonce", () => {
  const f = fixture(); try { const first = sealEvidenceItem(binding(), f.frame, f.provider); const second = sealEvidenceItem(binding(), f.frame, f.provider);
    assert.notEqual(first.ciphertext, second.ciphertext); assert.notEqual(first.nonce, second.nonce);
    assert.equal(Buffer.from(first.nonce, "base64url").length, 12); assert.equal(Buffer.from(first.tag, "base64url").length, 16);
    const key1 = f.provider.unwrap(scope, first.wrappedKey, Buffer.from(canonicalJson(first.binding))); const key2 = f.provider.unwrap(scope, second.wrappedKey, Buffer.from(canonicalJson(second.binding)));
    try { assert.notDeepEqual(key1, key2); } finally { key1.fill(0); key2.fill(0); }
    const opened = openEvidenceItem(binding(), first, f.provider); assert.equal(opened.content, "visible [REDACTED]"); assert.deepEqual(opened.manifest, [{ ruleId: "synthetic-token", startByte: 8, endByte: 21 }]);
    assert.ok(f.provider.returnedKeys.every(k => k.every(byte => byte === 0))); assert.ok(f.provider.macOutputs.every(k => k.every(byte => byte === 0)));
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("AAD matches exact event identity", () => {
  const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider);
    const expected = `{"conversationId":"${id(4)}","eventId":"${id(200)}","evidenceId":"${id(100)}","formatVersion":1,"frameId":"${id(10)}","mediaType":"text/plain; charset=utf-8","policyId":"synthetic-policy","policyVersion":"1","projectId":"${scope.projectId}","storeId":"${scope.storeId}","targetSessionId":"${id(3)}","vaultId":"${authority.vaultId}"}`;
    const key = f.provider.unwrap(scope, item.wrappedKey, Buffer.from(expected)); try { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(item.nonce, "base64url"), { authTagLength: 16 }); decipher.setAAD(Buffer.from(expected)); decipher.setAuthTag(Buffer.from(item.tag, "base64url")); const first = decipher.update(Buffer.from(item.ciphertext, "base64url")); const last = decipher.final(); try { assert.ok(Buffer.concat([first, last]).length > 0); } finally { first.fill(0); last.fill(0); } } finally { key.fill(0); }
    for (const field of Object.keys(binding())) { const b = { ...binding(), [field]: field === "formatVersion" ? 2 : field === "mediaType" ? "application/json" : field.endsWith("Id") && !["projectId", "vaultId", "storeId", "policyId"].includes(field) ? id(999) : `${String(binding()[field as keyof EvidenceItemBindingV1])}x` } as EvidenceItemBindingV1; assert.throws(() => openEvidenceItem(b, item, f.provider), integrity); }
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("no unauthenticated plaintext escapes", () => {
  const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider);
    for (const field of ["tag", "nonce", "ciphertext"] as const) { const bad = { ...item, [field]: changed(item[field]) };
    // Recompute the unkeyed transport digest: authentication still must fail in final().
    bad.ciphertextHash = createHash("sha256").update(canonicalJson({ formatVersion: 1, algorithm: "AES-256-GCM", binding: bad.binding, frame: bad.frame, wrapKeyRef: bad.wrapKeyRef, fingerprintKeyRef: bad.fingerprintKeyRef, nonce: bad.nonce, tag: bad.tag, ciphertext: bad.ciphertext })).digest("hex");
    assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity); assert.ok(f.provider.returnedKeys.every(k => k.every(byte => byte === 0))); }
    for (const field of ["tag", "nonce", "ciphertext"] as const) { const bad = { ...copy(item) }; (bad.wrappedKey as unknown as Record<string, unknown>)[field] = changed(bad.wrappedKey[field]); bad.wrappedKeyHash = createHash("sha256").update(canonicalJson(bad.wrappedKey)).digest("hex"); assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity); }
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("authenticated malformed UTF-8 is refused rather than normalized into returned content", () => {
  const f = fixture(); const dataKey = randomBytes(32); const raw = Buffer.concat([Buffer.from('{"content":"'), Buffer.from([255]), Buffer.from('","manifest":[]}')]);
  try { const item = sealEvidenceItem(binding(), f.frame, f.provider); const aad = Buffer.from(canonicalJson(item.binding)); const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", dataKey, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]); const wrappedKey = f.provider.wrap(scope, item.wrapKeyRef, dataKey, aad);
    const macInput = Buffer.from(canonicalJson({ projectId: scope.projectId, storeId: scope.storeId, keyRef: item.fingerprintKeyRef, input: { content: "\ufffd", manifest: [] } }));
    let mac: Uint8Array | undefined;
    try { mac = f.provider.mac(scope, "redacted-content-fingerprint", item.fingerprintKeyRef, "retained-evidence-redacted-content/v1", macInput); const bad = { ...item, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), wrappedKey, wrappedKeyHash: createHash("sha256").update(canonicalJson(wrappedKey)).digest("hex"), keyedFingerprint: Buffer.from(mac).toString("hex") };
      bad.ciphertextHash = createHash("sha256").update(canonicalJson({ formatVersion: 1, algorithm: "AES-256-GCM", binding: bad.binding, frame: bad.frame, wrapKeyRef: bad.wrapKeyRef, fingerprintKeyRef: bad.fingerprintKeyRef, nonce: bad.nonce, tag: bad.tag, ciphertext: bad.ciphertext })).digest("hex");
      assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity);
    } finally { mac?.fill(0); macInput.fill(0); }
  } finally { dataKey.fill(0); raw.fill(0); f.input.canonicalOriginalBytes.fill(0); }
});
test("seal and provider failure clear generated key and borrowed MAC scratch after return", () => {
  for (const failWrap of [false, true]) { const f = fixture(); const observed: Uint8Array[] = [];
    const provider: EvidenceKeyProvider = { currentKey: (s, p) => f.provider.currentKey(s, p), status: (s, p, r) => f.provider.status(s, p, r), wrap: (s, r, key, aad) => { observed.push(key); if (failWrap) throw new Error("synthetic-provider-private-handle"); return f.provider.wrap(s, r, key, aad); }, unwrap: (s, w, aad) => f.provider.unwrap(s, w, aad), mac: (s, p, r, d, bytes) => { observed.push(bytes); return f.provider.mac(s, p, r, d, bytes); } };
    try { if (failWrap) assert.throws(() => sealEvidenceItem(binding(), f.frame, provider), unavailable); else sealEvidenceItem(binding(), f.frame, provider); assert.equal(observed.length, 2); assert.ok(observed.every(buffer => buffer.every(byte => byte === 0))); } finally { f.input.canonicalOriginalBytes.fill(0); }
  }
});
test("cipher and wrapped-key tamper refuse", () => {
  const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider);
    for (const field of ["nonce", "tag", "ciphertext", "ciphertextHash", "wrappedKeyHash", "keyedFingerprint"] as const) { const bad = copy(item); (bad as unknown as Record<string, unknown>)[field] = field.endsWith("Hash") || field === "keyedFingerprint" ? "f".repeat(64) : changed(item[field]); assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity); }
    for (const field of ["formatVersion", "algorithm", "nonce", "tag", "ciphertext", "keyRef"] as const) { const bad = copy(item); (bad.wrappedKey as unknown as Record<string, unknown>)[field] = field === "formatVersion" ? 2 : field === "algorithm" ? "AES-128-GCM" : field === "keyRef" ? ref("original-input-commitment") : changed(bad.wrappedKey[field]); assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity); }
    for (const field of ["binding", "frame", "wrapKeyRef", "fingerprintKeyRef"] as const) { const bad = copy(item); const target = bad[field] as unknown as Record<string, unknown>; const key = field === "binding" ? "eventId" : field === "frame" ? "ordinal" : "version"; target[key] = field === "binding" ? id(999) : "2"; assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity); }
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("missing revoked foreign-purpose and historical-version keys fail closed", () => {
  const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider);
    for (const purpose of ["data-key-wrap", "redacted-content-fingerprint"] as const) { f.provider.denied.add(purpose); assert.throws(() => openEvidenceItem(binding(), item, f.provider), unavailable); f.provider.denied.clear(); }
    for (const key of ["wrapKeyRef", "fingerprintKeyRef"] as const) { const bad = copy(item); (bad[key] as { version: string }).version = "9"; if (key === "wrapKeyRef") (bad.wrappedKey.keyRef as { version: string }).version = "9"; assert.throws(() => openEvidenceItem(binding(), bad, f.provider), integrity); }
    assert.throws(() => buildRetainedEvidenceIntent(f.input, authority, policy, { ...keys, originalCommitmentKeyRef: ref("data-key-wrap") }, f.provider), unavailable);
    const historical = buildRetainedEvidenceIntent(f.input, authority, policy, { originalCommitmentKeyRef: ref("original-input-commitment", "2"), fingerprintKeyRef: ref("redacted-content-fingerprint", "2") }, f.provider); assert.equal(historical.originalCommitmentKeyRef.version, "2"); assert.equal(historical.fingerprintKeyRef.version, "2");
    f.provider.denied.add("original-input-commitment"); assert.throws(() => buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider), unavailable);
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("provider exception is safe", () => {
  for (const operation of ["current", "status", "wrap", "mac", "unwrap"]) { const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider); f.provider.failure = operation;
    const work = operation === "unwrap" ? () => openEvidenceItem(binding(), item, f.provider) : () => sealEvidenceItem(binding(), f.frame, f.provider);
    assert.throws(work, error => error instanceof RetainedEvidenceError && error.code === (operation === "unwrap" ? "INTEGRITY_FAILURE" : "RETAINED_EVIDENCE_KEY_UNAVAILABLE") && error.message === error.code && !("cause" in error) && Object.keys(error.details).length === 0);
    assert.ok(f.provider.returnedKeys.every(k => k.every(byte => byte === 0))); assert.ok(f.provider.macOutputs.every(k => k.every(byte => byte === 0)));
  } finally { f.input.canonicalOriginalBytes.fill(0); } }
});
test("pinned preparation refs survive provider current rotation and never fallback", () => {
  const f = fixture(); try { const w = buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider); f.provider.currentVersion = "2";
    const item = sealEvidenceItem(binding(), f.frame, f.provider, { wrapKeyRef: ref("data-key-wrap"), fingerprintKeyRef: w.fingerprintKeyRef });
    assert.equal(item.wrapKeyRef.version, "1"); assert.equal(item.fingerprintKeyRef.version, "1"); assert.equal(openEvidenceItem(binding(), item, f.provider).content, "visible [REDACTED]");
    assert.throws(() => sealEvidenceItem(binding(), f.frame, f.provider, { wrapKeyRef: ref("data-key-wrap", "9"), fingerprintKeyRef: w.fingerprintKeyRef }), unavailable);
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("random encryption does not change intent hash", () => {
  const f = fixture(); try { const firstWitness = buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider); const firstItem = sealEvidenceItem(binding(), f.frame, f.provider); const secondWitness = buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider); const secondItem = sealEvidenceItem(binding(), f.frame, f.provider);
    assert.equal(retainedEvidenceIntentHash(firstWitness), retainedEvidenceIntentHash(secondWitness)); assert.notEqual(firstItem.ciphertext, secondItem.ciphertext);
    assert.equal(retainedEvidenceIntentHash(firstWitness), createHash("sha256").update("project-memory/retained-evidence-command/v1\n").update(canonicalJson(firstWitness)).digest("hex"));
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("original commitment differs for collapsed secret text", () => {
  const first = fixture("fixture_alpha"); const second = fixture("fixture_beta"); try { assert.equal(first.frame.content, second.frame.content);
    const w1 = buildRetainedEvidenceIntent(first.input, authority, policy, keys, first.provider); const w2 = buildRetainedEvidenceIntent(second.input, authority, policy, keys, second.provider);
    assert.notEqual(w1.originalInputCommitment, w2.originalInputCommitment); assert.notEqual(retainedEvidenceIntentHash(w1), retainedEvidenceIntentHash(w2));
    assert.notEqual(w1.originalInputCommitment, createHash("sha256").update(first.input.canonicalOriginalBytes).digest("hex"));
    assert.equal(first.input.canonicalOriginalBytes[0], 123, "borrowed original bytes remain intact until caller clears them");
  } finally { first.input.canonicalOriginalBytes.fill(0); second.input.canonicalOriginalBytes.fill(0); }
});
test("exact MAC domains bind scope accepted refs and canonical inputs", () => {
  const f = fixture(); try { const witness = buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider); const item = sealEvidenceItem(binding(), f.frame, f.provider);
    const originalPreimage = canonicalJson({ projectId: scope.projectId, storeId: scope.storeId, keyRef: keys.originalCommitmentKeyRef, input: JSON.parse(f.input.canonicalOriginalBytes.toString()) as JsonValue });
    const redactedPreimage = canonicalJson({ projectId: scope.projectId, storeId: scope.storeId, keyRef: keys.fingerprintKeyRef, input: { content: f.frame.content, manifest: f.frame.manifest } });
    assert.equal(witness.originalInputCommitment, createHmac("sha256", Buffer.alloc(32, 2)).update("retained-evidence-original-input/v1\n").update(originalPreimage).digest("hex"));
    assert.equal(item.keyedFingerprint, createHmac("sha256", Buffer.alloc(32, 3)).update("retained-evidence-redacted-content/v1\n").update(redactedPreimage).digest("hex"));
    assert.equal(witness.policyVersion, "1"); assert.equal(witness.originalCommitmentKeyRef.version, "1"); assert.equal(witness.fingerprintKeyRef.version, "1");
    assert.equal(canonicalJson(witness), canonicalJson({ witnessVersion: 1, commandType: "retain-evidence-batch", authority, commandId: id(1), idempotencyKey: id(2), targetSessionId: id(3), conversationId: id(4), frames: [{ frameId: id(10), ordinal: "0", role: "user", category: "user-message", occurredAt: "2026-10-02T01:02:03.004Z", mediaType: "text/plain; charset=utf-8", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }], policyId: "synthetic-policy", policyVersion: "1", originalCommitmentKeyRef: { keyId: "synthetic:original-input-commitment", version: "1" }, fingerprintKeyRef: { keyId: "synthetic:redacted-content-fingerprint", version: "1" }, originalInputCommitment: witness.originalInputCommitment }));
    const encoded = canonicalJson({ witness, item: metadata(item) }); assert.ok(!encoded.includes("fixture_alpha")); assert.ok(!encoded.includes("[REDACTED]")); assert.ok(!encoded.includes("manifest"));
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("nested trusted bindings refs frame selectors and payload are owned frozen snapshots", () => {
  const f = fixture(); try { const a = copy(authority); const k = copy(keys); const w = buildRetainedEvidenceIntent(f.input, a, policy, k, f.provider); const before = retainedEvidenceIntentHash(w); (a as { targetOwnerGeneration: string }).targetOwnerGeneration = "8"; (k.originalCommitmentKeyRef as { version: string }).version = "2"; assert.equal(retainedEvidenceIntentHash(w), before);
    assert.ok(Object.isFrozen(w.authority)); assert.ok(Object.isFrozen(w.originalCommitmentKeyRef)); assert.ok(Object.isFrozen(w.frames[0]!.artifactHashes));
    const b = binding(); const item = sealEvidenceItem(b, f.frame, f.provider); (b as { eventId: string }).eventId = id(999); assert.equal(item.binding.eventId, id(200)); assert.ok(Object.isFrozen(item.wrappedKey.keyRef));
    const raw = { formatVersion: 1, witness: w, items: [metadata(item)] }; const decoded = decodeEvidenceBatchRetainedPayload(raw); raw.items.length = 0; assert.equal(decoded.items.length, 1); assert.ok(Object.isFrozen(decoded.items[0]!.binding));
    const pendingPayload: PendingEvent["payload"] = decoded; assert.equal(pendingPayload, decoded);
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("valid bounded deep JSON seals opens and hashes without recursive stack overflow", () => {
  let content: JsonValue = "visible"; for (let n = 0; n < 12_000; n++) content = [content]; const c = command(content); c.frames[0]!.mediaType = "application/json";
  const input = decodeRetainEvidenceBatch(c); const provider = new SyntheticProvider(); try { const frame = redactEvidence(input, policy).frames[0]!; const b = { ...binding(), mediaType: "application/json" as const }; const item = sealEvidenceItem(b, frame, provider); const opened = openEvidenceItem(b, item, provider); assert.equal(boundedRetainedJson(opened.content, 65_536).bytes, 24_009); assert.equal(retainedEvidenceIntentHash(buildRetainedEvidenceIntent(input, authority, policy, keys, provider)).length, 64); } finally { input.canonicalOriginalBytes.fill(0); }
});
test("strict refs and wrapped-key codecs reject noncanonical bytes versions extra fields and accessors", () => {
  assert.deepEqual(decodeEvidenceKeyRef(ref("data-key-wrap")), ref("data-key-wrap"));
  for (const bad of [{ keyId: "k", version: "0" }, { keyId: "k", version: "01" }, { keyId: "k", version: "9223372036854775808" }, { keyId: "k".repeat(129), version: "1" }, { keyId: "k", version: "1", extra: 1 }]) assert.throws(() => decodeEvidenceKeyRef(bad), unsupported);
  const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider); assert.deepEqual(decodeWrappedEvidenceKey(item.wrappedKey), item.wrappedKey); assert.deepEqual(decodeEncryptedEvidenceItem(item), item);
    for (const bad of [{ ...item.wrappedKey, nonce: item.wrappedKey.nonce + "=" }, { ...item.wrappedKey, nonce: "_" }, { ...item.wrappedKey, tag: "AA" }, { ...item.wrappedKey, ciphertext: "AA" }, { ...item.wrappedKey, algorithm: "AES-128-GCM" }, { ...item.wrappedKey, formatVersion: 2 }, { ...item.wrappedKey, padding: "x" }]) assert.throws(() => decodeWrappedEvidenceKey(bad), unsupported);
    let called = false; const hostile = { ...item, get nonce() { called = true; return item.nonce; } }; assert.throws(() => decodeEncryptedEvidenceItem(hostile), unsupported); assert.equal(called, false);
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("strict witness and payload codecs enforce selectors order correspondence and exact fields", () => {
  const f = payloadFixture(); assert.deepEqual(decodeRetainedEvidenceIntentWitness(f.payload.witness), f.payload.witness); assert.deepEqual(decodeEvidenceBatchRetainedPayload(f.payload), f.payload);
  for (const mutation of [{ witnessVersion: 2 }, { originalInputCommitment: "0" }, { secret: "synthetic" }, { frames: [] }, { authority: { ...authority, targetOwnerGeneration: "0" } }, { targetSessionId: id(999) }]) assert.throws(() => decodeRetainedEvidenceIntentWitness({ ...f.payload.witness, ...mutation }), unsupported);
  for (const mutation of [{ formatVersion: 2 }, { padding: "x" }, { items: [] }, { items: [f.payload.items[0], f.payload.items[0]] }]) assert.throws(() => decodeEvidenceBatchRetainedPayload({ ...f.payload, ...mutation }), unsupported);
  for (const field of ["eventId", "targetSessionId", "policyVersion", "projectId", "conversationId", "frameId"] as const) { const bad = copy(f.payload); (bad.items[0]!.binding as unknown as Record<string, unknown>)[field] = field.endsWith("Id") && field !== "projectId" ? id(999) : "2"; if (field === "eventId") assert.throws(() => assertRetainedStoredEvent(stored(bad)), integrity); else assert.throws(() => decodeEvidenceBatchRetainedPayload(bad), unsupported); }
  const badRef = copy(f.payload); (badRef.items[0]!.fingerprintKeyRef as { version: string }).version = "2"; assert.throws(() => decodeEvidenceBatchRetainedPayload(badRef), unsupported);
});
test("root and child witnesses preserve actual nullable fences and admitted root-owner metadata", () => {
  const f = fixture(); try {
    const root = buildRetainedEvidenceIntent(f.input, authority, policy, keys, f.provider); assert.equal(root.authority.rootSessionId, id(3)); assert.equal(root.authority.rootOwnerGeneration, "1"); assert.equal(root.authority.authorizingCapabilityGeneration, null);
    const childInput = decodeRetainEvidenceBatch({ ...command(), targetSessionId: id(30) });
    try { const child = buildRetainedEvidenceIntent(childInput, { ...authority, targetSessionId: id(30), parentSessionId: id(3), targetOwnerGeneration: null, targetCapabilityGeneration: null }, policy, keys, f.provider); assert.equal(child.authority.targetOwnerGeneration, null); assert.equal(child.authority.targetCapabilityGeneration, null); assert.equal(child.authority.rootOwnerGeneration, "1");
      const direct = buildRetainedEvidenceIntent(childInput, { ...authority, authorizationSessionId: id(30), targetSessionId: id(30), parentSessionId: id(3), authorizingOwnerGeneration: null, authorizingCapabilityGeneration: "2", targetOwnerGeneration: null, targetCapabilityGeneration: "2", capabilityKind: "child-session-handle", presentingActorRole: "untrusted", targetActorRole: "untrusted" }, policy, keys, f.provider); assert.equal(direct.authority.authorizingOwnerGeneration, null); assert.equal(direct.authority.authorizingCapabilityGeneration, "2");
      for (const mutation of [{ rootSessionId: id(31) }, { rootOwnerGeneration: "0" }, { targetOwnerGeneration: "1" }, { authorizingCapabilityGeneration: "2" }]) assert.throws(() => buildRetainedEvidenceIntent(childInput, { ...authority, targetSessionId: id(30), parentSessionId: id(3), targetOwnerGeneration: null, ...mutation }, policy, keys, f.provider), unsupported);
    } finally { childInput.canonicalOriginalBytes.fill(0); }
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("stored event validates exact retained correspondence and keeps legacy empty evidence", () => {
  const f = payloadFixture(); const event = stored(f.payload); assert.deepEqual(assertRetainedStoredEvent(event), f.payload);
  for (const mutation of [{ eventId: id(999) }, { commandId: id(999) }, { idempotencyKey: id(999) }, { sessionId: id(999) }, { projectId: "f".repeat(64) }, { workspaceId: "f".repeat(64) }, { parentSessionId: id(999) }, { actorRole: "maintenance" }, { clientInstanceId: "other" }, { eventSchemaVersion: 2 }, { commandEventIndex: 1 }]) assert.throws(() => assertRetainedStoredEvent({ ...event, ...mutation } as StoredEvent), integrity);
  assert.equal(assertRetainedStoredEvent({ ...event, eventType: "Other", evidenceRefs: [], evidenceDigests: [] }), null);
  assert.throws(() => assertRetainedStoredEvent({ ...event, eventType: "Other", evidenceRefs: [id(100)] } as unknown as StoredEvent), integrity);
  assert.throws(() => assertRetainedStoredEvent({ ...event, evidenceDigests: [{ ciphertextHash: "0".repeat(64), keyedFingerprint: "0".repeat(64) }] } as unknown as StoredEvent), integrity);
});
test("stored retained correspondence reads canonical payloadJson and treats cache as opaque", () => {
  const f = payloadFixture(); const event = stored(f.payload); assert.deepEqual(assertRetainedStoredEvent({ ...event, payload: {} }), f.payload);
  let invoked = false; const cache = { get witness() { invoked = true; throw new Error("synthetic-cache-handle"); } };
  assert.deepEqual(assertRetainedStoredEvent({ ...event, payload: cache as unknown as StoredEvent["payload"] }), f.payload); assert.equal(invoked, false);
  assert.deepEqual(assertRetainedStoredEvent({ ...event, payload: { formatVersion: 99 } }), f.payload);
  for (const payloadJson of ["{", " " + event.payloadJson, canonicalJson({ ...f.payload, formatVersion: 2 }), event.payloadJson.replace(id(200), id(999))]) assert.throws(() => assertRetainedStoredEvent({ ...event, payloadJson }), integrity);
  for (const payload of [null, [], new Date(), new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error("synthetic-cache-handle"); } })]) assert.throws(() => assertRetainedStoredEvent({ ...event, payload: payload as StoredEvent["payload"] }), integrity);
  assert.equal(invoked, false);
});
test("byte guards enforce exact bundle and complete-result boundaries", () => {
  assert.doesNotThrow(() => assertRetainedByteLimit(2_097_152, 2_097_152)); assert.throws(() => assertRetainedByteLimit(2_097_153, 2_097_152), limit);
  assert.doesNotThrow(() => assertRetainedByteLimit(16_384, 16_384)); assert.throws(() => assertRetainedByteLimit(16_385, 16_384), limit);
});
test("actual encoded bundle including metadata and wrapped keys is measured before persistence", () => {
  const f = fixture(); try { const item = sealEvidenceItem(binding(), f.frame, f.provider); assert.doesNotThrow(() => assertRetainedEvidenceBundle([item]));
    const wide = { ...item, ciphertext: Buffer.alloc(1_048_576).toString("base64url") }; assert.throws(() => assertRetainedEvidenceBundle([wide, wide]), limit);
    assert.throws(() => assertRetainedEvidenceBundle([{ ...item, padding: "x".repeat(2_097_153) }] as unknown as EncryptedEvidenceItemV1[]), unsupported);
  } finally { f.input.canonicalOriginalBytes.fill(0); }
});
test("complete safe result codec measures real maximum valid shape and rejects fake padding", () => {
  const evidenceIds = Array.from({ length: 64 }, (_, n) => id(100 + n)); const response = { resultVersion: 1, operation: "retain-evidence-batch", retentionFormat: "redacted-encrypted-v1", targetSessionId: id(3), conversationId: id(4), commandId: id(1), idempotencyKey: id(2), evidenceIds, eventPosition: "9223372036854775807", finalStreamVersion: "9223372036854775807" };
  const result = { eventIds: [id(200)], firstGlobalPosition: "9223372036854775807", lastGlobalPosition: "9223372036854775807", finalStreamVersion: "9223372036854775807", response };
  assert.ok(Buffer.byteLength(canonicalJson(result)) < 16_384); assert.deepEqual(decodeRetainedEvidenceStoredResult(result), result);
  assert.throws(() => decodeRetainedEvidenceStoredResult({ ...result, padding: "x".repeat(16_385) }), unsupported);
  assert.throws(() => decodeRetainedEvidenceStoredResult({ ...result, eventIds: Array.from({ length: 400 }, (_, n) => id(200 + n)) }), limit);
  assert.throws(() => decodeRetainedEvidenceStoredResult({ ...result, lastGlobalPosition: "1" }), unsupported);
});
