# V2 Native Read Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver private deterministic V2 list, recent, context-pack and follow-up-radar reads from one verified schema-2 image, with honest bounds and owned completion.

**Architecture:** Extend the existing owned verified-read child and stable query/result/decoder entry points. Reuse the database-only eligibility/row decoders, extract the existing fixed ranking pipeline, and keep cursor binding, workflow assembly and packing in focused verified-read helpers. The supervisor releases detached results only after the original admission, deadline, actual exit/drain and positive ownership cleanup checks.

**Tech Stack:** Existing TypeScript ESM, Node.js >=24.16.0, node:sqlite, node:test and measured esbuild artifacts; no dependency additions. The inherited fixed native runner has qualified Windows Job containment; its acceptance is Windows-scoped.

**Spec:** [Approved native read workflows](../specs/2026-10-07-v2-native-read-workflows-design.md). Human replied `อนุมัติ` on 2026-10-07 to the specification at c6e653f0da311e990aa7ff7e70a5b51d4c4f15eb, blob d9e00c6d2c612b6b27b1d6f87ffb8e4b3406e8f2, unchanged at planning HEAD d9dbd8dcf1cd90158d7f54848feed4fc7a9084e9.

Status: **human approved this written implementation plan on 2026-10-07** with `อนุมัติ`, for commit 17ccf9b5f14f6eb827fca036078def7d425cb4ee. Written-spec approval is complete. Execute all six tasks using the preserved **Subagent-Driven** method; no repeat stage or method approval is needed. Product baseline b1646c1c8d9d04345af6d456be4f5724c7f068d2. Prior private metadata/search/get/retained-evidence acceptance is not reopened.

## Global Constraints

- Fresh empty V2; V1 remains a separate read-only archive after eventual cutover. This increment uses owned synthetic stores; no V1 import/fallback or actual user content.
- Preserve `memory_v2Status`-only registration, `productionReady:false`, closed promotion, recovery `FRESH_START_CONTENT_UNVERIFIED`, `requireFullEvidence=true` and `host-capability-unverified`.
- Add exact operations `list-canonical-records`, `recent-canonical-records`, `build-context-pack`, `follow-up-radar`; retain verify/search/get semantics. Read/bootstrap/reply/cancel wire **3** rejects other versions; cleanup wire and persistent ownership-record schema remain **1**; projection schema remains **2**.
- Authority is captured VerifiedReadBinding.projectionBinding plus its trusted bound session. Caller IDs, roles, SQL, paths, rankers, callbacks, providers, credentials and process options are invalid. Project-strong receipt does not erase the bound selection session.
- Existing filters: visibility, validAt, knownAt. Default visibility is bound-session visibility, otherwise branch. Sessionless radar is verified empty; sessionless explicit session visibility remains input-invalid. Narrower visibility excludes session-owned follow-ups.
- Limit defaults to **5**, integer **1–10**. Context has fixed combined **10** items/follow-ups, fixed candidate collection **64**, one **2,048 estimated** token allowance and no caller budget/ranking override.
- Query nonempty/control-free, <=**1,024 UTF-8 bytes before and after NFKC** normalization; retain existing exact-get <=512-byte ID semantics. Cursor encoding <=**2,048 bytes**, strict data selector, bound to operation/order, selection, release/control and current image.
- List order `item_id COLLATE BINARY ASC`; recent `source_event_position DESC, item_id COLLATE BINARY ASC`; radar `source_event_position DESC, follow_up_id COLLATE BINARY ASC`. Recent is latest projected state ordered by source position, not wall-clock activity/history.
- Fixed parameterized keyset SQL applies eligibility before at most limit-plus-one rows; no OFFSET, caller SQL/scan caps, wildcard substitute, full-table materialization or cross-request lease. Radar/context follow-ups are query-free and trusted-session open/blocked only.
- Preserve candidate/provisional/verified/conflicted/superseded states and references; exclude retracted/expired/erased-evidence. Corruption/query/schema failures are typed failures, not empty data. No successor substitution or fabricated body/category/Markdown path.
- Descriptor-first bounds remain depth **8**, containers **128**, fields/record **32**, general array **64**, scalar **2,048 UTF-8 bytes**. Reject getters/exotic prototypes/symbols/sparse arrays/extra keys/malformed Unicode. Workflow arrays obey narrower operation caps.
- COMPLETE request AND bootstrap <=**8,192** UTF-8 bytes; COMPLETE terminal envelope <=**16,384**, including escaped JSON, receipt/fence/closure, cursor/conflict metadata. Mandatory metadata refusal never drops authority fields or increases caps.
- Original response deadline includes queue/startup/image/query/context/packing/exit: defaults **2,000 ms session-strong / 5,000 ms project-strong**, explicit integer **0–30,000 ms**. Cleanup **2,000 ms**, cancellation grace <=**100 ms**, child messages <=**8**; inherited queue/ownership safeguards remain.
- Stale cursor emits private `V2_CONTENT_CURSOR_STALE` with no content; malformed cursor is input-invalid. Preserve empty/input/stale/lag/integrity/cleanup-uncertain distinctions and original failure on cleanup uncertainty.
- No schema migration, publisher changes, public adapter, key custody, host attachment/capture, deployment/merge/push/release dispatch or activation. Complete F2 public/governed/privacy/host, F3 recovery/release and F4 cutover/live evidence remain separate requirements.

## Review Focus

1. Same bound session with a project-strong receipt whose session is null: selection still uses the trusted session — Tasks 3/5, `context_project_receipt_keeps_selection_session`.
2. A valid same-scope cursor is forged to a later key, or page size changes: traversal can narrow/change page size without gaining scope; changed semantic binding/image refuses — Task 2, `cursor_narrows_only_and_limit_is_not_authority`.
3. More than ten open follow-ups with no ranked query matches, or duplicates consume a shared budget: supplementation is query-free, deduplicated and truthfully bounded — Tasks 3/4, `context_zero_ranked_overflow_and_duplicate_budget`.
4. Escaped text/cursor/large conflict metadata fits item bounds but exceeds complete envelope or metadata token allowance: whole units or typed refusal, progress/counts remain honest — Task 4, `workflow_complete_envelope_and_metadata_allowance`.
5. Synchronous work blocks inside the actual new SQL or packer after image validation: parent expiry/abort still settles, and uncertain exit/removal withholds all content — Task 5, `compiled_workflow_query_and_packing_deadline`.

---

## Execution and verification discipline

Use the already attached managed checkout **C:/Users/Server/.codex/worktrees/v2-prod-readiness/Awakened-AI-System**. It currently has detached HEAD; after plan review create `codex/v2-native-read-workflows` from its then-current committed documentation HEAD if that branch is absent. If it already exists, verify its lineage/worktree ownership before using it. Preserve primary checkout and old fresh-start worktree's seven uncommitted projection-observer owners; do not reset/stash/fast-forward them.

Read both artifacts before execution. Root serializes the shared project-memory lifecycle. Dispatch one fresh implementer per task, then independent specification and quality reviews before the next task; no concurrent edits to shared unions/decoders or dist/dist-test. Whole-increment review follows Task 6. A reviewer uses current source-qualified focused evidence without independently rebuilding shared outputs.

Preflight stable Node >=24.16.0 and qualified SQLite/runtime capabilities with `node scripts/check-runtime.js --json`; a compiler success alone is not runtime qualification. Use the existing locked dependency installation policy if this checkout needs dependencies; never change package-lock or add packages for these tasks.

For each RED/GREEN, first run `npm run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec` with that task's exact dist-test filenames listed below. Compilation must succeed for RED. An absent new export is reached by dynamic import plus a test-local typed lookup/assertion, so missing modules/exports produce the named behavior assertion, not a compiler failure. GREEN is exit 0/no fail/cancel; record skips and platform branches separately. Recompile/rerun after edits invalidate the evidence. Commit exact owned paths, never `git add .`.

Tasks 1–4 may temporarily reject not-yet-implemented workflow branches with INTEGRITY_FAILURE, never dispatch them as search/get. This is an internal staging safeguard; all such temporary refusals are removed by Tasks 3/4, and complete wire3 deployment is Task 5. No partial task is claimed as a working end-to-end workflow.

### Exact task-local commands

Run `npm run test:build` first; then the owning task's command below, in serial. Task 5 also runs `npm run build` before its emitted-entry tests. New workflow cases in existing child/supervisor files belong to Task 5.

Task 1:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-workflow-contracts.test.js dist-test/tests/v2-native-content-contracts.test.js dist-test/tests/v2-internal-verified-read-contracts.test.js
```

Task 2:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-workflow-database.test.js dist-test/tests/v2-native-workflow-cursor.test.js dist-test/tests/v2-native-workflow-contracts.test.js dist-test/tests/retrieval-database-core.test.js
```

Task 3:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-workflow-query.test.js dist-test/tests/v2-native-content-query.test.js dist-test/tests/retrieval-selection-core.test.js dist-test/tests/retrieval-eligibility.test.js dist-test/tests/retrieval-ranking.test.js
```

Task 4:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-workflow-result.test.js dist-test/tests/v2-native-content-result.test.js
```

Task 5:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-workflow-entry.test.js dist-test/tests/v2-internal-verified-read-contracts.test.js dist-test/tests/v2-internal-verified-read-admission.test.js dist-test/tests/v2-internal-verified-read-child.test.js dist-test/tests/v2-internal-verified-read-cleanup.test.js dist-test/tests/v2-internal-verified-read-ownership.test.js dist-test/tests/v2-internal-verified-read-supervisor.test.js dist-test/tests/v2-internal-verified-read-entry.test.js dist-test/tests/v2-native-content-contracts.test.js dist-test/tests/v2-native-content-result.test.js dist-test/tests/v2-native-content-child.test.js dist-test/tests/v2-native-content-supervisor.test.js dist-test/tests/v2-native-content-entry.test.js dist-test/tests/ci-lifecycle-gates.test.js
```

Task 6:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-workflow-gate.test.js dist-test/tests/v2-native-content-gate.test.js dist-test/tests/v2-internal-verified-read-gate.test.js
```

## File responsibilities and fixed interfaces

All paths below are repository-relative. New runtime helpers live under `src/orchestrator/verified-read/`; retain the exact five-path retrieval build allowlist.

| Owner | Responsibility |
| --- | --- |
| retrieval/database-core.ts | Fixed schema2 canonical keyset queries, scoped conflict counts, query-free session follow-up keysets using existing private row decoders |
| verified-read/content-data-protocol.ts (new) | Shared existing item/conflict/scope/filter validators, avoiding decoder import cycles |
| verified-read/content-items.ts (new) | Shared detached item/search-item conversion, avoiding packer import cycles |
| verified-read/workflow-contracts.ts (new) | Four workflow request/result/cursor variants and policy identity; type-only imports connect existing content unions |
| verified-read/workflow-cursor.ts (new) | Strict selector codec, deterministic selection hash, current-image matching, continuation construction |
| verified-read/content-ranking.ts (new) | Extract existing fixed collection/filter/fusion/reranking/selection unchanged for old search; reusable limit10 context path |
| verified-read/workflow-query.ts (new) | Bounded query dispatch on supplied image; one-image ranked plus query-free follow-up context candidates |
| verified-read/workflow-result.ts (new) | Whole paging entries/cursors and shared context count/token/envelope packing |
| verified-read/workflow-protocol.ts (new) | Exact workflow parameter/result decoding and request/authority cross-validation |
| verified-read/content-{contracts,protocol,query,result}.ts | Stable existing entry points/union dispatch; old search/get behavior remains |
| verified-read/{contracts,protocol,admission,child,supervisor}.ts; v2/internal-verified-read.entry.ts | Atomic read wire3 and owned final acceptance; existing cleanup/ownership logic retained |
| scripts/run-v2-native-read-workflows.js (new); package.json | Fixed narrow acceptance command reusing owned runFixedStages, independent safe receipts |
| tests/support/v2-native-workflow-fixture.ts (new) | Genuine schema2 empty/populated/republish fixtures and test-only request/receipt/base helpers |
| tests/fixtures/v2-verified-read-process-fixture.ts | New test-only SQL/packing blocking modes; no product fault switches |
| tests/ci-lifecycle-gates.test.ts | Exact newly tracked source inventory, preserving sealed evaluator isolation |
| docs/superpowers/evidence/2026-10-07-v2-native-read-workflows.md (new) | Accepted identities, task evidence, reviews, limitations and remaining production coverage |

**Task 1 produces these exact types** (all Readonly; arrays readonly):

- Export existing ContentReadBase from content-contracts.ts. Workflow contracts import it and NativeContentFilters/NativeContentItem/NativeGetConflict/NativeSearchItem/NativeSearchConflict/NativeSelectionScope by type.
- NativePagedOperation = list-canonical-records | recent-canonical-records | follow-up-radar.
- NativePageParameters = NativeContentFilters & { limit?: number; cursor?: string }.
- ListCanonicalRecordsRequest / RecentCanonicalRecordsRequest / FollowUpRadarRequest = ContentReadBase plus exact operation and NativePageParameters. BuildContextPackRequest uses parameters NativeContentFilters & { query: string }. NativeWorkflowRequest is their union.
- NativeWorkflowCursor = { version:1; operation:NativePagedOperation; selectionHash:string; schemaVersion:2; projectionGeneration:number; projectionEventPosition:string; imageSha256:string; lastId:string; lastEventPosition:string|null }.
- WorkflowCursorBinding = Omit<NativeWorkflowCursor, "lastId"|"lastEventPosition">.
- NativeCanonicalPageEntry = { item:NativeContentItem; conflict:NativeGetConflict|null }.
- NativeCanonicalPageResult = { operation:list-canonical-records|recent-canonical-records; selectionScope:NativeSelectionScope; workflowBoundsVersion:typeof NATIVE_WORKFLOW_BOUNDS_VERSION; order:"item-id-binary-asc"|"source-event-position-desc-id-binary-asc"; items:readonly NativeCanonicalPageEntry[]; hasMore:boolean; nextCursor:string|null; byteBounded:boolean }.
- NativeRadarResult has exact follow-up-radar operation, the same scope/policy/paging fields, order source-event-position-desc-id-binary-asc, and items:readonly NativeContentItem[] constrained to follow-up/open|blocked.
- NativeContextResult = { operation:"build-context-pack"; selectionScope; rankingPolicyVersion:typeof NATIVE_CONTENT_RANKING_VERSION; workflowBoundsVersion:typeof NATIVE_WORKFLOW_BOUNDS_VERSION; items:readonly NativeSearchItem[]; conflicts:readonly NativeSearchConflict[]; followUps:readonly NativeContentItem[]; candidateBounded:boolean; selectionTruncated:boolean; byteBounded:boolean }.
- NATIVE_WORKFLOW_BOUNDS_VERSION = "v2-native-read-workflow-bounds-1". NativeWorkflowResult is the three result variants. Existing VerifiedContentReadRequest/NativeContentResult unions include these variants.
- NativeCanonicalPageEntry is a wrapper to retain exact-get conflict semantics per item; it adds no canonical schema fields. Fixed result order must match operation.

### Task 1: Strict private workflow contracts and decoders

**Files:** Create workflow-contracts.ts, workflow-protocol.ts and content-data-protocol.ts; modify verified-read/content-contracts.ts, content-protocol.ts, content-query.ts, content-result.ts, contracts.ts, protocol.ts and wire-data.ts. Create tests/v2-native-workflow-contracts.test.ts; update tests/v2-native-content-contracts.test.ts only for added variants (wire remains 2 until Task 5).

**Interfaces:**
- Consumes: existing descriptor copier, content filter/item/conflict validation and TrustedReadSession.
- Produces: types above; workflow-protocol.ts exports decodeNativeWorkflowParameters(operation:NativeWorkflowRequest["operation"], value:unknown, trustedSession:TrustedReadSession|null):NativePageParameters|BuildContextPackRequest["parameters"]; decodeNativeWorkflowResult(value:unknown):NativeWorkflowResult; assertNativeWorkflowMatchesRequest(content:NativeWorkflowResult, request:NativeWorkflowRequest, binding:VerifiedReadBinding, receipt:VerifiedReadReceipt):void.
- Stable content decoder entry points dispatch explicitly to workflow decoders. Extend independent request/receipt whitelists and operation-correlated success variants; preserve metadata no-content grammar.

- [ ] **Step 1: Write failing tests** `workflow_exact_parameters_and_results`, `workflow_descriptor_and_whole_envelope_bounds`, `workflow_request_scope_and_order_lies`. Pin defaults5/limits1,10; reject0,11/fractions, context limit/token/cursor overrides, caller scope/path/SQL, getters (zero invocations), sparse arrays, malformed Unicode and extra keys. Assert combined context10, duplicate (kind,id) rejection, follow-up kind/status/session, canonical page conflict membership/counts, operation-order correlation, hasMore iff nextCursor non-null and empty page cannot have continuation. Check 8192/8193 copier/full-bootstrap and16384/16385 terminal boundaries with actual encoded overhead,128/129 containers, depth8, fields32/scalars2048. All valid complete requests stay<=8192 and oversized raw requests refuse; do not fabricate a valid exact8192 request if the stricter operation grammar cannot reach that size. Retain old NFKC1024/get512 tests.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.equal(decodeNativeWorkflowParameters("list-canonical-records", {}, null).limit, 5);
assert.throws(() => decodeNativeWorkflowParameters("build-context-pack", {query:"native", limit:10}, null), {code:"FRESH_START_INPUT_INVALID"});
assert.equal(getterInvocations, 0);
```

- [ ] **Step 2: Compile and observe intended RED** for the two contracts files; no static import of absent helpers.
- [ ] **Step 3: Implement the exact interfaces** with bounded own-data snapshots and detached freezing. Extract the existing item/conflict/scope/filter validators into content-data-protocol.ts; both decoders import it, avoiding runtime decoder cycles. Its exact exports are decodeNativeContentItem(value:unknown, search:boolean):NativeContentItem|NativeSearchItem, decodeNativeContentConflict(value:unknown, search:boolean):NativeGetConflict|NativeSearchConflict, decodeNativeSelectionScope(value:unknown):NativeSelectionScope and decodeNativeContentFilters(value:unknown, trustedSession:TrustedReadSession|null):NativeContentFilters. Filters accept only the three filter keys. Preserve existing scalar/relationship semantics; request decoders pass a fresh detached filter-only record. Parent dispatch passes copied data; final outer decoder still charges the whole envelope. Cross-check source positions/status/time/visibility and new arrays against trusted authority and request limits. In wire-data.ts reject non-well-formed Unicode values and object keys after descriptor inspection; preserve every existing cap and encoded-size charge. Add exhaustive staging rejection for workflow branches in query/result until their tasks.
- [ ] **Step 4: GREEN** both contracts files; intrinsic result shape failures and immutable authority lies must fail independently.
- [ ] **Step 5: Commit exact task owners** as `feat: define private V2 read workflow contracts`.

### Task 2: Fixed keyset browsing, session follow-ups and cursor binding

**Files:** Modify retrieval/database-core.ts. Create verified-read/workflow-cursor.ts; modify workflow-protocol.ts to validate cursor syntax through the shared codec; create tests/support/v2-native-workflow-fixture.ts, tests/v2-native-workflow-database.test.ts and v2-native-workflow-cursor.test.ts. Keep existing retrieval database tests in the focused gate.

**Interfaces:**
- Database core exports ProjectionPageKey={id:string; eventPosition:bigint|null}; ProjectionCanonicalPage={items:readonly {item:RetrievalItem; eligibleConflictMemberCount:number|null}[]; hasMore:boolean}; ProjectionFollowUpPage={items:readonly RetrievalItem[]; hasMore:boolean}.
- collectCanonicalPageFromProjectionDatabase(database:DatabaseSync, manifest:ProjectionManifestV2, context:RetrievalEligibilityContext & {order:"id"|"event"; limit:number; after:ProjectionPageKey|null}):ProjectionCanonicalPage.
- collectFollowUpPageFromProjectionDatabase(database:DatabaseSync, manifest:ProjectionManifestV2, context:RetrievalEligibilityContext & {limit:number; after:ProjectionPageKey|null}):ProjectionFollowUpPage.
- Cursor exports decodeWorkflowCursor(value:unknown):NativeWorkflowCursor; encodeWorkflowCursor(cursor:NativeWorkflowCursor):string; createWorkflowSelectionHash(operation:NativePagedOperation, binding:VerifiedReadBinding, scope:NativeSelectionScope, filters:NativeContentFilters):string; assertWorkflowCursorMatches(cursor:NativeWorkflowCursor, binding:WorkflowCursorBinding):void; nextWorkflowCursor(binding:WorkflowCursorBinding, last:ProjectionPageKey):string.
- Fixture exports makeNativeWorkflowFixture(buildHash?:string, options?:ReadFixtureOptions):Promise<NativeContentFixture & {appendWorkflowCorpus(options?:{canonicalCount?:number; followUpCount?:number; matchingFollowUps?:boolean}):Promise<{canonicalIds:readonly string[]; followUpIds:readonly string[]}>}>. Extend genuine event/lifecycle fixtures; captureImage/publish/admission remain existing APIs. Do not mutate actual stores to fabricate acknowledgement.
- Fixture exports nativeWorkflowRequest(operation:NativeWorkflowRequest["operation"], parameters?:NativePageParameters|BuildContextPackRequest["parameters"]):NativeWorkflowRequest (default context query "native", otherwise {}, project-strong/position0/budget5000); nativeWorkflowReceipt(fixture,request,manifest):VerifiedReadReceipt from real admission.capture(request); nativeWorkflowSuccessBase(fixture,request,manifest):ReadSuccessBase using that receipt/fence and fixture IDs. Base closure is capacity reservation only.

- [ ] **Step 1: Write failing tests** `canonical_binary_and_latest_state_keysets`, `query_free_session_radar_and_corrupt_rows`, `cursor_binding_and_encoding`, `cursor_narrows_only_and_limit_is_not_authority`. Assert exact ID order/tied positions/pages1,5,10/exhaustion; source update moves the same record once in recent, not historical duplicates. Include mixed-case scalar IDs in a separately owned real-schema database fixture if event grammar disallows those IDs. Assert SQL LIMIT<=11 and fixed parameterization/no OFFSET; open/blocked only, no query substring requirement, foreign session/project/time/status excluded; sessionless returns empty after metadata verification. Missing table/bad row/schema fail, never empty. Cursor reject extra keys/wrong scalar/null-position mode/malformed Unicode/noncanonical encoding/>2048 bytes/position past tail; each wrong operation/filter/scope/release/control/image separately refuses as stale.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.deepEqual(first.items.map(row => row.item.id), expectedIds.slice(0, 5));
assert.equal(first.hasMore, true);
assert.equal(final.hasMore, false);
assert.throws(() => assertWorkflowCursorMatches(oldCursor, changedImageBinding), {code:"V2_CONTENT_CURSOR_STALE"});
```

- [ ] **Step 2: Compile and run RED** workflow database/cursor plus retrieval-database-core.
- [ ] **Step 3: Implement APIs** using existing verifyMetadata/preparedRows/eligibilityParameters/canonicalItem/scopedItem and SQL predicates. Validate schema2,1..10 limit, position0..9223372036854775807 and row anchors. Three fixed keysets, at most limit+1 SQL rows; scoped canonical conflict count reuses exact-get predicate. Repeat isEligible after decoding; corruption cannot be a dropped/empty row. Sessionless radar validates image/schema/table contract before empty return.
- [ ] **Step 4: Implement cursor codec and binding** as canonical JSON encoded base64url (no padding), validating bounded UTF-8 before/after decode and requiring canonical re-encoding equality. Scalar lastId<=2048 UTF-8 bytes remains subject to complete2048 cursor cap; canonical list lastEventPosition=null, other modes decimal within image tail. Use canonicalJson over a fixed plain object {operation,order,projectionBinding,selectionScope,expectedRelease,controlGeneration,compositionEpoch,filters:{visibility,validAt:null-or-value,knownAt:null-or-value}} and SHA-256. Normalize defaults before hashing. Bind all FreshStartRelease identities/hashes; no process paths/credentials. Exclude limit,budget,minimum position and receipt consistency from the selection hash because they do not grant selection scope. Match schema/generation/tail/image/hash/operation before SQL; stale survives the query error reducer. Extend assertNativeWorkflowMatchesRequest to independently reconstruct returned nextCursor binding from trusted binding/receipt, require its key equals the last returned item/source position, and enforce returned page count<=request limit; add these assertions to workflow-contracts and cursor tests. Changing valid scalar start key can only narrow keyset traversal; no signature/provenance claim.
- [ ] **Step 5: GREEN and commit** exact task owners as `feat: add scoped V2 keyset reads and cursors`.

### Task 3: One-image workflow query assembly

**Files:** Create verified-read/content-ranking.ts and workflow-query.ts; modify content-query.ts. Create tests/v2-native-workflow-query.test.ts. Existing v2-native-content-query, retrieval-selection-core, retrieval-eligibility and retrieval-ranking tests are regression targets.

**Interfaces:**
- content-ranking.ts exports NativeRankedQuery={rankedCandidates:readonly RerankedCandidate[]; selection:RankedSelection; conflictGroups:readonly RetrievalConflictGroup[]; candidateBounded:boolean}; collectNativeRankedQuery(database:DatabaseSync, manifest:ProjectionManifestV2, input:{eligibility:RetrievalEligibilityContext; query:string; limit:number; requiredEventPosition:string; remainingMs:number}):NativeRankedQuery.
- workflow-query.ts exports NativeWorkflowQueryContext={request:NativeWorkflowRequest; binding:VerifiedReadBinding; receipt:VerifiedReadReceipt; eligibility:RetrievalEligibilityContext; selectionScope:NativeSelectionScope; remainingMs:number}.
- NativeWorkflowCandidate union: canonical page {operation:list|recent; selectionScope; cursorBinding; page:ProjectionCanonicalPage}; radar page {operation:radar; selectionScope; cursorBinding; page:ProjectionFollowUpPage}; context {operation:context; selectionScope; ranked:NativeRankedQuery; followUps:ProjectionFollowUpPage}.
- queryNativeWorkflow(database:DatabaseSync, manifest:ProjectionManifestV2, context:NativeWorkflowQueryContext):NativeWorkflowCandidate. Extend NativeQueryCandidate union; stable queryNativeContent validates request/image/receipt/authority before dispatch.

- [ ] **Step 1: Write failing tests** `workflow_dispatch_and_receipt_image_match`, `context_project_receipt_keeps_selection_session`, `context_query_free_radar_uses_one_database`, `context_zero_ranked_overflow_and_duplicate_budget`. Assert all four operations use supplied database/manifest, trusted scope despite null receipt session, query-free follow-ups with zero text matches,10+1 bound, real source positions and no image pathname reopen/second parent query. Republish after capture; old cursor fails and uncursored reads restart. Assert unchanged existing search channels/ranking64/token2048/exact-get behavior and typed stale/timeout/scope/integrity.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.equal(candidate.operation, "build-context-pack");
assert.equal(candidate.selectionScope.sessionId, trustedSessionId);
assert.equal(candidate.followUps.hasMore, true);
assert.equal(distinctCapturedDatabaseHandles.size, 1);
```

- [ ] **Step 2: Compile and observe RED** workflow-query plus listed regression targets.
- [ ] **Step 3: Extract existing search ranking without behavior changes** into collectNativeRankedQuery; reuse current eligibility/filter/fusion/reranking/DEFAULT_RANKING_POLICY/selection. Search retains limit5/default request limit; context uses10. Check deadline around bounded SQL/filter/ranking, anchors<=tail and known<=source.
- [ ] **Step 4: Implement workflow dispatch** after existing image/receipt checks. Derive effective filters/selection once; derive cursor binding from this captured image and authority; validate supplied cursor, then issue one keyset query. Context executes ranking then query-free follow-up primitive limit10 on the very same database; carry lookahead hasMore into context bounds. Keep original response remaining budget; no parallel provider, separate adapter calls or new required-position fence. Preserve V2_CONTENT_CURSOR_STALE in content-query error reduction, reduce other unexpected database exceptions to integrity.
- [ ] **Step 5: GREEN and commit** exact owners as `feat: assemble V2 read workflows on one verified image`.

### Task 4: Paging progress and honest shared context packing

**Files:** Create verified-read/workflow-result.ts and content-items.ts; modify content-result.ts. Create tests/v2-native-workflow-result.test.ts; retain v2-native-content-result tests.

**Interfaces:**
- buildNativeWorkflowResult(candidate:NativeWorkflowCandidate, base:ReadSuccessBase):NativeWorkflowResult in workflow-result.ts; stable buildNativeContentResult dispatches explicitly.
- estimateNativeWorkflowContextTokens(result:NativeContextResult, selected:readonly Pick<FusedCandidate,"id"|"item">[]):number in workflow-result.ts. All selected retrieval items/follow-ups retain genuine normalizedKey/anchor for the inherited estimate; result wire does not invent these schema fields.
- content-items.ts exports detachNativeContentItem(item:RetrievalItem):NativeContentItem and detachNativeSearchItem(candidate:FusedCandidate):NativeSearchItem; extract existing detachedItem/searchItem bodies unchanged. Both packers import this helper. Packing uses wire-data.ts copyBoundedProtocolData/encodedProtocolBytes for complete envelopes and strict workflow result decoding; no packer-to-packer cycle or new barrel/public API.

- [ ] **Step 1: Write failing tests** `page_cursor_follows_last_returned_whole_item`, `workflow_complete_envelope_and_metadata_allowance`, `context_zero_ranked_overflow_and_duplicate_budget`, `context_conflict_unit_counts_and_warning_barrier`. Assert final cursor null, byte-withheld page resumes without duplication/omission, oversized first page item plus mandatory cursor refuses RESULT_TOO_LARGE. Assert context combined<=10, distinct(kind,id), independent oracle<=2048, whole conflict units/scoped warnings/counts; metadata-only>2048 refuses. Cover multi-byte/escaped strings, duplicate follow-up in ranked items, no ranked matches/>10 follow-ups, token-exhausted supplementation and every known omission represented by a flag.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.ok(result.items.length + result.followUps.length <= 10);
assert.ok(independentlyComputedTokenEstimate <= 2048);
assert.equal(new Set([...result.items, ...result.followUps].map(item => JSON.stringify([item.kind,item.id]))).size, result.items.length + result.followUps.length);
assert.ok(!knownOmittedFollowUps || result.candidateBounded || result.selectionTruncated || result.byteBounded);
```

- [ ] **Step 2: Compile and run RED** workflow-result and native-content-result.
- [ ] **Step 3: Implement page packing** using rows already selected by Task 2; attach canonical exact-get per-item conflicts, or radar items. Prospective complete envelope includes truthful flags and candidate continuation. hasMore = SQL lookahead OR byte-withheld eligible row; nextCursor is bound selector after LAST RETURNED item, never lookahead. Encode/recheck after every prospective whole item and final metadata; first eligible item that cannot fit refuses, so no empty continued page. Return immutable decoded detached result.
- [ ] **Step 4: Implement context packing** ranked conflict units first in existing selector order, then ordered follow-ups. Deduplicate by JSON tuple(kind,id), not id alone. One allowance is sum estimateCandidateTokens(selected) + ceil(encoded UTF-8 bytes of prospective result with every returned text="" /4). Charge scope/policy/flags/channels/positions/conflicts/warnings; conservative double identity charging is intentional. Recompute after each whole prospective unit; mandatory empty-result metadata alone over2048 refuses. Retain all scoped conflict descriptors; update returnedMemberCount after count/token/envelope decisions. Preserve inherited incomplete/zero-member conflict barriers for ranked units; do not split/suppress their warnings. Follow-up supplementation cannot duplicate or hide omission and uses remaining shared count/token budget.
- [ ] **Step 5: Implement honest flags and independent byte check** candidateBounded includes ranked collection or radar lookahead not proving exhaustion; selectionTruncated includes ranked policy/conflict suppression and known follow-ups omitted by combined10/token limit; byteBounded means final envelope omitted whole units. A duplicate retained in ranked items is not an omission. No guessed total counts/string clipping. Preserve old search's permitted empty byteBounded result; its existing first-unit assertion is not changed to paging semantics.
- [ ] **Step 6: GREEN and commit** exact owners as `feat: bound V2 paging and shared context packing`.

### Task 5: Atomic wire3 and owned compiled acceptance

**Files:** Modify verified-read/contracts.ts, protocol.ts, admission.ts, child.ts, supervisor.ts and src/v2/internal-verified-read.entry.ts. Update tests/support/v2-verified-read-fixture.ts and tests/fixtures/v2-verified-read-process-fixture.ts. Modify the nine direct wire fixture tests: v2-internal-verified-read-{contracts,child,supervisor,entry}; v2-native-content-{contracts,result,child,supervisor,entry}. Create tests/v2-native-workflow-entry.test.ts. Update tests/ci-lifecycle-gates.test.ts exact source inventory. No cleanup/ownership wire changes.

**Interfaces:**
- ReadBootstrap/ReadSuccessBase/ReadReply/ReadCancel version literal3. Add all workflow-correlated success variants and failure code V2_CONTENT_CURSOR_STALE. decodeReadBootstrap/reply/cancel accept only3.
- Existing adapter.verify/query/diagnostic/close and executeVerifiedRead signatures remain, widened private content unions only. Stage sequence remains admission/projection-wait/capture/validate/query/revalidate; <=8 messages.
- Test-only process modes add workflow-query-hang and workflow-packing-hang; they import compiled executeVerifiedRead with existing injected test build inspector and use owned supervisor spawn seam. They are not measured production argv/env capabilities.

- [ ] **Step 1: Write failing tests** `read_wire3_accepts_and_wire2_refuses`, `context_same_captured_image_and_final_authority`, `workflow_candidate_waits_for_owned_completion`, `compiled_workflow_query_and_packing_deadline`. Assert all seven private operations use3; cleanup/ownership1 unaffected. New context at query barrier survives pathname replacement/later event with both sections tied to original manifest/SHA/positions. Supervisor rejects wrong selection/cursor/result kind/order/status/position and yields no early terminal success before exit/drain/revalidation/ownership absence. Cover held exit, epoch change, late success, primary stale versus cleanup failure and removal failure.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.equal(outcome.code, "WORKER_TIMEOUT");
assert.ok(parentTicks >= 5);
assert.equal(maximumActiveReadOrCleanup, 1);
assert.equal(contentReleased, false);
assert.equal(ownerAbsent, cleanupPositive);
```

- [ ] **Step 2: Compile and run RED** new workflow-entry plus nine direct wire tests; update nominal fixtures coherently so targeted failures are wire/version or workflow behavior, not unrelated missing success fields.
- [ ] **Step 3: Move every product literal atomically to3** including admission.ts dummy bootstrap, supervisor binding-copy/launch/cancel and entry protocol-fault terminal. Update independent receipt/request whitelists/failure map and discriminated result assertions. Keep owned total deadline/cleanup order/quarantine and metadata no-content grammar. Update tests positively accepting3 and rejecting [1,2,"3"], retaining scalar/wrong-version variants. No blanket replace of schema2 or cleanup1.
- [ ] **Step 4: Add actual synchronous phase proofs** in test fixture only. workflow-query-hang intercepts the specific new fixed canonical-list or query-free follow-up SQL after query stage, confirmed validated image/owned lock. workflow-packing-hang intercepts Buffer.byteLength only for prospective workflow result JSON containing workflowBoundsVersion (not request/bootstrap), checks query-stage/lock marker, then Atomics.wait. Neither merely advances a clock before query/after packing. Through real compiled process handles prove deadline and AbortSignal separately: <=2000ms request plus1000ms scheduling tolerance, parent ticks>=5, read exit before cleanup, maximum one read OR cleanup child, independent writer survives/bytes unchanged. Bound each fault test at20000ms, barriers<=3000ms. On positive cleanup require owner absent; uncertainty retains original lock/owner and no content. Observe/drain all exact handles before deleting positively closed owned temp roots.
- [ ] **Step 5: Measure actual emitted integration** with one current build for this task's entry tests (not the final runner). Genuine deployed measured fixture reads all four workflows from empty/populated/restarted images. Extend exact read runtime helper inclusion assertions for content-data-protocol/items/ranking and workflow-contracts/cursor/protocol/query/result. workflow-contracts is an emitted input because its policy constant is imported at runtime. Cleanup has no workflow-query/result/content-ranking/content-items inputs or retrieval inputs. Because cleanup imports the existing shared protocol module, any new shared decoding inputs must be a subset of content-data-protocol.ts, workflow-contracts.ts, workflow-cursor.ts and workflow-protocol.ts; inspect/hash their complete closure and prohibit query/packer/process dependencies. Do not assert all decoder inputs disappear through tree shaking. Preserve exact five retrieval allowlist, five artifacts/build manifest schema1, source SHA/emitted SHA checks and no process/thread/helper/publisher facade. scripts/fresh-start-build.js/build.js need no allowlist/cap change.
- [ ] **Step 6: Update exact sealed source inventory** in tests/ci-lifecycle-gates.test.ts with exactly eight new verified-read helper paths alphabetically: content-data-protocol.ts, content-items.ts, content-ranking.ts, workflow-contracts.ts, workflow-cursor.ts, workflow-protocol.ts, workflow-query.ts, workflow-result.ts. Preserve evaluator/static-routing assertions, no broad globs/exclusion. Add private/public-equivalent new operation denial to genuine public status-only/V1-sentinel test; zero sentinel reads/writes, public content still unavailable.
- [ ] **Step 7: GREEN and commit** task owners plus source inventory as `feat: integrate owned V2 read workflows on wire3`. Regression targets additionally include internal admission/cleanup/ownership and ci-lifecycle-gates; no added skips/deleted assertions.

### Task 6: Fixed scoped acceptance, independent review and honest evidence

**Files:** Create scripts/run-v2-native-read-workflows.js and tests/v2-native-workflow-gate.test.ts; modify package.json only to add test:v2-native-read-workflows="node scripts/run-v2-native-read-workflows.js". Create docs/superpowers/evidence/2026-10-07-v2-native-read-workflows.md and update this plan's accepted task ledger after reviews. Existing runner/native33/metadata20 scripts and test lists remain unchanged.

**Gate-budget amendment approved on 2026-10-08:** The human replied `อนุมัติ` to raising only this workflow gate's default/maximum from 1,500,000 ms (25 minutes) to **2,100,000 ms (35 minutes)**. The actual old-cap run at `963a1e88f7167edf58791b41c1e146a47b7686ca` expired with native exit124 at stage26 (`v2-internal-verified-read-gate`), after25 successful stages/414 settled passes; interrupted-stage counts are unknown, eight later stages were unlaunched, cleanup was complete/Windows Job-active-zero, and qualification count was zero. Preserve the failed attempt; Task6 acceptance remains pending. Implement the mechanical amendment in exactly the runner, workflow-gate test, this plan and the approved spec; preserve one original clock, exact29/order/34stages, all30 existing test controls/assertions,5000ms gate cleanup and unchanged product/other-profile contracts. Add two focused early native-exit17 default/maximum cases, bringing the workflow-gate inventory to32 tests. Verify current compiler plus only those two named budget cases and the existing no-launch lock/invalid-cap/argv/old-profile test for RED/GREEN. After immutable scoped review and a clean four-owner commit, root runs the one required full exact29/34 gate with fresh build/compile. No other heavy suites or build are part of this amendment's focused checks.

**Interfaces:**
- Export runNativeReadWorkflowsGate({root=repository,timeoutMs=2100000,signal}={}):Promise<number> from new runner for owned-root tests; no caller-selected stages/files/profiles through CLI.
- Reuse runFixedStages from run-v2-internal-verified-read.js with profile native-read-workflows, gate v2-native-read-workflows, maximumMs2100000, common exclusive lock/Windows Job closure. CLI rejects every argument, owns SIGINT/SIGTERM abort and safe failure code NATIVE_READ_WORKFLOWS_GATE_FAILED.
- Fixed stages: runtime (scripts/check-runtime.js --json), typecheck (node_modules/typescript/bin/tsc --noEmit), build (scripts/build.js), compile (tsc -p tsconfig.test.json), each exact ordered test file below, then smoke (scripts/smoke-v2-fresh-start.js). One build/compile; **34 stages:4 setup+29 tests+smoke**.

**Root-led safe diagnostic amendment (Ruling29, 2026-10-08):** Export the nonthrowing pure `parseWorkflowFailureDiagnostics(stdout, compiledTestPath, root, failedCount)` helper for exact compiled-file numeric hints from the terminal failing section after a coherent footer. Only a failed test receipt with coherent fail>0 and no overflow gains optional `failureDiagnostics`; passing receipt/qualification schemas and primary native failure remain unchanged. Its fixed status is matched/partial/unavailable, truncation is explicit, and at most 16 ordered sites contain positive safe numeric declaration/optional assertion locations, optional ERR_ASSERTION/ERR_TEST_FAILURE code and optional testTimeoutFailure kind. Preserve duplicate declaration positions without claiming a loop variant is identified. Emit no observed names, paths, messages, stacks, values or content. Keep raw discard, 16MiB cap/SHA/counts, all identity/native/deadline guards and existing 35-minute/cleanup/product bounds. Node 24 spec formatting is not stable; official documentation recommends TestsStream events for programmatic consumers. This narrow best-effort parser changes no reporter, process seam or argv/environment and returns partial/unavailable for missing or unrecognized hints. Retain the failed workflow32/30pass2fail and content-supervisor83/82pass1fail attempts and separate passing replays; original failed names/causes are UNKNOWN, with no product fix or qualification inferred. Exact owners remain runner/test/spec/plan. Add three focused pure cases plus one actual early failed-test native fixture, retaining all 32 existing controls (36 workflow-gate tests total). Current compiler plus only those four new cases and the unchanged old-profile/lock control provide genuine RED/current GREEN; root owns immutable scoped review and required full qualification after clean scoped commit.

Exact 29 test names (append .test.js under dist-test/tests):

```text
v2-native-workflow-contracts
v2-native-workflow-database
v2-native-workflow-cursor
v2-native-workflow-query
v2-native-workflow-result
v2-native-workflow-entry
v2-native-workflow-gate
v2-native-content-contracts
v2-native-content-query
v2-native-content-result
v2-native-content-child
v2-native-content-supervisor
v2-native-content-entry
v2-native-content-gate
v2-internal-verified-read-contracts
v2-internal-verified-read-admission
v2-internal-verified-read-child
v2-internal-verified-read-cleanup
v2-internal-verified-read-ownership
v2-internal-verified-read-supervisor
v2-internal-verified-read-entry
v2-internal-verified-read-gate
retrieval-database-core
retrieval-selection-core
retrieval-candidates
v2-retrieval-candidates
retrieval-eligibility
retrieval-ranking
ci-lifecycle-gates
```

- [ ] **Step 1: Write failing runner tests** `workflow_gate_exact_inventory_and_single_build`, `workflow_gate_preserves_other_profiles_and_lock`, `workflow_gate_refuses_incoherent_receipts_and_identity_drift`. Pin exact29/order/stages34/max2100000/argv refusal/old native33+metadata20 unchanged. Fixed synthetic stage-root tests cover failure/cancel/timeout/Job-active-zero/drain/output lock uncertainty and non-Windows fail-closed before launch; preserve existing Windows-only skip declarations, introduce none into product behavior tests.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.equal(stageReceipts.length, 34);
assert.equal(testStageReceipts.length, 29);
assert.equal(stageReceipts.filter(stage => stage.stage === "build").length, 1);
assert.equal(stageReceipts.filter(stage => stage.stage === "compile").length, 1);
assert.ok(stageReceipts.every(stage => stage.cleanup === "complete" && stage.closure === "windows-job-active-zero"));
```

- [ ] **Step 2: Compile and observe RED** workflow-gate plus existing native-content-gate/internal-verified-read-gate.
- [ ] **Step 3: Implement safe acceptance accounting** following the existing retained-evidence runner pattern: actual native exit/complete closure plus coherent terminal outer Node spec footer (reuse parseFinalSpecCounts export), not nested summaries or independent per-field matching. Each test stage must have tests>0, fail=cancelled=todo=0 and pass+skipped=tests. Bound ephemeral output at16MiB/stage, hash observed bytes, report counts/skips/overflow and safe code plus optional bounded numeric failure hints only, then discard raw text. Overflow/truncated footer/changed source/artifact/compiled inputs refuses.
- [ ] **Step 4: Bind the settled candidate** before stages to clean committed HEAD and hashes of tracked src/tests/scripts/package/lock/tsconfig inputs; after compile measure entire dist-test tree and listed test hashes, after build measure v2-build.json/buildIdentityHash/all five emitted artifacts and closure inputs. Compare candidate/source/compiled/artifact identities after smoke. No source echo, arbitrary receipt or uncommitted tree accepted. Do not include mutable memory-vault notes in product identity. Runner containment cleanup is its existing5000ms window, distinct from product2000ms cleanup.
- [ ] **Step 5: GREEN runner regressions, task reviews and commit** exact task runtime/test/package owners as `test: add bounded V2 read workflow acceptance gate`. Perform independent whole-increment spec/code-quality review against actual settled source. Fix actionable issues with only affected focused reruns/re-review, then commit them. Do not dispatch another full acceptance while reviewers/build owners overlap.
- [ ] **Step 6: Run one settled native acceptance** `npm run test:v2-native-read-workflows` from clean committed source. Success is exit0, all34 stages accounted/positive Job closure/drain, no fail/cancel/todo, no new skipped tests, exact stable source/compiled/build identities and final private workflow qualification receipt. Existing skips/platform-unexercised branches are named, not counted as proof. Unsupported non-Windows runner is a typed refusal, not Linux qualification. Later complete-product release remains both-OS.
- [ ] **Step 7: Write evidence and completion ledger** containing actual command/runtime/OS/commit/source/build/compiled/artifact identity, per-task RED/GREEN and independent reviews, exact counts/skips, actual phase fault markers/closure, stale/cursor/context proofs and retained uncertain fixture ownership. Distinguish deployed emitted-entry proof from test-only compiled fault-seam proof, naming the stage/commit for each and any docs-only subsequent HEAD. No old failed output/count or future acceptance is invented. Verify reference/whitespace/exact-doc scope, commit evidence docs, and close project memory with verify:true.

## Completion and remaining PROD work

This plan is complete only when all six task deliveries/reviews and settled private acceptance succeed. That closes private list/recent/context/radar query semantics. Public routing/governed lifecycle/write tools, operational keys/rotation/history/erasure-restoration fences, actual current Codex full-visible capture/private finalization, F3 complete backup/restore/replay/rollback and eight-scenario public-service release proof, and F4 exact approved cutover/live workflow remain. The [readiness report](../reports/2026-10-07-v2-production-readiness.md) and [capability/release coverage](../reports/2026-10-07-v2-capability-release-coverage.md) retain those requirements.

Plan self-review: each spec section maps to Tasks1–6; source consumers/independent nominal fixtures enumerated; stable interface names checked; all five Review Focus cases have owning tests; exact resource and platform distinctions retained. Task checkboxes are prospective, not executed evidence.

## Delivered task/review ledger and final private qualification

**All six private deliveries, scoped reviews and the full Windows runtime qualification are accepted.** Original prospective checkboxes above remain planning history. This appended ledger binds the settled retry3 to runtime candidate56232b5 and the verified375-file frozen local archive. The subsequent exact two-document commit, guarded plan-local cleanup and verified memory closure are recorded in the external [handoff](C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/task6-56232b5-20261008-handoff/handoff.md); its metadata stays outside the frozen plan and avoids circular self-identification.

| Task | Delivered private boundary / accepted focused review | Final qualification |
| --- | --- | --- |
| 1 |Contracts/decoders; d4297f054d34ac8ec1a07a280418b01fcddf60fa;51/51;task-1-review.md Approved |Included in actual retry3 full29-file/34-stage qualification on56232b5,511tests/510pass/skip1 |
| 2 |Keysets/cursors; b5bc5bba6a15049d11c204bc1acfaf68e8a048ad;16/16;task-2-review.md Approved |Included in actual retry3 full29-file/34-stage qualification on56232b5,511tests/510pass/skip1 |
| 3 |Same-image assembly;2896cf0ad25be4686267d68e941d34e6035204e3;21/21;task-3-review.md Approved |Included in actual retry3 full29-file/34-stage qualification on56232b5,511tests/510pass/skip1 |
| 4 |Paging/shared context packing;9c1c7c2db6c1d24064040997e7c51e3056f2ef84;settled12/12;task-4-review.md Approved |Included in actual retry3 full29-file/34-stage qualification on56232b5,511tests/510pass/skip1 |
| 5 |Atomicwire3/owned emitted integration;original a545cbd; accepted fix1 71b351ab87c033dcf9798cef4d1372432507b9f3;395/395;task-5-fix1-review.md Approved |Included in actual retry3 full29-file/34-stage qualification on56232b5,511tests/510pass/skip1;old394/EOF and historicalbuild retained |
| 6 |Exact29/34runner;original94bd62b,fix1ca1dafc,accepted fix2 7593541;whole-reviewcorrection963a1e8 accepted;gate-onlyamendment581c51314e1b163bfacdb4a98c69dec89f9159f3 and safe-diagnostics56232b5023e27abb35f364051e71c321b33fc0bb accepted scoped review |private Windows runtime qualification accepted on56232b5;local archive verified;actual full gatePASS native0,qualification1;evidence/preservationverified local archive; final docs-only/cleanup/memory disposition recorded after execution in the external [handoff](C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/task6-56232b5-20261008-handoff/handoff.md) |

One completed whole review at7593541 required ImportantI1 correction;M4 selected,M1duplicatedpredicates/M2denseformat/M3anycasts deferred. One scoped correction at963a1e8 closed I1/localpre-open/M4,no introducedfindings. Human-approved35-minute gate-only amendment at581c513 has exactly4owners;original30controls retained plus2nativebudgetcases,currentworkflow-gate32tests;compiler0/RED3pass1fail2 and compiler0/GREEN3pass3fail0;scopedreviewApproved/no findings. [Final evidence](../evidence/2026-10-07-v2-native-read-workflows.md) preserves all35exactRulinglines/Thai reasons/costs, bounds14 and EOF18 clarifications.

Original uninstrumented25-minute run at963a1e8 FAILED124:25successfulstages/414settledpasses,stage26countsunknown,8unlaunched,qualification0,completeWindowsJob-active-zero,no finalsourcevalidation. Raw evidence remains permanentlypreserved;no stitching/partialacceptance. Humanapproval permits only gate default/maximum1500000→2100000ms;product2000/gatecleanup5000/exact29/34/oldnative33metadata20caps/identity/closure/assertions unchanged. No performancegain or guaranteedpass.

First35 attempt on581c513 at2026-10-08T06:47:44.1011879Z failed native1 at2026-10-08T07:03:22.8585996Z,outer938751.599ms. Stage11 workflow-gate32/30pass/2fail;total68/66pass/2fail,23unlaunched,qualification0,complete/Job-active-zero,commonlockabsent. Original two failed test names and causes remainUNKNOWN because approved runner discarded child raw;later diagnostics cannot retrospectively identify them. Preserve evidence/final35-native* and final35-failure-summary.json;this is testfailure,not timeout.

Ruling26 bounded existingcompiled diagnostics passed2/2,2/2,3/3 then full32/32 raw-forwarded at900000ms,Node591122.3452ms/outer593131.7963ms,native0/complete/Jobzero;source530/compiled990/HEAD581 unchanged,no edits/build/compile. SourceSHA5f2b5ed6f70de839ba48a15ae852001a5686e06d8056c1fb53ed186263cb269e and compiledSHA2cd1eb4357c8f2cf0eb63ffe38b9e3617547cf02a97b22999e9120644bb1e330 equal failedrun observations;failedrun build8f9d09380bf558c4da446fbb000f1fad635a6654987bf3f8a06ec9c461e1c5ad is historicalonly. Diagnostic proof indexevidence/workflow-full-nested-diagnostic-report.md,workflow-full-nested-diagnostic.json and workflow-full-nested-diagnostic.log (276549bytes,SHA22d5167e673c894cb1cc3d988865a15068c825877bdc617416d817a2549e68bf;historical58132/32diagnostic only). No diagnostic pass is full qualification or an inferred fix.

Retry1 also FAILED native1:2026-10-08T07:38:23.1551618Z→07:55:06.8778812Z,outer1003717.7953ms,16launched15success,210tests209pass1fail,18unlaunched,qualification0. Stage16content-supervisor83/82pass1fail,native1/complete/Jobzero;workflowgate32 actuallypassed in this failedfullrun. Originalname/causeUNKNOWN. RawSHAf45746fc0ec25f5a63505cef5f0ff35f7e6b5884ba778965d6d78982ad3efa9a;proof evidence/final35-retry1-failure-summary.json and native-start/execution/log. Retry1buildd4094d4c660a8c6712e87114ff928b2dc5d98f57e29859644f1ea3f880004f43 and unchangedsource530/compiled990 hashes are failed partialmeasurements,not finalqualifiedidentity. Keep failed25/failed35/failedretry1 distinct.

Ruling28 one existingcompiledcontent83replay120000/cleanup5000 passed83/83,no fail/cancel/skip/todo,Node15411.4506ms/outer17898.0189ms,native0/complete/Jobzero,commonlockabsent,HEADsourcecompiledsame,no edits/build/compile. Originalfailedname/cause remainsUNKNOWN;no productfix or acceptance inferred,no automaticfullrerun.

Safe-diagnostics amendment581c513→56232b5023e27abb35f364051e71c321b33fc0bb is clean exact4owner committed and immutable scopedSPEC compliant/QUALITY approved,no actionablefindings. report task6-safe-failure-diagnostics-report.md/review.md/root-proof.json bind23366bytepatch/SHA54b42249c0b8ae1533e1ad25636ac565bd4398451f89f08bd04d1492809e2b8e,532source/990compiled stable/current,cleantrackedtree/commonlockabsent. Currentcompiler0/governingnativeRED5tests1pass4fail0cancel/skip/todo,Node15949.6176ms/outer29626.1144ms,native1positiveJobzero;compiler0/GREEN5/5,Node13294.542ms/outer24327.221ms,native0positiveJobzero. InitialdirectRED is diagnostic-only,no outerclosureclaim. Realfailedfixture stillnative1/fail1/pass0/stages5/Jobzero/noqualification while safehintstest3:1/assertion4:10/ERR_ASSERTION pass;purecasespinstrictsafeprojection/partial/unavailable/duplicates/16bound. All32priorcontrols retained;fournewcases yieldinventory36,but no full36/full29proof is inferred. Hintsoptional/best-effort/non-authoritative;rawdiscardandallnative/deadline/cap/identity/qualification/productguardspreserved;historicnames/causesUNKNOWN.

Actualretry2native95531 nowSETTLED FAILED1,started08:36:59.8634459Z/ended2026-10-08T08:41:50.5076633Z,outer290639.8141ms,on56232,10launched9success,36tests33pass3fail,24unlaunched,qualification0/commonlockabsent. Stage10workflowentry12/9pass3fail,native1/completeJobzero. Rootproof evidence/final35-retry2-failure-summary.json/rawprefixfinal35-retry2-native;rawSHA608891ecdd1df7fd273f69d50f78cb82bb3d850d1d95892b36d70147ec8d0181. Optionalnumeric88:1 andduplicate140:13/sharedassert161:32 are non-authoritativepointers only,originalloopvariants/causeUNKNOWN,not attestation.

## Settled entry diagnostics, STOPPED original10 prefix and separate continuation

Ruling30 exact9 existingcompiled raw-forwarded diagnostic settled9/9,0fail/cancel/skip/todo,actualouter/native0,complete/WindowsJob-active-zero,stage65170.7033ms/Node63489.3121ms,closed2026-10-08T08:49:42.5483649Z. Root FULLREAD evidence/entry-failure-nested-diagnostic-report.md and entry-failure-nested-diagnostic.log;raw6362bytes/SHA739fb5c3bb751ddc861853313f47d626d40bc36102cc96f50028736f855d06d8,reportSHAdeac0dbfdc5885786c0af7d6559c5c5af9d631ecda4e189ee91f9f00e7410062. Settledfacts/fullidentity arrays are entry-failure-nested-diagnostic.json;actualshell/rawreceipt is entry-failure-nested-diagnostic-execution.json. All8negativecontrols reachedmarkers/expectedWORKER_TIMEOUTorWORKER_CLOSED/writer0/finaldrain;4intentionaluncertainrootsretained in fullreport,not deleted. Exact9proof is accepted as diagnostic-only;no originalvariant/caller/cause/fix/qualification is inferred.

Ruling31 originalsamefileorder full12 existingcompiled raw-forwarded diagnostic settled12/12,0fail/cancel/skip/todo,actualouter/native0,complete/WindowsJob-active-zero,stage83371.9544ms/Node81672.0001ms,closed2026-10-08T08:56:56.0880291Z. Root FULLREAD evidence/entry-ordered-nested-diagnostic-report.md and entry-ordered-nested-diagnostic.log;raw6552bytes/SHAad145b79749fac85a45438a978c7648e3e3d95f66efea38f61e0767cf64a81f0,reportSHA65a368525f3c0b2e8f1d68843177a75b0315f65c0a536d2aea43906b3380f9c9. entry-ordered-nested-diagnostic.json preservesfullreceipt/identities;execution.json preservesactualshell/rawreceipt. Restoredwire/contextprefix andstalesuffix passed on this run;5intentionaluncertainrootsretained. A passing ordered12run does NOT establish absence of order/transient/host effects or identify originalvariants/callers/cause.

Both settleddiagnostics bindclean56232b5023e27abb35f364051e71c321b33fc0bb,530sourceSHA291ba508b15ec6560af140897c0d7e3b3109e6eafec7c02b787b2067ffec72af,990compiledSHA8a1e736de014a9fd8a670238474d68e06b8f31f9987267f69ebc370ebe19b510,entrycompiledSHA296f88d577b42f5c6cf0ad339b74624156216bb614969526258f2c46a033bdd9;before/afterstable/commonlockabsent. Originalretry2FAILED36/33pass3fail remainsunqualified;originalhappycause/two loopvariants/sharedassertion161callerremainUNKNOWN. Primaryruntimeformatter possiblyreceivingplainstring is STATIC HYPOTHESIS,not originalcause proof. Sharedassertionhas5callers;finally-drainmaymaskearliererror;happy45s covers12serial5000queries plussetup/publish/close. Hosttelemetry/timing surfaces are context/hypotheses,not cause findings. No fix/timingchange/skip/guardrelaxation/stitchedsuccess is authorized by replay passes.

### Ruling32 stopped observer attempt and Ruling33 separate continuation

Original first10 diagnostic STOPPED outer1 after three successful native0/complete/WindowsJob-zero stages:runtime,typecheck,build. Compiler and six workflowfiles never launched in that attempt. Root's ignored after-build observer wrongly rejected its OWN live commonlock as dirty;this was an observer mistake,not product/test/native failure. Source530/HEAD562stableclean/finalcommonlockabsent. Freshbuildaa483350d40e48dd213b6628bbde896fde89fae3bc93554c86718acba5548f6c/manifestff68dc1d523222ffe42e66babb72a3c1a231483193019561fe5e4ec065cf9939 stableafterbuild. Stoppedraw20005bytes/SHA5bdeb560a4710ed2c12a15f9f0aa5d402320da1d955c80a2c929df1d61ff7b63;reportSHAd41c710983f246743a81b08448995eddbd10ea523c241414fdec22a6d2896806;allstoppedhistory/flawedhelperretained.

Root reviewed the corrected ignoredhelper before Ruling33 ONEremaining compiler+six-file continuation360000ms/cleanup5000ms. Exact ownlockline exception applies only inside ownedcallback;rawstatus remains preserved and before/final requireclean/lockabsence. Root also moved fullhash/build checkpoint toaftercompiler/final only,avoiding extra intermediate test-stage warming absent inoriginalgate. ExecutedhelperSHA9352b4283d8e02ce16392c550a0b60384388b97c7dd573ff259ae09a5cef3749;pre-rootpreparedscript/diff/review remainpreserved. No repeatedruntime/typecheck/build/product/testedit/timingchange/instrumentation/fullgate.

Separatecontinuation PASSED sevennative stages/36tests,0fail/cancel/skip/todo;actualouter/native0,eachcomplete/WindowsJob-zero,nooverflow,wrapper150602.8445ms,closed2026-10-08T09:16:51.1682736Z. Compilerexactlyonce39511.9434ms;contracts9,database4,cursor2,query4,result5,entry12 allpassed inoriginalfileorder;entryNode73016.505ms/native74054.1269ms. Five intentionaluncertainrootsretained;no postrunrootdeletion. Source530SHA291ba508b15ec6560af140897c0d7e3b3109e6eafec7c02b787b2067ffec72af,compiled990SHA8a1e736de014a9fd8a670238474d68e06b8f31f9987267f69ebc370ebe19b510,entrycompiled296f88d577b42f5c6cf0ad339b74624156216bb614969526258f2c46a033bdd9/buildaa483/manifestff68 stable,clean562/lockabsent.

Root independently FULLREAD evidence/entry-continuation-nested-diagnostic-report.md and fullraw,then recomputed exact7receipts/canonical530source/990compiled/allfiveactualartifacts/closureinputs/runtime/clean562 using evidence/verify-continuation-root.mjs exit0. Result evidence/entry-continuation-root-proof.json verified2026-10-08T09:27:58.987Z:diagnosticOnlytrue,qualificationfalse,nativeExit0/stages7/pass36. ReportSHA863816e26e1d286a981a740b584e439e3ceca81d50b34887a51624cfc26a2410;raw16976bytes/SHA83f16353c2241697c659e6d841a8f428e1aa46fa6094194b12469bd093e62e7b. Fullfacts entry-continuation-nested-diagnostic.json and execution.json preservemeasurements/nativeexit;originalrootreview/helperlimitsretained.

Interrupted3 + separate7 nativeepochs is NOT uninterruptedfirst10 and NOT full34qualification. Conditionedpasses do not establish absence of transient/order/hosteffects or originalcause/twoloopvariants/sharedbarriercaller;allremainUNKNOWN. Scoped562safe-diagnostics/focused5GREEN staysaccepted,butno guessed product/testfix,timingchange,stitchedqualification or historicalreclassification follows. WorkerSTOPPED and returnedownership.

## Actual full retry3 — settled PASS, private Windows runtime qualification

Root native36544 executed ONE unchanged uninstrumented full34-stage/29-file command on clean56232b5023e27abb35f364051e71c321b33fc0bb at2100000ms/cleanup5000ms. Started2026-10-08T09:29:14.1140802Z;ended2026-10-08T10:03:49.3845050Z;outer2075266.5217ms (34m35.2665s),terminalstage2070129.3825ms. Actual native0,511tests/510pass/0fail/0cancel/1inherited Windows skip/0todo,all34complete/windows-job-active-zero,29testfiles,smoke0,onequalification,clean/lockabsent/stable final identities. Root executed immutable reviewed evidence/verify-final35-retry3.mjs0;proof evidence/final35-retry3-verified-summary.json verified2026-10-08T10:04:07.434Z and final35-retry3-native-execution.json. RawSHA1d1cfa18f352c3b8079723ebff91ce2f744425ac91e9333bb71aeb3746f1ba3c. No failed/diagnostic counts are stitched into it.

Canonical530sourceSHA291ba508b15ec6560af140897c0d7e3b3109e6eafec7c02b787b2067ffec72af;990compiledSHA8a1e736de014a9fd8a670238474d68e06b8f31f9987267f69ebc370ebe19b510;freshbuild9f242bc870baf88ba5cb76b702bc34960d0530b2773f4f97165d46c29acd5d7e;manifestSHAa3588773ea6db0310a3ef868ff4e3b9397761786594e98923e80a5d2f4d91230/deploymentId3c57798c-0dfe-43aa-832c-43d4ba9230e8/schema1;Node24.16.0/win32/x64/executableSHAb3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3. Final evidence supplies all34 ordered receipt timings/counts/closure/output hashes,29compiled hashes,5artifact lengths/hashes and61/20 source/emitted closure proof references. Root independently revalidated all identities aftersmoke;none is the earlier aa483 diagnostic build.

Actualentry12 passes derive happy empty/populated/restarted/cursor/context plus all8 query/packing deadline/abort/uncertain ownership/writer/drain assertions from exactcompiled296f88d577b42f5c6cf0ad339b74624156216bb614969526258f2c46a033bdd9 and current emitted build. Child marker/image text was discarded:do not invent current image SHA or claim directraw current-marker capture. Skip1 belongs to actualinternal-verified-read-gate16/15pass1skip plus exact currentcompiled ba73ff9d92568fd477968d98e1ce5b5f691fd73b5bcf4f6837c319567c95042c declaration 'unsupported non-Windows containment refuses before any native stage and retains its output lock';its name/reason is declaration attribution,not childraw capture. No newskip,both-OS or wholePROD proof.

Ruling35:runtime delivery/reviews/privatequalification accepted;all375 frozen plan-local files preserved in a verified external ZIP. The exact2tracked docs,guarded frozen-plan-only cleanup and verified memory closure have their final disposition in the external handoff. Preserve all35 exact rulings/Thai why-cost in final evidence and handoff,allfailed/raw/diagnostic histories and F2unapproveddrafts;retain branch/worktree/siblings/uncertainTemp/alloutsidepaths. External handoff created:C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/task6-56232b5-20261008-handoff/handoff.md. Later docs-only HEAD/memory/cleanup outcomes go outsidefrozenplan;no self-hash/circular field. Root applies ONLY this appended ledger to the current approved562 trackedplan;originalprospectivebody remainshistory.
### Preserved actual root snapshots

Root snapshots at 2026-10-08T10:06:48.279Z bind the settled56232b5 candidate. Verified summary SHA256 4eda3d7d38c99ece8e7f2b24864214baf191c5c0537696108c99927a1a5da184;index evidence/final35-retry3-snapshot-index.json SHA256 06f4b71ec2eacf6761385802765c3f43b53c32a97a9c2ddd2fbb92248474ec84. The inventory snapshot preserves all530 source/990 compiled paths and current hashes rechecked by root. These hash-indexed plan-local copies preserve the measured deployment manifest and read/cleanup closure proof even after future emitted-output changes. final35-rulings-exact.json preserves all35 exact lines in order.

| Preserved root snapshot | Bytes | SHA256 |
| --- | --- | --- |
| evidence/final35-retry3-built-manifest.json | 974 | a3588773ea6db0310a3ef868ff4e3b9397761786594e98923e80a5d2f4d91230 |
| evidence/final35-retry3-built-read-closure.json | 41995 | 4dfc81588311da7f4cb5efb75cdc57dcfefa34cc41953537783e4c7bdb81d38e |
| evidence/final35-retry3-built-cleanup-closure.json | 12120 | 48b1c9b20c10301833adc2342e20b5a5445864ab418c5827ae4a5236fa850e0e |
| evidence/final35-retry3-source-compiled-inventory.json | 249999 | 8a1b17077e5198d6e33017966eadd36c032f4131ce5a1fb228a9c0ec45cce86e |
| evidence/final35-rulings-exact.json | 30085 | 5ad801e3e6154a6c68c263e717b3d9f9fc3a2c9f99854f8ea9dd761d6a25dc3c |
Root's exact2trackedtarget/reference/whitespace/scope verification:root verifies exactly the evidence document and appended plan ledger, resolved Markdown references, all35 exact rulings,34receipt/29compiled/5artifact hashes and git diff --check; actual result recorded after execution in the external [handoff](C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/task6-56232b5-20261008-handoff/handoff.md). Frozen primaryarchiveC:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/2026-10-07-v2-native-read-workflows-qualified-56232b5-20261008T100349Z.zip/dc7c2abc076ac9f6e8ef36e47db75b59bcd33d9c951e7f72a6a7c93f1dbcce07;exactrelativeinventory/length/SHA/streamedZIPreadback375 exact relative files/lengths/SHA256, streamed ZIP readback and fresh frozen-source equality at 2026-10-08T10:22:06.0351584Z; C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/2026-10-07-v2-native-read-workflows-qualified-56232b5-20261008T100349Z.zip.verification.json;Ruling35exactfrozenignoredplancleanupguarded exact frozen-plan removal result recorded after execution in the external [handoff](C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/task6-56232b5-20261008-handoff/handoff.md). Preserve allraw/history/rulings/rootindexes/unapprovedF2drafts. No worktree or uncertainTempcleanup. The archive is verified;the actual docs-only commit,guarded cleanup and memory closure are recorded in external handoff metadatareturned memory_sessionEnd verify:true health recorded after execution in the external [handoff](C:/Users/Server/Desktop/Awakened-AI-System/.superpowers/evidence-archive/task6-56232b5-20261008-handoff/handoff.md) before requestedpause.

Completion closes only this private read increment. Future public/governedF2lifecycle/write capabilities,operationalkeys/rotation/history/erasure-restoration,actualcurrentCodexcapture/privatefinalization,F3backup/restore/replay/release/both-OS andF4approvedcutover/liveworkflow remainOPEN. FutureF2written-spec drafts/reviews authorize no implementation. Existing closed readiness/public/privacy/recovery guards remain in force;no wholePROD/public/current-host readiness or activation/push/merge/deploy authority follows from this ledger.
