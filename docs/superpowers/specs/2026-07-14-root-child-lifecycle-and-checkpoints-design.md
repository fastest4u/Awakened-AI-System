# Subproject 2: Root/Child Lifecycle and Checkpoints

Date: 2026-07-14

Status: Approved for implementation planning

Parent design: docs/superpowers/specs/2026-07-11-full-event-sourced-memory-orchestrator-design.md

Predecessor: Subproject 1, Identity and Append-Only Event Core

Delivery position: Subproject 2 of 5

Primary-mode cutover: Forbidden in this subproject

## 1. Decision summary

Subproject 2 adds a durable, event-sourced lifecycle domain on top of the
project-isolated event core delivered by Subproject 1. It replaces the
single-active-session assumption inside the Version 2 domain with explicit root
and child sessions, capability-scoped authority, owner-generation
compare-and-swap, safe resume, durable checkpoints, structured child results,
operational leases, and an idempotent end workflow.

This subproject does not connect Version 2 lifecycle handling to the production
MCP composition root. Version 1 remains the sole user-visible MCP lifecycle
authority while the orchestrator is off. Subproject 2 supplies an unregistered,
pure compatibility mapper and test harness so Subproject 5 can later add actual
off, shadow, and primary routing without redesigning lifecycle semantics.

The approved delivery sequence remains:

1. Subproject 2: lifecycle ownership, checkpoints, and recovery.
2. Subproject 3: deterministic projections and explainable retrieval.
3. Subproject 4: encryption, privacy, retention, and global scope.
4. Subproject 5: migration, shadow parity, backup, rollback, and explicit
   production cutover.

## 2. Why this subproject exists

The current Version 1 lifecycle stores one vault-wide activeSession in
memory/.memory-mcp/lifecycle.json. A second memory_sessionStart archives the
first session as superseded. memory_sessionEnd then closes whichever session is
currently active because its input contains no authoritative session identity
or ownership proof.

This produces ownership inversion when a primary agent delegates work:

1. The primary starts root A.
2. A child independently starts B.
3. Version 1 supersedes A with B.
4. The primary ends what it believes is A.
5. Version 1 closes B with the primary outcome.

Atomic file replacement protects against torn JSON but cannot make a
read-modify-write singleton safe across processes, cannot distinguish owners,
and cannot make retries idempotent. Version 1 remains unchanged for
compatibility until the later cutover project; Version 2 must prove the correct
model independently first.

## 3. Relationship to the umbrella design

The approved umbrella architecture is authoritative. This phase specification
narrows it into one implementation boundary and resolves seams that the
umbrella deliberately left to phase planning.

This specification must not weaken these inherited invariants:

- ProjectBinding is transport-private and established before content access.
- Project, vault, store, workspace, and branch identities are resolved before
  session selection.
- Every externally initiated semantic mutating command has a caller-persisted
  commandId and globally unique idempotencyKey.
- Semantic history is append-only and hash chained.
- Correctness resides in SQLite transactions, constraints, and compare-and-swap,
  not in one process or one executor queue.
- Root lifecycle authority belongs only to a trusted primary binding that also
  proves possession of the current root capability.
- Child work is isolated in a child stream and cannot supersede, end, retract,
  or promote its parent.
- Starting one root never supersedes another root.
- Cross-project access remains denied before retrieval or mutation.
- Primary mode remains blocked until Subprojects 3 through 5 and every umbrella
  cutover gate pass.

## 4. Goals

Subproject 2 will:

1. Model roots and children as distinct event streams with immutable lineage.
2. Permit multiple concurrent roots in one project when their continuity
   namespaces differ.
3. Require trusted primary authority for root start, resume, suspend, amendment,
   cancellation, abandonment, and end; recovery always targets an authenticated
   primary even when maintenance executes the approved transaction.
4. Permit an optional direct child connection to checkpoint, report work, and
   propose completion only for its own child stream.
5. Issue opaque, binding-scoped, generation-scoped capabilities without storing
   plaintext capabilities.
6. Rotate root ownership with an owner-generation compare-and-swap and make all
   earlier-generation handles stale.
7. Resume only through explicit identity, deterministic scope filters, private
   resume proof, and exactly one safe candidate.
8. Record bounded checkpoints that are sufficient to resume work without
   replaying raw conversation evidence.
9. Aggregate child results through explicit primary disposition while
   preserving the child's immutable history.
10. End sessions through a durable, idempotent workflow that survives process
    death and lost responses.
11. Materialize one deterministic compatibility session-log artifact per
    session through a fenced outbox worker.
12. Supply migration, integrity, cross-process, retry, and fault-injection
    evidence that the original ownership inversion is impossible in Version 2.

## 5. Non-goals

Subproject 2 will not:

- modify src/app.ts or src/index.ts to route production MCP calls to Version 2;
- add a live off, shadow, or primary mode switch;
- make Version 2 the user-visible lifecycle authority;
- import Version 1 lifecycle files as resumable Version 2 sessions;
- build canonical, task, graph, lexical, vector, or retrieval projections;
- provide final session-tree query projections owned by Subproject 3;
- persist plaintext conversation or tool-result evidence;
- claim full-evidence retention or satisfy the production requireFullEvidence
  gate;
- implement envelope encryption, key rotation for evidence, erasure, promotion,
  retention, or global memory;
- implement legacy vault import, parity reports, production backup and restore,
  rollback fencing, dashboards, or production cutover;
- execute arbitrary caller-supplied shell commands;
- delete or rewrite Version 1 Markdown memory.

## 6. Approved phase-boundary decisions

### 6.1 Child authority

TrustedActorRole remains exactly primary, maintenance, or untrusted. This phase
does not add child or sub-agent to the trusted transport role enum or the
events.actor_role SQL constraint.

A direct child is a logical principal represented by:

- a transport binding whose actorRole is untrusted;
- a non-root agentId used only for attribution; and
- a child-session capability that authorizes a small action set on exactly one
  child stream.

The child capability is the authority. A caller-controlled role label is never
authority. A child connection without that capability remains untrusted and
cannot perform lifecycle mutation.

Authorization is conjunctive:

| Trusted binding | Authority input | Permitted lifecycle authority |
| --- | --- | --- |
| primary | none, new-start only | Create one new root and mint its private authority; cannot select or replace an existing root |
| primary | proof from current root-session-handle | Checkpoint or suspend the root; request, amend, or cancel end; fork, disposition, suspend, or complete descendants; record root or descendant coverage |
| primary | current root proof plus valid AbandonmentApproval | Abandon that root without representing success |
| primary | proof from current root-resume-token | Attempt exact or latest-safe root ownership transfer through generation CAS |
| primary | valid RecoveryApproval targeting that binding | Recover one root and receive replacement authority |
| untrusted | proof from child-session-handle | Read scoped context, checkpoint, record coverage, report, or propose completion for that child only |
| maintenance | valid RecoveryApproval targeting an attached authenticated primary | Execute recovery for that primary; never receive or use the replacement authority |
| maintenance | internal workflow fence | Continue an already-authorized saga or derived outbox phase |
| any other combination | any value | Denied |

A root proof presented through an untrusted binding still fails. A child proof
can never start, resume, recover, suspend, abandon, or end a root. A capability's
authoritySessionId may differ from targetSessionId only for an allowlisted
root-to-immutable-descendant action; lineage is folded and verified in the same
transaction.

### 6.2 Authoritative lifecycle state

Semantic truth is the immutable event stream. Subproject 2 also maintains small
transactional invariant indexes for authority, lease, continuity uniqueness,
latest-checkpoint location, and workflow recovery. These indexes are updated in
the same SQLite transaction as their semantic event and are verified against a
deterministic event fold.

These invariant indexes are not the user-facing session_tree projection.
Subproject 3 may rebuild richer query projections without changing lifecycle
command correctness.

### 6.3 Evidence boundary

Subproject 2 records only ordered coverage metadata:

- adapter and batch identity;
- frame ordinals and frame identifiers;
- domain-separated keyed content fingerprints;
- first, last, and highest-contiguous ordinal;
- canonical missing-ordinal intervals;
- capture mode and redaction state.

It stores no raw frame text, tool payload, model message, secret, plaintext
evidence, or unkeyed content hash. Coverage events use domain-separated
HMAC-SHA-256 fingerprints produced through an opaque provider operation so
short or predictable messages cannot be dictionary-checked from the database.
evidenceRefs and evidenceDigests remain empty until Subproject 4 supplies
encrypted evidence storage.

The only allowed capture mode in this phase is coverage-only. Synthetic
fixtures may prove batching, gap detection, and idempotency, but the system must
not claim that durable raw evidence is complete. Live content capture remains
disabled.

### 6.4 Runtime-mode boundary

The production composition root remains off and Version 1 remains authoritative.
Subproject 2 delivers:

- lifecycle-domain services behind internal interfaces;
- worker/executor operations needed to test them against a real store;
- Version 2 request and response contracts;
- a pure disabled adapter;
- a pure, unregistered shadow-compatibility mapper and parity harness.

Subproject 2 does not register those contracts as production MCP tools and does
not write semantic Version 2 events for ordinary Version 1 MCP traffic.

### 6.5 Exit-criterion interpretation

The umbrella statement that ownership inversion becomes impossible applies to
the Version 2 lifecycle processor exercised directly across real processes.
It does not assert that the still-authoritative Version 1 lifecycle is fixed.
The user-visible switch remains a Subproject 5 cutover action.

## 7. Architecture

The lifecycle domain is divided into focused units:

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| LifecycleContracts | Strict command, event, checkpoint, report, and response types | Identity and event contracts |
| SessionAggregate | Deterministic root or child event fold and transition validation | LifecycleContracts |
| SessionAuthorityRepository | Transactional authority, continuity, generation, and revocation indexes | SQLite driver |
| SessionLeaseRepository | Operational owner leases and fencing | SQLite driver and Clock |
| CapabilityService | Capability reconstruction, verifier/proof verification, deterministic reissue, and rotation | CapabilityKeyProvider and SessionAuthorityRepository |
| AuthorityMaterialAdapter | Private issuance delivery, proof derivation, and crash-durable pending-proof retention | CapabilityKeyProvider and trusted credential store |
| LifecycleCommandProcessor | Atomic lifecycle commands and semantic events | EventStore, aggregate, authority, lease |
| LifecycleQueryService | Bounded authoritative folds and safe summaries | EventStore and invariant indexes |
| CheckpointService | Checkpoint validation and append | LifecycleCommandProcessor |
| ChildWorkflowService | Fork, report, disposition, completion, suspension, and transfer | LifecycleCommandProcessor |
| SessionEndCoordinator | Durable workflow phases and recovery | workflow_instances, outbox, validation |
| CompatibilityLogMaterializer | Deterministic Markdown rendering and atomic replacement | Outbox worker and vault boundary |
| LifecycleV2CompatibilityAdapter | Pure disabled and shadow mapping for later routing | Version 1 input/output contracts |

No unit may open SQLite outside the project-store worker. Parent-process
services send strict commands through ProjectStoreExecutor. The worker validates
the re-established ProjectContext and performs authority checks, event append,
invariant-index changes, workflow changes, and outbox changes in one transaction.
Capability-proof verification and authoritative lifecycle intentHash
recomputation also occur within that worker authority boundary; parent-process
code cannot pre-authorize a lifecycle mutation.

Parent-side read-then-append authorization is forbidden.

## 8. Identity and session model

### 8.1 Session identity

sessionId is a server-generated canonical lowercase UUID and is the authoritative
session key.
Similarity of taskArea, topic, title, timestamps, filenames, or agent names is
never session identity.

Every session carries:

- projectId, vaultId, storeId, workspaceId, and optional branchScopeId;
- sessionId;
- sessionKind, root or child;
- immutable parentSessionId for a child and null for a root;
- clientNamespace;
- continuityKey;
- root correlationId;
- creating agentId and clientInstanceId;
- current ownerGeneration;
- semantic state;
- current stream version;
- latest checkpoint event position when present.

### 8.2 Continuity namespace

The continuity namespace is:

projectId + workspaceId + clientNamespace + continuityKey.

A partial unique SQLite index permits at most one nonterminal root in that
namespace. Child continuity is derived from the immutable child sessionId and is
not eligible for root selection.

The continuityKey is a selector, not a secret and not ownership proof. When the
adapter has a stable thread or task identifier it derives a stable key using a
versioned domain-separated hash of projectId, clientNamespace, and that
identifier. Otherwise the server generates a random key and the adapter persists
it outside child context.

### 8.3 Correlation and causation

The server owns lifecycle correlation:

- SessionStarted creates one correlationId for the root.
- Every root and child event in that tree inherits the root correlationId.
- SessionForked is the first child event and the causation source for later
  child events.
- Child report, disposition, checkpoint, transfer, resume, and end events record
  the directly preceding semantic event as causationId when one exists.
- Outbox work records the event that requested the materialization as its
  causation source.

Ordinary callers cannot replace the stored correlationId. commandId and
idempotencyKey remain caller-persisted retry identity; agentId remains
attribution only.

## 9. Session state machines

### 9.1 Root states

Persisted root states are active, suspended, ending, ended, and abandoned.

Allowed principal transitions are:

- no session to active through SessionStarted;
- active to suspended through SessionSuspendRequested and SessionSuspended;
- suspended to active through SessionResumed;
- active or suspended to ending through SessionEndRequested;
- ending to active or suspended through SessionEndCancelled;
- ending to ending through amendment, verification retry, or recovery;
- ending to ended only after SessionEndVerificationPassed and the required
  completion conditions;
- active, suspended, or ending to abandoned only through explicit approved
  abandonment.

Lease expiry does not change semantic state and never appends SessionEnded,
SessionSuspended, or SessionAbandoned.

### 9.2 Child states

Persisted child states are active, completion-proposed, completed, suspended,
and transferred.

Allowed transitions are:

- no child to active through SessionForked as the first child-stream event;
- active to completion-proposed through ChildCompletionProposed;
- completion-proposed to active when the primary rejects completion or requests
  more work through ChildWorkDispositioned;
- active or completion-proposed to completed through ChildSessionCompleted;
- active or completion-proposed to suspended through ChildSessionSuspended;
- suspended to transferred through ChildWorkTransferCreated;
- a future root may claim the immutable transfer ticket through
  ChildWorkTransferClaimed and create a new child session.

A completed child cannot reopen. A child is never reparented. Transfer creates
new lineage and preserves the old child stream.

### 9.3 Child report disposition

ChildWorkReported records the report exactly once. A separate
ChildWorkDispositioned event records one primary decision:

- accepted;
- partially-accepted;
- rejected; or
- superseded.

The disposition contains reportId plus a complete partition of canonical
lowercase UUID report item identifiers into accepted, rejected, and deferred
sets, and an explanation, not a rewritten child report. accepted puts every item
in accepted; rejected puts every item in rejected; partially-accepted requires a
nonempty accepted set and at least one nonempty rejected or deferred set; and
superseded puts every item in rejected with supersededByReportId. A later primary
may supersede a disposition through another event; history remains visible.

### 9.4 Authoritative event fold

A pure reducer folds one authoritative session stream and validates:

- contiguous stream versions and deterministic stream identity;
- immutable sessionId, session kind, and parentSessionId;
- every legal state transition and rejection of every post-terminal mutation;
- root ownerGeneration beginning at 1 and increasing exactly by one on transfer
  or ownership recovery;
- child capability generation and revocation;
- authority commitment and event-position monotonicity;
- checkpoint base positions that do not point into the future; and
- exactly one terminal event.

Before every lifecycle mutation, the worker compares the folded terminal state,
generation, parent, and latest authority commitment with session_authority.
Mismatch is INTEGRITY_FAILURE and never triggers automatic repair.

session_authority may shortlist nonterminal children for root-end evaluation,
but the coordinator folds every shortlisted child stream before deciding
whether completion or carry-forward requirements are satisfied.

## 10. Capability and ownership design

### 10.1 Capability kinds

Lifecycle capability schema Version 1 defines:

- root-session-handle;
- root-resume-token; and
- child-session-handle.

The root session handle authorizes current-generation root mutation. The resume
token authorizes an ownership-transfer attempt. The child handle authorizes only
checkpoint, report, and completion-proposal actions on one child. All three are
bearer secrets delivered only through the trusted adapter's private authority-
material channel; none is model-visible or part of a public or deduplicated
result.

### 10.2 Capability encoding

A capability uses the opaque wire form
pmcap1.KEY_ID.CANONICAL_CLAIMS.MAC, with the final three fields base64url encoded
without padding.
It is authenticated with domain-separated HMAC-SHA-256 and binds:

- capability version and key identifier;
- projectId, vaultId, storeId, workspaceId, clientNamespace, and sessionId;
- capability kind;
- one capabilityGeneration: root capabilities use ownerGeneration and child
  handles use childCapabilityGeneration;
- issuedAt and capability policy;
- a 256-bit random nonce; and
- the expiry policy for that capability kind.

Permissions are implicit in the capability kind and server policy. A caller
cannot supply a permission bitmap.

CapabilityKeyProvider exposes opaque current-key, MAC, verify, and keyed
fingerprint operations scoped by projectId, storeId, key identifier, and
purpose. Raw key bytes never leave the provider and never enter event payloads,
logs, exceptions, model-visible responses, or command_dedup. Production uses an
OS credential provider or an explicitly configured headless secret provider.
Provider access is restricted to trusted adapter and store-worker host
identities. A process-random fallback is forbidden because restart would destroy
resumability.

The provider retains every nonrevoked historical key ID referenced by
nonterminal authority, pending semantic retry records, or in-flight lifecycle
outbox rows. Explicit key revocation makes reconstruction or comparison fail
closed and requires the approved recovery path; code never silently substitutes
the current key.

Continuity and evidence fingerprints use dedicated provider purposes and store
their key identifiers. Subproject 2 permits one active continuity-index key per
project. Rotating that index key is a maintenance-fenced later operation that
must atomically recompute every nonterminal fingerprint before accepting new
starts; until that workflow exists, a continuity-index key change blocks
lifecycle mutation rather than weakening uniqueness.

Verification uses strict decoding, allowlisted fields, domain-separated MAC
input, and constant-time comparison. Invalid structure and invalid MAC return
the same safe ownership failure class.

The adapter never places an issued handle or resume token in a worker request.
It derives a CapabilityProof from the bearer secret with one of two discriminated
targets.

A semantic-command proof is domain-separated over:

- the resolved project, vault, store, workspace, client namespace,
  authoritySessionId, and targetSessionId;
- server-derived presentingActorRole, presentingClientInstanceId,
  targetActorRole, and targetClientInstanceId;
- capability kind and capabilityGeneration;
- commandId, idempotencyKey, and intentHash; and
- a random proofNonce encoded as a canonical lowercase UUID.

presentingActorRole/clientInstanceId identify the authenticated executor.
targetActorRole/clientInstanceId identify the recipient of newly issued or
recovered authority; when no authority is delivered they equal the presenter.
A fork with ChildBindingGrant targets that exact untrusted child, and maintenance
recovery targets the approval's primary. All four values are server-derived and
never caller-selected. In RecoveryApproval claims, executorActorRole maps to
presentingActorRole and targetActorRole remains the recipient.

intentHash is SHA-256 of canonical JSON containing every semantic input and
stable authority assertion. It explicitly excludes the CapabilityProof,
proofNonce, proof MAC or digest, ephemeral ProjectBinding ID, and raw evidence.
No caller-selected semantic field is omitted.

AuthorityMaterialAdapter uses the shared pure canonicalizer to compute a
candidate intentHash from decoded semantic input and its transport-private
trusted binding, then creates the proof. The worker re-decodes the request,
re-establishes ProjectContext and the stable server-derived binding assertions,
recomputes the authoritative intentHash from the original semantic assertions
with the same canonicalizer, and rejects any mismatch before proof verification
or dedup replay. Exact replay does not compare current binding generation,
branch/HEAD/dirty state, or a whole-context fingerprint; those volatile checks
run only for a fresh command after dedup misses. Candidate construction is not
authorization; only the worker's recomputation and transaction decide.

A bounded-operation proof instead binds canonical operationType, operationId,
requestId, operationHash, authoritySessionId, targetSessionId,
presentingActorRole, presentingClientInstanceId, targetActorRole,
targetClientInstanceId, capabilityGeneration, proofNonce, and a server-policy-
limited expiresAt. Lease renewal and protected
reads use this target. They do not use semantic command dedup; their generation/
fencing or read-only semantics and short expiry make an exact replay harmless.
Internal workflow and outbox operations use maintenance fences rather than a
capability.

CapabilityProof Version 1 is the target discriminator, proofNonce, and HMAC-
SHA-256. Its 32-byte proof key is HKDF-SHA-256 with IKM equal to the exact UTF-8
bytes of the complete pmcap1 bearer value, salt equal to 32 zero octets, info
equal to the exact UTF-8 bytes pm-lifecycle-command-proof-v1, and output length
32 octets. The proof MAC input is canonical JSON of the selected allowlisted
target tuple, prefixed by the exact same domain bytes.

For a new semantic command, the worker deterministically reconstructs the
current capability from persisted claims and CapabilityKeyProvider, derives the
same proof key, and verifies the proof inside the command transaction before any
mutation. command_dedup stores intentHash as command_hash plus nullable
authorization_proof_nonce and a domain-separated SHA-256 digest of the high-
entropy proof MAC; proof fields are null for commands that require no capability.
Approval-authorized commands instead store approvalId and a domain-separated
digest of the high-entropy approval MAC. Every Version 2 row stores the server-
derived presenting and target audience assertions.

Inside BEGIN IMMEDIATE the worker checks exact dedup replay before current-
generation proof verification. A replay must match intentHash, proofNonce, proof-
MAC digest, server-derived presentingActorRole, presentingClientInstanceId,
targetActorRole, targetClientInstanceId, authority and target sessions, any
approval ID/digest, and trusted binding. It may then return the stored public
effect
without reconstructing a capability that a successful rotating command already
made stale. A new command must verify against current authority. The adapter
persists the exact authorization input, whether proof or approval, with commandId
and idempotencyKey in its trusted, crash-durable private credential store until
it receives a terminal response. Thus an exact retry is allowed, but the input
cannot authorize a different intent, command, session, binding, or generation.

Internal event-appending workflow commands use the same dedup-first rule but
separate a stable replay expectation from fresh authorization. The trusted
runtime supplies workflow ID, workflow generation, planned-work ID, command
identity, and server-derived audiences before store execution. If dedup exists,
those stable fields must match and the stored record must contain a complete
original claim fence; the original claim need not still be live. Only a dedup
miss checks the current live coordinator owner/token and persists that claim in
the internal-workflow authorization record. Therefore a committed response-loss
retry succeeds after claim expiry or takeover, while a new stale-claim mutation
still fails. External decoders accept neither the replay expectation nor the
internal authorization record.

The volatile current claim assertion is not part of internal semantic intent or
the stable replay expectation. It is trusted runtime input used only by the fresh
callback. The command_dedup authorization record retains the claim that actually
authorized the committed mutation for audit and integrity verification.

planned-work ID is a nonsecret lowercase SHA-256 digest of canonical stable work
identity. Separate Version 1 domains bind validation
(workflow/generation/result/command/idempotency) and workflow phase
(workflow/generation/source phase/action/command/idempotency). Claim owner and
token are never inputs to that digest.

For workflow phases, the runtime first canonicalizes project, workflow,
generation, source phase, and action. It derives commandId by UUIDv5 under one
fixed lifecycle namespace and idempotencyKey from the canonical-action SHA-256,
then hashes the action plus those identities into planned-work ID. This ordering
is deterministic and has no circular derivation.

The pending record's binding witness is deliberately stable: projectId,
vaultId, storeId, workspaceId, clientNamespace, and the server-derived
presenting/target audiences. It never stores or compares projectBindingId,
binding generation, branch/HEAD/dirty state, or a whole-context fingerprint.
Those volatile values may change after the original command commits; exact
dedup retry still compares the original semantic assertions and stable witness,
while a fresh command performs current branch/source checks.

Capability claims assert an already-resolved ProjectBinding; they never select
a project. They do not bind to projectBindingId, binding generation, Git HEAD,
branch name, or the complete context fingerprint because those values can
change during a legitimate commit, revalidation, or cross-process resume.

- root-session-handle binds primary role and the current owner
  clientInstanceId;
- root-resume-token requires primary role at use but excludes
  clientInstanceId so another trusted primary process can attempt the CAS; each
  use-time proof still binds that candidate as both presenting and target
  primary; and
- child-session-handle binds untrusted role and the intended child
  clientInstanceId.

Issuance binding identifiers are retained for audit but are not capability
audience keys.

### 10.3 Stored authority

session_authority stores only:

- identity and immutable lineage fields;
- semantic_state as a fold-derived transactional mirror used only for
  constraints and indexing;
- ownerGeneration;
- an independent child capability generation when direct access is enabled;
- capability version, kind, key identifier, issue time, policy code, and expiry
  policy fields;
- bound role and client instance assertions;
- random issue nonces;
- domain-separated keyed verifiers of the complete issued handle and resume
  token;
- a keyed continuity fingerprint instead of a raw continuity key;
- issuance binding identifiers for audit;
- an authority commitment over the canonical committed-authority field set;
- latest checkpoint event position;
- checkpoint-required reason and event position when applicable;
- created, updated, revoked, and terminal timestamps.

Every canonical claim required to reproduce a capability is persisted except
key bytes. No command trusts semantic_state until it equals the authoritative
event fold. The nonterminal continuity index is gated by a null
terminalEventPosition, not by semantic_state alone.

The authority commitment covers session identity and kind, immutable parent,
workspaceId, clientNamespace, keyed continuity fingerprint plus its key ID and
domain, ownerGeneration, childCapabilityGeneration, direct-access flag,
capability versions and key identifiers, issue nonces, issuedAt, policy and
expiry fields, every bound role/client/audience assertion, capability verifiers,
revocation fields, and terminal guard. Pure audit-only issuance binding IDs are
explicitly excluded. Every event that mutates a committed field, including
start, fork, transfer, recovery, child rotation or revocation, completion, end,
and abandonment, carries the new commitment.

Plaintext capabilities are never stored. Because the nonce and binding material
are stored and the project key is external, the same capability can be
deterministically reissued after a lost response. Its keyed verifier must match
the stored verifier before it is released.

The command_dedup response payload stores only non-secret public material; its
authorization columns store only proof version, nonce, and digest. A deduplicated
replay always returns the stored public result plus authorityMaterialStatus,
whose value is reissued or stale. After a new or current-generation deduplicated
command succeeds, CapabilityService reissues authority material from
session_authority through the private adapter channel. Before reissue it
revalidates the binding and confirms that the recorded generation is current.
It releases reconstructed authority only to the authenticated targetActorRole
and targetClientInstanceId stored by the command and current authority row; the
presenting audience never substitutes for the target audience.
If ownership advanced, authorityMaterialStatus is stale, no capability is
released, and recoveryCode is SESSION_HANDLE_STALE. This is replay metadata, not
a second semantic failure or event. If the referenced key is unavailable or
revoked, status is also stale with SESSION_CAPABILITY_KEY_UNAVAILABLE and no
fallback key is attempted.

### 10.4 Owner generation and lease

A new root starts at ownerGeneration 1. A successful ownership transfer:

1. verifies a command-bound proof derived from the resume token;
2. verifies the candidate identity and resumable state;
3. checks that no foreign nonexpired owner lease blocks takeover;
4. releases generation G's lease;
5. compare-and-swaps authority from G to G+1 and rotates handle and resume
   nonces;
6. inserts the generation G+1 lease; and
7. appends SessionOwnerTransferred and, when resuming a suspended root,
   SessionResumed in the same transaction.

Exactly one concurrent transfer may win. Every prior-generation handle and
resume token becomes stale.

The trusted configuration defaults are:

- owner lease duration: 120 seconds;
- adapter renewal target: every 40 seconds;
- SQLite busy deadline: inherited from Subproject 1;
- no semantic abandonment timeout;
- resume token lifetime: until rotation, terminal state, explicit recovery, or
  key revocation.

All lease times come from an injected server Clock inside the store worker.
Callers cannot supply the current time or lease duration. Tests use a fake Clock;
correctness tests never sleep to create ordering.

Lease timestamps are stored as integer epoch milliseconds. Each root lease
lineage stores lastObservedAtMs and copies it into the next generation.
Renewal and takeover compute effectiveNow as the maximum of Clock.now and
lastObservedAtMs, then persist that value, so backward wall-clock movement
cannot revive an older lease. now equal to expiresAt is expired. Renewal retains
the current fencing value; acquisition or ownership transfer increments it.

Lease renewal is an internal adapter heartbeat authorized by a bounded-operation
proof, not a public semantic MCP command. The same current owner may renew after
nominal expiry only if no takeover has committed. Renewal and takeover serialize
under BEGIN IMMEDIATE: renewal-first extends the lease, while takeover-first
advances generation and makes the renewal stale.

session_leases is root-only. Any authenticated root semantic mutation
implicitly renews the current-generation lease in the same transaction. Expiry
alone does not revoke the current handle: whichever of the current owner's
renewal or mutation and an authorized takeover commits first wins.

Ownership transfer performs one ordered transaction: release generation G's
lease, compare-and-swap session_authority from G to G+1, insert the G+1 lease,
and append the new authority commitment event. SQL triggers reject any
unreleased lease whose authority row is not a nonterminal root or whose
ownerGeneration differs from the lease generation.

Root ownerGeneration is the root lease fencing value. Direct children have no
ownership lease; childCapabilityGeneration is independent and remains valid
until explicit rotation, revocation, completion, or policy expiry. A normal
root resume does not invalidate active children. The new primary may explicitly
revoke, rotate, suspend, accept, or reject them. A separately approved
compromise-recovery policy may revoke all child capabilities.

### 10.5 Recovery after capability loss

Capability loss cannot be repaired through task similarity or a model-visible
boolean. Recovery requires a transport-private RecoveryApproval issued by the
trusted host after explicit user action.

RecoveryApproval Version 1 uses the opaque form pmrap1.KEY_ID.CLAIMS.MAC and a
dedicated CapabilityKeyProvider purpose that no MCP argument can invoke. Strict
canonical claims contain:

- approvalVersion, approvalId as a canonical lowercase UUID, key ID, and action
  fixed to recover-root-authority;
- projectId, vaultId, storeId, workspaceId, root sessionId, and expected current
  ownerGeneration;
- commandId, idempotencyKey, and authoritative intentHash;
- executorActorRole and executorClientInstanceId;
- targetActorRole fixed to primary and targetClientInstanceId;
- issuedAt, expiresAt no more than ten minutes later under the injected Clock,
  and a 256-bit random approval nonce; and
- an allowlisted reason code plus a redacted user-approval reference.

The trusted host signs the exact canonical claims with domain-separated HMAC-
SHA-256. The worker strictly decodes, recomputes intentHash and server-derived
audiences, verifies signature and expiry in constant time, and consumes the
approval in the recovery transaction. A unique lifecycle_approval_consumptions
row stores approvalId, a domain-separated nonce digest, project/session,
commandId, target primary, and consumed event position, never the raw approval.
Exact command dedup is checked first and may replay the one committed recovery;
any new command that reuses the approval fails LIFECYCLE_APPROVAL_REPLAYED.

Recovery:

- fails closed if project or store integrity is uncertain;
- requires the exact primary or maintenance executor binding named by the
  approval and an attached authenticated private channel for the target primary;
- increments ownerGeneration;
- revokes all prior capabilities;
- rotates capability material;
- records the approval reference and reason without secret content; and
- appends SessionOwnershipRecovered and consumes the approval in the same
  transaction.

The recovery transaction uses the same trigger-safe ownership order as resume:
after privately materializing the planned event positions under BEGIN IMMEDIATE,
it releases generation G's lease, compare-and-swaps authority to G+1, inserts
the G+1 lease, then appends SessionOwnershipRecovered at the reserved position
and consumes the approval. Deferred event-position foreign keys are checked at
commit. Any failure rolls back the lease, authority, event, and approval
together.

Replacement authority binds only the target primary. A primary executor may be
its own target. A maintenance executor routes the AuthorityMaterialDescriptor
through the host broker directly to the attached target AuthorityMaterialAdapter;
it cannot reconstruct, receive, or use the bearer. Lost delivery is retried only
by exact dedup under the original executor binding and again routes to that same
target. Maintenance may restore authority but cannot fabricate SessionEnded or
a successful validation result.

AbandonmentApproval Version 1 reuses the same replay-resistant base envelope
with a separate approval domain and action fixed to abandon-root. It additionally
requires a proof from the current root handle, has no capability recipient, and
is consumed atomically with SessionAbandoned. Approval action types are not
interchangeable.

## 11. Safe start and resume

memory_sessionStart Version 2 supports new, exact, and latest-safe policies.

### 11.1 New

new requires a trusted primary binding but no pre-existing capability. It always
creates a new root unless the requested continuity namespace is already owned by
a nonterminal root. A collision returns CONTINUITY_CONFLICT or, when the exact
existing root is already authorized by the same idempotent command, the stored
result. It never supersedes the existing root.

### 11.2 Exact

exact requires an explicit sessionId or an exact namespaced continuityKey and a
private semantic-command proof from the resume token, bound at use to the
presenting and target primary clientInstanceId. A missing or mismatched candidate
performs no mutation.

### 11.3 Latest-safe

latest-safe applies these filters in order:

1. resolved projectId, vaultId, and storeId;
2. trusted primary ProjectBinding;
3. explicit sessionId when supplied;
4. exact clientNamespace and continuityKey when supplied;
5. workspaceId and compatible branch visibility;
6. root kind and resumable semantic state;
7. checkpoint and source-state compatibility;
8. exactly one remaining candidate;
9. private semantic-command resume-token proof bound to the candidate target
   primary;
10. owner-generation and lease compare-and-swap.

Zero candidates returns SESSION_NOT_FOUND or a nonmutating recovery requirement.
More than one returns SESSION_AMBIGUOUS with redacted candidate summaries.
Semantic similarity is never a filter or tie breaker.

Resumability is explicit:

- suspended is normally resumable;
- active permits same-owner deterministic reissue, or transfer only after the
  foreign lease expires;
- ending continues through its existing end workflow or recovery path and is
  not selected by ordinary latest-safe resume; and
- ended and abandoned are never resumable.

### 11.4 Lost response

Retrying the same commandId and idempotencyKey replays one semantic effect. It
reissues the same capability only while that generation remains authoritative.
If ownership has since advanced, the retry returns SESSION_HANDLE_STALE without
private material. Retrying with a reused key and different intent returns
IDEMPOTENCY_CONFLICT.

Two different resume commands may race. One generation compare-and-swap wins;
the other returns SESSION_ALREADY_OWNED or SESSION_HANDLE_STALE and performs no
event append.

## 12. Checkpoint contract

### 12.1 Checkpoint Version 1

A checkpoint contains:

- checkpointVersion, fixed to 1;
- server-generated checkpointId;
- sessionId and parentSessionId when applicable;
- server-derived baseEventPosition and committed checkpoint event position;
- createdAt and creator attribution;
- concise task summary;
- completedItems, inProgressItems, blockers, and nextActions;
- decisions, assumptions, and unresolved conflicts;
- filesTouched with project-relative path, action, optional content hash only
  when the referenced file is an independently governed retained artifact, and
  trusted branch reference;
- artifact references and source references;
- command or test labels, concrete result, exit classification, a domain-
  separated keyed output fingerprint with schema and key version, and artifact
  reference;
- trusted Git branch, HEAD, workspaceId, and dirty-worktree fingerprint;
- authoritative child-state summaries for a root checkpoint, each with its last
  folded event position and stream version;
- evidence capture mode, ordinal coverage, and missing intervals; and
- confidence for every material claim.

The worker derives identity, branch, child state, event position, and stream
version. Caller-supplied values for those fields are assertions only.

SourceStateFingerprint Version 1 includes sourceStateScopeVersion fixed to 1.
The scope is resolved only from trusted ProjectBinding/store configuration and
committed lifecycle rows; no caller supplies an exclusion. When those paths are
inside projectRoot, the provider excludes the exact descriptor path, canonical
storeRoot subtree (including SQLite sidecars and manifests), and canonical
host-private pending-authorization root. It also excludes only exact
compatibility-log targets derived from committed SessionStarted identities and
exact same-directory temporary paths whose parsed session/revision/claim tuple
matches a committed outbox row. It does not exclude the whole vault, the whole
05_Agent_Session_Logs directory, arbitrary globs, or caller paths.

The provider filters fixed Git status/inventory records through that scope
before hashing canonical branch/HEAD/dirty data. Therefore store, pending,
ending, failed, completed, cancelled, or abandoned materialization writes do not
invalidate their own checkpoint/validation witnesses, while any ordinary
tracked or untracked project edit remains visible. The scope version is part of
every checkpoint and validation source-state witness; changing the rule requires
a new version rather than reinterpreting an old fingerprint.

### 12.2 Validation and bounds

Checkpoint canonical JSON is limited to 256 KiB before event-envelope overhead.
The contract permits at most:

- 2,000 Unicode scalar values in taskSummary;
- 100 entries in each work-item or decision list;
- 200 file, artifact, source, command, test, or material-claim entries in total;
- 512 Unicode scalar values per project-relative path;
- 4,000 Unicode scalar values per individual summary or result field; and
- 200 canonical missing-ordinal intervals.

Absolute paths, parent traversal, external paths, raw command output, raw process
command lines, environment dumps, secrets, and raw evidence are rejected.

The server obtains baseEventPosition inside the same transaction immediately
before append. It is the project-event snapshot watermark through which every
relevant root and child stream was folded; unrelated project streams at or below
that watermark are ignored semantically. expectedStreamVersion and optional
expectedBaseEventPosition are compare-and-swap assertions. A stale assertion
returns EVENT_CONFLICT without a partial checkpoint.

### 12.3 Required triggers

The adapter requests a checkpoint:

- after a durable ADR, mistake, insight, or other high-value memory event;
- after each accepted or partially accepted child report;
- around transitions as specified by trusted RiskyTransitionPolicy Version 1;
- before suspension;
- before session end; and
- after the trusted adapter observes either 20 meaningful turns or 15 minutes
  since the previous checkpoint, whichever comes first.

Timers do not run inside the semantic store. Missed periodic triggers are visible
as checkpoint-age diagnostics and never fabricate an event.

Server-enforced transition rules are stronger than adapter reminders:

- suspend and end either append their required checkpoint in the same durable
  workflow or reject until a valid checkpoint is supplied;
- accepting or partially accepting a child report marks the root
  checkpoint-required at the disposition event position;
- a later root checkpoint whose base includes that position clears the marker;
  and
- RiskyTransitionPolicy Version 1 enumerates ownership transfer, ownership
  recovery, suspension, carry-forward claim, end amendment, end cancellation,
  and abandonment. Every command requires a pre-transition checkpoint whose base
  includes all prior relevant events. Every nonterminal transition marks a post-
  transition checkpoint requirement at its committed event position.
  Abandonment instead records the pre-checkpoint reference in the terminal event
  and queues the terminal materialization; it cannot require an impossible post-
  terminal semantic checkpoint.

A crash after child disposition therefore exposes recoverable
checkpoint-required state instead of silently claiming the checkpoint exists.

## 13. Child workflow

### 13.1 Fork

Only a proof from the current-generation root handle under a trusted primary
binding may fork.
memory_sessionFork atomically:

- verifies root state and authority;
- creates a new child sessionId;
- records immutable parentSessionId and inherited correlationId;
- appends SessionForked as the first event of the child stream, carrying root
  author, immutable parent, assignment, and root generation;
- returns a bounded public child context and, only when a transport-private
  ChildBindingGrant exists, routes a generation-1 child handle through the
  adapter-only authority-material channel; and
- never exposes any handle or resume token to model-visible child content.

The assigned subtask and scope are immutable assignment evidence. Later scope
changes append an amendment event.

SessionStarted is the first root event. SessionForked is the child creation
event and transitions an absent child directly to active. The same semantic fact
is not duplicated across root and child streams, so fork requires one stream CAS
plus authority-row changes rather than a new multi-stream append primitive.

Without a ChildBindingGrant, directAccessEnabled is false and only the primary
may record or complete the child. With a grant, the adapter has already created
the intended untrusted child binding and the handle is bound to its
clientInstanceId. A model-provided binding or later caller assertion can never
mint direct child authority.

### 13.2 Report

A child report contains a server-generated canonical lowercase UUID reportId
and:

- childSessionId and parentSessionId;
- assignment identity;
- outcome summary;
- findings with canonical lowercase UUID item IDs and evidence references;
- proposed decisions with canonical lowercase UUID item IDs;
- files observed or changed with canonical lowercase UUID item IDs;
- verification performed with canonical lowercase UUID item IDs;
- open follow-ups and blockers with canonical lowercase UUID item IDs;
- confidence and coverage-only keyed evidence fingerprints.

A direct child may submit its own report with a proof from its child handle. The
primary may also record a structured report received out of band. The event
records child author and primary recorder separately when both exist.

### 13.3 Completion

A proof from a child handle may only propose completion. A proof from the
current-generation root handle may accept and append ChildSessionCompleted.
Completion revokes the child handle.

The default root-end policy is require-completed. If active children remain,
session end returns SESSION_CHILDREN_ACTIVE without pretending they succeeded.

The explicit alternative is suspend-and-carry-forward:

- append ChildSessionSuspended;
- create an immutable transfer ticket;
- include the ticket in the final root checkpoint;
- revoke direct child mutation;
- leave the child non-successful; and
- permit a future primary to claim the ticket into a new child stream.

The transfer ticket preserves the original assignment and scope, latest
checkpoint reference, blockers, follow-ups, source-state fingerprint, original
root and child lineage, and creating event position. Claim is idempotent and
single-winner. The claimed child uses the future root correlationId and cites
the transfer event as lineage; it never changes the old parentSessionId.

## 14. Evidence coverage adapter

memory_recordEvidenceBatch is an internal Version 2 contract in this phase. A
batch contains:

- adapterSessionId, batchId, commandId, and every frameId as canonical lowercase
  UUIDs;
- idempotencyKey;
- target sessionId and a semantic-command CapabilityProof, never the capability
  itself; a root proof may target its root or verified descendant, while a child
  proof must target that same child;
- ordered frames with zero-based unsigned-decimal ordinal; sourceKind from the
  Version 1 enum model-turn, tool-request, tool-result, adapter-event, or
  external-observation; canonical UTC RFC3339 observedAt with millisecond
  precision; and keyed canonical content fingerprint;
- fingerprintSchemaVersion fixed to 1, fingerprintKeyId, and canonicalization
  domain pm-evidence-frame-v1;
- declared first and last ordinal; and
- redaction status fixed to content-not-retained.

The worker rejects duplicate ordinals with different fingerprints, overlapping
batches with contradictions, noncontiguous internal ordering, noncanonical
identifiers or timestamps, unknown source kinds, and scope mismatch. It
canonicalizes missing intervals transactionally and rejects any batch that would
produce more than 200 intervals with EVIDENCE_COVERAGE_TOO_FRAGMENTED; it never
truncates authoritative coverage. An exact retry is deduplicated.

EvidenceCoverageRecorded updates a small invariant index and appends canonical
coverage metadata. The response reports highestContiguousOrdinal and missing
intervals.

Internal storage labels this coverage-only. External umbrella-compatible status
is partial or tool-only with contentRetained false; it is never full-adapter.
coverage-only never satisfies the production full-adapter evidence-retention
gate, even when ordinals are contiguous. A final checkpoint must label it
honestly. Subproject 4 will add encrypted evidence bodies and change the
eligible capture mode through a new event schema version; it must not
reinterpret old coverage-only events as retained evidence.

## 15. Idempotent session-end workflow

### 15.1 Request

memory_sessionEnd requires:

- root sessionId;
- a proof from the current-generation root handle;
- commandId and idempotencyKey;
- expected project, vault, workspace, and optional branch assertions;
- explicit child end policy;
- final checkpoint fields;
- allowlisted validationProfileIds;
- requested qualityThreshold as an integer from 0 through 10,000 basis points;
- optional requireFullEvidence true; and
- optional requireMaterialization true, which may tighten but never weaken
  trusted project policy.

Before any mutation, the first transaction folds every nonterminal child. Under
require-completed, any active, completion-proposed, or suspended child returns
SESSION_CHILDREN_ACTIVE with zero effect. Only an eligible request verifies
authority, creates the deterministic workflow instance when absent or reopens
its cancelled row as specified below, appends SessionEndRequested, moves the
root to ending, and records the previous active or suspended state for
cancellation.

The workflowId is session-end/{sessionId}. Amendment increments its generation;
retrying the original command identity may wake only its existing generation and
never creates another workflow. A different end command while state is ending
returns SESSION_END_INCOMPLETE and directs the caller to amendment; it cannot
append another SessionEndRequested. A cancelled workflow row remains as durable
history. A later end request from the restored active or suspended root
atomically reopens that same row at generation G+1, replaces request/policy
state, clears prior claims/retry/validation plans, appends a new
SessionEndRequested, and starts again at requested. It never attempts a second
workflow insert, and exact retries of earlier request/cancel commands still
return their historical committed effects.

SessionEndRequested persists requested and effective child policy,
qualityThreshold, qualityPolicyVersion, requireFullEvidence, and
requireMaterialization. Trusted configuration supplies the minimum threshold and
both default requirement values. The effective threshold is the greater of
trusted and caller values; each effective boolean is trustedDefault OR
callerRequested.

The persisted quality policy contains at most 64 entries of profileId,
profileVersion, required, and integer weight from 1 through 1,000,000. Every
trusted required profile is always in the effective set; the caller may add only
allowlisted optional profiles and
cannot omit or reweight one. The canonical effective order is profileId then
profileVersion. totalEffectiveWeight must be positive. passingWeight is the sum
of weights whose fresh result passes; failed or unavailable results contribute
zero. qualityScore is floor(10,000 * passingWeight / totalEffectiveWeight) using
checked 64-bit integer arithmetic. Any required failure blocks regardless of
score.
Because this phase retains coverage only, effective requireFullEvidence always
takes the verification-failed branch.

### 15.2 Durable phases

The coordinator advances these durable phases:

1. requested;
2. children-resolved;
3. final-checkpoint-recorded;
4. ending-materialization-queued;
5. validating;
6. verification-passed or verification-failed.

Only verification-passed may advance to completion-appended, then to
completed-materialization-confirmed when required, and finally completed.
verification-failed is a waiting branch and can advance only through amendment,
cancellation, or abandonment. Amendment creates a new workflow generation,
fences every prior-generation coordinator and outbox claim, and restarts the
earliest affected downstream phase; no failed generation can reach
SessionEnded.

The final-checkpoint semantic transaction appends `SessionCheckpointRecorded`
and uses that committed event as the trigger for the ending compatibility-log
outbox row. Its event position is the ending materialization revision. The next
`ending-materialization-queued` phase is an eventless compare-and-swap that first
verifies that exact immutable row; there is no synthetic queue lifecycle event.

Cancellation and abandonment leave the forward phase chain in durable terminal
workflow phases cancelled and abandoned respectively. Recovery ignores both.
Only cancelled may later reopen to requested, and only with a new generation
and a fresh authorized SessionEndRequested as defined in Section 15.1.

Every phase transition is compare-and-swap protected and idempotent. A process
may crash before or after any event, workflow update, outbox claim, file replace,
or acknowledgement. Restart resumes the same workflow from durable state.

### 15.3 Validation

ValidationProfileRunner accepts only profile identifiers from trusted
configuration. It never accepts a shell command, executable path, environment,
working directory, or script body from a lifecycle tool argument.

A durable validation result is immutable, server-recorded, and produced only by
ValidationProfileRunner. Lifecycle request and amendment DTOs accept no result
IDs or observations. The coordinator selects only result IDs from its own
persisted attempt plan and accepts a result only when it binds the same project,
workflow generation, profile configuration, and final-checkpoint fingerprint.
A result contains:

- profileId, profile version, and trusted configuration hash;
- runId, workflow generation, and runner identity;
- source-state fingerprints recorded at validation start and completion;
- project, workspace, branch, HEAD, and dirty-worktree fingerprint;
- startedAt and completedAt;
- pass, fail, or unavailable status and normalized exit classification;
- concise redacted summary;
- a domain-separated keyed output fingerprint with algorithm and key version,
  plus artifact references; a plain SHA-256 content hash is permitted only for
  an independently governed retained artifact; and
- freshness policy result.

Before external execution, the coordinator durably plans exactly one runId,
resultId, result commandId, and result idempotencyKey for each workflow
generation/profile. Crash retry reuses that plan; amendment creates a new
generation and new plans. Validation-result persistence is an internal semantic
command whose stable replay expectation is the persisted attempt-plan identity.
On a dedup miss only, the fresh transaction requires the current live workflow
generation and coordinator claim and stores that nonsecret fence in
command_dedup. Exact committed replay compares the stable plan identity before
current-claim inspection. The command cannot be selected by an external
lifecycle request. Therefore one generation never has an ambiguous choice among
multiple validation attempts.

The vault gate is a named built-in profile. Immediately before
SessionEndVerificationPassed and again in the SessionEnded transaction, the
trusted runner captures current source state and compares it with the final-
checkpoint and validation-completion fingerprints. A mismatch before pass
appends SessionEndVerificationFailed. A mismatch discovered by the final
transaction appends SessionEndVerificationInvalidated and atomically returns the
workflow to verification-failed; neither path appends SessionEnded. The public
status reports SESSION_SOURCE_STATE_CONFLICT and leaves the session in ending.
SessionEndVerificationPassed is appended only when every required profile is
fresh and passing and the effective quality threshold is met. A failure appends
SessionEndVerificationFailed and leaves the session in ending.

The caller may request a stricter threshold but cannot weaken trusted project
policy. A result whose profile configuration, source state, workflow generation,
or freshness no longer matches cannot satisfy the gate.

### 15.4 Amendment, cancellation, and abandonment

memory_amendSessionEnd uses a new command and idempotency key, increments the
workflow generation, fences all earlier work, and records only changed evidence,
profiles, thresholds, materialization requirement, or child policy. It resets
the earliest phase affected by those changes and requires downstream validation
and source-state checks to run again.

memory_cancelSessionEnd appends SessionEndCancelled and restores the recorded
active or suspended state if the session is not terminal. It advances the
workflow to a durable cancelled phase and fences all claims. A later authorized
end request may reopen only that cancelled row as the next generation under the
rules in Section 15.1.

Every ending, amendment, validation-failure, verification-invalidation,
completion, cancellation, and abandonment rewrite queues an immutable outbox
row with a new materializationRevision equal to that row's triggering committed
event position. Workflow generation remains the semantic-saga fence; the
monotonic materialization revision is the artifact-rewrite fence. Cancellation
replaces the ending artifact with an explicit cancelled-and-restored active or
suspended state. Abandonment replaces it with abandoned state. The renderer
emits an ending marker only while the folded semantic state is ending, so no
cancellation or abandonment leaves a stale document that appears pending or
completed.

A workflow-origin row stores workflowId and workflowGeneration. Direct
abandonment from active or suspended has no session-end workflow and instead
uses a terminal-event origin with both workflow fields null; its committed
SessionAbandoned position is still the materialization revision. In both cases,
the latest committed revision for project, session, and artifact kind fences all
earlier claims.

Explicit abandonment requires trusted approval, appends SessionAbandoned,
revokes capabilities, and never represents successful completion.

SessionEnded is terminal and can be appended exactly once. A terminal end cannot
be amended, cancelled, resumed, or abandoned.

Semantic terminal state and workflow completion are distinct. A crash after
SessionEnded but before a required completed-materialization acknowledgement
leaves the session ended and the workflow recoverably incomplete. Recovery may
finish the derived artifact but must never append another SessionEnded.

## 16. Compatibility log materialization

The deterministic Version 2 compatibility path is:

05_Agent_Session_Logs/{sessionStartDate}-session-{sessionId}.md

Retry time, topic edits, process identity, and workflow generation do not change
the path. sessionStartDate is derived once from SessionStarted in UTC.

The renderer consumes only committed events and produces canonical UTF-8
Markdown with:

- explicit lifecycle state;
- accepted child outcomes and unresolved child follow-ups;
- final checkpoint summary;
- validation results and keyed fingerprints;
- materializedEventPosition;
- sessionId, projectId, workspaceId, and branch assertions; and
- a visible ending marker only while folded semantic state is ending.

Outbox target identity includes sessionId, artifact kind, and
materializationRevision. Every revision still targets the same deterministic
path. The existing target_key primary-key component is encoded as
lifecycle-log/{sessionId}/{materializationRevision}, so immutable lower-revision
history can coexist. Workflow-origin rows additionally bind workflowId and workflowGeneration;
terminal-event-origin rows are allowed only for a committed direct
SessionAbandoned transition. A stale revision is fenced from overwriting a newer
revision. Each immutable row retains its planned nextFingerprint, forming the
history needed to recognize bytes replaced before a lost acknowledgement.

The worker renders strictly through the event position recorded by the outbox
row. It:

1. claims an outbox row with a monotonic fencing token and lease;
2. renders deterministic bytes through that triggering event position;
3. writes a same-directory temporary file;
4. computes the keyed materialization fingerprint and prepares the replacement;
5. opens a short BEGIN IMMEDIATE transaction and loads the exact retained
   project/target/revision/owner/token row;
6. if it is completed and still the latest revision, checks its retained
   acknowledgement/fingerprint tuple and requires current target bytes to equal
   committed nextFingerprint, then returns the stored completion without a live-
   lease requirement; if a newer revision exists, returns bounded
   superseded-after-completion without writing;
7. otherwise requires noncompleted claimed status and rechecks the live claim
   expiry, latest materialization revision, applicable current workflow
   generation, and fingerprint algorithm/schema/key ID;
8. replaces the target only when absent, already equal to the new bytes, or
   exactly equal to either the expected acknowledged prior fingerprint or the
   committed nextFingerprint of any now-fenced lower-revision outbox row for
   the same project, session, artifact kind, and path;
9. syncs the file and containing directory when supported;
10. acknowledges the new fingerprint and fencing token; and
11. commits the SQLite transaction before reporting success.

Steps 5 through 11 are one LifecycleOperationalStore materialize operation.
Repository acknowledgement is private to that operation; no executor or worker
protocol variant can acknowledge without rechecking the current target bytes,
fingerprint history, revision, generation, owner, and token.

If the file write succeeds but acknowledgement is lost, retry computes the same
bytes and accepts the matching target fingerprint. If acknowledgement committed
but its response was lost, exact materialize replay checks completed state before
lease expiry and returns the one stored completion after verifying the retained
tuple and current latest target bytes. An expired unacknowledged row cannot use
that path; it requires takeover with a new fencing identity. If a newer
amendment, verification result, completion, cancellation, or abandonment already
fenced that row, the old completed retry returns superseded-after-completion and
the newer revision may recognize stale bytes from committed lower-revision
nextFingerprint and replace them safely. Any bytes not proven by one of those
committed fingerprints fail permanently with MATERIALIZATION_CONFLICT.

In this subproject the materializer is exercised only through direct Version 2
tests and fixtures. It does not replace Version 1 session-log behavior in the
production MCP.

## 17. Recovery

On worker or server start, the recovery coordinator inspects:

- nonterminal session-end workflows;
- pending or expired-claim lifecycle outbox rows and retryable failures whose
  nextAttemptAt has elapsed;
- ending sessions without a live coordinator;
- invariant-index/event-fold disagreement; and
- expired root leases under the injected Clock and generation compare-and-swap.

Process liveness or PID reuse may be diagnostic but never authorizes lease
mutation. Outbox failure rows persist retryable or permanent classification, a
safe error code, bounded attempt count, and nextAttemptAt. Recovery applies
bounded backoff and never automatically retries permanent conflict or integrity
failures.

It may resume idempotent workflow and outbox work. It may not infer success,
append SessionEnded, transfer ownership, or abandon a session without the
required durable evidence and authority.

If quick integrity fails, lifecycle mutation stops. Full integrity runs through
the existing maintenance path. Uncertain authoritative integrity enters
read-only recovery and returns INTEGRITY_FAILURE with safe remediation.

## 18. Storage migration

### 18.1 Migration registry

Subproject 2 replaces every hard-coded single-migration assumption with one
ordered immutable registry containing:

- migration identifier 0001-event-core, whose already-published immutable
  schema_migrations name remains event-core; and
- migration identifier 0002-session-lifecycle, recorded as session-lifecycle.

Registry versions are contiguous and equal array index plus one. Names are
unique, nonblank, and immutable. Recorded migrations must be an exact
name-and-checksum prefix of the binary registry:

- an older valid prefix returns SCHEMA_UPGRADE_REQUIRED;
- a recorded version above the binary returns SCHEMA_TOO_NEW;
- a gap, name change, or checksum change returns
  MIGRATION_CHECKSUM_MISMATCH; and
- exact history with schema-object drift returns
  SCHEMA_FINGERPRINT_MISMATCH.

schema_migrations is the authoritative migration history and
project_meta.schema_version is the current applied database version. Store
manifest schemaVersion remains manifest document-format version 1 and is not a
database migration counter.

Migration 0002 replaces project_meta_no_update with:

- an immutable-identity trigger that rejects changes to singleton, projectId,
  vaultId, storeId, and createdAt; and
- a monotonic-version trigger that allows only old schema version plus one after
  the matching schema_migrations row exists.

MigrationRunner executes 0002 DDL, inserts its immutable migration row, then,
when an identity row already exists, updates exactly that row's
project_meta.schema_version to 2 in the same BEGIN IMMEDIATE transaction. For
fresh bootstrap, both migrations run before project_meta is inserted and
bootstrap inserts current version 2. Published stores must contain exactly one
valid identity row before upgrade.

Expected schema fingerprinting applies the complete ordered registry to an empty
reference database. Bootstrap, worker open, status, and integrity use the same
registry and reject missing, reordered, changed, partial, or future migrations.

### 18.2 Migration 0002 tables

0002-session-lifecycle adds:

session_authority:

- one row per project and session;
- identity, deterministic streamId, kind, immutable parent, namespace, semantic
  state, generation, independent child generation, capability verifiers and
  nonces, keyed continuity
  fingerprint, issuance audit identifiers, authority commitment, latest
  checkpoint position, checkpoint-required marker, and timestamps;
- a partial unique index for nonterminal root continuity namespaces;
- a foreign key from projectId and streamId to streams, with application and
  fold validation requiring streamId exactly session/{sessionId}; and
- constraints that root and child capability fields are structurally coherent.

Its primary key is projectId plus sessionId. A self-foreign-key binds a child to
its parent authority row. Root rows require null parent, keyed continuity
fingerprint, and complete root-handle and resume-token reconstruction fields and
verifiers. Child rows require a parent and have no root continuity or resume
material; child reconstruction fields and verifier exist if and only if
directAccessEnabled is true. Terminal event position and terminal event type are
either both null or both present. Verifiers and nonces use fixed-length lowercase
hexadecimal encoding.

The nonterminal-root unique index covers projectId, workspaceId,
clientNamespace, and keyed continuity fingerprint. Additional indexes cover
parent plus terminal position and the ordered safe-resume scope.

session_leases:

- one retained operational row per ownership generation;
- owner generation as fencing value, trusted client instance, acquired and
  renewed times, lastObservedAtMs, expiry, and release time;
- a foreign key to session_authority; and
- a partial unique index allowing one unreleased lease per session.

Its primary key is projectId, sessionId, and ownerGeneration. Expiry does not
delete history, append an event, or imply semantic terminal state.
last_observed_at_ms is INTEGER NOT NULL. Triggers and transaction checks require
every unreleased row to reference a nonterminal root authority row at exactly the
same current ownerGeneration.

session_evidence_coverage:

- one row per project, session, and adapter session;
- coverage-only mode, ordinal bounds, highest contiguous ordinal, canonical
  missing intervals, keyed fingerprints, fingerprint schema/key/domain, latest
  batch position, and timestamps;
- a transactional constraint path that rejects a batch before canonical missing
  intervals exceed 200; and
- no raw content or evidence reference columns.

session_evidence_fingerprints is an immutable child table keyed by project,
session, adapter session, and ordinal, with a unique frame ID. It stores source
kind, observedAt, batch ID, fixed fingerprint algorithm/schema/key/domain/value,
and recorded event position. This table is required to accept identical overlap
and reject contradictory overlap; aggregate intervals alone are not evidence of
ordinal consistency.

child_transfer_tickets stores immutable source assignment/scope/checkpoint/
follow-up/source-state/lineage plus creating event position and one nullable
all-or-nothing claim group. Claim is a single compare-and-swap; source lineage is
never rewritten.

lifecycle_validation_results is immutable and stores project/session/result/
workflow/generation/profile/version/configuration, persisted run and runner
identity, final checkpoint identity/fingerprint, versioned validation-start and
validation-completion source-state witnesses, project/workspace/branch/HEAD/
dirty assertions, times, status/exit classification/redacted summary, output
fingerprint algorithm/schema/key/domain/value, artifact references, freshness,
and recorded event position.

Migration 0002 extends workflow_instances with session and triggering-event
binding, expected authority commitment, coordinator owner/claim token/lease,
attempt/failure/safe-error/next-attempt fields, and a paired
validationAttemptPlanGeneration plus canonical deterministic
validationAttemptPlans JSON array. The array is written once for one workflow
generation before external execution, contains one unique plan for every
effective profile and at most 64 entries, and is immutable while that generation
is unchanged. Amendment or cancelled-workflow reopening increments generation
and atomically clears the pair before a new complete array may be written.
Insert and update guards keep claim, generation, plan, retry, and failure groups
coherent. A recovery index orders by triggering event position then workflow ID.

Migration 0002 also adds the exact indexes required to recover session-end
workflow instances and claim lifecycle outbox work in event-position order.
Lifecycle outbox rows persist origin kind, triggering event position,
materialization revision equal to that event position, nullable workflow ID and
generation as an all-null/all-present group, expected prior and next keyed
materialization fingerprints with algorithm, schema version, key ID, and domain,
claim owner/lease/fencing token, retryable or permanent failure classification,
safe error code, bounded attempt count, and nextAttemptAt. Immutable rows form
the planned-fingerprint history; an ordered index finds the latest revision for
one project, session, and artifact kind, and that target plus revision is unique.
An UPDATE trigger makes origin, target identity/path, triggering position,
revision, and planned fingerprint fields immutable; only the guarded
claim/status/attempt/failure/backoff acknowledgement groups may change. A
completed row retains the exact acknowledgement owner, token, revision, and
fingerprint required for completed-state replay; completion never erases that
tuple.

Migration 0002 extends command_dedup with nullable lifecycle_authorization_kind;
authorization_proof_version, authorization_proof_nonce, and
authorization_proof_digest; authorization_approval_id and
authorization_approval_digest; authorization_session_id and target_session_id;
server-derived presenting_actor_role, presenting_client_instance_id,
target_actor_role, and target_client_instance_id; and internal workflow ID,
generation, stable planned-work ID, claim owner, and claim token. The three proof
fields are null or all present, and the two approval fields are null or both
present. command_hash stores intentHash. Existing Version 1 rows keep every new
column null. Every Version 2 semantic command stores authorization kind and its
binding assertions. Initial authority has null proof/approval but retains both
server-derived audiences and the generated target session. Protected authority
requires proof or approval; abandonment may contain both. Internal workflow
commands have no bearer or approval and instead require the complete workflow-
generation/planned-work/live-claim authorization record. No proof MAC, raw
approval, or bearer secret is stored.

lifecycle_approval_consumptions stores one immutable row per approvalId and
nonce digest, with projectId, sessionId, action, commandId, target primary,
consumed event position, and consumedAt. Unique approvalId and nonce-digest
indexes prevent cross-command or cross-action reuse; an exact replay resolves
through command_dedup before the consumption check.

### 18.3 Explicit upgrade

Ordinary read, append, status, or MCP activity never upgrades a store.

An explicit maintenance operation:

- inspects and reports the migration plan by default;
- requires an apply flag to mutate;
- establishes the exact ProjectBinding and maintenance fence;
- drains active executors and requires their maintenance-fence acknowledgement;
- renews the same owner/epoch/token with a trusted host TTL before every mutable
  or post-commit publication boundary and threads the returned later-expiring
  lease into the next compare-and-swap;
- runs upgrade-specific prefix integrity: application ID, exact recorded-prefix
  names and checksums, project_meta.schema_version equal to the prefix version,
  prefix schema fingerprint, foreign keys, and event hash chain;
- applies missing migrations in one SQLite transaction;
- updates project_meta.schema_version in that same transaction;
- runs current-registry full integrity after commit, including the new schema
  fingerprint, foreign keys, event hash chain, and lifecycle constraints;
- records a new integrity result; and
- closes every SQLite connection and filesystem handle opened by the upgrade;
  session capabilities are unchanged.

Fence acquisition commits before waiting for executors. No long-lived
maintenance or write transaction spans a wait, filesystem operation, integrity
scan, or manifest write; integrity may still use its bounded BEGIN DEFERRED
snapshot so one report observes one database state.

Failure before SQLite commit leaves Version 1 unchanged. Failure after commit
leaves Version 2 durably applied; retry detects the current schema and
idempotently completes full verification, integrity-manifest recording, and
maintenance-fence recovery. A partial schema, checksum mismatch, or future
version fails closed. Failure to record the post-commit integrity result never
rolls back or misclassifies the committed schema. Production backup and restore
policy remains Subproject 5 because this operation cannot yet be used as a
primary cutover.

## 19. Worker and executor protocol

The strict worker protocol adds exact request and response variants for:

- root start and resume;
- explicit ownership recovery;
- root suspension;
- child fork;
- root or child checkpoint;
- evidence coverage batch;
- child report and disposition;
- child completion or suspension;
- authoritative session tree summary;
- lease renewal;
- session-end request, amendment, cancellation, and status;
- internal validation-result and event-appending workflow-phase mutations;
- workflow claim, renewal, release, eventless phase advancement, and recoverable
  scan; and
- lifecycle outbox claim, renewal, materialization including acknowledgement,
  and failure recording.

Every decoder rejects unknown fields, unsafe numbers, noncanonical decimal
positions, malformed identity, oversized payloads, and authority-bearing values
that belong to trusted context.

LifecycleCommandStore is the only semantic lifecycle transaction owner. It owns
one BEGIN IMMEDIATE and shares internal event-append primitives with EventStore.
Authority and lease checks, stream CAS, events, command dedup, workflow rows,
and outbox rows commit together. It must not call EventStore.append from inside
that transaction and must not expose arbitrary SQL or a caller-selected stream
version.

LifecycleOperationalStore is the only nonsemantic lifecycle transaction owner.
It binds to the same ActiveStore connection and owns one short BEGIN IMMEDIATE
for exact workflow claim/renew/release/eventless-phase work or outbox
claim/renew/materialize/failure work. Its focused transaction facade exposes no
event append, authority, validation, arbitrary SQL, or command_dedup. Row-state
compare-and-swap and the exact workflow/revision/owner/token work identity provide
idempotency. Uncertain commit reports that unchanged identity. Any workflow phase
that appends a lifecycle event instead uses an internal semantic command through
LifecycleCommandStore.

Issued bearer secrets never cross the worker protocol. For issuance or reissue,
the worker returns a private, strictly decoded AuthorityMaterialDescriptor
Version 1 containing capability kind, complete persisted nonsecret canonical
claims, stored verifier, verifier algorithm/version/key ID/domain, current
authority commitment, and authority event position. ProjectStoreExecutor gives
that descriptor to the trusted AuthorityMaterialAdapter. Only an adapter whose
authenticated local identity equals the descriptor target may use its external
CapabilityKeyProvider to reconstruct authority material, recompute the verifier,
constant-time compare it, and release it locally. When presenter and target
differ, the source adapter routes the nonsecret descriptor through the private
host broker to the attached target adapter and performs zero reconstruction
calls; this is mandatory for maintenance recovery and fork-to-child routing.
Unknown or missing descriptor fields fail closed. For authorization, worker requests contain only the
appropriate discriminated CapabilityProof, a signed lifecycle approval, or—for
fork only—a signed transport-private ChildBindingGrant alongside the current
root proof; no issued session handle or resume token crosses the boundary.

The lifecycle intentHash contains semantic input and stable authorization
assertions, never the CapabilityProof, proof nonce or digest, plaintext
capability, ephemeral ProjectBinding ID, or raw evidence. Exact dedup checks the
separately stored authorization proof nonce and digest after matching intentHash.

Mutation-unknown handling returns the original commandId and idempotencyKey.
The executor never generates a replacement retry identity and remains poisoned
after an uncertain posted mutation until the caller revalidates and opens a new
executor.

## 20. Version 2 request and response contracts

Every externally initiated semantic lifecycle mutation requires commandId and
idempotencyKey. Root mutations after start also require sessionId and a semantic-
command proof derived from the current-generation root handle. Internal lease
heartbeats use a bounded-operation proof plus generation compare-and-swap.
Protected reads use a bounded-operation proof. Workflow
claim/renew/release/eventless-phase/recovery and outbox
claim/renew/materialize/failure operations use workflow/revision/owner/token
fencing and deterministic work identities through a separate internal
operational executor path. None uses semantic command_dedup or appends a
lifecycle event, and none is accepted from an external lifecycle DTO.
Validation-result persistence and workflow phase actions that append events use
the internal semantic path and dedup-first replay rules. Outbox acknowledgement
has no standalone operation: it is private to materialize after current-target
byte and fingerprint reconciliation.

memory_sessionStart adds:

- agentId;
- continuityKey;
- new, exact, or latest-safe resumePolicy;
- expected project, vault, and workspace assertions; and
- for exact or latest-safe transfer, a transport-private semantic-command proof
  derived from the resume token by the trusted adapter.

Executor output is { publicResult, authorityMaterialStatus, authorityMaterial? }.
The canonical stored publicResult contains ProjectContext summary, sessionId,
ownerGeneration, continuityKey, state, resumedFromSessionId, latest checkpoint,
event position, handleIssued, resumeTokenIssued, and an explicit
contextPackUnavailable indicator until Subproject 3 supplies projection
integration. It contains no handle, token, proof, nonce, authority descriptor, or
dynamic authorityMaterialStatus. The executor derives authorityMaterialStatus as
reissued or stale against current authority on every delivery. authorityMaterial
contains the root handle and private resume token only when status is reissued
and trusted-adapter policy permits it; it is never persisted, logged,
snapshotted, or exposed to model-visible content. A client without that private
channel remains on the Version 1 compatibility path.

memory_contextPack and memory_selfCheck contracts may carry sessionId and a
transport-private bounded-operation proof, but their Version 2 retrieval
implementation remains Subproject 3. Subproject 2 defines association validation
only.

New lifecycle contracts are:

- memory_sessionTree;
- memory_recoverSession;
- memory_sessionFork;
- memory_checkpoint;
- memory_recordEvidenceBatch;
- memory_recordChildResult;
- memory_dispositionChildResult;
- memory_completeChildSession;
- memory_amendSessionEnd;
- memory_cancelSessionEnd; and
- memory_abandonSession.

They remain unregistered in the production MCP during this subproject.

## 21. Disabled and shadow compatibility

The disabled adapter is a pure pass-through that:

- returns Version 1 input and output unchanged;
- opens no Version 2 executor;
- appends no semantic event;
- mints no capability; and
- performs no heuristic routing.

The shadow compatibility mapper is also unregistered and always nonmutating.
Given one captured Version 1 intent and outcome plus a trusted test
ProjectBinding, it produces a bounded, redacted ShadowComparison DTO with
executable fixed to false. The DTO contains hashes and safe summaries only, with
no raw Version 1 sensitive payload, capability, commandId, or idempotencyKey. It
never produces an executable Version 2 command, executes work, or appends a
semantic event.

It may report how a missing Version 1 session identity would be associated only
when exactly one eligible Version 2 root exists in the same project and
workspace. Zero or multiple candidates produce a diagnostic divergence. No
candidate count permits this phase's mapper to mint authority or mutate state.

Because Version 1 remains authoritative, shadow evidence cannot claim that
ownership inversion is fixed. The mapper labels:

- Version 1 supersession behavior;
- Version 2 root selection and authority outcome;
- invariant parity or intentional divergence;
- exact identity and event positions; and
- any unsupported evidence-retention gap.

Actual mode configuration, live interception, dual execution, parity storage,
operator controls, and cutover belong to Subproject 5.

## 22. Typed failures

Every failure includes a stable code, safe message, project and session
assertions when available, retryability, and bounded recovery actions.

This phase must implement at least:

- PROJECT_BINDING_REQUIRED;
- PROJECT_ID_MISMATCH;
- VAULT_ID_MISMATCH;
- WORKSPACE_AMBIGUOUS;
- STORE_UNAVAILABLE;
- SQLITE_CAPABILITY_MISSING;
- EVENT_CONFLICT;
- IDEMPOTENCY_CONFLICT;
- COMMAND_OUTCOME_UNKNOWN;
- OPERATION_OUTCOME_UNKNOWN;
- SESSION_NOT_FOUND;
- SESSION_AMBIGUOUS;
- SESSION_ALREADY_OWNED;
- SESSION_HANDLE_STALE;
- SESSION_OWNERSHIP_MISMATCH;
- CONTINUITY_CONFLICT;
- SESSION_STATE_CONFLICT;
- SESSION_CHILDREN_ACTIVE;
- SESSION_END_INCOMPLETE;
- SESSION_CAPABILITY_INVALID;
- SESSION_CAPABILITY_KEY_UNAVAILABLE;
- SESSION_CAPABILITY_EXPIRED;
- SESSION_RECOVERY_APPROVAL_REQUIRED;
- LIFECYCLE_APPROVAL_INVALID;
- LIFECYCLE_APPROVAL_EXPIRED;
- LIFECYCLE_APPROVAL_REPLAYED;
- SESSION_SOURCE_STATE_CONFLICT;
- SESSION_VALIDATION_RESULT_INVALID;
- CHECKPOINT_BASE_INVALID;
- EVIDENCE_CAPTURE_INCOMPLETE;
- EVIDENCE_COVERAGE_TOO_FRAGMENTED;
- MATERIALIZATION_CONFLICT;
- SCHEMA_UPGRADE_REQUIRED;
- SCHEMA_TOO_NEW;
- MIGRATION_CHECKSUM_MISMATCH;
- SCHEMA_FINGERPRINT_MISMATCH; and
- INTEGRITY_FAILURE.

Identity, capability, approval, migration, and integrity failures fail closed.
Failures never include handles, resume tokens, raw approvals, key identifiers
that aid guessing, raw evidence, environment values, or process command lines.

## 23. Security requirements

- Root authority requires both trusted primary ProjectBinding and a verified
  command proof derived from the current root handle.
- A child handle is scoped to one child session and an allowlisted action set;
  only its command-bound proof crosses the worker boundary.
- Maintenance authority cannot manufacture semantic success.
- All SQL is prepared and executed inside the isolated worker.
- Capability, keyed-fingerprint, and idempotency comparisons are constant-time
  where secret material is involved.
- Secret values are represented by redacted wrapper types whose serialization
  throws in development and emits no value in production.
- worker requests and responses, command_dedup, event payloads, outbox payloads,
  logs, test snapshots, and error envelopes contain no issued handle or token;
  live requests may contain the appropriate CapabilityProof and a fork may
  contain its transport-private ChildBindingGrant; live issuance responses may
  contain a nonsecret AuthorityMaterialDescriptor. A recovery or abandonment
  request may contain its signed private approval. No raw proof, grant,
  descriptor, or approval may be persisted in the project store, logs,
  snapshots, or fixtures. The only raw authorization persistence is the encrypted
  trusted-adapter pending-command record required for an exact semantic retry,
  deleted on terminal response.
- Coverage batches contain keyed fingerprints and ordinals only.
- Project-relative paths are containment checked before checkpoint or
  materialization use.
- Ordinary model-controlled inputs cannot select ProjectBinding, presenting or
  target actor role/clientInstanceId, Clock, KeyProvider, validation commands,
  mode, child-binding grant, or recovery/abandonment approval.

## 24. Testing strategy

### 24.1 Test-driven sequence

Every implementation slice begins with a failing test for its public contract or
invariant. Production code follows only after the failure is observed. Each
slice runs its focused test, the relevant neighboring tests, then the complete
regression suite.

### 24.2 Unit and contract tests

Tests cover:

- every root and child state transition and invalid transition;
- strict input and worker-wire decoding;
- capability issue, deterministic reissue, rotation, revocation, command-bound
  proof verification, nonce/command/generation replay rejection, malformed
  input, and constant-time verifier comparison;
- semantic-command versus bounded-operation proof target separation, rotating-
  command dedup-before-current-authority replay, descriptor tamper rejection,
  and crash-durable retry identity;
- candidate versus authoritative intentHash mismatch, presenting/target audience
  mismatch, portable resume-token proof binding, approval expiry and single-use,
  approval action separation, and maintenance-to-primary private routing;
- authority-commitment coverage for every reconstruction, audience, continuity,
  revocation, and terminal field;
- continuity-key namespacing;
- safe-resume filtering and ambiguity;
- checkpoint validation, bounds, path containment, and redaction;
- coverage batch overlap, gaps, contradiction, interval-fragmentation bound,
  canonical fingerprint inputs, and exact retry;
- child report disposition and immutable transfer lineage;
- root-only current-generation lease triggers, clock clamping, renewal/takeover
  ordering, and bounded-operation heartbeat proofs;
- session-end phases, failed-verification branch, source-state race detection,
  self-write exclusion scope, amendment generation fencing, cancel/reopen/end,
  cancellation/abandonment rewrite, and terminal protection;
- deterministic Markdown bytes and path;
- typed error privacy; and
- disabled adapter byte compatibility with Version 1.

### 24.3 Migration and integrity tests

Tests prove:

- a new store applies 0001 then 0002 exactly once;
- an existing valid 0001 store upgrades without changing prior events, hashes,
  command responses, identity, or manifest format;
- a Version 1 prefix-integrity precheck succeeds while ordinary current-binary
  worker open returns SCHEMA_UPGRADE_REQUIRED;
- project_meta.schema_version advances atomically from 1 to 2 while manifest
  schemaVersion remains document format 1;
- two explicit upgraders race and exactly one applies 0002;
- active executors drain and acknowledge the maintenance fence before DDL;
- an old binary opening Version 2 returns SCHEMA_TOO_NEW with zero writes;
- migration checksum drift, order drift, partial DDL, future versions, trigger
  loss, index loss, and added hostile schema objects fail closed;
- rollback on injected pre-commit migration failure leaves no 0002 object;
- crash after commit but before post-verification or fence release resumes
  idempotently, and integrity-manifest recording failure neither rolls back nor
  misclassifies the committed schema;
- quick and full integrity verify lifecycle constraints and invariant-index
  agreement; and
- database handles close on success and every failure.

### 24.4 Cross-process ownership tests

A real process fixture runs:

- one trusted primary root;
- 32 child sessions;
- multiple unrelated roots in the same project;
- a second project with identical continuity keys and session-like payloads; and
- linked worktrees sharing project storage but retaining workspace identity.

It proves:

- no child start, report, completion proposal, crash, or reconnect changes root
  authority;
- no unrelated root is superseded or ended;
- only a proof derived from the root's current primary handle can end it;
- recovery executed by maintenance binds and routes replacement authority only
  to the approval's authenticated target primary;
- project and workspace isolation remain exact; and
- final root materialization includes accepted child results and unresolved
  carry-forward work only.

### 24.5 Concurrency and lost-response tests

Tests prove:

- two simultaneous new starts with one continuity namespace yield one root and
  one deterministic conflict or deduplicated replay;
- simultaneous resumes yield exactly one owner-generation winner;
- every old-generation handle and token is rejected;
- after a resume rotates G to G+1 and its response is lost, exact dedup checks
  the persisted G proof tuple before current authority, returns the one stored
  effect, and reissues G+1 material only while G+1 remains current; after G+2 it
  returns the same public effect with stale status and no authority material;
- lost responses for semantic start, resume, suspension, ownership recovery,
  fork, child-assignment amendment, checkpoint, evidence batch, child report,
  disposition, completion, transfer creation and claim, end request,
  internal event-appending workflow phases, validation-result persistence,
  amendment, cancellation, and abandonment produce one semantic effect;
- an internal committed command replays by stable planned-work identity after its
  original claim expires or is taken over, without entering its fresh callback;
- eventless workflow and outbox claim, renewal, and failure replay by
  deterministic workflow/target/revision/owner/token work identity and never use
  semantic command_dedup or event append;
- a lost materialize response retries the complete byte-reconciling
  replace-and-ack operation; after acknowledgement commit and lease expiry, exact
  completed-state replay verifies the retained tuple/current latest bytes before
  returning the stored result, while an expired unacknowledged row requires
  takeover; no standalone acknowledgement path exists;
- stale workflow, capability, or lease generations and stale outbox revisions
  produce zero new effect for their attempted phase;
- after a lower revision replaces the artifact and crashes before
  acknowledgement, a newer rewrite safely replaces those committed stale
  deterministic bytes using immutable planned-fingerprint history;
- failed validation never reaches SessionEnded and coverage-only evidence never
  satisfies requireFullEvidence; and
- retry uses the original command identity.

### 24.6 Fault injection

Fault injection covers every valid crash point at these durable boundaries:

- authority insert or compare-and-swap;
- event append;
- lease update;
- workflow creation and phase update;
- final checkpoint;
- validation-result persistence and final source-state recheck;
- outbox insert;
- outbox claim;
- temporary-file write;
- atomic replacement;
- keyed materialization-fingerprint acknowledgement;
- retryable and permanent outbox failure recording;
- suspension, transfer creation/claim, explicit recovery, generation fencing,
  cancellation rewrite, and abandonment rewrite;
- verification event;
- SessionEnded append; and
- response delivery.

Atomic replacement and keyed acknowledgement are separate injectable boundaries
inside one materialize operation; the latter is not a standalone protocol call.

SQLite transaction boundaries expose before-write, after-write-before-commit,
and after-commit-before-response points. External validation exposes before-run
and after-run-before-result-commit. File staging exposes before-temp-write and
after-temp-fsync-before-replace. Atomic replacement exposes
after-replace-before-ack. Response delivery exposes only
after-commit-before-response. Tests never manufacture an invalid Cartesian
boundary/point pair.

Pre-commit SQLite death leaves zero new effect for that phase; committed response
loss replays no duplicate. A staged temporary file changes no authoritative
database state. Replacement-before-ack retry recognizes the immutable planned
fingerprint. Earlier committed saga phases remain durable. Restart recovers the
same workflow, runs quick and full integrity plus handle/rename checks for every
case, and never closes a different session.

Tests use process barriers and injectable faults, not timing sleeps.

### 24.7 Secret and evidence tests

Automated scans assert that database text columns, event payloads, dedup
responses, outbox payloads, Markdown artifacts, logs, errors, serialized worker
messages, snapshots, and retained fixtures do not contain issued handles, resume
tokens, project keys, raw fixture evidence, or secret environment values. Live
worker requests may contain only the appropriate CapabilityProof plus a
fork-only transport-private ChildBindingGrant, and live issuance responses only
the nonsecret AuthorityMaterialDescriptor; tests discard them immediately.
Credential-store tests prove pending semantic proofs, grants, and
signed approvals are encrypted at rest, survive a simulated adapter crash, and
are deleted after a terminal response.

Coverage-only responses and checkpoints must not claim raw-evidence retention
and must fail every requireFullEvidence gate.

## 25. Verification gates

Subproject 2 exits only when all of these pass:

1. Runtime capability check on Node.js 24.16.0 or newer with runtime SQLite
   3.51.3 or newer.
2. Typecheck and complete existing regression suite.
3. New lifecycle unit, migration, contract, cross-process, and fault suites.
4. One primary plus 32 children without an incorrect root transition.
5. Zero duplicate or lost committed lifecycle effects under retry and crash.
6. Exactly one concurrent resume winner with stale-handle rejection.
7. Deterministic session-log materialization and fenced retry.
8. Quick and full store integrity after every recovery corpus.
9. No capability, key, secret, or raw evidence leakage.
10. V1 production MCP isolation remains byte-compatible and src/app.ts and
    src/index.ts remain free of Version 2 lifecycle wiring.
11. Primary mode remains disabled.
12. Independent specification, implementation, and security review findings are
    resolved.
13. memory_verifyVault passes and the primary agent closes exactly one
    project-memory lifecycle.

The original ownership-inversion reproduction must fail by construction against
the Version 2 processor: a child has no root capability, a new root has a
different session identity, and no start command contains a supersede-current
operation.

## 26. Delivery components for the implementation plan

The later implementation plan will decompose work in this order:

1. Lifecycle contracts, aggregate fold, state transitions, and typed failures.
2. Ordered migration registry and 0002 lifecycle schema.
3. CapabilityKeyProvider, AuthorityMaterialAdapter, private retry store, proof
   targets, verification, reissue, and rotation.
4. Root start, safe resume, lease, and explicit recovery commands.
5. Child fork, report, disposition, completion, suspension, and transfer.
6. Versioned checkpoints and coverage-only evidence batches.
7. Worker protocol and executor lifecycle operations.
8. Durable session-end coordinator and recovery.
9. Fenced compatibility-log outbox materializer.
10. Disabled and pure shadow-compatibility adapters.
11. Cross-process, lost-response, fault-injection, security, and release gates.

The implementation plan must preserve small focused modules. It must not place
the aggregate, authority repository, capability logic, end coordinator, and
materializer into one service.

## 27. Dependencies on later subprojects

Subproject 3 will add deterministic session and retrieval projections,
consistency barriers, context-pack retrieval, scope filtering, explanations, and
the bilingual evaluation harness.

Subproject 4 will add encrypted raw evidence, evidence key management, privacy
and erasure workflows, promotion, conflict lifecycle, retention, provider
consent, and explicit global scope. It will upgrade coverage-only capture to an
encrypted evidence schema without treating old keyed fingerprints as retained
evidence.

Subproject 5 will add legacy import, actual off/shadow/primary configuration,
live dual execution, parity reports, compatibility materialization monitoring,
backup and restore, replay, rollback fencing, runbooks, and explicit production
cutover.

No result from Subproject 2 alone may be described as production-ready MCP
memory. Production readiness requires all umbrella cutover gates and explicit
user approval of the final parity report.

## 28. Resolved questions

This specification intentionally leaves no implementation-changing question
open:

- Child authority is untrusted binding plus a child capability.
- Semantic events plus transactional invariant indexes are authoritative.
- Evidence is coverage-only and contains no plaintext in this phase.
- Production MCP routing remains off and untouched.
- The Version 2 processor, not Version 1, owns this phase's inversion exit gate.
- schema_migrations is the immutable migration history,
  project_meta.schema_version is the matching current database version, and
  manifest schemaVersion remains document format 1.
- Capability secrets are reissued after command dedup and are never stored in
  command responses.
- Recovery approvals are signed, command-bound, audience-bound, expiring, and
  single-use; maintenance execution never makes maintenance the authority
  recipient.
- Lease expiry enables an authorized ownership attempt but never changes
  semantic session state by itself.

Any requested change to these decisions requires written-spec amendment and
review before implementation planning.
