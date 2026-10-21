import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import type { BranchScopeId, ProjectId, StoreId, VaultId, WorkspaceId } from "../src/orchestrator/identity/contracts.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type { ProjectionManifestV1 } from "../src/orchestrator/projections/manifest-codec.js";
import { validateInternalRetrievalRequest, type InternalRetrievalRequest, type InternalRetrievalResultItem,
  type RetrievalCandidateCollection, type RetrievalItem, type ValidatedInternalRetrievalRequest,
  type RetrievalChannel } from "../src/orchestrator/retrieval/contracts.js";
import type { RedactedDropCounts } from "../src/orchestrator/retrieval/explain.js";
import { estimateCandidateTokens, fuseCandidates, rerankCandidates, selectRankedCandidates,
  type RankingCandidate, type FusedCandidate, type RankedSelection } from "../src/orchestrator/retrieval/ranking.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000511" as BranchScopeId;
const SESSION_ID = "00000000-0000-4000-8000-000000000512";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000513";
const ITEM_ID = "00000000-0000-4000-8000-000000000514";
const FUTURE_ITEM_ID = "00000000-0000-4000-8000-000000000515";
const CONFLICT_ALTERNATIVE_ID = "00000000-0000-4000-8000-000000000524";
const CONFLICT_HIDDEN_ID = "00000000-0000-4000-8000-000000000525";
const CONFLICT_GROUP_ID = "00000000-0000-4000-8000-000000000526";
const NOW = "2026-08-24T00:00:00.000Z";

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: "3".repeat(64) as VaultId,
  storeId: "4".repeat(64) as StoreId,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/task-5",
  sessionId: null,
});


function manifest(): ProjectionManifestV1 {
  return Object.freeze({
    schemaVersion: 1,
    projectId: BINDING.projectId,
    vaultId: BINDING.vaultId,
    storeId: BINDING.storeId,
    workspaceId: BINDING.workspaceId,
    branchScopeId: BINDING.branchScopeId,
    branchRef: BINDING.branchRef,
    sessionId: null,
    generation: 1,
    terminalEventPosition: "20",
    terminalEventHash: "a".repeat(64),
    databaseFile: "projections-1-1.sqlite",
    databaseSha256: "b".repeat(64),
    coreChecksums: Object.freeze({
      sessionTree: "c".repeat(64),
      canonicalItems: "d".repeat(64),
      tasksFollowups: "e".repeat(64),
      artifactsFiles: "f".repeat(64),
      entityGraph: "1".repeat(64),
      lexicalChunks: "2".repeat(64),
      retrievalFeedback: "3".repeat(64),
    }),
    createdAt: "2026-08-24T00:00:00.000Z",
  });
}


interface SelectionCore {
  filterCandidates(collection: RetrievalCandidateCollection, request: ValidatedInternalRetrievalRequest):
    { readonly collection: RetrievalCandidateCollection; readonly defensiveDrops: RedactedDropCounts };
  rankingChannels(collection: RetrievalCandidateCollection): readonly (readonly RankingCandidate[])[];
  selectionReason(candidate: FusedCandidate): RetrievalChannel;
  resultItems(selection: RankedSelection): readonly InternalRetrievalResultItem[];
}
function item(id: string, overrides: Partial<RetrievalItem> = {}): RetrievalItem {
  return Object.freeze({
    id, kind: "canonical", projectId: PROJECT_ID, workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID, branchRef: BINDING.branchRef,
    sessionId: null, visibility: "project", status: "verified", confidence: "high",
    verificationMethod: "committed-event", validFrom: "2026-01-01T00:00:00.000Z", validTo: null,
    knownFromEventPosition: 1n, sourceEventPosition: 7n, summary: "fixture",
    normalizedKey: "entity", anchor: null, freshness: "fresh",
    conflictGroupId: null, supersedingItemId: null, retrievalFeedbackScoreUnits: 0, ...overrides,
  });
}
function collection(items: readonly RetrievalItem[], rank = false): RetrievalCandidateCollection {
  return {
    channels: [{ channel: "exact", candidates: items.map((value, i) => ({
      candidateId: `exact:canonical:${value.id}`, channel: "exact", rank: rank ? 1 : i + 1, item: value,
    })) }], eligibleItemCount: items.length, droppedItemCount: 0, truncated: false, conflictGroups: [],
  };
}
function inspectRuntimeClosure(): void {
  const visited = new Set<string>();
  const inspect = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    assert.doesNotMatch(path.replaceAll("\\", "/"),
      /\/(?:stable-directory|builder|coordinator|integrity|manifest|reader-lease|v2-reader-lease|service|candidates|v2-candidates|vector-cache)\.ts$|\/workers\/|\/migration\/|\/providers\//u);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const dependency = (specifier: string): void => {
      assert.ok(specifier === "node:crypto" || specifier === "node:util", `unexpected runtime dependency ${specifier} in ${path}`);
    };
    const follow = (specifier: string): void => {
      if (specifier.startsWith(".")) inspect(resolve(dirname(path), specifier.replace(/\.js$/u, ".ts")));
      else dependency(specifier);
    };
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
      } else if (statement.isTypeOnly) continue;
      follow(statement.moduleSpecifier.text);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        assert.ok(argument && ts.isStringLiteral(argument), `uninspectable dependency in ${path}`);
        follow(argument.text);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        assert.notEqual(node.expression.text, "DatabaseSync", "pure code must not open a database");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  for (const name of ["database-core", "selection-core"]) {
    inspect(join(process.cwd(), "src/orchestrator/retrieval", `${name}.ts`));
  }
  assert.ok(visited.size >= 5);
}
it("selection_core_preserves_complete_ranking_conversion", async () => {
  const modulePath = "../src/orchestrator/retrieval/selection-core.js";
  const core = await import(modulePath).catch(() => ({})) as Partial<SelectionCore>;
  assert.equal(typeof core.rankingChannels, "function");
  assert.equal(typeof core.filterCandidates, "function");
  assert.equal(typeof core.resultItems, "function");
  assert.equal(typeof core.selectionReason, "function");
  const input: InternalRetrievalRequest = {
    binding: BINDING, query: "entity", limit: 10, tokenBudget: 1200, candidateLimit: 64,
    consistency: { requiredEventPosition: 7n, deadlineMs: 100 }, knownAt: 20n,
  };
  const request = validateInternalRetrievalRequest(input);
  const anchor = item("A", {
    status: "conflicted", conflictGroupId: CONFLICT_GROUP_ID, retrievalFeedbackScoreUnits: 1200,
  });
  const denied = item("denied", { projectId: OTHER_PROJECT_ID, status: "conflicted",
    conflictGroupId: CONFLICT_GROUP_ID });
  const raw = { ...collection([anchor, denied]), eligibleItemCount: 4, conflictGroups: [{
    conflictGroupId: CONFLICT_GROUP_ID, eligibleMemberCount: 4, returnedMemberCount: 2,
    truncated: true, cursor: "opaque",
  }] };
  const filtered = core.filterCandidates!(raw, request);
  assert.equal(filtered.defensiveDrops.total, 1);
  assert.equal(filtered.defensiveDrops.byReason.scopeDenied, 1);
  assert.equal(filtered.collection.eligibleItemCount, 3);
  assert.equal(filtered.collection.droppedItemCount, 1);
  assert.deepEqual(filtered.collection.conflictGroups, [{
    conflictGroupId: CONFLICT_GROUP_ID, eligibleMemberCount: 3, returnedMemberCount: 1,
    truncated: true, cursor: "opaque",
  }]);
  const converted = core.rankingChannels!(filtered.collection)[0]![0]!;
  const legacyEstimatedTokens = estimateCandidateTokens({ id: "canonical:A", item: anchor });
  assert.equal(converted.highImpact, true);
  assert.equal(converted.sourceKey, "7");
  assert.equal(converted.entityKey, "entity");
  assert.equal(converted.feedbackScoreUnits, 1200);
  assert.equal(converted.conflictTotalMemberCount, 3);
  assert.equal(converted.conflictCursor, "opaque");
  assert.equal(converted.estimatedTokens, legacyEstimatedTokens);
  assert.equal(converted.estimatedTokens, 5); // A + entity + fixture + three newlines = 17 bytes.

  const fused = fuseCandidates(core.rankingChannels!(filtered.collection));
  const selected = selectRankedCandidates(rerankCandidates(fused, request), request);
  const pureSelectedItems = core.resultItems!(selected);
  let captured: readonly FusedCandidate[] = [];
  let closed = 0;
  const service = new InternalRetrievalService({
    projections: { async pin() { return { manifest: manifest(), databasePath: "unused",
      close() { closed++; } }; } },
    candidates: { collectEligible() { return raw; } },
    ranker: { select(candidates) { captured = candidates; return candidates; } },
  });
  const legacy = await service.retrieve(input);
  const legacySelectedItems = legacy.items;
  assert.deepEqual(pureSelectedItems, legacySelectedItems);
  assert.deepEqual(captured, fused);
  assert.deepEqual(pureSelectedItems.map(value => [value.id, value.channels, value.selectionReason]),
    [["A", ["exact"], "exact"]]);
  assert.equal(legacy.conflicts[0]!.totalMemberCount, 3);
  assert.equal(legacy.conflicts[0]!.cursor, "opaque");
  assert.equal(closed, 1);
  assert.equal(core.selectionReason!(fused[0]!), "exact");

  // Equal fusion scores isolate deterministic ID order, source/entity diversity,
  // and feedback reranking from channel rank differences.
  const ties = collection([
    item("C"), item("B"), item("A"), item("D", { sourceEventPosition: 8n }),
    item("E", { sourceEventPosition: 9n, normalizedKey: "other" }),
  ], true);
  const tiedFused = fuseCandidates(core.rankingChannels!(ties));
  assert.deepEqual(tiedFused.map(value => value.id),
    ["canonical:A", "canonical:B", "canonical:C", "canonical:D", "canonical:E"]);
  const diverse = selectRankedCandidates(tiedFused, request);
  assert.deepEqual(core.resultItems!(diverse).map(value => value.id), ["A", "B", "E"]);
  assert.equal(diverse.droppedByReason.diversity, 2);
  const feedback = collection([
    item("A", { normalizedKey: "same", retrievalFeedbackScoreUnits: -1200 }),
    item("B", { normalizedKey: "same", retrievalFeedbackScoreUnits: 1200 }),
  ], true);
  const feedbackRanked = rerankCandidates(fuseCandidates(core.rankingChannels!(feedback)), request);
  assert.deepEqual(feedbackRanked.map(value => value.id), ["canonical:B", "canonical:A"]);
  inspectRuntimeClosure();
});
