import { types } from "node:util";
import { FreshStartError } from "../fresh-start/contracts.js";
import type { GovernedNoteKind } from "../governed-notes/contracts.js";
import { GOVERNED_NOTE_V1_MARKERS, GOVERNED_NOTE_V2_MARKERS } from "../projections/contracts.js";
import type { NativeGetConflict, NativeGetResult } from "./content-contracts.js";
import { assertNativeContentMatchesRequest } from "./content-protocol.js";
import { decodeNativeContentItem, decodeNativeContentConflict, decodeNativeSelectionScope } from "./content-data-protocol.js";
import type { TrustedReadSession, FullNoteReadBootstrapV1, FullNoteReadCancelV1, FullNoteReadReplyV1, VerifiedReadBinding } from "./contracts.js";
import type { FullNoteVerifiedReadReceiptV1, GetFullNoteRequest, NativeFullNoteItem, NativeFullNoteResultV1 } from "./full-note-contracts.js";
import { assertReadReplyEnvelope, decodeReadBootstrap, decodeReadCancel, decodeReadReply, decodeVerifiedReadReceipt, decodeVerifiedReadRequest } from "./protocol.js";
import { copyBoundedFullNoteSuccessData, copyBoundedFullNoteResultData, copyBoundedProtocolData } from "./wire-data.js";

function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
/** The historical copier is frozen. Refuse proxies before handing new body-free metadata to it. */
function metadata(value: unknown, maximum: 8192 | 16384): unknown {
  let containers = 0;
  const inspect = (input: unknown, depth: number): void => {
    if (input === null || typeof input !== "object") return;
    if (types.isProxy(input) || depth > 8 || ++containers > 128) invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.length > (Array.isArray(input) ? 65 : 32)) invalid();
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (!d || !("value" in d)) invalid();
      inspect(d.value, depth + 1);
    }
  };
  inspect(value, 0); return copyBoundedProtocolData(value, maximum);
}
export function decodeGetFullNoteRequest(value: unknown, trustedSession: TrustedReadSession | null): GetFullNoteRequest {
  const source = record(metadata(value, 8192), ["operation", "consistency", "minimumEventPosition", "budgetMs", "parameters"]);
  if (source.operation !== "get-full-note") invalid();
  const session = metadata(trustedSession, 8192) as TrustedReadSession | null;
  // Only an owned, body-free equivalent enters the unchanged get decoder; it also validates the trusted session.
  const decoded = decodeVerifiedReadRequest({ ...source, operation: "get-canonical-record" }, session);
  if (decoded.operation !== "get-canonical-record") invalid();
  return Object.freeze({ ...decoded, operation: "get-full-note" });
}
export function decodeFullNoteVerifiedReadReceipt(value: unknown): FullNoteVerifiedReadReceiptV1 {
  const source = record(metadata(value, 16384), ["operation", "consistency", "scope", "releaseId", "controlGeneration", "requiredEventPosition",
    "projectionGeneration", "projectionEventPosition", "projectionEventHash", "imageSha256", "verification", "projectionSchemaVersion"]);
  if (source.operation !== "get-full-note" || source.projectionSchemaVersion !== 3) invalid();
  const { projectionSchemaVersion: _schema, ...inherited } = source;
  const receipt = decodeVerifiedReadReceipt({ ...inherited, operation: "get-canonical-record" });
  return Object.freeze({ ...receipt, operation: "get-full-note", projectionSchemaVersion: 3 });
}
export function decodeNativeFullNoteResult(value: unknown): NativeFullNoteResultV1 {
  const source = copyBoundedFullNoteResultData(value) as Record<string, unknown>;
  let item: NativeFullNoteItem | null = null;
  if (source.item !== null) {
    const raw = source.item as Record<string, unknown>;
    const inherited = decodeNativeContentItem({ id: raw.id, kind: raw.kind, projectId: raw.projectId, workspaceId: raw.workspaceId,
      branchScopeId: raw.branchScopeId, branchRef: raw.branchRef, sessionId: raw.sessionId, visibility: raw.visibility,
      status: raw.status, confidence: raw.confidence, verificationMethod: raw.verificationMethod, validFrom: raw.validFrom, validTo: raw.validTo,
      knownFromEventPosition: raw.knownFromEventPosition, sourceEventPosition: raw.sourceEventPosition, textKind: raw.textKind,
      text: raw.text, conflictGroupId: raw.conflictGroupId, supersedingItemId: raw.supersedingItemId }, false);
    if (GOVERNED_NOTE_V2_MARKERS.has(inherited.verificationMethod)) {
      if (raw.bodyAvailability !== "present") invalid();
    } else if (GOVERNED_NOTE_V1_MARKERS.has(inherited.verificationMethod)) {
      if (raw.bodyAvailability !== "absent" || raw.recordKind === null) invalid();
    } else if (inherited.verificationMethod.startsWith("governed-note-") || raw.bodyAvailability !== "absent" || raw.recordKind !== null) invalid();
    item = raw.bodyAvailability === "present"
      ? Object.freeze({ ...inherited, recordKind: raw.recordKind as GovernedNoteKind, bodyAvailability: "present",
          content: raw.content as Readonly<{ format: "markdown"; body: string; contentHash: string }> })
      : Object.freeze({ ...inherited, recordKind: raw.recordKind as GovernedNoteKind | null, bodyAvailability: "absent", content: null });
  }
  const conflict = source.conflict === null ? null : decodeNativeContentConflict(source.conflict, false) as NativeGetConflict;
  if (item === null ? conflict !== null : item.conflictGroupId === null ? conflict !== null : conflict === null || conflict.conflictGroupId !== item.conflictGroupId) invalid();
  return Object.freeze({ operation: "get-full-note", noteBoundsVersion: "v2-full-note-bounds-1",
    selectionScope: decodeNativeSelectionScope(source.selectionScope), item, conflict });
}

export function decodeFullNoteReadBootstrap(value: unknown): FullNoteReadBootstrapV1 {
  const source = record(metadata(value, 8192), ["version", "ids", "binding", "request", "lockToken", "remainingMs"]);
  if (source.version !== 4) invalid();
  // The entire input is already owned; the legacy validator receives only body-free inherited metadata.
  const rawRequest = record(source.request, ["operation", "consistency", "minimumEventPosition", "budgetMs", "parameters"]);
  if (rawRequest.operation !== "get-full-note") invalid();
  const inherited = decodeReadBootstrap({ ...source, version: 3, request: { ...rawRequest, operation: "get-canonical-record" } });
  const result = Object.freeze({ ...inherited, version: 4 as const, request: decodeGetFullNoteRequest(source.request, inherited.binding.session) });
  metadata(result, 8192); return result;
}
export function decodeFullNoteReadCancel(value: unknown): FullNoteReadCancelV1 {
  const source = record(metadata(value, 16384), ["version", "ids", "kind"]);
  if (source.version !== 4) invalid();
  return Object.freeze({ ...decodeReadCancel({ ...source, version: 3 }), version: 4 });
}
/** Explicit inherited view is constructed only from a dedicated owned full result. */
function summaryView(content: NativeFullNoteResultV1): NativeGetResult {
  const raw = content.item;
  const item = raw === null ? null : { id: raw.id, kind: raw.kind, projectId: raw.projectId, workspaceId: raw.workspaceId,
    branchScopeId: raw.branchScopeId, branchRef: raw.branchRef, sessionId: raw.sessionId, visibility: raw.visibility,
    status: raw.status, confidence: raw.confidence, verificationMethod: raw.verificationMethod, validFrom: raw.validFrom, validTo: raw.validTo,
    knownFromEventPosition: raw.knownFromEventPosition, sourceEventPosition: raw.sourceEventPosition, textKind: raw.textKind,
    text: raw.text, conflictGroupId: raw.conflictGroupId, supersedingItemId: raw.supersedingItemId };
  return { operation: "get-canonical-record", selectionScope: content.selectionScope, item, conflict: content.conflict };
}
export function assertNativeFullNoteMatchesRequest(content: NativeFullNoteResultV1, request: GetFullNoteRequest,
  binding: VerifiedReadBinding, receipt: FullNoteVerifiedReadReceiptV1): void {
  const owned = decodeNativeFullNoteResult(content), verified = decodeFullNoteVerifiedReadReceipt(receipt);
  const { projectionSchemaVersion: _schema, ...inherited } = verified;
  assertNativeContentMatchesRequest(summaryView(owned), { ...request, operation: "get-canonical-record" }, binding,
    { ...inherited, operation: "get-canonical-record" });
}
export function decodeFullNoteReadReply(value: unknown, request: GetFullNoteRequest): FullNoteReadReplyV1 {
  assertReadReplyEnvelope(value, 4);
  // No transport IDs live in request. The parent/entry must check retained IDs before this call.
  const kind = Object.getOwnPropertyDescriptor(value, "kind")!.value;
  if (kind !== "success") {
    const source = metadata(value, 16384) as Record<string, unknown>;
    const inherited = decodeReadReply({ ...source, version: 3 });
    if (inherited.kind === "success") invalid();
    return Object.freeze({ ...inherited, version: 4 });
  }
  const source = copyBoundedFullNoteSuccessData(value) as Record<string, unknown>;
  const receipt = decodeFullNoteVerifiedReadReceipt(source.receipt), content = decodeNativeFullNoteResult(source.content);
  const { projectionSchemaVersion: _schema, ...inheritedReceipt } = receipt;
  const base = decodeReadReply({ version: 3, ids: source.ids, kind: "success", receipt: { ...inheritedReceipt, operation: "verify-published-view" },
    fence: source.fence, closed: source.closed });
  if (base.kind !== "success") invalid();
  // Validate request/filter domains using its selected session, then bind explicit request relationships.
  const ownedRequest = decodeGetFullNoteRequest(request, content.selectionScope.sessionId === null ? null
    : { sessionId: content.selectionScope.sessionId, minimumEventPosition: "0" });
  if (receipt.consistency !== ownedRequest.consistency || (ownedRequest.parameters.visibility !== undefined && content.selectionScope.visibility !== ownedRequest.parameters.visibility)) invalid();
  const item = content.item;
  if (item !== null && (item.id !== ownedRequest.parameters.id
    || (ownedRequest.parameters.knownAt !== undefined && (BigInt(item.knownFromEventPosition) > BigInt(ownedRequest.parameters.knownAt) || BigInt(item.sourceEventPosition) > BigInt(ownedRequest.parameters.knownAt)))
    || (ownedRequest.parameters.validAt !== undefined && item.validFrom !== null && (item.validFrom > ownedRequest.parameters.validAt || (item.validTo !== null && ownedRequest.parameters.validAt >= item.validTo))))) invalid();
  return Object.freeze({ version: 4, ids: base.ids, kind: "success", receipt, content, fence: base.fence, closed: base.closed });
}
