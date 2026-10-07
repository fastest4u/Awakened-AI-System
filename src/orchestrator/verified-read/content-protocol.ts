import { FreshStartError } from "../fresh-start/contracts.js";
import type { RetrievalVisibility } from "../retrieval/contracts.js";
import { NATIVE_CONTENT_BOUNDS_VERSION, NATIVE_CONTENT_RANKING_VERSION } from "./content-contracts.js";
import type { NativeContentResult, NativeGetConflict, NativeGetResult, NativeSearchConflict, NativeSearchItem, NativeSearchResult, NativeSelectionScope, VerifiedContentReadRequest } from "./content-contracts.js";
import type { NativeWorkflowRequest } from "./workflow-contracts.js";
import type { TrustedReadSession, VerifiedReadBinding, VerifiedReadReceipt } from "./contracts.js";
import { copyBoundedProtocolData } from "./wire-data.js";
import { decodeNativeContentItem, decodeNativeContentConflict, decodeNativeSelectionScope, decodeNativeContentFilters } from "./content-data-protocol.js";
import { decodeNativeWorkflowParameters, decodeNativeWorkflowResult, assertNativeWorkflowMatchesRequest } from "./workflow-protocol.js";
const CONTROL = /[\u0000-\u001f\u007f]/u;
const VISIBILITIES: readonly RetrievalVisibility[] = ["project", "workspace", "branch", "session"];
function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function record(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum || CONTROL.test(value)) invalid();
  return value;
}
function position(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 19 || (value.length === 19 && value > "9223372036854775807")) invalid();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }
export function decodeNativeContentParameters(operation: VerifiedContentReadRequest["operation"], value: unknown, trustedSession: TrustedReadSession | null):
  VerifiedContentReadRequest["parameters"] {
  if (operation === "list-canonical-records" || operation === "recent-canonical-records" || operation === "follow-up-radar" || operation === "build-context-pack")
    return decodeNativeWorkflowParameters(operation, value, trustedSession);
  const search = operation === "search-projected-content";
  if (!search && operation !== "get-canonical-record") invalid();
  const key = search ? "query" : "id";
  const source = record(copyBoundedProtocolData(value, 8192), search ? [key, "limit", "visibility", "validAt", "knownAt"] : [key, "visibility", "validAt", "knownAt"], [key]);
  const raw = text(source[key], search ? 1024 : 512);
  const input = search ? raw.normalize("NFKC").trim() : raw;
  text(input, search ? 1024 : 512);
  const filterData = Object.fromEntries(["visibility", "validAt", "knownAt"].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
  const filters = decodeNativeContentFilters(filterData, trustedSession);
  if (!search) return Object.freeze({ id: input, ...filters });
  const limit = Object.hasOwn(source, "limit") ? count(source.limit) : 5;
  if (limit < 1 || limit > 10) invalid();
  return Object.freeze({ query: input, limit, ...filters });
}
export function decodeNativeContentResult(value: unknown): NativeContentResult {
  const input = copyBoundedProtocolData(value, 16384);
  if (!input || typeof input !== "object") invalid();
  const operation = (input as Record<string, unknown>).operation;
  if (operation === "list-canonical-records" || operation === "recent-canonical-records" || operation === "follow-up-radar" || operation === "build-context-pack") return decodeNativeWorkflowResult(input);
  if (operation === "search-projected-content") {
    const source = record(input, ["operation", "selectionScope", "rankingPolicyVersion", "contentBoundsVersion", "items", "conflicts", "candidateBounded", "selectionTruncated", "byteBounded"]);
    if (source.rankingPolicyVersion !== NATIVE_CONTENT_RANKING_VERSION || source.contentBoundsVersion !== NATIVE_CONTENT_BOUNDS_VERSION) invalid();
    const items = Object.freeze(array(source.items, 10).map(value => decodeNativeContentItem(value, true) as NativeSearchItem));
    const conflicts = Object.freeze(array(source.conflicts, 64).map(value => decodeNativeContentConflict(value, true) as NativeSearchConflict));
    if (new Set(items.map(value => JSON.stringify([value.kind, value.id]))).size !== items.length
      || new Set(conflicts.map(value => value.conflictGroupId)).size !== conflicts.length) invalid();
    for (const group of conflicts) if (group.returnedMemberCount !== items.filter(value => value.conflictGroupId === group.conflictGroupId).length) invalid();
    for (const value of items) if (value.conflictGroupId !== null && !conflicts.some(group => group.conflictGroupId === value.conflictGroupId)) invalid();
    return Object.freeze({ operation, selectionScope: decodeNativeSelectionScope(source.selectionScope), rankingPolicyVersion: NATIVE_CONTENT_RANKING_VERSION,
      contentBoundsVersion: NATIVE_CONTENT_BOUNDS_VERSION, items, conflicts, candidateBounded: boolean(source.candidateBounded),
      selectionTruncated: boolean(source.selectionTruncated), byteBounded: boolean(source.byteBounded) });
  }
  if (operation === "get-canonical-record") {
    const source = record(input, ["operation", "selectionScope", "item", "conflict"]);
    const value = source.item === null ? null : decodeNativeContentItem(source.item, false);
    const group = source.conflict === null ? null : decodeNativeContentConflict(source.conflict, false) as NativeGetConflict;
    if (value === null ? group !== null : value.kind !== "canonical" || (value.conflictGroupId === null ? group !== null : group === null || group.conflictGroupId !== value.conflictGroupId)) invalid();
    return Object.freeze({ operation, selectionScope: decodeNativeSelectionScope(source.selectionScope), item: value, conflict: group });
  }
  return invalid();
}
/** Cross-checks detached data against immutable authority; outer decoder owns complete-envelope limits. */
export function assertNativeContentMatchesRequest(content: NativeContentResult, request: VerifiedContentReadRequest, binding: VerifiedReadBinding, receipt: VerifiedReadReceipt): void {
  // Re-decode before dispatch so accessor-bearing content never reaches a property read.
  const result = decodeNativeContentResult(content);
  if (result.operation === "list-canonical-records" || result.operation === "recent-canonical-records" || result.operation === "follow-up-radar" || result.operation === "build-context-pack") {
    if (request.operation !== result.operation) invalid();
    return assertNativeWorkflowMatchesRequest(result, request as NativeWorkflowRequest, binding, receipt);
  }
  if (result.operation !== "search-projected-content" && result.operation !== "get-canonical-record") invalid();
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
