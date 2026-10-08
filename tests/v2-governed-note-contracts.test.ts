import test from "node:test";
import assert from "node:assert/strict";
import * as codec from "../src/orchestrator/governed-notes/codec.js";
import { GOVERNED_NOTE_ERROR_CODES, GovernedNoteError } from "../src/orchestrator/governed-notes/errors.js";
import type { PreparedGovernedNoteCreateV1, PreparedGovernedNoteRecoveryV1 } from "../src/orchestrator/governed-notes/contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { commandId: id(1), idempotencyKey: id(2) };
const invalid = { code: "GOVERNED_NOTE_INPUT_INVALID" }, limit = { code: "GOVERNED_NOTE_LIMIT_EXCEEDED" };
const command = (summary = "summary", count = 1) => ({ version: 1, operation: "create-governed-note", ...ids, recordKind: "insight", summary, confidence: "medium", provenance: Array.from({ length: count }, (_, n) => ({ kind: "source-event", identity: id(10 + n) })) });
const recovery = () => ({ version: 1, operation: "recover-governed-note-result", operationId: id(3), requestId: id(4), ...ids, expiresAt: "2026-10-08T00:00:00.000Z" });
const proof = (target = "semantic-command") => ({ proofVersion: 1, target, proofNonce: id(5), proofFingerprint: "a".repeat(64) });
const authorization = () => ({ kind: "protected", authoritySessionId: id(6), targetSessionId: id(6), proof: proof(), approval: null, childBindingGrant: null });
const audience = { presentingActorRole: "primary", presentingClientInstanceId: "client", targetActorRole: "primary", targetClientInstanceId: "client" };
const timing = { requestTimeoutMs: 15000, closeTimeoutMs: 5000, recoveryProofLifetimeMs: 60000, maxPending: 128, executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 15000, sqliteBusyTimeoutMs: 5000 };
const scope = { projectId: id(20), vaultId: id(21), storeId: id(22), workspaceId: "b".repeat(64), branchScopeId: null, branchRef: null, sessionId: id(6) };
const receipt = () => ({ resultVersion: 1, operation: "create-governed-note", ...ids, recordId: id(7), recordKind: "insight", status: "candidate", verificationStatus: "unverified", scope, sourceEventIds: [id(8), id(9)], terminalPosition: "2" });

test("summary caps raw normalized and redacted UTF8 without clipping", () => {
  assert.equal(Buffer.byteLength(codec.decodeGovernedNoteCommandV1(command("🙂".repeat(512))).summary), 2048);
  assert.throws(() => codec.decodeGovernedNoteCommandV1(command("🙂".repeat(512) + "x")), limit);
  for (const text of ["\ud800", "\udc00", "", " \n\t"]) assert.throws(() => codec.decodeGovernedNoteCommandV1(command(text)), invalid);
  // U+0344 expands to two combining characters under NFC.
  assert.throws(() => codec.decodeGovernedNoteCommandV1(command("\u0344".repeat(600))), limit);
});
test("owned canonical input refuses exotic shape and duplicate selectors", () => {
  let trapCalls = 0, getterCalls = 0;
  const proxy = new Proxy(command(), { ownKeys() { trapCalls++; throw Error("trap"); }, getPrototypeOf() { trapCalls++; throw Error("trap"); } });
  const accessor = Object.defineProperty(command(), "summary", { enumerable: true, get() { getterCalls++; return "value"; } });
  const sparse = command(); sparse.provenance = Array(1);
  for (const value of [proxy, accessor, sparse, new Date(), { ...command(), extra: 1 }, { ...command(), [Symbol("key")]: 1 }, { ...command(), confidence: undefined }, { ...command(), confidence: NaN }, { ...command(), provenance: [command().provenance[0], command().provenance[0]] }]) assert.throws(() => codec.decodeGovernedNoteCommandV1(value), invalid);
  assert.equal(trapCalls, 0); assert.equal(getterCalls, 0);
  const original = command(); const decoded = codec.decodeGovernedNoteCommandV1(original); original.summary = "changed";
  assert.equal(decoded.summary, "summary"); assert.ok(Object.isFrozen(decoded)); assert.ok(Object.isFrozen(decoded.provenance)); assert.ok(Object.isFrozen(decoded.provenance[0]));
});
test("provenance requires one through sixty four selectors", () => {
  assert.throws(() => codec.decodeGovernedNoteCommandV1(command("summary", 0)), invalid);
  for (const n of [1, 64]) assert.equal(codec.decodeGovernedNoteCommandV1(command("summary", n)).provenance.length, n);
  assert.throws(() => codec.decodeGovernedNoteCommandV1(command("summary", 65)), limit);
});
test("provenance set ordering preserves raw summary", () => {
  const raw = "  e\u0301\n"; const value = { ...command(raw), provenance: [{ kind: "source-event", identity: id(12) }, { kind: "retained-evidence", identity: id(11) }, { kind: "source-event", identity: id(10) }] };
  assert.deepEqual(codec.decodeGovernedNoteCommandV1(value).provenance, [{ kind: "retained-evidence", identity: id(11) }, { kind: "source-event", identity: id(10) }, { kind: "source-event", identity: id(12) }]);
  assert.equal(codec.decodeGovernedNoteCommandV1(value).summary, raw);
  for (const recordKind of ["session-log", "insight", "mistake", "adr"]) assert.equal(codec.decodeGovernedNoteCommandV1({ ...command(), recordKind }).recordKind, recordKind);
});
test("unsupported version differs from invalid shape", () => {
  for (const patch of [{ version: 2 }, { operation: "future" }]) assert.throws(() => codec.decodeGovernedNoteCommandV1({ ...command(), ...patch }), { code: "GOVERNED_NOTE_FORMAT_UNSUPPORTED" });
  for (const patch of [{ version: "1" }, { operation: null }, { commandId: id(0xab).toUpperCase() }, { commandId: id(1).replace("4000", "5000") }]) assert.throws(() => codec.decodeGovernedNoteCommandV1({ ...command(), ...patch }), invalid);
  assert.deepEqual(codec.decodeGovernedNoteRecoveryV1(recovery()), recovery());
  for (const patch of [{ expiresAt: "2026-10-08" }, { requestId: "bad" }, { summary: "extra" }]) assert.throws(() => codec.decodeGovernedNoteRecoveryV1({ ...recovery(), ...patch }), invalid);
});
test("semantic packing accounts for JSON escape overhead", () => {
  const base = command("x", 64); const overhead = Buffer.byteLength(canonicalJson(base)) - 1;
  const escaped = 8192 - overhead; const six = Math.floor(escaped / 6), remainder = escaped % 6;
  const value = command("\u0001".repeat(six) + "x".repeat(remainder), 64);
  assert.equal(Buffer.byteLength(canonicalJson(value)), 8192);
  assert.ok(Buffer.byteLength(value.summary) <= 2048);
  assert.equal(codec.decodeGovernedNoteCommandV1(value).summary, value.summary);
  assert.throws(() => codec.decodeGovernedNoteCommandV1({ ...value, summary: value.summary + "x" }), limit);
});
test("decoder structural budgets are independent", () => {
  const check = (at: unknown, over: unknown) => { assert.throws(() => codec.decodeGovernedNoteCommandV1({ ...command(), extra: at }), invalid); assert.throws(() => codec.decodeGovernedNoteCommandV1({ ...command(), extra: over }), limit); };
  const nested = (depth: number) => { let item: unknown = null; for (let n = 0; n < depth; n++) item = [item]; return item; };
  // Existing protocol convention: command root depth 0, nested container depth 8 is supported.
  check(nested(8), nested(9));
  check(Object.fromEntries(Array.from({ length: 32 }, (_, n) => [String(n), null])), Object.fromEntries(Array.from({ length: 33 }, (_, n) => [String(n), null])));
  check(Array(64).fill(null), Array(65).fill(null));
  // Command root + provenance array + selector = 3 containers; extra outer array = 1.
  const containers = (n: number) => [Array.from({ length: 62 }, () => []), Array.from({ length: n - 3 - 62 }, () => [])];
  check(containers(125), containers(126));
  const authBase = authorization(); const baseBytes = Buffer.byteLength(canonicalJson(authBase));
  const authWithBytes = (bytes: number) => ({ ...authBase, extra: Array.from({ length: 8 }, (_, n) => "x".repeat(n === 7 ? bytes - baseBytes - 11 - 16 - 7 - 7 * 2048 : 2048)) });
  // Direct admission sees authorization packing separately, before exact shape rejection.
  for (const bytes of [16384, 16385]) {
    const auth = authWithBytes(bytes); assert.equal(Buffer.byteLength(canonicalJson(auth)), bytes);
    assert.throws(() => codec.encodePreparedGovernedNoteCreateV1({ command: command(), authorization: auth } as unknown as PreparedGovernedNoteCreateV1), bytes === 16384 ? invalid : limit);
  }
});
test("prepared canonical transport validates authority independently and never accepts raw prepared objects", () => {
  const input = { command: command("x".repeat(2048), 64), authorization: authorization() } as unknown as PreparedGovernedNoteCreateV1;
  const wire = codec.encodePreparedGovernedNoteCreateV1(input); assert.ok(wire.command.length > 2048);
  assert.deepEqual(codec.decodePreparedGovernedNoteCreateV1(wire), input);
  assert.throws(() => codec.decodePreparedGovernedNoteCreateV1(input), invalid);
  for (const commandText of [" " + wire.command, wire.command.replace('"version":1', '"version":1,"version":1')]) assert.throws(() => codec.decodePreparedGovernedNoteCreateV1({ ...wire, command: commandText }), invalid);
  for (const patch of [{ targetSessionId: id(40) }, { proof: null }, { approval: {} }, { childBindingGrant: {} }, { proof: { ...proof(), token: "forbidden" } }, { proof: proof("bounded-operation") }]) assert.throws(() => codec.encodePreparedGovernedNoteCreateV1({ ...input, authorization: { ...authorization(), ...patch } } as unknown as PreparedGovernedNoteCreateV1), invalid);
  const r = { request: recovery(), authorization: { kind: "bounded-operation", authoritySessionId: id(6), targetSessionId: id(6), proof: proof("bounded-operation"), audience } } as unknown as PreparedGovernedNoteRecoveryV1;
  assert.deepEqual(codec.decodePreparedGovernedNoteRecoveryV1(codec.encodePreparedGovernedNoteRecoveryV1(r)), r);
  assert.throws(() => codec.encodePreparedGovernedNoteRecoveryV1({ ...r, authorization: { ...r.authorization, audience: { ...audience, token: "extra" } } } as unknown as PreparedGovernedNoteRecoveryV1), invalid);
});
test("errors have exact closed code message and original identity details", () => {
  const expectedCodes = ["GOVERNED_NOTE_CONFIG_INVALID", "GOVERNED_NOTE_INPUT_INVALID", "GOVERNED_NOTE_LIMIT_EXCEEDED", "GOVERNED_NOTE_FORMAT_UNSUPPORTED", "GOVERNED_NOTE_POLICY_UNAVAILABLE", "GOVERNED_NOTE_KEY_UNAVAILABLE", "GOVERNED_NOTE_PROVENANCE_INELIGIBLE", "GOVERNED_NOTE_UNAVAILABLE", "GOVERNED_NOTE_OWNER_BUSY", "GOVERNED_NOTE_OWNERSHIP_UNCERTAIN", "PROJECT_BINDING_REQUIRED", "PROJECT_ID_MISMATCH", "VAULT_ID_MISMATCH", "STORE_ID_MISMATCH", "SESSION_NOT_FOUND", "SESSION_HANDLE_STALE", "SESSION_OWNERSHIP_MISMATCH", "SESSION_CAPABILITY_INVALID", "SESSION_CAPABILITY_KEY_UNAVAILABLE", "SESSION_CAPABILITY_EXPIRED", "IDEMPOTENCY_CONFLICT", "COMMAND_OUTCOME_UNKNOWN", "INTEGRITY_FAILURE", "SQLITE_BUSY", "MAINTENANCE_QUIESCING", "STORE_QUEUE_FULL", "WORKER_PROTOCOL_ERROR", "WORKER_CLOSED", "WORKER_UNAVAILABLE", "FRESH_START_INPUT_INVALID", "FRESH_START_IDENTITY_MISMATCH", "FRESH_START_RELEASE_MISMATCH", "FRESH_START_NOT_INITIALIZED", "FRESH_START_STORAGE_FAILURE", "FRESH_START_CONTEXT_REQUIRED", "FRESH_START_BUILD_MISMATCH", "FRESH_START_SCHEMA_MISMATCH", "FRESH_START_ADMISSION_STALE", "FRESH_START_ADMISSION_DENIED", "FRESH_START_CONTENT_UNVERIFIED", "FRESH_START_RECOVERY_REQUIRED"];
  assert.deepEqual(GOVERNED_NOTE_ERROR_CODES, expectedCodes);
  const idCodes = new Set(["COMMAND_OUTCOME_UNKNOWN", "GOVERNED_NOTE_OWNERSHIP_UNCERTAIN", "GOVERNED_NOTE_KEY_UNAVAILABLE"]);
  for (const code of GOVERNED_NOTE_ERROR_CODES) {
    const details = idCodes.has(code) ? ids : {}; const decoded = codec.decodeGovernedNoteErrorV1({ code, message: code, details }, ids);
    assert.equal(decoded.message, code); assert.deepEqual(decoded.details, details); assert.ok(Object.isFrozen(decoded.details));
    assert.throws(() => codec.decodeGovernedNoteErrorV1({ code, message: "unsafe", details }, ids), invalid);
    assert.throws(() => codec.decodeGovernedNoteErrorV1({ code, message: code, details: { ...details, extra: true } }, ids), invalid);
    if (idCodes.has(code)) for (const bad of [{}, { commandId: ids.commandId }, { ...ids, commandId: id(50) }]) assert.throws(() => codec.decodeGovernedNoteErrorV1({ code, message: code, details: bad }, ids), invalid);
    else assert.throws(() => codec.decodeGovernedNoteErrorV1({ code, message: code, details: ids }, ids), invalid);
  }
  for (const details of [{ ...ids, [Symbol("key")]: 1 }, Object.defineProperty({}, "commandId", { enumerable: true, get() { throw Error("getter"); } })]) assert.throws(() => codec.decodeGovernedNoteErrorV1({ code: "COMMAND_OUTCOME_UNKNOWN", message: "COMMAND_OUTCOME_UNKNOWN", details }, ids), invalid);
  assert.throws(() => codec.decodeGovernedNoteErrorV1({ code: "WORKER_TIMEOUT", message: "WORKER_TIMEOUT", details: {} }, ids), invalid);
  assert.throws(() => codec.decodeGovernedNoteErrorV1({ code: "COMMAND_OUTCOME_UNKNOWN", message: "COMMAND_OUTCOME_UNKNOWN", details: ids }, null), invalid);
  const detached = new GovernedNoteError("COMMAND_OUTCOME_UNKNOWN", ids); assert.notEqual(detached.details, ids); assert.deepEqual(detached.details, ids);
  const sanitized = new GovernedNoteError("provider-exception" as never, ids); assert.equal(sanitized.message, "GOVERNED_NOTE_UNAVAILABLE"); assert.deepEqual(sanitized.details, {});
  assert.equal(new GovernedNoteError("COMMAND_OUTCOME_UNKNOWN").code, "GOVERNED_NOTE_INPUT_INVALID");
});
test("stored and recovery results are exact owned JSON receipts with positive decimal positions", () => {
  assert.deepEqual(codec.decodeGovernedNoteStoredReceiptV1(receipt()), receipt());
  const stored = { eventIds: [id(8), id(9)], firstGlobalPosition: "1", lastGlobalPosition: "2", finalStreamVersion: "2", response: receipt() };
  assert.deepEqual(codec.decodeGovernedNoteStoredResultV1(stored), stored);
  const committed = { resultVersion: 1, operation: "recover-governed-note-result", outcome: "committed", receipt: { ...receipt(), replay: true } };
  assert.deepEqual(codec.decodeGovernedNoteRecoveryResultV1(committed), committed);
  const absent = { resultVersion: 1, operation: "recover-governed-note-result", outcome: "not-found", ...ids }; assert.deepEqual(codec.decodeGovernedNoteRecoveryResultV1(absent), absent);
  for (const patch of [{ replay: true }, { terminalPosition: "0" }, { terminalPosition: "9223372036854775808" }, { terminalPosition: "02" }, { sourceEventIds: [id(8)] }, { sourceEventIds: [id(8), id(9), id(10)] }, { status: "verified" }, { scope: { ...scope, sessionId: null } }]) assert.throws(() => codec.decodeGovernedNoteStoredReceiptV1({ ...receipt(), ...patch }), invalid);
  assert.equal(codec.decodeGovernedNoteStoredReceiptV1({ ...receipt(), terminalPosition: "9223372036854775807" }).terminalPosition, "9223372036854775807");
  for (const bytes of [16384, 16385]) {
    const base = receipt(); const overhead = Buffer.byteLength(canonicalJson(base)) + 11 + 16 + 7;
    const value = { ...base, extra: Array.from({ length: 8 }, (_, n) => "x".repeat(n === 7 ? bytes - overhead - 7 * 2048 : 2048)) };
    assert.equal(Buffer.byteLength(canonicalJson(value)), bytes); assert.throws(() => codec.decodeGovernedNoteStoredReceiptV1(value), bytes === 16384 ? invalid : limit);
  }
  assert.throws(() => codec.decodeGovernedNoteRecoveryResultV1({ ...committed, receipt: { ...receipt(), replay: false } }), invalid);
});
test("timing supported endpoints are values not elapsed waits", () => {
  const max = { ...timing, requestTimeoutMs: 2147483647, closeTimeoutMs: 2147483647, appendRetryDeadlineMs: 2147483647, recoveryProofLifetimeMs: 120000 };
  assert.equal(codec.validateGovernedNoteTimingV1(max).requestTimeoutMs, 2147483647); assert.equal(codec.validateGovernedNoteTimingV1(max).recoveryProofLifetimeMs, 120000);
  assert.ok(Object.isFrozen(codec.validateGovernedNoteTimingV1({ ...timing, requestTimeoutMs: 1, closeTimeoutMs: 1, appendRetryDeadlineMs: 1, recoveryProofLifetimeMs: 1 })));
});
test("invalid timing refuses before any allocation", () => {
  for (const key of ["requestTimeoutMs", "closeTimeoutMs", "recoveryProofLifetimeMs"]) for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER, ...(key === "recoveryProofLifetimeMs" ? [120001] : [])]) assert.throws(() => codec.validateGovernedNoteTimingV1({ ...timing, [key]: value }), { code: "GOVERNED_NOTE_CONFIG_INVALID" });
  for (const key of ["maxPending", "executorLeaseMs", "heartbeatIntervalMs", "appendRetryDeadlineMs", "sqliteBusyTimeoutMs"]) assert.throws(() => codec.validateGovernedNoteTimingV1({ ...timing, [key]: 1 }), { code: "GOVERNED_NOTE_CONFIG_INVALID" });
});
