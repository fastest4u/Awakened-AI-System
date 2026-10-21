import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectionManifestV2 } from "../src/orchestrator/projections/manifest-codec.js";
import { InternalRetrievalError, validateInternalRetrievalRequest, type InternalRetrievalRequest, type RetrievalCandidateCollection, type RetrievalItem } from "../src/orchestrator/retrieval/contracts.js";
import { isEligible } from "../src/orchestrator/retrieval/eligibility.js";
import { getCanonicalFromProjectionDatabase } from "../src/orchestrator/retrieval/database-core.js";
import { filterCandidates, rankingChannels } from "../src/orchestrator/retrieval/selection-core.js";
import { DEFAULT_RANKING_POLICY, fuseCandidates } from "../src/orchestrator/retrieval/ranking.js";
import type { VerifiedContentReadRequest } from "../src/orchestrator/verified-read/content-contracts.js";
import type { NativeQueryCandidate, NativeQueryContext } from "../src/orchestrator/verified-read/content-query.js";
import { command } from "./fixtures/fresh-start-admission-child.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { makeNativeContentFixture, nativeGetRequest, nativeSearchRequest, NATIVE_BRANCH, NATIVE_BRANCH_REF, NATIVE_SESSION,
  type NativeContentFixture } from "./support/v2-native-content-fixture.js";

// RED used test-local structural types; GREEN also verifies the exported contracts.
type Context = NativeQueryContext;
type Candidate = NativeQueryCandidate;
async function queryFunction(): Promise<(db: DatabaseSync, manifest: ProjectionManifestV2, context: Context) => Candidate> {
  const modulePath = "../src/orchestrator/verified-read/content-query.js";
  let fn: unknown;
  try { fn = (await import(modulePath)).queryNativeContent; }
  catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof fn, "function", "native query/lookup implementation is missing");
  return fn as (db: DatabaseSync, manifest: ProjectionManifestV2, context: Context) => Candidate;
}
function context(fixture: NativeContentFixture, manifest: ProjectionManifestV2, request: VerifiedContentReadRequest): Context {
  const fence = fixture.admission.capture(request);
  fixture.admission.revalidate(fence, manifest);
  return { request, binding: fixture.binding, remainingMs: 5000, receipt: {
    operation: request.operation, consistency: request.consistency, scope: { ...fixture.binding.projectionBinding,
      sessionId: request.consistency === "session-strong" ? fixture.binding.session?.sessionId ?? null : null },
    releaseId: fixture.release.releaseId, controlGeneration: fixture.binding.controlGeneration,
    requiredEventPosition: fence.requiredPosition, projectionGeneration: manifest.generation,
    projectionEventPosition: manifest.terminalEventPosition, projectionEventHash: manifest.terminalEventHash,
    imageSha256: manifest.databaseSha256, verification: "image-scope-position-and-active-admission" } };
}
function search(candidate: Candidate) { assert.equal(candidate.operation, "search-projected-content"); if (candidate.operation !== "search-projected-content") throw new Error("search expected"); return candidate; }
function get(candidate: Candidate) { assert.equal(candidate.operation, "get-canonical-record"); if (candidate.operation !== "get-canonical-record") throw new Error("get expected"); return candidate; }
function appendCanonical(fixture: NativeContentFixture, options: Record<string, JsonValue> = {}) {
  const id = randomUUID();
  const value = command();
  const payload = { sourceVersion: 2, binding: fixture.binding.projectionBinding as unknown as JsonValue, itemId: id,
    normalizedKey: `native:${id}`, status: "verified", confidence: "high", verificationMethod: "committed-event",
    validFrom: FRESH_NOW, validTo: null, summary: "native bounds", contentHash: "a".repeat(64),
    conflictGroupId: null, supersedingItemId: null, ...options };
  if (["retracted", "expired", "erased-evidence"].includes(String(payload.status))) {
    fixture.appendSynthetic({ ...value, commandId: randomUUID(), correlationId: randomUUID(),
      idempotencyKey: `query-seed/${id}`, streamId: `query-seed/${id}`, events: [{ ...value.events[0]!,
        eventType: "MemorySourceRecorded", eventSchemaVersion: 2, payload: { ...payload, status: "verified" } }] });
  }
  const result = fixture.appendSynthetic({ ...value, commandId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `query/${id}`, streamId: `query/${id}`, events: [{ ...value.events[0]!, eventType: "MemorySourceRecorded", eventSchemaVersion: 2,
      payload }] });
  return { id, ...result };
}

// Break caught: returning metadata-only/empty content, dropping genuine channels or full conversion.
it("native_schema2_channels_and_fixed_selection", async () => {
  const fixture = await makeNativeContentFixture(undefined, { branchScopeId: NATIVE_BRANCH, branchRef: NATIVE_BRANCH_REF,
    session: { sessionId: NATIVE_SESSION, minimumEventPosition: "0" } });
  try {
    const corpus = await fixture.appendCorpus();
    const published = await fixture.publish();
    const image = fixture.captureImage();
    try {
      assert.equal(image.manifest.schemaVersion, 2);
      assert.equal(image.manifest.terminalEventPosition, "12");
      assert.equal(image.manifest.databaseSha256, published.databaseSha256);
      assert.equal(published.terminalEventHash, fixture.writer.prepare("SELECT event_hash FROM events WHERE global_position = 12").get()!.event_hash);
      const beforeBytes = readFileSync(join(fixture.binding.projectionDirectory.canonicalPath, published.databaseFile));
      assert.equal(createHash("sha256").update(beforeBytes).digest("hex"), published.databaseSha256);
      const query = await queryFunction();
      const run = (text: string) => search(query(image.database, image.manifest, context(fixture, image.manifest,
        nativeSearchRequest({ parameters: { query: text, limit: 10 } }))));
      for (const [text, id, channel] of [
        ["native:exact", corpus.ids.canonical, "exact"], ["lexicalneedle", corpus.ids.lexical, "lexical"],
        ["src/native/artifact.ts", corpus.ids.artifact, "symbol-path"], [corpus.ids.checkpoint, corpus.ids.checkpoint, "session-checkpoint"],
        ["native open follow-up", corpus.ids.openFollowUp, "open-follow-up"], ["native blocked follow-up", corpus.ids.blockedFollowUp, "open-follow-up"],
      ] as const) {
        const candidate = run(text).rankedCandidates.find(c => c.item?.id === id);
        assert.ok(candidate, `${channel} returns its actual projected item`);
        assert.ok(candidate.contributions.some(c => c.channel === channel));
        assert.equal(candidate.item!.sourceEventPosition.toString(), corpus.sourcePositions[
          id === corpus.ids.canonical ? "canonical" : id === corpus.ids.lexical ? "lexical" : id === corpus.ids.artifact ? "artifact"
            : id === corpus.ids.checkpoint ? "checkpoint" : id === corpus.ids.openFollowUp ? "openFollowUp" : "blockedFollowUp"]);
        const event = fixture.writer.prepare("SELECT event_hash FROM events WHERE global_position = $position").get({ $position: candidate.item!.sourceEventPosition });
        assert.match(event!.event_hash as string, /^[0-9a-f]{64}$/u);
      }
      const all = run("native");
      assert.ok(all.rankedCandidates.every(c => !c.contributions.some(x => x.channel === "alias")));
      const canonical = all.rankedCandidates.find(c => c.item?.id === corpus.ids.canonical)!;
      assert.equal(canonical.feedbackScoreUnits, 10000);
      assert.equal(canonical.sourceKey, corpus.sourcePositions.canonical);
      assert.equal(canonical.entityKey, "native:exact");
      assert.ok(canonical.estimatedTokens! > 0);
      assert.equal(DEFAULT_RANKING_POLICY.version, "retrieval-ranking-v2-shadow-fixed-units");
      assert.deepEqual(run("native").rankedCandidates, all.rankedCandidates);
      assert.ok(all.selection.droppedByReason.diversity > 0);
      for (const source of new Set(all.selection.candidates.map(c => c.sourceKey))) {
        assert.ok(all.selection.candidates.filter(c => c.sourceKey === source).length <= DEFAULT_RANKING_POLICY.diversity.maxPerSource);
      }
      for (const [name, status] of [["canonical", "verified"], ["keyCollision", "candidate"], ["conflictMemberA", "conflicted"],
        ["conflictMemberB", "provisional"], ["superseded", "superseded"]] as const) {
        assert.equal(all.rankedCandidates.find(c => c.item?.id === corpus.ids[name])?.item?.status, status);
      }
      const conflict = run("native:conflict-a");
      assert.deepEqual(new Set(conflict.rankedCandidates.map(c => c.item?.id)), new Set([corpus.ids.conflictMemberA, corpus.ids.conflictMemberB]));
      assert.equal(conflict.conflictGroups[0]?.eligibleMemberCount, 2);
      assert.ok(conflict.rankedCandidates.every(c => c.conflictTotalMemberCount === 2));
      const zero = search(query(image.database, image.manifest, context(fixture, image.manifest,
        nativeSearchRequest({ parameters: { query: "native:conflict-a", limit: 1 } }))));
      assert.equal(zero.rankedCandidates.length, 2);
      assert.equal(zero.selection.conflicts[0]?.totalMemberCount, 2);
      assert.ok(zero.selection.conflicts[0]!.selectedMemberCount < 2);
      assert.equal(run('" OR *').rankedCandidates.length, 0);
      assert.equal(fixture.writer.prepare("SELECT MAX(global_position) AS position FROM events").get()!.position, 12n);
      assert.deepEqual(readFileSync(join(fixture.binding.projectionDirectory.canonicalPath, published.databaseFile)), beforeBytes);
      assert.equal(JSON.parse(readFileSync(join(fixture.binding.projectionDirectory.canonicalPath, "projection-manifest.json"), "utf8")).generation, 2);
      console.log(`native fixture schema=${published.schemaVersion} sha256=${published.databaseSha256} terminal=${published.terminalEventPosition}/${published.terminalEventHash} sourcePositions=${JSON.stringify(corpus.sourcePositions)}`);
    } finally { image.close(); }
  } finally { fixture.cleanup(); }
});

// Break caught: key/case/successor substitution, lost status or denied-record disclosure.
it("canonical_get_id_key_case_and_supersession", async () => {
  const fixture = await makeNativeContentFixture();
  try {
    const corpus = await fixture.appendCorpus();
    const denied = appendCanonical(fixture, { status: "retracted" });
    await fixture.publish(); const image = fixture.captureImage();
    try {
      const query = await queryFunction();
      const run = (id: string) => get(query(image.database, image.manifest, context(fixture, image.manifest, nativeGetRequest(id))));
      assert.equal(run(corpus.ids.canonical).lookup.item?.id, corpus.ids.canonical);
      assert.equal(run(corpus.ids.keyCollision).lookup.item?.normalizedKey, corpus.ids.canonical);
      assert.equal(run(corpus.ids.canonical.toUpperCase()).lookup.item, null);
      assert.equal(run(` ${corpus.ids.canonical}`).lookup.item, null);
      // The exported lookup requires scope/time only, never a fabricated search query.
      assert.equal(getCanonicalFromProjectionDatabase(image.database, image.manifest,
        { binding: fixture.binding.projectionBinding, id: corpus.ids.canonical }).item?.id, corpus.ids.canonical);
      assert.equal(run(corpus.ids.superseded).lookup.item?.status, "superseded");
      assert.equal(run(corpus.ids.superseded).lookup.item?.supersedingItemId, corpus.ids.successor);
      assert.equal(run(corpus.ids.superseded).lookup.item?.summary, "native superseded projected summary");
      assert.equal(run(corpus.ids.conflictMemberA).lookup.eligibleConflictMemberCount, 2);
      assert.deepEqual(run("missing").lookup, run(denied.id).lookup);
      assert.deepEqual(run("missing").lookup, run(corpus.ids.artifact).lookup);
      const otherId = image.database.prepare("SELECT item_id FROM canonical_items WHERE session_id IS NOT NULL").get()!.item_id as string;
      assert.deepEqual(run("missing").lookup, run(otherId).lookup);
      assert.deepEqual(run("missing").lookup, { item: null, eligibleConflictMemberCount: null });
    } finally { image.close(); }
  } finally { fixture.cleanup(); }
});

// Break caught: using project-strong receipt's null session as selection authority.
it("project_strong_keeps_trusted_selection_session", async () => {
  const fixture = await makeNativeContentFixture(undefined, { session: { sessionId: NATIVE_SESSION, minimumEventPosition: "0" } });
  try {
    const corpus = await fixture.appendCorpus(); await fixture.publish(); const image = fixture.captureImage();
    try {
      const query = await queryFunction(); const ctx = context(fixture, image.manifest, nativeSearchRequest());
      assert.equal(ctx.receipt.scope.sessionId, null);
      const selected = search(query(image.database, image.manifest, ctx));
      assert.equal(selected.selectionScope.sessionId, corpus.sessionIds.trusted);
      assert.equal(selected.selectionScope.visibility, "session");
      assert.ok(selected.rankedCandidates.some(c => c.item?.id === corpus.ids.checkpoint));
      assert.ok(selected.rankedCandidates.every(c => c.item?.sessionId !== corpus.sessionIds.other));
      const narrow = search(query(image.database, image.manifest, context(fixture, image.manifest,
        nativeSearchRequest({ parameters: { query: "native", visibility: "project" } }))));
      assert.ok(narrow.rankedCandidates.every(c => c.item?.visibility === "project"));
      assert.equal(narrow.selectionScope.sessionId, corpus.sessionIds.trusted);
      assert.throws(() => query(image.database, image.manifest, { ...ctx, remainingMs: 0 }), { code: "WORKER_TIMEOUT" });
      assert.throws(() => query(image.database, image.manifest, { ...ctx,
        receipt: { ...ctx.receipt, projectionEventHash: "9".repeat(64) } }), { code: "INTEGRITY_FAILURE" });
    } finally { image.close(); }
  } finally { fixture.cleanup(); }
});

// Break caught: SQL/defensive scope or temporal mismatch, sibling-authority inheritance, swallowed corruption.
it("sql_and_defensive_eligibility_agree", async () => {
  const fixture = await makeNativeContentFixture();
  try {
    const corpus = await fixture.appendCorpus();
    const bad = ["retracted", "expired", "erased-evidence"].map(status => appendCanonical(fixture, { status }));
    const temporal = appendCanonical(fixture, { validTo: "2026-10-02T00:00:00.000Z" });
    await fixture.publish(); const image = fixture.captureImage();
    try {
      const query = await queryFunction();
      for (const item of bad) assert.equal(get(query(image.database, image.manifest, context(fixture, image.manifest, nativeGetRequest(item.id)))).lookup.item, null);
      for (const [filters, want] of [
        [{ validAt: "2026-10-02T00:00:00.000Z" }, false], [{ validAt: FRESH_NOW }, true],
        [{ validAt: "2026-01-01T00:00:00.000Z" }, false], [{ knownAt: (BigInt(temporal.position) - 1n).toString() }, false],
        [{ knownAt: temporal.position }, true],
      ] as const) assert.equal(get(query(image.database, image.manifest, context(fixture, image.manifest, nativeGetRequest(temporal.id, filters)))).lookup.item !== null, want);
      const request = validateInternalRetrievalRequest({ binding: fixture.binding.projectionBinding, query: "native", limit: 10,
        tokenBudget: 2048, candidateLimit: 64, consistency: { requiredEventPosition: BigInt(image.manifest.terminalEventPosition), deadlineMs: 5000 } });
      const item = get(query(image.database, image.manifest, context(fixture, image.manifest, nativeGetRequest(corpus.ids.conflictMemberA)))).lookup.item!;
      for (const mutation of [{ projectId: "9".repeat(64) }, { workspaceId: "9".repeat(64) }, { branchScopeId: NATIVE_BRANCH },
        { branchRef: NATIVE_BRANCH_REF }, { sessionId: NATIVE_SESSION, visibility: "session" },
        { status: "retracted" }, { freshness: "corrupt", sourceEventPosition: BigInt(image.manifest.terminalEventPosition) + 1n }]) {
        const foreign = { ...item, ...mutation } as RetrievalItem;
        assert.equal(isEligible(foreign, request, request.binding), false);
        const collection: RetrievalCandidateCollection = { channels: [{ channel: "exact", candidates: [{ candidateId: "good", channel: "exact", rank: 1, item }] },
          { channel: "conflict-closure", candidates: [{ candidateId: "bad", channel: "conflict-closure", rank: 1, item: { ...foreign, id: "foreign-sibling" } }] }],
          eligibleItemCount: 2, droppedItemCount: 0, truncated: false,
          conflictGroups: [{ conflictGroupId: corpus.conflictGroupId, eligibleMemberCount: 2, returnedMemberCount: 2, truncated: false, cursor: null }] };
        const filtered = filterCandidates(collection, request).collection;
        assert.deepEqual(fuseCandidates(rankingChannels(filtered)).map(c => c.item?.id), [item.id]);
        assert.equal(filtered.conflictGroups[0]?.eligibleMemberCount, 1);
      }
      const clone = new DatabaseSync(":memory:");
      try {
        clone.deserialize((image.database as DatabaseSync & { serialize(): Uint8Array }).serialize());
        clone.exec("PRAGMA ignore_check_constraints = ON");
        clone.prepare("UPDATE canonical_items SET project_id = ? WHERE item_id = ?").run("9".repeat(64), corpus.ids.canonical);
        assert.deepEqual(get(query(clone, image.manifest, context(fixture, image.manifest, nativeGetRequest(corpus.ids.canonical)))).lookup,
          { item: null, eligibleConflictMemberCount: null });
        clone.prepare("UPDATE canonical_items SET project_id = ? WHERE item_id = ?").run(fixture.binding.projectionBinding.projectId, corpus.ids.canonical);
        clone.prepare("UPDATE canonical_items SET source_event_position = ? WHERE item_id = ?").run(BigInt(image.manifest.terminalEventPosition) + 1n, corpus.ids.canonical);
        assert.equal(get(query(clone, image.manifest, context(fixture, image.manifest, nativeGetRequest(corpus.ids.canonical)))).lookup.item, null);
        clone.prepare("UPDATE canonical_items SET source_event_position = 1, known_from_event_position = 2 WHERE item_id = ?").run(corpus.ids.canonical);
        assert.throws(() => query(clone, image.manifest, context(fixture, image.manifest, nativeGetRequest(corpus.ids.canonical))), { code: "INTEGRITY_FAILURE" });
        clone.prepare("UPDATE canonical_items SET known_from_event_position = 1, confidence = 'invalid' WHERE item_id = ?").run(corpus.ids.canonical);
        assert.throws(() => query(clone, image.manifest, context(fixture, image.manifest, nativeGetRequest(corpus.ids.canonical))), { code: "INTEGRITY_FAILURE" });
        clone.exec("DROP TABLE canonical_items");
        assert.throws(() => query(clone, image.manifest, context(fixture, image.manifest, nativeGetRequest("missing"))), { code: "INTEGRITY_FAILURE" });
      } finally { clone.close(); }
      assert.throws(() => query(image.database, { ...image.manifest, workspaceId: "9".repeat(64) as ProjectionManifestV2["workspaceId"] },
        context(fixture, image.manifest, nativeGetRequest(corpus.ids.canonical))), { code: "PROJECTION_SCOPE_MISMATCH" });
    } finally { image.close(); }
  } finally { fixture.cleanup(); }
});

// Break caught: unbounded repository/ranking input or token budget, stale empty image reuse.
it("empty_genesis_later_publish_and_private_candidate_token_bounds", async () => {
  const fixture = await makeNativeContentFixture();
  try {
    const empty = fixture.captureImage();
    try {
      const query = await queryFunction();
      assert.equal(search(query(empty.database, empty.manifest, context(fixture, empty.manifest, nativeSearchRequest()))).rankedCandidates.length, 0);
      assert.equal(get(query(empty.database, empty.manifest, context(fixture, empty.manifest, nativeGetRequest("missing")))).lookup.item, null);
    } finally { empty.close(); }
    for (let index = 0; index < 70; index++) appendCanonical(fixture, { summary: `native bounds ${index} ${"x".repeat(900)}` });
    await fixture.publish(); const image = fixture.captureImage();
    try {
      const query = await queryFunction(); const all = search(query(image.database, image.manifest, context(fixture, image.manifest, nativeSearchRequest())));
      assert.equal(new Set(all.rankedCandidates.map(c => c.id)).size, 64);
      assert.equal(all.candidateBounded, true);
      assert.ok(all.selection.candidates.length > 0);
      assert.ok(all.selection.candidates.length < 10);
      assert.ok(all.selection.usedTokens <= 2048);
      assert.ok(all.selection.droppedByReason.tokenBudget > 0);
      assert.ok(all.rankedCandidates.every(c => c.item!.knownFromEventPosition <= c.item!.sourceEventPosition
        && c.item!.sourceEventPosition <= 70n));
    } finally { image.close(); }
  } finally { fixture.cleanup(); }
});
