import type { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV2 } from "../projections/manifest-codec.js";
import {
  InternalRetrievalError, validateInternalRetrievalRequest,
  type RetrievalConflictGroup, type RetrievalEligibilityContext,
} from "../retrieval/contracts.js";
import {
  collectEligibleFromProjectionDatabase, getCanonicalFromProjectionDatabase,
  type CanonicalLookup,
} from "../retrieval/database-core.js";
import { filterCandidates, rankingChannels } from "../retrieval/selection-core.js";
import {
  DEFAULT_RANKING_POLICY, fuseCandidates, rerankCandidates, selectRankedCandidates,
  type RankedSelection, type RerankedCandidate,
} from "../retrieval/ranking.js";
import type { NativeSelectionScope, VerifiedContentReadRequest } from "./content-contracts.js";
import type { VerifiedReadBinding, VerifiedReadReceipt } from "./contracts.js";
import { decodeVerifiedReadReceipt, decodeVerifiedReadRequest } from "./protocol.js";

export type NativeQueryContext = Readonly<{
  request: VerifiedContentReadRequest;
  binding: VerifiedReadBinding;
  receipt: VerifiedReadReceipt;
  remainingMs: number;
}>;
export type NativeQueryCandidate =
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
  if (request.operation === "verify-published-view") return fail("INTEGRITY_FAILURE");
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
    const internal = validateInternalRetrievalRequest({ ...eligibility, query: request.parameters.query,
      limit: request.parameters.limit ?? 5, candidateLimit: 64, tokenBudget: 2048,
      includeGlobal: false, vector: { enabled: false }, explain: false,
      consistency: { requiredEventPosition: BigInt(receipt.requiredEventPosition), deadlineMs: context.remainingMs },
    });
    const collected = collectEligibleFromProjectionDatabase(database, manifest, internal);
    checkDeadline();
    const filtered = filterCandidates(collected, internal).collection;
    for (const channel of filtered.channels) for (const candidate of channel.candidates) {
      const item = candidate.item;
      if (item.knownFromEventPosition > item.sourceEventPosition
        || item.sourceEventPosition > BigInt(manifest.terminalEventPosition)) return fail("INTEGRITY_FAILURE");
    }
    const fused = fuseCandidates(rankingChannels(filtered), DEFAULT_RANKING_POLICY);
    checkDeadline();
    const rankedCandidates = rerankCandidates(fused, internal, DEFAULT_RANKING_POLICY);
    const selection = selectRankedCandidates(rankedCandidates, { limit: internal.limit, tokenBudget: internal.tokenBudget }, DEFAULT_RANKING_POLICY);
    checkDeadline();
    return Object.freeze({ operation: request.operation, selectionScope, rankedCandidates, selection,
      conflictGroups: filtered.conflictGroups, candidateBounded: filtered.truncated });
  } catch (error) {
    if (error instanceof InternalRetrievalError && error.code === "PROJECTION_SCOPE_MISMATCH") {
      return fail("PROJECTION_SCOPE_MISMATCH");
    }
    if (error instanceof Error && (error.message === "WORKER_TIMEOUT" || error.message === "PROJECTION_SCOPE_MISMATCH")) throw error;
    return fail("INTEGRITY_FAILURE");
  }
}
