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

**Interfaces:**
- Export runNativeReadWorkflowsGate({root=repository,timeoutMs=1500000,signal}={}):Promise<number> from new runner for owned-root tests; no caller-selected stages/files/profiles through CLI.
- Reuse runFixedStages from run-v2-internal-verified-read.js with profile native-read-workflows, gate v2-native-read-workflows, maximumMs1500000, common exclusive lock/Windows Job closure. CLI rejects every argument, owns SIGINT/SIGTERM abort and safe failure code NATIVE_READ_WORKFLOWS_GATE_FAILED.
- Fixed stages: runtime (scripts/check-runtime.js --json), typecheck (node_modules/typescript/bin/tsc --noEmit), build (scripts/build.js), compile (tsc -p tsconfig.test.json), each exact ordered test file below, then smoke (scripts/smoke-v2-fresh-start.js). One build/compile; **34 stages:4 setup+29 tests+smoke**.

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

- [ ] **Step 1: Write failing runner tests** `workflow_gate_exact_inventory_and_single_build`, `workflow_gate_preserves_other_profiles_and_lock`, `workflow_gate_refuses_incoherent_receipts_and_identity_drift`. Pin exact29/order/stages34/max1500000/argv refusal/old native33+metadata20 unchanged. Fixed synthetic stage-root tests cover failure/cancel/timeout/Job-active-zero/drain/output lock uncertainty and non-Windows fail-closed before launch; preserve existing Windows-only skip declarations, introduce none into product behavior tests.

Assertion anchors (test-local variables come from the named fixture/observer setup):

```ts
assert.equal(stageReceipts.length, 34);
assert.equal(testStageReceipts.length, 29);
assert.equal(stageReceipts.filter(stage => stage.stage === "build").length, 1);
assert.equal(stageReceipts.filter(stage => stage.stage === "compile").length, 1);
assert.ok(stageReceipts.every(stage => stage.cleanup === "complete" && stage.closure === "windows-job-active-zero"));
```

- [ ] **Step 2: Compile and observe RED** workflow-gate plus existing native-content-gate/internal-verified-read-gate.
- [ ] **Step 3: Implement safe acceptance accounting** following the existing retained-evidence runner pattern: actual native exit/complete closure plus coherent terminal outer Node spec footer (reuse parseFinalSpecCounts export), not nested summaries or independent per-field matching. Each test stage must have tests>0, fail=cancelled=todo=0 and pass+skipped=tests. Bound ephemeral output at16MiB/stage, hash observed bytes, report counts/skips/overflow and safe code only, then discard raw text. Overflow/truncated footer/changed source/artifact/compiled inputs refuses.
- [ ] **Step 4: Bind the settled candidate** before stages to clean committed HEAD and hashes of tracked src/tests/scripts/package/lock/tsconfig inputs; after compile measure entire dist-test tree and listed test hashes, after build measure v2-build.json/buildIdentityHash/all five emitted artifacts and closure inputs. Compare candidate/source/compiled/artifact identities after smoke. No source echo, arbitrary receipt or uncommitted tree accepted. Do not include mutable memory-vault notes in product identity. Runner containment cleanup is its existing5000ms window, distinct from product2000ms cleanup.
- [ ] **Step 5: GREEN runner regressions, task reviews and commit** exact task runtime/test/package owners as `test: add bounded V2 read workflow acceptance gate`. Perform independent whole-increment spec/code-quality review against actual settled source. Fix actionable issues with only affected focused reruns/re-review, then commit them. Do not dispatch another full acceptance while reviewers/build owners overlap.
- [ ] **Step 6: Run one settled native acceptance** `npm run test:v2-native-read-workflows` from clean committed source. Success is exit0, all34 stages accounted/positive Job closure/drain, no fail/cancel/todo, no new skipped tests, exact stable source/compiled/build identities and final private workflow qualification receipt. Existing skips/platform-unexercised branches are named, not counted as proof. Unsupported non-Windows runner is a typed refusal, not Linux qualification. Later complete-product release remains both-OS.
- [ ] **Step 7: Write evidence and completion ledger** containing actual command/runtime/OS/commit/source/build/compiled/artifact identity, per-task RED/GREEN and independent reviews, exact counts/skips, actual phase fault markers/closure, stale/cursor/context proofs and retained uncertain fixture ownership. Distinguish deployed emitted-entry proof from test-only compiled fault-seam proof, naming the stage/commit for each and any docs-only subsequent HEAD. No old failed output/count or future acceptance is invented. Verify reference/whitespace/exact-doc scope, commit evidence docs, and close project memory with verify:true.

## Completion and remaining PROD work

This plan is complete only when all six task deliveries/reviews and settled private acceptance succeed. That closes private list/recent/context/radar query semantics. Public routing/governed lifecycle/write tools, operational keys/rotation/history/erasure-restoration fences, actual current Codex full-visible capture/private finalization, F3 complete backup/restore/replay/rollback and eight-scenario public-service release proof, and F4 exact approved cutover/live workflow remain. The [readiness report](../reports/2026-10-07-v2-production-readiness.md) and [capability/release coverage](../reports/2026-10-07-v2-capability-release-coverage.md) retain those requirements.

Plan self-review: each spec section maps to Tasks1–6; source consumers/independent nominal fixtures enumerated; stable interface names checked; all five Review Focus cases have owning tests; exact resource and platform distinctions retained. Task checkboxes are prospective, not executed evidence.
