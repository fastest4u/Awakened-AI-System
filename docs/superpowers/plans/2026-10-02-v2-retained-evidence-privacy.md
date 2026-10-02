# V2 Retained Evidence Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain an authorized bounded batch as redacted, authenticated encrypted evidence with one atomic event/result and recoverable original command identity.

**Architecture:** Three responsibility groups own intake/privacy, immutable evidence formats, and protected command persistence/recovery. They reuse the existing project SQLite connection and event-append transaction; there is no second event store. A distinct private worker lane carries the command without widening generic append or misclassifying it as coverage-only lifecycle work.

**Tech Stack:** Existing TypeScript ESM, Node >=24.16.0, node:crypto and qualified node:sqlite; no new dependency. Follow the [Node 24 crypto contract](https://nodejs.org/docs/latest-v24.x/api/crypto.html) for authenticated decryption and explicit tag length.

**Spec:** [Approved F2-A retained evidence privacy design](../specs/2026-10-02-v2-retained-evidence-privacy-design.md), artifact `47445e7f3c46377e60bb48e4d527664df481b3c0`. The human's subsequent `อนุมัติ` closes written-spec review; this executable plan still needs human review before implementation. Preserve the already selected Subagent-Driven method.

## Global Constraints

- Command `retain-evidence-batch`, version 1; event `EvidenceBatchRetained`, version 1; never alias `record-evidence-batch`.
- 64 frames per batch; 65,536 original UTF-8 content bytes per frame; 1,048,576 canonical original batch bytes.
- 32 unique lowercase SHA-256 artifact hashes per frame; 256 policy rules; 2,048 UTF-8 bytes per literal pattern.
- 4,096 redaction spans per batch; 2,097,152 encrypted bundle bytes including metadata/wrapped keys.
- 128 Unicode scalars per key/policy identifier; 16,384 bytes per complete safe result envelope.
- Selectors are canonical UUIDv4; ordinals are canonical nonnegative SQLite-int64 decimal strings; timestamps are canonical UTC milliseconds.
- Media types are exactly `text/plain; charset=utf-8` and `application/json`; reject malformed Unicode, extra fields, accessors, prototypes, sparse arrays and unsupported versions.
- Roles/categories and tool correlation rules are exactly spec section 4; first ordinal is zero with null predecessor; later batches continue the committed head.
- Reject whole oversized/unsupported commands; no truncation, dropped frame, binary import, compression or chunk reassembly.
- Redact before encryption; no original content or key material in durable rows, results, outbox, logs, metrics, reports or temporary files.
- Every item uses a fresh random 256-bit data key, AES-256-GCM, fresh 96-bit nonce and 128-bit tag.
- AAD binds format/project/vault/store/evidence/exact planned event/target/conversation/frame/media/policy identity.
- Dedicated evidence provider purposes are not session capability or pending-authorization keys; no plaintext key files or plaintext fallback.
- Stable command domain is `project-memory/retained-evidence-command/v1`; keyed domains are `retained-evidence-original-input/v1` and `retained-evidence-redacted-content/v1`.
- Compare exact original input with the prior accepted commitment key/policy versions; randomized encryption is not intent identity.
- Ordinary replay needs current valid proof matching recorded authorizing/target generations and binding; no cross-generation caller recovery flag.
- Add schema 9 after schema 8; migrations 1-8, old checksums, old event/hash domains and empty-evidence serialization remain unchanged.
- Event/blob/head/immutable authorization/one dedup result commit together; possible commit failure returns `COMMAND_OUTCOME_UNKNOWN` with original IDs.
- Recheck proof/ownership/target/fresh-start/maintenance inside the authoritative transaction; release generation is not session owner generation.
- Keep `requireFullEvidence=true`, coverage-only strict-end refusal, public `memory_v2Status` only, promotion closed and `productionReady:false`.
- No V1 access/import/fallback, real desktop transcripts/secrets/config/trust/install, network key discovery, hosted workflow changes, push, merge, deployment or activation.
- Synthetic provider/capture proof is not OS-backed key recovery, complete host capture, F2 completion or whole-system PROD readiness.

## Review Focus

- Deep/wide JSON and escaped multibyte secrets must be bounded before copying and redact with original byte offsets, not UTF-16 offsets — Task 1 tests `hostile shape is rejected before value access` and `JSON escapes and Unicode spans refer to original bytes`.
- Two different original secrets producing identical placeholders must conflict under the same command identity — Task 5 test `different secrets with identical redaction conflict`.
- A concurrent winner using a different accepted key/policy version must be compared under its own witness, not the losing preparation — Task 5 test `racing loser compares winner pinned versions`.
- A valid newly transferred owner must not receive the old owner's retained result through ordinary replay — Task 5 test `new owner cannot replay previous generation`.
- Worker timeout after posting/possible commit must preserve original recovery IDs without asserting rollback or successful cleanup — Task 7 test `posted retention timeout is outcome unknown`.

---

## Workspace and execution rules

Use `C:/Users/Server/.codex/worktrees/v2-fresh-start/Awakened-AI-System`, branch `codex/v2-fresh-start`, starting at `47445e7`. All paths below are repository-relative to this linked worktree. Preserve unrelated dirty work in the primary checkout. Run `git status --short` and `npm run check:runtime` before implementation; stop on changed assumptions rather than upgrading dependencies or editing live stores.

Implement Tasks 1-8 in order. Each task has behavioral RED/GREEN, a scoped local commit and fresh spec/code review under Subagent-Driven before its dependent task starts. Source-only inventories may run in parallel; do not put concurrent implementers in shared append/runtime files. Root owns project-memory session lifecycle and final plan/spec coverage review.

The current `npm test` profile rejects extra arguments. Every focused RED/GREEN command below means **first** `npm run test:build`, **then** the stated native Node command. If an export is new, add only its compilable closed/refusing skeleton before RED; a missing import/compiler error is not the required behavioral failure. Rerun compilation after source/test edits, not separately for each table row.

At each task's commit step, stage only the exact Create/Modify/Test paths owned by that task, inspect `git diff --cached --name-only` and `git diff --cached --check`, then commit the stated message. Do not use `git add .`. Keep future-task files out of that commit.

## File ownership

The following new files are planned, not existing verified source. Existing files are modified only at their named integration seams; do not restructure unrelated lifecycle code.

| Task | Create | Responsibility |
| --- | --- | --- |
| 1 | `src/orchestrator/privacy/evidence-contracts.ts` | Exact intake, safe codes, frame/result types and all caps |
| 1 | `src/orchestrator/privacy/redaction.ts` | Trusted versioned policy and deterministic bounded redaction |
| 2 | `src/orchestrator/privacy/evidence-key-provider.ts` | Private purpose-separated provider contract |
| 2 | `src/orchestrator/privacy/evidence-envelope.ts` | Authenticated envelopes, immutable cipher/wrap digests and plaintext ownership |
| 2 | `src/orchestrator/privacy/retained-evidence-intent.ts` | Keyed original-input witness and stable hash reconstruction |
| 2 | `src/orchestrator/privacy/retained-evidence-codec.ts` | Strict stored payload/ref/envelope metadata decoder shared by readers |
| 3 | `src/orchestrator/storage/migrations/0009-retained-evidence.ts` | Additive checksummed evidence tables/constraints |
| 3 | `src/orchestrator/privacy/retained-evidence.repository.ts` | Connection-bound immutable rows, head CAS and prior authorization lookup |
| 3 | `tests/support/retained-evidence-fixture.ts` | Owned real schema/authority stores and synthetic provider/policy/fault observations |
| 4 | `src/orchestrator/privacy/retained-evidence-authority.ts` | Private proof verification and nonforgeable admitted authority handles |
| 4 | `src/orchestrator/privacy/retained-evidence.service.ts` | Existing transaction orchestration, atomic retention and safe result |
| 6 | `src/orchestrator/privacy/retained-evidence-reader.ts` | Authorized event/blob authentication and redacted internal reads |
| 7 | `src/orchestrator/privacy/retained-evidence-worker-protocol.ts` | Closed private request/result wire codecs |
| 7 | `src/orchestrator/privacy/retained-evidence-runtime.factory.ts` | Trusted injected local command composition; no host provider discovery |
| 7 | `tests/fixtures/project-store-retained-evidence-worker.ts` | Same production backend composition with fixture-only synthetic dependencies |
| 8 | `scripts/run-v2-retained-evidence.js` | One fixed local acceptance target set and bounded owned test-process lifecycle |
| 8 | `docs/superpowers/reports/2026-10-02-v2-retained-evidence-acceptance.md` | Actual commit/runtime/proof scope and remaining dependencies |

| Tasks | Modify existing files | Exact seam |
| --- | --- | --- |
| 3 | `src/orchestrator/storage/migrations/registry.ts` | Register migration 9/current schema version |
| 3 | `tests/migration-registry.test.ts`, `tests/project-store-bootstrap.test.ts`, `tests/project-store-upgrade.test.ts` | Current-schema expectations only; retain historical witnesses |
| 3 | `scripts/smoke-worker.js`, `scripts/smoke-v2-fresh-start.js` | Current upgrade version and independently checked schema-9 golden |
| 3, 4, 6, 7 | `tests/ci-lifecycle-gates.test.ts` | Exact new source paths/current-schema assertion and necessary caller-target admission edges; keep baseline/V1 fences |
| 4 | `src/orchestrator/contracts/event.ts` | Stored refs/digest types, not generic append permission |
| 4, 5 | `src/orchestrator/storage/event-append-transaction.ts` | Protected planned-ID preparation, evidence SQL and replay isolation |
| 6 | `src/orchestrator/integrity/stored-event-authenticator.ts`, `src/orchestrator/integrity/event-integrity.service.ts` | Strict retained-event validation and witness/row reconstruction |
| 6 | `src/orchestrator/integrity/lifecycle-integrity.service.ts`, `src/orchestrator/storage/lifecycle-projection.repository.ts` | Strict mixed-event hydration without evidence-as-lifecycle interpretation |
| 6 | `src/orchestrator/projections/event-reader.ts`, `src/orchestrator/projections/source-event-codec.ts` | Strict refs/payload decoding and position-only retained-event branch |
| 7 | `src/orchestrator/runtime/worker-protocol.ts`, `src/orchestrator/runtime/project-store-executor.ts`, `src/orchestrator/runtime/project-store-worker-backend.ts` | Private wire, original mutation identity, injected handler and fail-closed absence |
| 7 | `tests/project-store-executor.test.ts`, `tests/lifecycle-worker-protocol.test.ts` | Posted timeout/queue/protocol behavior and unchanged coverage lane |
| 8 | `docs/superpowers/plans/2026-09-29-v2-fresh-start-delivery-roadmap.md` | Record only the proved F2-A increment, not F2/F3/F4 completion |

New tests: Task 1 owns `tests/v2-retained-evidence-contracts.test.ts` and `tests/v2-retained-evidence-redaction.test.ts`; Task 2 owns `tests/v2-retained-evidence-envelope.test.ts`; Task 3 owns `tests/v2-retained-evidence-migration.test.ts`; Task 4 owns `tests/v2-retained-evidence-command.test.ts`; Task 5 owns `tests/v2-retained-evidence-replay.test.ts`; Task 6 owns `tests/v2-retained-evidence-integrity.test.ts`; Tasks 7-8 own `tests/v2-retained-evidence-entry.test.ts`.

## Shared interface decisions

Each owning task defines these types/functions before consumers use them. Decimal positions/generations serialize as strings, not numbers or wire BigInts. Types named below are new unless an existing path is explicitly given.

**Task 1, `evidence-contracts.ts`:** `RetainEvidenceBatchCommandV1` has exactly the seven spec fields. `RetainedEvidenceFrameV1` has exactly the ten spec fields with a media/content discriminated union. `BoundedEvidenceInputV1` holds the frozen decoded command and caller-owned canonical original bytes. It is private/transient, never a storage/wire result. `RetainedEvidenceReceiptV1` is a JSON object with `resultVersion:1`, `operation:"retain-evidence-batch"`, `retentionFormat:"redacted-encrypted-v1"`, target/conversation/command/idempotency IDs, ordered `evidenceIds:string[]`, `eventPosition:string` and `finalStreamVersion:string`; no plaintext, manifests, capability or completeness claims. `RetainedEvidenceError` exposes only a closed safe code and permitted recovery IDs. New codes are `RETAINED_EVIDENCE_INPUT_INVALID`, `RETAINED_EVIDENCE_LIMIT_EXCEEDED`, `RETAINED_EVIDENCE_FORMAT_UNSUPPORTED`, `RETAINED_EVIDENCE_POLICY_UNAVAILABLE`, `RETAINED_EVIDENCE_KEY_UNAVAILABLE`, `RETAINED_EVIDENCE_FRAME_CONFLICT`, `RETAINED_EVIDENCE_ORDER_CONFLICT` and `RETAINED_EVIDENCE_UNAVAILABLE`. Preserve the existing closed authority/admission/integrity/idempotency/SQLite/unknown-outcome codes; never forward an arbitrary native code/message/cause.

```typescript
decodeRetainEvidenceBatch(value: unknown): BoundedEvidenceInputV1;
decodeRetainedEvidenceReceipt(value: unknown): RetainedEvidenceReceiptV1;
assertRetainedByteLimit(actualBytes: number, maximumBytes: number): void;
```

**Task 1, `redaction.ts`:** `TrustedRedactionPolicyV1` is trusted immutable configuration with bounded policy/version/rule IDs and resolved private values; it cannot be constructed from the command. `RedactedEvidenceFrameV1` contains the decoded nonsecret selectors, redacted content and manifest `{ruleId,startByte,endByte}[]`. `RedactedEvidenceBatchV1` contains ordered frames/policy identity/span count.

```typescript
redactEvidence(input: BoundedEvidenceInputV1, policy: TrustedRedactionPolicyV1): RedactedEvidenceBatchV1;
```

**Task 2, `evidence-key-provider.ts`:** `EvidenceKeyScope` is `{projectId:string,storeId:string}`; `EvidenceKeyRefV1` is `{keyId:string,version:string}` with a bounded identifier and canonical positive-int64 decimal version; `EvidenceKeyPurpose` is `"data-key-wrap" | "original-input-commitment" | "redacted-content-fingerprint"`. `WrappedEvidenceKeyV1` has exactly `formatVersion:1`, `keyRef:EvidenceKeyRefV1`, `algorithm:"AES-256-GCM"`, `nonce:string`, `ciphertext:string`, `tag:string`: canonical base64url bytes, fresh 12-byte nonce, 16-byte tag and encrypted 32-byte data key. The wrapping key stays inside the scoped provider and is purpose-separated from both MAC keys. Reject other versions/algorithms/fields. Provider methods are synchronous local operations; returned plaintext/data-key buffers are fresh caller-owned memory, and providers must not retain borrowed input bytes.

```typescript
interface EvidenceKeyProvider {
  currentKey(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose): EvidenceKeyRefV1;
  status(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose, ref: EvidenceKeyRefV1): "available" | "revoked" | "unavailable";
  wrap(scope: EvidenceKeyScope, ref: EvidenceKeyRefV1, dataKey: Uint8Array, aad: Uint8Array): WrappedEvidenceKeyV1;
  unwrap(scope: EvidenceKeyScope, wrapped: WrappedEvidenceKeyV1, aad: Uint8Array): Uint8Array;
  mac(scope: EvidenceKeyScope, purpose: "original-input-commitment" | "redacted-content-fingerprint", ref: EvidenceKeyRefV1, domain: string, bytes: Uint8Array): Uint8Array;
}
```

**Task 2:** `EvidenceItemBindingV1` is the exact spec AAD selector set. `EncryptedEvidenceItemV1` adds version/algorithm/nonce/tag/ciphertext/wrapped-key envelope and their recorded key refs/digests. `RetainedEvidenceIntentWitnessV1` contains spec section 7 trusted scope/generations, command identities, ordered frame identities, accepted policy/key versions and keyed original commitment. `EvidenceBatchRetainedPayloadV1` contains that witness and ordered nonsecret item metadata only.

```typescript
sealEvidenceItem(binding: EvidenceItemBindingV1, frame: RedactedEvidenceFrameV1, provider: EvidenceKeyProvider): EncryptedEvidenceItemV1;
openEvidenceItem(binding: EvidenceItemBindingV1, item: EncryptedEvidenceItemV1, provider: EvidenceKeyProvider): RedactedEvidenceFrameV1;
buildRetainedEvidenceIntent(input: BoundedEvidenceInputV1, admitted: RetainedEvidenceAuthoritySnapshotV1, policy: TrustedRedactionPolicyV1, keys: RetainedEvidenceIntentKeysV1, provider: EvidenceKeyProvider): RetainedEvidenceIntentWitnessV1;
retainedEvidenceIntentHash(witness: RetainedEvidenceIntentWitnessV1): string;
decodeEvidenceBatchRetainedPayload(value: unknown): EvidenceBatchRetainedPayloadV1;
assertRetainedStoredEvent(event: StoredEvent): EvidenceBatchRetainedPayloadV1 | null;
```

`RetainedEvidenceIntentKeysV1` pins original-commitment/fingerprint key refs. `RetainedEvidenceAuthoritySnapshotV1`, defined by Task 2 as nonsecret witness metadata, contains normalized project/vault/store/workspace/client/principal binding, authorizing/target session and parent IDs, both admitted owner/capability generations and capability kind. It is not itself authority; only Task 4's verified handle authorizes preparation/commit. `assertRetainedStoredEvent` returns null for a nonretained event only after requiring its legacy empty refs/digests; it rejects unsupported retained versions/shapes.

**Task 3, repository:** `RetainedEvidencePriorV1` joins immutable authorization, witness, authoritative event and dedup result. `RetainedStreamHeadV1` contains target/conversation identity, last frame/ordinal and CAS version. `RetainedEvidenceRepository` takes the existing `SqliteConnection`; it opens no connection/transaction and exposes only `findPrior(commandId:string,idempotencyKey:string):RetainedEvidencePriorV1|null`, `readHead(targetSessionId:string,conversationId:string):RetainedStreamHeadV1|null`, `assertCanContinue(input:BoundedEvidenceInputV1,head:RetainedStreamHeadV1|null):void`, `insertCommitted(bundle:RetainedEvidenceCommitV1):void` and `assertCorrespondence(event:StoredEvent):void`. `RetainedEvidenceCommitV1` contains the exact committed event, ordered encrypted items, immutable authorization and expected/next head. No raw input/policy secret is a field.

**Task 4:** `RetainedEvidenceInvocationV1` has trusted `ProjectContext`, bounded input and private protected authorization/proof supplied separately from the command. `VerifiedRetainedEvidenceAuthority` is a nonserializable opaque handle registered in a private WeakMap, minted only after real proof/current-target checks. `RetainedEvidenceAuthorityVerifier.verify(invocation):VerifiedRetainedEvidenceAuthority` reads the current connection-bound authority/fold; `revalidate(handle):RetainedEvidenceAuthoritySnapshotV1` repeats it on that same connection inside the transaction. New private authorization decoding requires protected kind, nonnull proof, exact authority/target selectors, null approval/grant and current audience; it does not call the closed coverage command decoder with a cast.

`RetainedEvidenceServiceOptions` contains `connection:SqliteConnection`, `events:EventAppendTransaction`, `repository:RetainedEvidenceRepository`, `authority:RetainedEvidenceAuthorityVerifier`, `provider:EvidenceKeyProvider`, trusted `policy:()=>TrustedRedactionPolicyV1`, `now:()=>string` and optional fixture-only `faults:RetainedEvidenceFaultInjector`. Its constructor takes those options. `RetainedEvidenceFaultInjector.hit(boundary,commandId,idempotencyKey):void` names only `before-begin`, `after-event`, `after-blobs`, `after-head`, `after-auth`, `after-dedup`, `before-commit`, `after-commit-before-response`; it is not a command field or deployed failure switch.

```typescript
RetainedEvidenceService.retain(invocation: RetainedEvidenceInvocationV1): AppendResult<RetainedEvidenceReceiptV1>;
EventAppendTransaction.planRetainedEvidenceIdentity(authority: VerifiedRetainedEvidenceAuthority, command: RetainEvidenceBatchCommandV1): RetainedEvidenceEventPlan;
EventAppendTransaction.prepareRetainedEvidence(plan: RetainedEvidenceEventPlan, append: AppendCommand<RetainedEvidenceReceiptV1>, payload: EvidenceBatchRetainedPayloadV1, items: readonly EncryptedEvidenceItemV1[]): PreparedEventAppend<RetainedEvidenceReceiptV1>;
```

`RetainedEvidenceEventPlan` is another connection/command-bound opaque handle with a trusted random event ID, not an optional event-ID override on generic `prepare`. Existing `planPrepared`, `appendPlanned`, `insertDedup` and `result` remain the writer primitives. The new preparation recomputes the witness hash and checks the exact plan/AAD/item/digest correspondence; it never accepts a naked override or copied authority object.

**Task 5:** `RetainedEvidenceService` owns prior equality/recovery before preparation and again inside `BEGIN IMMEDIATE`. Use the repository's joined prior; generic/lifecycle replay cannot return an evidence-authorized dedup entry. Original receipt/result stays immutable; existing `AppendResult.deduplicated` marks replay without rewriting its stored response. A newly minted valid proof nonce under the same recorded generations may authorize ordinary replay; do not require reuse of a prior transient proof or overwrite immutable initial authorization.

**Task 6:** `RetainedEvidenceReadInvocationV1`, defined in `retained-evidence-reader.ts`, contains trusted `context:ProjectContext`, `authorization:BoundedOperationAuthorization` from the existing lifecycle contract, UUIDv4 `operationId`, `requestId`, `evidenceId` and canonical `expiresAt`. `RetainedEvidenceReader.read(invocation:RetainedEvidenceReadInvocationV1):RedactedEvidenceFrameV1` needs no original plaintext. Task 6 extends the authority verifier with `verifyRead(invocation):VerifiedRetainedEvidenceAuthority`: existing bounded capability proof binds operation type `read-retained-evidence`, the exact evidence/target/scope selectors, nonce, current generation and the existing bounded-proof expiry horizon. Require current proof/exact binding and recorded-generation entitlement before repository/event/blob authentication and decryption. Opaque handles carry operation kind; a read handle cannot prepare/commit a write. This read remains internal, not a worker/public content operation. Intent/hash reconstruction uses the stored witness without provider access; authenticated plaintext/fingerprint verification is a separate claim.

**Task 7:** `PreparedRetainedEvidenceCommandV1` transports decoded command plus exact private protected authorization, never a provider/policy/opaque handle. Its proof target uses existing `SemanticCommandProofTargetV1`/`CapabilityService.verifyProof`: a transient proof intent binds the complete bounded original command and trusted scope via existing `commandHash`, whereas the durable command hash remains the new keyed witness. Never persist/log that transient original-input digest or proof material. Recompute the proof intent at the worker; do not trust a caller-provided hash. `RetainedEvidenceRuntimeFactory.create({connection,maintenanceFence,capabilityKeyProvider,context}):RetainedEvidenceRuntime` uses a trusted injected evidence provider/policy resolver; `RetainedEvidenceRuntime.execute(prepared):AppendResult<RetainedEvidenceReceiptV1>` wraps the Task 4 service. Absence of trusted provider/policy/authority composition refuses, not synthetic/default keys.

```typescript
decodePreparedRetainedEvidenceCommand(value: unknown): PreparedRetainedEvidenceCommandV1;
ProjectStoreExecutor.executeRetainedEvidenceMutation(prepared: PreparedRetainedEvidenceCommandV1): Promise<AppendResult<RetainedEvidenceReceiptV1>>;
```

## Runtime budget and cancellation boundary

Current `ProjectStoreExecutorOptions` owns positive `maxPending`, `requestTimeoutMs`, `closeTimeoutMs`, lease/heartbeat intervals and optional `appendRetryDeadlineMs`. `request` rejects queue overflow, arms the posted request timer, poisons/terminates on timeout, and preserves posted mutation command/idempotency IDs as `COMMAND_OUTCOME_UNKNOWN`. These are existing deployment options, not new numeric defaults in this plan.

Current lifecycle `execute(operation,context)` and backend `dispatch(request)` have no AbortSignal/deadline parameter. Generic append alone uses `retryPrimarySqliteBusy`; lifecycle dispatch does not. Its elapsed retry check cannot interrupt SQLite or synchronous crypto. Wire decoding, preparation, authority delivery and termination/cleanup are not collectively bounded by the request timer. The verified-read supervisor's signal/process lane is read-only and must not become write authority.

Task 7 gives retention the existing parent mutation timer/queue/poison path and the existing generic append busy-retry wrapper with `appendRetryDeadlineMs`, retrying only fully rolled-back primary busy attempts under original IDs. It adds no nested deadline, hidden retry identity or timing promises. Caps bound local transformations; posted timeout is uncertain outcome, not cancellation/rollback proof. Changing to network keys, a hard total deadline or a new interruptible provider/recovery lane requires a separately reviewed contract.

## Task 1 Bounded intake and deterministic redaction

**Files:** Create the two Task 1 source files and its two test files from File ownership. Existing canonical JSON and lifecycle identifier parsers are references, not permission to relax their historical semantics.

**Interfaces:** Consume `JsonValue`/`canonicalJson` and existing canonical timestamp/int64 parsers. Produce the Task 1 interfaces above, all caps and closed privacy errors; UUIDv4 and malformed-Unicode checks are stricter local checks, not changes to existing parsers.

- [ ] Write named contract tests for exact seven/ten fields, all roles/categories, invalid null/correlation combinations, contiguous within-batch predecessors, UUID version, int64 overflow and unsupported media/version. Add `hostile shape is rejected before value access` for getters/proxies throwing on access, prototype/sparse/cyclic/deep/wide JSON and lone surrogate keys/values. Assert the decoder refuses safely and never invokes provider/redactor work.
- [ ] Write boundary tests for exactly 64/65 frames, 65,536/65,537 frame bytes, 1,048,576/1,048,577 canonical batch bytes and 32/33 hashes. Build exact-sized valid fixtures by measuring canonical bytes, not by guessing string length; empty batches reject as invalid.
- [ ] Write redaction tests for credential fields, authorization headers, private-key blocks, configured token rules, resolved process-secret values and user literals; test overlaps/duplicate matches deterministically, missing mandatory secret reference and untrusted regex/callback refusal. Add `JSON escapes and Unicode spans refer to original bytes` and 256/257 rules, 2,048/2,049 literal bytes, 4,096/4,097 spans and 128/129 scalar IDs. Check manifest contains rule IDs/ranges only and encrypted-content input has no matched value.

```typescript
assert.equal(decoded.command.frames.length, 64);
assert.equal(Buffer.byteLength(decoded.canonicalOriginalBytes), 1_048_576);
assert.throws(() => decodeRetainEvidenceBatch(overLimit), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
assert.equal(manifest[0]!.startByte, Buffer.byteLength(originalPrefix, "utf8"));
assert.ok(!JSON.stringify(manifest).includes(syntheticSecret));
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-contracts.test.js dist-test/tests/v2-retained-evidence-redaction.test.js`; expected native nonzero at intended assertions, not compilation/fixture failure.
- [ ] Implement bounded iterative shape/UTF-8 accounting before expensive canonical copying, returning owned immutable snapshots. Implement deterministic field/token scanners/literals with stable rule ordering and overlap handling; for JSON, ranges refer to bytes of canonical original JSON content, for text to original UTF-8 content. Keep strict JSON output valid and apply rules to every free-text value; selectors remain strict typed IDs/hashes. Clear owned mutable buffers in finally, without claiming string/GC zeroization.
- [ ] Run the same command for GREEN; expected native zero/all named cases pass.
- [ ] Stage the Task 1 paths, inspect the staged diff/whitespace and commit `feat: add bounded retained evidence intake and redaction`.

## Task 2 Envelopes and immutable intent formats

**Files:** Create the four Task 2 source files and envelope test file. Task 1 tests remain unchanged unless a concrete contract defect is separately reviewed.

**Interfaces:** Consume Task 1 input/redacted/policy types. Produce the provider/envelope/witness/payload types and functions in Shared interface decisions, plus strict receipt-size verification reused at commit/wire boundaries.

- [ ] Write tests `each item uses independent data key and nonce`, `AAD matches exact event identity`, `no unauthenticated plaintext escapes`, `cipher and wrapped-key tamper refuse`, and `provider exception is safe`. Mutate each cipher/tag/nonce/AAD scope/event/media/policy and wrapped-key field; missing/revoked/foreign-purpose key must fail. Use synthetic scoped provider objects, not capability-key reuse.
- [ ] Write `random encryption does not change intent hash` and `original commitment differs for collapsed secret text`. Pin all three exact domains, accepted policy/key versions and canonical witness bytes; assert no unkeyed plaintext digest or secret value in witness/payload. Test `assertRetainedByteLimit` at 2,097,152/2,097,153 bundle bytes and 16,384/16,385 complete result bytes. Also test actual encoded bundles/results are measured and excess rejected before persistence/acknowledgement; strict codecs must not accept fake padding fields to manufacture a valid oversized result. Distinguish byte-guard unit boundaries from valid end-to-end shapes whose maximum is below that defensive cap.

```typescript
assert.equal(Buffer.from(item.nonce, "base64url").length, 12);
assert.equal(Buffer.from(item.tag, "base64url").length, 16);
assert.equal(retainedEvidenceIntentHash(firstWitness), retainedEvidenceIntentHash(secondWitness));
assert.notEqual(firstItem.ciphertext, secondItem.ciphertext);
assert.throws(() => openEvidenceItem(binding, tampered, provider), { code: "INTEGRITY_FAILURE" });
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-envelope.test.js`; require the intended envelope/witness assertion failures.
- [ ] Implement explicit `authTagLength:16`, AAD before update, tag after encryption final and authentication final before any decrypted content escapes. Encrypt canonical `{content,manifest}`; its redacted-content HMAC binds project/store/domain and recorded ref. Cipher digest covers immutable AAD/cipher/nonce/tag/ciphertext; wrap digest binds the initial envelope. Catch native/provider errors without causes/handles in safe output and clear all caller-owned keys/plaintext/failed-plaintext buffers. Key reference version is validated, not inferred from current provider selection.
- [ ] Implement strict witness/payload/ref codecs and SHA-256 of the exact new command domain plus newline plus canonical witness. Keyed MAC inputs bind their exact distinct domain, project/store and bounded canonical input. Keep existing event hash functions unchanged.
- [ ] Run the same test for GREEN; expected native zero/all named cases pass.
- [ ] Stage the Task 2 paths, inspect the staged diff/whitespace and commit `feat: define encrypted evidence envelopes and stable intent`.

## Task 3 Additive storage and real synthetic fixture

**Files:** Create migration/repository/fixture and migration test; modify Task 3 existing files in File ownership. Add exact new source paths to the CI source ratchet when first introduced; preserve its sealed baseline and exact V1 isolation.

**Interfaces:** Consume Task 2 immutable item/payload/witness codecs; produce repository/head/prior/commit interfaces. Fixture exports `makeRetainedEvidenceFixture():Promise<RetainedEvidenceFixture>` with real connection/context/authority setup, evidence provider/policy, row snapshots, owned cleanup and reopen. It exposes no fake authority result.

- [ ] Write schema tests for real 8-to-9 upgrade, unchanged bytes/checksums for migrations 1-8 and old event rows, foreign event/dedup references, duplicate frame/command binding and immutable blob/authorization UPDATE/DELETE refusal. Test repository can continue ordinal zero/null only at empty head and exact predecessor/ordinal/tool-input correlation only at committed head; cross-command duplicate frame is `RETAINED_EVIDENCE_FRAME_CONFLICT`.

```typescript
assert.equal(currentSchemaVersion, 9);
assert.deepEqual(after.oldMigrationChecksums, before.oldMigrationChecksums);
assert.deepEqual(after.oldEventRows, before.oldEventRows);
assert.throws(() => repository.assertCanContinue(wrongPredecessor, head), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" });
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-migration.test.js`; expected missing schema-9 behavior, not missing driver/runtime qualification.
- [ ] Implement strict project-scoped `retained_evidence_blobs`, `retained_evidence_stream_heads`, `retained_evidence_command_authorizations` with event/dedup FKs, frame/ordinal uniqueness, immutable initial blob/authorization triggers and head CAS. Deferred FKs may satisfy insertion order within one transaction. The repository never starts/commits transactions, returns plaintext or offers generic update/delete.
- [ ] Implement the fixture using `applyCurrentProjectStoreSchema` and real lifecycle runtime/capability setup patterns from `tests/support/v2-native-content-fixture.ts`; local helpers there are not exported APIs. Use a distinct in-memory scoped evidence provider and disposable synthetic stores. For fresh-start rejection fixtures use genuine `fresh-start-fixture.ts` transitions; do not hand-write an active production row or reuse V1 vault data.
- [ ] Update exact current-schema expectations and smoke upgrade histories to 9. Independently compute/check the schema-9 golden from registered schema/qualified database against a separately inspected migration SQL identity before writing its constant; do not dynamically accept a release's own reported fingerprint. Preserve migration-2/7 frozen smoke witnesses and status/promotion denial.
- [ ] Run the migration test for GREEN plus `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/migration-registry.test.js dist-test/tests/migration-runner.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js`; expect native zero/all required cases pass.
- [ ] Stage the Task 3 paths, inspect the staged diff/whitespace and commit `feat: add immutable retained evidence schema`.

## Task 4 Protected authority and atomic command

**Files:** Create authority/service and command test; modify event contract/append transaction and exact CI source ratchet entries. Consume Task 3 fixture; extend its genuine authority setup for root/direct-child/sibling sessions as needed.

**Interfaces:** Produce Task 4 verified/plan handles and service signatures. Reuse `CapabilityService.verifyProof`, `SessionAuthorityRepository` and `EventAppendTransaction`; do not pass the new command through `LifecycleCommandEnvelope` or its lifecycle-only override.

- [ ] Write tests `authorized batch commits one complete bundle` and `generic retained command and event are reserved even with empty refs`. Assert real event/blob/head/authorization/dedup row counts, AAD/committed event-ID equality, exact ordered refs/digests, safe result and no outbox/plaintext canonical row. Assert generic nonempty refs remain refused and a copied/forged opaque plan or authority handle cannot prepare evidence.
- [ ] Write authority table tests for root self/direct owned child success; foreign project/vault/store/workspace/client/session, sibling and child-to-root refusal; stale/revoked proof, closed/terminal target and forged parent refusal. Test same-connection proof/target revalidation, actual fresh-start prepared/recovery/disabled rejection and maintenance/release generation change between preparation and transaction admission. Test first/later stream head gaps, predecessor, duplicate frame and tool-output correlation against earlier same-batch or committed input. Add actual service cases `missing required policy or key leaves no durable effect`: compare event/blob/head/auth/dedup snapshots before/after every mandatory redaction/wrap/MAC dependency refusal.

```typescript
assert.equal(rows.retainedEvents, 1);
assert.equal(rows.blobs, accepted.command.frames.length);
assert.equal(rows.authorizations, 1);
assert.equal(rows.dedup, 1);
assert.equal(rows.heads, 1);
assert.deepEqual(event.evidenceRefs, result.response.evidenceIds);
assert.equal(item.aad.eventId, result.eventIds[0]);
assert.equal(rows.canonicalItems, 0);
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-command.test.js`; require intended authority/atomicity failures.
- [ ] Implement verification/opaque event planning and evidence-aware preparation without changing generic append permission or old empty serialization. Use stream ID `retained-evidence/${targetSessionId}/${conversationId}` and stream type `retained-evidence` in the existing store; session attribution/parent/generations remain bound in witness/event/AAD. It is not a lifecycle `session/*` event or a semantic-state transition, and cannot satisfy coverage/end completeness.
- [ ] Implement service's new-command path: bounded intake/authority/prior probe, trusted event plan, redaction/encryption, BEGIN IMMEDIATE, authoritative dedup miss plus current proof/target/head/fresh-start/maintenance recheck, existing event append, immutable blob/auth/head writes, one dedup and COMMIT before response. Validate result caps before commit and reproduce established rollback/unknown-outcome classification. Check generic/lifecycle replay for evidence authorization and reject rather than relying on null legacy authorization.
- [ ] Run the command test for GREEN plus `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-hash.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-store.test.js`; expect native zero/all required cases pass.
- [ ] Stage the Task 4 paths, inspect the staged diff/whitespace and commit `feat: retain evidence with protected atomic authority`.

## Task 5 Original result recovery and durable fault races

**Files:** Extend service/repository/fixture and append replay isolation from Tasks 3-4; create replay test. Add real worker/process barrier support to the owned fixture when testing concurrent independent connections; do not simulate a race using two sequential calls.

**Interfaces:** Consume joined prior/witness/provider status and Task 4 verified handles. Produce stable replay through `RetainedEvidenceService.retain`, not a new command, public recovery API or cross-generation flag.

- [ ] Write `exact retry and restart return original bundle`, `different secrets with identical redaction conflict`, `racing loser compares winner pinned versions`, `historical commitment key refusal retains recovery identity`, and `new owner cannot replay previous generation`. Change current policy/keys after acceptance and assert replay uses prior versions without redaction/encryption/wrap calls. Test a fresh valid proof nonce under the same recorded generations after losing the response. Changed original metadata/content/command-under-idempotency must conflict; a valid new-generation owner and stale old proof both refuse old response disclosure.
- [ ] Write real two-preparation race with a barrier before authoritative recheck; switch trusted current versions between preparations and assert exactly one event/blob set/result/head advance. Write faults before BEGIN, after event insertion, after blob insertion/head/auth/dedup work before commit, commit-before-throw/rollback-failure, and after commit before acknowledgement. Precommit row snapshot is unchanged; uncertain/postcommit fault recovers identical original bytes/IDs/result on reopening with retained historical provider keys.

```typescript
assert.deepEqual(replayed.response, accepted.response);
assert.deepEqual(afterRestart.encryptedRows, committed.encryptedRows);
assert.equal(providerObserved.wrapCallsAfterRetry, 0);
assert.equal(finalRows.retainedEvents, 1);
assert.equal(finalRows.headVersion, "1");
assert.equal(unknown.code, "COMMAND_OUTCOME_UNKNOWN");
assert.equal(unknown.details.commandId, original.commandId);
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-replay.test.js`; require intended replay/race failures and observed real write barriers.
- [ ] Implement prior equality before any encryption and inside transaction using the winner's pinned commitment ref, policy identity and recorded generations. Compare current valid proof/binding before response disclosure; missing/revoked historical key is safe key refusal with original IDs, never replacement or guessed equality. Discard/clear losing nondurable bundles. Use actual connection fault wrappers/process closure patterns from existing event-store/lifecycle crash tests; close all owned children/connections before directory cleanup.
- [ ] Run the same replay test for GREEN; expected native zero/all required cases pass with observed race/fault boundaries.
- [ ] Stage the Task 5 paths, inspect the staged diff/whitespace and commit `feat: recover original retained evidence outcomes`.

## Task 6 Strict integrity readers and authorized redacted reads

**Files:** Create reader/integrity test; extend the Task 4 authority module for private reads; modify the six Task 6 existing reader/authenticator files and CI exact source entries. Do not add privacy decryption/imports to the isolated verified-read child graph.

**Interfaces:** Consume shared stored codec/repository/verified authority/envelope functions. Produce `RetainedEvidenceReader.read` and strict retained-event reconstruction in existing quick/full/range/read paths; no public reader registration.

- [ ] Write `legacy empty hash vectors remain identical`, `mixed chain reconstructs retained witness without provider`, `missing or swapped blob refuses`, `retained version and ref mismatch refuse`, `retained event advances projection without canonical content`, and `historical unknown remains unprojected`. Preserve exact legacy hash/checksum golden vectors rather than regenerate them. Exercise stored event hydration through projection, lifecycle and event integrity paths, not just a unit codec.
- [ ] Write reader tests for current authorized root/direct child and unauthorized scope/generation/expired proof; bind the bounded proof to exact evidence ID and reject a read handle used for write preparation. Read without resubmitting original plaintext. Verify cipher/wrap/AAD/tag and recorded redacted fingerprint before content return. Assert bad key/fingerprint/tampered manifest/body and native failures expose no original/decrypted bytes or provider error messages. Verify retained stream does not change session lifecycle stream version/state or coverage-only strict-end denial.

```typescript
assert.equal(reconstructed.commandHash, acceptedWitnessHash);
assert.equal(providerObserved.integrityMacCalls, 0);
assert.equal(projected.position, retainedEvent.globalPosition);
assert.deepEqual(projected.canonicalItems, []);
assert.deepEqual(decodeProjectionEvent(historicalUnknown), { kind: "unprojected", eventPosition: 42n, eventType: "UnrecognizedV99" });
assert.throws(() => reader.read(swappedEvidenceSelector), { code: "SESSION_CAPABILITY_INVALID" });
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-integrity.test.js`; require intended mixed-row/projection/reader failures.
- [ ] Replace empty-only/cast-only hydration with the exact shared branch; validate ref/digest/payload shape even when the event is otherwise unprojected. Event integrity joins actual blobs/authorization/head/dedup and checks witness/hash/result correspondence. Stored-event authenticator checks metadata before its existing event hash, without altering domains. Lifecycle integrity accepts authenticated non-lifecycle retained rows in its global cursor without folding them into session states. Projection decoders recognize version 1 and advance position without decrypting/canonical promotion; unrelated historical unknowns retain existing behavior.
- [ ] Implement authorized private reads with no plaintext fallback using the exact Task 6 bounded proof and recorded-generation check.
- [ ] Run the integrity test for GREEN plus the exact reader/hash/projection and coverage groups in the final matrix; expect native zero/all required cases pass.
- [ ] Stage the Task 6 paths, inspect the staged diff/whitespace and commit `feat: authenticate retained evidence across mixed event readers`.

## Task 7 Private worker integration with honest timeout semantics

**Files:** Create the Task 7 protocol/factory/fixture; extend entry test and existing executor/protocol tests; modify the three listed runtime files and exact CI source/admission entries. No public app/config/MCP registry change and no new production artifact or test provider import in production.

**Interfaces:** Produce Task 7 decoded private command/factory/executor interfaces. Extend `WorkerRequest` only with `{id,type:"retained-evidence",binding,prepared}` and a matching safe result. The backend injects `retainedEvidenceRuntimeFactory` separately from the existing lifecycle factory; its absence is a closed retention-unavailable failure. Leave closed lifecycle command/result unions unchanged.

- [ ] Write `private wire rejects weakened authorization and caller hash`, `queue full posts nothing`, `posted retention timeout is outcome unknown`, `unposted failure is not a committed result`, and `missing private composition refuses`. Exercise fake scheduler/worker timeout deterministically and a real synthetic fixture worker for successful dispatch/reopen. Test complete result 16,384-byte cap and original IDs on unknown outcome. Existing coverage protocol must reject a retain command rather than reinterpret it.
- [ ] Write backend tests for bounded primary busy retries using the existing append deadline option, full rollback before retry and no retry after uncertain commit. Test trusted factory errors/provider messages become closed nonsecret wire errors; caller-supplied proof/selectors cannot grant a private provider or weaken policy. Exercise prepared/recovery/disabled production admission independently of fixture success.

```typescript
assert.equal(queueFull.code, "STORE_QUEUE_FULL");
assert.equal(workerObserved.postsAfterQueueFull, 0);
assert.equal(postedTimeout.code, "COMMAND_OUTCOME_UNKNOWN");
assert.equal(postedTimeout.details.commandId, original.commandId);
assert.equal(postedTimeout.details.idempotencyKey, original.idempotencyKey);
assert.equal(missingComposition.code, "RETAINED_EVIDENCE_UNAVAILABLE");
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-entry.test.js dist-test/tests/project-store-executor.test.js dist-test/tests/lifecycle-worker-protocol.test.js`; require intended new-lane failures.
- [ ] Implement exact request/result decoding before post, original semantic mutation identity and existing timer/poison handling. Apply the existing 4 MiB outer wire bound in addition to the tighter command/result caps; new-lane failure decoding accepts only the closed safe codes/recovery IDs. Compose the same service/connection/authority/provider path in the injected fixture worker and backend; synchronous crypto remains local and uninterruptible, not an AbortSignal guarantee. Use existing busy wrapper only for rolled-back primary busy; no generic/lifecycle authorization shortcut and no automatic new identity on recovery.
- [ ] Extend `APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF` only with newly changed **exact** source paths from this plan's ownership map. Add exact caller/target edge `retained-evidence.service.ts` to `fresh-start/fresh-start-admission.ts` only if that direct import is used; otherwise use existing guarded append admission. Preserve baseline/V1 byte checks, forbidden fixture/migration/public-promotion imports and no wildcard exemption.
- [ ] Run the entry/executor/protocol RED command for GREEN; expect native zero/all required cases pass.
- [ ] Stage only Task 7's exact paths before the Git-based source ratchet so it sees new files, and inspect the staged diff/whitespace.
- [ ] Run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-lifecycle-gates.test.js dist-test/tests/ci-fresh-start-foundation.test.js`; require native zero before committing.
- [ ] Commit the reviewed staged Task 7 changes as `feat: dispatch private retained evidence mutations`.

## Task 8 Compiled isolated acceptance and accurate handoff

**Files:** Create the fixed local runner and acceptance report; extend entry test; update only the stated roadmap increment. Do not change `.github` workflows, upload slots or default migration/full-suite test profiles.

**Interfaces:** Consume the eight exact new test files and actual private backend/factory. Runner accepts only `--group focused` or `--group acceptance` (default focused); no arbitrary file list. It compiles once, runs the fixed new files, and for acceptance also runs the final affected matrix/build/smokes once with exclusive build ownership. Receipts contain actual commit/runtime/exit/count data and safe evidence IDs/digests, never test secrets or fixture command bodies.

- [ ] Write entry acceptance `compiled private composition retains and reopens synthetic batch` and `compiled prepared service remains status only`. First drives the emitted `dist-test` fixture through real backend/private service, proof/crypto/SQLite, loses acknowledgement/reopens and verifies original rows/result. Second independently drives the measured `dist/workers/project-store.worker.js`/V2 artifacts and requires missing private provider or prepared admission to refuse; it is not artifact happy-path retention proof. Confirm nine unverified desktop qualification rows are not upgraded by this test.
- [ ] Write `synthetic originals absent from durable and output surfaces`: scan owned DB/WAL/storage/output/error/log/report/outbox surfaces for known fixture secrets, unwrapped keys and original content; include failed attempts, concurrency and provider/native exceptions. Inspect raw persisted JSON and actual output, not a report assembled from expected answers. Test runner refuses unknown groups and cannot launch overlapping compiler/build stages.

```typescript
assert.deepEqual(reopened.response, accepted.response);
assert.ok(observedSurfaces.every(value => !value.includes(syntheticSecret)));
assert.deepEqual(publicTools, ["memory_v2Status"]);
assert.equal(publicStatus.productionReady, false);
assert.equal(strictSessionEndRefused, true);
```

- [ ] Run RED: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-entry.test.js`; require intended compiled/privacy assertions, not missing build artifacts. Build artifacts before the artifact-specific RED if its own prerequisites are already green.
- [ ] Implement only missing acceptance/runner behavior and run the final matrix below once after task reviews on a recorded committed candidate. Observe child process close/worker termination separately from caller timeout and retain incomplete cleanup as failure, not a pass. Record each command's native exit/count/failure and precise compiled-source versus measured-artifact scope.
- [ ] Write report/roadmap from actual results; if final code changes follow acceptance, requalify affected rows on the new candidate before claiming it accepted.
- [ ] Stage the Task 8 paths, inspect the staged diff/whitespace and commit `test: qualify private retained evidence foundation`.
- [ ] Close project memory with verify:true after recording the final commit/proof identities and remaining follow-ups. Completion wording is **private retained-evidence foundation accepted** only when every required row is proved and whole-branch review passes; do not claim the prior compiled result covers changed product bytes.

## Final affected verification matrix

Run from the linked worktree, one command at a time; read native exit status and all failing tests. Reuse a single `test:build` between unchanged test commands. Do not run the whole legacy migration/retrieval/full suite for each task or delete its tests. The following matrix is this increment's proof, not F3 exact-release proof.

```powershell
npm run check:runtime
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-contracts.test.js dist-test/tests/v2-retained-evidence-redaction.test.js dist-test/tests/v2-retained-evidence-envelope.test.js dist-test/tests/v2-retained-evidence-migration.test.js dist-test/tests/v2-retained-evidence-command.test.js dist-test/tests/v2-retained-evidence-replay.test.js dist-test/tests/v2-retained-evidence-integrity.test.js
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-hash.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-store.test.js dist-test/tests/stored-event-authenticator.test.js dist-test/tests/event-integrity.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/projection-runtime.test.js
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/migration-registry.test.js dist-test/tests/migration-runner.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/sqlite-driver.test.js
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/lifecycle-executor.test.js dist-test/tests/project-store-executor.test.js dist-test/tests/evidence-coverage.test.js dist-test/tests/fresh-start-admission.test.js dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/ci-lifecycle-gates.test.js dist-test/tests/ci-fresh-start-foundation.test.js
npm run typecheck
npm run build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-retained-evidence-entry.test.js dist-test/tests/v2-foundation-entry.test.js dist-test/tests/runtime-capabilities.test.js
node scripts/smoke-worker.js
node scripts/smoke-v2-fresh-start.js
```

Expected: every applicable command exits zero, no failed/unfinished required rows, compiled artifact identities match the observed build, public status/promotion/full-evidence denial is unchanged. A failing or hanging row requires focused diagnosis and honest open status; no placeholder passing count, timeout increase without cause, fake active release or deletion/relabeling of historical evidence.

## Coverage and human review

Spec sections 1-3/9 trust and private scope are owned by Tasks 4/7/8; section 4 input/stream continuity by Tasks 1/3/4; section 5 redaction by Tasks 1/2/8; sections 6-7 crypto/intent/recovery by Tasks 2/5/6; section 8 storage/history/readers by Tasks 3/4/6; section 10 acceptance by each task's named tests and Task 8. Section 11's later F2/F3/F4 work remains explicitly outside this plan.

After authoring, root checks spec coverage, step granularity, producer/consumer type consistency, all five Review Focus test owners, and proportion to the spec; fix defects inline. Human reviews this saved plan before code execution. Neither this plan nor its local publication activates retention/public V2/PROD or qualifies actual desktop complete capture, operational keys, erasure/rotation/recovery, governed canonical content, F3 release restore or F4 live cutover.
