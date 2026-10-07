import { FreshStartError } from "../fresh-start/contracts.js";
import { NATIVE_CONTENT_RANKING_VERSION } from "./content-contracts.js";
import type { NativeContentItem, NativeSearchItem, NativeSearchConflict, NativeGetConflict, NativeSelectionScope } from "./content-contracts.js";
import { decodeNativeContentFilters, decodeNativeContentItem, decodeNativeContentConflict, decodeNativeSelectionScope } from "./content-data-protocol.js";
import type { TrustedReadSession, VerifiedReadBinding, VerifiedReadReceipt } from "./contracts.js";
import { NATIVE_WORKFLOW_BOUNDS_VERSION } from "./workflow-contracts.js";
import type { NativeWorkflowRequest, NativeWorkflowResult, NativePageParameters, BuildContextPackRequest, NativeCanonicalPageEntry } from "./workflow-contracts.js";
import { copyBoundedProtocolData } from "./wire-data.js";
import { decodeWorkflowCursor, createWorkflowSelectionHash, assertWorkflowCursorMatches } from "./workflow-cursor.js";

function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function record(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }
function followUp(value: unknown): NativeContentItem {
  const item = decodeNativeContentItem(value, false);
  if (item.kind !== "follow-up" || !["open", "blocked"].includes(item.status) || item.visibility !== "session" || item.sessionId === null) invalid();
  return item;
}
function unique(items: readonly NativeContentItem[]): void {
  if (new Set(items.map(item => JSON.stringify([item.kind, item.id]))).size !== items.length) invalid();
}
function checkFollowUps(items: readonly NativeContentItem[], scope: NativeSelectionScope): void {
  for (const item of items) if (scope.visibility !== "session" || scope.sessionId === null || item.sessionId !== scope.sessionId) invalid();
}
function binary(a: string, b: string): number { return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }
function checkOrder(items: readonly NativeContentItem[], byPosition: boolean): void {
  for (let i = 1; i < items.length; i++) {
    const previous = items[i - 1], current = items[i];
    if (byPosition && BigInt(previous.sourceEventPosition) !== BigInt(current.sourceEventPosition)) {
      if (BigInt(previous.sourceEventPosition) < BigInt(current.sourceEventPosition)) invalid();
    } else if (binary(previous.id, current.id) >= 0) invalid();
  }
}
export function decodeNativeWorkflowParameters(operation: NativeWorkflowRequest["operation"], value: unknown, trustedSession: TrustedReadSession | null): NativePageParameters | BuildContextPackRequest["parameters"] {
  if (!["list-canonical-records", "recent-canonical-records", "follow-up-radar", "build-context-pack"].includes(operation)) invalid();
  const context = operation === "build-context-pack";
  const source = record(copyBoundedProtocolData(value, 8192), [...(context ? ["query"] : ["limit", "cursor"]), "visibility", "validAt", "knownAt"], context ? ["query"] : []);
  const filterData = Object.fromEntries(["visibility", "validAt", "knownAt"].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
  const filters = decodeNativeContentFilters(filterData, trustedSession);
  if (context) {
    const query = text(text(source.query, 1024).normalize("NFKC").trim(), 1024);
    return Object.freeze({ query, ...filters });
  }
  const limit = Object.hasOwn(source, "limit") ? source.limit : 5;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) invalid();
  if (Object.hasOwn(source, "cursor")) decodeWorkflowCursor(source.cursor);
  return Object.freeze({ limit, ...filters, ...(Object.hasOwn(source, "cursor") ? { cursor: text(source.cursor, 2048) } : {}) });
}
export function decodeNativeWorkflowResult(value: unknown): NativeWorkflowResult {
  const input = copyBoundedProtocolData(value, 16384);
  if (!input || typeof input !== "object") invalid();
  const operation = (input as Record<string, unknown>).operation;
  if (!["list-canonical-records", "recent-canonical-records", "follow-up-radar", "build-context-pack"].includes(operation as string)) invalid();
  const context = operation === "build-context-pack";
  const source = record(input, context ? ["operation", "selectionScope", "workflowBoundsVersion", "rankingPolicyVersion", "items", "conflicts", "followUps", "candidateBounded", "selectionTruncated", "byteBounded"]
    : ["operation", "selectionScope", "workflowBoundsVersion", "order", "items", "hasMore", "nextCursor", "byteBounded"]);
  if (source.workflowBoundsVersion !== NATIVE_WORKFLOW_BOUNDS_VERSION) invalid();
  const selectionScope = decodeNativeSelectionScope(source.selectionScope);
  const byteBounded = boolean(source.byteBounded);
  if (context) {
    if (source.rankingPolicyVersion !== NATIVE_CONTENT_RANKING_VERSION) invalid();
    const items = Object.freeze(array(source.items, 10).map(value => decodeNativeContentItem(value, true) as NativeSearchItem));
    const followUps = Object.freeze(array(source.followUps, 10).map(followUp));
    if (items.length + followUps.length > 10) invalid();
    unique([...items, ...followUps]); checkFollowUps(followUps, selectionScope);
    checkOrder(followUps, true);
    checkFollowUps(items.filter(item => item.kind === "follow-up"), selectionScope);
    for (const item of items) if (item.kind === "follow-up" && !["open", "blocked"].includes(item.status)) invalid();
    const conflicts = Object.freeze(array(source.conflicts, 64).map(value => decodeNativeContentConflict(value, true) as NativeSearchConflict));
    if (new Set(conflicts.map(group => group.conflictGroupId)).size !== conflicts.length) invalid();
    for (const group of conflicts) if (group.returnedMemberCount !== items.filter(item => item.conflictGroupId === group.conflictGroupId).length) invalid();
    for (const item of items) if (item.conflictGroupId !== null && !conflicts.some(group => group.conflictGroupId === item.conflictGroupId)) invalid();
    return Object.freeze({ operation: "build-context-pack", selectionScope, workflowBoundsVersion: NATIVE_WORKFLOW_BOUNDS_VERSION,
      rankingPolicyVersion: NATIVE_CONTENT_RANKING_VERSION, items, conflicts, followUps,
      candidateBounded: boolean(source.candidateBounded), selectionTruncated: boolean(source.selectionTruncated), byteBounded });
  }
  const expectedOrder = operation === "list-canonical-records" ? "item-id-binary-asc" : "source-event-position-desc-id-binary-asc";
  if (source.order !== expectedOrder) invalid();
  const hasMore = boolean(source.hasMore), nextCursor = source.nextCursor === null ? null : text(source.nextCursor, 2048);
  if (nextCursor !== null) decodeWorkflowCursor(nextCursor);
  if (hasMore !== (nextCursor !== null)) invalid();
  const paging = { selectionScope, workflowBoundsVersion: NATIVE_WORKFLOW_BOUNDS_VERSION as typeof NATIVE_WORKFLOW_BOUNDS_VERSION, hasMore, nextCursor, byteBounded };
  if (operation === "follow-up-radar") {
    const items = Object.freeze(array(source.items, 10).map(followUp));
    unique(items); checkFollowUps(items, selectionScope); checkOrder(items, true);
    if (!items.length && hasMore) invalid();
    return Object.freeze({ ...paging, operation, order: "source-event-position-desc-id-binary-asc", items });
  }
  const items = Object.freeze(array(source.items, 10).map(value => {
    const entry = record(value, ["item", "conflict"]);
    const item = decodeNativeContentItem(entry.item, false);
    const conflict = entry.conflict === null ? null : decodeNativeContentConflict(entry.conflict, false) as NativeGetConflict;
    if (item.kind !== "canonical" || (item.conflictGroupId === null ? conflict !== null : conflict === null || item.conflictGroupId !== conflict.conflictGroupId)) invalid();
    return Object.freeze({ item, conflict }) as NativeCanonicalPageEntry;
  }));
  unique(items.map(entry => entry.item)); checkOrder(items.map(entry => entry.item), operation !== "list-canonical-records");
  for (const entry of items) {
    if (entry.conflict === null) continue;
    const members = items.filter(value => value.item.conflictGroupId === entry.conflict!.conflictGroupId);
    if (entry.conflict.eligibleMemberCount < members.length
      || members.some(value => value.conflict?.eligibleMemberCount !== entry.conflict!.eligibleMemberCount)) invalid();
  }
  if (!items.length && hasMore) invalid();
  return Object.freeze({ ...paging, operation, order: expectedOrder, items }) as NativeWorkflowResult;
}
/** Intrinsic shape and trusted selection authority are separate, mandatory checks. */
export function assertNativeWorkflowMatchesRequest(content: NativeWorkflowResult, request: NativeWorkflowRequest, binding: VerifiedReadBinding, receipt: VerifiedReadReceipt): void {
  const result = decodeNativeWorkflowResult(content);
  if (result.operation !== request.operation || receipt.operation !== request.operation || receipt.consistency !== request.consistency) invalid();
  const parameters = decodeNativeWorkflowParameters(request.operation, request.parameters, binding.session);
  const expected = { projectId: binding.projectionBinding.projectId, workspaceId: binding.projectionBinding.workspaceId,
    branchScopeId: binding.projectionBinding.branchScopeId, branchRef: binding.projectionBinding.branchRef,
    sessionId: binding.session?.sessionId ?? null, visibility: parameters.visibility ?? (binding.session === null ? "branch" : "session") };
  for (const key of Object.keys(expected) as (keyof NativeSelectionScope)[]) if (result.selectionScope[key] !== expected[key]) invalid();
  const items = result.operation === "build-context-pack" ? [...result.items, ...result.followUps]
    : result.operation === "follow-up-radar" ? result.items : result.items.map(entry => entry.item);
  if (result.operation !== "build-context-pack" && items.length > ((parameters as NativePageParameters).limit ?? 5)) invalid();
  if (result.operation !== "build-context-pack" && result.nextCursor !== null) {
    const cursor = decodeWorkflowCursor(result.nextCursor);
    assertWorkflowCursorMatches(cursor, { version: 1, operation: result.operation, schemaVersion: 2,
      selectionHash: createWorkflowSelectionHash(result.operation, binding, expected as NativeSelectionScope, parameters),
      projectionGeneration: receipt.projectionGeneration, projectionEventPosition: receipt.projectionEventPosition, imageSha256: receipt.imageSha256 });
    const last = items.at(-1);
    if (last === undefined || cursor.lastId !== last.id
      || cursor.lastEventPosition !== (result.operation === "list-canonical-records" ? null : last.sourceEventPosition)) invalid();
  }
  const visibilities = ["project", "workspace", "branch", "session"];
  for (const item of items) {
    if (item.projectId !== expected.projectId || item.workspaceId !== expected.workspaceId || item.branchScopeId !== expected.branchScopeId || item.branchRef !== expected.branchRef
      || visibilities.indexOf(item.visibility) > visibilities.indexOf(expected.visibility)
      || (item.sessionId !== null && item.visibility !== "session")
      || (item.visibility === "session" && (expected.sessionId === null || item.sessionId !== expected.sessionId))
      || ["retracted", "expired", "erased-evidence"].includes(item.status)
      || BigInt(item.sourceEventPosition) > BigInt(receipt.projectionEventPosition)) invalid();
    if (item.kind === "follow-up" && (expected.sessionId === null || item.sessionId !== expected.sessionId || !["open", "blocked"].includes(item.status))) invalid();
    if (parameters.knownAt !== undefined && (BigInt(item.knownFromEventPosition) > BigInt(parameters.knownAt) || BigInt(item.sourceEventPosition) > BigInt(parameters.knownAt))) invalid();
    if (parameters.validAt !== undefined && item.validFrom !== null && (item.validFrom > parameters.validAt || (item.validTo !== null && parameters.validAt >= item.validTo))) invalid();
  }
}
