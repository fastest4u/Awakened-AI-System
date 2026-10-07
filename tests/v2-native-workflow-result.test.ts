import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievalItem } from "../src/orchestrator/retrieval/contracts.js";
import type { RerankedCandidate } from "../src/orchestrator/retrieval/ranking.js";
import type { NativeWorkflowCandidate } from "../src/orchestrator/verified-read/workflow-query.js";
import type { NativeWorkflowResult, NativeContextResult } from "../src/orchestrator/verified-read/workflow-contracts.js";
import type { ReadSuccessBase } from "../src/orchestrator/verified-read/contracts.js";
import { decodeVerifiedReadReceipt } from "../src/orchestrator/verified-read/protocol.js";
import { decodeWorkflowCursor } from "../src/orchestrator/verified-read/workflow-cursor.js";
import { readReceipt, READ_UUID, READ_HASH } from "./support/v2-verified-read-fixture.js";
import { buildNativeContentResult } from "../src/orchestrator/verified-read/content-result.js";
type Build = (candidate: NativeWorkflowCandidate, base: ReadSuccessBase) => NativeWorkflowResult;
async function packer(): Promise<Build> {
  const api = await import("../src/orchestrator/verified-read/" + "workflow-result.js").catch(e => {
    if (e.code !== "ERR_MODULE_NOT_FOUND") throw e; return {};
  }) as { buildNativeWorkflowResult?: Build };
  assert.equal(typeof api.buildNativeWorkflowResult, "function", "missing workflow packing behavior");
  return api.buildNativeWorkflowResult!;
}
const scope = { projectId: READ_UUID, workspaceId: READ_HASH, branchScopeId: null, branchRef: null, sessionId: READ_UUID, visibility: "session" as const };
function base(operation: NativeWorkflowCandidate["operation"]): ReadSuccessBase {
  return { version: 3, ids: { requestId: "request", attemptId: "attempt", laneEpoch: "epoch" }, kind: "success",
    receipt: { ...decodeVerifiedReadReceipt(readReceipt()), operation, consistency: "project-strong", projectionEventPosition: "9223372036854775807", verification: "image-scope-position-and-active-admission" },
    fence: { controlGeneration: "0", releaseId: READ_UUID, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" }, closed: { image: true, reader: true, lock: true } };
}
function row(id: string, change: Partial<RetrievalItem> = {}): RetrievalItem {
  return { id, kind: "canonical", projectId: READ_UUID as RetrievalItem["projectId"], workspaceId: READ_HASH as RetrievalItem["workspaceId"], branchScopeId: null, branchRef: null, sessionId: null,
    visibility: "branch", status: "provisional", confidence: "medium", verificationMethod: "asserted", validFrom: null, validTo: null,
    knownFromEventPosition: 1n, sourceEventPosition: 2n, summary: "summary", normalizedKey: "genuine key", anchor: "genuine anchor", freshness: "fresh", conflictGroupId: null, supersedingItemId: null, retrievalFeedbackScoreUnits: 0, ...change };
}
function follow(id: string, change: Partial<RetrievalItem> = {}): RetrievalItem { return row(id, { kind: "follow-up", status: "open", visibility: "session", sessionId: READ_UUID as RetrievalItem["sessionId"], ...change }); }
function ranked(item: RetrievalItem, count: number | null = null): RerankedCandidate {
  const score = { numerator: 1n, denominator: 1n };
  return { id: `${item.kind}:${item.id}`, item, conflictGroupId: item.conflictGroupId, highImpact: item.status === "conflicted", sourceKey: null, entityKey: null, estimatedTokens: 1, feedbackScoreUnits: 0, conflictTotalMemberCount: count, conflictCursor: null,
    contributions: [{ channel: "lexical", rank: 1, weightUnits: 10000, score }], fusionScore: score, bestRank: 1,
    features: { verificationState: 0, provenanceQuality: 0, temporalValidity: 0, queryIntent: 0, scopeDistance: 0, conflictState: 0, sourceFreshness: 0, retrievalFeedback: 0 }, featureScore: score, rerankScore: score };
}
function context(ordered: readonly RerankedCandidate[], followUps: readonly RetrievalItem[] = [], selected = ordered, more = false): Extract<NativeWorkflowCandidate, { operation: "build-context-pack" }> {
  const ids = [...new Set(ordered.flatMap(v => v.conflictGroupId === null ? [] : [v.conflictGroupId]))];
  return { operation: "build-context-pack", selectionScope: scope, followUps: { items: followUps, hasMore: more }, ranked: { rankedCandidates: ordered, candidateBounded: false,
    conflictGroups: ids.map(conflictGroupId => ({ conflictGroupId, eligibleMemberCount: Math.max(...ordered.filter(v => v.conflictGroupId === conflictGroupId).map(v => v.conflictTotalMemberCount ?? 1)), returnedMemberCount: 0, truncated: true, cursor: null })),
    selection: { candidates: selected, conflicts: [], usedTokens: 0, truncated: selected.length < ordered.length, droppedByReason: { diversity: 0, resultLimit: 0, tokenBudget: 0, conflictSuppressed: 0 } } } };
}
function asContext(result: NativeWorkflowResult): NativeContextResult { assert.equal(result.operation, "build-context-pack"); return result as NativeContextResult; }
function oracle(result: NativeContextResult, source: readonly RetrievalItem[]): number {
  const items = [...result.items, ...result.followUps];
  const texts = items.map(wire => source.find(v => v.kind === wire.kind && v.id === wire.id)!);
  return texts.reduce((n, v) => n + Math.max(1, Math.ceil(Buffer.byteLength(`${v.id}\n${v.normalizedKey}\n${v.summary}\n${v.anchor ?? ""}`) / 4)), 0)
    + Math.ceil(Buffer.byteLength(JSON.stringify({ ...result, items: result.items.map(v => ({ ...v, text: "" })), followUps: result.followUps.map(v => ({ ...v, text: "" })) })) / 4);
}
const tooLarge = { code: "V2_CONTENT_RESULT_TOO_LARGE" };
const binding = { version: 1 as const, operation: "list-canonical-records" as const, selectionHash: READ_HASH, schemaVersion: 2 as const, projectionGeneration: 1, projectionEventPosition: "100", imageSha256: READ_HASH };
function page(items: readonly RetrievalItem[], hasMore = false): NativeWorkflowCandidate { return { operation: "list-canonical-records", selectionScope: scope, cursorBinding: binding, page: { items: items.map(item => ({ item, eligibleConflictMemberCount: null })), hasMore } }; }
// A cursor after a withheld/lookahead row would lose an eligible record.
test("page_cursor_follows_last_returned_whole_item", async () => {
  const build = await packer();
  const rows = Array.from({ length: 5 }, (_, i) => row(`row-${i}`, { summary: "\\".repeat(2048) }));
  const first = build(page(rows), base("list-canonical-records"));
  assert.equal(first.operation, "list-canonical-records"); if (first.operation !== "list-canonical-records") assert.fail();
  assert.ok(first.items.length > 0 && first.items.length < rows.length); assert.equal(first.byteBounded, true); assert.equal(first.hasMore, true);
  assert.equal(decodeWorkflowCursor(first.nextCursor!).lastId, first.items.at(-1)!.item.id);
  const second = build(page(rows.slice(first.items.length)), base("list-canonical-records"));
  if (second.operation !== "list-canonical-records") assert.fail();
  assert.equal(second.nextCursor, null); assert.deepEqual([...first.items, ...second.items].map(v => v.item.id), rows.map(v => v.id));
  for (const operation of ["recent-canonical-records", "follow-up-radar"] as const) {
    const entries = [row("a", { sourceEventPosition: 20n }), row("b", { sourceEventPosition: 10n })];
    const candidate: NativeWorkflowCandidate = operation === "follow-up-radar"
      ? { operation, selectionScope: scope, cursorBinding: { ...binding, operation }, page: { items: entries.map(v => follow(v.id, { sourceEventPosition: v.sourceEventPosition })), hasMore: true } }
      : { operation, selectionScope: scope, cursorBinding: { ...binding, operation }, page: { items: entries.map(item => ({ item, eligibleConflictMemberCount: null })), hasMore: true } };
    const result = build(candidate, base(operation));
    if (result.operation === "build-context-pack") assert.fail();
    assert.equal(result.hasMore, true); assert.equal(decodeWorkflowCursor(result.nextCursor!).lastId, "b"); assert.equal(decodeWorkflowCursor(result.nextCursor!).lastEventPosition, "10");
    assert.deepEqual(buildNativeContentResult(candidate, base(operation)), result);
  }
  const conflicted = page([row("g", { status: "conflicted", conflictGroupId: "group" })]);
  if (conflicted.operation === "list-canonical-records") {
    const result = build({ ...conflicted, page: { items: [{ item: conflicted.page.items[0].item, eligibleConflictMemberCount: 3 }], hasMore: false } }, base(conflicted.operation));
    if (result.operation !== "list-canonical-records") assert.fail();
    assert.deepEqual(result.items[0].conflict, { conflictGroupId: "group", eligibleMemberCount: 3, returnedMemberCount: 1, truncated: true });
  }
  assert.deepEqual(buildNativeContentResult(page([]), base("list-canonical-records")), build(page([]), base("list-canonical-records")));
});
// Escaped JSON and mandatory metadata can overwhelm capacity even with legal individual scalars.
test("workflow_complete_envelope_and_metadata_allowance", async () => {
  const build = await packer(); const b = base("list-canonical-records");
  const padded = { ...b, ids: { requestId: "\\".repeat(2048), attemptId: "\\".repeat(2048), laneEpoch: "\\".repeat(2048) } };
  assert.throws(() => build(page([row("first", { summary: "\\".repeat(2048) })], true), padded), tooLarge);
  const contextBase = base("build-context-pack");
  const byteBase = { ...contextBase, ids: { requestId: "\\".repeat(1800), attemptId: "\\".repeat(1800), laneEpoch: "\\".repeat(1800) } };
  const unit = ranked(row("escaped", { summary: "\\".repeat(2048) }));
  const withheld = asContext(build(context([unit]), byteBase));
  assert.equal(withheld.items.length, 0); assert.equal(withheld.byteBounded, true); assert.equal(withheld.selectionTruncated, false);
  assert.deepEqual(buildNativeContentResult(context([]), contextBase), build(context([]), contextBase));
  const groups = Array.from({ length: 8 }, (_, i) => ranked(row(`g${i}`, { conflictGroupId: `${i}:` + "é".repeat(700) }), 2));
  assert.throws(() => build(context(groups, [], []), base("build-context-pack")), tooLarge);
  const rows = Array.from({ length: 10 }, (_, i) => follow(`f${i}`, { summary: 'é"\\'.repeat(300), sourceEventPosition: BigInt(20 - i) }));
  const result = asContext(build(context([], rows), base("build-context-pack")));
  assert.ok(result.followUps.length > 0 && result.followUps.length < 10); assert.ok(oracle(result, rows) <= 2048);
  assert.equal(result.selectionTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify({ ...base("build-context-pack"), content: result })) <= 16384);
});
// Count and token budgets are shared; duplicate ranked follow-ups do not charge twice or hide omissions.
test("context_zero_ranked_overflow_and_duplicate_budget", async () => {
  const build = await packer(); const rows = Array.from({ length: 10 }, (_, i) => follow(`f${i}`, { sourceEventPosition: BigInt(20 - i) }));
  const emptyRanked = asContext(build(context([], rows, [], true), base("build-context-pack")));
  assert.ok(emptyRanked.items.length + emptyRanked.followUps.length <= 10); assert.equal(emptyRanked.candidateBounded, true); assert.ok(oracle(emptyRanked, rows) <= 2048);
  const result = asContext(build(context([ranked(rows[0])], rows, undefined, true), base("build-context-pack")));
  assert.equal(new Set([...result.items, ...result.followUps].map(v => JSON.stringify([v.kind, v.id]))).size, result.items.length + result.followUps.length);
  assert.ok(result.items.length + result.followUps.length <= 10); assert.ok(oracle(result, rows) <= 2048); assert.equal(result.followUps.some(v => v.id === rows[0].id), false);
  assert.ok(result.candidateBounded || result.selectionTruncated || result.byteBounded);
  const sameId = row("f0"); const distinct = asContext(build(context([ranked(sameId)], [rows[0]]), base("build-context-pack")));
  assert.equal(distinct.items.length + distinct.followUps.length, 2);
});
// Truncating a group or skipping a zero-member warning must not admit later ranked units.
test("context_conflict_unit_counts_and_warning_barrier", async () => {
  const build = await packer(); const a = ranked(row("a", { conflictGroupId: "g" }), 3), b = ranked(row("b", { conflictGroupId: "g" }), 3), later = ranked(row("later"));
  const result = asContext(build(context([a, later, b]), base("build-context-pack")));
  assert.deepEqual(result.items.map(v => v.id), ["a", "b"]); assert.deepEqual(result.conflicts, [{ conflictGroupId: "g", eligibleMemberCount: 3, returnedMemberCount: 2, highImpact: false, truncated: true }]); assert.equal(result.selectionTruncated, true);
  const zero = asContext(build(context([a, later], [], [later]), base("build-context-pack"))); assert.equal(zero.items.length, 0); assert.equal(zero.conflicts[0].returnedMemberCount, 0);
  const expensive = [ranked(row("x", { status: "conflicted", conflictGroupId: "whole", summary: "é".repeat(1024), normalizedKey: "é".repeat(1024), anchor: "é".repeat(1024) }), 2), ranked(row("y", { status: "conflicted", conflictGroupId: "whole", summary: "é".repeat(1024), normalizedKey: "é".repeat(1024), anchor: "é".repeat(1024) }), 2)];
  assert.ok(expensive.reduce((sum, v) => sum + Math.ceil(Buffer.byteLength(`${v.item!.id}\n${v.item!.normalizedKey}\n${v.item!.summary}\n${v.item!.anchor}`) / 4), 0) > 2048);
  const whole = asContext(build(context([...expensive, later]), base("build-context-pack"))); assert.equal(whole.items.length, 0); assert.equal(whole.conflicts[0].returnedMemberCount, 0); assert.equal(whole.selectionTruncated, true); assert.equal(whole.conflicts[0].highImpact, true); assert.equal(whole.conflicts[0].truncated, true); assert.ok(oracle(whole, expensive.map(v => v.item!)) <= 2048);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.items) && Object.isFrozen(result.conflicts[0]));
});
