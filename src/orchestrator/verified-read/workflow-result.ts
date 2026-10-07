import type { FusedCandidate } from "../retrieval/ranking.js";
import { estimateCandidateTokens } from "../retrieval/ranking.js";
import { NATIVE_CONTENT_RANKING_VERSION, type NativeContentItem, type NativeSearchConflict, type NativeSearchItem } from "./content-contracts.js";
import { detachNativeContentItem, detachNativeSearchItem } from "./content-items.js";
import type { ReadSuccessBase } from "./contracts.js";
import type { NativeWorkflowCandidate } from "./workflow-query.js";
import { NATIVE_WORKFLOW_BOUNDS_VERSION, type NativeCanonicalPageEntry, type NativeContextResult, type NativeWorkflowResult } from "./workflow-contracts.js";
import { nextWorkflowCursor } from "./workflow-cursor.js";
import { decodeNativeWorkflowResult } from "./workflow-protocol.js";
import { copyBoundedProtocolData, encodedProtocolBytes } from "./wire-data.js";

function tooLarge(): never { throw Object.assign(new Error("V2_CONTENT_RESULT_TOO_LARGE"), { code: "V2_CONTENT_RESULT_TOO_LARGE" }); }
/** Reservations include closure metadata, but never attest successful cleanup. */
function envelope(result: NativeWorkflowResult, base: ReadSuccessBase): NativeWorkflowResult {
  let copied: { content: unknown };
  try {
    copied = copyBoundedProtocolData({ ...base, content: result }, 16384) as { content: unknown };
    if (encodedProtocolBytes(copied) > 16384) tooLarge();
  } catch { tooLarge(); }
  return decodeNativeWorkflowResult(copied.content);
}
const identity = (item: Pick<NativeContentItem, "kind" | "id">): string => JSON.stringify([item.kind, item.id]);
/** Charge genuine retrieval text and keys, plus all prospective wire metadata (including identity twice). */
export function estimateNativeWorkflowContextTokens(result: NativeContextResult, selected: readonly Pick<FusedCandidate, "id" | "item">[]): number {
  const metadata = { ...result, items: result.items.map(item => ({ ...item, text: "" })), followUps: result.followUps.map(item => ({ ...item, text: "" })) };
  return selected.reduce((sum, candidate) => sum + estimateCandidateTokens(candidate), 0)
    + Math.ceil(encodedProtocolBytes(metadata) / 4);
}

function contextResult(candidate: Extract<NativeWorkflowCandidate, { operation: "build-context-pack" }>, base: ReadSuccessBase): NativeContextResult {
  const ranked = candidate.ranked;
  const groups = new Map<string, FusedCandidate[]>();
  for (const value of ranked.rankedCandidates) {
    if (value.conflictGroupId === null) continue;
    const members = groups.get(value.conflictGroupId) ?? []; members.push(value); groups.set(value.conflictGroupId, members);
  }
  const descriptors: NativeSearchConflict[] = [...groups].map(([conflictGroupId, members]) => ({ conflictGroupId,
    eligibleMemberCount: ranked.conflictGroups.find(group => group.conflictGroupId === conflictGroupId)?.eligibleMemberCount
      ?? Math.max(members.length, ...members.map(member => member.conflictTotalMemberCount ?? 0)),
    returnedMemberCount: 0, highImpact: members.some(member => member.highImpact), truncated: true }));
  let items: NativeSearchItem[] = [], followUps: NativeContentItem[] = [];
  let selected: Pick<FusedCandidate, "id" | "item">[] = [];
  let selectionTruncated = ranked.selection.truncated, byteBounded = false;
  const result = (nextItems = items, nextFollowUps = followUps): NativeContextResult => ({ operation: "build-context-pack", selectionScope: candidate.selectionScope,
    rankingPolicyVersion: NATIVE_CONTENT_RANKING_VERSION, workflowBoundsVersion: NATIVE_WORKFLOW_BOUNDS_VERSION,
    items: nextItems, followUps: nextFollowUps,
    conflicts: descriptors.map(group => { const count = nextItems.filter(item => item.conflictGroupId === group.conflictGroupId).length;
      return { ...group, returnedMemberCount: count, truncated: count < group.eligibleMemberCount }; }),
    candidateBounded: ranked.candidateBounded || candidate.followUps.hasMore, selectionTruncated, byteBounded });
  const checked = (prospective: NativeContextResult): NativeContextResult => envelope(prospective, base) as NativeContextResult;
  checked(result());
  if (estimateNativeWorkflowContextTokens(result(), []) > 2048) tooLarge();
  const seen = new Set<string>(), processed = new Set<string>();
  const selectedIds = new Set(ranked.selection.candidates.map(value => value.id));
  for (const value of ranked.rankedCandidates) {
    let unit: readonly FusedCandidate[], incomplete = false;
    if (value.conflictGroupId === null) {
      if (!selectedIds.has(value.id)) continue;
      unit = [ranked.selection.candidates.find(member => member.id === value.id)!];
    } else {
      if (processed.has(value.conflictGroupId)) continue; processed.add(value.conflictGroupId);
      unit = ranked.selection.candidates.filter(member => member.conflictGroupId === value.conflictGroupId);
      incomplete = unit.length < descriptors.find(group => group.conflictGroupId === value.conflictGroupId)!.eligibleMemberCount;
      if (incomplete) selectionTruncated = true;
      if (!unit.length) break;
    }
    const unitSeen = new Set(seen);
    unit = unit.filter(member => { if (member.item === undefined) throw Object.assign(new Error("INTEGRITY_FAILURE"), { code: "INTEGRITY_FAILURE" });
      const key = identity(member.item); if (unitSeen.has(key)) return false; unitSeen.add(key); return true; });
    if (items.length + followUps.length + unit.length > 10) { selectionTruncated = true; break; }
    const nextItems = [...items, ...unit.map(detachNativeSearchItem)], nextSelected = [...selected, ...unit];
    try { checked(result(nextItems)); }
    catch (error) { if ((error as { code?: string }).code !== "V2_CONTENT_RESULT_TOO_LARGE") throw error; byteBounded = true; break; }
    if (estimateNativeWorkflowContextTokens(result(nextItems), nextSelected) > 2048) { selectionTruncated = true; break; }
    items = nextItems; selected = nextSelected; for (const key of unitSeen) seen.add(key);
    if (incomplete) break;
  }
  for (const item of candidate.followUps.items) {
    const key = identity(item); if (seen.has(key)) continue;
    if (items.length + followUps.length >= 10) { selectionTruncated = true; break; }
    const nextFollowUps = [...followUps, detachNativeContentItem(item)], nextSelected = [...selected, { id: `${item.kind}:${item.id}`, item }];
    try { checked(result(items, nextFollowUps)); }
    catch (error) { if ((error as { code?: string }).code !== "V2_CONTENT_RESULT_TOO_LARGE") throw error; byteBounded = true; break; }
    if (estimateNativeWorkflowContextTokens(result(items, nextFollowUps), nextSelected) > 2048) { selectionTruncated = true; break; }
    followUps = nextFollowUps; selected = nextSelected; seen.add(key);
  }
  const final = checked(result());
  if (estimateNativeWorkflowContextTokens(final, selected) > 2048) tooLarge();
  return final;
}

export function buildNativeWorkflowResult(candidate: NativeWorkflowCandidate, base: ReadSuccessBase): NativeWorkflowResult {
  if (candidate.operation === "build-context-pack") return contextResult(candidate, base);
  const radar = candidate.operation === "follow-up-radar";
  const rows = candidate.page.items;
  let count = 0, byteBounded = false;
  const result = (size: number): NativeWorkflowResult => {
    const hasMore = candidate.page.hasMore || size < rows.length;
    const last = size === 0 ? null : radar ? (candidate as Extract<NativeWorkflowCandidate, { operation: "follow-up-radar" }>).page.items[size - 1]
      : (candidate as Extract<NativeWorkflowCandidate, { operation: "list-canonical-records" | "recent-canonical-records" }>).page.items[size - 1].item;
    let nextCursor: string | null = null;
    if (hasMore && last !== null) {
      try { nextCursor = nextWorkflowCursor(candidate.cursorBinding, { id: last.id, eventPosition: candidate.operation === "list-canonical-records" ? null : last.sourceEventPosition }); }
      catch { tooLarge(); }
    }
    const common = { selectionScope: candidate.selectionScope, workflowBoundsVersion: NATIVE_WORKFLOW_BOUNDS_VERSION as typeof NATIVE_WORKFLOW_BOUNDS_VERSION, hasMore, nextCursor, byteBounded };
    if (candidate.operation === "follow-up-radar") return { ...common, operation: candidate.operation,
      order: "source-event-position-desc-id-binary-asc", items: candidate.page.items.slice(0, size).map(detachNativeContentItem) };
    const items: NativeCanonicalPageEntry[] = candidate.page.items.slice(0, size).map(entry => ({ item: detachNativeContentItem(entry.item),
      conflict: entry.item.conflictGroupId === null ? null : { conflictGroupId: entry.item.conflictGroupId,
        eligibleMemberCount: entry.eligibleConflictMemberCount!, returnedMemberCount: 1, truncated: entry.eligibleConflictMemberCount! > 1 } }));
    return { ...common, operation: candidate.operation, order: candidate.operation === "list-canonical-records" ? "item-id-binary-asc" : "source-event-position-desc-id-binary-asc", items };
  };
  // Do not decode an empty continued reservation: mandatory metadata is validated with the first real unit.
  if (!rows.length) return envelope(result(0), base);
  for (let size = 1; size <= rows.length; size++) {
    try { envelope(result(size), base); }
    catch (error) { if ((error as { code?: string }).code !== "V2_CONTENT_RESULT_TOO_LARGE") throw error;
      if (count === 0) tooLarge(); byteBounded = true; break; }
    count = size;
  }
  return envelope(result(count), base);
}
