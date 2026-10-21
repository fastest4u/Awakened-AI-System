import test from "node:test";
import assert from "node:assert/strict";
import * as codec from "../src/orchestrator/governed-notes/codec.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { assertMarkdownNoteBodyV1, governedNoteBodyHash } from "../src/orchestrator/governed-notes/body-content.js";
import type { GovernedNoteCommandV2, PreparedGovernedNoteCreateV2, PreparedGovernedNoteRecoveryV2, GovernedNoteStoredResultV2, GovernedNoteCreatedPayloadV2, GovernedNoteSourcePayloadV2 } from "../src/orchestrator/governed-notes/contracts.js";
import { createHash } from "node:crypto";

// Compile-safe RED admission: missing APIs must fail assertions, not TypeScript.
function api<K extends keyof typeof codec>(name: K): (typeof codec)[K] {
  const value = Object.getOwnPropertyDescriptor(codec, name)?.value;
  assert.equal(typeof value, "function", `missing V2 behavior: ${name}`);
  return value as (typeof codec)[K];
}
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { commandId: id(1), idempotencyKey: id(2) };
const invalid = { code: "GOVERNED_NOTE_INPUT_INVALID" }, limit = { code: "GOVERNED_NOTE_LIMIT_EXCEEDED" };
const body = '  ```\r\n\tไทย e\u0301 😀  \r\n```\n';
const command = (text = body) => ({ version: 2, operation: "create-governed-note", ...ids, recordKind: "insight", summary: "summary", confidence: "medium", provenance: [{ kind: "source-event", identity: id(10) }], content: { format: "markdown", body: text } });
const authorization = { kind: "protected", authoritySessionId: id(6), targetSessionId: id(6), proof: { proofVersion: 1, target: "semantic-command", proofNonce: id(5), proofFingerprint: "a".repeat(64) }, approval: null, childBindingGrant: null };
const scope = { projectId: id(20), vaultId: id(21), storeId: id(22), workspaceId: "b".repeat(64), branchScopeId: null, branchRef: null, sessionId: id(6) };
const receipt = () => ({ resultVersion: 2, operation: "create-governed-note", ...ids, recordId: id(7), recordKind: "insight", status: "candidate", verificationStatus: "unverified", scope, sourceEventIds: [id(8), id(9)], terminalPosition: "2", content: { format: "markdown", contentHash: "a".repeat(64) } });

test("literal_v2_boundaries", () => {
  const decode = api("decodeGovernedNoteCommandV2");
  assert.equal(decode(command()).content.body, body);
  for (const text of ["x".repeat(65536), "\\".repeat(65536), "😀".repeat(16384)]) assert.equal(decode(command(text)).content.body, text);
  assert.equal(Buffer.byteLength(JSON.stringify("\\".repeat(65536))), 131074);
  for (const bad of ["x".repeat(65537), "😀".repeat(16384) + "x"]) assert.throws(() => decode(command(bad)), limit);
  for (const bad of ["\u0000x", "\u007fx", "\ud800", "\udc00", " \t\r\n", "", "\u000bx"]) assert.throws(() => decode(command(bad)), invalid);
  assert.throws(() => codec.decodeGovernedNoteCommandV1(command()));
  for (const patch of [{ version: 1 }, { recordKind: "task" }, { content: { format: "html", body } }, { content: { format: "markdown", body, contentHash: "a".repeat(64) } }, { summary: "x".repeat(2049) }]) assert.throws(() => decode({ ...command(), ...patch }));
});

test("owned_body_copy_preserves_literal_and_rejects_effectful_inputs", () => {
  const decode = api("decodeGovernedNoteCommandV2"); let getterCalls = 0, trapCalls = 0;
  const getter = (field: string, value: unknown) => Object.defineProperty(value, field, { enumerable: true, get() { getterCalls++; throw Error("getter"); } });
  const proxy = new Proxy(command(), { get() { trapCalls++; throw Error("trap"); }, ownKeys() { trapCalls++; throw Error("trap"); }, getPrototypeOf() { trapCalls++; throw Error("trap"); } });
  const nestedProxy = new Proxy(command().content, { ownKeys() { trapCalls++; throw Error("trap"); } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [proxy, getter("version", command()), { ...command(), content: getter("body", command().content) }, { ...command(), content: nestedProxy }, new Date(), { ...command(), [Symbol("extra")]: 1 }, { ...command(), extra: cyclic }, { ...command(), content: Object.assign(Object.create(Date.prototype), command().content) }]) assert.throws(() => decode(value), invalid);
  assert.equal(getterCalls, 0); assert.equal(trapCalls, 0);
  const nullPrototype = Object.assign(Object.create(null), command()); nullPrototype.content = Object.assign(Object.create(null), command().content);
  assert.equal(canonicalJson(decode(nullPrototype)), canonicalJson(decode(command())));
  const input = command(); const owned = decode(input); input.content.body = "changed";
  assert.equal(owned.content.body, body); assert.ok(Object.isFrozen(owned.content));
  const check = (at: unknown, over: unknown) => { assert.throws(() => decode({ ...command(), extra: at }), invalid); assert.throws(() => decode({ ...command(), extra: over }), limit); };
  const nested = (depth: number) => { let item: unknown = null; for (let n = 0; n < depth; n++) item = [item]; return item; };
  check(nested(8), nested(9)); check(Array(64).fill(null), Array(65).fill(null));
  check(Object.fromEntries(Array.from({ length: 32 }, (_, n) => [String(n), null])), Object.fromEntries(Array.from({ length: 33 }, (_, n) => [String(n), null])));
  const containers = (n: number) => [Array.from({ length: 62 }, () => []), Array.from({ length: n - 4 - 62 }, () => [])];
  check(containers(125), containers(126));
  assert.throws(() => decode({ ...command(), extra: { body: "x".repeat(2049) } }), limit);
  assert.throws(() => decode({ ...command(), "content.body": "x".repeat(2049) }), limit);
});

test("v2_wire_rejects_duplicate_members_and_noncanonical_bytes", () => {
  const encode = api("encodePreparedGovernedNoteCreateV2"), decode = api("decodePreparedGovernedNoteCreateV2");
  const input = { command: command("\\".repeat(65536)), authorization } as unknown as PreparedGovernedNoteCreateV2; const wire = encode(input);
  assert.deepEqual(decode(wire), input); assert.throws(() => decode(input), invalid);
  for (const text of [" " + wire.command, wire.command.replace('"version":2', '"version":2,"version":2'), wire.command.replace('"body":', '"body":"extra","body":')]) assert.throws(() => decode({ ...wire, command: text }), invalid);
  assert.equal(api("encodeGovernedNoteCommandV2")(command() as GovernedNoteCommandV2), canonicalJson(command()));
});

test("receipt_recovery_discriminants_are_exact", () => {
  const decode = api("decodeGovernedNoteStoredReceiptV2"), recover = api("decodeGovernedNoteRecoveryResultV2");
  assert.deepEqual(decode(receipt()), receipt());
  const committed = { resultVersion: 2, operation: "recover-governed-note-result", outcome: "committed", receipt: { ...receipt(), replay: true } };
  assert.deepEqual(recover(committed), committed);
  const { content: _content, ...v1 } = receipt(); const old = { ...v1, resultVersion: 1, replay: true };
  const historical = recover({ ...committed, receipt: old }); assert.equal(historical.outcome, "committed"); if (historical.outcome === "committed") assert.deepEqual(historical.receipt, old);
  assert.throws(() => decode({ ...receipt(), resultVersion: 1 }), { code: "GOVERNED_NOTE_FORMAT_UNSUPPORTED" });
  for (const patch of [{ replay: true }, { content: { ...receipt().content, body } }, { content: { format: "html", contentHash: "a".repeat(64) } }, { terminalPosition: "02" }]) assert.throws(() => decode({ ...receipt(), ...patch }), invalid);
  assert.throws(() => recover({ ...committed, receipt: { ...old, content: receipt().content } }), invalid);
  assert.throws(() => recover({ ...committed, receipt: { ...receipt(), replay: false } }), invalid);
  assert.deepEqual(recover({ resultVersion: 2, operation: "recover-governed-note-result", outcome: "not-found", ...ids }), { resultVersion: 2, operation: "recover-governed-note-result", outcome: "not-found", ...ids });
});

const digest = (domain: string, value: unknown) => createHash("sha256").update(domain + "\n" + canonicalJson(value)).digest("hex");
function source(text = body) {
  return { sourceVersion: 3, binding: scope, item: { itemId: id(7), normalizedKey: `governed-note/insight/${id(7)}`, status: "candidate", confidence: "medium", verificationMethod: "governed-note-unverified-v2", validFrom: "2026-10-09T00:00:00.000Z", validTo: null, summary: "summary", contentHash: digest("project-memory/governed-note-summary/v1", "summary"), conflictGroupId: null, supersedingItemId: null, anchor: null, recordKind: "insight", content: { format: "markdown", body: text, contentHash: digest("project-memory/governed-note-body/v1", { format: "markdown", body: text }) } }, followUps: [], artifacts: [], entities: [], aliases: [], edges: [] };
}
function created() {
  const authority = { ...scope, clientNamespace: "test", presentingActorRole: "primary", presentingClientInstanceId: "client", targetActorRole: "primary", targetClientInstanceId: "client", authorizationSessionId: id(6), targetSessionId: id(6), parentSessionId: null, rootSessionId: id(6), rootOwnerGeneration: "1", authorizingOwnerGeneration: "1", authorizingCapabilityGeneration: null, targetOwnerGeneration: "1", targetCapabilityGeneration: null, capabilityKind: "root-session-handle" };
  const { branchRef: _ref, branchScopeId: _branch, sessionId: _session, ...a } = authority;
  return { formatVersion: 2, witness: { witnessVersion: 2, commandType: "create-governed-note", ...ids, recordId: id(7), recordKind: "insight", confidence: "medium", authority: a, binding: scope, provenance: [{ kind: "source-event", identity: id(10), sourceEventId: id(10), sourceEventPosition: "1", sourceEventHash: "a".repeat(64), sourceCommandId: id(11), sourceIdempotencyKey: id(12) }], policyId: "policy", policyVersion: "1", originalCommitmentKeyRef: { keyId: "key", version: "1" }, originalInputCommitment: "a".repeat(64), summaryContentHash: source().item.contentHash, noteEventId: id(8), sourceEventId: id(9), recordedAt: "2026-10-09T00:00:00.000Z", contentFormat: "markdown", bodyContentHash: source().item.content.contentHash } };
}

test("body_hash_and_durable_source_are_literal_and_version_exact", () => {
  assert.doesNotThrow(() => assertMarkdownNoteBodyV1("x".repeat(65536)));
  for (const bad of ["x".repeat(65537), "\u0000x", "\u007fx", "\ud800", " \t\r\n"]) assert.throws(() => assertMarkdownNoteBodyV1(bad));
  assert.equal(governedNoteBodyHash({ format: "markdown", body }), source().item.content.contentHash);
  assert.notEqual(governedNoteBodyHash({ format: "markdown", body }), governedNoteBodyHash({ format: "markdown", body: body.normalize("NFC") }));
  const valid: GovernedNoteSourcePayloadV2 = codec.decodeGovernedNoteSourcePayloadV2(source()); assert.deepEqual(valid, source()); assert.ok(Object.isFrozen(valid.item.content));
  assert.equal(codec.decodeGovernedNoteSourcePayloadV2(source("\\".repeat(65536))).item.content.body.length, 65536);
  for (const itemPatch of [{ recordKind: "adr" }, { verificationMethod: "governed-note-unverified-v1" }, { summary: " e\u0301 " }, { content: { ...source().item.content, contentHash: "a".repeat(64) } }, { content: { ...source().item.content, body: "changed" } }, { content: { ...source().item.content, extra: true } }]) assert.throws(() => codec.decodeGovernedNoteSourcePayloadV2({ ...source(), item: { ...source().item, ...itemPatch } }), invalid);
  for (const patch of [{ sourceVersion: 2 }, { followUps: [{}] }, { body }]) assert.throws(() => codec.decodeGovernedNoteSourcePayloadV2({ ...source(), ...patch }), invalid);
  assert.throws(() => codec.decodeGovernedNoteSourcePayloadV1(source()), invalid);
  assert.throws(() => codec.decodeGovernedNoteSourcePayloadV2({ ...source(), "item.content.body": "x".repeat(2049) }), limit);
  assert.throws(() => codec.decodeGovernedNoteSourcePayloadV2({ ...source(), item: { ...source().item, "content.body": "x".repeat(2049) } }), limit);
  const c: GovernedNoteCreatedPayloadV2 = codec.decodeGovernedNoteCreatedPayloadV2(created()); assert.deepEqual(c, created());
  for (const patch of [{ witnessVersion: 1 }, { contentFormat: "html" }, { bodyContentHash: "bad" }, { content: { format: "markdown", body } }]) assert.throws(() => codec.decodeGovernedNoteCreatedPayloadV2({ ...created(), witness: { ...created().witness, ...patch } }), invalid);
  assert.throws(() => codec.decodeGovernedNoteCreatedPayloadV2({ ...created(), formatVersion: 1 }), invalid);
  assert.throws(() => codec.decodeGovernedNoteCreatedPayloadV1(created()), invalid);
});

// Add inert invalid metadata to isolate encoded accounting before exact-shape rejection.
function paddingAt(base: object, bytes: number) {
  const count = Math.ceil((bytes - Buffer.byteLength(canonicalJson(base))) / 2051);
  const extra = Array.from({ length: count }, () => "x".repeat(2048));
  const value = { ...base, extra }; const excess = Buffer.byteLength(canonicalJson(value)) - bytes;
  extra[count - 1] = "x".repeat(2048 - excess); assert.equal(Buffer.byteLength(canonicalJson(value)), bytes); return value;
}
test("independent_encoded_metadata_authorization_and_body_free_result_gates", () => {
  const c = command(); const blank = { ...c, content: { ...c.content, body: "" } };
  const validBase = { ...blank, summary: "x", provenance: Array.from({ length: 64 }, (_, n) => ({ kind: "source-event", identity: id(10 + n) })) };
  const summaryBytes = 8192 - Buffer.byteLength(canonicalJson(validBase)) + 1;
  const exactSummary = "\u0001".repeat(Math.floor(summaryBytes / 6)) + "x".repeat(summaryBytes % 6);
  const validMaximum = { ...validBase, summary: exactSummary, content: { format: "markdown", body: "\\".repeat(65536) } };
  assert.equal(Buffer.byteLength(canonicalJson({ ...validMaximum, content: { ...validMaximum.content, body: "" } })), 8192);
  assert.equal(Buffer.byteLength(canonicalJson(codec.decodeGovernedNoteCommandV2(validMaximum))), 139264);
  assert.throws(() => codec.decodeGovernedNoteCommandV2({ ...validMaximum, summary: exactSummary + "x" }), limit);
  for (const bytes of [8192, 8193]) {
    const padded = paddingAt(blank, bytes); const value = { ...padded, content: c.content };
    assert.throws(() => codec.decodeGovernedNoteCommandV2(value), bytes === 8192 ? invalid : limit);
  }
  for (const bytes of [16384, 16385]) {
    assert.throws(() => codec.encodePreparedGovernedNoteCreateV2({ command: c, authorization: paddingAt(authorization, bytes) } as unknown as PreparedGovernedNoteCreateV2), bytes === 16384 ? invalid : limit);
    assert.throws(() => codec.decodeGovernedNoteStoredReceiptV2(paddingAt(receipt(), bytes)), bytes === 16384 ? invalid : limit);
    assert.throws(() => codec.decodeGovernedNoteRecoveryResultV2(paddingAt({ resultVersion: 2, operation: "recover-governed-note-result", outcome: "not-found", ...ids }, bytes)), bytes === 16384 ? invalid : limit);
  }
  const s = source(); const emptyBody = { ...s, item: { ...s.item, content: { ...s.item.content, body: "" } } };
  for (const bytes of [65536, 65537]) {
    const padded = paddingAt(emptyBody, bytes); const value = { ...padded, item: s.item };
    assert.throws(() => codec.decodeGovernedNoteSourcePayloadV2(value), bytes === 65536 ? invalid : limit);
  }
  const large = [Array(64).fill("x".repeat(2048)), Array(64).fill("x".repeat(2048)), Array(64).fill("x".repeat(2048))];
  assert.ok(Buffer.byteLength(canonicalJson({ ...c, extra: large })) > 196608);
  assert.throws(() => codec.decodeGovernedNoteCommandV2({ ...c, extra: large }), limit);
  for (const decode of [codec.decodeGovernedNoteCreatedPayloadV2, codec.decodeGovernedNoteSourcePayloadV2]) assert.throws(() => decode({ ...(decode === codec.decodeGovernedNoteCreatedPayloadV2 ? created() : s), extra: large }), limit);
  const max = command("\\".repeat(65536)); assert.ok(Buffer.byteLength(canonicalJson(codec.decodeGovernedNoteCommandV2(max))) < 196608);
  assert.ok(Buffer.byteLength(canonicalJson(codec.decodeGovernedNoteSourcePayloadV2(source("\\".repeat(65536))))) < 262144);
});

test("recovery_wire_stored_result_and_existing_identity_domains_are_preserved", () => {
  const request = { version: 2, operation: "recover-governed-note-result", operationId: id(3), requestId: id(4), ...ids, expiresAt: "2026-10-09T00:00:00.000Z" };
  const audience = { presentingActorRole: "primary", presentingClientInstanceId: "client", targetActorRole: "primary", targetClientInstanceId: "client" };
  const prepared = { request, authorization: { kind: "bounded-operation", authoritySessionId: id(6), targetSessionId: id(6), proof: { ...authorization.proof, target: "bounded-operation" }, audience } } as PreparedGovernedNoteRecoveryV2;
  const wire = codec.encodePreparedGovernedNoteRecoveryV2(prepared); assert.deepEqual(codec.decodePreparedGovernedNoteRecoveryV2(wire), prepared);
  for (const text of [" " + wire.request, wire.request.replace('"version":2', '"version":2,"version":2')]) assert.throws(() => codec.decodePreparedGovernedNoteRecoveryV2({ ...wire, request: text }), invalid);
  for (const bytes of [8192, 8193]) assert.throws(() => codec.decodeGovernedNoteRecoveryV2(paddingAt(request, bytes)), bytes === 8192 ? invalid : limit);
  const stored = { eventIds: [id(8), id(9)], firstGlobalPosition: "1", lastGlobalPosition: "2", finalStreamVersion: "2", response: receipt() };
  const decoded: GovernedNoteStoredResultV2 = codec.decodeGovernedNoteStoredResultV2(stored); assert.deepEqual(decoded, stored);
  for (const bytes of [16384, 16385]) assert.throws(() => codec.decodeGovernedNoteStoredResultV2(paddingAt(stored, bytes)), bytes === 16384 ? invalid : limit);
  assert.throws(() => codec.decodeGovernedNoteStoredResultV2({ ...stored, response: { ...receipt(), resultVersion: 1 } }));
  for (const sessionVersion of [1, 2, 3, 5]) {
    const sessionId = id(6).replace("4000", `${sessionVersion}000`), patchedScope = { ...scope, projectId: "a".repeat(64), vaultId: "c".repeat(64), storeId: "d".repeat(64), branchScopeId: sessionId, sessionId };
    assert.deepEqual(codec.decodeGovernedNoteStoredReceiptV2({ ...receipt(), scope: patchedScope }).scope, patchedScope);
    const input = { command: command(), authorization: { ...authorization, authoritySessionId: sessionId, targetSessionId: sessionId } } as unknown as PreparedGovernedNoteCreateV2;
    assert.deepEqual(codec.decodePreparedGovernedNoteCreateV2(codec.encodePreparedGovernedNoteCreateV2(input)), input);
  }
  assert.throws(() => codec.decodeGovernedNoteCommandV2({ ...command(), commandId: id(1).replace("4000", "5000") }), invalid);
});
