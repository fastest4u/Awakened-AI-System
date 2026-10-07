import type { RetrievalItem } from "../retrieval/contracts.js";
import type { FusedCandidate } from "../retrieval/ranking.js";
import { selectionReason } from "../retrieval/selection-core.js";
import type { NativeContentItem, NativeSearchItem } from "./content-contracts.js";
export function detachNativeContentItem(item: RetrievalItem): NativeContentItem {
  return {
    id: item.id, kind: item.kind, projectId: item.projectId, workspaceId: item.workspaceId,
    branchScopeId: item.branchScopeId, branchRef: item.branchRef, sessionId: item.sessionId,
    visibility: item.visibility, status: item.status, confidence: item.confidence,
    verificationMethod: item.verificationMethod, validFrom: item.validFrom, validTo: item.validTo,
    knownFromEventPosition: item.knownFromEventPosition.toString(), sourceEventPosition: item.sourceEventPosition.toString(),
    textKind: item.kind === "canonical" ? "canonical-summary" : "projection-text", text: item.summary,
    conflictGroupId: item.conflictGroupId, supersedingItemId: item.supersedingItemId,
  };
}
export function detachNativeSearchItem(candidate: FusedCandidate): NativeSearchItem {
  if (candidate.item === undefined) throw Object.assign(new Error("INTEGRITY_FAILURE"), { code: "INTEGRITY_FAILURE" });
  return { ...detachNativeContentItem(candidate.item), channels: candidate.contributions.map(value => value.channel),
    selectionReason: selectionReason(candidate) };
}
