import { types } from "node:util";
import { FreshStartError } from "../fresh-start/contracts.js";
import type { GovernedNoteKind } from "../governed-notes/contracts.js";
import type { NativeGetConflict } from "./content-contracts.js";
import { decodeNativeContentConflict, decodeNativeContentItem, decodeNativeSelectionScope } from "./content-data-protocol.js";
import type { TrustedReadSession } from "./contracts.js";
import type { FullNoteVerifiedReadReceiptV1, GetFullNoteRequest, NativeFullNoteItem, NativeFullNoteResultV1 } from "./full-note-contracts.js";
import { decodeVerifiedReadReceipt, decodeVerifiedReadRequest } from "./protocol.js";
import { copyBoundedFullNoteResultData, copyBoundedProtocolData } from "./wire-data.js";

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
    if (inherited.verificationMethod === "governed-note-unverified-v2") {
      if (raw.bodyAvailability !== "present") invalid();
    } else if (inherited.verificationMethod === "governed-note-unverified-v1") {
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
