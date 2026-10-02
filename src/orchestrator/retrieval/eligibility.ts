import type { ProjectBinding } from "../projections/contracts.js";
import type {
  RetrievalEligibilityContext,
  RetrievalItem,
} from "./contracts.js";

const UNREADABLE_STATUSES = new Set<RetrievalItem["status"]>([
  "retracted",
  "expired",
  "erased-evidence",
]);
const VISIBILITY_LEVEL: Readonly<Record<RetrievalItem["visibility"], number>> = Object.freeze({
  project: 0,
  workspace: 1,
  branch: 2,
  session: 3,
});

export function workspaceVisible(
  item: RetrievalItem,
  binding: ProjectBinding,
  _request: RetrievalEligibilityContext,
): boolean {
  return item.workspaceId === binding.workspaceId;
}

export function branchVisible(
  item: RetrievalItem,
  binding: ProjectBinding,
  _request: RetrievalEligibilityContext,
): boolean {
  return item.branchScopeId === binding.branchScopeId
    && item.branchRef === binding.branchRef;
}

export function sessionVisible(
  item: RetrievalItem,
  request: RetrievalEligibilityContext,
): boolean {
  const requested = request.visibility
    ?? (request.sessionId === undefined ? "branch" : "session");
  if (VISIBILITY_LEVEL[item.visibility] > VISIBILITY_LEVEL[requested]) return false;
  if (item.visibility !== "session") return true;
  return request.sessionId !== undefined && item.sessionId === request.sessionId;
}

export function statusVisible(item: RetrievalItem): boolean {
  return !UNREADABLE_STATUSES.has(item.status);
}

export function temporalVisible(
  item: RetrievalItem,
  request: RetrievalEligibilityContext,
): boolean {
  if (
    request.knownAt !== undefined
    && (
      item.knownFromEventPosition > request.knownAt
      || item.sourceEventPosition > request.knownAt
    )
  ) return false;
  if (request.validAt === undefined || item.validFrom === null) return true;
  return item.validFrom <= request.validAt
    && (item.validTo === null || request.validAt < item.validTo);
}

export function freshnessVisible(item: RetrievalItem): boolean {
  return item.freshness === "fresh";
}

export function isEligible(
  item: RetrievalItem,
  request: RetrievalEligibilityContext,
  binding: ProjectBinding,
): boolean {
  return item.projectId === binding.projectId
    && workspaceVisible(item, binding, request)
    && branchVisible(item, binding, request)
    && sessionVisible(item, request)
    && statusVisible(item)
    && temporalVisible(item, request)
    && freshnessVisible(item);
}
