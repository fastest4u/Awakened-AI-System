# V2 Private Full-Body Markdown Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create private candidate/unverified Markdown notes of four kinds and return their redacted full bodies through an independently verified exact-ID read.

**Architecture:** Keep versioned note commands on the existing single worker-owned transaction path. Authenticate inline redacted source bodies into a new schema3 side table in the same immutable projection image. Add a dedicated protocol4 full-note read while ordinary summary reads retain protocol3 and their existing bounds.

**Tech Stack:** Existing TypeScript ESM, Node.js >=24.16.0, node:sqlite, node:test and Windows Job-contained qualification; no new dependencies.

**Spec:** [Approved specification](../specs/2026-10-09-v2-full-body-notes-design.md), commit `d3c4128b278e89cc32404e01c590772cad9c3ca8`. The human approved this written artifact on 2026-10-09. Its pre-review status paragraph is historical.

**Execution:** Subagent-Driven was already selected. This plan awaits human review; implementation has not started. Continue in `C:/Users/Server/.codex/worktrees/v2-prod-readiness/Awakened-AI-System`, branch `codex/v2-governed-summary-commands`.

## Global Constraints

- Four kinds only: `session-log`, `insight`, `mistake`, `adr`; candidate/unverified; Markdown is inert literal text. Separate summary remains all ordinary retrieval text.
- Semantic create2; Created schema2/formatVersion2/witness2; source schema4/sourceVersion3/`governed-note-unverified-v2`; stored receipt2; recovery request/envelope2. Freeze all V1 exact shapes, purposes and domains.
- New IDs retain UUIDv4; imported project/vault/store identities retain existing projection validators, workspace its existing validator, sessions/branches their existing domains. Positions are canonical unsigned decimal strings, compared as bigint.
- Raw and redacted body each <=65,536 UTF-8 bytes, well-formed Unicode, no C0/DEL except TAB/CR/LF, `body.trim().length !== 0`. Do not trim or normalize stored body. Only redaction may alter it.
- Summary retains raw -> NFC/trim -> redaction -> final gates. Freeze one trusted policy for both fields; combined spans <=4,096, rules <=256, literal rules <=2,048 bytes; provenance <=64.
- V2 create <=196,608 canonical bytes; create metadata with body `''` <=8,192; authorization independently <=16,384. Recovery input <=8,192. Body-free create/recovery correlation replies <=16,384.
- Created/source payload each <=262,144; source metadata with body `''` <=65,536. Dedicated full-note complete success <=262,144, metadata with body `''` <=65,536. Input/stage/failure and old-route caps remain8,192/16,384.
- Owned copy limits remain depth8, containers128, fields32, array elements64, ordinary scalar2,048. Only selected `content.body`, source `item.content.body`, full reply `content.item.content.body` gets the body allowance. Do not route a body through the old scalar copier first.
- Allowed body JSON string is <=131,074 encoded bytes (2x+2). Independently pack complete envelopes before commit/delivery; no clipping, dropping, retrying with changed IDs or raising caps.
- Worker request/atomic append remain4MiB, exactly two adjacent events, stream versions1/2, zero outbox jobs. Event replay remains100,000 events/64MiB aggregate/1MiB stored row; checksum representation32MiB; owned image capture64MiB.
- Summary hash domain `project-memory/governed-note-summary/v1\n`; body `project-memory/governed-note-body/v1\n`; V2 witness hash `project-memory/governed-note-command/v2\n`. Original-input MAC purpose `original-input-commitment`, domain `governed-note-original-input/v2`, canonical `{authority,binding,command:decodedV2}`. Proof purposes `create-governed-note/v2`, `recover-governed-note-result/v2`.
- One owning worker/FIFO/connection; current authority and existing eligible retained-evidence provenance. Authenticate all versions before dedup classification. Cross-version same identity conflicts; V1 recovery of valid V2 truth returns safe `GOVERNED_NOTE_FORMAT_UNSUPPORTED` after authentication.
- Historical equality uses the witness's historical key and exact raw summary/body. Recovery authenticates stored truth without reopening provenance or requiring original input. Raw input/spans never enter durable rows, receipt, log, metric or error.
- Preserve absorbing `OWNERSHIP_UNCERTAIN`, original recovery IDs and mandatory timings: request15,000ms, close5,000ms, recovery proof60,000ms, pending128, executor lease15,000ms, heartbeat5,000ms, append retry15,000ms, SQLite busy5,000ms, private read5,000ms.
- Freeze schema1/2 SQL/names/checksum vectors. Schema3 names: `sessionTree`, `sessionCheckpoints`, `canonicalItems`, `tasksFollowups`, `artifactsFiles`, `entityGraph`, `lexicalChunks`, `retrievalFeedback`, `governedNotes`; filename `projections-3-${generation}.sqlite`; checksum domain remains `project-memory/projection-core/v1\n`.
- Side rows are `{projectId,itemId,recordKind,format,body,bodyContentHash,sourceEventPosition}`, explicit nulls, decimal position strings, binary projectId/itemId ascending. V1 required row has null body tuple; V2 required row has present valid tuple; generic item has no row. Validate reserved-marker/prefix/kind/position and cross-table integrity before absence handling.
- Legacy genesis is exact11 fields/bare eight-name map, tied to schema2. GenesisV2 adds `genesisVersion:2`, `projectionSchemaVersion:3`, nine-name map and stores its exact envelope in existing `projection_checksums_json`. No event-store migration or old-row rewrite; legacy genesis may publish schema3 after deterministic rebuild.
- Ordinary rich reads support schema2|3 with unchanged outputs, ranking and caps; schema1 remains historical. Workflow cursor version1 carries actual schema2|3/generation/hash. Schema upgrade requires new generation even at an already-sufficient position and without new events.
- Only `get-full-note` uses bootstrap/reply/cancel4 and receipt `projectionSchemaVersion:3`. Cleanup protocol remains1. Query one captured locked schema3 image, revalidate admission, close image/reader/lock before success, never fetch a body afterward.
- Preserve closed error sets, `productionReady=false`, status-only public registration, V1 archive isolation and five deployment artifacts. No Markdown rendering/vault/import, new public routes, lifecycle promotion commands, production activation or operational key-custody changes.
- Every fresh implementer/reviewer brief must include these verification constraints before generic TDD guidance. Use the named causal cohorts, then one new final gate; do not append default/all/migration sweeps or old full gates for reassurance. Each RED/GREEN run requires its own current compile; native runs also require current product build.
- In the steps below, **compile** means `npm.cmd run test:build` and **product build** means `npm.cmd run build`; issue each as a separate command and check its exit before the next command. Rebuild after relevant product changes before any native cohort.
- Commands below run separately, sequentially, stopping on nonzero exit. A RED run must fail for the named missing behavior, not only compilation or environment failure. GREEN means exit0, all selected tests pass, zero skips. Commit only the task's explicit files after `git diff --check`; never commit unrelated work.

## Review Focus

1. Null-prototype owned records and property-order variation should decode identically; getters/proxies/exotic records must refuse without invoking getters. Task1: `owned_body_copy_preserves_literal_and_rejects_effectful_inputs`.
2. Duplicate members in canonical wire JSON must refuse rather than hide a version/body override. Task1: `v2_wire_rejects_duplicate_members_and_noncanonical_bytes`.
3. Caller mutation between proof preparation, queued send and response handling must not alter admitted bytes or returned owned data. Tasks2/10: `proof_binds_captured_original_v2` and `queued_v2_send_uses_owned_snapshot`.
4. A schema2 cursor must become stale after a schema3 generation is published at the same event position. Task7: `same_position_schema_upgrade_invalidates_cursor`.
5. Final rollback or cleanup failure must retain original IDs and permanently prevent owner reuse even when a late V2 receipt arrives. Tasks3/11: `v2_rollback_failure_is_absorbing` and `late_full_note_success_cannot_override_uncertain_cleanup`.

---

## File ownership and execution order

This is one delivery because successful creation, projection publication and verified full-note return depend on each other. Tasks are serial review units; independent source investigations may run in parallel, shared edits/builds may not.

| Unit | Files and responsibility |
| --- | --- |
| Literal contracts | New `src/orchestrator/governed-notes/body-content.ts`; versioned contracts/codecs in the same directory; keep hashing/validation below codec/intent/pair dependencies. |
| Privacy/authority | `privacy/redaction.ts`, governed `intent.ts`, `authority.ts`; one policy snapshot, exact raw equality, V2 proof purposes. |
| Durable note truth | Governed `pair-validation.ts`, `repository.ts`, `service.ts`; storage guarded append and event/lifecycle integrity consumers; versioned authenticated pair/dedup. |
| Schema3 | Projection `schema.ts`, `contracts.ts`, `checksum.ts`, `folds.ts`, `source-event-codec.ts`, `event-reader.ts`; explicit V3 profile and owned authenticated source disposition. |
| Genesis | New `fresh-start/genesis-codec.ts`; contracts/repository/initializer/read admission share legacy/V2 persisted envelope decoding. |
| Publication | Projection builder/manifest/coordinator/integrity/image/directory/journal/lease and runtime profile selection; deterministic new immutable generation. |
| Ordinary retrieval | `retrieval/database-core.ts`, `retrieval/v2-candidates.ts`, content/workflow query/ranking/cursor contracts; schema2|3 rich selection without body leakage. |
| Full-note read | New `verified-read/full-note-{contracts,protocol,query,result}.ts`; exact-ID side-table lookup and whole-envelope body allowance. |
| Native protocol | Verified read `contracts.ts`, `protocol.ts`, `wire-data.ts`, `child.ts`, `supervisor.ts`, internal entry; correlated version4 while version3 stays strict. |
| Private note transport | Governed runtime/run/worker protocol; runtime executor/backend/worker runtime; V2 fixture preparation ingress. |
| Native proof | Governed/domain/provider/private-read fixtures and native tests, build closure pinning. |
| Qualification | New runner/test, package alias and evidence document; one contained increment qualification with candidate identity recorded. |

Existing fixtures retain V1 APIs. New test-local values such as `validV1`, `validSourceV2`, `validFullSuccess` mean owned fixtures constructed in the named test file, never caller-selected providers or production bypasses. Assertion excerpts identify required checks; fixture setup is part of their owning test step.

### Task 1: Exact V2 contracts and literal body codecs

**Files:** Create `src/orchestrator/governed-notes/body-content.ts`, `tests/v2-full-body-note-contracts.test.ts`; modify `src/orchestrator/governed-notes/contracts.ts`, `src/orchestrator/governed-notes/codec.ts`. Test also `tests/v2-governed-note-contracts.test.ts`.

**Interfaces:** Produce all spec section3/4 `*V2` types, `GovernedNoteSourcePayloadV2`, `GovernedNoteStoredResultV2 = StoredCommandResponse<GovernedNoteStoredReceiptV2>`. Export `assertMarkdownNoteBodyV1(body:unknown):asserts body is string`, `governedNoteBodyHash(content:MarkdownNoteContentV1):string`. Export exact `decodeGovernedNote{Command,Recovery,SourcePayload,CreatedPayload,StoredReceipt,StoredResult,RecoveryResult}V2(value:unknown)` returning the matching type; `encodeGovernedNoteCommandV2(command:GovernedNoteCommandV2):string`; `encodePreparedGovernedNoteCreateV2(input:PreparedGovernedNoteCreateV2):PreparedGovernedNoteCreateWireV2`, `decodePreparedGovernedNoteCreateV2(value:unknown):PreparedGovernedNoteCreateV2` and equivalent recovery methods. Old decoders remain V1-only; owned discriminant dispatch belongs to the consuming tasks. The body module imports neither codec, intent, pair nor projection modules.

- [ ] Write `literal_v2_boundaries`, `owned_body_copy_preserves_literal_and_rejects_effectful_inputs`, `v2_wire_rejects_duplicate_members_and_noncanonical_bytes`, and `receipt_recovery_discriminants_are_exact`; reuse the valid V1 input fixture with only spec-authorized additions.

```ts
const body = '  ```\r\n\tไทย e\u0301 😀  \r\n```\n';
assert.equal(decodeGovernedNoteCommandV2({...validV1, version:2, content:{format:'markdown', body}}).content.body, body);
assert.doesNotThrow(() => assertMarkdownNoteBodyV1('x'.repeat(65536)));
for (const bad of ['x'.repeat(65537), '\u0000x', '\u007fx', '\ud800', ' \t\r\n']) assert.throws(() => assertMarkdownNoteBodyV1(bad));
assert.equal(Buffer.byteLength(JSON.stringify('\\'.repeat(65536))), 131074);
assert.equal(getterCalls, 0); // After accessor/proxy/exotic rejection matrix.
assert.equal(canonicalJson(nullPrototypeDecoded), canonicalJson(ordinaryDecoded));
assert.throws(() => decodeGovernedNoteCommandV1({...validV1, version:2, content:{format:'markdown', body}}));
```

Also assert exact 196608/8192/16384/262144 encoded gates, 65536 metadata gate, depth8/containers128/fields32/arrays64, unknown keys, body outside its three owned paths, escaping-heavy bodies, source/witness/receipt mixed versions, and duplicate `version`/`body` in prepared canonical wire strings. A version discriminator must be inspected via owned descriptors, never accessor reads.

- [ ] Run RED: `npm.cmd run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-contracts.test.js`; observe the named V2 behavior failure.
- [ ] Implement the listed types, low-level literal validity/hash and exact owned V2 codecs. Independently measure canonical encoded command, body-empty metadata, authorization, payload and body-free result; preserve every V1 bound and hash. Require canonical wire bytes to match the re-encoded owned shape, rejecting duplicate members.
- [ ] Run GREEN: current `npm.cmd run test:build`, then the same node command plus `dist-test/tests/v2-governed-note-contracts.test.js`; all pass with zero skips.
- [ ] Commit the four task files: `feat(v2): add exact full-body note contracts`.

### Task 2: Shared-policy redaction, historical equality and V2 authority

**Files:** Modify `src/orchestrator/privacy/redaction.ts`, `src/orchestrator/governed-notes/intent.ts`, `src/orchestrator/governed-notes/authority.ts`, `tests/support/governed-note-domain-fixture.ts`; create `tests/v2-full-body-note-privacy.test.ts`. Test also `tests/v2-governed-note-redaction.test.ts`, `tests/v2-governed-note-authority.test.ts`.

**Interfaces:** Consume Task1. Produce `redactGovernedNoteContentV2(summary:string,body:string,policy:TrustedRedactionPolicyV1):Readonly<{summary:string;body:string;policyId:string;policyVersion:string;spanCount:number}>`. Add `buildGovernedNoteOriginalCommitmentV2(command:GovernedNoteCommandV2,authority:GovernedNoteAuthoritySnapshotV1,binding:ProjectBinding,ref:EvidenceKeyRefV1,provider:EvidenceKeyProvider):string`, `assertGovernedNoteOriginalEqualityV2(command,authority,binding,witness:GovernedNoteWitnessV2,provider):void`, `governedNoteCommandHashV2(witness:GovernedNoteWitnessV2):string`. Add `governedNoteCreateProofTargetV2(command:GovernedNoteCommandV2,scope:GovernedNoteCreateProofScopeV1,binding:ProjectBinding,proofNonce:string):SemanticCommandProofTargetV1`, `governedNoteRecoveryProofTargetV2(request:GovernedNoteRecoveryV2,context:ProjectContext,binding:ProjectBinding,capabilityGeneration:string,proofNonce:string):BoundedOperationProofTargetV1`. Authority adds `verifyCreateV2(prepared:PreparedGovernedNoteCreateV2,context:ProjectContext):VerifiedGovernedNoteCreateAuthority`, `verifyRecoveryV2(prepared:PreparedGovernedNoteRecoveryV2,context:ProjectContext):VerifiedGovernedNoteRecoveryAuthority`, and `requireGovernedNoteCreateAuthorityV2(connection,handle,command:GovernedNoteCommandV2,expectedBinding?):GovernedNoteAuthoritySnapshotV1` with existing connection/handle/binding types. Revalidation/binding/discard retain connection-bound handles. Domain fixture adds `commandV2(overrides?:Partial<GovernedNoteCommandV2>):GovernedNoteCommandV2`, `prepareCreateV2(command:GovernedNoteCommandV2,context?:ProjectContext):PreparedGovernedNoteCreateV2`, `prepareRecoveryV2(ids:GovernedNoteRecoveryIdsV1,expiresAt:string,context?:ProjectContext):PreparedGovernedNoteRecoveryV2`.

- [ ] Write `literal_redaction_preserves_markdown`, `combined_span_budget_is_4096`, `proof_binds_captured_original_v2`, `raw_equal_display_conflicts`, `historical_v2_key_selection`, and root/direct-child authority refusal matrix.

```ts
assert.equal(redacted.body, expectedBodyWithOnlySecretSpansReplaced);
assert.equal(redacted.summary, expectedNfcTrimmedSummary);
assert.equal(policyReads, 1);
assert.equal(redacted.spanCount, 4096);
assert.throws(() => redactGovernedNoteContentV2(span4097Summary, span4097Body, policy));
assert.notEqual(macForRawBodyA, macForRawBodyB); // Same redacted body, different raw secret/EOL/NFC.
assert.equal(macFromHistoricalKey, originalMac);
assert.equal(createProof.intentHash, commandHash({proofPurpose:'create-governed-note/v2', scope, binding, originalCommand:canonicalJson(commandV2)}));
assert.equal(recoveryProof.operationHash, commandHash({proofPurpose:'recover-governed-note-result/v2', ...recoverySelectors}));
assert.equal(capturedCommand.content.body, originalBody); // Caller mutation after preparation.
```

Test raw/final65536 boundaries and redaction expansion65537, missing/process-secret-invalid policy, revoked/ended/sibling/transferred authority, target audience mismatch, wrong capability purpose/generation and absent historical key; assert fixed safe errors without original text.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-privacy.test.js`; named assertions fail.
- [ ] Implement one frozen policy snapshot and shared span counter across separately processed fields; body never enters the summary normalizer. Bind exact admitted originals into the historical scoped MAC; add version-specific proof domains without altering V1 or WeakMap authority ownership. Add the domain fixture's V2 proof helpers.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/v2-governed-note-redaction.test.js dist-test/tests/v2-governed-note-authority.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): bind literal note bodies to trusted privacy and authority`.

### Task 3: Authenticated V2 pair, guarded append, replay and recovery

**Files:** Modify `src/orchestrator/governed-notes/pair-validation.ts`, `src/orchestrator/governed-notes/repository.ts`, `src/orchestrator/governed-notes/service.ts`, `src/orchestrator/storage/event-append-transaction.ts`, `src/orchestrator/storage/event-store.ts`, `src/orchestrator/integrity/event-integrity.service.ts`, `src/orchestrator/integrity/lifecycle-integrity.service.ts`; create `tests/v2-full-body-note-command.test.ts`. Test also `tests/v2-governed-note-codec.test.ts`, `tests/v2-governed-note-replay.test.ts`, `tests/v2-governed-note-recovery.test.ts`, `tests/event-append-transaction.test.ts`.

**Interfaces:** In pair-validation define `GovernedNotePriorV2 = Readonly<{witness:GovernedNoteWitnessV2;events:readonly [StoredEvent,StoredEvent];result:GovernedNoteStoredResultV2;commandHash:string;responseHash:string}>` and `GovernedNotePrior = GovernedNotePriorV1|GovernedNotePriorV2`; repository re-exports types through erased imports. `validateGovernedNotePairV2(events:readonly StoredEvent[],input:GovernedNoteStoredResultV2):GovernedNoteWitnessV2`; `validateGovernedNotePairAny(events:readonly StoredEvent[],input:GovernedNoteStoredResultV1|GovernedNoteStoredResultV2):GovernedNoteWitnessV1|GovernedNoteWitnessV2`; repository `findGovernedNotePriorAny(commandId:string,idempotencyKey:string):GovernedNotePrior|null`; `assertStoredGovernedNoteCorrespondenceAny(connection:SqliteConnection,event:StoredEvent):GovernedNotePrior|null`. Preserve V1 wrappers. Add transaction `planGovernedNoteIdentityV2(authority:VerifiedGovernedNoteCreateAuthority,command:GovernedNoteCommandV2):GovernedNoteEventPlan`, `prepareGovernedNoteV2(plan:GovernedNoteEventPlan,append:AppendCommand<GovernedNoteStoredReceiptV2>,payload:GovernedNoteCreatedPayloadV2):PreparedEventAppend<GovernedNoteStoredReceiptV2>`; shared append/discard retains opaque plan ownership. Service `createV2(prepared:PreparedGovernedNoteCreateV2,context:ProjectContext):AppendResult<GovernedNoteStoredReceiptV2>` and `recoverV2(prepared:PreparedGovernedNoteRecoveryV2,context:ProjectContext):GovernedNoteRecoveryResultV2`; V1 recovery authenticates any prior before format refusal.

- [ ] Write `four_kinds_create_exact_inline_pair`, `v2_replay_and_cross_version_conflict`, `v2_recovery_authenticates_both_receipts`, `reserved_v2_cannot_escape_generic_append`, `precommit_packing_is_atomic`, `v2_rollback_failure_is_absorbing`, and `raw_body_never_persists` using the Task2 domain fixture.

```ts
const before = f.rows();
const result = f.service().createV2(f.prepareCreateV2(f.commandV2({content:{format:'markdown',body}})), f.rootContext);
assert.equal(f.rows().events - before.events, 2);
assert.equal(f.rows().dedup - before.dedup, 1);
assert.equal(f.rows().outbox - before.outbox, 0);
assert.equal(result.response.resultVersion, 2);
assert.equal('body' in result.response.content, false);
assert.equal(created.eventSchemaVersion, 2); assert.equal(source.eventSchemaVersion, 4);
assert.equal(decodeGovernedNoteSourcePayloadV2(JSON.parse(source.payloadJson)).item.content.body, redactedBody);
assert.equal(recoveredV2.receipt.resultVersion, 2);
assert.equal(recoveredLegacyViaV2.receipt.resultVersion, 1);
assert.equal(v1RecoveryError.code, 'GOVERNED_NOTE_FORMAT_UNSUPPORTED');
assert.equal(v1RecoveryError.message, 'GOVERNED_NOTE_FORMAT_UNSUPPORTED');
assert.deepEqual(v1RecoveryError.details, {});
assert.equal(f.rowContents().includes(rawSecret), false);
```

Assert independent kind/format/body/hash/version/header/source-position/dedup tampering refuses; same raw replay is detached and creates zero rows; changed raw body with equal redacted text and V1/V2 collisions are `IDEMPOTENCY_CONFLICT`. Recovery does not reopen provenance; new notes remain ineligible provenance. Packing/authority failures leave entire row snapshot unchanged. Faults before/after first insert, rollback/commit/response ambiguity retain original IDs and never replay through generic append.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-command.test.js`; observe missing V2 transaction/service behavior.
- [ ] Implement the interfaces and every guarded seam: reserved command recognition, validation, noteBudget/noteState, replay refusal, planning, prepared ownership, append, dedup and discard. Recognize both markers and `governed-note/` prefixes independently of malformed keys. Pack both payloads, pair, receipt/correlation and prospective returnability before insertion; prove body JSON <=131074 plus full-note metadata allowance65536 fits262144. Authenticate version before conflict/unsupported classification. Retain retry/fault/uncertainty semantics and closed errors.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/v2-governed-note-codec.test.js dist-test/tests/v2-governed-note-replay.test.js dist-test/tests/v2-governed-note-recovery.test.js dist-test/tests/event-append-transaction.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): persist and recover authenticated full-body note pairs`.

### Task 4: Schema3 rows, authenticated source disposition and deterministic folds

**Files:** Modify `src/orchestrator/projections/schema.ts`, `src/orchestrator/projections/contracts.ts`, `src/orchestrator/projections/checksum.ts`, `src/orchestrator/projections/folds.ts`, `src/orchestrator/projections/source-event-codec.ts`, `src/orchestrator/projections/event-reader.ts`, `src/orchestrator/projections/manifest-codec.ts` (types/constants only); create `tests/v2-full-body-note-projection.test.ts`. Test also `tests/projection-schema.test.ts`, `tests/projection-source-event-codec.test.ts`, `tests/projection-folds.test.ts`.

**Interfaces:** Produce `PROJECTION_SCHEMA_SQL_V3`, `PROJECTION_NAMES_V3`, `ProjectionNameV3`, `ProjectionManifestV3`, `GovernedNoteProjectionRowV1` with exact spec row fields, `ProjectionFoldStateV3` adding schema3/governedNotes to the frozen V2 state. Add explicit frozen `PROJECTION_NAMES_V2`/`ProjectionNameV2` aliases; existing unversioned schema SQL/version/names aliases retain schema2 semantics. Define owned `ProjectionSourceDisposition = Readonly<{event:StoredEvent;governedNotePrior:GovernedNotePrior|null}>`. Add `ProjectionEventSnapshotV3 extends ProjectionEventSnapshot` with `dispositions():Iterable<ProjectionSourceDisposition>`; reader `openCommittedSnapshotV3(binding:ProjectBinding):Promise<ProjectionEventSnapshotV3>` and `replayCommittedProjectionSources(binding:ProjectBinding,options:CommittedProjectionReplayOptions,consume:(source:ProjectionSourceDisposition)=>void):CommittedProjectionReplayResult`. Add `ProjectionFoldAccumulatorV3.append(source:ProjectionSourceDisposition):void`, `.finish():ProjectionFoldStateV3`. `projectionCoreChecksum(name,schemaVersion,projectId,terminalEventPosition,rows)` accepts explicit3 while frozen1/2 callers keep their profiles.

- [ ] Write `authenticated_v1_kind_and_v2_body_fold`, `schema3_checksum_rows_are_canonical`, `side_table_integrity_precedes_absence` and `frozen_historical_profiles`; retain original schema1/2 golden vectors.

```ts
assert.equal(v1Row.recordKind, v1AuthenticatedWitness.recordKind);
assert.deepEqual([v1Row.format,v1Row.body,v1Row.bodyContentHash], [null,null,null]);
assert.equal(v2Row.body, literalRedactedBody);
assert.equal(v2Row.sourceEventPosition, sourcePosition.toString());
assert.equal(typeof v2Row.sourceEventPosition, 'string');
assert.deepEqual(checksumRows.map(r => [r.projectId,r.itemId]), expectedBinaryOrder);
assert.deepEqual(v3.canonicalItems, v2.canonicalItems);
assert.deepEqual(v3.lexicalChunks, v2.lexicalChunks);
assert.equal(PROJECTION_NAMES_V3.length, 9);
assert.equal(PROJECTION_NAMES_V1.includes('retrievalFeedback'), true);
```

Test missing/orphan/duplicate row, tuple partial-null, invalid kind/hash/body, positive/source-position mismatch, reserved malformed marker/prefix, generic-with-row and payload cache tampering. Assert Created is validated but unprojected; V1 kind is never guessed from normalized key. Cover imported content-addressed identities without broadening new-note IDs.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-projection.test.js`; named schema3/fold assertions fail.
- [ ] Implement explicit V3 schema/state/source fold. Retain correspondence returned by Task3 repository in an owned disposition; keep `StoredEvent` and canonical `payloadJson` authority unchanged. Emit side row only at source position; preserve original replay/capacity budgets and original SQL/row/checksum profiles. Put PK/FK/tuple constraints in SQL and complete cross-table/hash validation in owned fold/row capture.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/projection-schema.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): add authenticated schema3 governed note projection`.

### Task 5: Exact legacy and V2 genesis persistence/admission

**Files:** Create `src/orchestrator/fresh-start/genesis-codec.ts`, `tests/v2-full-body-note-genesis.test.ts`; modify `src/orchestrator/fresh-start/contracts.ts`, `src/orchestrator/fresh-start/fresh-start.repository.ts`, `src/orchestrator/fresh-start/fresh-start-initializer.ts`, `src/orchestrator/verified-read/admission.ts`. Test also `tests/fresh-start-repository.test.ts`, `tests/fresh-start-admission.test.ts`.

**Interfaces:** Alias the current unversioned11-field type as `FreshStartGenesisV1`; produce `FreshStartGenesisV2` and `StoredGenesisChecksumsV2` per spec, plus `FreshStartGenesis = FreshStartGenesisV1|FreshStartGenesisV2`. `decodeFreshStartGenesis(value:unknown):FreshStartGenesis`; `decodeStoredGenesisChecksums(text:string):Readonly<{genesisVersion:1;projectionSchemaVersion:2;projectionChecksums:Readonly<Record<ProjectionNameV2,string>>}>|StoredGenesisChecksumsV2`; `encodeStoredGenesisChecksums(genesis:FreshStartGenesis):string`. Repository, initialization journal/recovery and independent admission consume the same codec. This task supports reading/writing both envelopes; switching new initialization's image publication to3 belongs to Task6.

- [ ] Write `legacy_genesis_bytes_are_unchanged`, `v2_genesis_exact_envelope`, `genesis_profile_does_not_override_admission` and mixed/tampered discriminant refusal.

```ts
assert.equal(Object.keys(legacyGenesis).length, 11);
assert.equal(encodeStoredGenesisChecksums(legacyGenesis), originalBareMapBytes);
assert.equal(v2Genesis.genesisVersion, 2); assert.equal(v2Genesis.projectionSchemaVersion, 3);
assert.equal(Object.keys(v2Genesis.projectionChecksums).length, 9);
assert.deepEqual(JSON.parse(encodeStoredGenesisChecksums(v2Genesis)), {genesisVersion:2, projectionSchemaVersion:3, projectionChecksums:v2Genesis.projectionChecksums});
assert.equal(v2Genesis.semanticPosition, '0');
assert.equal(eventStoreSqlSchemaAfter, eventStoreSqlSchemaBefore);
assert.equal(admissionWithWrongControlGeneration, 'FRESH_START_ADMISSION_STALE');
```

Pin schema-selected empty checksum/genesis hash, extra/missing keys, changed existing maps, unknown versions, journal round trip and legacy genesis accepting a verified schema3 image while all release/operator/control/maintenance checks stay active.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-genesis.test.js`; envelope/profile assertions fail.
- [ ] Implement the shared exact codec and thread the union through initializer/repository/journal/read admission. Persist new discriminants only inside existing immutable JSON column; leave legacy stored bytes unchanged. Decode schema-selected empty checksums without requiring the not-yet-implemented V3 publisher; retain historical initializer profile entry points.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/fresh-start-repository.test.js dist-test/tests/fresh-start-admission.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): persist versioned genesis projection profiles`.

### Task 6: Build, publish, validate and retire schema3 immutable images

**Files:** Modify `src/orchestrator/projections/builder.ts`, `src/orchestrator/projections/manifest-codec.ts`, `src/orchestrator/projections/manifest.ts`, `src/orchestrator/projections/coordinator.ts`, `src/orchestrator/projections/integrity.ts`, `src/orchestrator/projections/image-metadata.ts`, `src/orchestrator/projections/immutable-image.ts`, `src/orchestrator/projections/stable-directory.ts`, `src/orchestrator/projections/stable-directory-read-core.ts`, `src/orchestrator/projections/reconciliation-journal.ts`, `src/orchestrator/projections/v2-reader-lease.ts`, `src/orchestrator/runtime/projection-runtime.ts`, `src/orchestrator/fresh-start/fresh-start-initializer.ts`, `src/orchestrator/migration/v2-shadow-projection.ts`, `src/orchestrator/parity/v2-snapshot-parity.ts`, `src/orchestrator/parity/v2-expected-difference.ts`. Create `tests/v2-full-body-note-publication.test.ts`; test also `tests/projection-builder.test.ts`, `tests/projection-coordinator.test.ts`, `tests/projection-integrity.test.ts`, `tests/fresh-start-initializer.test.ts`.

**Interfaces:** Consume Task4/5. `StagedProjectionGenerationV3 = Omit<StagedProjectionGeneration,'manifest'> & {readonly manifest:ProjectionManifestV3}`; builder `buildV3(snapshot:ProjectionEventSnapshotV3,generation:number):Promise<StagedProjectionGenerationV3>`; `parseProjectionManifestV3(value:unknown,expectedBinding:ProjectBinding):ProjectionManifestV3`; `parseRichProjectionManifest(value:unknown,expectedBinding:ProjectBinding):ProjectionManifestV2|ProjectionManifestV3`. Existing publication parser returns manifest1|2|3. `PublishedProjectionGenerationV3 = Omit<PublishedProjectionGenerationV2,'manifest'> & {readonly manifest:ProjectionManifestV3}`; coordinator `ensurePublishedV3(binding:ProjectBinding,requiredEventPosition:bigint,deadlineMs:number):Promise<PublishedProjectionGenerationV3>` shares publication ownership with V2. Rich evaluation lease accepts actual manifest2|3. Image metadata/integrity replay select exact profile, never relabel.

- [ ] Write `same_position_no_events_requires_schema3_generation`, `legacy_genesis_schema3_rebuild_is_deterministic`, `owned_image_contains_and_checks_body`, and schema-specific reconciliation/retirement failure tests.

```ts
assert.equal(published.schemaVersion, 3);
assert.equal(published.terminalEventPosition, priorSchema2.terminalEventPosition);
assert.equal(published.terminalEventHash, priorSchema2.terminalEventHash);
assert.notEqual(published.generation, priorSchema2.generation);
assert.match(published.databaseFile, /^projections-3-\d+\.sqlite$/); // published is returned generation.manifest.
assert.equal(hashOldImageAfter, hashOldImageBefore);
assert.deepEqual(firstBuild.checksums, independentRebuild.checksums);
assert.equal(capturedRows.governedNotes[0].body, redactedBody);
assert.equal(bodyTamperResult, 'INTEGRITY_FAILURE');
```

Test 100000/64MiB/1MiB replay,32MiB checksum and64MiB capture refusal boundaries; wrong profile/checksum names, retained leases, interrupted publication/journal, ownership loss/deadline on same-position upgrade, missing side rows and mismatched image/body hashes. Keep schema1/2 golden files unchanged.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-publication.test.js`; no-events profile upgrade test fails.
- [ ] Implement V3 staging/capture/integrity/publication/recovery/retirement. Check profile as well as position in sufficient-view fast paths. Update both embedded mutation-script and host-side directory filename/profile validators, journal namespace and V2 lease checks. Switch new private initialization to the matching schema3 empty image/genesis using Task5 codec; keep an explicit legacy profile fixture. Bind legacy migration/parity callers explicitly to frozen schema2; corpus-format2 in retrieval evaluation/rehearsal is unrelated and stays unchanged.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/fresh-start-initializer.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): publish and verify schema3 immutable note images`.

### Task 7: Ordinary rich reads and cursors retain summary semantics on schema3

**Files:** Modify `src/orchestrator/retrieval/database-core.ts`, `src/orchestrator/retrieval/v2-candidates.ts`, `src/orchestrator/verified-read/content-query.ts`, `src/orchestrator/verified-read/content-ranking.ts`, `src/orchestrator/verified-read/workflow-contracts.ts`, `src/orchestrator/verified-read/workflow-cursor.ts`, `src/orchestrator/verified-read/workflow-query.ts`, `src/orchestrator/verified-read/workflow-protocol.ts`; create `tests/v2-full-body-note-summary-regression.test.ts`. Test also `tests/v2-native-content-query.test.ts`, `tests/v2-native-workflow-cursor.test.ts`, `tests/v2-native-workflow-query.test.ts`.

**Interfaces:** `RetrievalProjectionManifest` includes3 for explicit metadata/profile validation. Existing rich database lookup/page methods, `queryNativeContent(database,manifest,context)` and workflow query functions accept manifest2|3 while preserving old result types. Existing cursor encoder/decoder carry opaque version1 and `schemaVersion:2|3` from the actual image. No old operation gains body or kind fields.

- [ ] Write `ordinary_schema3_text_and_ranking_are_summary_only`, `schema3_uses_rich_columns` and `same_position_schema_upgrade_invalidates_cursor`.

```ts
assert.deepEqual(results3.search, results2.search);
assert.deepEqual(results3.get, results2.get);
assert.deepEqual(results3.list, results2.list); assert.deepEqual(results3.recent, results2.recent);
assert.deepEqual(results3.context, results2.context); assert.deepEqual(results3.radar, results2.radar);
assert.equal(JSON.stringify(results3).includes(uniqueBodyOnlyTerm), false);
assert.equal(cursor3.schemaVersion, 3); assert.equal(cursor3.version, 1);
assert.equal(crossSchemaCursorError, 'V2_CONTENT_CURSOR_STALE');
assert.ok(ordinaryCompleteReplyBytes <= 16384);
```

Compare schema2/schema3 on the same historical V1/generic corpus; test new V2 summary-only behavior on schema3 separately, without requiring the frozen schema2 builder to accept source4. Cover schema3 nullable rich columns, eligibility/temporal/conflict/ranking ties, same-position different generation/hash and same-image selection mismatch. Historical schema1 consumers still take their legacy SQL path.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-summary-regression.test.js`; schema3 rich/cursor tests fail.
- [ ] Implement explicit schema2|3 rich profile discrimination at database, candidate, ranking and workflow boundaries; preserve bounds/version strings, shape and FTS/vector/lexical input. Do not replace `===2` with an unconditional latest-profile default.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/v2-native-content-query.test.js dist-test/tests/v2-native-workflow-cursor.test.js dist-test/tests/v2-native-workflow-query.test.js`; all pass.
- [ ] Commit explicit task files: `fix(v2): preserve summary reads across schema3 publication`.

### Task 8: Dedicated full-note request, indexed query and bounded result

**Files:** Create `src/orchestrator/verified-read/full-note-contracts.ts`, `src/orchestrator/verified-read/full-note-protocol.ts`, `src/orchestrator/verified-read/full-note-query.ts`, `src/orchestrator/verified-read/full-note-result.ts`, `tests/v2-full-note-contracts.test.ts`, `tests/v2-full-note-query.test.ts`, `tests/v2-full-note-result.test.ts`; modify `src/orchestrator/verified-read/wire-data.ts`, `src/orchestrator/retrieval/database-core.ts` for the pure indexed row lookup.

**Interfaces:** Produce spec `GetFullNoteRequest`, `NativeFullNoteItem`, `NativeFullNoteResultV1`; `FullNoteVerifiedReadReceiptV1 = Omit<VerifiedReadReceipt,'operation'> & {operation:'get-full-note';projectionSchemaVersion:3}` and `FullNoteReadSuccessBaseV1 = Omit<ReadSuccessBase,'version'|'receipt'> & {version:4;receipt:FullNoteVerifiedReadReceiptV1}`. `FullNoteQueryContext = Omit<NativeQueryContext,'request'|'receipt'> & {request:GetFullNoteRequest;receipt:FullNoteVerifiedReadReceiptV1}`. Export `decodeGetFullNoteRequest(value:unknown,trustedSession:TrustedReadSession|null):GetFullNoteRequest`, `decodeNativeFullNoteResult(value:unknown):NativeFullNoteResultV1`, `queryNativeFullNote(database:DatabaseSync,manifest:ProjectionManifestV3,context:FullNoteQueryContext):NativeFullNoteResultV1`, `buildNativeFullNoteResult(candidate:NativeFullNoteResultV1,base:FullNoteReadSuccessBaseV1):NativeFullNoteResultV1`. Pure database helper `getGovernedNoteFromProjectionDatabase(database:DatabaseSync,manifest:ProjectionManifestV3,projectId:string,itemId:string):GovernedNoteProjectionRowV1|null`; never imports governed service/repository/publisher. Add `copyBoundedFullNoteSuccessData(value:unknown):unknown` for full `content.item.content.body`, and `copyBoundedFullNoteResultData(value:unknown):unknown` for exact inner `item.content.body`; each requires its admitted discriminant/keys,65536 body,65536 body-empty metadata and262144 total. Original copier stays unchanged; Task9 correlates the outer lane before either body-aware copy.

- [ ] Write `full_note_has_summary_and_literal_body`, `legacy_and_generic_absence_are_distinct`, `missing_v2_row_is_integrity`, `full_note_exact_id_plan_is_indexed`, `whole_success_budget_not_only_body`, and request/result exact-shape tests.

```ts
assert.equal(result.operation, 'get-full-note');
assert.equal(result.noteBoundsVersion, 'v2-full-note-bounds-1');
assert.equal(result.item!.text, summary); assert.equal(result.item!.content!.body, literalRedactedBody);
assert.equal(v1.item!.recordKind, v1Kind); assert.equal(v1.item!.bodyAvailability, 'absent');
assert.equal(v1.item!.content, null); assert.equal(generic.item!.recordKind, null);
assert.deepEqual([missing.item, missing.conflict], [null,null]);
assert.ok(queryPlan.some(row => /SEARCH governed_notes.*(INDEX|PRIMARY KEY)/.test(row.detail)));
assert.ok(visitedGovernedRows <= 1);
assert.ok(completeSuccessBytes <= 262144); assert.ok(bodyEmptyMetadataBytes <= 65536);
assert.equal(overflowError, 'V2_CONTENT_RESULT_TOO_LARGE');
```

Reuse get ID512-byte/filter domains, selection scope/conflict/eligibility and temporal behavior. Inspect the private canonical normalized key/verification marker before detaching the item. Assert body hash independently, all four kinds, unchanged `textKind`, schema2 full-note refusal, wrong project/ID/scope/filter, tampered kind/position/hash, false absence and metadata-hidden body rejection. Exact262144/262145 and65536/65537 encoded envelopes must be measured; old16384/16385 boundary remains strict. Measure actual prepared exact-ID SQL via `EXPLAIN QUERY PLAN` and count returned rows in the test harness, not a mocked planner or production telemetry field.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-note-contracts.test.js dist-test/tests/v2-full-note-query.test.js dist-test/tests/v2-full-note-result.test.js`; named query/bounds fail.
- [ ] Implement exact full-note contracts and body-aware owned copying before the generic copier; reuse eligible canonical exact-ID selection, then indexed same-image side row lookup. Validate cross-table marker/kind/position rules before absent branch. Pack whole success including receipt/fence/prospective closed fields, not only inner content; return frozen owned content.
- [ ] Run GREEN: compile, then the RED command; all three files pass with zero skips.
- [ ] Commit explicit task files: `feat(v2): query full Markdown notes from schema3 images`.

### Task 9: Correlated protocol4 child and supervisor with closure before success

**Files:** Modify `src/orchestrator/verified-read/contracts.ts`, `src/orchestrator/verified-read/protocol.ts`, `src/orchestrator/verified-read/child.ts`, `src/orchestrator/verified-read/supervisor.ts`, `src/orchestrator/verified-read/admission.ts`, `src/v2/internal-verified-read.entry.ts`, `src/orchestrator/verified-read/full-note-protocol.ts`; create `tests/v2-full-note-protocol.test.ts`, `tests/v2-full-note-child.test.ts`, `tests/v2-full-note-supervisor.test.ts`. Test also `tests/v2-native-content-child.test.ts`, `tests/v2-native-content-supervisor.test.ts`.

**Interfaces:** Define exact `FullNoteReadBootstrapV1`, `FullNoteReadReplyV1`, `FullNoteReadCancelV1`, `FullNoteReadTerminalReplyV1` using version4 and existing IDs/binding/phase/failure/closure fields; only full-note success permits body. New decoders `decodeFullNoteReadBootstrap`, `decodeFullNoteReadCancel`, `decodeFullNoteReadReply(value:unknown,request:GetFullNoteRequest):FullNoteReadReplyV1`. New child `executeFullNoteVerifiedRead(bootstrap:FullNoteReadBootstrapV1,dependencies:FullNoteVerifiedReadChildDependencies):Promise<FullNoteReadTerminalReplyV1>`; dependency fields match existing child closures with V4 stage emission. `VerifiedFullNoteReadResultV1 = Readonly<{receipt:FullNoteVerifiedReadReceiptV1;content:NativeFullNoteResultV1}>`; adapter adds `queryFullNote(request:GetFullNoteRequest,options?:{signal?:AbortSignal}):Promise<VerifiedFullNoteReadResultV1>` while old query remains typed to old operations. Shared owned process send union includes V4; retained lane request determines expected version. Cleanup ownership protocol/repository stay1.

- [ ] Write `protocol4_only_admits_full_note`, `parent_correlates_before_large_copy`, `full_note_closes_before_success`, `full_note_waits_for_schema3`, and bounded cancel/deadline/cleanup tests.

```ts
assert.equal(reply.version, 4); assert.equal(reply.receipt.projectionSchemaVersion, 3);
assert.equal(reply.receipt.operation, 'get-full-note');
assert.deepEqual(reply.closed, {image:true,reader:true,lock:true});
assert.ok(closeImageOrdinal < successOrdinal && closeReaderOrdinal < successOrdinal && closeLockOrdinal < successOrdinal);
assert.equal(postReleaseBodyFetches, 0);
assert.equal(oldRouteLargeBodyError, 'WORKER_PROTOCOL_ERROR');
assert.equal(wrongIdsLargeBodyError, 'WORKER_PROTOCOL_ERROR');
assert.equal(Object.isFrozen(parentResult.content.item!.content), true);
assert.equal(cleanupBootstrap.version, 1);
```

Test swapped versions/operation/IDs, extra keys, stage/failure body smuggling, complete262144 cap, scope/requestedID/selection/schema/hash/generation/position/fence mismatch, stale admission, no schema3 by deadline, abort at every phase and uncertain cleanup. No success before full native closure; unsupported schema never substitutes summary.

- [ ] Run RED: compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-note-protocol.test.js dist-test/tests/v2-full-note-child.test.js dist-test/tests/v2-full-note-supervisor.test.js`; missingV4/correlation assertions fail.
- [ ] Implement request-bound V4 dispatch before old16KiB copy in entry/child/parent. Capture/check/query/revalidate one locked named image; use existing budgets/ownership/cleanup state machine and closed errors. Add full-note method to the existing adapter rather than a second independent owner; share common child resource machinery without changing V3 decoders' admitted operations.
- [ ] Run GREEN: compile, then the RED command plus `dist-test/tests/v2-native-content-child.test.js dist-test/tests/v2-native-content-supervisor.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): transport full-note reads through owned protocol4`.

### Task 10: Additive V2 private note worker/controller and preparation ingress

**Files:** Modify `src/orchestrator/governed-notes/contracts.ts`, `src/orchestrator/governed-notes/worker-protocol.ts`, `src/orchestrator/governed-notes/runtime.factory.ts`, `src/orchestrator/governed-notes/run.ts`, `src/orchestrator/governed-notes/fixture-control.ts`, `src/orchestrator/runtime/worker-protocol.ts`, `src/orchestrator/runtime/project-store-executor.ts`, `src/orchestrator/runtime/project-store-worker-backend.ts`, `src/orchestrator/runtime/project-store-worker-runtime.ts`, `tests/support/governed-note-fixture.ts`, `tests/support/governed-note-local-providers.ts`, `tests/fixtures/project-store-governed-note-worker.ts`. Create `tests/v2-full-body-note-runtime.test.ts`; test also `tests/v2-governed-note-executor.test.ts`, `tests/v2-governed-note-ownership.test.ts`.

**Interfaces:** `GovernedNoteRuntimeV2 extends GovernedNoteRuntime` adds Task3 `createV2/recoverV2`; `GovernedNoteRuntimeFactoryPortV2.create(input:RetainedEvidenceRuntimeCreateInput):GovernedNoteRuntimeV2`. Executor adds `createGovernedNoteV2(prepared:PreparedGovernedNoteCreateV2):Promise<AppendResult<GovernedNoteStoredReceiptV2>>`, `recoverGovernedNoteResultV2(prepared:PreparedGovernedNoteRecoveryV2):Promise<GovernedNoteRecoveryResultV2>`. `GovernedNoteOwnerPortV2 extends GovernedNoteOwnerPortV1` adds those two methods; `GovernedNoteRunOptionsV2 = Omit<GovernedNoteRunOptionsV1,'ownerFactory'> & {ownerFactory:(input:GovernedNoteOwnerConstructionV1)=>GovernedNoteOwnerPortV2}`. `GovernedNoteRunV2 extends GovernedNoteRunV1` adds `createV2(permit:GovernedNoteOwnerPermitV1,input:PreparedGovernedNoteCreateV2):Promise<GovernedNoteReceiptV2>`, `recoverV2(permit:GovernedNoteOwnerPermitV1,input:PreparedGovernedNoteRecoveryV2):Promise<GovernedNoteRecoveryResultV2>`; `createGovernedNoteRunV2(options:GovernedNoteRunOptionsV2):GovernedNoteRunV2` shares existing allocator/fixture/permit brands/controller. Add `decodeGovernedNoteCreateSuccessV2(value:unknown,ids:GovernedNoteRecoveryIdsV1):AppendResult<GovernedNoteStoredReceiptV2>`, `decodeGovernedNoteRecoverySuccessV2(value:unknown,ids:GovernedNoteRecoveryIdsV1):GovernedNoteRecoveryResultV2`. New fixture ActionV2/ResultV2 unions retain V1 actions/results and add `prepare-create-v2`/`prepare-recovery-v2`; RequestV2/ReplyV2 substitute those unions and correlation version2. Only admitted `prepare-create-v2` request/success gets262144 total/65536 body-empty metadata at its nested semantic body path; recovery, legacy actions and failures retain old8192/16384 limits. Add matching `decodeGovernedFixture{Action,Result,Request,Reply}V2` with V1 parameter roles and exact V2 returns, `GovernedFixtureActionPortV2` extending V1 with an execute overload for the new action union, and `executeGovernedFixtureActionV2(run:GovernedNoteRunV2,permit:GovernedNoteOwnerPermitV1,action:GovernedFixtureActionV2):Promise<GovernedFixtureResultV2>`. OwnerPortV2's fixtureActions may use this compatible port. `GovernedNoteNativeFixtureV2 extends GovernedNoteNativeFixtureV1` adds `run:GovernedNoteRunV2`, `prepareCreateV2(command:GovernedNoteCommandV2):Promise<PreparedGovernedNoteCreateV2>`, `prepareRecoveryV2(ids:GovernedNoteRecoveryIdsV1):Promise<PreparedGovernedNoteRecoveryV2>`, and widens `verifiedReadBinding(receipt:GovernedNoteReceiptV1|GovernedNoteReceiptV2):Promise<VerifiedReadBinding>`. Keys remain worker-local.

- [ ] Write `queued_v2_send_uses_owned_snapshot`, `request_version_selects_expected_success`, `v2_preparation_accepts_65536_body`, `missing_v2_runtime_refuses_before_effects`, and controller uncertainty/recovery-serialization tests.

```ts
assert.equal(executorResult.response.resultVersion, 2);
assert.ok(encodedPreparedV2Bytes <= 262144);
assert.equal(sentCommand.content.body, originalBody);
assert.equal(oldDecoderAcceptedV2Success, false);
assert.equal(responseSelectedVersion, admittedRequestVersion);
assert.equal(secondWriterConnections, 0);
await assert.rejects(() => run.reopen(permit), {code:'GOVERNED_NOTE_OWNERSHIP_UNCERTAIN'});
assert.equal(recoveryIds.commandId, originalIds.commandId);
```

Assert authorization separately16384; failure/stage/body-free product reply16384, V1 fixture bounds unchanged, purpose/fixture/permit forgery, no recovery renewal or automatic replay after timeout/lost response/forced close. Prepared wire outer shapes are identical: response-supplied version alone must never choose decoder.

- [ ] Run RED: product `npm.cmd run build`, then test compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-note-runtime.test.js`; named V2 transport/preparation behavior fails.
- [ ] Implement additive APIs sharing current FIFO/state machine, worker connection and composed factory. Backend `governedNote(request)` selects service method only after owned semantic decode, refuses absentV2 methods before effects. Retain admitted request version for response validation. Thread V2 through every private worker/runtime/run seam and trusted fixture preparation path, including native recovery's currently hardcoded version1.
- [ ] Run GREEN: current build and test compile, then RED command plus `dist-test/tests/v2-governed-note-executor.test.js dist-test/tests/v2-governed-note-ownership.test.js`; all pass.
- [ ] Commit explicit task files: `feat(v2): carry full-body commands through the private owned worker`.

### Task 11: Real-worker write to compiled-child full-note read and native closure

**Files:** Modify `tests/support/governed-note-fixture.ts`, `tests/support/v2-native-content-fixture.ts`, `tests/fixtures/v2-verified-read-process-fixture.ts`, `scripts/fresh-start-build.js`, `tests/v2-native-content-entry.test.ts`; create `tests/v2-full-note-entry.test.ts`. Modify `tests/v2-governed-note-candidate-read.test.ts` only for explicit V2/schema3 cases. Preserve existing fixture ownership/provider composition.

**Interfaces:** `makeGovernedNoteFixtureV2(options?:{child?:boolean;scenario?:string;projectionSchemaVersion?:3}):Promise<GovernedNoteNativeFixtureV2>` consumes Task10, explicitly publishes via `buildV3`, and exposes existing `verifiedReadBinding` for receipt1|2. Actual read uses Task9 adapter `queryFullNote`. Extend fixed fixture controls only for bounded stage/fault observations; never expose provider values or unchecked body retrieval. Build remains five artifacts and two isolated `.closure.json` manifests.

- [ ] Write `native_full_note_round_trip_four_kinds`, `native_escaped_65536_body_and_old_route_bounds`, `native_same_position_upgrade`, `late_full_note_success_cannot_override_uncertain_cleanup`, and extend `pure_retrieval_closure_is_exact`.

```ts
const created = await fixture.run.createV2(fixture.permit, await fixture.prepareCreateV2(command));
const read = await adapter.queryFullNote({operation:'get-full-note', consistency:'session-strong', minimumEventPosition:created.terminalPosition, budgetMs:5000, parameters:{id:created.recordId}});
assert.equal(read.content.item!.content!.body, expectedRedactedBody);
assert.equal(read.content.item!.recordKind, command.recordKind);
assert.ok(BigInt(read.receipt.projectionEventPosition) >= BigInt(created.terminalPosition));
assert.equal(read.receipt.projectionSchemaVersion, 3);
assert.equal(actualReadEntrypoint, emittedPrivateReadEntrypoint);
assert.equal(actualWriterEntrypoint, compiledGovernedFixtureWorker);
assert.equal(ownerReusableAfterUncertainCleanup, false);
assert.equal(fixtureResetCount, 0);
```

Cover root/direct-child same scope and sibling/ended/revoked negatives, source eligibility, V1 receipt recovered byV2, V1 note/body absence and generic unknown kind, frozen detached result, escaping-heavy entire reply, actual deadline/cancel/fault/cleanup. Inspect persisted events/dedup and bounded diagnostics for absence of raw secret; capture actual scope/positions and original failed recovery IDs. An in-process helper is not native proof.

- [ ] Run RED: current build/test compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-note-entry.test.js`; native path/closure assertions fail.
- [ ] Implement explicit schema3 fixture publication without another writer, including sufficient schema2/no-new-event upgrade. Pin new read-only modules and pure `governed-notes/body-content.ts` in source/emitted AST closure checks; prohibit governed repository/service, builder/coordinator, writer, dynamic loaders, child-process/worker-thread imports inside private child closure. Keep the five pure retrieval-file allowlist exact and five deployment artifacts; compiled fixture worker custody is separately identified.
- [ ] Run GREEN: current build/test compile, then RED command plus `dist-test/tests/v2-governed-note-candidate-read.test.js dist-test/tests/v2-native-content-entry.test.js`; all pass, actual owned resources close. Keep failed fixture evidence until original-ID recovery/closure classification is recorded; do not reset it for a green rerun.
- [ ] Commit explicit task files: `test(v2): prove native full-body note read-after-write`.

### Task 12: One contained increment qualification, review and evidence publication

**Files:** Create `scripts/run-v2-full-body-notes.js`, `tests/v2-full-body-notes-gate.test.ts`, `docs/evidence/v2-full-body-notes.md`; modify `package.json`. Reuse `scripts/run-v2-internal-verified-read.js` and governed runner machinery read-only; do not change historical qualification profiles or shared validation registry ceilings.

**Interfaces:** Export `runFullBodyNotesGate(options?:{root?:string;timeoutMs?:number;signal?:AbortSignal}):Promise<void>`; like the governed runner, it emits verified qualification and rejects on fixed failure, using `runFixedStages`' numeric exit internally. No-argument CLI; alias `test:v2-full-body-notes`; profile `full-body-notes`; safe failure `FULL_BODY_NOTES_GATE_FAILED`; fixed proposed total ceiling2100000ms, fixed cleanup5000ms, stage output16MiB. Do not insert this35-minute outer runner into lifecycle's300000ms validation registry; preserve registry output1048576 and bounded executable/cwd/args/env/hash allowlists.

- [ ] Write `full_body_gate_is_literal_contained_and_zero_skip`, `qualification_binds_candidate_and_private_closure`, `gate_rejects_dirty_docs_and_product_inputs`, and deadline/cancel/ownership-release tests.

```ts
assert.equal(cliAcceptedArgs, false);
assert.equal(profile.totalTimeoutMs, 2100000); assert.equal(profile.cleanupTimeoutMs, 5000);
assert.equal(profile.stageOutputMaximumBytes, 16 * 1024 * 1024);
assert.equal(failure.message, 'FULL_BODY_NOTES_GATE_FAILED');
assert.equal(success.skipped, 0);
assert.equal(success.windowsJobActiveZero, true);
assert.equal(success.lockReleasedBeforeQualification, true);
assert.equal(identityIncludesTrackedDocsAndModesAndBlobIds, true);
assert.equal(identityIncludesCompiledFixtureWorker, true);
```

- [ ] Run RED: test compile, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-full-body-notes-gate.test.js`; absent runner/profile assertions fail.
- [ ] Implement the runner/alias and prepare evidence headings with explicit unqualified status. Use literal serial stages: runtime check -> typecheck -> build -> test compile -> each file in the inventory below -> worker smoke -> fresh-start smoke. Use existing Windows Job transport, remove inherited `NODE_TEST_CONTEXT`, require native exit/drained output/active-zero, exact stage order and coherent final spec counts. Bind committed all-tracked-non-memory source bytes/modes/blob IDs, runtime executable/version/arch, build manifest, five artifacts, two closure manifests/dependency hashes, full compiled tree and named tests, explicit compiled fixture/service/controller/runtime closure. Reject hidden index flags/untracked or ignored product files/symlinks and dirty tracked docs. Retain uncertain lock ownership and exit130/124 for cancellation/deadline.
- [ ] Run GREEN: current test compile, then RED command; gate unit tests all pass, zero skips.
- [ ] Obtain fresh whole-increment spec, code-quality and security reviews after all prior task reviews. Review both approved spec and plan, V1/schema1/2 compatibility, exact lane bounds, reserved-family integrity, authenticated projection disposition, child closure and native evidence. Fix material findings through causal RED/GREEN cycles, then commit implementation and prepared evidence on a clean candidate. No qualification claim before this commit.
- [ ] Run **once** on that committed candidate: `npm.cmd run test:v2-full-body-notes`. Expected exit0 with named qualification marker only after every stage is verified and final owned lock released. Use fresh disposable native fixtures; record actual elapsed/per-stage output digests/counts, candidate source identity, build/runtime/dependency/provider/policy/timing identities, scope/positions and original recovery IDs. If it fails, classify cause and retain evidence; rerun only after a causal change or unresolved condition is addressed. Never silently widen2100000ms or substitute an old gate.
- [ ] Publish actual results in `docs/evidence/v2-full-body-notes.md` as a separate documentation commit. State qualified runtime candidate HEAD/hash distinctly from later evidence HEAD (governed source digest includes docs), review outcomes, limitations and `productionReady=false`. Historical945-pass summary evidence remains historical. End project memory with exact outcomes/files/follow-ups/verification and verify health before handing back.

**Final runner literal test inventory, in this order (each under `dist-test/tests/` with `.test.js`):**

```text
v2-full-body-note-contracts
v2-full-body-note-privacy
v2-full-body-note-command
v2-full-body-note-projection
v2-full-body-note-genesis
v2-full-body-note-publication
v2-full-body-note-summary-regression
v2-full-body-note-runtime
v2-full-note-contracts
v2-full-note-query
v2-full-note-result
v2-full-note-protocol
v2-full-note-child
v2-full-note-supervisor
v2-full-note-entry
v2-full-body-notes-gate
v2-governed-note-contracts
v2-governed-note-codec
v2-governed-note-recovery
v2-governed-note-ownership
v2-governed-note-candidate-read
projection-source-event-codec
projection-schema
projection-coordinator
projection-integrity
fresh-start-repository
fresh-start-admission
v2-native-content-query
v2-native-content-entry
v2-native-workflow-cursor
v2-native-workflow-query
```

That is31 causal files and37 serial stages including four preparation stages and two smoke stages. Earlier task cohorts provide redaction/authority/replay/append/build/old-child/supervisor focused proof; do not append their whole union or either historical gate after qualification. A reviewer may require a causal inventory correction before candidate commit; record that explicit amendment rather than silently broaden a successful gate.

## Root self-review and handoff

Spec coverage: sections1/2 -> Tasks1/3/7/10; section3 -> Tasks1/2/8/9/10; section4 -> Tasks1/2/3; section5 -> Tasks2/3/10/11; section6 -> Tasks4/5/6/7; section7 -> Tasks8/9/11; section8 -> Tasks1/2/3/9/11; section9 -> all task cohorts and Task12; section10 -> file ownership map. Review Focus has an owning named test for every entry. Every task has a RED/GREEN cycle, exact interfaces and an independently reviewable commit; neighboring tasks preserve the versioned names/types above.

Before execution, include the approved spec, Global Constraints, this task's exact interfaces/tests, historical compatibility and verification scope in every worker/reviewer brief. Preserve the chosen Subagent-Driven method. Human plan review must occur before product implementation.
