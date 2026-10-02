# V2 Native Content Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver private bounded native V2 projected-content search and exact canonical-ID get on the same verified image, without opening public content or PROD.

**Architecture:** Extract database-only retrieval and pure defensive ranking conversion without changing legacy wrappers. The existing owned child runs fixed queries, converts/byte-bounds detached results, then performs its original cleanup/final admission sequence; the supervisor validates and releases content only after actual exit and ownership-record removal. Use one separate fixed native-content gate sharing the existing measured build, Windows Job bridge and output lock.

**Tech Stack:** Existing TypeScript ESM, Node.js >=24.16.0, `node:sqlite`, node:test, current projection schema 2 and project-store schema 8; no dependency additions. The compiled-process gate requires the already qualified Windows PowerShell/.NET Job environment, not a cross-platform containment claim.

**Spec:** [Approved native-content design](../specs/2026-10-02-v2-native-content-query-design.md), approved at `bedee3d71b93a49a4e23854185247887b7f43f60` with `อนุมัติสเปก V2 native content written` on 2026-10-02.

Status: Human approved this plan at `eb63704f79579d0c5e30e93041839c0e1db432ee` on 2026-10-02 with `อนุมัติแผน`; implementation is authorized within its scope. Preserve the selected Subagent-Driven method. These are six **Native content Tasks**, not a reopening of the accepted private metadata-only Tasks 1–6. Task heading order is normalized for the Superpowers brief extractor; requirements are unchanged.

Execution progress: Native content Tasks 1–5 accepted after compile-success RED, focused GREEN and independent specification / code-quality approval. All listed GREEN runs had zero skipped tests; implementation commits and attributed evidence are:

| Native task | Accepted implementation | Focused GREEN |
| --- | --- | --- |
| 1 | `71a1c57bf09281d739416faaa1009bc603f86cda` | Ten targets, 58/58 |
| 2 | `0462011b97dcfdb65bfc1b4cd7a265fbbd3f6ae2` | Seven targets, 164/164 |
| 3 | `e8faaed876e57f49e6612fa12b7e94657064c603` | Eight targets, 43/43 |
| 4 | `3fa2e2427e87a437636d9b3fec0419c944b7acad` | Five targets, 27/27 |
| 5 | `dc30263b76883cef8dbba4a71cbb011637258c55` | Ten targets, 195/195; affected refreshes 70/70, 15/15 and 12/12 |

Task 5 removes the temporary private content refusal and integrates the original owned lane. Task 6 measured emitted acceptance remains pending; these deliverables are not public availability or whole-system production acceptance. Task 5 review had no Critical/Important findings and one deferred nonblocking test-precision item: `query-budget` advances before SQL, while `packing-budget` advances at revalidation after packing. Those cases prove stage-boundary checks, not independent overruns inside each synchronous phase. Retain this qualification for whole-increment review.

Retained evidence limitation: the existing admission test reports Windows denied its rename, so that stale-handle replacement branch was not exercised on this platform (not a skipped Node test). The independent reviewer classified this pre-existing limitation as nonblocking for Task 2; retain it in final evidence and assess applicable later verification rather than silently claiming the branch ran.

## Global Constraints

- Fresh empty V2, no V1 import/search/fallback or parity facade in the query route; only owned synthetic stores are used for this increment.
- Preserve `memory_v2Status`-only registration, public content/promotion denial, `productionReady:false`, `requireFullEvidence:true`, recovery `FRESH_START_CONTENT_UNVERIFIED` and `host-capability-unverified`.
- Exactly three private operations: `verify-published-view`, `search-projected-content`, `get-canonical-record`. Read bootstrap/reply/cancel version **2** only; cleanup wire version **1** and ownership schema **1** stay unchanged.
- Content parameters: search query <=1024 UTF-8 bytes before/after NFKC+trim; exact case-sensitive get ID <=512 bytes, no normalization/trim/key/fuzzy lookup; both nonempty/control-free. Search limit defaults to **5**, integer **1..10**. Canonical `validAt` <=24 bytes and decimal `knownAt` <=9223372036854775807 are optional captured-image filters, not replay or implicit wall-clock expiry.
- Selection defaults to trusted session when bound, otherwise branch; visibility only narrows. Sessionless session visibility is invalid. Project-strong does not erase a trusted selection session; no caller session/binding/policy/SQL/path/callback/provider authority.
- Fixed search: <=**64 unique candidates**, estimated token budget **2048**, global/vector/explain disabled. Preserve `retrieval-ranking-v2-shadow-fixed-units`; add distinct private `v2-native-content-bounds-1`, not a production-certification label.
- Descriptor-first data only: depth **8**, aggregate record/array containers **128**, record fields **32**, scalar UTF-8 bytes **2048**; dense arrays only, items <=**10**, conflicts <=**64**, channels <=**7**. Encoded COMPLETE request/bootstrap <=**8192**, COMPLETE reply <=**16384** bytes, including escaping and metadata.
- Original response deadline: session-strong **2000 ms**, project-strong **5000 ms**, trusted integer override **0..30000 ms**, measured from supervisor arrival. Queue <=**8**; one read OR cleanup child; image <=**64 MiB**, manifest <=**64 KiB**, discarded stdout/stderr <=**4 KiB each**, stage+terminal <=**8**. Content adds one `query` phase between validate/revalidate; metadata omits it.
- Separate production cleanup **2000 ms**, grace <=**100 ms**; confirmed read exit before exact cleanup child. Quarantine uncertain closure; any existing ownership record, including `complete`, blocks restart until positively removed by its owner. No stale-PID kill, automatic record clearing, deadline inflation or unresolved-root deletion.
- Never clip text, fabricate full body/MD path/source event ID, upgrade status, follow a superseding ID, refill past an incomplete conflict barrier or release partial/early content. Private size failure is `V2_CONTENT_RESULT_TOO_LARGE`, not a new public error/tool.
- No schema migration/publisher repair, new public tools, host configuration/trust/capture, actual user data/credentials/transcripts, CI upload/run, push/merge/deploy/activation in this plan. F2 public/governed writes/privacy/full desktop capture, F3 new-V2 recovery/exact release proof and F4 approved live cutover remain later work.

## Review Focus

1. Multibyte/NFKC/escaped strings fit a query or item cap but overflow bootstrap/terminal overhead: refuse or truthfully byte-bound the COMPLETE envelope, never clip text — Task 2 `unicode_and_complete_bootstrap_bounds`; Task 4 `escaped_envelope_first_unit_barrier`.
2. Session-bound project-strong receipt has null session: selection still uses the bound session and rejects another session's rows — Task 3 `project_strong_keeps_trusted_selection_session`; Task 5 `supervisor_rejects_session_scope_lie`.
3. Repository-incomplete group omits an unknown high-impact sibling, or ranking selects zero members: keep its warning and suppress later units even when observed `highImpact` is false — Task 4 `repository_incomplete_and_zero_member_barriers`.
4. Requested ID equals another row's normalized key, differs in case, or points to a superseded record: exact get returns only that ID, with faithful status/reference, never a key match/sibling/successor — Task 3 `canonical_get_id_key_case_and_supersession`; Task 5 `supervisor_rejects_get_substitution`.
5. Valid terminal content precedes held exit, record removal, epoch change or expired cleanup: no success before all owned closure/acceptance proofs; preserve primary failure and quarantine — Task 5 `content_candidate_waits_for_exit_and_record_absence`; Task 6 `compiled_blocked_query_and_uncertain_closure`.

---

## Execution discipline and verification commands

Use the existing worktree `C:/Users/Server/.codex/worktrees/v2-fresh-start/Awakened-AI-System`, branch `codex/v2-fresh-start`; preserve unrelated primary-checkout changes. Do not create another checkout, change the selected method or revisit fresh/no-V1/client decisions.

At execution start read the spec plus this plan, applicable skills and project instructions; serialize MCP memory lifecycles because the vault has one current session. Dispatch one fresh implementer per Task, then fresh spec-compliance and quality reviews. Do not run overlapping implementers on shared protocol/query files. Reviewers read source/evidence without rebuilding concurrently. Reuse a Task's current focused test output; rerun only when a review fix invalidates it. The whole-increment review follows Task 6. Preserve unresolved test ownership rather than clearing locks to force progress.

Each red/green cycle below uses **two serial commands** from that worktree:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-content-contracts.test.js
```

The second line is the contracts Task example; pass the exact Task targets listed below as `dist-test/tests/<listed-name>.test.js` arguments to that same node command. Compilation must exit 0 even for RED. For a new absent module, use test-local interface declarations and dynamic lookup (for Task 1: `const path = "../../src/orchestrator/retrieval/database-core.js"; await import(path)` with only `ERR_MODULE_NOT_FOUND` mapped to undefined); assert the export exists. Do not statically import nonexistent types or count a compiler error as RED. For changed behavior in existing modules, compile successfully and observe the named assertion fail. GREEN requires command exit 0, no failed/cancelled tests; report skips separately. No `npm test`, `test:all` or full migration gate is requested for task-local reassurance.

One agent owns `dist`/`dist-test`. Run the final fixed native-content gate once after review (Task 6), with one build and one compile; do not run the legacy twenty-file gate as an additional reassurance sweep. Applicable final frozen-release checks whose inputs changed are not waived.

## File responsibilities and shared interfaces

All paths below are repository-relative; interfaces are private, with no new public barrel exports.

| Files | Responsibility / owner |
| --- | --- |
| `src/orchestrator/retrieval/database-core.ts` | Pure existing database row/query/conflict/feedback algorithms; later exact-ID get, Task 1 then Task 3 |
| `src/orchestrator/retrieval/selection-core.ts` | Pure defensive filtering and full ranking/result conversion, Task 1 |
| `retrieval/{candidates,v2-candidates,service}.ts` | Existing wrappers delegate to pure core; unchanged legacy semantics, Task 1 |
| `retrieval/{contracts,eligibility}.ts` | Query-free eligibility context shared by search/get, Task 3; no fixed ranking edits |
| `src/orchestrator/verified-read/content-contracts.ts` | Private request/DTO/query-result contracts and fixed policy names, Task 2 |
| `verified-read/wire-data.ts` | Descriptor-first bounded record/dense-array copier and complete encoded measurement, Task 2 |
| `verified-read/content-protocol.ts` | Exact parameters/results and binding/receipt/request relationships, Task 2 |
| `verified-read/{contracts,protocol}.ts` | Version-2 read union and delegation; cleanup version 1 preserved, Task 2 |
| `verified-read/content-query.ts` | Fixed query dispatch against supplied open database/manifest; no lifecycle/provider, Task 3 |
| `verified-read/content-result.ts` | Detached DTO conversion and whole-unit complete-envelope packing, Task 4 |
| `verified-read/{admission,child,supervisor}.ts`, `src/v2/internal-verified-read.entry.ts` | Metadata wire transition in Task 2, same-lane native integration in Task 5 |
| `tests/support/v2-native-content-fixture.ts` | Genuine synthetic content commands, active schema-2 image and measured deployment helpers, Task 3 then Task 6 |
| `tests/support/v2-verified-read-fixture.ts` | Update read-version seeds Task 2; additive trusted scope/synthetic append seam Task 3 |
| `tests/fixtures/v2-verified-read-process-fixture.ts` | Version-2 read seeds Task 2; test-only actual query blocking mode Task 5 |
| `scripts/fresh-start-build.js`, `tests/v2-internal-verified-read-child.test.ts` | Matching exact pure retrieval closure exceptions when the child imports the core, Task 5; emitted proof Task 6 |
| `scripts/run-v2-internal-verified-read.js`, `scripts/run-v2-native-content.js`, `package.json` | Shared owned runner plus separate fixed native-content profile, Task 6 |
| `tests/ci-lifecycle-gates.test.ts` | Explicit sorted source-diff-list reconciliation, baseline unchanged, Task 6 |
| `docs/superpowers/evidence/2026-10-02-v2-native-content-query.md`, this plan, its spec, delivery roadmap | Actual incremental acceptance/limitations only, Task 6 after evidence |

Tests are named in their owning Tasks. Existing cleanup entry, ownership implementation, publisher, migration, public V2 app/composition and build identity's five-artifact list are not feature-edit targets.

### Task 1: Native content — Extract database and selection primitives without changing wrappers

**Files:** Create `src/orchestrator/retrieval/{database-core,selection-core}.ts`; modify `src/orchestrator/retrieval/{candidates,v2-candidates,service}.ts`; create `tests/{retrieval-database-core,retrieval-selection-core}.test.ts`. Existing regressions are listed in Step 4.

**Interfaces:** `database-core.ts` exports `RetrievalProjectionManifest = ProjectionManifestV1 | ProjectionManifestV2` (types from `manifest-codec.ts`) and `collectEligibleFromProjectionDatabase(database: DatabaseSync, manifest: RetrievalProjectionManifest, input: InternalRetrievalRequest): RetrievalCandidateCollection`. Move only database algorithms, including fixed SQL/row conversion/metadata/conflict closure/feedback. `selection-core.ts` exports:

```typescript
interface FilteredCandidates {
  readonly collection: RetrievalCandidateCollection;
  readonly defensiveDrops: RedactedDropCounts;
}
filterCandidates(collection: RetrievalCandidateCollection,
  request: ValidatedInternalRetrievalRequest): FilteredCandidates;
rankingChannels(collection: RetrievalCandidateCollection): readonly (readonly RankingCandidate[])[];
selectionReason(candidate: FusedCandidate): RetrievalChannel;
resultItems(selection: RankedSelection): readonly InternalRetrievalResultItem[];
```

The existing `RankedInternalRetrievalResultItem` is structurally the same item plus already-present conflictGroupId; retain its service export without a runtime service import in the pure module. Pure modules consume only codec/metadata, contracts, eligibility, ranking and pure explanation types; no filesystem opening, stable-directory helper, leases, migration deadline/provider/custom-ranker orchestration.

- [x] **Step 1: Write `database_core_exports_and_preserves_native_and_legacy_queries` and `selection_core_preserves_complete_ranking_conversion`.** Reuse owned images from existing candidate tests, not active production paths. For the conversion test use one conflicted candidate with source position 7n, key `entity`, feedback 1200 and group eligible count 3/cursor `opaque`; assert:

```typescript
assert.equal(typeof core.collectEligibleFromProjectionDatabase, "function");
assert.deepEqual(pureCollection, legacyCollection);
assert.equal(converted.highImpact, true);
assert.equal(converted.sourceKey, "7");
assert.equal(converted.entityKey, "entity");
assert.equal(converted.feedbackScoreUnits, 1200);
assert.equal(converted.conflictTotalMemberCount, 3);
assert.equal(converted.conflictCursor, "opaque");
assert.equal(converted.estimatedTokens, legacyEstimatedTokens);
assert.deepEqual(pureSelectedItems, legacySelectedItems);
```

Include a defensively denied conflict member to pin scoped counts, and equal-score/source/entity diversity plus feedback order. The test's source-graph assertion follows runtime imports and rejects helper, filesystem-opening, subprocess/thread/provider paths.
- [x] **Step 2: Run RED** with `npm run test:build`, then the exact two compiled new test files. Expected: export-presence assertion fails, compilation succeeds.
- [x] **Step 3: Implement the declared exports and delegate wrappers.** Move existing bodies, not ranking weights/selector behavior. Runtime manifest types/decoding must use `manifest-codec.ts` and metadata verification `image-metadata.ts`; `candidates.ts` retains pathname/opening and its existing exported database seam as a re-export. `v2-candidates.ts` delegates pure queries after its current lease validation; `service.ts` calls the full `rankingChannels`, never raw `collection.channels` directly in fusion. Preserve source-aware feedback, highImpact, conflict totals/cursor and custom ranker/explain/vector orchestration outside the core.
- [x] **Step 4: Run GREEN** after one `npm run test:build`: exact compiled files `retrieval-database-core`, `retrieval-selection-core`, `retrieval-candidates`, `v2-retrieval-candidates`, `retrieval-service`, `retrieval-ranking`, `retrieval-eligibility`, `projection-runtime`, `retrieval-explain`, `retrieval-vector-cache` (each under `dist-test/tests/*.test.js`, same serial node command). Expected: exit 0; unchanged wrapper ordering/bounds/feature behavior. If source inspection shows a changed parity/evaluation input, refresh only its affected named case and record that reason; do not sweep migration suites.
- [x] **Step 5: Review and commit the extracted deliverable** after exact spec/quality gates. Stage only the five production files and two new tests named above; `git diff --cached --check`, then `git commit -m "refactor: extract pure retrieval database and selection cores"`. Record focused evidence and source commit; do not mark native content integration complete.

### Task 2: Native content — Exact content contracts and version-2 read wire

**Files:** Create `src/orchestrator/verified-read/{content-contracts,wire-data,content-protocol}.ts` and `tests/v2-native-content-contracts.test.ts`; modify `verified-read/{contracts,protocol,admission,child,supervisor}.ts`, `src/v2/internal-verified-read.entry.ts`, `tests/support/v2-verified-read-fixture.ts`, `tests/fixtures/v2-verified-read-process-fixture.ts`, and affected `tests/v2-internal-verified-read-{contracts,admission,child,supervisor,entry}.test.ts` read-version expectations. Cleanup's independent v1 values are not replaced.

**Interfaces:** In `contracts.ts`, retain metadata shape as `MetadataVerifiedReadRequest`, define `VerifiedReadRequest = MetadataVerifiedReadRequest | VerifiedContentReadRequest`, and `ReadSuccessBase` with exact `{version:2, ids:ReadMessageIds, kind:"success", receipt:VerifiedReadReceipt, fence:ReadFence, closed:{image:true,reader:true,lock:true}}`. `ReadReply` is a strict v2 stage/failure/metadata-success/content-success union. `ReadCancel` is v2. `ReadPhase` gains `query`; private failure union gains `V2_CONTENT_RESULT_TOO_LARGE`. Metadata success forbids content; content success requires matching content. Cleanup types/decoders remain v1, ownership v1.

`content-contracts.ts` exports:

```typescript
type NativeContentFilters = Readonly<{
  visibility?: RetrievalVisibility; validAt?: string; knownAt?: string;
}>;
type SearchProjectedContentRequest = Readonly<{
  operation: "search-projected-content"; consistency: MetadataVerifiedReadRequest["consistency"];
  minimumEventPosition: string; budgetMs: number;
  parameters: NativeContentFilters & Readonly<{query: string; limit?: number}>;
}>;
type GetCanonicalRecordRequest = Readonly<{
  operation: "get-canonical-record"; consistency: MetadataVerifiedReadRequest["consistency"];
  minimumEventPosition: string; budgetMs: number;
  parameters: NativeContentFilters & Readonly<{id: string}>;
}>;
type VerifiedContentReadRequest = SearchProjectedContentRequest | GetCanonicalRecordRequest;
type NativeContentResult = NativeSearchResult | NativeGetResult;
type VerifiedContentReadResult = Readonly<{receipt: VerifiedReadReceipt; content: NativeContentResult}>;
```

`NativeSelectionScope` is exactly the spec's six fields. `NativeContentItem` is exactly its 19 scalar fields (current `RetrievalItem` enums, nullable values; positions become canonical decimal strings; `summary` becomes full `text` plus exact `textKind`). `NativeSearchItem` adds channels/selectionReason. Define `NativeSearchConflict`, `NativeGetConflict`, `NativeSearchResult`, `NativeGetResult` using all and only spec section 5 fields, including three search booleans and both policy strings. Freeze exported fixed names `NATIVE_CONTENT_BOUNDS_VERSION = "v2-native-content-bounds-1"` and `NATIVE_CONTENT_RANKING_VERSION = "retrieval-ranking-v2-shadow-fixed-units"`; no caller setter.

`wire-data.ts` exports `copyBoundedProtocolData(value: unknown, maximumBytes: 8192 | 16384): unknown` and `encodedProtocolBytes(value: unknown): number`; copy is descriptor-first, charge actual JSON-escaped bytes during bounded copying, never invoke getters/toJSON/iterators. Measurement accepts only already copied data and does not grant validation. `content-protocol.ts` exports:

```typescript
decodeNativeContentParameters(operation: VerifiedContentReadRequest["operation"],
  value: unknown, trustedSession: TrustedReadSession | null):
  SearchProjectedContentRequest["parameters"] | GetCanonicalRecordRequest["parameters"];
decodeNativeContentResult(value: unknown): NativeContentResult;
assertNativeContentMatchesRequest(content: NativeContentResult, request: VerifiedContentReadRequest,
  binding: VerifiedReadBinding, receipt: VerifiedReadReceipt): void;
```

Existing `decodeVerifiedReadRequest`, `decodeReadBootstrap`, `decodeReadReply`, `decodeReadCancel`, `decodeVerifiedReadReceipt` keep names and consume these exact types. Result assertion validates every item scope/session/time/position, exact get ID/kind, search duplicate `(kind,id)`/channel/reason/limit, conflict count relationships and operation/scope/policy identities. It is pure and shared by child/supervisor; complete envelope size remains the outer decoder's responsibility.

- [x] **Step 1: Write `unicode_and_complete_bootstrap_bounds`, `strict_v2_variants_and_dense_arrays` and `content_relationships_and_metadata_shape`.** Test-local DTO seeds have exactly the declared fields. Include NFKC expansion, raw/pre-normalized >1024, 512-byte exact ID boundary and unchanged case/space, limit omitted/1/10 vs 0/11, noncanonical timestamps/decimals/INT64 overflow and sessionless session selector. Array cases: holes, accessor index, symbol/extra own property, exotic prototype, duplicate channels and >10/64/7. Assert zero getter/toJSON calls, container 128/129, depth 8/9, scalar 2048/2049 and full request/bootstrap/reply 8192/8193 and 16384/16385 with escaping:

```typescript
assert.equal(decodeSearch(defaultLimitInput).parameters.limit, 5);
assert.equal(decodeGet(caseSensitiveInput).parameters.id, "Case-ID ");
assert.equal(getterCalls, 0);
assert.equal(toJSONCalls, 0);
assert.throws(() => decodeReadBootstrap(version1Input));
assert.throws(() => decodeReadReply(version1Reply));
assert.throws(() => decodeReadCancel(version1Cancel));
assert.equal(decodeCleanupBootstrap(cleanupVersion1).version, 1);
assert.throws(() => decodeReadReply(metadataWithContent));
assert.throws(() => decodeReadReply(contentWithoutContent));
assert.throws(() => assertNativeContentMatchesRequest(wrongScopeResult, request, binding, receipt));
```

`decodeSearch`/`decodeGet` in this snippet mean the existing request decoder narrowed by discriminant, not extra production exports. Relationship cases also reject known>source, source>image, get successor substitution, duplicate group IDs, returned-count mismatch, false truncation and receipt operation mismatch. Assert diagnostics/failures contain no input query/ID/text/runtime path/token/raw SQL.
- [x] **Step 2: Run RED** after successful compile: exact `v2-native-content-contracts.test.js`. Expected missing content decoder/export or version-2 behavior assertion, not a compiler failure.
- [x] **Step 3: Implement contracts/copier/decoders and metadata v2 transition.** Bound generic arrays to at most 64 then apply operation-specific caps; exact descriptor/prototype checks precede access. Update binding-copy dummy bootstrap in admission/supervisor and fixed read entry's send/cancel/stage/failure/success versions to 2. Keep `verify` metadata-only, its returned receipt shape unchanged. Until Task 5, explicitly fail content execution closed with `FRESH_START_INPUT_INVALID`; do not produce a fake metadata receipt for a newly decoded content operation. Such temporary fail-closed behavior is documented as unfinished integration, not accepted content support. The private new code is not added to the public error registry.
- [x] **Step 4: Run GREEN** after one compile: new contracts and existing `v2-internal-verified-read-{contracts,admission,child,supervisor,cleanup,ownership}` compiled files. Expected exit 0, metadata no query stage/content, strict new read v2, independent cleanup v1/ownership v1/restart unchanged. Save compiled-entry behavior for Task 6's measured rebuild; do not use old `dist` to claim new-source acceptance.
- [x] **Step 5: Review and commit** only the Task 2 named files actually changed and new test, with exact staging and `git diff --cached --check`; `git commit -m "feat: define bounded native content read protocol v2"`. Keep this independent deliverable's temporary content refusal explicit.

### Task 3: Native content — Fixed native search and ID-only canonical lookup

**Files:** Create `src/orchestrator/verified-read/content-query.ts`, `tests/support/v2-native-content-fixture.ts`, `tests/v2-native-content-query.test.ts`; modify `retrieval/{database-core,contracts,eligibility}.ts` and additive synthetic seam in `tests/support/v2-verified-read-fixture.ts`.

**Interfaces:** `retrieval/contracts.ts` adds query-free `RetrievalEligibilityContext = Readonly<Pick<InternalRetrievalRequest, "binding" | "sessionId" | "visibility" | "validAt" | "knownAt">>`. Eligibility predicate parameters widen from full request to this structural context; existing search remains compatible. In `database-core.ts` export:

```typescript
type CanonicalLookupContext = RetrievalEligibilityContext & Readonly<{id: string}>;
type CanonicalLookup = Readonly<{
  item: RetrievalItem | null; eligibleConflictMemberCount: number | null;
}>;
getCanonicalFromProjectionDatabase(database: DatabaseSync, manifest: ProjectionManifestV2,
  context: CanonicalLookupContext): CanonicalLookup;
```

No fake `query` is required for get. It runs exact parameterized `project_id` AND case-sensitive `item_id` predicates and shares actual metadata/row conversion/eligibility. An eligible grouped item gets only the same group's eligible count; null item always has null count.

`content-query.ts` exports `NativeQueryContext = Readonly<{request:VerifiedContentReadRequest; binding:VerifiedReadBinding; receipt:VerifiedReadReceipt; remainingMs:number}>`, `NativeQueryCandidate` and `queryNativeContent(database: DatabaseSync, manifest: ProjectionManifestV2, context: NativeQueryContext): NativeQueryCandidate`. Candidate is a discriminated search `{operation, selectionScope, rankedCandidates:readonly RerankedCandidate[], selection:RankedSelection, conflictGroups:readonly RetrievalConflictGroup[], candidateBounded:boolean}` or get `{operation, selectionScope, lookup:CanonicalLookup}`. The search candidate keeps all considered group counts and full ranked first-appearance order for Task 4, including zero-selected groups. No candidate crosses IPC.

Test helpers: export `ReadFixtureOptions = Readonly<{branchScopeId?:string|null; branchRef?:string|null; session?:TrustedReadSession|null}>` and add it to existing `makeActiveReadFixture(buildHash = READ_HASH, options: ReadFixtureOptions = {})`; construct binding/project context and real synthetic branch/session rows consistently, not merely a claimed binding override. Add returned test-only `appendSynthetic(command: AppendCommand<JsonValue>): {position:string;hash:string}` using the existing owned `EventStore`, actual committed positions/hash and same admission. Existing zero-argument `append()`/`publish()` behavior stays intact. New `makeNativeContentFixture(buildHash = READ_HASH, options: ReadFixtureOptions = {}): Promise<NativeContentFixture>` delegates real active setup. Define `NativeContentFixture = Awaited<ReturnType<typeof makeActiveReadFixture>> & Readonly<{appendCorpus():Promise<NativeCorpus>; captureImage():Readonly<{database:DatabaseSync;manifest:ProjectionManifestV2;close():void}>}>`; capture uses actual published bytes plus `openImmutableProjectionImage`, not a pathname reopen in production. Define `NativeCorpus` as `{ids:{canonical,lexical,artifact,checkpoint,openFollowUp,blockedFollowUp,superseded,successor,keyCollision,conflictMemberA,conflictMemberB}:string; sessionIds:{trusted:string;other:string}; conflictGroupId:string; sourcePositions:Readonly<Record<keyof NativeCorpus["ids"],string>>}` with all nested records readonly. Each named source position is the actual committed position that supplied that item's projected text, not a placeholder. Add `nativeSearchRequest(overrides?: Partial<SearchProjectedContentRequest>): SearchProjectedContentRequest` and `nativeGetRequest(id:string, filters?:NativeContentFilters): GetCanonicalRecordRequest` as test seeds only. No existing local parity fixture is promoted into authority.

Controller execution ruling (2026-10-02, Task 3 fixture timing only; not a new human approval): await the test-only corpus helper because the existing authorized lifecycle runtime executes through a Promise. Preserve true empty genesis before corpus creation, generic EventStore appendSynthetic admission, real capability proofs and all production schema/guards. Cost if wrong: fixture await-site maintenance. No specification or other Task requirement changes.

- [x] **Step 1: Write `native_schema2_channels_and_fixed_selection`, `canonical_get_id_key_case_and_supersession`, `project_strong_keeps_trusted_selection_session` and `sql_and_defensive_eligibility_agree`.** Build genuine nonempty schema-2 images with production builder/publish and committed synthetic commands, exercising exact/key, lexical, artifact/path, checkpoint, open/blocked follow-up and conflict closure; alias stays empty. Test query `'" OR *'` uses escaped fixed FTS construction, not raw SQL. Verify deterministic policy feedback/diversity and 65+ candidates bound at 64, fixed token budget 2048. Use a canonical requested ID also present as another row's normalized key, plus case-different ID and superseded reference:

```typescript
assert.equal(get.lookup.item?.id, requestedId);
assert.equal(get.lookup.item?.status, "superseded");
assert.equal(get.lookup.item?.supersedingItemId, successorId);
assert.equal(caseDifferent.lookup.item, null);
assert.deepEqual(missing.lookup, foreign.lookup);
assert.deepEqual(missing.lookup, denied.lookup);
assert.equal(grouped.lookup.eligibleConflictMemberCount, 2);
assert.equal(search.selectionScope.sessionId, trustedSessionId);
assert.equal(projectStrongReceipt.scope.sessionId, null);
assert.ok(search.rankedCandidates.every(c => c.item?.sessionId !== otherSessionId));
assert.ok(uniqueCandidateIds.size <= 64);
assert.ok(search.selection.usedTokens <= 2048);
```

Pin candidate/provisional/verified/conflicted/superseded fidelity; deny retracted/expired/erased-evidence, wrong project/workspace/branch/session, validAt half-open boundary, knownAt and ahead-of-image source. Inject an ineligible conflict member into the collection in a pure defensive test and prove it is removed before fusion, not inheriting sibling scope. Malformed row/schema error throws integrity failure, not absence. Verify source/hash/event position is real and no read appends or publisher changes occur. Empty genesis yields empty/absent; later committed-position publish yields content. Fixture `captureImage` is only a test setup seam and never called from supervisor.
- [x] **Step 2: Run RED** after compile: `v2-native-content-query.test.js`. Expected missing query/lookup export or exact-ID assertion fails while compilation succeeds.
- [x] **Step 3: Implement exact lookup and fixed dispatcher.** Consumes Task 1's pure collection/filter/full ranking conversion and current default fusion/rerank/selection, with internally built validated search request: binding from image authority, session from trusted binding, required position from receipt, deadline remaining from original read, fixed candidate/token caps and disabled optional features. Apply SQL plus defensive predicates and validate source<=image/known<=source before returning internal candidates. Get shares the query-free context; any query/row integrity exception maps to existing bounded integrity/scope families, not null.
- [x] **Step 4: Run GREEN** after one compile: `v2-native-content-query`, `retrieval-database-core`, `retrieval-selection-core`, `retrieval-candidates`, `v2-retrieval-candidates`, `retrieval-eligibility`, `retrieval-service`, `retrieval-ranking`. Expected exit 0, truthful empty/absence and no key/successor substitution. Record fixture sources and actual schema/hash; `ownedReadImage` is not content acceptance.
- [x] **Step 5: Review and commit** exact Task 3 files with staged diff check; `git commit -m "feat: query native V2 search and exact canonical records"`. Backend unit acceptance does not remove Task 2's temporary child refusal.

### Task 4: Native content — Detached DTOs and conservative complete-envelope packing

**Files:** Create `src/orchestrator/verified-read/content-result.ts` and `tests/v2-native-content-result.test.ts`.

**Interfaces:** Consume `NativeQueryCandidate` from Task 3, `ReadSuccessBase`/DTOs from Task 2 and its bounded measurement/copy/relationship helpers. Export `buildNativeContentResult(candidate: NativeQueryCandidate, base: ReadSuccessBase): NativeContentResult`. `base` reserves a complete prospective success envelope; it is not a cleanup attestation or permission to emit before Task 5. Caller supplies real IDs/receipt/fence; result conversion copies exactly the spec's DTO fields, positions to decimals, full summary to text, canonical-summary vs projection-text, explicit nulls and faithful status. No normalizedKey/anchor/cursor/source event ID/runtime objects leak.

- [x] **Step 1: Write `repository_incomplete_and_zero_member_barriers`, `escaped_envelope_first_unit_barrier`, `mandatory_metadata_and_get_are_all_or_nothing` and `detached_projection_text_status_and_positions`.** Construct test-local internal candidates using declared Task 3 types and fixed ranked order; do not change legacy selector. Assert observed low-impact group selected count 1/eligible count 2 blocks a later item, and zero-selected group at its first appearance blocks all later units. Whole selected group byte overflow emits none of that group (never a fitting subset); retain every considered descriptor including zero returned. UTF-8/escaped quotes/backslashes and long IDs/receipt fields test complete envelope, first oversized unit and mandatory metadata failure:

```typescript
assert.equal(result.contentBoundsVersion, "v2-native-content-bounds-1");
assert.equal(result.rankingPolicyVersion, "retrieval-ranking-v2-shadow-fixed-units");
assert.equal(result.selectionTruncated, true);
assert.equal(result.conflicts[0]?.highImpact, false);
assert.equal(result.conflicts[0]?.truncated, true);
assert.ok(!result.items.some(item => item.id === laterId));
assert.equal(zeroMember.conflicts[0]?.returnedMemberCount, 0);
assert.equal(firstOversized.items.length, 0);
assert.equal(firstOversized.byteBounded, true);
assert.ok(encodedProtocolBytes({ ...base, content: result }) <= 16384);
assert.equal(result.items[0]?.text, fullUnclippedProjectedText);
assert.throws(() => buildNativeContentResult(oversizedGet, base),
  {code: "V2_CONTENT_RESULT_TOO_LARGE"});
```

Also exercise scalar 2048/2049, container 128/129, mandatory descriptors exceeding capacity, empty valid text, no ineligible-group count disclosure, no mutation of query candidates, determinism across repeated packing and exact get conflict returned=1/truncated=count>1. All relationships pass Task 2 assertion; absent get is both item/conflict null, not size fallback.
- [x] **Step 2: Run RED** after compile: `v2-native-content-result.test.js`. Expected missing packing export or first-unit/barrier/size assertion failure.
- [x] **Step 3: Implement `buildNativeContentResult` with fixed first-appearance units.** Construct selected groups as indivisible units and ungrouped selected items as singleton units; use ranked candidates for first appearance, including considered groups with no selected members. Reserve ALL considered group descriptors plus complete base before items. For each prospective unit recalculate returned counts/truncation/booleans and run complete-envelope limits; first field/container/message failure drops that unit and everything after it, `byteBounded:true`. On any selected<eligible group emit its fitting selected unit then stop and `selectionTruncated:true`; zero group stops without items. Never refill/reorder/clip, regardless of highImpact. If mandatory metadata cannot fit throw private size failure. Get copies its single exact item completely or throws that same failure. Final copy/freeze and full-envelope recheck is mandatory.
- [x] **Step 4: Run GREEN** after one compile: `v2-native-content-result`, `v2-native-content-contracts`, `v2-native-content-query`, `retrieval-ranking`, `retrieval-selection-core`. Expected exit 0 and unchanged legacy policy/selector; new suppression is confined to the separately named content-bounds policy.
- [x] **Step 5: Review and commit** exactly the new source/test after staged diff check; `git commit -m "feat: bound detached native content by complete envelopes"`.

### Task 5: Native content — Execute queries in the owned lane and release only settled content

**Files:** Modify `src/orchestrator/verified-read/{child,supervisor}.ts`, `scripts/fresh-start-build.js`, `tests/fixtures/v2-verified-read-process-fixture.ts`; create `tests/v2-native-content-{child,supervisor}.test.ts`; update `tests/v2-internal-verified-read-child.test.ts`'s source graph and affected metadata child/supervisor test doubles. Admission/entry already speak v2 from Task 2; change them only if a concrete integration assertion identifies required dispatch typing, not admission policy.

**Interfaces:** Keep `executeVerifiedRead(bootstrap: ReadBootstrap, dependencies: VerifiedReadChildDependencies): Promise<ReadTerminalReply>` and its dependencies unchanged (no production query callback). Remove temporary content refusal; import the fixed Task 3/4 functions in child only. Extend `VerifiedReadAdapter` with:

```typescript
verify(request: MetadataVerifiedReadRequest, options?: {signal?: AbortSignal}): Promise<VerifiedReadReceipt>;
query(request: VerifiedContentReadRequest, options?: {signal?: AbortSignal}): Promise<VerifiedContentReadResult>;
diagnostic(): VerifiedReadDiagnostic;
close(): Promise<VerifiedReadDiagnostic>;
```

Both operations use the same internal queue/lane, original arrival timestamp and ownership state machine. Metadata returns its original receipt; content returns frozen `{receipt,content}` only. Shared internal pending entries/settlement store an exact validated terminal candidate, not receipt-only state or a second executor. No new public composition registration.

- [x] **Step 1: Write `child_queries_same_image_and_final_authority`, `supervisor_rejects_session_scope_lie`, `supervisor_rejects_get_substitution`, `content_candidate_waits_for_exit_and_record_absence` and `original_budget_and_cleanup_preserve_primary_failure`.** Use genuine Task 3 synthetic images/authority for child integration and deterministic port/clock barriers for supervisor races. Replace/rename published pathname after capture and prove original image supplies original text/positions; actual wrong SHA/metadata/source anchor refuses. Ordinary later commit is permitted; transition before final authoritative observation refuses, not an invented network-delivery fence. Forged reply tests mutate operation, trusted session scope despite project-strong null receipt session, source position/count/limit and exact get ID/kind independently. Acceptance assertions:

```typescript
assert.equal(settled, false); // terminal received, exit deliberately held
assert.equal(settled, false); // normal exit observed, record removal deliberately held
assert.equal(result.content.operation, request.operation); // only after actual absence
assert.equal(Object.isFrozen(result.content), true);
assert.equal(epochChangedOutcome.code, "FRESH_START_ADMISSION_STALE");
assert.equal(expiredOutcome.code, "WORKER_TIMEOUT");
assert.equal(expiredOutcome.cleanup, "incomplete"); // deliberate missing closure proof
assert.equal(primaryIntegrityOutcome.code, "INTEGRITY_FAILURE");
assert.equal(primaryIntegrityOutcome.cleanup, "incomplete");
assert.equal(activeReadOrCleanupChildrenMaximum, 1);
assert.equal(unrelatedWriterKilled, false);
```

Queue+startup+query+packing+exit share one original budget; zero-budget/no child, queued cancellation, queue ninth refusal, late terminal, duplicate terminal, too many messages and metadata no query phase are pinned. Image close, exact lock release, final snapshot, reader close, normal exit and actual ownership unlink each have independently isolated failure/barrier cases; no copied synthetic assertion alone proves real closure. Persisted `complete` still blocks until actual absence. Diagnostics never contain query/id/text/SQL or ownership path/token.
- [x] **Step 2: Run RED** after compile: exact new `v2-native-content-child` and `v2-native-content-supervisor` files. Expected current temporary content refusal/missing query export or held-exit validation assertion failure, not compilation failure.
- [x] **Step 3: Integrate fixed query/packing at the exact image boundary.** After current SHA/manifest/metadata validation, emit at most one content-only `query` stage, call fixed query using opened image and receipt, then build content against prospective full terminal base. Continue original close-image/release-lock/revalidate/close-reader sequence and produce exact v2 terminal only after success. Check original remaining budget around synchronous phases; native SQL/packing is not promised preemptible. Supervisor decodes/copies/freezes whole reply, compares receipt operation and all Task 2 result relationships, enforces request-specific ordered metadata five/content six phases and <=8 messages, discards late/epoch-invalid candidates, and releases only after exit plus positively completed record removal. Preserve original production cleanup window and primary-error/cleanup separation; no deadline reset.
- [x] **Step 4: Permit only the exact pure dependency graph needed by this child import.** In `scripts/fresh-start-build.js` and mirrored existing child source-graph test, replace only wholesale `/retrieval/` ban with exact permitted runtime paths: `database-core.ts`, `selection-core.ts`, `contracts.ts`, `eligibility.ts`, `ranking.ts`. Keep `candidates.ts`, `v2-candidates.ts`, `service.ts`, evaluation/providers/lease wrappers forbidden and all helper/process/thread/static/emitted syntax denials intact. Add source-graph positive/negative assertions; no directory/wildcard permit or `scripts/build.js` loader relaxation. This belongs here so Task 5's existing source-closure regression can pass independently; actual emitted acceptance is still Task 6.
- [x] **Step 5: Add the fixed test-only `query-hang` executable mode** in the existing process fixture. Before calling actual `executeVerifiedRead`, install a fixture-process-only interceptor on `DatabaseSync.prototype.prepare` that recognizes the fixed native canonical content SELECT, requires the observed `query` stage, then writes readiness and blocks via `Atomics.wait` before executing that statement. Metadata/admission SQL does not trigger it. Parent proves the marker occurs AFTER actual image validation and owned lock, expires response while that exact disposable query process is blocked, and observes read exit, cleanup exit and independent writer survival. No production query dependency/argv/env/bootstrap fault field is added. Successful actual compiled operations are separately proved in Task 6; the fault harness does not claim arbitrary production SQL injection or RSS containment.
- [x] **Step 6: Run GREEN** after one compile: new child/supervisor plus `v2-native-content-{contracts,query,result}`, existing `v2-internal-verified-read-{admission,child,supervisor,cleanup,ownership}`. Expected exit 0; source closure admits only reviewed pure paths, actual blocked process parent remains responsive and no late/early content escapes. Record uncertain cleanup roots without deleting them.
- [x] **Step 7: Review and commit** exact changed Task 5 paths with staged diff check; `git commit -m "feat: execute native content inside settled verified read lanes"`. Real emitted bundle acceptance remains Task 6, not an old-build claim.

### Task 6: Native content — Measured compiled acceptance and one fixed targeted gate

**Files:** Modify `scripts/run-v2-internal-verified-read.js`, `package.json`, `tests/v2-internal-verified-read-gate.test.ts`, `tests/ci-lifecycle-gates.test.ts`, `tests/support/v2-native-content-fixture.ts`; create `scripts/run-v2-native-content.js`, `tests/v2-native-content-{entry,gate}.test.ts`. Verify Task 5's build/source closure without repeating its edits. After acceptance create `docs/superpowers/evidence/2026-10-02-v2-native-content-query.md` and update this plan/spec plus `docs/superpowers/plans/2026-09-29-v2-fresh-start-delivery-roadmap.md` status only.

**Interfaces:** Extend `runVerifiedReadGate({root=repository, timeoutMs=900000, signal, profile="metadata"} = {}): Promise<number>` with exact internal enum `"metadata" | "native-content"`. No arbitrary files/commands/stage callbacks/CLI profile input; root remains existing test seam only. Default metadata targets/count/CLI remain exactly twenty unchanged. Thin `scripts/run-v2-native-content.js` CLI accepts no arguments and invokes fixed `profile:"native-content"`; package adds only `"test:v2-native-content": "node scripts/run-v2-native-content.js"`. Both profiles share exclusive `.fresh-start-foundation.lock`, existing serial stage machinery and Windows Job closure. Test-gate 900000 ms total and 5000 ms cleanup remain test-only, not production deadlines. Unknown profile/CLI args fail before launching any process.

Native fixed stages: one existing `scripts/build.js` build, one existing `tsconfig.test.json` compilation, each of the **33** exact compiled targets below serially, then `scripts/smoke-v2-fresh-start.js`. Pass text uses native profile's actual count, never default twenty's claim:

```text
retrieval-database-core
retrieval-selection-core
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
retrieval-candidates
v2-retrieval-candidates
retrieval-eligibility
retrieval-ranking
retrieval-service
projection-runtime
retrieval-explain
retrieval-vector-cache
stable-directory-read-core
projection-image-metadata
projection-manifest
projection-integrity
v2-reader-lease
v2-foundation-entry
ci-fresh-start-foundation
ci-lifecycle-gates
```

Every name resolves to `dist-test/tests/<name>.test.js`. Do not add migration runner/import/parity full suites. Exact directly affected parity/evaluation cases triggered in Task 1 may be additional individually justified checks, not a silent profile expansion or deletion of existing default/full/migration profiles.

- [ ] **Step 1: Write `compiled_native_schema2_operations_and_public_denial`, `compiled_blocked_query_and_uncertain_closure`, `native_profile_preserves_default_and_owns_outputs`, and `pure_retrieval_closure_is_exact`.** Extend test fixture with `deployMeasuredNativeFixture(options: ReadFixtureOptions = {}): Promise<NativeContentFixture>`: read current build manifest identity, copy the same existing five compiled artifacts and manifest to identity-checked owned deployment, set trusted internal deployment directory, create release with measured build hash. No new artifact is added. Execute actual compiled search/get/metadata against genuine owned schema-2 content, empty genesis and later committed minimum positions; bind sessions for checkpoint/follow-up, reopen a new private adapter for later reads. Assertions include:

```typescript
assert.equal(search.content.operation, "search-projected-content");
assert.equal(get.content.operation, "get-canonical-record");
assert.equal(get.content.item?.textKind, "canonical-summary");
assert.equal(get.content.item?.text, committedProjectedSummary);
assert.equal(get.receipt.imageSha256, actualCapturedImageSha256);
assert.equal(v1SentinelReads, 0);
assert.equal(v1SentinelWrites, 0);
assert.deepEqual(publicTools, ["memory_v2Status"]);
assert.equal(publicStatus.productionReady, false);
assert.equal(effectiveEvidencePolicy.requireFullEvidence, true);
assert.equal(artifactCount, 5);
assert.equal(defaultMetadataTrace.testStages.length, 20);
assert.equal(nativeTrace.testStages.length, 33);
assert.equal(nativeTrace.buildStages, 1);
assert.equal(nativeTrace.compileStages, 1);
assert.equal(overlappingOutputOwners, 0);
```

Controller preflight clarification (2026-10-02): `effectiveEvidencePolicy` is returned by the existing production `deriveEffectiveQualityPolicyV1` with synthetic trusted=true/requested=false inputs; assert the actual coverage-only classifier refuses success with `EVIDENCE_CAPTURE_INCOMPLETE`. This proves policy-helper behavior, not compiled launch/live configuration. `V2LaunchConfig` has paths and releaseId only; actual requireFullEvidence=true wiring before primary cutover remains F2. No runtime field/wiring, spec change or new human approval is inferred.

Gate tests use small owned stage fixtures, not recursively executing all gate suites. Prove shared lock refusal, unknown profile/extra argv no child, positive Job tree active-zero before next stage, timeout/cancel and uncertain lock retained. Production actual blocked read uses Task 5's fixed test process port separately; assert responsiveness, exact read/cleanup exits/record removal and unrelated writer survival. Bundle negative controls isolate wrong deployment/source echo/unbundled code refusal independently from stored authority mismatch; instrument owned V1 sentinel, never live vault. Source AND emitted closures deny subprocess/thread/helper facades; cleanup graph stays query-free.
- [ ] **Step 2: Run RED** after successful compile: exact `v2-native-content-gate.test.js` with synthetic stage fixtures. Expected fixed-profile/wrapper behavioral failure, not a missing old artifact mistaken for new build proof. Source-only closure checks can already pass from Task 5; actual compiled operations cannot be called acceptance until Step 5 builds current source.
- [ ] **Step 3: Reconcile the exact source list while preserving closure isolation.** Task 5's exact pure-path exceptions remain; emitted verification proves the new private content modules enter the read graph, not cleanup. Five-artifact list remains `v2.js`, `v2-admin.js`, `workers/project-store.worker.js`, `internal/v2-internal-verified-read.js`, `internal/v2-internal-verified-read-cleanup.js`.

Reconcile sorted `APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF` in `tests/ci-lifecycle-gates.test.ts` with exact new/changed source paths, retaining baseline `68e77fa10165c99243ded1e8c1c80d1e0f7da92f`. Include the sixteen pre-existing accepted omitted paths: projections `image-metadata.ts`, `immutable-image.ts`, `manifest-codec.ts`, `stable-directory-read-core.ts`, `v2-reader-lease.ts`; retrieval `candidates.ts`; storage `event-chain-constants.ts`; verified-read `admission.ts`, `child.ts`, `cleanup.ts`, `contracts.ts`, `ownership.ts`, `protocol.ts`, `supervisor.ts`; V2 `internal-verified-read.entry.ts`, `internal-verified-read-cleanup.entry.ts`. Add this increment's exact pure/core/content paths and actual modified `retrieval/{contracts,eligibility,v2-candidates}.ts` where missing. Do not move baseline or infer a prior executed failure; this is stale-list reconciliation. Keep dynamic production-entry inventory and exact `PREPARED_IMPORTS` caller-target pairs, add only a demonstrated new required pair; no public foundation wiring/directory exemption.
- [ ] **Step 4: Implement the fixed profile and thin no-argument wrapper** using the existing shared Job/lock/monotonic-deadline stage functions, not a duplicated runner. Match the exact 33-name native list; preserve default twenty-name trace/CLI and `npm test`, `test:all`, `test:migration`, `test:build-artifacts`. Stage stdout identifies profile, stage, actual outcome/elapsed and closure/cleanup; never report direct child exit alone as tree closure. Nonqualified platform fails closed with truthful limitation, not skipped-as-PASS.
- [ ] **Step 5: Run final current-source verification once.** Run `npm run typecheck` then `npm run test:v2-native-content` serially. Expected typecheck exit 0; native gate one build/compile, all 33 named files and fresh-start smoke succeed, positive process-tree closure and output lock removed by its owner. Record actual per-test counts/skips, profile outcome, source commit/worktree diff, runtime/platform and new build/closure hashes; no fixed speculative pass count. If a failure occurs, investigate only its cause and rerun the invalidated affected checks; retain uncertain owner/root evidence and ask direction if new authority is needed. Do not inflate production deadlines or run unchanged full migration/F1 gates for reassurance.
- [ ] **Step 6: Obtain whole-increment review** after all per-Task spec/quality reviews, using frozen actual source/diff and evidence. Reviewer checks interfaces, all five Review Focus cases, actual emitted closure, same-image/fence and real blocked query proof; no parallel recompilation. Fix in scope and refresh invalidated evidence only. A discovered design deviation goes back to human review, not silent policy change.
- [ ] **Step 7: Write actual acceptance evidence and update truthful status.** Evidence file records exact accepted implementation source, build identity/artifact closure, commands/results/skips/cleanup, native channel/get/citation semantics and ownership controls. Link accepted old private evidence as unchanged baseline only, not rerun proof. Mark these six Native content Tasks complete only after their required gates; roadmap distinguishes private backend from unfinished public tools/list/recent/context/radar, governed writes/privacy/full current-desktop capture, F3/F4. Keep PROD false and no-ready-marker; do not mark the whole system ready.
- [ ] **Step 8: Review and commit the exact Task 6 file set** with no output/build artifacts/locks/evidence roots staged, `git diff --cached --check`, then `git commit -m "test: qualify native content queries with a fixed owned gate"`. Record final commit and documentation-only follow-up commit separately if needed to avoid claiming a build qualified a later implementation change. Successful serialized memory sessionEnd with precise outcomes/verification and `verify:true` closes the increment; unresolved follow-ups remain explicit.

## Inline plan self-review and handoff

Coverage map: spec 1 scope/public limits → Global Constraints and Task 6; spec 2 pure extraction → Task 1; spec 3 exact wire/authority → Tasks 2/3; spec 4 same image/eligibility/get → Tasks 3/5; spec 5 DTO/citations/relationships → Tasks 2/4/5; spec 6 bounds/deadline/cleanup → Tasks 4/5; spec 7 compiled/focused proof → Task 6; spec 8 incremental non-PROD handoff → this section and Task 6 evidence.

Main-agent inline self-review completed during plan preparation: each specification section maps to a Task; checkbox actions/commands and neighboring interfaces were checked; all five Review Focus cases have named owning tests; signatures/assertions replace implementation transcripts. Corrected source-closure permit sequencing into Task 5 so its regression can pass before Task 6, made synthetic fixture types explicit, and kept default vs native gate counts separate. Fixtures are explicitly new or additive, not assumed existing content support. Cleanup v1 and ownership v1 are separate from read v2. Plan-writing verification is docs-only and does not substitute for any future executable result.

Human review completed with `อนุมัติแผน` on 2026-10-02. Execute continuously within the approved scope using Subagent-Driven; do not ask for the execution-method choice again. This plan delivers the private native content backend, not full F2/F3/F4 or actual PROD activation.
