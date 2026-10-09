# V2 Private Governed Summary Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (selected and preserved) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. superpowers:executing-plans is the alternative skill only if the human changes the selected method.

**Goal:** Deliver private, provenance-linked candidate/unverified summary creation and narrowly authorized result recovery for session-log, insight, mistake and ADR records on one controlled disposable store owner.

**Architecture:** Add bounded note contracts, current same-session authority and one authenticated two-event/dedup pair on the existing SQLite owner. Extend the existing worker FIFO and executor, then place fresh-store admission and normal-close-only reopen behind an opaque run controller. Qualify a newly compiled worker-local synthetic composition and the existing private candidate read lane while preserving the closed public/production gates.

**Tech Stack:** Node.js >=24.16.0, TypeScript ^5.8.3, node:sqlite, node:worker_threads, node:test, existing capability/evidence providers and esbuild ^0.28.2; no new dependency.

**Spec:** [Approved governed summary design](../specs/2026-10-08-v2-governed-summary-commands-design.md), published at `c258b1bdcfd918c19a2755484a3bf4b6c994fd4c`, SHA256 `1e88d9daa36e4d4bd7510d77fe209c6b2d062189a19f21bbfde6e227ecaa3585`. The human explicitly answered **“อนุมัติ spec และจัดทำแผนต่อ”**. This document is the next plan for human review; implementation has not started. The source baseline is that commit; previously qualified product runtime `56232b5023e27abb35f364051e71c321b33fc0bb` remains historical evidence, not qualification of these future changes.

## Global Constraints

- Four exact kinds: `session-log | insight | mistake | adr`; summary-only, `candidate`, `unverified`. No full body, Markdown artifact, public tool, factual verification or session finalization.
- Summary nonempty and <=2,048 UTF-8 bytes at raw original, NFC-then-trim intermediate and redacted output. Preserve raw original transiently for equality; no clipping.
- Provenance 1–64 direct exact `{kind,identity}` selectors; kinds `source-event | retained-evidence`, UUIDv4 identities, duplicate selectors refused, binary kind/identity ordering, no recursion.
- Semantic create/recovery canonical input <=8,192 bytes; complete correlated success/error <=16,384 bytes; protected authorization separately <=16,384 bytes.
- Semantic/result depth <=8, aggregate containers <=128, fields per record <=32, array elements <=64, scalar text <=2,048 UTF-8 bytes. Canonical command transport string is not a semantic scalar.
- Existing complete worker transport and atomic append <=4 MiB; exactly two events and zero outbox jobs. Projection source event <=256 KiB. Redaction <=256 rules, <=2,048-byte literals and <=4,096 spans.
- R=`requestTimeoutMs` and C=`closeTimeoutMs`: mandatory integer 1..2147483647, no default. L=`recoveryProofLifetimeMs`: mandatory integer 1..120000, no default. Validate before allocation/open.
- `maxPending:128`, `executorLeaseMs:15000`, `heartbeatIntervalMs:5000`, `appendRetryDeadlineMs:R`, `sqliteBusyTimeoutMs:5000` exactly. R covers FIFO/execution after bounded construction; append retry begins after FIFO, C is escalation only, L governs worker authorization. No fixed close/native-settlement bound.
- Qualification profile `governed-summary-commands`: R=15000, C=5000, L=60000, all fixed values above, private read budget=5000. These are explicit disposable test inputs, not operational defaults or SLA. Timer range edges use injected observation without long real waits.
- Only worker-local synchronous provider/policy/clock/nonce dependencies; no parent provider RPC, network provider or provider subprocess. Synthetic provisioning survives permitted same-run normal reopen, including key versions/status/current maps.
- Create authority is current same-session protected proof: `authoritySessionId===targetSessionId`, proof nonnull, approval and childBindingGrant null. Own ACTIVE root or own nonterminal direct-access child under ACTIVE root only.
- Recovery independently passes existing `command-recovery` fresh-start admission and current same-session bounded proof. Final worker verification plus frozen result detach inside read transaction is the authorization point; disclose only after successful read COMMIT. Later healthy delivery may cross expiry; no parent clock/check/renewal.
- Fresh-only opaque allocator/controller; reserve before owner construction. Only privately observed complete normal close permits same-run reopen. `OWNERSHIP_UNCERTAIN` is absorbing; no forced-close, cross-parent, stale-session, post-end, root-on-child or operator recovery.
- Lost downstream CLIENT delivery after successful executor receipt may recover. Lost WORKER response, posted timeout/possible commit, forced cleanup and uncertain construction preserve original IDs/fixture and deny reuse permanently in this run. Never reset/delete an uncertain store to manufacture acceptance.
- No SQL migration, old-event rewrite, projection schema bump, cap increase, unrelated refactor or added production entrypoint. Keep V1 isolated, `memory_v2Status`-only public registration, `productionReady:false`, closed promotion, `FRESH_START_CONTENT_UNVERIFIED`, `requireFullEvidence=true`, `host-capability-unverified`.
- Develop in the already attached `C:/Users/Server/.codex/worktrees/v2-prod-readiness/Awakened-AI-System`, branch `codex/v2-governed-summary-commands`; do not alter the unrelated primary checkout. Root owns project-memory lifecycle. Source discovery reports are ignored preparation, not qualification.
- Preserve the accepted Task6 artifact/history/archive. Run task-focused checks, then one relevant current-candidate gate; repeat only for changed qualifying inputs or concrete failure/finding. No default/all, stress, migration or old broad Task6/read gate as reassurance.

## Review Focus

1. Normal-close reopen after key rotation must preserve historical verifier and note-MAC identities **and their status/version maps**, rather than merely regenerating matching seed bytes — G10 `normal reopen preserves provider history and status`.
2. A canonical command larger than 2,048 bytes but within 8,192 must survive generic worker envelope decoding while each semantic scalar remains capped — G07 `canonical transport exceeds scalar cap without bypassing semantic limits`.
3. A recovery result detached before expiry may be delivered after expiry, but a read-COMMIT failure must withhold that already detached value — G06 `read commit failure withholds detached committed and absent results`, G10 both delayed-delivery fixtures.
4. Optional missing `context.branchScopeId` must derive the inspected branch; an explicitly wrong scope or changed branch must refuse replay/disclosure — G02 `optional branch scope derives current binding` and G06 `current branch mismatch withholds both outcomes`.
5. Integrity/rebuild checking only the second pair member must still authenticate its companion and dedup, while unrelated opaque historical events remain untouched — G04 `range and rebuild cannot skip reserved companion`.

---

## File and interface ownership

All paths below are repository-relative to the managed checkout. NEW names are implementation decisions in this plan. Read the spec alongside the plan; its exact object keys/pair bytes are authoritative.

| Owner | Responsibility | Task |
| --- | --- | --- |
| NEW `src/orchestrator/governed-notes/contracts.ts`, `codec.ts`, `errors.ts` | Exact private types, owned bounds/canonical decoding, closed errors and timing validation | G01 |
| Existing `src/orchestrator/privacy/redaction.ts` | Export plain summary redaction using existing private policy/string machinery | G01 |
| NEW `governed-notes/authority.ts`, `intent.ts` | Connection-bound verified handles, proof targets, current projection binding and keyed original equality | G02 |
| NEW `governed-notes/provenance.repository.ts` | Direct retained-source authentication/eligibility | G03 |
| NEW `governed-notes/pair-validation.ts`, `repository.ts` | Pure pair/result invariants, authenticated durable lookup/correspondence | G04 |
| Existing append transaction, projection reader/codec and event/lifecycle integrity services | Reserved-family guarded writer and shared durable pair validation | G04 |
| NEW `governed-notes/service.ts` | Atomic create/replay, then independently admitted read-only recovery | G05/G06 |
| NEW `governed-notes/worker-protocol.ts`, `runtime.factory.ts`; existing four runtime owners | Exact wire, one FIFO/connection dispatch, safe mutation/nonmutation classifications | G07 |
| Existing `runtime/project-store-executor.ts` | Cached private normal-close observation | G08 |
| NEW `governed-notes/run.ts`, `fixture-allocation.ts` | Opaque fresh-only controller, admission serialization and run-bound fixture allocation | G09 |
| NEW `tests/support/governed-note-domain-fixture.ts` | Direct writer fixtures ONLY for isolated domain tests; never native owner evidence | G02–G06 |
| NEW `tests/support/governed-note-local-providers.ts`, `governed-note-fixture.ts`, `tests/fixtures/project-store-governed-note-worker.ts` | Worker-local synthetic composition, exclusive trusted fixture controls and private read binding | G10 |
| NEW runner plus package alias, gate tests and evidence/report docs | Fixed contained qualification and honest compiled/emitted identity | G11 |

Existing source anchors at c258b1b: retained authority `privacy/retained-evidence-authority.ts:83–183`; redaction `privacy/redaction.ts:36,124,189`; append `storage/event-append-transaction.ts:1506–1561,1695–1854`; shared correspondence `integrity/event-integrity.service.ts:61,1168,1691–1726`; projection reader `projections/event-reader.ts:455–458`; family codec `projections/source-event-codec.ts:1253–1283`; lifecycle replay `integrity/lifecycle-integrity.service.ts:3955,4611`; executor `runtime/project-store-executor.ts:643–738,1046–1153,1263–1374`; backend `runtime/project-store-worker-backend.ts:376–407,562–574,659–687`; worker FIFO `runtime/project-store-worker-runtime.ts:147–249`. Line numbers are discovery anchors, not fixed edit ranges after preceding tasks.

### Shared contracts and verification convention

- G01 defines all spec section3/5/8/10 types, including aliases, `GovernedNoteAuthoritySnapshotV1`, descriptors/witness/payload, stored receipt/result, facade receipt, recovery result, close observation and opaque fixture/permit/run interfaces. `ProjectBinding` always means `projections/contracts.ts`, not the identity module's similarly named type. `GovernedNoteStoredReceiptV1` is JSON-compatible and contains no `replay`; `GovernedNoteStoredResultV1=StoredCommandResponse<GovernedNoteStoredReceiptV1>`; create returns existing bigint `AppendResult` after parent adaptation.
- `GovernedNoteClockV1={now():string;nowMs():bigint}` and `GovernedNoteRecoveryIdsV1=Readonly<{commandId:string;idempotencyKey:string}>` are NEW common types. All command/event/proof IDs are lowercase UUIDv4. Decimal positions/generations remain strings/bigints <=9223372036854775807, positive when committed.
- Test blocks pin names and assertion oracles; test-local setup/parameter tables belong in their named test file. The domain fixture's exact public test surface is specified in G02; native fixture/controller surfaces are specified in G09/G10. Do not implement a fake authority snapshot or fake witness as the positive oracle.
- For each RED cycle first `npm run test:build`, then the listed compiled `node --test --test-concurrency=1 --test-reporter=spec ...` command. Missing imports/types during initial scaffolding are **setup failures**, not behavioral RED. Supply a narrow callable placeholder/refusal only as necessary to compile, then record the failed assertion proving the missing behavior. Never report a compiler error as behavioral RED. After implementation run the **same** focused command for GREEN and the listed affected controls once. No new tests for the plan document itself.
- Each task gets its selected SDD spec/quality review and an explicit file-scoped commit after GREEN; do not stage unrelated changes. Task numbers G01–G11 are this new increment, not renaming historical Task6. Whole-branch review follows G10 implementation and G11 gate preparation; fix actual findings before final qualification.

## G01: Bounded note types, wire codecs, errors and plain summary redaction

**Files:** Create `src/orchestrator/governed-notes/contracts.ts`, `codec.ts`, `errors.ts`; Modify `src/orchestrator/privacy/redaction.ts`; Test NEW `tests/v2-governed-note-contracts.test.ts`, `tests/v2-governed-note-redaction.test.ts`; affected control `tests/v2-retained-evidence-redaction.test.ts`.

**Interfaces:** Consumes existing identifier parsers, `retainedDataEntries`, `retainedStringMetrics`, `boundedRetainedJson`, `canonicalJson`, capability authorization types and redaction machinery. Produces exact spec types and constants `GOVERNED_NOTE_LIMITS`, `GOVERNED_NOTE_ERROR_CODES` (literal list from spec §10, no spread), `GovernedNoteError extends Error` carrying safe `code/details`; `decodeGovernedNoteErrorV1(value:unknown,ids:GovernedNoteRecoveryIdsV1|null):GovernedNoteErrorV1`; `decodeGovernedNoteCommandV1(value:unknown):GovernedNoteCommandV1`; `decodeGovernedNoteRecoveryV1(value:unknown):GovernedNoteRecoveryV1`; `encodePreparedGovernedNoteCreateV1(input:PreparedGovernedNoteCreateV1):PreparedGovernedNoteCreateWireV1` / `decodePreparedGovernedNoteCreateV1(value:unknown):PreparedGovernedNoteCreateV1`, corresponding Recovery functions; `decodeGovernedNoteStoredReceiptV1`, `decodeGovernedNoteStoredResultV1`, `decodeGovernedNoteRecoveryResultV1` each `(value:unknown):NamedType`; `validateGovernedNoteTimingV1(value:unknown):TrustedGovernedNoteTimingV1`; `redactGovernedNoteSummaryV1(summary:string,policy:TrustedRedactionPolicyV1):Readonly<{summary:string;policyId:string;policyVersion:string}>`.

- [x] **Step 1: Write exact codec/redaction boundary assertions.** Use fixed valid UUIDv4 values and the four exact kinds; parameterize input classes below without evaluating accessors/proxy traps.

```ts
// "summary caps raw normalized and redacted UTF8 without clipping"
assert.equal(Buffer.byteLength(decodeGovernedNoteCommandV1(valid2048).summary), 2048);
assert.throws(() => decodeGovernedNoteCommandV1(over2048), {code:"GOVERNED_NOTE_LIMIT_EXCEEDED"});
assert.throws(() => decodeGovernedNoteCommandV1(loneSurrogate), {code:"GOVERNED_NOTE_INPUT_INVALID"});
// "owned canonical input refuses exotic shape and duplicate selectors"
assert.equal(trapCalls, 0); assert.equal(getterCalls, 0);
assert.deepEqual(decoded.provenance, binarySortedSelectors); assert.ok(Object.isFrozen(decoded));
// "errors have exact closed code message and original identity details"
assert.equal(decodedError.message, decodedError.code);
assert.deepEqual(decodedError.details, originalIds); // only the three ID-bearing codes
assert.throws(() => decodeGovernedNoteErrorV1(partialOrExtraIds, originalIds));
// "timing supported endpoints are values not elapsed waits"
assert.equal(validateGovernedNoteTimingV1(maxProfile).requestTimeoutMs, 2147483647);
assert.equal(validateGovernedNoteTimingV1(maxProfile).recoveryProofLifetimeMs, 120000);
```

Additional named cases: `semantic packing accounts for JSON escape overhead` (8,192 accepted, 8,193 refused), `decoder structural budgets are independent` (depth8/9, containers128/129, fields32/33, array64/65 and authorization16,384/16,385), `provenance requires one through sixty four selectors` (0 refuses,1/64 accepts,65 limit refusal), `unsupported version differs from invalid shape`, `provenance set ordering preserves raw summary`, `policy and secret expansion cannot escape output cap` (rules256/257, literal2048/2049, spans4096/4097, unavailable required process secret, empty normalized/redacted result), `invalid timing refuses before any allocation` (R/C/L absent,0,negative,fraction,NaN,Infinity,R/C2147483648/MAX_SAFE_INTEGER,L120001,wrong fixed values or retry!=R). Complete error table checks every literal, non-ID exact `{}`, three ID-bearing exact original IDs, extra/symbol/accessor detail refusal and absence of WORKER_TIMEOUT.
- [x] **Step 2: Establish behavioral RED.** Compile, then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-contracts.test.js dist-test/tests/v2-governed-note-redaction.test.js`; expect named codec/bound/redaction assertion failures, not setup failure.
- [x] **Step 3: Implement the interfaces in the named owners.** Traverse own descriptors before copying; map retained helper errors safely while retaining input-vs-limit distinction. Freeze snapshots, preserve raw summary, sort selectors, enforce exact UUIDv4/decimal/timestamp/authorization shapes. Check raw/NFC-trimmed/redacted bytes independently and extract plain `transformString(...,false,0,...)` behavior sharing `trustedPolicy`; keep span manifest transient. Physical canonical wrapper uses existing 4 MiB packing, JSON parse plus independent semantic decode and byte-identical canonical equality.
- [x] **Step 4: Verify GREEN and retained redaction compatibility.** Recompile and run the same command plus `dist-test/tests/v2-retained-evidence-redaction.test.js`; all pass, no clipping, no trap execution, no changed retained behavior.
- [x] **Step 5: Commit only these six files.** `git add src/orchestrator/governed-notes/contracts.ts src/orchestrator/governed-notes/codec.ts src/orchestrator/governed-notes/errors.ts src/orchestrator/privacy/redaction.ts tests/v2-governed-note-contracts.test.ts tests/v2-governed-note-redaction.test.ts` then `git commit -m "feat: bound private governed note contracts and redaction"`.

## G02: Current same-session authority, proof targets and original-input equality

**Files:** Create `src/orchestrator/governed-notes/authority.ts`, `intent.ts`, `tests/support/governed-note-domain-fixture.ts`; Test NEW `tests/v2-governed-note-authority.test.ts`. Read existing retained authority, capability service/codecs, session/fold and branch repositories; do not widen retained permission.

**Interfaces:** Consumes G01, `CapabilityService`, `SessionAuthorityRepository`, `BranchScopeRepository`, `EvidenceKeyProvider` and exact existing proof target types. Produces separate opaque `VerifiedGovernedNoteCreateAuthority` and `VerifiedGovernedNoteRecoveryAuthority`; `GovernedNoteAuthorityVerifier({connection:SqliteConnection,capabilities:CapabilityService,clock:GovernedNoteClockV1})` with `verifyCreate(prepared,context):VerifiedGovernedNoteCreateAuthority`, `revalidateCreate(handle):GovernedNoteAuthoritySnapshotV1`, `verifyRecovery(prepared,context):VerifiedGovernedNoteRecoveryAuthority`, `revalidateRecovery(handle):GovernedNoteAuthoritySnapshotV1`, `bindingForCreate(handle):ProjectBinding`, `bindingForRecovery(handle):ProjectBinding`. Export `requireGovernedNoteCreateAuthority(connection:SqliteConnection,handle:VerifiedGovernedNoteCreateAuthority,command:GovernedNoteCommandV1):GovernedNoteAuthoritySnapshotV1` and `deriveGovernedNoteBinding(connection:SqliteConnection,context:ProjectContext,targetSessionId:string):ProjectBinding`.

Define `GovernedNoteCreateProofScopeV1=Omit<SemanticCommandProofTargetV1,'proofVersion'|'target'|'commandId'|'idempotencyKey'|'intentHash'|'proofNonce'>`; `governedNoteCreateProofTarget(command:GovernedNoteCommandV1,scope:GovernedNoteCreateProofScopeV1,binding:ProjectBinding,proofNonce:string):SemanticCommandProofTargetV1`; `governedNoteRecoveryProofTarget(request:GovernedNoteRecoveryV1,context:ProjectContext,binding:ProjectBinding,capabilityGeneration:string,proofNonce:string):BoundedOperationProofTargetV1`. Intent exports `buildGovernedNoteOriginalCommitment(command,authority,binding,ref:EvidenceKeyRefV1,provider:EvidenceKeyProvider):string`, `assertGovernedNoteOriginalEquality(command,authority,binding,witness:GovernedNoteWitnessV1,provider):void`, `governedNoteCommandHash(witness:GovernedNoteWitnessV1):string`, `governedNoteSummaryHash(summary:string):string`; parameter types are G01 exact command/authority/binding/provider types throughout.

Domain test fixture `makeGovernedNoteDomainFixture():Promise<GovernedNoteDomainFixtureV1>` exposes its isolated `connection`, root/child `ProjectContext`, actual capability/evidence providers, mutable synthetic clock, frozen policy, actual verifier and appended retained source IDs. Methods: `command(overrides?:Partial<GovernedNoteCommandV1>):GovernedNoteCommandV1`, `prepareCreate(command:GovernedNoteCommandV1,context?:ProjectContext):PreparedGovernedNoteCreateV1`, `prepareRecovery(ids:GovernedNoteRecoveryIdsV1,expiresAt:string,context?:ProjectContext):PreparedGovernedNoteRecoveryV1`, `rows():Readonly<{events:number;dedup:number;streams:number;outbox:number;authorization:number}>`, `cleanup():Promise<void>`. Test-local privileged corruption/lifecycle transitions may use this direct connection before domain calls. This fixture is explicitly not same-owner native qualification.

- [x] **Step 1: Write authority and independent cryptographic oracles.**

```ts
// "root on child sibling ended revoked and transferred authority refuse"
assert.throws(() => verifier.verifyCreate(rootOnChild, f.childContext), {code:"SESSION_OWNERSHIP_MISMATCH"});
assert.deepEqual(f.rows(), before);
// "verified handles are input verifier connection and operation bound"
assert.throws(() => requireGovernedNoteCreateAuthority(otherConnection, validHandle, command));
assert.throws(() => requireGovernedNoteCreateAuthority(f.connection, copiedHandle, command));
// "historical original equality includes scope and original Unicode"
assert.notEqual(commitmentRaw, commitmentNfcOrWhitespaceVariant);
assert.equal(commitmentReorderedSelectors, commitmentRaw);
assert.equal(governedNoteSummaryHash(redacted), independentlyComputedSummarySha);
assert.equal(governedNoteCommandHash(witness), independentlyComputedWitnessSha);
// "optional branch scope derives current binding"
assert.deepEqual(derivedWithoutOptionalScope, inspectedBinding);
assert.throws(() => deriveGovernedNoteBinding(f.connection, explicitWrongScope, sessionId), {code:"SESSION_OWNERSHIP_MISMATCH"});
```

Parameterize own ACTIVE root/own direct child positive paths; stale root generation, terminal child, ended root, role/client/namespace/workspace/branch mismatch; wrong proof domain/target/hash/nonce, retained proof substitution, forged/cross-verifier/recovery handle, altered command after verification, generation strings beyond63-bit. Independent byte vector uses the five exact domains and real newline; note MAC material canonical `{authority,binding,command}` through `evidenceMacInput`, scoped key and purpose `original-input-commitment`. Inspect output buffer clearing and map provider exception/invalid MAC/historical key absence to safe original-ID key errors, never raw exception.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-authority.test.js`; expect same-session/handle/hash/branch assertion failure.
- [x] **Step 3: Implement proof/authority and intent helpers.** Build fresh actual repository/fold/material inspection; check same-session restriction before proof verification. Separate WeakMaps bind exact verifier/connection/input/operation/snapshot/binding. Strict future expiry uses worker clock. Inspect branch without creating/rebinding it. Use historical note key on equality, constant-time MAC comparison, clear owned input/output buffers in finally; no durable raw-input SHA or new domain.
- [x] **Step 4: Verify GREEN.** Same compile/test command; both positive authority kinds and all refusal vectors pass with zero writes in refused cases.
- [x] **Step 5: Commit only these four new files.** `git add src/orchestrator/governed-notes/authority.ts src/orchestrator/governed-notes/intent.ts tests/support/governed-note-domain-fixture.ts tests/v2-governed-note-authority.test.ts` then `git commit -m "feat: verify governed note authority and original intent"`.

## G03: Authenticate direct retained-only provenance

**Files:** Create `src/orchestrator/governed-notes/provenance.repository.ts`; Modify `tests/support/governed-note-domain-fixture.ts` only for genuine retained-source cases; Test NEW `tests/v2-governed-note-provenance.test.ts`.

**Interfaces:** Consumes G01/G02, existing `RetainedEvidenceRepository.findPrior`, `assertStoredRetainedEvidenceCorrespondence`, `authenticateStoredEvent`, actual retained item transport/head validation and historical source key helpers. Produces `GovernedNoteProvenanceRepository.validate(connection:SqliteConnection,references:GovernedNoteCommandV1['provenance'],currentAuthority:GovernedNoteAuthoritySnapshotV1,projectionBinding:ProjectBinding,provider:EvidenceKeyProvider):readonly GovernedNoteProvenanceDescriptorV1[]`. Descriptors have exactly `kind,identity,sourceEventId,sourceEventPosition,sourceEventHash,sourceCommandId,sourceIdempotencyKey`; parent positions remain decimal strings.

This repository has no note command-ID parameters: key failure is internal typed `GovernedNoteProvenanceKeyUnavailable extends Error`, with fixed safe message and no provider text. G05 catches that type and emits exact ID-bearing GOVERNED_NOTE_KEY_UNAVAILABLE from its admitted original command. Never fabricate IDs from retained source commands or emit an incomplete external governed error directly from this helper.

- [x] **Step 1: Write eligibility and corruption assertions using actual retained commands.**

```ts
// "both direct selectors authenticate the same retained parent"
assert.equal(fromEvent[0].sourceEventHash, actualParent.eventHash);
assert.equal(fromItem[0].sourceEventPosition, actualParent.globalPosition.toString());
assert.deepEqual(Object.keys(fromItem[0]).sort(), exactDescriptorKeys);
// "other families foreign scope and root-on-child retained sources refuse"
assert.throws(() => repository.validate(f.connection, ineligibleRefs, authority, binding, f.provider), {code:"GOVERNED_NOTE_PROVENANCE_INELIGIBLE"});
assert.deepEqual(f.rows(), before);
// "retained orphan corruption is integrity not absence"
assert.throws(() => repository.validate(f.connection, corruptedRefs, authority, binding, f.provider), {code:"INTEGRITY_FAILURE"});
assert.equal(providerUnwrapCalls, 0);
```

Table covers missing/event-schema/generic MemorySourceRecorded/GovernedNoteCreated/lifecycle/checkpoint, foreign project/store/session/branch, authorizer!=target, authority generation mismatch, item binding.evidenceId mismatch, authenticated predecessor/genesis, bad blob/wrap/ciphertext/transport digest/head, orphan dedup/authorization, unexpected lifecycle witness/outbox. Available historical wrap/fingerprint/original source key references required for new creation; revoked/unavailable keys refuse safely without decrypt. A changed source between two calls must fail second validation, proving no cross-transaction memoization; repeated references may share only one call-local parent authentication.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-provenance.test.js`; expect eligibility/correspondence assertion failure.
- [x] **Step 3: Implement exact direct lookups and shared retained validation.** Hydrate actual rows and authenticate using actual preceding event hash; resolve item to its one parent, prove committed retained truth and exact current authority/projection binding, then current availability of recorded source refs. Return binary-sorted owned descriptors only; no recursive/global cache/decryption.
- [x] **Step 4: Verify GREEN.** Same compile/test command; accepted descriptors match real database rows, all refused/corrupt cases leave row counts unchanged and never unwrap.
- [x] **Step 5: Commit only task files.** `git add src/orchestrator/governed-notes/provenance.repository.ts tests/support/governed-note-domain-fixture.ts tests/v2-governed-note-provenance.test.ts` then `git commit -m "feat: authenticate retained-only governed provenance"`.

## G04: Guard and authenticate the durable pair across every writer/read-integrity entrance

**Files:** Create `src/orchestrator/governed-notes/pair-validation.ts`, `repository.ts`; Modify `src/orchestrator/storage/event-append-transaction.ts`, `src/orchestrator/projections/event-reader.ts`, `source-event-codec.ts`, `src/orchestrator/integrity/event-integrity.service.ts`, `lifecycle-integrity.service.ts`, and domain fixture; Test NEW `tests/v2-governed-note-codec.test.ts`. Affected controls: `tests/event-append-transaction.test.ts`, `event-integrity.test.ts`, `projection-source-event-codec.test.ts`, `v2-retained-evidence-integrity.test.ts`.

**Interfaces:** Consumes G01–G03 genuine verified authority, exact witness/source envelope and existing append/prepared/planned/result types. Produces opaque `GovernedNoteEventPlan` owned by one `EventAppendTransaction`; methods `planGovernedNoteIdentity(handle:VerifiedGovernedNoteCreateAuthority,command:GovernedNoteCommandV1):GovernedNoteEventPlan`, `prepareGovernedNote(plan:GovernedNoteEventPlan,append:AppendCommand<GovernedNoteStoredReceiptV1>,payload:GovernedNoteCreatedPayloadV1):PreparedEventAppend<GovernedNoteStoredReceiptV1>`, `discardGovernedNote(prepared:PreparedEventAppend<GovernedNoteStoredReceiptV1>):void`; `governedNotePlannedIds(plan:GovernedNoteEventPlan):Readonly<{recordId:string;noteEventId:string;sourceEventId:string}>` returns only genuine plan IDs without weakening membership.

`GovernedNotePriorV1=Readonly<{witness:GovernedNoteWitnessV1;events:readonly [StoredEvent,StoredEvent];result:GovernedNoteStoredResultV1;commandHash:string;responseHash:string}>`; `GovernedNoteRepository(connection:SqliteConnection)` with `findGovernedNotePrior(commandId:string,idempotencyKey:string):GovernedNotePriorV1|null`. `assertStoredGovernedNoteCorrespondence(connection:SqliteConnection,event:StoredEvent):GovernedNotePriorV1|null` returns null only for unrelated families. Pure `validateGovernedNotePair(events:readonly StoredEvent[],result:GovernedNoteStoredResultV1):GovernedNoteWitnessV1`; `assertGovernedNoteDedupCorrespondence(pair:GovernedNotePriorV1,row:GovernedNoteDedupRowV1):void`; `GovernedNoteDedupRowV1` is the owned decoder of existing dedup columns required by spec §5 (identities/type/state/hashes/canonical response/event IDs/positions/stream version/empty outbox), no new table. `decodeGovernedNoteCreatedPayloadV1(value:unknown):GovernedNoteCreatedPayloadV1` belongs to G01 codec but is completed here with pure cross-payload checks.

- [x] **Step 1: Write independent fixed-byte pair vectors and real stored correspondence tests.**

```ts
// "guarded pair has exact durable layout before first insert"
assert.equal(pair[1].globalPosition, pair[0].globalPosition + 1n);
assert.deepEqual(pair.map(e => e.commandEventIndex), [0, 1]);
assert.deepEqual(pair.map(e => e.streamVersion), [1n, 2n]);
assert.equal(storedResult.response.terminalPosition, pair[1].globalPosition.toString());
assert.equal(dedup.command_hash, independentWitnessSha); assert.equal(dedup.outbox_order_json, "[]");
// "generic prepare replay planning append and dedup refuse reserved family"
assert.deepEqual(rowsAfterEveryGuardRefusal, rowsBefore);
// "range and rebuild cannot skip reserved companion"
assert.equal(singleMemberRange.ok, false);
assert.ok(singleMemberRange.issues.some(i => i.code === "EVENT_HASH_MISMATCH" || i.code === "COMMAND_METADATA_MISMATCH"));
assert.throws(() => rebuildCorruptPair()); assert.deepEqual(opaqueUnknownPayloadAfter, opaqueUnknownPayloadBefore);
```

Parameterize missing/reordered/third event, wrong event ID/index/position/stream/type/scope/headers/sourceRefs/evidence fields/lifecycle witness, canonical payloadJson vs mutable payload cache, wrong receipt kind/status/scope/terminal/pair IDs, noncanonical response/hash/dedup state/outbox/lifecycle authorization. Zero dedup **and** zero events returns null; orphan event, orphan dedup, multiple OR-selector hits and identity/type mismatch refuse. Exact guarded prep rejects copied/cross-transaction handles/plans or generic reserved command/stream/companion on every entrance; full pair/result/append budgets validate before branch/stream/event insertion. Real mixed chain quick/full/range, lifecycle replay and immutable rebuild agree without provider calls; unrelated opaque historical payloads remain uninspected; V1 codec still refuses schema3.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-codec.test.js`; expect guarded storage/shared correspondence failure.
- [x] **Step 3: Implement pure pair validation and authenticated repository lookup.** Hydrate database truth locally (the retained hydrator is private), authenticate both events against actual predecessors and canonical payloadJson, then assert all §5 equalities and current dedup/response hashes. Query project plus command OR idempotency in both tables. Pair validation imports no service/append/integrity aggregator; repositories depend on pure helpers, preventing recursive integrity cycles.
- [x] **Step 4: Add genuine guarded append membership and shared consumers.** Allocate three UUIDs once per plan; weak maps bind transaction/handle/command/IDs. Governed planning follows retained read-only branch inspection; defer stream insertion to `appendPlanned` after full validation. Protect prepare/replay/planPrepared/appendPlanned/insertDedup, including reserved MemorySourceRecorded marker; use fixed witness hash rather than generic caller hash override. Projection reader checks full pair before binding filtering/yield; codec explicitly recognizes validated nonprojecting GovernedNoteCreated. Event quick/full/range and lifecycle hydration call the same stored correspondence, even when only one member lies in the checked range.
- [x] **Step 5: Verify GREEN and changed shared invariants.** Recompile, run the same command plus the four affected controls listed above. Actual valid rebuild yields one candidate; corrupt pair never silently folds/skips/returns absence; retained mixed-chain and opaque-unknown controls still pass.
- [x] **Step 6: Commit only task owners.** `git add src/orchestrator/governed-notes/pair-validation.ts src/orchestrator/governed-notes/repository.ts src/orchestrator/governed-notes/codec.ts src/orchestrator/storage/event-append-transaction.ts src/orchestrator/projections/event-reader.ts src/orchestrator/projections/source-event-codec.ts src/orchestrator/integrity/event-integrity.service.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/support/governed-note-domain-fixture.ts tests/v2-governed-note-codec.test.ts` then `git commit -m "feat: guard and authenticate governed note event pairs"`.

## G05: Atomic creation, exact replay and privacy under real transaction faults

**Files:** Create `src/orchestrator/governed-notes/service.ts`; Modify domain fixture; Test NEW `tests/v2-governed-note-command.test.ts`, `tests/v2-governed-note-replay.test.ts`; affected controls `v2-retained-evidence-command.test.ts`, `v2-retained-evidence-replay.test.ts`.

**Interfaces:** Consumes G01–G04 and existing admission/maintenance/append transaction. Produces `GovernedNoteServiceOptions={connection:SqliteConnection;events:EventAppendTransaction;repository:GovernedNoteRepository;provenance:GovernedNoteProvenanceRepository;authority:GovernedNoteAuthorityVerifier;provider:EvidenceKeyProvider;policy:()=>TrustedRedactionPolicyV1;clock:GovernedNoteClockV1;faults?:GovernedNoteFaultInjectorV1}` and `GovernedNoteService(options).create(prepared:PreparedGovernedNoteCreateV1,context:ProjectContext):AppendResult<GovernedNoteStoredReceiptV1>`. Typed fault union: `before-begin | after-note-event | after-source-event | after-dedup | before-commit | after-commit-before-response | recovery-before-final-verify | recovery-after-detach | recovery-before-commit`; interface `GovernedNoteFaultInjectorV1.inject(point:GovernedNoteFaultPointV1):void`. Between-event fault uses actual append transaction's existing `after-first-insert-before-commit` seam. Domain fixture adds `service():GovernedNoteService`.

- [x] **Step 1: Write four-kind atomic and historical replay assertions.**

```ts
// "each kind commits exactly one candidate pair and committed receipt"
assert.equal(result.deduplicated, false); assert.equal(result.finalStreamVersion, 2n);
assert.equal(after.events - before.events, 2); assert.equal(after.dedup - before.dedup, 1);
assert.equal(after.outbox, before.outbox); assert.equal(after.authorization, before.authorization);
// "exact replay returns original IDs before current policy preparation"
assert.equal(replay.deduplicated, true); assert.deepEqual(replay.eventIds, result.eventIds);
assert.deepEqual(replay.response, result.response); assert.equal(newPolicyCalls, 0);
// "same display different raw secret or Unicode conflicts"
assert.throws(() => f.service().create(changedOriginal, f.context), {code:"IDEMPOTENCY_CONFLICT"});
// "raw secret and provider exception never enter persisted or safe output bytes"
assert.equal(persistedAndOutputBytes.includes(seedSecret), false);
assert.equal(persistedAndOutputBytes.includes(providerExceptionMarker), false);
```

Table: equivalent selector reordering wins; kind/summary/confidence/provenance/C/I partial collision differs; historical MAC survives policy/current-key rotation, unavailable historical note key fails with exact originals; concurrent winner between preparation/BEGIN overrides new plan IDs, mismatching winner conflicts. Before-BEGIN, actual between-events, after-source/dedup and before-COMMIT rollback leave no partial pair; post-COMMIT failure remains original-ID unknown with real pair present. Separate pre-BEGIN busy, successful rollback busy, raw busy, rollback failure and commit-attempt uncertainty: only proven no-effect busy is marked retryable; no fake rollback/cancellation proof. Revalidate actual authority/binding/admission/maintenance/provenance inside BEGIN IMMEDIATE; revoked source/authority/control changed after preparation writes nothing. Clear owned buffers/discard genuine plans on all paths without claiming managed-string erasure.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-command.test.js dist-test/tests/v2-governed-note-replay.test.js`; expect real pair/replay/fault assertion failure.
- [x] **Step 3: Implement atomic create/replay.** Prior lookup before policy/current-key work; exact prior requires current witness authority/binding equality and historical original MAC. For new work prepare descriptors/redaction/witness/IDs, then own BEGIN IMMEDIATE, revalidate all fences and winner, append guarded pair and dedup, COMMIT, return only acknowledged result. Source envelope/headers are exactly spec §5; original summary never enters durable SHA/payload/receipt/log/error. Track commit-attempt/rollback certainty explicitly and expose existing service-classified busy marker only for proved safe attempts; all possible commits become original-ID unknown.
- [x] **Step 4: Verify GREEN and retained command/replay controls.** Recompile and run the same command plus the two affected controls; inspect actual rows and redacted byte scan, not only response flags.
- [x] **Step 5: Commit only task files.** `git add src/orchestrator/governed-notes/service.ts tests/support/governed-note-domain-fixture.ts tests/v2-governed-note-command.test.ts tests/v2-governed-note-replay.test.ts` then `git commit -m "feat: commit and replay private governed candidates atomically"`.

## G06: Independently admitted receipt recovery with worker-point authorization

**Files:** Modify `src/orchestrator/governed-notes/service.ts`, `authority.ts`, domain fixture; Test NEW `tests/v2-governed-note-recovery.test.ts`; affected control `tests/fresh-start-admission.test.ts`.

**Interfaces:** Consumes G02 recovery handles and G04 authenticated prior. Produces `GovernedNoteService.recover(prepared:PreparedGovernedNoteRecoveryV1,context:ProjectContext):GovernedNoteRecoveryResultV1`. Existing `assertFreshStartConnectionAllowed(connection,'command-recovery')` remains the gate; no new admission substitute. Authority revalidation retains exact G02 signatures and worker clock.

- [x] **Step 1: Write independent admission, absence and final-detach tests.**

```ts
// "receipt recovery needs pair truth and current authority not source keys"
assert.equal(recovered.outcome, "committed"); assert.equal(recovered.receipt.replay, true);
assert.deepEqual(providerCallsAfter, providerCallsBefore); assert.deepEqual(f.rows(), before);
// "absence requires both identity selectors absent in events and dedup"
assert.deepEqual(absent, {resultVersion:1, operation:"recover-governed-note-result", outcome:"not-found", ...originalIds});
assert.throws(() => recoverOrphan(), {code:"INTEGRITY_FAILURE"});
// "final worker detach uses strict future expiry"
assert.equal(atTMinus1.outcome, expectedOutcome);
assert.throws(() => detachAtT(), {code:"SESSION_CAPABILITY_EXPIRED"});
// "read commit failure withholds detached committed and absent results"
assert.equal(deliveredSuccesses, 0); assert.deepEqual(f.rows(), before);
```

Parameterize both committed and absent outcomes: admission active/read-only-recovery positive; failed release/build/schema/tail/freshness before lookup refuses despite valid authority; stale/ended/revoked/transferred/generation change before final verification refuses despite successful admission. Before lookup/during read/immediately before detach expiry refuses; after detach expiry alone does not revoke result. `current branch mismatch withholds both outcomes` compares derived binding to witness, including optional branch handling. Recovery does no unwrap/original MAC/source key revalidation; source key status changes after commit do not block receipt. Wrong proof operation/selectors/domain/operationId/requestId/nonce/C/I/expiry refuses. Read COMMIT/cleanup failure withholds detached candidate and uses nonmutation safe failure, never a second mutation uncertainty/automatic renewal. No receipt/body/session-state fields beyond exact union.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-recovery.test.js`; expect admission/final-authority/commit-withholding failure.
- [x] **Step 3: Implement read-only recovery.** Decode/verify independently, pass existing command-recovery gate before any durable lookup and revalidate at its existing boundaries. Own BEGIN DEFERRED, authenticate prior/qualified absence, recheck current authority and derived binding/proof, create frozen detached result at final worker observation, keep private until successful COMMIT. Before final point expiry/revocation refuses; after point no parent dependency/renewal. Withhold on read transaction failure and clear transient handles safely.
- [x] **Step 4: Verify GREEN and admission control.** Recompile and run the same command plus `dist-test/tests/fresh-start-admission.test.js`; all recovery tests have zero row delta, both outcomes use the same authorization point.
- [x] **Step 5: Commit only task files.** `git add src/orchestrator/governed-notes/service.ts src/orchestrator/governed-notes/authority.ts tests/support/governed-note-domain-fixture.ts tests/v2-governed-note-recovery.test.ts` then `git commit -m "feat: recover governed receipts at current worker authority"`.

## G07: Extend the existing wire, executor, backend and FIFO without mutation ambiguity

**Files:** Create `src/orchestrator/governed-notes/worker-protocol.ts`, `runtime.factory.ts`; Modify `src/orchestrator/runtime/worker-protocol.ts`, `project-store-executor.ts`, `project-store-worker-runtime.ts`, `project-store-worker-backend.ts`; Test NEW `tests/v2-governed-note-executor.test.ts`. Inspect/update only exhaustive consumers actually affected in `tests/project-store-executor.test.ts`, `tests/fixtures/project-store-lifecycle-runtime-worker.ts`, `tests/event-store.crash.test.ts`; controls `project-store-executor.test.ts`, `lifecycle-worker-protocol.test.ts`, `v2-retained-evidence-entry.test.ts`.

**Interfaces:** Exact two WorkerRequest variants from spec §3; no fixture-control/model variants. NEW `GovernedNoteRuntimeFactoryPort.create(input:RetainedEvidenceRuntimeCreateInput):GovernedNoteRuntime`; runtime `create(prepared:PreparedGovernedNoteCreateV1,context:ProjectContext):AppendResult<GovernedNoteStoredReceiptV1>`, `recover(prepared:PreparedGovernedNoteRecoveryV1,context:ProjectContext):GovernedNoteRecoveryResultV1`. `GovernedNoteRuntimeFactoryOptions={provider:EvidenceKeyProvider;policy:()=>TrustedRedactionPolicyV1;clock:GovernedNoteClockV1;nonceSource:CapabilityNonceSource;faults?:GovernedNoteFaultInjectorV1}`. Backend option `governedNoteRuntimeFactory?:GovernedNoteRuntimeFactoryPort`. Executor `createGovernedNote(prepared):Promise<AppendResult<GovernedNoteStoredReceiptV1>>`, `recoverGovernedNoteResult(prepared):Promise<GovernedNoteRecoveryResultV1>`.

Protocol helper types use existing decimal-position append wire pattern; `decodeGovernedNoteCreateSuccessV1(value:unknown,ids:GovernedNoteRecoveryIdsV1):GovernedNoteCreateSuccessWireV1`, `decodeGovernedNoteRecoverySuccessV1(value:unknown,ids:GovernedNoteRecoveryIdsV1):GovernedNoteRecoveryResultV1`, `GovernedNoteCreateSuccessWireV1` exact AppendResult keys with first/last/final positions as decimal strings and G01 stored receipt. Validate complete correlated envelope size, expected operation and original IDs at generic and request-specific decoding, not just one layer.

- [x] **Step 1: Write fake-worker/FIFO/backend assertion oracles.**

```ts
// "canonical transport exceeds scalar cap without bypassing semantic limits"
assert.ok(Buffer.byteLength(validWire.command) > 2048);
assert.equal(decodedRequest.type, "governed-note-create"); assert.equal(postCount, 1);
// "posted create timeout preserves original identity and poisons owner"
assert.equal(createError.code, "COMMAND_OUTCOME_UNKNOWN"); assert.deepEqual(createError.details, originalIds);
// "recovery timeout is unavailable without mutation ambiguity"
assert.equal(recoveryError.code, "WORKER_UNAVAILABLE"); assert.deepEqual(recoveryError.details, {});
// "all factories share one exact connection fence and key provider"
assert.strictEqual(governedInput.connection, lifecycleInput.connection);
assert.strictEqual(governedInput.maintenanceFence, retainedInput.maintenanceFence);
assert.strictEqual(governedInput.keyProvider, retainedInput.keyProvider);
```

Named cases: `malformed prepared and full queue post nothing`; `wrong correlation operation IDs or oversized success poisons posted create` (>16,384 including id); `safe errors require exact message details and original IDs`; `missing governed factory refuses without write`; `classified rollback busy retries in place before later FIFO request`; `raw busy and commit uncertainty never retry`; `FIFO consumes R while retry budget starts after dequeue`; `closed quiescing rebound owner refuses`; `late in-flight work is not reported cancelled`; `nonce source allocates actual planned IDs`. Controlled local policy/provider/current/status/MAC/verification throws sanitize; synthetic deferred WorkerLike call/termination observations represent stalls without launching an unbounded native hang. Existing lifecycle/retained successes/errors remain unchanged.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-executor.test.js`; expect missing admission/classification/wire/FIFO behavior failure.
- [x] **Step 3: Implement governed protocol/runtime factory and same-owner dispatch.** Independently decode parent and worker; recognize new success union in `decodeUnknownSuccess` **and** request-specific path. Build service/authority/repos on factory input's exact connection/fence/keyProvider, passing injected UUID source into append. Create uses mutation plus original semanticIdentity; recovery uses bounded scheduling **with null mutation identity**, so existing bounded OPERATION_OUTCOME_UNKNOWN path cannot apply. Map timeout safely and preserve complete closed governed errors before post. Share existing FIFO/retry/maintenance/binding, no second owner or queue.
- [x] **Step 4: Verify GREEN and nominal controls.** Recompile and run the same command plus the three listed controls. Inspect whole-compile exhaustive consumers before changing mocks; unsupported governed operations refuse explicitly, never fall through generic append. Broaden lifecycle/crash tests only if an actual affected behavior/finding requires it.
- [x] **Step 5: Commit exact changed task files.** `git add src/orchestrator/governed-notes/worker-protocol.ts src/orchestrator/governed-notes/runtime.factory.ts src/orchestrator/runtime/worker-protocol.ts src/orchestrator/runtime/project-store-executor.ts src/orchestrator/runtime/project-store-worker-runtime.ts src/orchestrator/runtime/project-store-worker-backend.ts tests/v2-governed-note-executor.test.ts` plus only the inspected nominal fixture/test files actually changed; `git commit -m "feat: dispatch governed notes on the existing worker owner"`.

## G08: Observe normal release through the existing cached close operation

**Files:** Modify `src/orchestrator/runtime/project-store-executor.ts`, `tests/project-store-executor.test.ts`, `tests/v2-governed-note-executor.test.ts`.

**Interfaces:** Consumes G01 `GovernedNoteCloseObservationV1`. Produces `ProjectStoreExecutor.closeForGovernedNoteController():Promise<GovernedNoteCloseObservationV1>` bound to private UUIDv4 ownerId. It joins the SAME `#closePromise/#quiescePromise/#terminationPromise` and cached `terminateWorker`; no independent close or second termination deadline.

- [x] **Step 1: Write pending/forced/normal close assertions.**

```ts
// "normal close observation waits for cached termination"
assert.strictEqual(executor.close(), executor.close()); assert.equal(closePosts, 1); assert.equal(terminateCalls, 1);
assert.equal(observationSettledBeforeTerminate, false);
assert.equal(normalObservation.disposition, "graceful-confirmed");
// "forced resolving close late ack poison and quiesce cannot confirm release"
assert.equal(forcedObservation.disposition, "ownership-uncertain");
assert.equal(lateAckObservation.disposition, "ownership-uncertain");
// "pending termination has no second deadline"
assert.equal(extraTerminationTimers, 0); assert.equal(closeSettled, false);
```

Parameterize drain-before-close ack, ack `closed:true`/wrong correlation/malformed/error, C escalation before late ack, already poisoned/quiesced/closed without recorded normal sequence, termination rejection/cleanup failure, repeated close/observation calls. Generic close may resolve forced paths; canReuse/state/exit/lease/heartbeat never mint confirmation. Absorbing disqualification survives late termination or late complete graceful chain.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-executor.test.js dist-test/tests/project-store-executor.test.js`; expect close observation assertions to fail while old close contracts remain visible.
- [x] **Step 3: Implement cached observation.** Record private owner identity and absorbing disqualification at poison/quiesce/escalation/cleanup uncertainty. Confirm only complete drained -> exact correlated closed:true -> completed termination with no disqualification. Cached observation joins existing close even if already initiated; do not infer release from Promise<void> resolution. Keep indefinite pending termination as pending.
- [x] **Step 4: Verify GREEN.** Same compile/test command; existing close identity/idempotence/error behavior preserved, one terminate, no false normal release.
- [x] **Step 5: Commit only these three files.** `git add src/orchestrator/runtime/project-store-executor.ts tests/project-store-executor.test.ts tests/v2-governed-note-executor.test.ts` then `git commit -m "feat: attest normal governed owner release through cached close"`.

## G09: Fresh-only opaque run controller and serialized recovery admission

**Files:** Create `src/orchestrator/governed-notes/run.ts`, `fixture-allocation.ts`; Test NEW `tests/v2-governed-note-ownership.test.ts`.

**Interfaces:** Consumes G01 timing/opaque types and G07/G08 executor. Produces `createGovernedNoteRunV1(options:GovernedNoteRunOptionsV1):GovernedNoteRunV1`, run methods exactly `open(fixture:FreshGovernedNoteFixtureV1):Promise<GovernedNoteOwnerPermitV1>`, `create(permit,input:PreparedGovernedNoteCreateV1):Promise<GovernedNoteReceiptV1>`, `recover(permit,input:PreparedGovernedNoteRecoveryV1):Promise<GovernedNoteRecoveryResultV1>`, `close(permit):Promise<void>`, `reopen(permit):Promise<GovernedNoteOwnerPermitV1>`. `GovernedNoteRunOptionsV1=Readonly<{timing:TrustedGovernedNoteTimingV1;freshInitializer:GovernedNoteFreshInitializationPortV1;ownerFactory:(input:GovernedNoteOwnerConstructionV1)=>GovernedNoteOwnerPortV1}>`; `GovernedNoteOwnerConstructionV1=Readonly<{runId:string;fixtureId:string;ownerGeneration:string;context:ProjectContext;freshStartContext:FreshStartTrustedContext;timing:TrustedGovernedNoteTimingV1}>`. `GovernedNoteFreshInitializationPortV1.initialize(input:Readonly<{freshDirectory:string;fixtureId:string}>):Promise<Readonly<{context:ProjectContext;freshStartContext:FreshStartTrustedContext}>>` is a trusted local composition dependency, invoked only after exclusive fresh allocation and rechecked against that directory's real identity/routes. Owner factory privately captures existing executor dependencies; options are trusted composition, not tool/model input. Allocator `allocateFreshGovernedNoteFixtureV1(run:GovernedNoteRunV1,input:Readonly<{parentDirectory:string}>):Promise<FreshGovernedNoteFixtureV1>`; weak-map membership binds run/fresh filesystem identity/contexts.

Private implementation record `GovernedNoteOwnerPortV1` contains `open():Promise<void>` and exact G07/G08 `createGovernedNote/recoverGovernedNoteResult/closeForGovernedNoteController` signatures plus optional G10 `fixtureActions:GovernedFixtureActionPortV1`; raw executor/connection never returned by run/permit. The controller exposes no arbitrary SQL/callback capability. Test dependency injection permits controlled trusted fake owner settlement, not tool/model caller fabrication of release observations.

**Explicit error binding for plan review:** spec §8 requires absorbing owner uncertainty, while §10 prohibits an ID-bearing error without an admitted original note C/I. This plan gives exact detail validity precedence: create/recover with admitted IDs may emit GOVERNED_NOTE_OWNERSHIP_UNCERTAIN with those IDs; uncertain setup/open/reopen/close with no particular note command emits GOVERNED_NOTE_UNAVAILABLE with exact empty details. Forged/stale/cross-run input still uses INPUT_INVALID. The store remains permanently OWNERSHIP_UNCERTAIN in every uncertain case; no availability/reopen guarantee changes. This resolves the otherwise impossible no-command-ID error shape and is an explicit documentary clarification for the human's plan review, not an implementation already made.

- [x] **Step 1: Write state machine and allocation side-effect assertions.**

```ts
// "open reserves before owner construction and denies duplicate open"
assert.equal(ownerConstructions, 1); assert.equal(secondOpenCode, "GOVERNED_NOTE_INPUT_INVALID");
// "active create makes recovery immediately busy without post or timer restart"
assert.equal(busyError.code, "GOVERNED_NOTE_OWNER_BUSY"); assert.equal(recoveryPosts, 0);
// "recovery holds exclusive admission through validated caller disposition"
assert.equal(competingCreatePosts, 0); assert.equal(competingRecoveryPosts, 0);
// "only normal release permits same-run reopen and invalidates old permit"
assert.equal(reopenConstructions, 1); assert.notStrictEqual(newPermit, oldPermit);
assert.equal(stalePermitCode, "GOVERNED_NOTE_INPUT_INVALID");
// "late receipt or exit never revives uncertain store"
assert.equal(replacementConstructions, 0); assert.equal(fixtureStillExists, true);
```

Table: forged/stale/cross-run permits/fixtures, collision/path escape/symlink/file-identity replacement, new run attaching prior directory, invalid timing before mkdir/open, uncertain constructor/open/reopen, normal close vs forced/quiesce/cleanup error, DRAINING ingress, posted timeout/late commit, queue-full definitive refusal, read protocol/timeout uncertainty, ID-bearing uncertainty after admitted valid command and generic close failure without IDs. Fresh setup handles close before owner admission; no old fixture deletion. R/C endpoints exercised with injected scheduler observations, not native long waits. Definitive nonmutation refusal returns OPEN only if owner still healthy; recovery gate remains until its validated response/rejection disposition. A competing close during fixture/recovery exclusion refuses OWNER_BUSY immediately rather than racing ingress or adding a queue; close during admitted creates enters DRAINING and joins the existing executor drain.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-ownership.test.js`; expect owner/gate/allocator assertion failures.
- [x] **Step 3: Implement fresh allocator and controller.** Exclusive random UUID child directory, existing fresh-start initialization/captured context/filesystem identity, no attach API. Reserve synchronously before constructing; private monotonic owner generation and WeakMaps enforce membership. Count creates before dispatch, decrement only definitive settlement; recovery refuses immediately if count>0 and otherwise exclusively blocks ingress through disposition. DRAINING before close await; only G08 genuine normal observation permits same-run reopen. Any uncertainty transitions once to absorbing OWNERSHIP_UNCERTAIN, retaining fixture/original IDs; never retry/remint/reset.
- [x] **Step 4: Verify GREEN.** Same compile/test command; exact state transitions/zero unauthorized posts/no replacement owner checked under deterministic settlements.
- [x] **Step 5: Commit only these three files.** `git add src/orchestrator/governed-notes/run.ts src/orchestrator/governed-notes/fixture-allocation.ts tests/v2-governed-note-ownership.test.ts` then `git commit -m "feat: serialize governed recovery behind fresh run ownership"`.

## G10: Compile and exercise local synthetic owner composition and real candidate reads

**Files:** Create `src/orchestrator/governed-notes/fixture-control.ts`, `tests/support/governed-note-local-providers.ts`, `governed-note-fixture.ts`, `tests/fixtures/project-store-governed-note-worker.ts`; Modify `src/orchestrator/governed-notes/run.ts` only for the closed trusted fixture ingress, `src/orchestrator/runtime/project-store-worker-runtime.ts`/backend only for the narrow same-FIFO/same-connection fixture seam specified below; Test NEW `tests/v2-governed-note-entry.test.ts`, `tests/v2-governed-note-candidate-read.test.ts`. Do not modify the stock worker/build artifact list or reuse retained parent-provider RPC/direct writer as native evidence.

**Interfaces:** `makeGovernedNoteFixture():Promise<GovernedNoteNativeFixtureV1>` returns `run:GovernedNoteRunV1`, `fixture:FreshGovernedNoteFixtureV1`, `permit:GovernedNoteOwnerPermitV1`, safe session/source IDs, `prepareCreate(command:GovernedNoteCommandV1):Promise<PreparedGovernedNoteCreateV1>`, `prepareRecovery(ids:GovernedNoteRecoveryIdsV1):Promise<PreparedGovernedNoteRecoveryV1>`, `verifiedReadBinding(receipt:GovernedNoteReceiptV1):Promise<VerifiedReadBinding>`, safe detached observations and `cleanup():Promise<void>`. No `writer`, raw connection, bearer/key bytes or raw executor in the returned surface. G01 timing profile is mandatory.

Provisioning type `SyntheticGovernedNoteProvisioningV1` is private harness-only: exact `{version:1,runId:string,fixtureId:string,seed:string,capabilityKeys:readonly SyntheticCapabilityKeyStateV1[],evidenceKeys:readonly SyntheticEvidenceKeyStateV1[],policy:TrustedRedactionPolicyV1,clockNow:string}`. Seed is canonical base64url encoding of32 fresh bytes. `SyntheticCapabilityKeyStateV1={purpose:CapabilityKeyPurpose,keyId:string,current:boolean,status:'available'|'revoked'|'unavailable'}`; `SyntheticEvidenceKeyStateV1={purpose:EvidenceKeyPurpose,ref:EvidenceKeyRefV1,current:boolean,status:'available'|'revoked'|'unavailable'}`. At most256 total key entries/4MiB complete private startup envelope, exact unique purpose+ref entries and exactly one current key per configured purpose; existing key-ref/policy/timestamp validators apply. It preserves key identities, verifier versions and history/status/current maps. Nonce source is constructed locally using crypto randomUUID/randomBytes, with the closed bootstrap's injected one-time ID sequence only for those actual allotted session allocations; reopening never replays a consumed UUID sequence. Worker startup constructs all local providers/factories from this trusted configuration. Import state is private to normal-close same-run provisioning, never governed wire/log/result/model input; current identity/status changes use the closed exclusive fixture action set. Receipt-only recovery uses no source decrypt/MAC.

Native `freshInitializer` uses actual `FreshStartInitializer.initializeFresh` for the newly minted directory, then the existing owned-test `activateFreshTestStore(connection,actualFreshIdentity)` only during its pre-owner isolated initialization; capture returned trusted context/control generation and close all initialization handles before `run.open`. The test-only verifier must never enter the product allocator's default behavior, stock worker or operational setup; no existing path/global FRESH_IDENTITY is silently substituted. Record the synthetic admission release/build inspector values actually used, separately from real emitted/compiled artifact hashes. They are private test dependencies, not proof of an operationally approved release. Owner context/audience is selected in trusted fixture initialization for root or own-child case, never a model override at note dispatch.

### G10 binding supplement: closed trusted actions on the existing FIFO

Define these exact NEW private types in `governed-notes/fixture-control.ts`, allowing product runtime owners to import a private composition contract without depending on test files. No public registration/WorkerRequest variant or stock-worker factory is added.

```ts
type FixtureLifecycleOperationV1 = Extract<LifecycleWorkerOperationWire, {
  operation: 'abandon-session' | 'create-child-transfer' | 'claim-child-transfer' | 'suspend-child-session'
}>;
type GovernedFixtureControlsV1 =
  | Readonly<{kind:'clock';now:string}>
  | Readonly<{kind:'policy';policy:TrustedRedactionPolicyV1}>
  | Readonly<{kind:'evidence-key-status';purpose:EvidenceKeyPurpose;ref:EvidenceKeyRefV1;status:'available'|'revoked'|'unavailable'}>
  | Readonly<{kind:'evidence-key-rotate';purpose:EvidenceKeyPurpose;ref:EvidenceKeyRefV1}>
  | Readonly<{kind:'capability-key-status';purpose:CapabilityKeyPurpose;keyId:string;status:'available'|'revoked'|'unavailable'}>;
type GovernedFixtureActionV1 =
  | Readonly<{kind:'bootstrap';rootSessionId:string;childSessionId:string}>
  | Readonly<{kind:'retain';prepared:PreparedRetainedEvidenceCommandV1}>
  | Readonly<{kind:'prepare-create';authoritySessionId:string;command:GovernedNoteCommandV1}>
  | Readonly<{kind:'prepare-recovery';authoritySessionId:string;operationId:string;requestId:string;commandId:string;idempotencyKey:string}>
  | Readonly<{kind:'change-authority';operation:FixtureLifecycleOperationV1}>
  | Readonly<{kind:'set-fixture-controls';controls:GovernedFixtureControlsV1}>;
type GovernedFixtureResultV1 =
  | Readonly<{kind:'bootstrap';rootSessionId:string;childSessionId:string}>
  | Readonly<{kind:'retain';receipt:RetainedEvidenceReceiptV1}>
  | Readonly<{kind:'prepare-create';prepared:PreparedGovernedNoteCreateV1}>
  | Readonly<{kind:'prepare-recovery';prepared:PreparedGovernedNoteRecoveryV1}>
  | Readonly<{kind:'applied';applied:true}>;
interface GovernedFixtureActionPortV1 {
  execute(action:GovernedFixtureActionV1):Promise<GovernedFixtureResultV1>;
  dispose():void;
}
```

`PreparedRetainedEvidenceCommandV1` comes from `privacy/retained-evidence-worker-protocol.ts`; `LifecycleWorkerOperationWire` and asynchronous `LifecycleWorkerRuntime.execute(operation,context):Promise<LifecycleWorkerSuccessWire>` are existing runtime types. Bootstrap constructs actual root-start/fork-child prepared operations locally using the selected injected UUID sequence and allotted session IDs; it is not a fake session-row insertion. Change-authority accepts only the enumerated existing lifecycle operations and materializes/verifies them through their existing runtime. No SQL/function/path/generic operation content is accepted.

Backend optional `trustedGovernedFixtureFactory?:TrustedGovernedFixtureFactoryV1`; synchronous `.create(input:RetainedEvidenceRuntimeCreateInput & Readonly<{context:ProjectContext;lifecycleRuntime:LifecycleWorkerRuntime;retainedEvidenceRuntime:RetainedEvidenceRuntime;governedNoteRuntime:GovernedNoteRuntime}>):GovernedFixtureActionPortV1`. This binder captures worker-local dependencies and actual same connection; action execution remains asynchronous. Backend `.executeTrustedGovernedFixtureAction(binding:WorkerBindingAssertion,action:GovernedFixtureActionV1):Promise<GovernedFixtureResultV1>` requires active matching binding and this optional factory. Call its idempotent synchronous `dispose()` through existing `closeHandles` before a successful close acknowledgement, alongside lifecycle disposal/SQLite close; any resource-disposal failure prevents normal confirmation. Local owned key buffers are cleared there without claiming total managed-memory erasure; no stronger native/provider termination contract. Runtime optional `trustedGovernedFixtureActions?:Readonly<{execute:(binding:WorkerBindingAssertion,action:GovernedFixtureActionV1)=>Promise<GovernedFixtureResultV1>}>` avoids expanding `WorkerRuntimeBackend` nominal mocks; `.enqueueTrustedGovernedFixtureAction(binding,action):Promise<GovernedFixtureResultV1>` validates bounded input, refuses closing/quiescing immediately, appends to existing `#fifo`, rechecks open/current binding/state at execution and settles the SAME FIFO. No callback argument or second queue.

Controller module-private trusted export `executeGovernedFixtureActionV1(run:GovernedNoteRunV1,permit:GovernedNoteOwnerPermitV1,action:GovernedFixtureActionV1):Promise<GovernedFixtureResultV1>` is absent from five-method run facade and tool transports. It checks private membership, OPEN/healthy/no in-flight create, takes the same admission exclusion flag as recovery before posting, holds through validated disposition, and refuses busy actions without waiting. Close/reopen cannot race this ingress. Raw port/connection/executor does not escape.

Private startup `MessagePort` transports fixture actions, never provider calls: request exact `{version:1,requestId,runId,storeId,ownerGeneration,binding,action}`; response exact `{version:1,requestId,ok:true,result}` or `{version:1,requestId,ok:false,error:GovernedNoteErrorV1}`. UUID/run/store/current positive decimal ownerGeneration/correlation and closed action/result shapes independently checked on both ends; request<=4MiB/result<=16,384, prepared note/retained/lifecycle subinputs use their existing specific limits. Never feed a retained batch through note's2,048 scalar cap. New port/generation on normal reopen, old ports closed; timeout/malformed result makes controller uncertain. A fixed safe generic failure without valid command IDs uses GOVERNED_NOTE_UNAVAILABLE, not an incomplete ID-bearing error.

Provision all synthetic current refs/history/status maps explicitly before bootstrap; local providers do not secretly rotate or invent current key versions during calls. WorkerFactory privately retains seed plus this complete bounded provisioning state. After a definitively acknowledged closed fixture control, update the private retained state to the same new refs/status/policy/clock; only normally confirmed reopen may consume it. An uncertain control/close never exports permission to reconstruct another owner. This preserves complete history without returning key bytes or introducing provider RPC. Integration asserts actual local provider status/current behavior after reopen, not just seed equality. Proof minting locally reconstructs the current capability, uses G02 targets and worker now+L, destroys handle/resume token in finally, and returns only the protected envelope; later service admission/authority still rechecks independently.

- [x] **Step 1: Write native owner and read assertions.**

```ts
// "bootstrap proof mint and mutation use one controlled local worker owner"
assert.equal(openWriterConnectionCount, 1); assert.equal(parentProviderRpcCalls, 0);
assert.equal(providerThreadId, ownerWorkerThreadId); assert.equal(factoryConnectionIdentityCount, 1);
// "normal reopen preserves provider history and status"
assert.equal(replayed.receipt.recordId, firstReceipt.recordId);
assert.deepEqual(reopenedStatusMap, expectedHistoricalStatusMap);
// "delayed committed delivery after worker authorization expiry"
assert.equal(detachTime, T - 1n); assert.equal(deliveryTime, T + 1n);
assert.equal(result.outcome, "committed"); assert.equal(parentClockCalls, 0); assert.equal(proofRenewals, 0);
// "delayed not-found delivery after worker authorization expiry"
assert.equal(absent.outcome, "not-found"); assert.equal(newCreatePostsWhileHeld, 0);
// "exact ID private read returns actual candidate summary at terminal position"
assert.equal(content.item.id, receipt.recordId); assert.equal(content.item.status, "candidate");
assert.equal(content.item.textKind, "canonical-summary"); assert.equal(content.item.text, actualRedactedSummary);
assert.equal(content.item.sourceEventPosition, receipt.terminalPosition);
assert.equal("recordKind" in content.item, false); assert.equal("verificationStatus" in content.item, false);
```

Native cases for all four kinds/root/own child, retained-only source and exact durable pair; lost downstream CLIENT result with healthy executor recovery; normal close/same-run reopen fresh proof and historical note replay; source key revoked after commit still receipt-recoverable; missing factory refuses; independent admission/authority refusal; corrupted companion never projects. Delayed committed and not-found fixtures each detach T-1, deliver T+1 while R live, COMMIT succeeds; separate detach=T refuses, no writes/automatic renewal/parent freshness check. Synthetic stalled/forced/native-termination observations stay in G07–G09 fake dependencies; do not launch real unbounded hangs here. Scan durable pair/dedup/safe outputs/logs/metrics for seeded original secret, token/key/exception markers.

Candidate read fixture closes setup handles and invokes existing `createVerifiedReadAdapter(binding).query` with exact `GetCanonicalRecordRequest`, session-strong terminal minimum and recorded5000ms budget. Image binding sessionId=null; trusted read session=note session. Verify actual kind canonical, confidence/scope/marker and VerifiedReadReceipt. Controlled search/context fixture pins ranking version `retrieval-ranking-v2-shadow-fixed-units`, candidateLimit64, tokenBudget2048, includeGlobalfalse/vectoroff/noexplain, existing candidate feature2500/fallback provenance3500 and budgets/diversity. Lag/refusal never triggers another mutation, promotion or kind boost.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-entry.test.js dist-test/tests/v2-governed-note-candidate-read.test.js`; expect local-owner/reopen/read/delivery assertions to fail. Disposable native workers only; each test awaits normal cleanup or preserves its uncertain fixture.
- [x] **Step 3: Implement bounded local providers and exclusive same-owner trusted fixture ingress.** Follow the binding supplement below, selected WorkerFactory compiled fixture and real lifecycle/retained/governed factories on ONE backend connection/fence/keyProvider. Bootstrap and mint proofs from actual same-owner current capability material; destroy handles/resume tokens in finally. No alternate writer remains after initialization. Selected later fixture changes update private provisioning history through exclusive ingress, preserving exact reopen identity.
- [x] **Step 4: Implement native fixture and existing read binding.** Capture exact initialized route/file/directory/build/admission identities, compose private projection/read supervision using existing accepted interfaces, build/catch up to receipt position and execute exact-ID/controlled-ranked queries. Keep product public content-read guard unchanged. Record private compiled worker/factory/runtime use; emitted stock worker is foundation regression only, not local custody proof.
- [x] **Step 5: Verify GREEN.** Recompile/run the same command and inspect safe row/provider/thread/identity/closed-handle observations. All new native acceptance obligations execute without skip; invalid source/scope/admission tests prove no mutation/disclosure; no parent provider callback or surviving writer.
- [x] **Step 6: Commit only task owners.** `git add src/orchestrator/governed-notes/fixture-control.ts tests/support/governed-note-local-providers.ts tests/support/governed-note-fixture.ts tests/fixtures/project-store-governed-note-worker.ts tests/v2-governed-note-entry.test.ts tests/v2-governed-note-candidate-read.test.ts src/orchestrator/governed-notes/run.ts src/orchestrator/runtime/project-store-worker-runtime.ts src/orchestrator/runtime/project-store-worker-backend.ts` then `git commit -m "test: qualify worker-local governed composition and candidate reads"`.

## G11: Fixed contained current-candidate qualification and evidence publication

**Files:** Create `scripts/run-v2-governed-summary-commands.js`, `tests/v2-governed-note-gate.test.ts`, `docs/superpowers/evidence/2026-10-08-v2-governed-summary-commands.md`, `docs/superpowers/reports/2026-10-08-v2-governed-summary-commands-verification.md`; Modify `package.json`, this plan's progress checkboxes. Shared contained runner, Job bridge, footer parser, accepted Task6 gate and build artifact list stay unchanged.

**Interfaces:** `runGovernedSummaryCommandsGate({root:string,timeoutMs:number,signal?:AbortSignal}):Promise<void>` is an internal owned-root seam, CLI accepts NO arguments. Profile `governed-summary-commands`, gate `v2-governed-summary-commands`, fixed failure `GOVERNED_SUMMARY_COMMANDS_GATE_FAILED`; default/max single total budget900000ms, injected controls1..900000ms. Package alias `test:v2-governed-summary-commands` exactly `node scripts/run-v2-governed-summary-commands.js`. Reuse exported `runFixedStages` from `scripts/run-v2-internal-verified-read.js` and `parseFinalSpecCounts` from `scripts/run-v2-retained-evidence.js`; adapt existing gate-specific identity logic locally without changing/extracting the accepted Task6 gate.

- [x] **Step 1: Write fixed-inventory/identity/finalization controls.**

```ts
// "gate has literal inventory one build one compile and one total deadline"
assert.equal(stages.length, 34); assert.equal(testStages.length, 28);
assert.equal(buildStages.length, 1); assert.equal(compileStages.length, 1);
// "failure malformed final footer mutation or missing containment never qualifies"
assert.equal(qualificationCount, 0); assert.equal(subsequentStagesRun, 0);
// "final owned-lock release is required before qualification publication"
assert.equal(successBeforeFinalRelease, false); assert.equal(lockFailureQualificationCount, 0);
```

Controls: dirty tracked docs/product, untracked/ignored product, hidden index flags, symlink/non-file/noncanonical Git modes and source/emitted/compiled/fixture mutation refuse; coherent outer final test counts only (tests>0,fail/cancelled/todo0,pass+skip==tests); nested/incomplete/contradictory footer/output overflow/native failure refuse. Cancellation/deadline includes earlier stages; unsupported containment host refuses; overlap/replaced lock/missing positive Job active-zero/drained output/bridge close/final release failure retains ownership or withholds qualification. One successful synthetic complete inventory suffices; early-refusal tests avoid repeating all34 stages. No governed acceptance case may be skipped; report any inherited skip identity/reason.
- [x] **Step 2: Establish behavioral RED.** Compile then run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-gate.test.js`; expect inventory/refusal/finalization failure.
- [x] **Step 3: Implement the fixed runner and safe prepared report.** Exact34-stage order: runtime `scripts/check-runtime.js --json`; typecheck `node_modules/typescript/bin/tsc --noEmit`; build `scripts/build.js`; compile `node_modules/typescript/bin/tsc -p tsconfig.test.json`; the28 literal test stages below, serial `--test --test-concurrency=1 --test-reporter=spec dist-test/tests/<name>.test.js`; worker smoke `scripts/smoke-worker.js`; fresh-start smoke `scripts/smoke-v2-fresh-start.js`. No npm-child indirection or extra broad gate. Pre/post bind clean source commit/raw+Git blob/modes, runtime executable, five emitted artifacts/build manifest/read closures, whole compiled tree and explicit new compiled worker/providers/factory/service/controller/test hashes. Publish success only after shared contained finalization positively releases owned lock and final deadline/abort check passes.

```text
v2-governed-note-contracts
v2-governed-note-redaction
v2-governed-note-authority
v2-governed-note-provenance
v2-governed-note-codec
v2-governed-note-command
v2-governed-note-replay
v2-governed-note-recovery
v2-governed-note-ownership
v2-governed-note-executor
v2-governed-note-entry
v2-governed-note-candidate-read
v2-governed-note-gate
v2-retained-evidence-redaction
v2-retained-evidence-command
v2-retained-evidence-replay
v2-retained-evidence-integrity
v2-retained-evidence-entry
event-append-transaction
event-store
event-integrity
stored-event-authenticator
projection-source-event-codec
projection-folds
project-store-executor
lifecycle-worker-protocol
fresh-start-admission
v2-foundation-entry
```

- [x] **Step 4: Verify GREEN for runner controls.** Recompile/run the same focused gate-test command. Prepared evidence document names immutable inventory/profile/limits and pending actual result; no passing claim before execution.
- [ ] **Step 5: Review and commit the complete candidate before qualification.** Finish selected whole-branch review against approved spec/plan, fix only actual findings and rerun their affected checks. Stage exact runner/gate/package/docs/plan owners and `git commit -m "test: add contained governed summary qualification gate"`. Require clean committed candidate; no install/baseline sweep or F3/PROD activation.
- [ ] **Step 6: Run final qualification ONCE.** `npm run test:v2-governed-summary-commands`; expected exit0, exactly34 measured stages/28 test files, one successful qualification, smoke public gates closed, no failing/cancelled/todo/new governed skip.900000ms is a ceiling, not estimated completion or evidence that it fits. If failure/timeout, retain diagnostic hashes/fixture/IDs/lock as required, identify actual stage, fix concrete cause and rerun only after changed qualifying inputs; never silently extend budget or call diagnostics acceptance.
- [ ] **Step 7: Publish exact result/evidence and close memory.** Record qualified commit, source/compiled/emitted/runtime/profile/provider/policy hashes, stage receipts/elapsed/counts/skips, fixed safe outcomes and open operational/F2/F3/F4 obligations. Raw failed test titles/output/error bodies/secrets stay out of published evidence; safe output byte counts/digests and fixed codes suffice. Reconcile generated qualification into documentary evidence and commit only those docs; explicitly distinguish qualified runtime HEAD from later docs-only HEAD. Successfully call root `memory_sessionEnd` with precise verification/paths/open follow-ups and `verify:true`, inspect health, then report this increment's outcome without claiming whole F2 or PROD complete.

## Spec coverage and root self-review record

| Approved obligation | Task/test ownership |
| --- | --- |
| §1 four summary kinds/candidate state/material recovery limits | G01 types; G05 atomic four-kind tests; G09 absorbing owner; G10 real native receipt/read |
| §2 all byte/structural/redaction/R/C/L bounds and separate clocks | G01 boundary tables; G07 FIFO/retry clock tests; G08 close pending; G09 pre-allocation/range; G10 exact profile; G11 contained single budget |
| §3 exact protected/wire types, worker-local three-factory same owner | G01/G02 transport/proof; G07 both protocol layers/factory identity; G10 local composition and sole writer |
| §4 closed direct retained provenance/key/corruption policy | G03 all selector/family/scope/key/orphan tables; G05 in-transaction second validation |
| §5 pair/witness/receipt/hash/guarded dedup/rebuild/integrity | G04 independent vectors and actual quick/full/range/rebuild/lifecycle replay; G05 real service; G10 native pair |
| §6 creation/replay/busy/rollback/commit/privacy | G05 actual transaction faults/winner/MAC/byte scans; G07 classified retry/post timeout; G09 no revival |
| §7 independent recovery admission/current proof/binding/final detach | G02 targets/current inspection; G06 both outcomes/expiry/COMMIT/refusal; G10 separately named delayed committed/not-found delivery |
| §8 fresh allocator/permits/normal release/absence serialization | G08 genuine release; G09 complete state/admission table; G10 same-owner bootstrap and reopen |
| §9 existing exact read/ranking and no fabricated fields | G10 candidate-read/controlled ranking/lag-zero-rewrite tests |
| §10 exact error union/ID details/safe classification | G01 complete closed-code table; G05/G06 safe service faults; G07 wire/post classifications; G09 controller errors |
| §11 every adversarial row and proof boundary | Parameter tables in G01–G10; meaningful native obligations mandatory in G10; G11 literal inventory/refusal/qualification |
| §12 remaining whole PROD and V1/public isolation | G10 no public/provider expansion; G11 foundation/smoke and honest pending evidence |
| §13 accepted material choices and §14 preserved evidence/reuse | Approval header/global scope; no repeated spec/method choice; G11 targeted gate and runtime/docs identity separation |

Root personally completed the five writing-plans checks after inserting the G10 binding supplement: every spec section/acceptance row maps to the table and named assertion cohorts; step actions and exact owned files are resolved; consumer type names agree across tasks; all five Review Focus conditions have owned tests; plan length is comparable to the approved74,864-byte spec and code blocks pin types/assertions rather than function bodies. Corrected the stored-integrity report oracle to existing EVENT_HASH_MISMATCH/COMMAND_METADATA_MISMATCH codes, specified private factory/owner/action types and asynchronous same-FIFO fixture ingress, fixed complete provider-history reconstruction, and separated internal provenance key refusal from command-ID-bearing external errors. G09 explicitly identifies the spec §8/§10 no-command-ID ambiguity and selects a concrete safe error binding for human plan review. Source-binding agents provided discovery only, not this self-review. No implementation naming/timing placeholder or unowned acceptance requirement remains; the explicit G09 clarification is included in the review request. No runtime test/build/compiler/install was performed during plan preparation. Plan review remains the next human gate; retain Subagent-Driven thereafter.
