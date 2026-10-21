import { detachNativeContentItem, detachNativeSearchItem } from "./content-items.js";
import { buildNativeWorkflowResult } from "./workflow-result.js";
import type { FusedCandidate } from "../retrieval/ranking.js";
import {
  NATIVE_CONTENT_BOUNDS_VERSION, NATIVE_CONTENT_RANKING_VERSION,
  type NativeContentResult, type NativeGetResult, type NativeSearchConflict,
  type NativeSearchItem, type NativeSearchResult,
} from "./content-contracts.js";
import { decodeNativeContentResult } from "./content-protocol.js";
import type { NativeQueryCandidate } from "./content-query.js";
import type { ReadSuccessBase } from "./contracts.js";
import { copyBoundedProtocolData, encodedProtocolBytes } from "./wire-data.js";

function tooLarge(): never {
  throw Object.assign(new Error("V2_CONTENT_RESULT_TOO_LARGE"), { code: "V2_CONTENT_RESULT_TOO_LARGE" });
}
/** Capacity reservation only: prospective closure fields do not attest cleanup or authorize emission. */
function boundedEnvelope(content: NativeSearchResult | NativeGetResult, base: ReadSuccessBase): NativeSearchResult | NativeGetResult {
  let copied: { content: unknown };
  try {
    copied = copyBoundedProtocolData({ ...base, content }, 16384) as { content: unknown };
    if (encodedProtocolBytes(copied) > 16384) return tooLarge();
  } catch { return tooLarge(); }
  const result = decodeNativeContentResult(copied.content);
  if (result.operation !== "search-projected-content" && result.operation !== "get-canonical-record") {
    throw Object.assign(new Error("INTEGRITY_FAILURE"), { code: "INTEGRITY_FAILURE" });
  }
  return result;
}

/** Converts private ranked candidates without changing selection policy or releasing any content. */
export function buildNativeContentResult(candidate: NativeQueryCandidate, base: ReadSuccessBase): NativeContentResult {
  if (candidate.operation === "list-canonical-records" || candidate.operation === "recent-canonical-records"
    || candidate.operation === "follow-up-radar" || candidate.operation === "build-context-pack") {
    return buildNativeWorkflowResult(candidate, base);
  }
  if (candidate.operation === "get-canonical-record") {
    const item = candidate.lookup.item;
    return boundedEnvelope({ operation: candidate.operation, selectionScope: candidate.selectionScope,
      item: item === null ? null : detachNativeContentItem(item),
      conflict: item === null || item.conflictGroupId === null ? null : {
        conflictGroupId: item.conflictGroupId, eligibleMemberCount: candidate.lookup.eligibleConflictMemberCount!,
        returnedMemberCount: 1, truncated: candidate.lookup.eligibleConflictMemberCount! > 1,
      } }, base);
  }

  if (candidate.operation !== "search-projected-content") {
    const exhaustive: never = candidate.operation;
    throw Object.assign(new Error("INTEGRITY_FAILURE"), { code: "INTEGRITY_FAILURE", cause: exhaustive });
  }
  // Only groups appearing in defensive, reranked candidates are considered; collection-only
  // groups can have no eligible observed member and must not disclose counts.
  const groups = new Map<string, FusedCandidate[]>();
  for (const value of candidate.rankedCandidates) {
    if (value.conflictGroupId === null) continue;
    const members = groups.get(value.conflictGroupId) ?? [];
    members.push(value); groups.set(value.conflictGroupId, members);
  }
  const descriptors: NativeSearchConflict[] = [...groups].map(([conflictGroupId, members]) => {
    const scoped = candidate.conflictGroups.find(value => value.conflictGroupId === conflictGroupId);
    const eligibleMemberCount = scoped?.eligibleMemberCount ?? Math.max(members.length,
      ...members.map(value => value.conflictTotalMemberCount ?? 0));
    return { conflictGroupId, eligibleMemberCount, returnedMemberCount: 0,
      highImpact: members.some(value => value.highImpact), truncated: eligibleMemberCount > 0 };
  });
  let items: NativeSearchItem[] = [];
  let selectionTruncated = candidate.selection.truncated;
  let byteBounded = false;
  const result = (prospectiveItems = items): NativeSearchResult => ({
    operation: candidate.operation, selectionScope: candidate.selectionScope,
    rankingPolicyVersion: NATIVE_CONTENT_RANKING_VERSION, contentBoundsVersion: NATIVE_CONTENT_BOUNDS_VERSION,
    items: prospectiveItems,
    conflicts: descriptors.map(group => {
      const returnedMemberCount = prospectiveItems.filter(value => value.conflictGroupId === group.conflictGroupId).length;
      return { ...group, returnedMemberCount, truncated: returnedMemberCount < group.eligibleMemberCount };
    }),
    candidateBounded: candidate.candidateBounded, selectionTruncated, byteBounded,
  });
  // All descriptors and complete base are mandatory even when no item can be admitted.
  boundedEnvelope(result(), base);
  const selectedIds = new Set(candidate.selection.candidates.map(value => value.id));
  const processedGroups = new Set<string>();
  for (const ranked of candidate.rankedCandidates) {
    const groupId = ranked.conflictGroupId;
    let unit: readonly FusedCandidate[];
    let incomplete = false;
    if (groupId === null) {
      if (!selectedIds.has(ranked.id)) continue;
      unit = [candidate.selection.candidates.find(value => value.id === ranked.id)!];
    } else {
      if (processedGroups.has(groupId)) continue;
      processedGroups.add(groupId);
      // Preserve the fixed selector's member order; never split a group to fit.
      unit = candidate.selection.candidates.filter(value => value.conflictGroupId === groupId);
      incomplete = unit.length < descriptors.find(value => value.conflictGroupId === groupId)!.eligibleMemberCount;
      if (incomplete) selectionTruncated = true;
      if (unit.length === 0) break;
    }
    const prospectiveItems = [...items, ...unit.map(detachNativeSearchItem)];
    try { boundedEnvelope(result(prospectiveItems), base); }
    catch (error) {
      if ((error as { code?: string }).code !== "V2_CONTENT_RESULT_TOO_LARGE") throw error;
      byteBounded = true; break;
    }
    items = prospectiveItems;
    if (incomplete) break;
  }
  // Fresh descriptor copy/freezing and full-envelope recheck includes final booleans/counts.
  return boundedEnvelope(result(), base);
}
