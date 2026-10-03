import type { StoredEvent } from "../contracts/event.js";
import type { EvidenceItemBindingV1, EvidenceItemMetadataV1, EncryptedEvidenceItemV1, EvidenceFrameMetadataV1 } from "./evidence-envelope.js";
import type { EvidenceKeyRefV1, WrappedEvidenceKeyV1 } from "./evidence-key-provider.js";
import type { RetainedEvidenceAuthoritySnapshotV1, RetainedEvidenceIntentWitnessV1 } from "./retained-evidence-intent.js";
import { assertRetainedByteLimit, boundedRetainedJson, decodeRetainEvidenceBatch, decodeRetainedEvidenceReceipt, retainedDataEntries, retainedExactRecord, retainedStringMetrics, RETAINED_EVIDENCE_LIMITS, RetainedEvidenceError, type RetainedEvidenceReceiptV1 } from "./evidence-contracts.js";
import { parseCanonicalTimestamp, parseCanonicalUuid, parseUnsignedDecimal } from "../lifecycle/contracts/identifiers.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { JsonValue } from "../contracts/event.js";
import type { RedactionSpanV1 } from "./redaction.js";
import { types } from "node:util";
export const RETAINED_EVIDENCE_BUNDLE_BYTES = 2_097_152;
export type EvidenceBatchRetainedPayloadV1 = { readonly formatVersion: 1; readonly witness: RetainedEvidenceIntentWitnessV1; readonly items: EvidenceItemMetadataV1[] };
const FORMAT = "RETAINED_EVIDENCE_FORMAT_UNSUPPORTED";
function closed(): never { throw new RetainedEvidenceError(FORMAT); }
function integrity(): never { throw new RetainedEvidenceError("INTEGRITY_FAILURE"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> { return retainedExactRecord(value, keys, FORMAT); }
function list(value: unknown, maximum: number): unknown[] { const entries = retainedDataEntries(value, maximum, FORMAT); if (!Array.isArray(value)) closed(); return entries.map(([, item]) => item); }
export function retainedIdentifier(value: unknown): string {
  const metrics = retainedStringMetrics(value, 512, FORMAT); if (metrics.scalars === 0 || metrics.scalars > 128) closed(); return value as string;
}
function hash(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) closed(); return value; }
/** Existing trusted scope identity permits canonical lowercase UUID versions 1-5. */
function scopeUuid(value: unknown): string { try { return parseCanonicalUuid(value, "retained-scope"); } catch { return closed(); } }
function uuid(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) closed(); return value; }
function decimal(value: unknown, positive = false): string { try { const n = parseUnsignedDecimal(value, "retained"); if (positive && n === 0n) closed(); return value as string; } catch { return closed(); } }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function nullableGeneration(value: unknown): string | null { return value === null ? null : decimal(value, true); }
function actor(value: unknown): "primary" | "maintenance" | "untrusted" { if (value !== "primary" && value !== "maintenance" && value !== "untrusted") closed(); return value; }
function media(value: unknown): "text/plain; charset=utf-8" | "application/json" { if (value !== "text/plain; charset=utf-8" && value !== "application/json") closed(); return value; }
/** Decode bounded canonical base64url only, checking length before allocation. */
function encoded(value: unknown, bytes?: number): string {
  if (typeof value !== "string" || value.length === 0) closed();
  assertRetainedByteLimit(value.length, RETAINED_EVIDENCE_BUNDLE_BYTES);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) closed();
  if (bytes !== undefined && value.length !== Math.ceil(bytes * 8 / 6)) closed();
  const decoded = Buffer.from(value, "base64url");
  if ((bytes !== undefined && decoded.length !== bytes) || decoded.toString("base64url") !== value) closed();
  return value;
}
export function decodeEvidenceKeyRef(value: unknown): EvidenceKeyRefV1 {
  const r = record(value, ["keyId", "version"]); return Object.freeze({ keyId: retainedIdentifier(r.keyId), version: decimal(r.version, true) });
}
export function decodeWrappedEvidenceKey(value: unknown): WrappedEvidenceKeyV1 {
  const r = record(value, ["formatVersion", "keyRef", "algorithm", "nonce", "ciphertext", "tag"]);
  if (r.formatVersion !== 1 || r.algorithm !== "AES-256-GCM") closed();
  return Object.freeze({ formatVersion: 1, keyRef: decodeEvidenceKeyRef(r.keyRef), algorithm: "AES-256-GCM", nonce: encoded(r.nonce, 12), ciphertext: encoded(r.ciphertext, 32), tag: encoded(r.tag, 16) });
}
export function decodeEvidenceItemBinding(value: unknown): EvidenceItemBindingV1 {
  const r = record(value, ["formatVersion", "projectId", "vaultId", "storeId", "evidenceId", "eventId", "targetSessionId", "conversationId", "frameId", "mediaType", "policyId", "policyVersion"]);
  if (r.formatVersion !== 1) closed();
  return Object.freeze({ formatVersion: 1, projectId: scopeUuid(r.projectId), vaultId: scopeUuid(r.vaultId), storeId: scopeUuid(r.storeId), evidenceId: uuid(r.evidenceId), eventId: uuid(r.eventId), targetSessionId: uuid(r.targetSessionId), conversationId: uuid(r.conversationId), frameId: uuid(r.frameId), mediaType: media(r.mediaType), policyId: retainedIdentifier(r.policyId), policyVersion: retainedIdentifier(r.policyVersion) });
}
const FRAME_FIELDS = ["frameId", "ordinal", "role", "category", "occurredAt", "mediaType", "previousFrameId", "toolCorrelationId", "artifactHashes"];
function validateFrameSequence(frames: readonly EvidenceFrameMetadataV1[]): void {
  // Reuse accepted role/tool/order contracts with harmless bounded content only.
  let input;
  try { input = decodeRetainEvidenceBatch({ version: 1, commandType: "retain-evidence-batch", commandId: "00000000-0000-4000-8000-000000000001", idempotencyKey: "00000000-0000-4000-8000-000000000002", targetSessionId: "00000000-0000-4000-8000-000000000003", conversationId: "00000000-0000-4000-8000-000000000004", frames: frames.map(f => ({ ...f, content: f.mediaType === "application/json" ? null : "" })) }); }
  catch { closed(); }
  finally { input?.canonicalOriginalBytes.fill(0); }
}
export function decodeEvidenceFrameMetadata(value: unknown): EvidenceFrameMetadataV1 {
  const r = record(value, FRAME_FIELDS); const artifactHashes = list(r.artifactHashes, RETAINED_EVIDENCE_LIMITS.hashes).map(hash);
  if (new Set(artifactHashes).size !== artifactHashes.length) closed();
  if (r.role !== "user" && r.role !== "assistant" && r.role !== "tool") closed();
  if (!["user-message", "assistant-message", "tool-input", "tool-output", "child-report", "artifact-reference", "retrieval-feedback", "user-correction"].includes(r.category as string)) closed();
  try { parseCanonicalTimestamp(r.occurredAt, "retained"); } catch { closed(); }
  const frame: EvidenceFrameMetadataV1 = Object.freeze({ frameId: uuid(r.frameId), ordinal: decimal(r.ordinal), role: r.role, category: r.category as EvidenceFrameMetadataV1["category"], occurredAt: r.occurredAt as string, mediaType: media(r.mediaType), previousFrameId: nullableUuid(r.previousFrameId), toolCorrelationId: nullableUuid(r.toolCorrelationId), artifactHashes: Object.freeze(artifactHashes) as string[] });
  validateFrameSequence([frame]); return frame;
}
const AUTHORITY_FIELDS = ["projectId", "vaultId", "storeId", "workspaceId", "clientNamespace", "presentingActorRole", "presentingClientInstanceId", "targetActorRole", "targetClientInstanceId", "authorizationSessionId", "targetSessionId", "parentSessionId", "rootSessionId", "rootOwnerGeneration", "authorizingOwnerGeneration", "authorizingCapabilityGeneration", "targetOwnerGeneration", "targetCapabilityGeneration", "capabilityKind"];
function rootAuthorityMetadata(r: Record<string, unknown>): Pick<RetainedEvidenceAuthoritySnapshotV1, "rootSessionId" | "rootOwnerGeneration"> { return { rootSessionId: uuid(r.rootSessionId), rootOwnerGeneration: decimal(r.rootOwnerGeneration, true) }; }
function principalId(value: unknown): string {
  const metrics = retainedStringMetrics(value, 1_024, FORMAT); if (metrics.scalars === 0 || metrics.scalars > 256) closed(); return value as string;
}
export function decodeRetainedEvidenceAuthority(value: unknown): RetainedEvidenceAuthoritySnapshotV1 {
  const r = record(value, AUTHORITY_FIELDS);
  if (!["root-session-handle", "root-resume-token", "child-session-handle"].includes(r.capabilityKind as string)) closed();
  const snapshot: RetainedEvidenceAuthoritySnapshotV1 = Object.freeze({ ...rootAuthorityMetadata(r), projectId: scopeUuid(r.projectId), vaultId: scopeUuid(r.vaultId), storeId: scopeUuid(r.storeId), workspaceId: hash(r.workspaceId), clientNamespace: principalId(r.clientNamespace), presentingActorRole: actor(r.presentingActorRole), presentingClientInstanceId: principalId(r.presentingClientInstanceId), targetActorRole: actor(r.targetActorRole), targetClientInstanceId: principalId(r.targetClientInstanceId), authorizationSessionId: uuid(r.authorizationSessionId), targetSessionId: uuid(r.targetSessionId), parentSessionId: nullableUuid(r.parentSessionId), authorizingOwnerGeneration: nullableGeneration(r.authorizingOwnerGeneration), authorizingCapabilityGeneration: nullableGeneration(r.authorizingCapabilityGeneration), targetOwnerGeneration: nullableGeneration(r.targetOwnerGeneration), targetCapabilityGeneration: nullableGeneration(r.targetCapabilityGeneration), capabilityKind: r.capabilityKind as RetainedEvidenceAuthoritySnapshotV1["capabilityKind"] });
  // Root ownership and child direct-access fences are distinct nullable columns.
  if (snapshot.authorizingOwnerGeneration === null ? snapshot.authorizingCapabilityGeneration === null : snapshot.authorizingCapabilityGeneration !== null) closed();
  if (snapshot.parentSessionId === null ? snapshot.targetOwnerGeneration === null || snapshot.targetCapabilityGeneration !== null : snapshot.targetOwnerGeneration !== null) closed();
  if (snapshot.capabilityKind === "child-session-handle" ? snapshot.authorizingOwnerGeneration !== null : snapshot.authorizingOwnerGeneration === null) closed();
  if (snapshot.authorizationSessionId === snapshot.targetSessionId && (snapshot.authorizingOwnerGeneration !== snapshot.targetOwnerGeneration || snapshot.authorizingCapabilityGeneration !== snapshot.targetCapabilityGeneration)) closed();
  if (snapshot.parentSessionId === null ? snapshot.rootSessionId !== snapshot.targetSessionId || snapshot.rootOwnerGeneration !== snapshot.targetOwnerGeneration || snapshot.authorizationSessionId !== snapshot.targetSessionId : snapshot.rootSessionId !== snapshot.parentSessionId || snapshot.rootSessionId === snapshot.targetSessionId) closed();
  if (snapshot.authorizingOwnerGeneration !== null && (snapshot.authorizationSessionId !== snapshot.rootSessionId || snapshot.authorizingOwnerGeneration !== snapshot.rootOwnerGeneration)) closed();
  if (snapshot.authorizingOwnerGeneration === null && snapshot.authorizationSessionId !== snapshot.targetSessionId) closed();
  return snapshot;
}
export function decodeRetainedEvidenceIntentWitness(value: unknown): RetainedEvidenceIntentWitnessV1 {
  const r = record(value, ["witnessVersion", "commandType", "authority", "commandId", "idempotencyKey", "targetSessionId", "conversationId", "frames", "policyId", "policyVersion", "originalCommitmentKeyRef", "fingerprintKeyRef", "originalInputCommitment"]);
  if (r.witnessVersion !== 1 || r.commandType !== "retain-evidence-batch") closed();
  const authority = decodeRetainedEvidenceAuthority(r.authority); const frames = list(r.frames, 64).map(decodeEvidenceFrameMetadata); validateFrameSequence(frames);
  const targetSessionId = uuid(r.targetSessionId); if (authority.targetSessionId !== targetSessionId) closed();
  const witness: RetainedEvidenceIntentWitnessV1 = { witnessVersion: 1, commandType: "retain-evidence-batch", authority, commandId: uuid(r.commandId), idempotencyKey: uuid(r.idempotencyKey), targetSessionId, conversationId: uuid(r.conversationId), frames, policyId: retainedIdentifier(r.policyId), policyVersion: retainedIdentifier(r.policyVersion), originalCommitmentKeyRef: decodeEvidenceKeyRef(r.originalCommitmentKeyRef), fingerprintKeyRef: decodeEvidenceKeyRef(r.fingerprintKeyRef), originalInputCommitment: hash(r.originalInputCommitment) };
  return boundedRetainedJson(witness, RETAINED_EVIDENCE_LIMITS.batchBytes).snapshot as RetainedEvidenceIntentWitnessV1;
}
const ITEM_METADATA_FIELDS = ["binding", "frame", "wrapKeyRef", "fingerprintKeyRef", "ciphertextHash", "wrappedKeyHash", "keyedFingerprint"];
function itemMetadata(r: Record<string, unknown>): EvidenceItemMetadataV1 {
  const binding = decodeEvidenceItemBinding(r.binding); const frame = decodeEvidenceFrameMetadata(r.frame);
  if (binding.frameId !== frame.frameId || binding.mediaType !== frame.mediaType) closed();
  return Object.freeze({ binding, frame, wrapKeyRef: decodeEvidenceKeyRef(r.wrapKeyRef), fingerprintKeyRef: decodeEvidenceKeyRef(r.fingerprintKeyRef), ciphertextHash: hash(r.ciphertextHash), wrappedKeyHash: hash(r.wrappedKeyHash), keyedFingerprint: hash(r.keyedFingerprint) });
}
export function decodeEncryptedEvidenceItem(value: unknown): EncryptedEvidenceItemV1 {
  const r = record(value, [...ITEM_METADATA_FIELDS, "formatVersion", "algorithm", "nonce", "tag", "ciphertext", "wrappedKey"]);
  if (r.formatVersion !== 1 || r.algorithm !== "AES-256-GCM") closed();
  const metadata = itemMetadata(r); const wrappedKey = decodeWrappedEvidenceKey(r.wrappedKey);
  if (canonicalJson(metadata.wrapKeyRef) !== canonicalJson(wrappedKey.keyRef)) closed();
  const item: EncryptedEvidenceItemV1 = Object.freeze({ ...metadata, formatVersion: 1, algorithm: "AES-256-GCM", nonce: encoded(r.nonce, 12), tag: encoded(r.tag, 16), ciphertext: encoded(r.ciphertext), wrappedKey });
  boundedRetainedJson(item, RETAINED_EVIDENCE_BUNDLE_BYTES); return item;
}
export function decodeEvidenceBatchRetainedPayload(value: unknown): EvidenceBatchRetainedPayloadV1 {
  const r = record(value, ["formatVersion", "witness", "items"]); if (r.formatVersion !== 1) closed();
  const witness = decodeRetainedEvidenceIntentWitness(r.witness); const items = list(r.items, 64).map(item => itemMetadata(record(item, ITEM_METADATA_FIELDS)));
  if (items.length !== witness.frames.length) closed();
  const evidenceIds = new Set<string>(); const eventId = items[0]?.binding.eventId;
  for (let n = 0; n < items.length; n++) {
    const item = items[n]!; const b = item.binding;
    if (evidenceIds.has(b.evidenceId)) closed(); evidenceIds.add(b.evidenceId);
    if (b.projectId !== witness.authority.projectId || b.vaultId !== witness.authority.vaultId || b.storeId !== witness.authority.storeId || b.targetSessionId !== witness.targetSessionId || b.conversationId !== witness.conversationId || b.eventId !== eventId || b.policyId !== witness.policyId || b.policyVersion !== witness.policyVersion || canonicalJson(item.frame) !== canonicalJson(witness.frames[n]) || canonicalJson(item.fingerprintKeyRef) !== canonicalJson(witness.fingerprintKeyRef)) closed();
  }
  return boundedRetainedJson({ formatVersion: 1, witness, items }, RETAINED_EVIDENCE_BUNDLE_BYTES).snapshot as EvidenceBatchRetainedPayloadV1;
}
export function assertRetainedStoredEvent(event: StoredEvent): EvidenceBatchRetainedPayloadV1 | null {
  try {
    if (event.eventType !== "EvidenceBatchRetained") {
      if (list(event.evidenceRefs, 0).length !== 0 || list(event.evidenceDigests, 0).length !== 0) integrity();
      return null;
    }
    if (event.eventSchemaVersion !== 1 || event.commandEventIndex !== 0 || event.visibilityScope !== "session") integrity();
    // Existing authenticated readers preserve canonical bytes and may discard the redundant cache.
    // Inspect only its plain-container shape; never enumerate it or invoke nested accessors.
    if (typeof event.payload !== "object" || event.payload === null || types.isProxy(event.payload) || Array.isArray(event.payload)) integrity();
    const prototype: unknown = Object.getPrototypeOf(event.payload);
    if (prototype !== Object.prototype && prototype !== null) integrity();
    retainedStringMetrics(event.payloadJson, RETAINED_EVIDENCE_BUNDLE_BYTES, "INTEGRITY_FAILURE");
    const parsed: unknown = JSON.parse(event.payloadJson);
    const payload = decodeEvidenceBatchRetainedPayload(parsed); const w = payload.witness; const a = w.authority;
    const refs = list(event.evidenceRefs, RETAINED_EVIDENCE_LIMITS.frames).map(uuid);
    const digests = list(event.evidenceDigests, RETAINED_EVIDENCE_LIMITS.frames).map(value => {
      const pair = record(value, ["ciphertextHash", "keyedFingerprint"]);
      return { ciphertextHash: hash(pair.ciphertextHash), keyedFingerprint: hash(pair.keyedFingerprint) };
    });
    if (refs.length !== payload.items.length || digests.length !== payload.items.length) integrity();
    for (let index = 0; index < payload.items.length; index++) {
      const item = payload.items[index]!; const digest = digests[index]!;
      if (refs[index] !== item.binding.evidenceId || digest.ciphertextHash !== item.ciphertextHash || digest.keyedFingerprint !== item.keyedFingerprint) integrity();
    }
    if (w.commandId !== event.commandId || w.idempotencyKey !== event.idempotencyKey || w.targetSessionId !== event.sessionId || a.parentSessionId !== event.parentSessionId || a.projectId !== event.projectId || a.vaultId !== event.vaultId || a.storeId !== event.storeId || a.workspaceId !== event.workspaceId || a.presentingActorRole !== event.actorRole || a.presentingClientInstanceId !== event.clientInstanceId || payload.items.some(item => item.binding.eventId !== event.eventId) || canonicalJson(payload) !== event.payloadJson) integrity();
    return payload;
  } catch { return integrity(); }
}
export function assertRetainedEvidenceBundle(value: readonly EncryptedEvidenceItemV1[]): void {
  const items = list(value, 64).map(decodeEncryptedEvidenceItem); if (items.length === 0) closed(); boundedRetainedJson(items, RETAINED_EVIDENCE_BUNDLE_BYTES);
}
export function decodeRedactedEvidencePlaintext(value: unknown, mediaType: EvidenceItemBindingV1["mediaType"]): { readonly content: JsonValue; readonly manifest: readonly RedactionSpanV1[] } {
  const r = record(value, ["content", "manifest"]); const spans = list(r.manifest, RETAINED_EVIDENCE_LIMITS.spans); let end = 0;
  const manifest = spans.map(value => { const span = record(value, ["ruleId", "startByte", "endByte"]); if (!Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte) || Number(span.startByte) < end || Number(span.endByte) <= Number(span.startByte) || Number(span.endByte) > RETAINED_EVIDENCE_LIMITS.frameBytes) closed(); end = Number(span.endByte); return { ruleId: retainedIdentifier(span.ruleId), startByte: Number(span.startByte), endByte: Number(span.endByte) }; });
  if (mediaType === "text/plain; charset=utf-8" && typeof r.content !== "string") closed();
  return boundedRetainedJson({ content: r.content, manifest }, RETAINED_EVIDENCE_BUNDLE_BYTES).snapshot as unknown as { readonly content: JsonValue; readonly manifest: readonly RedactionSpanV1[] };
}
export type RetainedEvidenceStoredResultV1 = { readonly eventIds: string[]; readonly firstGlobalPosition: string; readonly lastGlobalPosition: string; readonly finalStreamVersion: string; readonly response: RetainedEvidenceReceiptV1 };
export function decodeRetainedEvidenceStoredResult(value: unknown): RetainedEvidenceStoredResultV1 {
  const r = record(value, ["eventIds", "firstGlobalPosition", "lastGlobalPosition", "finalStreamVersion", "response"]);
  const eventIds = list(r.eventIds, 1).map(uuid); if (eventIds.length !== 1) closed();
  let response: RetainedEvidenceReceiptV1; try { response = decodeRetainedEvidenceReceipt(r.response); } catch (error) { if (error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED") throw error; closed(); }
  const firstGlobalPosition = decimal(r.firstGlobalPosition, true); const lastGlobalPosition = decimal(r.lastGlobalPosition, true); const finalStreamVersion = decimal(r.finalStreamVersion, true);
  if (firstGlobalPosition !== lastGlobalPosition || response.eventPosition !== firstGlobalPosition || response.finalStreamVersion !== finalStreamVersion) closed();
  return boundedRetainedJson({ eventIds, firstGlobalPosition, lastGlobalPosition, finalStreamVersion, response }, RETAINED_EVIDENCE_LIMITS.resultBytes).snapshot as RetainedEvidenceStoredResultV1;
}
