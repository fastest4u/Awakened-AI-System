import { FreshStartError } from "../fresh-start/contracts.js";
import { isProjectionProjectStoreIdentity } from "../projections/contracts.js";
import type { RetrievalChannel, RetrievalItem, RetrievalVisibility } from "../retrieval/contracts.js";
import { NATIVE_CONTENT_BOUNDS_VERSION, NATIVE_CONTENT_RANKING_VERSION } from "./content-contracts.js";
import type { GetCanonicalRecordRequest, NativeContentItem, NativeContentResult, NativeGetConflict,
  NativeSearchConflict, NativeSearchItem, NativeSelectionScope, SearchProjectedContentRequest, VerifiedContentReadRequest } from "./content-contracts.js";
import type { TrustedReadSession, VerifiedReadBinding, VerifiedReadReceipt } from "./contracts.js";
import { copyBoundedProtocolData } from "./wire-data.js";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VISIBILITIES: readonly RetrievalVisibility[] = ["project", "workspace", "branch", "session"];
const KINDS: readonly RetrievalItem["kind"][] = ["canonical", "lexical", "artifact", "checkpoint", "follow-up"];
const STATUSES: readonly RetrievalItem["status"][] = ["candidate", "provisional", "verified", "conflicted", "superseded", "retracted", "expired", "erased-evidence", "active", "open", "blocked"];
const CHANNELS: readonly RetrievalChannel[] = ["exact", "alias", "lexical", "symbol-path", "session-checkpoint", "open-follow-up", "conflict-closure"];
const ITEM_KEYS = ["id", "kind", "projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility", "status", "confidence", "verificationMethod", "validFrom", "validTo", "knownFromEventPosition", "sourceEventPosition", "textKind", "text", "conflictGroupId", "supersedingItemId"];
function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
/** Only used on descriptor-copied inputs. */
function record(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value, "utf8") > maximum || CONTROL.test(value)) invalid();
  return value;
}
function position(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 19
    || (value.length === 19 && value > "9223372036854775807")) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) invalid();
  return result;
}
function identity(value: unknown): string { if (!isProjectionProjectStoreIdentity(value)) invalid(); return value as string; }
function hash(value: unknown): string { const result = text(value, 64); if (!HASH.test(result)) invalid(); return result; }
function nullableUuid(value: unknown): string | null { if (value === null) return null; const result = text(value, 36); if (!UUID.test(result)) invalid(); return result; }
function nullableText(value: unknown, maximum = 2048): string | null { return value === null ? null : text(value, maximum); }
function visibility(value: unknown): RetrievalVisibility { if (!VISIBILITIES.includes(value as RetrievalVisibility)) invalid(); return value as RetrievalVisibility; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }

export function decodeNativeContentParameters(operation: VerifiedContentReadRequest["operation"], value: unknown, trustedSession: TrustedReadSession | null):
  SearchProjectedContentRequest["parameters"] | GetCanonicalRecordRequest["parameters"] {
  const search = operation === "search-projected-content";
  if (!search && operation !== "get-canonical-record") invalid();
  const key = search ? "query" : "id";
  const source = record(copyBoundedProtocolData(value, 8192), search ? [key, "limit", "visibility", "validAt", "knownAt"] : [key, "visibility", "validAt", "knownAt"], [key]);
  const raw = text(source[key], search ? 1024 : 512);
  const input = search ? raw.normalize("NFKC").trim() : raw;
  text(input, search ? 1024 : 512);
  const filters = {
    ...(Object.hasOwn(source, "visibility") ? { visibility: visibility(source.visibility) } : {}),
    ...(Object.hasOwn(source, "validAt") ? { validAt: timestamp(source.validAt) } : {}),
    ...(Object.hasOwn(source, "knownAt") ? { knownAt: position(source.knownAt) } : {}),
  };
  if (filters.visibility === "session" && trustedSession === null) invalid();
  if (!search) return Object.freeze({ id: input, ...filters });
  const limit = Object.hasOwn(source, "limit") ? count(source.limit) : 5;
  if (limit < 1 || limit > 10) invalid();
  return Object.freeze({ query: input, limit, ...filters });
}
function selectionScope(value: unknown): NativeSelectionScope {
  const source = record(value, ["projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility"]);
  return Object.freeze({ projectId: identity(source.projectId), workspaceId: hash(source.workspaceId),
    branchScopeId: nullableUuid(source.branchScopeId), branchRef: nullableText(source.branchRef, 1024),
    sessionId: nullableUuid(source.sessionId), visibility: visibility(source.visibility) });
}
function item(value: unknown, search: boolean): NativeContentItem | NativeSearchItem {
  const source = record(value, search ? [...ITEM_KEYS, "channels", "selectionReason"] : ITEM_KEYS);
  if (!KINDS.includes(source.kind as RetrievalItem["kind"]) || !STATUSES.includes(source.status as RetrievalItem["status"])
    || !["high", "medium", "low", "guess"].includes(source.confidence as string)) invalid();
  const textKind = source.kind === "canonical" ? "canonical-summary" : "projection-text";
  if (source.textKind !== textKind || typeof source.text !== "string") invalid();
  // Projected text is intentional content and may contain newlines or be empty.
  const output: NativeContentItem = Object.freeze({ id: text(source.id, 2048), kind: source.kind as RetrievalItem["kind"],
    projectId: identity(source.projectId), workspaceId: hash(source.workspaceId), branchScopeId: nullableUuid(source.branchScopeId),
    branchRef: nullableText(source.branchRef, 1024), sessionId: nullableUuid(source.sessionId), visibility: visibility(source.visibility),
    status: source.status as RetrievalItem["status"], confidence: source.confidence as RetrievalItem["confidence"], verificationMethod: text(source.verificationMethod, 2048, true),
    validFrom: source.validFrom === null ? null : timestamp(source.validFrom), validTo: source.validTo === null ? null : timestamp(source.validTo),
    knownFromEventPosition: position(source.knownFromEventPosition), sourceEventPosition: position(source.sourceEventPosition), textKind,
    text: source.text, conflictGroupId: nullableText(source.conflictGroupId), supersedingItemId: nullableText(source.supersedingItemId) });
  if (BigInt(output.knownFromEventPosition) > BigInt(output.sourceEventPosition)) invalid();
  if (!search) return output;
  const channels = array(source.channels, 7);
  if (channels.length === 0 || new Set(channels).size !== channels.length || channels.some(channel => !CHANNELS.includes(channel as RetrievalChannel))
    || !channels.includes(source.selectionReason)) invalid();
  return Object.freeze({ ...output, channels: Object.freeze([...channels]) as readonly RetrievalChannel[], selectionReason: source.selectionReason as RetrievalChannel });
}
function conflict(value: unknown, search: boolean): NativeSearchConflict | NativeGetConflict {
  const source = record(value, search ? ["conflictGroupId", "eligibleMemberCount", "returnedMemberCount", "highImpact", "truncated"] : ["conflictGroupId", "eligibleMemberCount", "returnedMemberCount", "truncated"]);
  const eligibleMemberCount = count(source.eligibleMemberCount), returnedMemberCount = count(source.returnedMemberCount), truncated = boolean(source.truncated);
  if (returnedMemberCount > eligibleMemberCount || truncated !== (returnedMemberCount < eligibleMemberCount)) invalid();
  const common = { conflictGroupId: text(source.conflictGroupId, 2048), eligibleMemberCount, returnedMemberCount, truncated };
  if (search) return Object.freeze({ ...common, highImpact: boolean(source.highImpact) });
  if (returnedMemberCount !== 1 || eligibleMemberCount < 1) invalid();
  return Object.freeze({ ...common, returnedMemberCount: 1 });
}
export function decodeNativeContentResult(value: unknown): NativeContentResult {
  const input = copyBoundedProtocolData(value, 16384);
  if (!input || typeof input !== "object") invalid();
  const operation = (input as Record<string, unknown>).operation;
  if (operation === "search-projected-content") {
    const source = record(input, ["operation", "selectionScope", "rankingPolicyVersion", "contentBoundsVersion", "items", "conflicts", "candidateBounded", "selectionTruncated", "byteBounded"]);
    if (source.rankingPolicyVersion !== NATIVE_CONTENT_RANKING_VERSION || source.contentBoundsVersion !== NATIVE_CONTENT_BOUNDS_VERSION) invalid();
    const items = Object.freeze(array(source.items, 10).map(value => item(value, true) as NativeSearchItem));
    const conflicts = Object.freeze(array(source.conflicts, 64).map(value => conflict(value, true) as NativeSearchConflict));
    if (new Set(items.map(value => JSON.stringify([value.kind, value.id]))).size !== items.length
      || new Set(conflicts.map(value => value.conflictGroupId)).size !== conflicts.length) invalid();
    for (const group of conflicts) if (group.returnedMemberCount !== items.filter(value => value.conflictGroupId === group.conflictGroupId).length) invalid();
    for (const value of items) if (value.conflictGroupId !== null && !conflicts.some(group => group.conflictGroupId === value.conflictGroupId)) invalid();
    return Object.freeze({ operation, selectionScope: selectionScope(source.selectionScope), rankingPolicyVersion: NATIVE_CONTENT_RANKING_VERSION,
      contentBoundsVersion: NATIVE_CONTENT_BOUNDS_VERSION, items, conflicts, candidateBounded: boolean(source.candidateBounded),
      selectionTruncated: boolean(source.selectionTruncated), byteBounded: boolean(source.byteBounded) });
  }
  if (operation === "get-canonical-record") {
    const source = record(input, ["operation", "selectionScope", "item", "conflict"]);
    const value = source.item === null ? null : item(source.item, false);
    const group = source.conflict === null ? null : conflict(source.conflict, false) as NativeGetConflict;
    if (value === null ? group !== null : value.kind !== "canonical" || (value.conflictGroupId === null ? group !== null : group === null || group.conflictGroupId !== value.conflictGroupId)) invalid();
    return Object.freeze({ operation, selectionScope: selectionScope(source.selectionScope), item: value, conflict: group });
  }
  return invalid();
}
/** Cross-checks detached data against immutable authority; outer decoder owns complete-envelope limits. */
export function assertNativeContentMatchesRequest(content: NativeContentResult, request: VerifiedContentReadRequest, binding: VerifiedReadBinding, receipt: VerifiedReadReceipt): void {
  // Re-decode to make intrinsic relationships mandatory even for independently constructed child results.
  const result = decodeNativeContentResult(content);
  if (result.operation !== request.operation || receipt.operation !== request.operation || receipt.consistency !== request.consistency) invalid();
  const parameters = decodeNativeContentParameters(request.operation, request.parameters, binding.session);
  const expected = { projectId: binding.projectionBinding.projectId, workspaceId: binding.projectionBinding.workspaceId,
    branchScopeId: binding.projectionBinding.branchScopeId, branchRef: binding.projectionBinding.branchRef,
    sessionId: binding.session?.sessionId ?? null, visibility: parameters.visibility ?? (binding.session === null ? "branch" : "session") };
  for (const key of Object.keys(expected) as (keyof NativeSelectionScope)[]) if (result.selectionScope[key] !== expected[key]) invalid();
  const imagePosition = BigInt(position(receipt.projectionEventPosition));
  const items = result.operation === "search-projected-content" ? result.items : result.item === null ? [] : [result.item];
  if (result.operation === "search-projected-content") {
    if (request.operation !== "search-projected-content" || result.items.length > (request.parameters.limit ?? 5)) invalid();
  } else if (result.item !== null && (request.operation !== "get-canonical-record" || result.item.id !== request.parameters.id || result.item.kind !== "canonical")) invalid();
  for (const value of items) {
    if (value.projectId !== expected.projectId || value.workspaceId !== expected.workspaceId || value.branchScopeId !== expected.branchScopeId || value.branchRef !== expected.branchRef
      || VISIBILITIES.indexOf(value.visibility) > VISIBILITIES.indexOf(expected.visibility)
      || (value.sessionId !== null && value.visibility !== "session")
      || (value.visibility === "session" && (expected.sessionId === null || value.sessionId !== expected.sessionId))
      || ["retracted", "expired", "erased-evidence"].includes(value.status)
      || BigInt(value.knownFromEventPosition) > BigInt(value.sourceEventPosition) || BigInt(value.sourceEventPosition) > imagePosition) invalid();
    if (parameters.knownAt !== undefined && (BigInt(value.knownFromEventPosition) > BigInt(parameters.knownAt) || BigInt(value.sourceEventPosition) > BigInt(parameters.knownAt))) invalid();
    if (parameters.validAt !== undefined && value.validFrom !== null
      && (value.validFrom > parameters.validAt || (value.validTo !== null && parameters.validAt >= value.validTo))) invalid();
  }
}
