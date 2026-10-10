import type { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV2, ProjectionManifestV3 } from "../projections/manifest-codec.js";
import { validateInternalRetrievalRequest, type RetrievalConflictGroup, type RetrievalEligibilityContext } from "../retrieval/contracts.js";
import { collectEligibleFromProjectionDatabase } from "../retrieval/database-core.js";
import { filterCandidates, rankingChannels } from "../retrieval/selection-core.js";
import { DEFAULT_RANKING_POLICY, fuseCandidates, rerankCandidates, selectRankedCandidates, type RankedSelection, type RerankedCandidate } from "../retrieval/ranking.js";
export type NativeRankedQuery = Readonly<{ rankedCandidates: readonly RerankedCandidate[]; selection: RankedSelection;
  conflictGroups: readonly RetrievalConflictGroup[]; candidateBounded: boolean }>;
/** The fixed native search pipeline; context shares the same collection and token policy. */
export function collectNativeRankedQuery(database: DatabaseSync, manifest: ProjectionManifestV2 | ProjectionManifestV3,
  input: { eligibility: RetrievalEligibilityContext; query: string; limit: number; requiredEventPosition: string; remainingMs: number }): NativeRankedQuery {
  const deadline = performance.now() + input.remainingMs;
  const fail = (code: "INTEGRITY_FAILURE" | "WORKER_TIMEOUT"): never => { throw Object.assign(new Error(code), {code}); };
  const checkDeadline = () => { if(performance.now() >= deadline) fail("WORKER_TIMEOUT"); };
  if (manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3) return fail("INTEGRITY_FAILURE");
  checkDeadline();
  const internal = validateInternalRetrievalRequest({ ...input.eligibility, query: input.query,
      limit: input.limit, candidateLimit: 64, tokenBudget: 2048,
      includeGlobal: false, vector: { enabled: false }, explain: false,
      consistency: { requiredEventPosition: BigInt(input.requiredEventPosition), deadlineMs: Math.floor(input.remainingMs) },
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
    return Object.freeze({ rankedCandidates, selection,
      conflictGroups: filtered.conflictGroups, candidateBounded: filtered.truncated });
}
