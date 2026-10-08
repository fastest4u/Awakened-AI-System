import type * as C from "./contracts.js";
import { GOVERNED_NOTE_LIMITS as LIMITS } from "./contracts.js";
import { GOVERNED_NOTE_ERROR_CODES, GovernedNoteError, isRecoveryIdErrorCode, type GovernedNoteErrorCode, type GovernedNoteErrorV1 } from "./errors.js";
import { boundedRetainedJson, retainedDataEntries, retainedExactRecord, retainedStringMetrics, RetainedEvidenceError } from "../privacy/evidence-contracts.js";
import { parseCanonicalTimestamp, parseCanonicalUuid, parseUnsignedDecimal, type SessionId } from "../lifecycle/contracts/identifiers.js";
import type { BoundedOperationAuthorization, CapabilityProofV1, LifecycleAudience } from "../lifecycle/contracts/commands.js";
import type { JsonValue } from "../contracts/event.js";
import { isProjectionProjectStoreIdentity, isProjectionWorkspaceIdentity, type ProjectBinding } from "../projections/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeRetainedEvidenceAuthority, decodeEvidenceKeyRef } from "../privacy/retained-evidence-codec.js";
import { createHash } from "node:crypto";

export function decodeGovernedNoteCreatedPayloadV1(value: unknown): C.GovernedNoteCreatedPayloadV1 {
  const outer = record(snapshot(value, LIMITS.sourceEventBytes), ["formatVersion", "witness"]);
  if (outer.formatVersion !== 1) refuse();
  const r = record(outer.witness, ["witnessVersion", "commandType", "commandId", "idempotencyKey", "recordId", "recordKind", "confidence", "authority", "binding", "provenance", "policyId", "policyVersion", "originalCommitmentKeyRef", "originalInputCommitment", "summaryContentHash", "noteEventId", "sourceEventId", "recordedAt"]);
  if (r.witnessVersion !== 1 || r.commandType !== "create-governed-note") refuse();
  const a = retained(() => decodeRetainedEvidenceAuthority(r.authority));
  if ((a.capabilityKind !== "root-session-handle" && a.capabilityKind !== "child-session-handle") || a.authorizationSessionId !== a.targetSessionId || a.presentingActorRole !== a.targetActorRole || a.presentingClientInstanceId !== a.targetClientInstanceId) refuse();
  for (const g of [a.rootOwnerGeneration, a.authorizingOwnerGeneration, a.authorizingCapabilityGeneration, a.targetOwnerGeneration, a.targetCapabilityGeneration]) if (g !== null) decimal(g);
  const b = binding(r.binding);
  for (const k of ["projectId", "vaultId", "storeId", "workspaceId"] as const) if (b[k] !== a[k]) refuse();
  if (b.sessionId !== a.targetSessionId || !Array.isArray(r.provenance) || r.provenance.length < 1 || r.provenance.length > 64) refuse();
  let previous = "";
  const provenance = r.provenance.map(value => {
    const p = record(value, ["kind", "identity", "sourceEventId", "sourceEventPosition", "sourceEventHash", "sourceCommandId", "sourceIdempotencyKey"]);
    const kind = enumeration(p.kind, ["source-event", "retained-evidence"] as const), identity = uuid(p.identity), sourceEventId = uuid(p.sourceEventId), key = `${kind}/${identity}`;
    if (key <= previous || kind === "source-event" && identity !== sourceEventId) refuse(); previous = key;
    return Object.freeze({ kind, identity, sourceEventId, sourceEventPosition: decimal(p.sourceEventPosition), sourceEventHash: hash(p.sourceEventHash), sourceCommandId: uuid(p.sourceCommandId), sourceIdempotencyKey: uuid(p.sourceIdempotencyKey) });
  });
  const noteEventId = uuid(r.noteEventId), sourceEventId = uuid(r.sourceEventId), recordId = uuid(r.recordId);
  if (new Set([noteEventId, sourceEventId, recordId]).size !== 3) refuse();
  const witness: C.GovernedNoteWitnessV1 = Object.freeze({ witnessVersion: 1, commandType: "create-governed-note", commandId: uuid(r.commandId), idempotencyKey: uuid(r.idempotencyKey), recordId, recordKind: enumeration(r.recordKind, ["session-log", "insight", "mistake", "adr"] as const), confidence: enumeration(r.confidence, ["high", "medium", "low", "guess"] as const), authority: a as C.GovernedNoteAuthoritySnapshotV1, binding: b, provenance: Object.freeze(provenance), policyId: nonempty(r.policyId), policyVersion: nonempty(r.policyVersion), originalCommitmentKeyRef: retained(() => decodeEvidenceKeyRef(r.originalCommitmentKeyRef)), originalInputCommitment: hash(r.originalInputCommitment), summaryContentHash: hash(r.summaryContentHash), noteEventId, sourceEventId, recordedAt: timestamp(r.recordedAt) });
  return Object.freeze({ formatVersion: 1, witness });
}

/** Reserved markers are recognized before structural validation. Unrelated payloads stay opaque. */
export function isGovernedNoteSourcePayload(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const item = (value as { item?: unknown }).item;
  if (item === null || typeof item !== "object") return false;
  const i = item as { normalizedKey?: unknown; verificationMethod?: unknown };
  return i.verificationMethod === "governed-note-unverified-v1" || typeof i.normalizedKey === "string" && i.normalizedKey.startsWith("governed-note/");
}
export function decodeGovernedNoteSourcePayloadV1(value: unknown) {
  const r = record(snapshot(value, LIMITS.sourceEventBytes), ["sourceVersion", "binding", "item", "followUps", "artifacts", "entities", "aliases", "edges"]);
  if (r.sourceVersion !== 2) refuse();
  for (const key of ["followUps", "artifacts", "entities", "aliases", "edges"]) if (!Array.isArray(r[key]) || r[key].length !== 0) refuse();
  const i = record(r.item, ["itemId", "normalizedKey", "status", "confidence", "verificationMethod", "validFrom", "validTo", "summary", "contentHash", "conflictGroupId", "supersedingItemId", "anchor"]);
  const itemId = uuid(i.itemId), text = summary(i.summary), contentHash = hash(i.contentHash);
  if (text !== text.normalize("NFC").trim() || i.status !== "candidate" || i.verificationMethod !== "governed-note-unverified-v1" || i.validTo !== null || i.conflictGroupId !== null || i.supersedingItemId !== null || i.anchor !== null || !["session-log", "insight", "mistake", "adr"].some(kind => i.normalizedKey === `governed-note/${kind}/${itemId}`) || contentHash !== createHash("sha256").update("project-memory/governed-note-summary/v1\n").update(canonicalJson(text)).digest("hex")) refuse();
  return Object.freeze({ sourceVersion: 2 as const, binding: binding(r.binding), item: Object.freeze({ itemId, normalizedKey: string(i.normalizedKey), status: "candidate" as const, confidence: enumeration(i.confidence, ["high", "medium", "low", "guess"] as const), verificationMethod: "governed-note-unverified-v1", validFrom: timestamp(i.validFrom), validTo: null, summary: text, contentHash, conflictGroupId: null, supersedingItemId: null, anchor: null }), followUps: Object.freeze([]), artifacts: Object.freeze([]), entities: Object.freeze([]), aliases: Object.freeze([]), edges: Object.freeze([]) });
}

function refuse(code: GovernedNoteErrorCode = "GOVERNED_NOTE_INPUT_INVALID"): never { throw new GovernedNoteError(code); }
/** Retained helper errors never expose their text or partial recovery details. */
function retained<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { return refuse(error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED" ? "GOVERNED_NOTE_LIMIT_EXCEEDED" : "GOVERNED_NOTE_INPUT_INVALID"); }
}
function limit(actual: number, maximum: number): void { if (actual > maximum) refuse("GOVERNED_NOTE_LIMIT_EXCEEDED"); }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> { return retained(() => retainedExactRecord(value, fields)); }
function string(value: unknown, maximum: number = LIMITS.scalarBytes): string { retained(() => retainedStringMetrics(value, maximum)); return value as string; }
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || value[14] !== "4") refuse();
  return canonicalUuid(value);
}
/** Existing branch/session identities preserve the lifecycle UUID version domain. */
function canonicalUuid(value: unknown): string {
  try { return parseCanonicalUuid(value, "governed-note"); } catch { return refuse(); }
}
function sessionId(value: unknown): SessionId { return canonicalUuid(value) as SessionId; }
function projectStoreIdentity(value: unknown): string { if (!isProjectionProjectStoreIdentity(value)) refuse(); return value; }
function workspaceIdentity(value: unknown): string { if (!isProjectionWorkspaceIdentity(value)) refuse(); return value; }
function decimal(value: unknown): string {
  try { const parsed = parseUnsignedDecimal(value, "governed-note"); if (parsed < 1n || parsed > 9223372036854775807n) refuse(); return value as string; } catch { return refuse(); }
}
function timestamp(value: unknown): string { try { return parseCanonicalTimestamp(value, "governed-note"); } catch { return refuse(); } }
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== "string" || !choices.includes(value as T)) refuse(); return value as T; }
function nonempty(value: unknown, maximum: number = LIMITS.scalarBytes): string { const text = string(value, maximum); if (text.length === 0) refuse(); return text; }
function hash(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) refuse(); return value; }
function format(r: Record<string, unknown>, key: string, operation: string): void {
  if (!Number.isSafeInteger(r[key]) || Number(r[key]) < 1 || typeof r.operation !== "string" || r.operation.length === 0) refuse();
  if (r[key] !== 1 || r.operation !== operation) refuse("GOVERNED_NOTE_FORMAT_UNSUPPORTED");
}

/** Bound hostile structure before copying; each semantic component owns its budget. */
function snapshot(value: unknown, maximumBytes: number): JsonValue {
  let containers = 0; const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) refuse(); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item !== "object" || ancestors.has(item)) refuse();
    limit(depth, LIMITS.depth); limit(++containers, LIMITS.containers);
    const entries = retained(() => retainedDataEntries(item, Array.isArray(item) ? LIMITS.arrayElements : LIMITS.fields));
    ancestors.add(item);
    for (const [key, child] of entries) { string(key); visit(child, depth + 1); }
    ancestors.delete(item);
  };
  // Match the existing private protocol decoder's root-depth-zero convention.
  visit(value, 0);
  return retained(() => boundedRetainedJson(value, maximumBytes)).snapshot;
}
function summary(value: unknown): string {
  const raw = string(value, LIMITS.summaryBytes); const normalized = raw.normalize("NFC").trim();
  string(normalized, LIMITS.summaryBytes); if (normalized.length === 0) refuse(); return raw;
}
function selectors(value: unknown): C.GovernedNoteCommandV1["provenance"] {
  if (!Array.isArray(value)) refuse();
  const entries = retained(() => retainedDataEntries(value, LIMITS.provenance)); if (entries.length === 0) refuse();
  const seen = new Set<string>();
  const items = entries.map(([, item]) => {
    const r = record(item, ["kind", "identity"]); const kind = enumeration(r.kind, ["source-event", "retained-evidence"] as const); const identity = uuid(r.identity);
    const key = `${kind}/${identity}`; if (seen.has(key)) refuse(); seen.add(key); return Object.freeze({ kind, identity });
  });
  items.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
  return Object.freeze(items);
}
export function decodeGovernedNoteCommandV1(value: unknown): C.GovernedNoteCommandV1 {
  const r = record(snapshot(value, LIMITS.inputBytes), ["version", "operation", "commandId", "idempotencyKey", "recordKind", "summary", "confidence", "provenance"]);
  const decoded = Object.freeze({ version: 1 as const, operation: "create-governed-note" as const, commandId: uuid(r.commandId), idempotencyKey: uuid(r.idempotencyKey), recordKind: enumeration(r.recordKind, ["session-log", "insight", "mistake", "adr"] as const), summary: summary(r.summary), confidence: enumeration(r.confidence, ["high", "medium", "low", "guess"] as const), provenance: selectors(r.provenance) });
  format(r, "version", decoded.operation); return decoded;
}
export function decodeGovernedNoteRecoveryV1(value: unknown): C.GovernedNoteRecoveryV1 {
  const r = record(snapshot(value, LIMITS.inputBytes), ["version", "operation", "operationId", "requestId", "commandId", "idempotencyKey", "expiresAt"]);
  const decoded = Object.freeze({ version: 1 as const, operation: "recover-governed-note-result" as const, operationId: uuid(r.operationId), requestId: uuid(r.requestId), commandId: uuid(r.commandId), idempotencyKey: uuid(r.idempotencyKey), expiresAt: timestamp(r.expiresAt) });
  format(r, "version", decoded.operation); return decoded;
}
function proof(value: unknown, target: CapabilityProofV1["target"]): CapabilityProofV1 {
  const r = record(value, ["proofVersion", "target", "proofNonce", "proofFingerprint"]);
  if (r.proofVersion !== 1 || r.target !== target) refuse();
  return Object.freeze({ proofVersion: 1, target, proofNonce: uuid(r.proofNonce), proofFingerprint: hash(r.proofFingerprint) });
}
function createAuthorization(value: unknown): C.GovernedNoteProtectedAuthorizationV1 {
  const r = record(snapshot(value, LIMITS.authorizationBytes), ["kind", "authoritySessionId", "targetSessionId", "proof", "approval", "childBindingGrant"]);
  const authoritySessionId = sessionId(r.authoritySessionId); const targetSessionId = sessionId(r.targetSessionId);
  if (r.kind !== "protected" || authoritySessionId !== targetSessionId || r.approval !== null || r.childBindingGrant !== null) refuse();
  return Object.freeze({ kind: "protected", authoritySessionId, targetSessionId, proof: proof(r.proof, "semantic-command"), approval: null, childBindingGrant: null });
}
function recoveryAuthorization(value: unknown): BoundedOperationAuthorization {
  const r = record(snapshot(value, LIMITS.authorizationBytes), ["kind", "authoritySessionId", "targetSessionId", "proof", "audience"]);
  const authoritySessionId = sessionId(r.authoritySessionId); const targetSessionId = sessionId(r.targetSessionId);
  if (r.kind !== "bounded-operation" || authoritySessionId !== targetSessionId) refuse();
  const a = record(r.audience, ["presentingActorRole", "presentingClientInstanceId", "targetActorRole", "targetClientInstanceId"]);
  const actor = (value: unknown) => enumeration(value, ["primary", "maintenance", "untrusted"] as const);
  const principal = (value: unknown): string => { const metrics = retained(() => retainedStringMetrics(value, 1024)); if (metrics.scalars === 0 || metrics.scalars > 256) refuse(); return value as string; };
  const audience: LifecycleAudience = Object.freeze({ presentingActorRole: actor(a.presentingActorRole), presentingClientInstanceId: principal(a.presentingClientInstanceId), targetActorRole: actor(a.targetActorRole), targetClientInstanceId: principal(a.targetClientInstanceId) });
  return Object.freeze({ kind: "bounded-operation", authoritySessionId, targetSessionId, proof: proof(r.proof, "bounded-operation"), audience });
}
/** Transport text has a 4 MiB packing budget, not the semantic scalar ceiling. */
function wire(value: unknown, key: "command" | "request"): Record<string, unknown> {
  const r = record(value, [key, "authorization"]);
  string(r[key], LIMITS.transportBytes);
  // Validate semantic authorization before the physical wrapper copies it.
  const authorization = snapshot(r.authorization, LIMITS.authorizationBytes);
  return record(retained(() => boundedRetainedJson({ [key]: r[key], authorization }, LIMITS.transportBytes)).snapshot, [key, "authorization"]);
}
function parseCanonical<T>(value: unknown, decode: (value: unknown) => T): T {
  string(value, LIMITS.transportBytes); let parsed: unknown;
  try { parsed = JSON.parse(value as string); } catch { return refuse(); }
  const decoded = decode(parsed); if (canonicalJson(decoded) !== value) refuse(); return decoded;
}
export function encodePreparedGovernedNoteCreateV1(input: C.PreparedGovernedNoteCreateV1): C.PreparedGovernedNoteCreateWireV1 {
  const r = record(input, ["command", "authorization"]); const command = decodeGovernedNoteCommandV1(r.command); const authorization = createAuthorization(r.authorization);
  const encoded = Object.freeze({ command: canonicalJson(command), authorization }); wire(encoded, "command"); return encoded;
}
export function decodePreparedGovernedNoteCreateV1(value: unknown): C.PreparedGovernedNoteCreateV1 {
  const r = wire(value, "command"); return Object.freeze({ command: parseCanonical(r.command, decodeGovernedNoteCommandV1), authorization: createAuthorization(r.authorization) });
}
export function encodePreparedGovernedNoteRecoveryV1(input: C.PreparedGovernedNoteRecoveryV1): C.PreparedGovernedNoteRecoveryWireV1 {
  const r = record(input, ["request", "authorization"]); const request = decodeGovernedNoteRecoveryV1(r.request); const authorization = recoveryAuthorization(r.authorization);
  const encoded = Object.freeze({ request: canonicalJson(request), authorization }); wire(encoded, "request"); return encoded;
}
export function decodePreparedGovernedNoteRecoveryV1(value: unknown): C.PreparedGovernedNoteRecoveryV1 {
  const r = wire(value, "request"); return Object.freeze({ request: parseCanonical(r.request, decodeGovernedNoteRecoveryV1), authorization: recoveryAuthorization(r.authorization) });
}
export function decodeGovernedNoteErrorV1(value: unknown, ids: C.GovernedNoteRecoveryIdsV1 | null): GovernedNoteErrorV1 {
  const r = record(snapshot(value, LIMITS.resultBytes), ["code", "message", "details"]);
  if (typeof r.code !== "string" || !(GOVERNED_NOTE_ERROR_CODES as readonly string[]).includes(r.code) || r.message !== r.code) refuse();
  const code = r.code as GovernedNoteErrorCode;
  if (isRecoveryIdErrorCode(code)) {
    const d = record(r.details, ["commandId", "idempotencyKey"]); const original = record(ids, ["commandId", "idempotencyKey"]);
    const commandId = uuid(d.commandId), idempotencyKey = uuid(d.idempotencyKey);
    if (commandId !== uuid(original.commandId) || idempotencyKey !== uuid(original.idempotencyKey)) refuse();
    return Object.freeze({ code, message: code, details: Object.freeze({ commandId, idempotencyKey }) });
  }
  record(r.details, []); return Object.freeze({ code, message: code, details: Object.freeze({}) });
}
function binding(value: unknown): C.GovernedNoteStoredReceiptV1["scope"] {
  const r = record(value, ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"]);
  const result: C.GovernedNoteStoredReceiptV1["scope"] = {
    projectId: projectStoreIdentity(r.projectId) as ProjectBinding["projectId"],
    vaultId: projectStoreIdentity(r.vaultId) as ProjectBinding["vaultId"],
    storeId: projectStoreIdentity(r.storeId) as ProjectBinding["storeId"],
    workspaceId: workspaceIdentity(r.workspaceId) as ProjectBinding["workspaceId"],
    branchScopeId: r.branchScopeId === null ? null : canonicalUuid(r.branchScopeId) as ProjectBinding["branchScopeId"],
    branchRef: r.branchRef === null ? null : nonempty(r.branchRef, 1024), sessionId: sessionId(r.sessionId),
  };
  return Object.freeze(result);
}
const RECEIPT_FIELDS = ["resultVersion", "operation", "commandId", "idempotencyKey", "recordId", "recordKind", "status", "verificationStatus", "scope", "sourceEventIds", "terminalPosition"];
function pair(value: unknown): [string, string] {
  if (!Array.isArray(value)) refuse(); const entries = retained(() => retainedDataEntries(value, LIMITS.arrayElements)); if (entries.length !== 2) refuse();
  const first = uuid(entries[0]![1]), second = uuid(entries[1]![1]); if (first === second) refuse(); return Object.freeze([first, second]) as [string, string];
}
function receipt(value: unknown, withReplay: boolean): C.GovernedNoteStoredReceiptV1 | C.GovernedNoteReceiptV1 {
  const r = record(value, withReplay ? [...RECEIPT_FIELDS, "replay"] : RECEIPT_FIELDS);
  if (r.status !== "candidate" || r.verificationStatus !== "unverified" || (withReplay && r.replay !== true)) refuse();
  const decoded = { resultVersion: 1 as const, operation: "create-governed-note" as const, commandId: uuid(r.commandId), idempotencyKey: uuid(r.idempotencyKey), recordId: uuid(r.recordId), recordKind: enumeration(r.recordKind, ["session-log", "insight", "mistake", "adr"] as const), status: "candidate" as const, verificationStatus: "unverified" as const, scope: binding(r.scope), sourceEventIds: pair(r.sourceEventIds), terminalPosition: decimal(r.terminalPosition) };
  format(r, "resultVersion", decoded.operation); return Object.freeze(withReplay ? { ...decoded, replay: true } : decoded);
}
export function decodeGovernedNoteStoredReceiptV1(value: unknown): C.GovernedNoteStoredReceiptV1 { return receipt(snapshot(value, LIMITS.resultBytes), false); }
export function decodeGovernedNoteStoredResultV1(value: unknown): C.GovernedNoteStoredResultV1 {
  const r = record(snapshot(value, LIMITS.resultBytes), ["eventIds", "firstGlobalPosition", "lastGlobalPosition", "finalStreamVersion", "response"]);
  return Object.freeze({ eventIds: pair(r.eventIds), firstGlobalPosition: decimal(r.firstGlobalPosition), lastGlobalPosition: decimal(r.lastGlobalPosition), finalStreamVersion: decimal(r.finalStreamVersion), response: receipt(r.response, false) });
}
export function decodeGovernedNoteRecoveryResultV1(value: unknown): C.GovernedNoteRecoveryResultV1 {
  const owned = snapshot(value, LIMITS.resultBytes); const head = retained(() => retainedDataEntries(owned, LIMITS.fields)); const outcome = head.find(([key]) => key === "outcome")?.[1];
  if (outcome !== "committed" && outcome !== "not-found") refuse();
  const r = record(owned, outcome === "committed" ? ["resultVersion", "operation", "outcome", "receipt"] : ["resultVersion", "operation", "outcome", "commandId", "idempotencyKey"]);
  format(r, "resultVersion", "recover-governed-note-result");
  return outcome === "committed" ? Object.freeze({ resultVersion: 1, operation: "recover-governed-note-result", outcome, receipt: receipt(r.receipt, true) as C.GovernedNoteReceiptV1 }) : Object.freeze({ resultVersion: 1, operation: "recover-governed-note-result", outcome, commandId: uuid(r.commandId), idempotencyKey: uuid(r.idempotencyKey) });
}
export function validateGovernedNoteTimingV1(value: unknown): C.TrustedGovernedNoteTimingV1 {
  try {
    const r = record(value, ["requestTimeoutMs", "closeTimeoutMs", "recoveryProofLifetimeMs", "maxPending", "executorLeaseMs", "heartbeatIntervalMs", "appendRetryDeadlineMs", "sqliteBusyTimeoutMs"]);
    for (const key of ["requestTimeoutMs", "closeTimeoutMs", "recoveryProofLifetimeMs"]) if (!Number.isSafeInteger(r[key]) || Number(r[key]) < 1 || Number(r[key]) > (key === "recoveryProofLifetimeMs" ? 120000 : 2147483647)) refuse();
    if (r.maxPending !== 128 || r.executorLeaseMs !== 15000 || r.heartbeatIntervalMs !== 5000 || r.sqliteBusyTimeoutMs !== 5000 || r.appendRetryDeadlineMs !== r.requestTimeoutMs) refuse();
    return Object.freeze({ requestTimeoutMs: r.requestTimeoutMs as number, closeTimeoutMs: r.closeTimeoutMs as number, recoveryProofLifetimeMs: r.recoveryProofLifetimeMs as number, maxPending: 128, executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: r.requestTimeoutMs as number, sqliteBusyTimeoutMs: 5000 });
  } catch { return refuse("GOVERNED_NOTE_CONFIG_INVALID"); }
}
