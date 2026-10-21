# V2 private governed summary commands — design

Date: 2026-10-08 (Asia/Bangkok). **Status: written specification for human review; product implementation has not started.**

The human requested continuation of the remaining F2 work after accepted Task6. This is the next independently testable authority subsystem within that work: summary-only candidate creation for session logs, insights, mistakes and ADRs. It preserves the whole-F2 goal and explicitly leaves full-body governance, public lifecycle/routing, operational privacy/keys and actual-host qualification for their own subsequent deliveries.

Source baseline: `51076be9e7f4c68f8d45e27e80cf136aac835546`; its product runtime is the accepted `56232b5023e27abb35f364051e71c321b33fc0bb`. Work continues on `codex/v2-governed-summary-commands` in the existing managed worktree, retaining the completed private-read branch. Archived candidate3 was independently suitable for human written-spec review; current publication is a design artifact, not a design approval or executable plan.

## 1. Outcome, selected approach and material limits

The overall goal remains complete fresh-start V2 production memory replacement, with V1 isolated as a read-only archive. This increment proposes one private backend for session-log, insight, mistake and ADR summary creation. Each accepted command creates one provenance-linked redacted candidate/unverified record, preserves stable command identity and returns an authenticated durable result.

Delivered governance is absent -> candidate/unverified, and equivalent duplicate -> the same committed result. Kind is event/receipt metadata. Current private retrieval returns its actual summary/status/confidence, without fabricated kind/body/verificationStatus fields. No original full note body, Markdown artifact, factual verification, session end or public write is delivered.

The chosen composition owns a fresh disposable store for one parent-run controller. Only privately confirmed normal graceful close allows same-run reopen. OWNERSHIP_UNCERTAIN is absorbing: uncertain construction, lost worker response, timeout/possible commit, forced close or cleanup uncertainty permanently prevents reuse/reopen of that store in this run. A late receipt, exit or eventually closed connection cannot revive it. A new parent cannot attach previous-run stores through this composition. Preserve old fixtures and recovery IDs; never delete/reset them to claim recovery.

A healthy owner can recover a result after successful executor receipt was lost on downstream client delivery, or after normal close and same-run reopen. Recovery requires current same-session authority at its worker authorization point: own ACTIVE root, or own nonterminal direct-access child while its root is ACTIVE. Ended/revoked/transferred authority remains denied; no root-on-behalf-of-child, sibling, resume-token or operator substitution.

**Selected delivery boundary and cost:** successful recovery authorization linearizes at the final worker current-authority/proof verification and owned result detach inside the read transaction. Successful transport/client delivery can occur after expiresAt. A delivered result attests that authorization observation and durable lookup outcome; it does not assert current session/generation authority or an unexpired proof at parent facade return. The parent validates ordinary ownership/protocol/correlation but acquires no capability clock or fresh-authority check. No automatic proof renewal occurs. This applies equally to committed and not-found results.

| Alternative | Benefit | Why outside the selected increment |
| --- | --- | --- |
| Selected summary-only commands with normal-close recovery | Smallest coherent private authority subsystem | Accepts indefinite unresolved outcomes and no crash-parent/forced-close/post-end recovery |
| Full bodies and public lifecycle now | Closer visible replacement of existing workflows | Requires body/read/erasure/public lifecycle and unfinished operational dependencies |
| Durable cross-parent quarantine/reconciliation | Supports wider restart recovery | Requires a crash-safe authority covering every writer entrance and separately governed reconciliation |
| Stronger provider/process termination | Addresses hard shutdown/forced-reopen requirements | Requires new execution/native contracts and qualification; timer races cannot provide it |
| Fresh proof at parent return | Stronger caller-delivery freshness claim | Would require a qualified parent clock and explicit authority-observation design; not selected |

All NEW interfaces, literals, codecs and controller behavior below are proposed extensions. Existing helpers are named explicitly; their existence does not prove the extensions work.

## 2. Resource bounds and mandatory trusted timing

Reject overflow without clipping, dropping fields or increasing existing caps. Charge encoded witness, authorization, correlation and result overhead.

| Item | Bound / rule |
| --- | --- |
| Summary | Nonempty and <=2,048 UTF-8 bytes as raw original, NFC-trimmed intermediate and redacted output |
| Provenance | 1-64 direct references, exactly kind+UUID; duplicate selectors refuse; no recursive traversal |
| Semantic create or recovery input | <=8,192 canonical encoded bytes |
| Complete success/error response | <=16,384 encoded bytes, including worker correlation |
| Semantic/result decoder depth / aggregate containers | <=8 / <=128 |
| Fields per record / elements per array | <=32 / <=64 |
| Semantic/result scalar text | <=2,048 UTF-8 bytes |
| Protected authorization | <=16,384 encoded bytes, separately bounded |
| Complete worker request transport | Existing <=4 MiB; canonical command text is transport, not a semantic scalar |
| Atomic append command | Existing <=4 MiB; exactly two events, zero outbox jobs |
| Projection source event | Existing <=256 KiB |
| Trusted redaction processing | <=256 rules, <=2,048-byte literals, <=4,096 spans |

The projection's 16 KiB summary storage ceiling is not the creation limit. A scalar-valid summary can still fail total-envelope packing. Fixed structures remain shallow; full durable append budgeting is separate from semantic input/result structural caps. No SQL migration, old event rewrite, projection schema bump or cap increase is selected.

```ts
type TrustedGovernedNoteTimingV1 = Readonly<{
  requestTimeoutMs: number;        // R: integer 1..2,147,483,647; mandatory, no default.
  closeTimeoutMs: number;          // C: integer 1..2,147,483,647; mandatory, no default.
  recoveryProofLifetimeMs: number; // L: integer 1..120,000; mandatory, no default.
  maxPending: 128;
  executorLeaseMs: 15000;
  heartbeatIntervalMs: 5000;
  appendRetryDeadlineMs: number;   // Exactly R.
  sqliteBusyTimeoutMs: 5000;
}>;
```

Validate configuration before fixture allocation or owner opening; invalid config is GOVERNED_NOTE_CONFIG_INVALID, without IDs/details. R applies equally to create/recovery. The existing parent timer begins after bounded request construction and before posting, covering FIFO plus worker execution. It excludes finite pre-post decoding; controller recovery adds no waiting queue. Parent scheduling must remain responsive. A posted mutation without confirmed response is unknown, never rollback proof.

C is graceful-close escalation time. Forced shutdown still awaits termination without a second deadline, so final close settlement has no fixed bound. appendRetryDeadlineMs begins after FIFO wait and is checked after service-classified failed attempts; equality with R does not make a shared absolute deadline or interrupt an in-flight call. SQLite busy timeout is not a bound on all transaction/provider/commit work. Lease expiry/heartbeat failure do not prove closure or release. L independently limits proof validity at worker authorization; it is not a request/close/provider deadline.

Current executor validation accepts all positive safe integers and DEFAULT_SCHEDULER directly calls Node setTimeout. Official Node 24 docs retrieved through Context7 establish that delay>2147483647, delay<1 or NaN becomes 1 ms, fractions truncate, and exact callback time/order are not guaranteed. Hence the proposed R/C range is an API-supported representation bound, not an operational SLA/default. [Official Node.js 24 timers](https://nodejs.org/docs/latest-v24.x/api/timers.html#settimeoutcallback-delay-args). No new docs lookup or product patch is part of this consolidation.

Each future disposable qualification records exact R/C/L, all other timing/queue values, build, policy, capability/evidence provider and native dependency identities. Providers/policy/clock/nonce dependencies execute locally and synchronously in the owned worker. No network provider, parent/user callback or additional provider subprocess is composed. Factory selection enforces that restriction; the existing interfaces provide no native return/cancel/dispose/deadline guarantee. A stalled dependency can permanently remove the store from this composition's usable set. Error sanitation cannot stop a nonreturning call. Operational custody remains unqualified.

## 3. Exact types, authority transport and owner extension

Use existing `ProjectContext` from identity/contracts.ts; `SessionId`, `parseCanonicalUuid`, `parseUnsignedDecimal`, `parseCanonicalTimestamp` from lifecycle/contracts/identifiers.ts; `Confidence`, `AppendResult`, `StoredCommandResponse`, `JsonValue` from contracts/event.ts; `SemanticCommandAuthorization`, `BoundedOperationAuthorization`, `CapabilityProofV1` from lifecycle/contracts/commands.ts. `CommandId`, `IdempotencyKey`, `OperationId`, `RequestId` and `RecordId` are NEW semantic aliases of string, not claimed existing brands. Each is canonical lowercase UUIDv4: parseCanonicalUuid plus length=36 and character 14='4'. All newly allocated record/event/proof nonce IDs use the same rule. Referenced IDs use canonical UUIDv4 too, matching retained codecs. Timestamps are existing canonical millisecond UTC strings. Durable position/generation strings use parseUnsignedDecimal, <=9223372036854775807; committed positions/generations require >=1. No Number conversion for positions.

Exact NEW request and protected transport shapes:

```ts
type GovernedNoteCommandV1 = Readonly<{
  version: 1; operation: 'create-governed-note';
  commandId: string; idempotencyKey: string;
  recordKind: 'session-log' | 'insight' | 'mistake' | 'adr';
  summary: string; confidence: Confidence;
  provenance: readonly Readonly<{ kind: 'source-event' | 'retained-evidence'; identity: string }>[];
}>;
type GovernedNoteRecoveryV1 = Readonly<{
  version: 1; operation: 'recover-governed-note-result';
  operationId: string; requestId: string; commandId: string; idempotencyKey: string; expiresAt: string;
}>;
type GovernedNoteProtectedAuthorizationV1 =
  Extract<SemanticCommandAuthorization, { kind: 'protected' }>;
type PreparedGovernedNoteCreateV1 = Readonly<{
  command: GovernedNoteCommandV1; authorization: GovernedNoteProtectedAuthorizationV1;
}>;
type PreparedGovernedNoteRecoveryV1 = Readonly<{
  request: GovernedNoteRecoveryV1; authorization: BoundedOperationAuthorization;
}>;
type PreparedGovernedNoteCreateWireV1 = Readonly<{
  command: string; authorization: GovernedNoteProtectedAuthorizationV1;
}>;
type PreparedGovernedNoteRecoveryWireV1 = Readonly<{
  request: string; authorization: BoundedOperationAuthorization;
}>;
```

Only command's exact eight fields and recovery's exact seven fields are permitted. Target session is `authorization.targetSessionId`; it equals authoritySessionId and is bound by proof. It is never accepted from model fields. Create authorization has exactly kind, authoritySessionId, targetSessionId, proof, approval, childBindingGrant; kind='protected', proof nonnull/semantic-command, approval=null, childBindingGrant=null. Recovery authorization has exactly kind, authoritySessionId, targetSessionId, proof, audience; kind='bounded-operation', proof target='bounded-operation'. Both proofs have exact existing four fields, version=1, UUIDv4 nonce and 64-lowercase-hex fingerprint. Audience has exact presentingActorRole/presentingClientInstanceId/targetActorRole/targetClientInstanceId and equals trusted context/current stored audience. No token bytes cross this boundary.

Implement NEW `decodeGovernedNoteCommandV1(unknown)`, `decodeGovernedNoteRecoveryV1(unknown)`, `encode/decodePreparedGovernedNoteCreateV1` and corresponding Recovery functions. Decoder algorithm is selected, not deferred: traverse only own descriptors using the existing proxy-rejecting `retainedDataEntries`; enforce section 2 depth/container/field/array/scalar caps before copying; reject undefined/nonfinite numbers/symbols/accessors/proxies/exotic/sparse input; produce a frozen owned snapshot. Use `retainedStringMetrics` for well-formed Unicode and exact raw/quoted UTF-8 charging. Canonicalize that admitted shallow snapshot using `canonicalJson`/`boundedRetainedJson`; the canonical UTF-8 semantic input cap is 8,192 bytes. Do NOT apply `copyBoundedProtocolData` directly to an 8,192-byte canonical command STRING: its 2,048-byte scalar ceiling would reject transport. Physical canonical-string wrappers instead use `boundedRetainedJson` with 4 MiB total cap; parse JSON then re-decode and require byte-for-byte canonical-string equality. Protected authorization alone is <=16,384 encoded bytes. Runtime and parent both independently validate prepared transport and correlated responses.

Provenance is an unordered set semantically: reject duplicate (kind,identity), sort by binary kind then binary identity before canonical input/proof/MAC. Keep raw original summary exactly in the transient canonical input. Proposed display normalization is NFC then trim, then accepted plain-text redaction; require nonempty and <=2,048 UTF-8 bytes on raw input, normalized intermediate and redacted output. Newline content is allowed by current native result decoding. Different original whitespace/normalization forms remain different inputs even if display text matches. Extract `redactGovernedNoteSummaryV1(summary, policy): {summary:string,policyId:string,policyVersion:string}` around existing trustedPolicy/transformString(...,false,0,...) behavior; share policy/rule/span validation, never create fake frames. The span manifest is transient and not a new output/persistence field.

Add exactly these private WorkerRequest variants using existing `WorkerBindingAssertion` generated by `encodeWorkerBindingAssertion(context)`:

```ts
| { id: string; type: 'governed-note-create'; binding: WorkerBindingAssertion; prepared: PreparedGovernedNoteCreateWireV1 }
| { id: string; type: 'governed-note-recover'; binding: WorkerBindingAssertion; prepared: PreparedGovernedNoteRecoveryWireV1 }
```

Extend ProjectStoreExecutor -> ProjectStoreWorkerRuntime -> ProjectStoreWorkerBackend with these typed operations on the existing owning connection and FIFO. Do not open a parent writer or use generic executor.append as the service API. NEW executor methods are `createGovernedNote(prepared: PreparedGovernedNoteCreateV1): Promise<AppendResult<GovernedNoteStoredReceiptV1>>` and `recoverGovernedNoteResult(prepared: PreparedGovernedNoteRecoveryV1): Promise<GovernedNoteRecoveryResultV1>`. First uses the existing mutation request classification/semanticIdentity(projectId,commandId,idempotencyKey); second uses bounded nonmutation request classification, no semantic mutation identity. Parent maps create timeout to original-ID unknown, recovery timeout to WORKER_UNAVAILABLE. Response envelope remains exact `{id,ok:true,data}` or `{id,ok:false,error:{code,message,details}}`, <=16,384 encoded bytes including correlation. Assert IDs and expected operation on response.

NEW `GovernedNoteRuntimeFactoryPort.create(input: RetainedEvidenceRuntimeCreateInput): GovernedNoteRuntime` reuses that exact input's connection, maintenanceFence, keyProvider. `GovernedNoteRuntime` has synchronous `create(prepared,context): AppendResult<GovernedNoteStoredReceiptV1>` and `recover(prepared,context): GovernedNoteRecoveryResultV1`. Factory options use existing EvidenceKeyProvider, `() => TrustedRedactionPolicyV1`, `{now():string;nowMs():bigint}`, CapabilityNonceSource, and optional typed fault injector. No parent callback is used during worker execution; provider/factory instances are trusted worker composition dependencies. FreshStartTrustedContext stays in existing owner open/binding flow, not caller note content.

### Private compiled composition ownership

The implementation plan must assign a NEW compiled private worker fixture/composition, selected through the existing ProjectStoreExecutor.workerFactory seam. It constructs capability/evidence providers, policy, capability clock and nonce source locally in that worker, then injects lifecycle, retained-evidence and governed-note factories into ProjectStoreWorkerBackend using its ONE owning connection, maintenanceFence and keyProvider. Bootstrap and later fixture authority changes enter only through the controller's exclusive same-owner admission; no surviving fixture.writer or second connection may mutate an admitted store. The raw executor/connection is never exposed through a governed permit.

The stock src/workers/project-store.worker.ts currently injects build/timing dependencies only; it is not an already delivered governed-key/lifecycle composition. The compiled retained-evidence worker and entry tests are seam precedents, but their MessageChannel parent-provider bridge does not satisfy this increment's worker-local dependency restriction and must not be reused as its qualification. Existing runtime/owner close and binding behavior remains the basis; the future plan names the new composition and integration owners explicitly.

Trusted SYNTHETIC startup provisioning is bound to this run and fresh fixture and survives only its permitted normal-close/same-run reopen. Preserve capability verifier/handle-key identity and historical NOTE original-input commitment keys needed for create replay. Generating an unrelated provider on each reopen would not satisfy those contracts. Provisioning is private harness configuration, absent from model/tool content, receipts and logs; it is not operational secret custody. Receipt-only recovery still authenticates pair/result plus current authority without source decryption or recomputing original-input MAC, as sections 4 and 7 require.

## 4. Closed provenance eligibility policy

Only the following retained authoritative source families are eligible. Projections and generic lifecycle events do not supply provenance authority.

| Input reference | Admit only if | Refuse |
| --- | --- | --- |
| source-event UUID | Exactly an `EvidenceBatchRetained` schema-1 event, matched to committed retain-evidence-batch dedup/authorization/blob/stream truth; exact current note authority snapshot and branch binding match | Every other event family/schema, including generic MemorySourceRecorded, new GovernedNoteCreated, checkpoints and lifecycle events |
| retained-evidence UUID | Exactly one retained_evidence_blobs item whose parent event meets the same rule; binding.evidenceId matches selector; full metadata/ciphertext/wrap correspondence authenticates | Missing/foreign/mismatched item, malformed ciphertext envelope, orphaned event/dedup/authorization |
| Either | Same project/vault/store/workspace/client namespace, exact target session and current recorded audience/generations; source was authorized by that same session, not root-on-behalf-of-child | Different session/branch/authority generation or revoked/terminal/transferred/currently unavailable authority |

NEW `GovernedNoteProvenanceRepository.validate(connection, references, currentAuthority, projectionBinding, provider)` executes bounded direct lookups. For source-event, select the event by project+eventId, then obtain parent command IDs; for retained-evidence, select exact item by project+evidenceId to obtain event/command IDs. Hydrate StoredEvent using the existing stored-row field mapping; authenticate against its actual preceding event hash using authenticateStoredEvent. Run `RetainedEvidenceRepository.findPrior(commandId,idempotencyKey)` AND `assertStoredRetainedEvidenceCorrespondence(connection,event)`: the latter additionally requires state='committed', no lifecycle authorization/outbox, blob transport hashes and stream-head continuity. Verify canonical authority equality using decodeRetainedEvidenceAuthority and strict new note restrictions. Verify event workspace and nullable branchScopeId/branchRef against the note's chosen projection binding.

For direct item, verifyRetainedEvidenceTransport and exact item membership. For source-event, validate each item in the existing bounded batch. At new creation require provider.status='available' for recorded wrap, redacted fingerprint and original commitment refs using existing purposes; no unwrap/plaintext read and no full-body authorization. Missing/deleted backing data refuses; revoked/unavailable keys refuse. There is no general evidence erasure/revocation database state invented here. This slice's current eligibility is precisely intact authenticated retained storage + active exact authority + available recorded purpose keys. Later erase/governance mechanisms remain a separate integration obligation, not silently supported.

Validate before preparation and again inside BEGIN IMMEDIATE. Produce one evidence descriptor per submitted reference (at most 64), sorted in canonical reference order, with EXACT fields: `{kind,identity,sourceEventId,sourceEventPosition,sourceEventHash,sourceCommandId,sourceIdempotencyKey}`. All IDs are canonical UUIDv4, position positive decimal, hash 64 lowercase hex. Multiple references can point at one source event; each distinct submitted selector stays represented. No recursive note provenance traversal. Repeated parent-batch checks may be memoized within that transaction only; no stale cross-transaction cache.

After commit, receipt recovery/replay authenticates stored descriptors and pair truth rather than requiring source keys currently available again. Create replay still needs its historical NOTE original-input key and exact current recorded authority. This preserves committed attribution without returning content; later erasure is not retroactively described as no commit. Physical corruption of note pair/dedup remains integrity failure.

## 5. Exact durable pair, witness, receipt and equality

NEW `GovernedNoteAuthoritySnapshotV1` is `RetainedEvidenceAuthoritySnapshotV1` narrowed by decoder to capabilityKind root-session-handle|child-session-handle, authorizationSessionId=targetSessionId, presenting/target roles and clients equal. It has the existing exact 19 fields (not capability/proof material): projectId,vaultId,storeId,workspaceId,clientNamespace,presentingActorRole,presentingClientInstanceId,targetActorRole,targetClientInstanceId,authorizationSessionId,targetSessionId,parentSessionId,rootSessionId,rootOwnerGeneration,authorizingOwnerGeneration,authorizingCapabilityGeneration,targetOwnerGeneration,targetCapabilityGeneration,capabilityKind. The enumerated exact list is authoritative. Use existing decoder's field validators and additional restrictions, not a fabricated capability handle.

Use existing projection `ProjectBinding` fields exactly: `{projectId,vaultId,storeId,workspaceId,branchScopeId,branchRef,sessionId}`. sessionId equals authorized target. Derive branch from owning `BranchScopeRepository.inspect` under the trusted current workspace, using the retained read-only planning precedent; nullable branchRef is current workspace branchRef for Git, otherwise null. If context.branchScopeId is supplied, require it to equal the inspected scope; otherwise use the inspected scope or null when none exists. Absence of the optional context field does not force a false mismatch. The workspace is already trusted and fixed; never create or rebind a branch during note planning.

```ts
type GovernedNoteWitnessV1 = Readonly<{
  witnessVersion: 1; commandType: 'create-governed-note';
  commandId: string; idempotencyKey: string; recordId: string;
  recordKind: GovernedNoteCommandV1['recordKind']; confidence: Confidence;
  authority: GovernedNoteAuthoritySnapshotV1;
  binding: ProjectBinding; // projections/contracts.ts, not identity ProjectBinding.
  provenance: readonly GovernedNoteProvenanceDescriptorV1[];
  policyId: string; policyVersion: string;
  originalCommitmentKeyRef: EvidenceKeyRefV1; originalInputCommitment: string;
  summaryContentHash: string;
  noteEventId: string; sourceEventId: string; recordedAt: string;
}>;
type GovernedNoteCreatedPayloadV1 = Readonly<{ formatVersion: 1; witness: GovernedNoteWitnessV1 }>;
type GovernedNoteStoredReceiptV1 = {
  resultVersion: 1; operation: 'create-governed-note'; commandId: string; idempotencyKey: string;
  recordId: string; recordKind: GovernedNoteCommandV1['recordKind'];
  status: 'candidate'; verificationStatus: 'unverified';
  scope: ProjectBinding; sourceEventIds: [string,string]; terminalPosition: string;
};
type GovernedNoteStoredResultV1 = StoredCommandResponse<GovernedNoteStoredReceiptV1>;
type GovernedNoteReceiptV1 = GovernedNoteStoredReceiptV1 & { readonly replay: boolean };
type GovernedNoteRecoveryResultV1 =
  | Readonly<{ resultVersion: 1; operation: 'recover-governed-note-result'; outcome: 'committed'; receipt: GovernedNoteReceiptV1 }>
  | Readonly<{ resultVersion: 1; operation: 'recover-governed-note-result'; outcome: 'not-found'; commandId: string; idempotencyKey: string }>;
```

All object keys exact; all decoded data frozen/owned. receipt.replay is added only after durable authentication: create derives it from AppendResult.deduplicated; committed recovery sets true. No replay field in stored receipt. API facade returns GovernedNoteReceiptV1; worker create returns stored result plus existing deduplicated/responseHash fields with decimal wire positions, then executor adapts to existing bigint AppendResult. Recover wire is exact GovernedNoteRecoveryResultV1. No capability-generation details are exposed via receipt scope.

Allocate fresh recordId, noteEventId, sourceEventId with the owning injected UUID source once per preparation; bind them to a NEW WeakMap-backed `GovernedNoteEventPlan` owned by the EventAppendTransaction instance. Set streamType='governed-note', streamId=`governed-note/${targetSessionId}/${recordId}`, expectedStreamVersion=0n, commandType='create-governed-note', correlationId=commandId, agentId='governed-note'. An exact prior wins over newly prepared IDs. Pair stream versions are 1 and 2; finalStreamVersion='2'. Event zero `GovernedNoteCreated` schema=1 payload is above; event one `MemorySourceRecorded` schema=3 payload is exactly:

`{sourceVersion:2,binding:w.binding,item:{itemId:w.recordId,normalizedKey:'governed-note/'+w.recordKind+'/'+w.recordId,status:'candidate',confidence:w.confidence,verificationMethod:'governed-note-unverified-v1',validFrom:w.recordedAt,validTo:null,summary:redactedSummary,contentHash:w.summaryContentHash,conflictGroupId:null,supersedingItemId:null,anchor:null},followUps:[],artifacts:[],entities:[],aliases:[],edges:[]}`.

Both headers: same trusted scope/session/parent/audience, occurredAt=recordedAt=w.recordedAt, visibilityScope='session', confidence=w.confidence, verificationStatus='unverified', causationId absent/null. sourceRefs equals sorted UNIQUE parent sourceEventId values from descriptors. evidenceRefs=[] and evidenceDigests=[] for both: the pair references attribution, creates no new evidence blob or retained ownership claim. Direct retained item IDs remain in typed witness descriptors. lifecycleIntentWitness absent and lifecycleIntentJson=null; note witness is in payload, never misencoded as a lifecycle witness.

Require source event global position = note event position+1; commandEventIndex=0/1, event IDs as planned, same command identities and stream. Store dedup state='committed', command_type='create-governed-note', no lifecycle authorization, outbox_order_json='[]', exact event_ids_json canonical pair, first/last positions, final stream version, response_json canonical StoredCommandResponse. terminalPosition equals event one's global position; stored receipt sourceEventIds equals exact pair. `response_hash=responseHash(storedResult)` using existing helper. `command_hash=SHA256(UTF8('project-memory/governed-note-command/v1\n'+canonicalJson(witness)))`. `summaryContentHash=SHA256(UTF8('project-memory/governed-note-summary/v1\n'+canonicalJson(redactedSummary)))`. Fingerprints do not expose raw summary.

NEW guarded append seams mirror retained ownership, without using generic hash override: `planGovernedNoteIdentity(verifiedHandle,command)`, `prepareGovernedNote(plan,append,payload)`, `discardGovernedNote(prepared)`. Guard prepare, planPrepared, appendPlanned and insertDedup against reserved type/stream/event and binding mismatches; generic append/replay cannot forge the family or acquire its dedup result. Validate complete pair and stored result before any insertion. Reuse existing events/streams/command_dedup columns; no side authorization table is needed because the authenticated witness contains the snapshot. This is proposed extension work, not current generic append permission.

NEW `findGovernedNotePrior` queries dedup AND events by project plus `(command_id=C OR idempotency_key=I)`. Zero of both -> absent; orphan rows -> integrity; multiple or identity/type mismatch -> conflict. For one exact committed dedup, require EXACTLY two corresponding events, authenticate both hashes/chain positions, decode both payloads and assert every pair/receipt/dedup equality above. Stored payloadJson and response_json must be canonical; use payloadJson as truth, never mutable payload cache. Rebuild, quick/full integrity and private result recovery all call the same pair validator; `GovernedNoteCreated` gets an explicit validated non-projection disposition, and a matching reserved MemorySourceRecorded cannot bypass the validator. Only after this correspondence proof may recovery return receipt or creation compare historical MAC. At final worker authorization/detach for recovery, or inside the transaction for creation replay, require canonical current derived projection binding to equal witness.binding as well as current authority equality; a branch/session/workspace scope mismatch returns SESSION_OWNERSHIP_MISMATCH. The authority snapshot alone does not contain branch identity. No original-summary hash appears in events or dedup.

## 6. Creation transaction, retry and privacy contract

The trusted future transport retains commandId/idempotencyKey before transmission; this service never substitutes identities after uncertainty. Durable identity allocation across parent crash remains future public-lifecycle work, not a guarantee of this disposable composition.

Decode owned input; verify current same-session protected authority and fresh-start semantic-mutation admission; look up prior command truth before new policy/current-key preparation. Exact replay authenticates pair/dedup/receipt, checks current recorded authority and binding, and compares historical original-input MAC. Incompatible input/identity conflicts. Missing historical note key refuses under original IDs; no silent re-redaction. The raw original summary remains part of transient equality even when display normalization/redaction yields identical text.

For a new command, validate eligible provenance and prepare redacted summary, witness, planned IDs and receipt. Enter BEGIN IMMEDIATE on the existing worker connection. Recheck fresh-start admission/current control, maintenance fence, current session/audience/generations, command uniqueness and provenance eligibility. Recheck a concurrent prior winner under the transaction before effects. Equivalent prior returns its authenticated result; conflicting prior refuses. Append exactly the pair and dedup result in that transaction. Validate the complete planned pair/result before insertion; acknowledge only after successful COMMIT. The service owns its transaction; no generic append shortcut or second writer connection.

| State/event | Required result |
| --- | --- |
| Invalid or refused before effects are possible | Fixed safe error; no commit claim |
| Posted create without a confirmed outcome | COMMAND_OUTCOME_UNKNOWN with original IDs; ownership uncertainty is absorbing |
| Service-classified busy proving pre-BEGIN absence or successful rollback | Existing bounded busy retry route only |
| Raw busy, rollback failure, commit-attempt uncertainty | No automatic retry; unknown whenever commit cannot be excluded |
| Commit and worker/executor receipt succeed | Winning receipt; same controller remains healthy if no separate failure |
| Downstream client loses that successful executor receipt | Healthy-owner recovery or normal-close/same-run reopen recovery is allowed |
| Worker response lost until R fires, unknown commit, forced cleanup | Original IDs preserved; store permanently unavailable in this run, even if it committed late |
| Equivalent duplicate under current authority | Same record/event pair/result; detached replay indicator only |
| Changed original content/kind/confidence/provenance/scope under same identity | Conflict or prescribed authority/scope refusal |
| Orphaned/mismatched event pair or dedup | Integrity/conflict failure, never not-found |

Late original commit is a possible durable outcome after a caller timeout. It is not proved rollback or cancellation. The absorbing owner rule may prevent this increment from resolving it. Never automatically retry an unknown command, mint replacement IDs, reset a fixture, promote a candidate or duplicate creation because a projection lags.

Raw original inputs must not enter durable events/dedup hashes/errors/logs/metrics/receipts. Durable content is only the approved redacted summary and authenticated metadata/keyed commitment. Clear owned buffers where possible; managed-runtime strings cannot be promised completely erased. Extract accepted plain-text redaction behavior without fabricating frames, ordinals or host coverage. Existing retained privacy is reused but does not qualify operational custody, full-body retention, erasure/restore completeness or factual truth.

## 7. Proof, current authority and worker authorization linearization

**Independent command-recovery admission.** Before any durable command-result lookup, every recovery attempt must pass the existing `FreshStartAdmissionGuard` with operation=`command-recovery`, exact release/build/schema and the recovery-tail fence. Use the existing owning-connection admission route and retain the guard's required current-state freshness/revalidation at its existing operation boundaries. Owner construction/open binding, a healthy controller or an earlier successful admission does not substitute for this operation-specific gate; do not invent a replacement admission mechanism or cache away its required checks.

Admission in `active` or `read-only-recovery` mode permits only the narrow result lookup when all existing command-recovery conditions pass. It is independent of current same-session bounded proof and authority, which must still pass at the selected final worker verification/detach point. Admission grants no summary/body access, stale-session recovery or post-end permission. Failed admission or failed authority withholds BOTH receipt and not-found using the corresponding existing safe error; recovery performs no mutation. The worker authorization/detach and later delivery-expiry contract below is unchanged.

Reuse the current authority repository/fold/current-handle inspection pattern, with the stricter equality restriction checked BEFORE proof verification. Derive fresh `GovernedNoteAuthoritySnapshotV1` on each check; do not use retained verified handles or a caller-supplied snapshot as permission. NEW WeakMap note create/recovery handles bind connection, verifier instance, exact canonical input/selector, operation and snapshot. Transaction revalidation must recompute current scope/proof and compare canonical snapshot to the saved one. Root must be semanticState='active'; both root/target must lack terminal/revocation fields; child retains the existing nonterminal/directAccess checks and root-generation matching. Recovery after end/revocation/transfer remains denied.

Use existing EvidenceKeyPurpose='original-input-commitment' with NEW MAC domain **`governed-note-original-input/v1`**. No new purpose enum, wrapping key or deployed secret is required by this proposal. The original commitment input is `canonicalJson({authority: admittedSnapshot,binding:projectionBinding,command:canonicalCommandSnapshot})`. Feed that bounded canonical text through existing evidenceMacInput({projectId,storeId},ref,text), then existing evidenceMac(...,'original-input-commitment',ref,'governed-note-original-input/v1',bytes). Persist 64-lowercase-hex MAC and decoded EvidenceKeyRefV1; compare using timing-safe bytes on replay with the historical key. Key reference validators are existing decodeEvidenceKeyRef; policy IDs/versions use retainedIdentifier. No new policy generation is substituted on replay. Only historical note-key lookup/MAC is necessary for equivalence, not fresh policy or provider currentKey. Clear transient canonical original/MAC input bytes in finally.

Create proof is existing SemanticCommandProofTargetV1, target='semantic-command', proofVersion=1. All scope/audience/capabilityKind/generation/session fields come from the current trusted inspection. commandId/idempotencyKey come from admitted command; proofNonce comes from protected authorization. Set intentHash to existing `commandHash({proofPurpose:'create-governed-note/v1',scope,binding:projectionBinding,originalCommand:canonicalCommandText})`. Here scope is EXACTLY SemanticCommandProofTargetV1 excluding proofVersion,target,commandId,idempotencyKey,intentHash,proofNonce. This transient hash binds raw input but is never durable witness/dedup/log/receipt data.

Recovery proof is existing BoundedOperationProofTargetV1, target='bounded-operation', proofVersion=1, operationType='recover-governed-note-result'. Build selectors with exact fields:

`{projectId,vaultId,storeId,workspaceId,clientNamespace,branchScopeId,branchRef,authoritySessionId,targetSessionId,commandId,idempotencyKey,operationId,requestId,presentingActorRole,presentingClientInstanceId,targetActorRole,targetClientInstanceId,expiresAt}`.

Set operationHash=`commandHash({proofPurpose:'recover-governed-note-result/v1',...selectors})`; all other target fields are the existing bounded target fields from current stored handle and exact request/proof. The separate authorization audience must equal recomputed four audience fields. Compute expiresAt with the existing capability clock as canonical milliseconds now+L, positive safe-integer L<=120000; call existing verifyProof with the stored handle material. Never substitute a real capability token into the wire.

**Recovery success authorization linearization point.** Require the independent existing command-recovery admission above before lookup. Check bounded proof expiry and current authority before lookup; begin the read transaction, retain the existing admission guard freshness/revalidation requirements, and verify proof/current authority again before reading durable command truth. After lookup/pair authentication, rederive current authority and projection binding and verify the same bounded proof inside that transaction. For committed results require equality to the witness authority/binding; for absent results require equality to the initially verified snapshot and current binding. Immediately before creating the final owned frozen detached success object, check expiresAt using the existing worker capability clock. This final successful worker verification and detach inside the read transaction is the authorization linearization point for BOTH committed and not-found. No success is detached if expiry has crossed by then. Authority means the current-state observation made by that verification under the serialized ownership contract; it is not a promise of perpetual authority.

Keep detached result private until read COMMIT succeeds. A read-transaction cleanup/commit failure withholds success and uses the safe nonmutation failure path; it cannot create another uncertain note mutation. After successful detach, COMMIT, worker transport and parent response validation may finish after expiresAt. The parent does not check expiry again, consult a capability clock or revalidate session/generation authority. Parent success requires ordinary controller ownership, request/correlation/protocol and timeout health only. Holding recovery admission through disposition proves absence serialization; it does not extend proof lifetime.

Thus an authenticated committed OR not-found result delayed across expiresAt AFTER final worker verification/detach is still delivered successfully if those ordinary conditions remain healthy. The caller receives an authorized lookup result as of that worker point, not proof that its session/generation or capability is current at facade return. This is a material selected tradeoff. A later new recovery request must present authority current for that request.

Expiry before lookup, during transaction work before final detach, or immediately before worker detach refuses as a nonmutating authorization error. Expiry after successful detach does not retroactively invalidate that authorization point, even if read COMMIT is still pending. Preserve the caller's original command IDs; do not renew proof, write, report not-found from the failed attempt or turn expiry into mutation uncertainty. An explicitly requested fresh recovery uses a new operationId/requestId/proofNonce and authority valid then, preserving commandId/idempotencyKey. No expired/revoked/transferred historical authority is revived. No trusted parent-clock dependency is introduced.

The five NEW domain literals are therefore fixed: `create-governed-note/v1` (transient create proof purpose), `recover-governed-note-result/v1` (bounded proof purpose), `governed-note-original-input/v1` (provider MAC), and `project-memory/governed-note-command/v1` / `project-memory/governed-note-summary/v1` (durable command and redacted-summary SHA-256 domains). No unlisted note domain is needed. Provider MAC prepends its own domain newline by existing contract; SHA-256 contracts explicitly include one newline, not a literal backslash-n.

## 8. Ownership controller, normal release and final-absence serialization

OWNERSHIP_UNCERTAIN is an absorbing state for the STORE SLOT in this controller run. A late forced exit, successful termination after timeout, eventual SQLite closure or authenticated receipt does not reopen this store. Preserve fixture/IDs. This sacrifices availability to avoid inventing forced/native release evidence. It delivers recovery on a healthy owner or after orderly confirmed close only.

Exact NEW private close observation:

```ts
type GovernedNoteCloseObservationV1 = Readonly<{
  disposition: 'graceful-confirmed' | 'ownership-uncertain';
  ownerId: string;
}>;
```

Add a private executor/controller seam `closeForGovernedNoteController(): Promise<GovernedNoteCloseObservationV1>` which shares the same single cached underlying close operation with close(). It records internally whether the actual graceful branch drained all requests, received the exact correlated `{closed:true}` response and then completed terminateWorker, with no poison/quiesce/forced escalation at any point. Only that complete sequence yields graceful-confirmed. NEW controller ownerId is a UUIDv4 bound in module-private state to that exact executor. No caller-supplied observation/boolean is accepted. Do not infer normal close from existing close() resolution or canReuse=false: current forced branch also resolves close and marks closed. No new timer races or termination wait deadline; this method may remain pending. Controller sets DRAINING/UNCERTAIN before awaiting it. It must return/throw safe unavailable on rejected cleanup without marking released; no side error detail needs to escape.

Existing runtime closes FIFO, awaits backend.close(), then posts closed:true. Existing backend closeHandles awaits child termination, attempts lifecycle disposal and connection.close, and throws on any failure. The selected local providers have no outside writer handle by composition. After this exact normal close acknowledgment and completed worker termination, old worker cannot execute further commands and its successfully closed connection is the release basis. No claims about a provider stalled under forced termination are needed. If the graceful branch skips because poisoned/quiesced, it cannot issue the new confirmation. A constructor/open failure whose resources might exist also permanently poisons its slot.

Concrete admission API is a NEW private run controller, never exposed in tool wire:

```ts
interface FreshGovernedNoteFixtureV1 { readonly __freshFixture: unique symbol }
interface GovernedNoteOwnerPermitV1 { readonly __noteOwnerPermit: unique symbol }
interface GovernedNoteRunV1 {
  open(fixture: FreshGovernedNoteFixtureV1): Promise<GovernedNoteOwnerPermitV1>;
  create(permit: GovernedNoteOwnerPermitV1, input: PreparedGovernedNoteCreateV1): Promise<GovernedNoteReceiptV1>;
  recover(permit: GovernedNoteOwnerPermitV1, input: PreparedGovernedNoteRecoveryV1): Promise<GovernedNoteRecoveryResultV1>;
  close(permit: GovernedNoteOwnerPermitV1): Promise<void>;
  reopen(permit: GovernedNoteOwnerPermitV1): Promise<GovernedNoteOwnerPermitV1>;
}
```

Brand syntax is illustrative of unforgeable interfaces: actual acceptance uses WeakMap membership, not properties. A NEW trusted disposable fixture allocator mints FreshGovernedNoteFixtureV1 only by exclusively creating a fresh random-UUID child directory of the selected disposable test root, completing existing fresh-start initialization there and capturing its ProjectContext/FreshStartTrustedContext. Its private map binds those contexts to this run and exact newly created filesystem identity. Input is `{parentDirectory:string}` from trusted harness configuration; no existing-store path is accepted. Collision refuses, never attaches. Paths/routes must resolve within that fresh directory and match the initialized file identity; otherwise refuse. This does not grant production initialization authority: it is an isolated harness construction contract to be exercised only under a later approved plan. Parent restart loses these private permits and has no API to remint one for the prior directory. All old fixtures remain untouched.

Open reserves slot BEFORE calling existing owner construction/open. Permit carries only opaque identity; controller retains context, executor and monotonically increasing owner generation privately. Concurrent opens, forged/cross-run permits and reopen from anything except normally RELEASE_CONFIRMED refuse `GOVERNED_NOTE_OWNERSHIP_UNCERTAIN` when uncertainty exists, otherwise `GOVERNED_NOTE_INPUT_INVALID`. Old permit becomes invalid after a successful reopen; no executor/raw connection escapes the controller. Bootstrap retained/session fixtures are completed on the same controlled owning connection before governed dispatch; no alternate writer is composed. If the harness needs later fixture lifecycle changes, route them through the same owner/controller exclusive admission; never use a second connection to mutate fixtures under active admission.

**No added queue/deadline:** track only the existing owner's admitted create count (increment synchronously before dispatch, decrement only after definitive settled operation). Unknown/transport failure makes the slot permanently uncertain. Recovery atomically closes new CREATE admission; if any create is in flight, return `GOVERNED_NOTE_OWNER_BUSY` immediately and reopen admission only if still healthy. Do not asynchronously wait before posting and then restart R. If no creates are in flight, post recovery under existing R while holding all new note create/recovery admission; competing calls receive OWNER_BUSY. Existing FIFO and one owning connection then ensure no previously accepted create can append later. Hold the gate until validated response/rejection is disposed to its caller; release only while still healthy. No persistent per-command ledger or new queue is introduced.

On healthy recovery, BEGIN DEFERRED and the existing FreshStartAdmissionGuard command-recovery gate (exact release/build/schema and recovery-tail fence, with its required freshness/revalidation) precede exact lookup/pair authentication; final worker proof/current-authority verification and owned result detach occur inside that read transaction, followed by COMMIT before release to transport. Healthy ownership or owner-open binding is not recovery admission, and recovery admission is not same-session authority. Section 7 defines that authorization point; later delivery may cross expiry without a parent freshness assertion. Both events and dedup selectors absent is final absence relative to all earlier admitted attempts; orphan data is integrity failure. Any active unknown/poisoned owner prevents lookup altogether. A later explicit create after gate release is a new attempt using original IDs, not a replacement identity or automatic action. DRAINING blocks dispatch. Normally confirmed close permits only same-run reopen; fresh parent refuses prior store. No cross-parent durable quarantine is claimed.

**Recovery availability:** lost CLIENT delivery after executor received a successful commit response can recover on the healthy owner or after normal close. A lost WORKER response causing R timeout, commit uncertainty, forced close or cleanup failure does not qualify for reopen in this increment, even if its late original commit occurs. That case remains unknown/unavailable with IDs and fixture preserved. This is the selected honest limitation, not a failed proof disguised as recovery.

The complete controller state table is normative:

| State | Admission / allowed transition |
| --- | --- |
| RESERVED / opening | Reserve before constructing; no second owner or dispatch. Successful open -> OPEN. Uncertain construction -> OWNERSHIP_UNCERTAIN. |
| OPEN | Create under admission/authority. Recovery with an active create -> immediate OWNER_BUSY without waiting; otherwise -> RECOVERY_EXCLUSIVE. Explicit close -> DRAINING. Any ownership uncertainty -> OWNERSHIP_UNCERTAIN. |
| RECOVERY_EXCLUSIVE | Refuse competing create/recover with OWNER_BUSY. Hold gate through validated result/error disposition. Definitive nonmutation result/refusal while healthy -> OPEN. Timeout/protocol/ownership uncertainty -> OWNERSHIP_UNCERTAIN. |
| DRAINING | No dispatch or replacement construction. ONLY privately observed complete normal graceful close -> RELEASE_CONFIRMED. Poison, escalation, quiesce or cleanup uncertainty -> OWNERSHIP_UNCERTAIN. |
| RELEASE_CONFIRMED | Only same controller/run may consume the old permit to reopen, reserving a new owner generation. Success -> OPEN with new permit. Uncertain reopen -> OWNERSHIP_UNCERTAIN. |
| OWNERSHIP_UNCERTAIN | Permanent refusal for this store slot. No outgoing release/reopen transition, including after late receipt/exit. Preserve fixture and IDs. |

A recovery result has meaning relative to previously admitted attempts, never an assertion that no future explicit attempt can commit. No proof expiry after worker detach changes this serialization rule; no gate substitutes for fresh capability verification on a later request.

## 9. Existing candidate read lane and unchanged ranking

Bind acceptance to existing `createVerifiedReadAdapter(binding).query(request)` from verified-read/supervisor.ts. Use `VerifiedReadBinding` from verified-read/contracts.ts with exact fresh-start release/control, captured eventsFile identity, projection/executor/deployment directory identities, current compositionEpoch and `session:{sessionId:receipt.scope.sessionId,minimumEventPosition:receipt.terminalPosition}`. Projection binding uses its existing project-wide image sessionId=null, not the note session value; selection session lives in TrustedReadSession. The trusted fixture supplies this existing binding, not a caller path/session override.

Exact read-after-write request is existing `GetCanonicalRecordRequest`:

`{operation:'get-canonical-record',consistency:'session-strong',minimumEventPosition:receipt.terminalPosition,budgetMs:resolveVerifiedReadBudget('session-strong'),parameters:{id:receipt.recordId,visibility:'session'}}`.

`resolveVerifiedReadBudget` is the existing read-lane function, whose current session-strong default is 2,000 ms; this is NOT R, C or L and establishes no production success SLA. Qualification may supply another accepted explicit read budget 0..30,000 and records it. The exact-ID lane does not depend on ranked top-k inclusion. Accepted response has VerifiedReadReceipt plus NativeGetResult, content.item nonnull with id=recordId, kind='canonical', status='candidate', textKind='canonical-summary', text=actual redacted summary, confidence unchanged, verificationMethod='governed-note-unverified-v1', sourceEventPosition=terminalPosition, matching session/branch/workspace. Existing output has no verificationStatus field or recordKind field: do not fabricate them. Pair/header validation proves unverified creation separately.

Evidence resolves candidate eligibility: database-core canonical SQL excludes only retracted/expired/erased-evidence, then `getCanonicalFromProjectionDatabase` checks exact binary ID and `isEligible`. eligibility.ts permits candidate subject to workspace/branch/session/temporal/freshness checks. content-query binds TrustedReadSession independently from consistency scope. The private `SqliteVerifiedReadAdmission` captures/revalidates exact active release/image position; it is distinct from FreshStartAdmissionGuard's public content-read refusal. Preserve both; never invoke public content-read to make private acceptance pass or change its refusal.

Ranking regression uses existing search-projected-content or build-context-pack through the same adapter, with a short unique fixture summary token. Existing collectNativeRankedQuery uses candidateLimit=64, tokenBudget=2048, includeGlobal=false, vector disabled, no explain, current filter/fuse/rerank/select pipeline. Preserve NATIVE_CONTENT_RANKING_VERSION='retrieval-ranking-v2-shadow-fixed-units'. Current candidate status feature is 2,500; selected marker is neither committed-event nor projection-chunk, so its current provenance feature is the fallback 3,500. These are existing numeric features, not verification claims or new ranking choices. Do not boost marker/kind or promote candidate. Exact retrieval is guaranteed only for an eligible caught-up fixture under bounded read success; ranked inclusion remains subject to existing budgets/diversity and is asserted only in a controlled fixture that fits them.

## 10. Closed errors and exact details

NEW `GOVERNED_NOTE_ERROR_CODES` is the closed union of these literals (no spreads accepting future unrelated codes):

```
GOVERNED_NOTE_CONFIG_INVALID
GOVERNED_NOTE_INPUT_INVALID
GOVERNED_NOTE_LIMIT_EXCEEDED
GOVERNED_NOTE_FORMAT_UNSUPPORTED
GOVERNED_NOTE_POLICY_UNAVAILABLE
GOVERNED_NOTE_KEY_UNAVAILABLE
GOVERNED_NOTE_PROVENANCE_INELIGIBLE
GOVERNED_NOTE_UNAVAILABLE
GOVERNED_NOTE_OWNER_BUSY
GOVERNED_NOTE_OWNERSHIP_UNCERTAIN
PROJECT_BINDING_REQUIRED
PROJECT_ID_MISMATCH
VAULT_ID_MISMATCH
STORE_ID_MISMATCH
SESSION_NOT_FOUND
SESSION_HANDLE_STALE
SESSION_OWNERSHIP_MISMATCH
SESSION_CAPABILITY_INVALID
SESSION_CAPABILITY_KEY_UNAVAILABLE
SESSION_CAPABILITY_EXPIRED
IDEMPOTENCY_CONFLICT
COMMAND_OUTCOME_UNKNOWN
INTEGRITY_FAILURE
SQLITE_BUSY
MAINTENANCE_QUIESCING
STORE_QUEUE_FULL
WORKER_PROTOCOL_ERROR
WORKER_CLOSED
WORKER_UNAVAILABLE
FRESH_START_INPUT_INVALID
FRESH_START_IDENTITY_MISMATCH
FRESH_START_RELEASE_MISMATCH
FRESH_START_NOT_INITIALIZED
FRESH_START_STORAGE_FAILURE
FRESH_START_CONTEXT_REQUIRED
FRESH_START_BUILD_MISMATCH
FRESH_START_SCHEMA_MISMATCH
FRESH_START_ADMISSION_STALE
FRESH_START_ADMISSION_DENIED
FRESH_START_CONTENT_UNVERIFIED
FRESH_START_RECOVERY_REQUIRED
```

Exact NEW error type (GovernedNoteErrorCode is the literal union above):

```ts
type RecoveryIdErrorCode =
  | 'COMMAND_OUTCOME_UNKNOWN'
  | 'GOVERNED_NOTE_OWNERSHIP_UNCERTAIN'
  | 'GOVERNED_NOTE_KEY_UNAVAILABLE';
type GovernedNoteErrorV1 =
  | Readonly<{
      code: Exclude<GovernedNoteErrorCode, RecoveryIdErrorCode>;
      message: Exclude<GovernedNoteErrorCode, RecoveryIdErrorCode>;
      details: Readonly<Record<string, never>>;
    }>
  | Readonly<{
      code: RecoveryIdErrorCode;
      message: RecoveryIdErrorCode;
      details: Readonly<{ commandId: string; idempotencyKey: string }>;
    }>;
```

Runtime decoding requires EXACT own keys code/message/details, message===code and membership in the closed union. The first branch's details must be an exact empty plain owned record, not merely a value assignable to TypeScript `{}`. The second branch's details must have exactly commandId and idempotencyKey, each a valid canonical UUIDv4 equal to the admitted original command IDs. No extra key, optional ID, missing ID or empty-details second branch is valid. Use INPUT_INVALID with empty details for a request lacking valid IDs; use GOVERNED_NOTE_UNAVAILABLE with empty details for owner-close failure without a particular command. Do not expose ownerId, exceptions, summaries, key refs, paths or MACs.

Shape/invalid UUID/Unicode/duplicates -> INPUT_INVALID; well-formed unsupported version/operation -> FORMAT_UNSUPPORTED; structural/byte cap -> LIMIT_EXCEEDED. Decoder needs separate limit accounting so it does not rely on a helper that collapses overflow into generic input error. Proxy-safe traversal and canonical byte algorithm above provide that distinction. Policy acquisition/validation -> POLICY_UNAVAILABLE. Evidence provider/retained key failure -> KEY_UNAVAILABLE. Missing or inadmissible provenance -> PROVENANCE_INELIGIBLE; authenticated-row/pair corruption -> INTEGRITY_FAILURE. Current authority/proof failures use matching existing listed SESSION codes. Missing note command is successful not-found only under qualified absence, never SESSION_NOT_FOUND.

Preserve listed existing fresh-start/binding/maintenance/busy codes only after safe type-aware classification. Unrecognized errors before possible commit -> GOVERNED_NOTE_UNAVAILABLE with no original text/cause. After a possible commit, rollback uncertainty or lost mutation response -> COMMAND_OUTCOME_UNKNOWN with IDs and permanent controller uncertainty. Parent WORKER_TIMEOUT is mapped for create to unknown and for recovery to WORKER_UNAVAILABLE; WORKER_TIMEOUT is deliberately absent from this new wire allowlist. Protocol/correlation/integrity failure after a posted create cannot prove noncommit: parent returns unknown and poisons the slot, even if internal diagnostics retain a fixed safe classification. Oversized/malformed success follows the same rule. No automatic retries except existing service-classified SQLITE_BUSY proving pre-BEGIN absence/successful rollback. Unknown nonmutation recovery failure does not become a second mutation outcome.

## 11. Adversarial isolated acceptance contract

These are future executable obligations under a separately approved plan, not tests run or results established here. Use disposable stores, synthetic retained evidence, trusted local authority/provider fixtures and exact recorded build/profile identity. Show both asserted outcome and absence of unintended effects.

| Fixture / input | Required observable result |
| --- | --- |
| Each of four kinds with legitimate retained provenance and redaction | Exactly one candidate/unverified pair/receipt; actual redacted summary; no full body, fabricated output kind or factual verification |
| Empty/over-limit summaries; 2,048-byte boundary; NFC/redaction expansion | Raw/intermediate/final bounds enforced; no clipping; metadata/envelope charged |
| Exotic/accessor/proxy/symbol/sparse/extra-key input; 0/64/65 provenance refs | Own-data bounded decoder rejects unsupported input before effects; no accessor/trap execution in proxy-safe traversal |
| Reordered versus duplicate provenance | Order-only change is equivalent replay; duplicate selector refuses |
| Raw NFC or whitespace variants with same displayed summary | Historical original-input equality detects conflict |
| Missing/foreign/other-event-family source | PROVENANCE_INELIGIBLE; no generic event fallback |
| Retained source authorized by root for child | Refused under same-session note provenance policy |
| Source key revoked/unavailable before new creation | Key refusal, no creation; no decrypt/plaintext fallback |
| Source corruption, blob transport mismatch or orphaned retained dedup/auth | Integrity failure rather than valid provenance |
| Wrong session/sibling/root-on-child/role/client/audience/generation/branch | No mutation or receipt disclosure; current same-session scope enforced |
| Wrong proof target/domain/hash/nonce; retained proof reused as note proof | Refusal before effects |
| Valid active/read-only-recovery command-recovery admission plus current same-session authority | Narrow committed receipt or qualified not-found lookup permitted; no summary/body or post-end access; existing admission freshness/revalidation remains exercised |
| Failed command-recovery release/build/schema/recovery-tail admission | Corresponding existing safe admission error withholds receipt AND not-found, even with valid proof and healthy owner; no mutation |
| Successful command-recovery admission but stale/ended/revoked/transferred same-session authority | Corresponding existing safe authority refusal withholds receipt AND not-found; admission cannot replace worker-point authority |
| Fault before BEGIN, between pair events/dedup, before COMMIT | No partial authoritative candidate; fixed refusal or unknown according to actual commit uncertainty |
| Commit-attempt/rollback uncertainty, lost worker acknowledgment | Original-ID unknown; slot permanently unavailable, no automatic retry/reopen |
| Late original commit after caller timeout | Commit may exist; controller stays uncertain, IDs/fixture preserved, never final absence/replacement |
| Lost downstream client delivery after successful executor receipt | Healthy-owner recovery returns original authenticated receipt; no extra candidate |
| Orderly normal close after healthy receipt, same-run reopen | Original authenticated receipt recoverable with new current bounded proof; no generic close-success inference |
| Concurrent equivalent commands or changed kind/summary/confidence/provenance | One winner for exact original equality; changed input/identity conflicts |
| Policy/key rotation and missing historical note key | Replay uses recorded historical equality or fails closed; no new policy rewrite |
| Receipt-only recovery after source-key status changes | Authenticate note pair/receipt and current note authority; do not recompute original equality or decrypt source |
| Pair reorder/missing companion/tampered receipt/hash/index/stream position | Integrity/conflict; no unknown-event skip or not-found |
| Dedup absent but either original event exists | Integrity failure; absence requires both identity selectors absent in events and dedup |
| Generic append attempts reserved witness or source-event companion | Refused at guarded preparation/planning/append/dedup paths |
| In-flight create when recovery arrives | Immediate OWNER_BUSY; no hidden wait or restarted R; no not-found |
| Recovery gate held while response is delayed | New create/recovery refused until disposition; prior-attempt absence remains serialized |
| Forced close resolves generic close(); late graceful response/exit after escalation | No normal-release token; absorbing uncertainty remains |
| Constructor uncertainty, stale/forged/cross-run permit, duplicate open | No replacement owner; exact current run/store/owner binding enforced |
| New parent tries existing prior fixture | Refused through fresh allocator/controller; prior fixture preserved |
| Retained/lifecycle fixture writer bypasses exclusive controller | Qualification fails; do not claim sole ownership or final absence |
| Queue-full before posting vs posted timeout | STORE_QUEUE_FULL versus original-ID unknown; no new command IDs |
| FIFO consumes R; retry budget starts later; in-flight call returns late | Separate clocks preserved; no false preemption/rollback claim |
| Provider/policy/current/status/MAC/verify stall | Parent safe response as schedulable; no native termination claim; uncertainty absorbing where owner poisoned |
| Healthy exact-ID read at committed position | Existing private lane returns actual candidate summary and matching source position; lag refusal never duplicates mutation |
| Ranked search/context controlled fixture | Existing candidate/fallback features, ranking version, budgets/diversity unchanged; no kind boost/promotion |
| Seeded raw secrets and provider exceptions | Absent from durable pair/dedup/results/errors/logs/metrics; no total managed-memory-erasure claim |
| R/C API-range boundary | 1 and 2147483647 accepted as configuration using injected scheduler observation; zero/negative/fraction/NaN/Infinity/2147483648/MAX_SAFE_INTEGER refuse before fixture/open; no long wall-clock waits |
| L boundary and invalid trusted profile | 1..120000 only, no default; invalid config fails before fixture/open |
| Exact error union | ID-bearing codes cannot have empty/partial/extra details; non-ID codes have exact empty details; message===code; returned IDs equal admitted originals |
| Public/full-evidence/V1 regression | Status-only registration, productionReady:false, closed promotion/full-evidence gates and V1 isolation preserved |

### Proof/authority boundary fixtures

Use deterministic trusted worker capability-clock values and controlled response delivery. The test oracle knows times; the production parent gains no clock dependency. All delayed-success cases remain inside ordinary R and keep controller/worker/protocol healthy, so proof expiry is the isolated variable.

| Phase at which expiry is crossed | Committed-result expectation | Not-found-result expectation |
| --- | --- | --- |
| Before worker lookup | Nonmutation authorization refusal; no receipt | Nonmutation authorization refusal; no absence result |
| During the worker read transaction before final verification | Nonmutation authorization refusal | Nonmutation authorization refusal |
| Immediately before final worker verification/detach | Nonmutation authorization refusal; original IDs retained by caller | Nonmutation authorization refusal; no absence claim |
| AFTER final successful worker verification/detach inside transaction, before authenticated transport reaches parent | Delivery succeeds if read COMMIT and ordinary ownership/protocol/timeout checks succeed | Delivery succeeds under the same conditions; exclusive gate remains held through disposition |

Two separately named fixtures are mandatory: **delayed committed delivery after worker authorization expiry** and **delayed not-found delivery after worker authorization expiry**. For each, choose expiresAt=T, final worker verification/detach at T-1 and parent delivery at T+1 with R still live. Assert success and no parent freshness check/renewal; returned result represents the worker authorization point, not authority at facade return. Neither result claims current session/generation state at that later time. A separate fixture at detach time T (expiry no longer future) expects refusal, not success. Preserve original command IDs and prove no mutation in all recovery expiry fixtures.

Also exercise revocation/terminal/transfer/generation change before the final worker observation: refuse even if committed data exists. This enforces current authority at the selected observation point without promising continuing validity through transport. A read COMMIT/cleanup failure after detached candidate creation withholds that candidate and follows nonmutation availability/ownership handling; no partial detached candidate escapes as success.

Synthetic pending termination observations may test absorbing state without launching a real unbounded native hang. No forced/native-release proof is required for reopening because forced paths never reopen. Any actual stall fixture needs contained lifecycle under the later approved test plan; this spec grants no process-control authorization now.

## 12. Remaining entire-PROD obligations

Public routing, root/child continuation/checkpoint/recoverable end, PUBLIC workflow/capability parity and operational lifecycle composition remain incomplete. The private deterministic list/recent/context-pack/follow-up-radar subsystem is already accepted through Task6; this specification does not repeat or relabel that delivery. Full note bodies, kind-aware projected APIs and Markdown-targeted semantics remain pending. Verification/promotion/correction/conflict/supersession/retraction/expiry/erasure and restore-safe enforcement are not delivered by candidate creation.

Operational purpose-key custody/rotation/historical recovery/deployment remain unqualified. Actual supported host visible capture/protected persistence/private finalization still need real-host evidence. F3 needs backup/scheduling/health, isolated restore and authenticated replay to acknowledged position, key/erasure reconciliation and exact compiled public-service qualification on Ubuntu and Windows. F4 needs exact release/configuration/target approval, protected V1 isolation and live durable write/later retrieval/backup evidence. No V1 import or migration rehearsal is introduced.

Preserve memory_v2Status-only public registration, productionReady:false, closed promotion, FRESH_START_CONTENT_UNVERIFIED, requireFullEvidence=true and host-capability-unverified. This candidate does not add durable cross-parent/all-writer fencing, forced/native-release reconciliation or post-end recovery authority. Isolated acceptance cannot activate production or resolve these broader dependencies.

## 13. Concrete proposed approval bundle

The archived candidate passed root and independent architectural review; the current baseline/status and explicit local-composition ownership were checked during this F2 continuation. Human written-spec review accepts or revises this complete bundle:

1. Four summary-only candidate/unverified kinds, retained-only exact same-session provenance, strict raw/normalized/redacted 2,048-byte limit; full body/public parity pending.
2. Exact v1 private types/transports, canonical reserved two-event/dedup/receipt contract, keyed original-input equality and fixed proof/hash/error domains defined here.
3. Explicit qualified R/C/L with supported ranges and no operational defaults; separate clocks, local synchronous dependencies and no fixed native/close-settlement bound.
4. Fresh disposable single-run ownership, only privately confirmed normal graceful close permits same-run reopen, and uncertainty is absorbing. Lost client delivery after healthy receipt is recoverable; lost worker response/timeout/forced cleanup is permanently unavailable in this slice.
5. Same-session current authority/proof verification and result detach INSIDE the worker transaction are the recovery authorization point. Authenticated committed/not-found delivery may cross expiry afterward and still succeed while ordinary controller/protocol/timeout checks are healthy. No parent current-authority/fresh-proof promise, clock dependency or auto-renewal. Ended/revoked/transferred authority before that worker point refuses.
6. Existing exact-ID private candidate retrieval and unchanged ranking; precise isolated matrix above; production/public gates preserved.

The narrow scope, indefinite unavailable outcomes and worker-point delivery freshness are material product costs, not hidden implementation details. If they fail the intended next increment, revise architecture before approval. There is no remaining request for the user to invent literals, interface bindings or timing values; exact fixture R/C/L are later engineering qualification inputs under the explicit policy.

Even written-spec approval permits only the next planning stage. An executable plan requires its own review, retaining the already chosen Subagent-Driven method. This written design does not itself authorize product implementation, operational setup, deployment or activation. The existing Subagent-Driven preference is retained; no method reselection is needed.

## 14. Design verification and preserved evidence

The archived candidate3 and its editable consolidated draft are byte-identical SHA25619e841a99a5089507ac42a56902e0fdb66f09f4dd0c480eb77142fa15d4f8222. Independent review3 cleared N1 independent command-recovery admission and preserved accepted I1/I2/M1 corrections. This published version refreshes the satisfied private-read prerequisite and explicitly assigns private local worker-composition responsibility; the selected command, authority, ownership, error, timing, pair and recovery-delivery contracts remain unchanged.

[Design review and source bindings](../reports/2026-10-08-v2-governed-summary-commands-design-review.md) records the recovered review lineage and current static audits. [Accepted private workflow evidence](../evidence/2026-10-07-v2-native-read-workflows.md) binds runtime56232b5 and documentary51076be separately. [Fresh-start roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md) retains all remaining F2/F3/F4 obligations. Original reviewed inputs, failed/diagnostic histories and unapproved proposals remain in the verified external375-file archive; publication does not rewrite them.

Self-review checks placeholder absence, internal consistency, subsystem scope, exact interfaces/values, independent admission versus authority, normal-close-only ownership, worker authorization versus later delivery and faithful pending operational/public requirements. These are documentary/static checks, not new runtime acceptance. Reuse the accepted unchanged baseline; do not rerun Task6 or old broad suites merely to prepare this design. The later executable plan uses task-focused checks and one relevant current-candidate subsystem qualification after review, repeating other evidence only when changed inputs or concrete findings require it. F3's exact public-service/both-OS release remains separate.
