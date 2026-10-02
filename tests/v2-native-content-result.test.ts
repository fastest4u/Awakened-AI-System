import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievalItem } from "../src/orchestrator/retrieval/contracts.js";
import type { RerankedCandidate } from "../src/orchestrator/retrieval/ranking.js";
import type { NativeQueryCandidate } from "../src/orchestrator/verified-read/content-query.js";
import type { NativeContentResult, NativeSearchResult, VerifiedContentReadRequest } from "../src/orchestrator/verified-read/content-contracts.js";
import type { ReadSuccessBase, VerifiedReadBinding } from "../src/orchestrator/verified-read/contracts.js";
import { assertNativeContentMatchesRequest } from "../src/orchestrator/verified-read/content-protocol.js";
import { decodeVerifiedReadReceipt } from "../src/orchestrator/verified-read/protocol.js";
import { copyBoundedProtocolData, encodedProtocolBytes } from "../src/orchestrator/verified-read/wire-data.js";
import { readBootstrap, readReceipt, READ_UUID, READ_HASH } from "./support/v2-verified-read-fixture.js";

type SearchCandidate = Extract<NativeQueryCandidate, { operation: "search-projected-content" }>;
type Build = (candidate: NativeQueryCandidate, base: ReadSuccessBase) => NativeContentResult;
async function packer(): Promise<Build> {
  let api: { buildNativeContentResult?: Build } | undefined;
  try { api = await import("../src/orchestrator/verified-read/" + "content-result.js"); }
  catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof api?.buildNativeContentResult, "function", "missing detached whole-envelope packing export");
  return api!.buildNativeContentResult!;
}
const tooLarge = { code: "V2_CONTENT_RESULT_TOO_LARGE" };
const scope = { projectId: READ_UUID, workspaceId: READ_HASH, branchScopeId: null, branchRef: null,
  sessionId: null, visibility: "branch" as const };
function base(operation: NativeQueryCandidate["operation"] = "search-projected-content"): ReadSuccessBase {
  return { version: 2, ids: { requestId: "request", attemptId: "attempt", laneEpoch: "epoch" }, kind: "success",
    receipt: { ...decodeVerifiedReadReceipt(readReceipt()), operation, consistency: "project-strong", projectionEventPosition: "9223372036854775807",
      verification: "image-scope-position-and-active-admission" },
    fence: { controlGeneration: "0", releaseId: READ_UUID, capturedPosition: "0", capturedHash: READ_HASH, requiredPosition: "0" },
    closed: { image: true, reader: true, lock: true } };
}
function row(id: string, change: Partial<RetrievalItem> = {}): RetrievalItem {
  return { id, kind: "canonical", projectId: READ_UUID as RetrievalItem["projectId"],
    workspaceId: READ_HASH as RetrievalItem["workspaceId"], branchScopeId: null, branchRef: null, sessionId: null,
    visibility: "branch", status: "provisional", confidence: "medium", verificationMethod: "asserted",
    validFrom: null, validTo: null, knownFromEventPosition: 1n, sourceEventPosition: 2n,
    summary: "full projected summary", normalizedKey: "private-normalized-key", anchor: "private-anchor",
    freshness: "fresh", conflictGroupId: null, supersedingItemId: null, retrievalFeedbackScoreUnits: 0, ...change };
}
function ranked(item: RetrievalItem, count: number | null = null): RerankedCandidate {
  const score = { numerator: 1n, denominator: 1n };
  return { id: `${item.kind}:${item.id}`, item, conflictGroupId: item.conflictGroupId, highImpact: item.status === "conflicted",
    sourceKey: "private-source", entityKey: "private-entity", estimatedTokens: 1, feedbackScoreUnits: 0,
    conflictTotalMemberCount: count, conflictCursor: "private-cursor", contributions: [
      { channel: "lexical", rank: 2, weightUnits: 10000, score: { numerator: 1n, denominator: 2n } },
      { channel: "exact", rank: 1, weightUnits: 25000, score } ], fusionScore: score, bestRank: 1,
    features: { verificationState: 0, provenanceQuality: 0, temporalValidity: 0, queryIntent: 0,
      scopeDistance: 0, conflictState: 0, sourceFreshness: 0, retrievalFeedback: 0 }, featureScore: score, rerankScore: score };
}
function search(ordered: readonly RerankedCandidate[], selected = ordered): SearchCandidate {
  const groups = [...new Set(ordered.flatMap(value => value.conflictGroupId === null ? [] : [value.conflictGroupId]))];
  const conflicts = groups.map(conflictGroupId => {
    const members = ordered.filter(value => value.conflictGroupId === conflictGroupId);
    const eligibleMemberCount = Math.max(members.length, ...members.map(value => value.conflictTotalMemberCount ?? 0));
    return { conflictGroupId, eligibleMemberCount, returnedMemberCount: members.length,
      truncated: members.length < eligibleMemberCount, cursor: "private-cursor" };
  });
  return { operation: "search-projected-content", selectionScope: { ...scope }, rankedCandidates: ordered,
    selection: { candidates: selected, conflicts: conflicts.map(group => ({ conflictGroupId: group.conflictGroupId,
      totalMemberCount: group.eligibleMemberCount, selectedMemberCount: selected.filter(value => value.conflictGroupId === group.conflictGroupId).length,
      highImpact: ordered.some(value => value.conflictGroupId === group.conflictGroupId && value.highImpact),
      truncated: selected.filter(value => value.conflictGroupId === group.conflictGroupId).length < group.eligibleMemberCount, cursor: "private-cursor" })),
      usedTokens: selected.length, truncated: selected.length < ordered.length,
      droppedByReason: { diversity: 0, resultLimit: 0, tokenBudget: 0, conflictSuppressed: 0 } },
    conflictGroups: conflicts, candidateBounded: false };
}
function asSearch(result: NativeContentResult): NativeSearchResult {
  assert.equal(result.operation, "search-projected-content");
  return result as NativeSearchResult;
}
function relationships(content: NativeContentResult, envelope = base(content.operation)): void {
  const request: VerifiedContentReadRequest = content.operation === "search-projected-content"
    ? { operation: content.operation, consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters: { query: "needle", limit: 10 } }
    : { operation: content.operation, consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000, parameters: { id: content.item?.id ?? "absent" } };
  assertNativeContentMatchesRequest(content, request, readBootstrap().binding as VerifiedReadBinding, envelope.receipt);
  assert.ok(encodedProtocolBytes(copyBoundedProtocolData({ ...envelope, content }, 16384)) <= 16384);
}

// A repository-incomplete low-impact group or an unselected group must stop later units.
test("repository_incomplete_and_zero_member_barriers", async () => {
  const build = await packer();
  const first = ranked(row("first", { conflictGroupId: "g" }), 2);
  const later = ranked(row("later"));
  const laterGroup = ranked(row("later-group", { conflictGroupId: "later-g" }), 1);
  const candidate = search([first, later, laterGroup]);
  const result = asSearch(build(candidate, base()));
  assert.deepEqual(result.items.map(value => value.id), ["first"]);
  assert.equal(result.contentBoundsVersion, "v2-native-content-bounds-1");
  assert.equal(result.rankingPolicyVersion, "retrieval-ranking-v2-shadow-fixed-units");
  assert.equal(result.selectionTruncated, true); assert.equal(result.byteBounded, false);
  assert.deepEqual(result.conflicts, [
    { conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 1, highImpact: false, truncated: true },
    { conflictGroupId: "later-g", eligibleMemberCount: 1, returnedMemberCount: 0, highImpact: false, truncated: true } ]);
  relationships(result);
  const zeroMember = asSearch(build(search([first, later], [later]), base()));
  assert.equal(zeroMember.items.length, 0); assert.equal(zeroMember.conflicts[0].returnedMemberCount, 0);
  assert.equal(zeroMember.selectionTruncated, true); assert.equal(zeroMember.byteBounded, false);
  relationships(zeroMember);
});

// Byte measurement must include escaped strings, the full base and indivisible selected groups.
test("escaped_envelope_first_unit_barrier", async () => {
  const build = await packer();
  const padded = { ...base(), ids: { requestId: "\\".repeat(1800), attemptId: '"'.repeat(1800), laneEpoch: "é".repeat(900) },
    receipt: { ...base().receipt, scope: { ...base().receipt.scope, branchRef: "\\".repeat(1000) } } };
  const oversized = ranked(row("oversized", { summary: '"\\'.repeat(1024) }));
  const result = asSearch(build(search([oversized, ranked(row("later"))]), padded));
  assert.equal(result.items.length, 0); assert.equal(result.byteBounded, true); relationships(result, padded);
  const members = Array.from({ length: 4 }, (_, i) => ranked(row(`member-${i}`, { conflictGroupId: "whole", summary: "\\".repeat(2048) }), 4));
  const whole = asSearch(build(search([...members, ranked(row("later"))]), base()));
  assert.equal(whole.items.length, 0); assert.equal(whole.byteBounded, true);
  assert.equal(whole.conflicts[0].returnedMemberCount, 0); assert.equal(whole.conflicts[0].truncated, true); relationships(whole);
  // A fitting prefix is retained, then the entire failed group and later singleton are suppressed.
  const prefix = asSearch(build(search([ranked(row("prefix")), ...members, ranked(row("later"))]), base()));
  assert.deepEqual(prefix.items.map(value => value.id), ["prefix"]); assert.equal(prefix.byteBounded, true); relationships(prefix);
});

// Mandatory descriptors/base cannot be dropped to fit, and get cannot become absence or clipped success.
test("mandatory_metadata_and_get_are_all_or_nothing", async () => {
  const build = await packer();
  const descriptors = Array.from({ length: 12 }, (_, i) => ranked(row(`row-${i}`, { conflictGroupId: `${i}:` + "\\".repeat(1000) }), 2));
  assert.throws(() => build(search(descriptors, []), base()), tooLarge);
  const badBase = { ...base(), ids: { ...base().ids, requestId: "é".repeat(1025) } };
  assert.throws(() => build(search([]), badBase), tooLarge);
  const lookup: NativeQueryCandidate = { operation: "get-canonical-record", selectionScope: scope,
    lookup: { item: row("exact", { summary: "é".repeat(1025) }), eligibleConflictMemberCount: null } };
  assert.throws(() => build(lookup, base(lookup.operation)), tooLarge);
  const padded = { ...base(lookup.operation), ids: { requestId: "\\".repeat(2048), attemptId: "\\".repeat(2048), laneEpoch: "\\".repeat(2048) } };
  assert.throws(() => build({ ...lookup, lookup: { ...lookup.lookup, item: row("exact", { summary: "\\".repeat(2048) }) } }, padded), tooLarge);
});

// Dropping fields, upgrading status, rounding positions or retaining mutable input references is a bug.
test("detached_projection_text_status_and_positions", async () => {
  const build = await packer(); const fullUnclippedProjectedText = "line one\nquotes \" slash \\ ภาษาไทย";
  const projected = row("lexical", { kind: "lexical", status: "active", summary: fullUnclippedProjectedText,
    knownFromEventPosition: 9007199254740993n, sourceEventPosition: 9223372036854775807n });
  const canonical = row("old", { status: "superseded", supersedingItemId: "new", summary: "" });
  const candidate = search([ranked(projected), ranked(canonical)]);
  const before = structuredClone(candidate); const result = asSearch(build(candidate, base()));
  assert.equal(result.items[0].text, fullUnclippedProjectedText); assert.equal(result.items[0].textKind, "projection-text");
  assert.equal(result.items[0].status, "active"); assert.equal(result.items[0].knownFromEventPosition, "9007199254740993");
  assert.equal(result.items[0].sourceEventPosition, "9223372036854775807");
  assert.equal(result.items[1].text, ""); assert.equal(result.items[1].textKind, "canonical-summary");
  assert.equal(result.items[1].status, "superseded"); assert.equal(result.items[1].supersedingItemId, "new");
  assert.equal(result.items[1].validTo, null); assert.equal(result.items[1].sessionId, null);
  assert.deepEqual(result.items[0].channels, ["lexical", "exact"]); assert.equal(result.items[0].selectionReason, "exact");
  assert.deepEqual(Object.keys(result.items[0]).sort(), ["id", "kind", "projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility",
    "status", "confidence", "verificationMethod", "validFrom", "validTo", "knownFromEventPosition", "sourceEventPosition", "textKind", "text",
    "conflictGroupId", "supersedingItemId", "channels", "selectionReason"].sort());
  assert.deepEqual(candidate, before); assert.deepEqual(build(candidate, base()), result);
  assert.notEqual(result.selectionScope, candidate.selectionScope);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.selectionScope) && Object.isFrozen(result.items)
    && Object.isFrozen(result.conflicts) && Object.isFrozen(result.items[0]) && Object.isFrozen(result.items[0].channels));
  (projected as { summary: string }).summary = "mutated";
  (candidate.selectionScope as { visibility: string }).visibility = "project";
  assert.equal(result.items[0].text, fullUnclippedProjectedText); assert.equal(result.selectionScope.visibility, "branch"); relationships(result);
});

// Scalar overflow suppresses this singleton and later ones, rather than clipping UTF-8 text.
test("scalar_2048_2049_and_candidate_flags", async () => {
  const build = await packer();
  const candidate = search([ranked(row("fit", { summary: "é".repeat(1024) })), ranked(row("too-large", { summary: "é".repeat(1024) + "x" })), ranked(row("later"))]);
  const result = asSearch(build({ ...candidate, candidateBounded: true }, base()));
  assert.deepEqual(result.items.map(value => value.id), ["fit"]); assert.equal(result.items[0].text, "é".repeat(1024));
  assert.equal(result.byteBounded, true); assert.equal(result.candidateBounded, true); relationships(result);
});

// Unconsidered/ineligible groups must not disclose counts; complete groups retain selected order.
test("considered_groups_and_first_appearance_order", async () => {
  const build = await packer();
  const a = ranked(row("a", { conflictGroupId: "g" }), 2), b = ranked(row("b", { conflictGroupId: "g" }), 2);
  const middle = ranked(row("middle")), later = ranked(row("later"));
  const candidate = search([a, middle, b, later], [b, a, middle, later]);
  const result = asSearch(build({ ...candidate, conflictGroups: [...candidate.conflictGroups,
    { conflictGroupId: "ineligible", eligibleMemberCount: 99, returnedMemberCount: 0, truncated: true, cursor: null }] }, base()));
  assert.deepEqual(result.items.map(value => value.id), ["b", "a", "middle", "later"]);
  assert.deepEqual(result.conflicts, [{ conflictGroupId: "g", eligibleMemberCount: 2, returnedMemberCount: 2, highImpact: false, truncated: false }]);
  assert.equal(result.selectionTruncated, false); assert.equal(result.byteBounded, false); relationships(result);
});

// Get conflict metadata is exact and absence is an intentional null pair.
test("exact_get_conflict_and_absence", async () => {
  const build = await packer();
  for (const count of [1, 3]) {
    const result = build({ operation: "get-canonical-record", selectionScope: scope,
      lookup: { item: row("exact", { status: "conflicted", conflictGroupId: "g" }), eligibleConflictMemberCount: count } }, base("get-canonical-record"));
    assert.equal(result.operation, "get-canonical-record"); if (result.operation !== "get-canonical-record") assert.fail();
    assert.equal(result.item!.id, "exact"); assert.equal(result.item!.status, "conflicted");
    assert.deepEqual(result.conflict, { conflictGroupId: "g", eligibleMemberCount: count, returnedMemberCount: 1, truncated: count > 1 });
    assert.ok(Object.isFrozen(result.item) && Object.isFrozen(result.conflict)); relationships(result);
  }
  const absent = build({ operation: "get-canonical-record", selectionScope: scope,
    lookup: { item: null, eligibleConflictMemberCount: null } }, base("get-canonical-record"));
  assert.deepEqual(absent, { operation: "get-canonical-record", selectionScope: scope, item: null, conflict: null }); relationships(absent);
});

// The shared descriptor copier is the packer's aggregate capacity gate, including both container kinds.
test("aggregate_container_128_129_boundary", () => {
  const containers = (count: number) => [Array.from({ length: 63 }, () => ({})), Array.from({ length: count - 66 }, () => ({}))];
  assert.doesNotThrow(() => copyBoundedProtocolData(containers(128), 16384));
  assert.throws(() => copyBoundedProtocolData(containers(129), 16384), { code: "FRESH_START_INPUT_INVALID" });
});
