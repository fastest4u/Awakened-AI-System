import type { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV2 } from "../projections/manifest-codec.js";
import {
  InternalRetrievalError,
  type RetrievalConflictGroup, type RetrievalEligibilityContext,
} from "../retrieval/contracts.js";
import {
  getCanonicalFromProjectionDatabase,
  type CanonicalLookup,
} from "../retrieval/database-core.js";
import type { RankedSelection, RerankedCandidate } from "../retrieval/ranking.js";
import type { NativeSelectionScope, VerifiedContentReadRequest } from "./content-contracts.js";
import type { VerifiedReadBinding, VerifiedReadReceipt } from "./contracts.js";
import { decodeVerifiedReadReceipt, decodeVerifiedReadRequest } from "./protocol.js";

import { collectNativeRankedQuery } from "./content-ranking.js";
import { queryNativeWorkflow, type NativeWorkflowCandidate } from "./workflow-query.js";

export type NativeQueryContext = Readonly<{
  request: VerifiedContentReadRequest;
  binding: VerifiedReadBinding;
  receipt: VerifiedReadReceipt;
  remainingMs: number;
}>;
export type NativeQueryCandidate = NativeWorkflowCandidate
  | Readonly<{ operation: "search-projected-content"; selectionScope: NativeSelectionScope;
      rankedCandidates: readonly RerankedCandidate[]; selection: RankedSelection;
      conflictGroups: readonly RetrievalConflictGroup[]; candidateBounded: boolean }>
  | Readonly<{ operation: "get-canonical-record"; selectionScope: NativeSelectionScope; lookup: CanonicalLookup }>;

function fail(code: "INTEGRITY_FAILURE" | "PROJECTION_SCOPE_MISMATCH" | "WORKER_TIMEOUT"): never {
  throw Object.assign(new Error(code), { code });
}

/** Pure query/selection on the caller's already captured, verified schema-2 image.
 * Candidates are private and remain unaccepted until the read owner revalidates/closes. */
export function queryNativeContent(
  database: DatabaseSync,
  manifest: ProjectionManifestV2,
  context: NativeQueryContext,
): NativeQueryCandidate {
  const started = performance.now();
  // Caller errors retain the existing input family, outside image-error reduction.
  const request = decodeVerifiedReadRequest(context.request, context.binding.session);
  switch (request.operation) {
    case "verify-published-view": return fail("INTEGRITY_FAILURE");
    case "list-canonical-records":
    case "recent-canonical-records":
    case "build-context-pack":
    case "follow-up-radar":
    case "search-projected-content":
    case "get-canonical-record": break;
    default: { const exhaustive: never = request; return exhaustive; }
  }
  const deadline = started + context.remainingMs;
  const checkDeadline = () => { if (performance.now() >= deadline) fail("WORKER_TIMEOUT"); };
  try {
    if (!Number.isSafeInteger(context.remainingMs) || context.remainingMs < 0
      || context.remainingMs > request.budgetMs || manifest.schemaVersion !== 2) return fail("INTEGRITY_FAILURE");
    checkDeadline();
    const binding = context.binding.projectionBinding;
    const receipt = decodeVerifiedReadReceipt(context.receipt);
    for (const key of ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef"] as const) {
      if (manifest[key] !== binding[key] || receipt.scope[key] !== binding[key]) return fail("PROJECTION_SCOPE_MISMATCH");
    }
    if (manifest.sessionId !== null || binding.sessionId !== null
      || receipt.scope.sessionId !== (request.consistency === "session-strong" ? context.binding.session?.sessionId ?? null : null)) {
      return fail("PROJECTION_SCOPE_MISMATCH");
    }
    if (receipt.operation !== request.operation || receipt.consistency !== request.consistency
      || receipt.releaseId !== context.binding.expectedRelease.releaseId
      || receipt.controlGeneration !== context.binding.controlGeneration
      || receipt.projectionGeneration !== manifest.generation
      || receipt.projectionEventPosition !== manifest.terminalEventPosition
      || receipt.projectionEventHash !== manifest.terminalEventHash
      || receipt.imageSha256 !== manifest.databaseSha256
      || BigInt(receipt.requiredEventPosition) > BigInt(manifest.terminalEventPosition)
      || BigInt(receipt.requiredEventPosition) < BigInt(request.minimumEventPosition)
      || BigInt(receipt.requiredEventPosition) < BigInt(context.binding.session?.minimumEventPosition ?? "0")) {
      return fail("INTEGRITY_FAILURE");
    }
    // Receipt session is a consistency scope, not selection authority.
    const sessionId = context.binding.session?.sessionId;
    const filters = request.parameters;
    const visibility = filters.visibility ?? (sessionId === undefined ? "branch" : "session");
    const eligibility: RetrievalEligibilityContext = Object.freeze({ binding, visibility,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(filters.validAt === undefined ? {} : { validAt: filters.validAt }),
      ...(filters.knownAt === undefined ? {} : { knownAt: BigInt(filters.knownAt) }),
    });
    const selectionScope: NativeSelectionScope = Object.freeze({ projectId: binding.projectId,
      workspaceId: binding.workspaceId, branchScopeId: binding.branchScopeId, branchRef: binding.branchRef,
      sessionId: sessionId ?? null, visibility });
    if (request.operation === "get-canonical-record") {
      const lookup = getCanonicalFromProjectionDatabase(database, manifest, { ...eligibility, id: request.parameters.id });
      checkDeadline();
      return Object.freeze({ operation: request.operation, selectionScope, lookup });
    }
    if (request.operation !== "search-projected-content") {
      const result = queryNativeWorkflow(database, manifest, { request, binding: context.binding, receipt,
        eligibility, selectionScope, remainingMs: Math.max(0, deadline - performance.now()) });
      checkDeadline();
      return result;
    }
    const ranked = collectNativeRankedQuery(database, manifest, { eligibility, query: request.parameters.query,
      limit: request.parameters.limit ?? 5, requiredEventPosition: receipt.requiredEventPosition,
      remainingMs: Math.max(0, deadline - performance.now()) });
    checkDeadline();
    return Object.freeze({ operation: request.operation, selectionScope, ...ranked });
  } catch (error) {
    if (error instanceof InternalRetrievalError && error.code === "PROJECTION_SCOPE_MISMATCH") {
      return fail("PROJECTION_SCOPE_MISMATCH");
    }
    if (error instanceof Error && (error.message === "WORKER_TIMEOUT" || error.message === "PROJECTION_SCOPE_MISMATCH" || (Object.hasOwn(error, "code") && (error as Error & { code?: string }).code === "V2_CONTENT_CURSOR_STALE"))) throw error;
    return fail("INTEGRITY_FAILURE");
  }
}
