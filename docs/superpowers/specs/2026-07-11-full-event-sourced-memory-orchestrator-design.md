# Full Event-Sourced Project Memory Orchestrator

Status: Approved architecture design
Date: 2026-07-11
Runtime floor: Node.js 24.16.0 or newer within the supported Node.js 24 LTS line, with runtime SQLite 3.51.3 or newer
Projection-integrity runtime amendment: docs/superpowers/specs/2026-08-23-node-24-projection-integrity-runtime-amendment.md
Current decision record: memory/04_Architecture_Decisions/adopt-a-strictly-isolated-full-event-sourced-project-memory-orchestrator-2.md
Historical decision record: memory/04_Architecture_Decisions/adopt-a-strictly-isolated-full-event-sourced-project-memory-orchestrator.md (its Node.js 22.13 runtime clause is superseded)
Runtime safety decision: memory/04_Architecture_Decisions/require-a-wal-safe-sqlite-runtime-for-the-event-sourced-memory-store.md

## 1. Decision summary

The project-memory MCP will evolve from a Markdown-first service with one process-global active lifecycle into a full event-sourced orchestrator with these invariants:

1. Every memory-bearing operation is resolved to exactly one project before any read or write.
2. Each project has a physically isolated local event store and derived projection store.
3. Worktrees of the same Git repository share the project store but keep distinct workspace and branch scopes.
4. Root lifecycle ownership belongs to the primary agent. Sub-agents cannot start, supersede, or end the root lifecycle.
5. Every durable change is an immutable, idempotent, attributable event.
6. Raw visible conversation evidence and sub-agent reports are retained locally, secret-redacted, and encrypted.
7. Canonical memory is derived from evidence through explicit promotion, verification, correction, retraction, and temporal validity.
8. Retrieval applies project and visibility filters before ranking, combines multiple retrieval channels, and returns provenance for every result.
9. Cross-project retrieval is denied by default. A separate global store receives only explicitly promoted memories and is read only when includeGlobal is true.
10. Migration is non-destructive and reversible through off, shadow, and primary modes.

This is an umbrella architecture. Delivery is split into independently testable subprojects in section 22; each subproject receives its own implementation plan and review gate.

## 2. Problem statement and evidence

The current lifecycle state contains one activeSession field for the entire vault:

- src/services/memory-lifecycle.service.ts:44-48 defines a single activeSession.
- src/services/memory-lifecycle.service.ts:94-118 archives that session as superseded whenever another memory_sessionStart occurs.
- src/services/memory-lifecycle.service.ts:162-181 ends whichever session is active, without a caller-supplied session identifier.
- src/schemas/memory.ts:202-242 exposes no projectId, workspaceId, sessionId, parentSessionId, continuityKey, clientId, or idempotencyKey for lifecycle commands.

The resulting failure is systemic:

1. The primary agent starts root session A.
2. A sub-agent follows the same task-start rule and starts session B.
3. B supersedes A.
4. The primary agent calls memory_sessionEnd.
5. The service closes B with the primary agent's outcomes while A remains merely superseded.

No note must be physically lost for the lifecycle record to become inaccurate. The existing tests can all pass while this ownership inversion remains possible because the model assumes only one caller.

The current retrieval system has valuable Markdown notes, metadata, lexical search, hybrid embeddings, and lifecycle gates, but it does not have a single immutable source of truth for:

- concurrent sessions and their ownership;
- exact project and worktree scope;
- command idempotency;
- temporal fact validity and contradictions;
- evidence-to-canonical-memory lineage;
- deterministic replay after a crash;
- explainable multi-stage retrieval;
- non-destructive correction and forgetting.

The currently installed MCP SDK cannot be treated as the durable identity boundary. Transport metadata can be absent, and stdio does not provide a stable logical task identity. The new protocol therefore carries explicit domain identity and capability-bound session handles.

The pre-change baseline is 406 passing tests plus a passing TypeScript typecheck. This design treats that suite as a regression floor, not as evidence that the concurrency defect is absent.

## 3. Goals

### 3.1 Correctness goals

- Zero memory results from the wrong project.
- Zero cases where a child or unrelated caller ends or supersedes a root session.
- Exactly-once observable command effects under retries.
- Deterministic projection state after replaying the same event sequence.
- Correct continuation of unfinished work across IDE, agent, and process restarts.
- Explicit conflicts instead of silent last-write-wins behavior.
- Verifiable provenance from every returned memory to source events and evidence.
- Crash recovery without treating an uncommitted operation as complete.

### 3.2 Retrieval goals

- Preserve exact identifiers, paths, decisions, follow-ups, and recent task state.
- Prefer verified current canonical memory over stale, provisional, or raw evidence.
- Support Thai, English, mixed-language text, code identifiers, file paths, and structured metadata.
- Explain why each item was selected and which scope filters were applied.
- Support local embeddings and reranking by default, with per-project opt-in external providers.

### 3.3 Operational goals

- Run unflagged on Node.js 24.16.0 or newer and fail closed unless runtime SQLite is 3.51.3 or newer.
- Enforce the Node.js 24.16.0 floor through package metadata, startup probes, authoritative-store bootstrap, build targets, and CI rather than relying on a declaration alone.
- Permit multiple MCP server processes to use the same project safely.
- Keep legacy Markdown memory available throughout migration and rollback.
- Detect identity mismatch, corruption, projection lag, broken lineage, and incomplete session closure.

## 4. Non-goals

The first event-sourced release will not:

- synchronize divergent stores across machines or independently cloned repositories;
- infer or automatically promote global memory;
- share raw evidence across projects;
- store hidden model reasoning or chain-of-thought;
- replace Git as the source of truth for source code;
- make a local administrator unable to inspect or replace local files;
- train a learned reranker;
- delete legacy Markdown during migration;
- provide a remote distributed event database.

Visible user and assistant messages, tool calls, tool results, sub-agent reports, and referenced artifacts are eligible raw evidence. Hidden reasoning is neither requested nor stored.

## 5. Architecture overview

~~~mermaid
flowchart LR
    C["MCP clients and IDE adapters"] --> I["Project identity gate"]
    I --> O["Command and lifecycle orchestrator"]
    O --> E["Per-project immutable event store"]
    O --> B["Encrypted evidence blobs"]
    E --> P["Deterministic projectors"]
    P --> S["Session and checkpoint projection"]
    P --> K["Canonical knowledge projection"]
    P --> T["Task, artifact, and temporal projections"]
    P --> G["Entity graph projection"]
    P --> R["Lexical and vector retrieval projections"]
    S --> Q["Retrieval orchestrator"]
    K --> Q
    T --> Q
    G --> Q
    R --> Q
    Q --> X["Context pack with citations and explanation"]
    O --> M["Legacy Markdown materializer and outbox"]
    K -->|explicit promotion only| Z["Physically separate global store"]
    Z -->|includeGlobal=true only| Q
~~~

The event store is authoritative. Markdown notes and every query-oriented table are materialized views. A projection can be deleted and rebuilt without losing durable memory.

## 6. Project identity and physical isolation

### 6.1 Identity hierarchy

The resolver produces this hierarchy before opening a content-bearing store:

| Identity | Purpose | Stability |
| --- | --- | --- |
| projectId | Stable logical project UUID | Shared by normal checkout and linked worktrees |
| vaultId | Stable UUID for the memory vault belonging to the project | Stable unless an explicit vault migration occurs |
| storeId | UUID of the physical event-store instance | Local to one repository clone or non-Git vault |
| workspaceId | Stable identity for one checkout or linked worktree | Distinct for each worktree |
| branchScopeId | UUID for one recorded Git ref lineage | Preserved through recorded rename; not inferred from name reuse |
| branchRef | Branch name or detached commit at event time | Changes as Git state changes |
| sessionId | One root or child work stream | Unique and immutable |
| continuityKey | Stable client/task key used for safe resume | Stable across process or IDE restarts |
| agentId | Logical primary or child agent identity | Scoped to a session |
| clientInstanceId | Attribution for one IDE/MCP client process; not an authority claim | Regenerated per client process |
| projectBindingId | Transport-private binding between one MCP connection and its intended project | Valid for the connection or explicit rebind generation |

The project descriptor is memory/.memory-mcp/project-identity.json and contains only versioned identity metadata:

~~~json
{
  "schemaVersion": 1,
  "projectId": "uuid",
  "vaultId": "uuid",
  "createdAt": "RFC3339 timestamp"
}
~~~

The descriptor is intended to be versioned with the project so linked worktrees resolve the same projectId and vaultId.

### 6.2 Canonical local store location

For Git projects, the canonical store directory is:

    <git-common-dir>/project-memory/<projectId>/v2/

git rev-parse --git-common-dir resolves to the same directory for all linked worktrees, so they share one event stream without relying on a mutable global path registry.

For non-Git projects, the store directory is:

    <vaultRoot>/.memory-mcp/v2/

The directory contains:

- events.sqlite — authoritative events, encrypted evidence, idempotency records, outbox, and operational leases;
- projections-{generation}.sqlite plus a small current-projection manifest — disposable query projections and offsets without replacing an open Windows file;
- backups/ — verified snapshots and signed or hashed manifests;
- store-manifest.json — storeId, projectId, vaultId, schema version, and last integrity result.

An independently cloned repository has a different Git common directory. If it contains an existing project descriptor but no registered local store, ordinary tools fail with PROJECT_REPLICA_DECISION_REQUIRED. The user must explicitly choose one of:

- initialize a separate local replica with the same projectId and a new storeId, accepting that automatic convergence is unavailable;
- attach or import an existing replica through a provenance-preserving migration;
- fork as a new project, which writes a new projectId and vaultId through a reviewed identity event.

The system never silently decides that a copied or cloned descriptor represents either the same project or a new one. Automatic multi-clone convergence is deferred.

### 6.3 Identity gate

Before any content-bearing tool is enabled, the MCP host establishes a ProjectBinding outside model-controlled tool arguments. For stdio this comes from an explicit configured project root. For a multi-connection host it comes from the trusted IDE adapter or MCP roots handshake plus an explicit selected root. A binding contains projectBindingId, projectId, vaultId, workspaceId, clientNamespace, binding generation, and canonical paths.

Heuristic discovery may return diagnostic candidates through memory_projectStatus, but it cannot authorize a content read or write. If the host cannot bind exactly one intended project, all content-bearing tools fail with PROJECT_BINDING_REQUIRED. Changing the active IDE project requires a new binding generation; an existing connection never follows a newly focused folder silently.

Before every content-bearing operation, the server:

1. loads the transport-private ProjectBinding;
2. resolves and canonicalizes the bound workspace and vault real paths again;
3. reads the project descriptor;
4. resolves Git common directory, worktree identity, branch, and HEAD when available;
5. derives workspaceId from projectId plus canonical worktree identity;
6. opens only the store named by the binding;
7. compares binding, descriptor, and project_meta projectId and vaultId values;
8. rejects the operation if any identity is missing, ambiguous, stale, or mismatched.

Inputs may include expectedProjectId, expectedVaultId, or expectedWorkspaceId as defense-in-depth assertions. They never create authority, select a candidate, or override the transport binding.

The event database must not use SQLite ATTACH to query another project's database. A process may hold separate connections for separate projects, but every connection context and command object is permanently bound to exactly one resolved ProjectContext.

Version 2 identity is never created as a side effect of an ordinary read or write. A project without a descriptor must use the explicit, warn-then-run bootstrap or migration command. Shadow mode may diagnose a missing descriptor, but it cannot invent an identity and begin recording semantic events silently.

### 6.4 Worktree and branch visibility

All linked worktrees share stable project memory. Events also record workspaceId, branchScopeId, branchRef, and source commit or dirty-state anchors.

New knowledge begins in the narrowest valid visibility:

- session — transient task-specific context;
- workspace — facts about uncommitted files or one worktree;
- branch — facts and decisions valid on a branch;
- project — verified stable knowledge for all worktrees;
- global — explicitly promoted knowledge in the separate global store.

A query context is eligible to see an item only when projectId matches and one of these predicates is true:

- project scope — always eligible inside the bound project, subject to temporal and status filters;
- branch scope — candidate.branchScopeId equals query.branchScopeId;
- workspace scope — candidate.workspaceId equals query.workspaceId;
- session scope — candidate.sessionId equals query.sessionId;
- global scope — the separate global predicate in section 6.5 passes.

branchScopeId is a stored UUID associated with a Git ref lineage, not a hash of the mutable branch name. A recorded branch rename preserves the scope ID. Reusing a deleted branch name creates a new scope unless an explicit lineage attachment proves continuity. Two worktrees on the same branch scope may read branch-scoped knowledge; workspace-scoped knowledge remains local to its originating worktree. A detached HEAD receives a commit-specific scope and shares only with the same detached commit unless explicitly attached.

Visibility does not prove freshness. Rebase, revert, merge, branch movement, or a changed source hash can mark an otherwise visible item stale or conflicted. Workspace or branch knowledge is not silently promoted after a Git merge. A merge detector may propose promotion, but a primary agent or user must confirm the resulting WorkspaceKnowledgePromoted or BranchKnowledgePromoted event.

### 6.5 Global memory

Global memory is a separate physical store under the user's application-data directory. It accepts only explicit promotion commands containing distilled content, provenance, an audience, and the source project's promotion event hash. Raw evidence and session handles are never copied.

An audience is either all-projects or an explicit allowlist of target projectIds. Retrieval requires all of:

1. includeGlobal=true;
2. a valid ProjectBinding for the target project;
3. target projectId satisfies the item's audience;
4. the global item is active, acknowledged, temporally eligible, and not pending correction or revocation.

Promotion, correction, expiry, and revocation use an idempotent cross-store saga because SQLite cannot transact across physically separate stores. New promotions are written pending in the global store and become visible only after the source promotion event and acknowledgement are durable. Revocation and privacy erasure first disable the global item, then append the source acknowledgement, so a partial failure prefers temporary absence over stale or unauthorized disclosure. The saga has durable phase state, derived idempotency keys, retry, compensation, and integrity diagnostics.

Retrieval defaults to includeGlobal=false. When enabled, local project results are retrieved first. Eligible global results are fetched through a separate reader, labeled scope=global, deduplicated, and ranked below equally verified project-local results. Source correction, retraction, expiry, or evidence erasure must revoke or replace every dependent global promotion before the source operation reports completion.

## 7. Runtime and SQLite contract

Node.js 24.16.0 or newer within the supported Node.js 24 LTS line is the minimum. The former Node.js 22.22.3 floor supplied unflagged `node:sqlite` and SQLite 3.51.3, but it has no portable API for inspecting the exact descriptor-pinned byte image of a projection generation. Reopening a private scratch copy by pathname allowed a same-user A→B→A substitution between identity checks and SQLite open. Node.js 24.16.0 supplies `DatabaseSync.deserialize()`, so the verifier can inspect an isolated in-memory database created from bytes read and hash-verified through the pinned source descriptor. All new authoritative-store API use sits behind a SqliteDriver interface or a startup capability probe; the pre-existing optional Zed workspace-diagnostic shim remains non-authorizing and is not reused by the event store.

The runtime gate checks both `process.versions.node` and `SELECT sqlite_version()`. Production multi-process WAL mode fails closed unless Node.js is 24.16.0 or newer, `node:sqlite` can be loaded, SQLite is 3.51.3 or newer, and functional WAL, FTS5, transaction rollback, in-memory deserialization, defensive, and query-only probes pass. The minimum-version check runs before authoritative-store bootstrap loads SQLite. A semver declaration alone is insufficient because `node:sqlite` may be disabled and future runtime packaging can change the bundled SQLite engine.

The driver must prove support for:

- DatabaseSync and `DatabaseSync.deserialize()` into an isolated in-memory database;
- SQLite 3.51.3 or newer at runtime;
- prepared statements and bound parameters;
- required PRAGMAs;
- transactions with BEGIN IMMEDIATE, COMMIT, and ROLLBACK;
- functional FTS5 create, insert, and query behavior for lexical projections, or a tested local fallback;
- confirmed WAL activation rather than requested-WAL configuration alone;
- defensive mode and `PRAGMA query_only=ON` on deserialized projection inspection databases;
- consistent backup through either the runtime backup API or the quiesced snapshot path.

Each writer connection applies and verifies:

~~~sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;
~~~

busy_timeout is configurable, but five seconds is the initial default. Unsupported hardening options are reported by the capability probe rather than silently assumed.

Each process owns its connection. SQLite coordinates cross-process writers. All event appends use short BEGIN IMMEDIATE transactions, prepared statements, optimistic stream versions, and retry with bounded jitter only for retryable busy errors.

Production controllers do not run DatabaseSync work on the MCP event-loop thread. A ProjectStoreExecutor owns a dedicated worker thread and bounded command queue per active project, serializes that process's writes, and returns structured results to the asynchronous controller. Idle executors close cleanly. Maintenance replay and projection rebuild use separate workers, while SQLite WAL and optimistic versions remain the authority across processes.

## 8. Authoritative event store

### 8.1 Source tables

events.sqlite contains:

| Table | Responsibility |
| --- | --- |
| project_meta | Immutable projectId, vaultId, storeId, schema version, creation metadata |
| streams | Stream identity, type, and current optimistic version |
| events | Ordered immutable event envelopes and payloads |
| evidence_blobs | Encrypted visible-message, tool, artifact, and child-report evidence |
| command_dedup | Required idempotency key, command hash/type, state, committed event range, and canonical public response |
| workflow_instances | Durable multi-phase saga state, current phase, generation, and terminal result |
| outbox | At-least-once side effects with deterministic target key, claim lease, fencing token, content hash, and status |
| session_authority | Owner generation, binding, continuity guard, handle/resume-token hashes, and terminal guard |
| session_leases | Mutable operational liveness only; never canonical session truth |
| maintenance_state | Fenced quiescing epoch and acknowledgements for backup or migration |
| schema_migrations | Applied database migration checksums |

The generation selected by the current-projection manifest contains derived tables and projection_offsets. No row in any projection database is authoritative.

### 8.2 Event envelope

Every event contains:

- globalPosition — monotonically increasing database position;
- eventId — globally unique UUID;
- projectId, vaultId, storeId, workspaceId, branchScopeId, and branchRef;
- streamId, streamType, and streamVersion;
- eventType and eventSchemaVersion;
- sessionId and optional parentSessionId;
- trusted actorRole from the adapter binding plus attributed agentId and clientInstanceId;
- correlationId and optional causationId;
- commandId, idempotencyKey, and zero-based commandEventIndex;
- occurredAt supplied by the domain and recordedAt assigned by the store;
- visibilityScope;
- confidence and verificationStatus;
- sourceRefs and evidenceRefs;
- canonical JSON payload;
- payloadHash, previousGlobalHash, and eventHash.

The database enforces:

- UNIQUE eventId;
- UNIQUE projectId plus streamId plus streamVersion;
- UNIQUE projectId plus commandId plus commandEventIndex;
- UNIQUE projectId plus idempotencyKey in command_dedup, not events;
- foreign keys from evidence and outbox records;
- project identity equality with project_meta;
- non-empty event type, schema version, recorded time, and hashes.

eventHash is SHA-256 over a versioned canonical serialization of the immutable envelope, payloadHash, evidence ciphertext hashes, keyed content fingerprints, and previousGlobalHash. An evidence fingerprint is HMAC-SHA-256 over redacted plaintext using a project fingerprint key; a raw plaintext hash is never stored because it can enable dictionary attacks against short content. The chain is tamper-evident, not tamper-proof against a local administrator who can rewrite the full database. Verified backup manifests can be signed by a project integrity key to make unauthorized historical replacement detectable across snapshots.

Every mutating command requires commandId and a client-persisted, globally unique idempotencyKey minted before the first send. commandType is part of commandHash. Reusing a key for another command type or payload is always IDEMPOTENCY_CONFLICT. Strict primary mode never derives a key from a transient MCP request ID. Idempotency is enforced once per command in command_dedup so one atomic command may append multiple events; each event carries commandEventIndex and events enforces uniqueness of projectId plus commandId plus commandEventIndex. events.idempotencyKey remains indexed for audit and lineage but is not unique.

### 8.3 Immutability and correction

SQLite triggers reject UPDATE and DELETE on events. Historical facts are changed only by appending events such as:

- FactCorrected;
- FactSuperseded;
- FactRetracted;
- FactExpired;
- DecisionSuperseded;
- SourceInvalidated;
- EvidenceErased.

Event schemas are versioned. Readers use pure upcasters to convert older payloads into the current in-memory form. Upcasting never rewrites historical event rows.

Privacy erasure is the only intentional mutation of evidence_blobs. The erasure transaction removes ciphertext and wrapped keys, records an immutable tombstone hash and reason, and appends EvidenceErased. Source event hashes and provenance remain so replay can distinguish erased evidence from missing or corrupt evidence.

### 8.4 Atomic append algorithm

For a single-transaction mutating command:

1. Resolve ProjectContext and validate session capability.
2. Canonicalize the command and compute commandHash.
3. Redact secrets and encrypt any required evidence before beginning the write transaction.
4. BEGIN IMMEDIATE.
5. Look up idempotencyKey.
6. If the key exists with the same commandHash, reconstruct the canonical public response at its committed event range without another semantic append.
7. If the key exists with a different commandHash, return IDEMPOTENCY_CONFLICT.
8. Read and compare the expected stream version.
9. Insert evidence, all event rows with contiguous commandEventIndex values starting at zero, updated stream version, canonical public response, one command_dedup row, and outbox work.
10. COMMIT.
11. Notify projectors and wait for the command's required consistency level.

A crash before COMMIT has no durable command effect. A crash after COMMIT is recovered from command_dedup, events, and outbox. Retrying the same idempotencyKey returns the same semantic result. Sensitive capabilities are excluded from the stored public response; after the same trusted binding proves authority, the server may reissue an equivalent capability for the same ownership generation without duplicating the semantic event.

Multi-phase commands such as session end, migration, global promotion, and cryptographic erasure create workflow_instances in the acceptance transaction. A retry with the same key wakes the existing event-driven saga and returns its current or terminal state; it does not short-circuit unfinished phases. Each saga phase uses a deterministic child key derived from the root command ID, phase name, and workflow generation.

Exactly-once refers to committed semantic event effects. Filesystem materialization and external integration are at-least-once operations made idempotent through deterministic target IDs, fenced claim leases, temporary-file plus atomic-replace writes, and content-hash comparison. No design claims a distributed exactly-once transaction across SQLite and an external side effect.

### 8.5 Read-your-writes consistency

Lifecycle and verification commands require strong read-after-write behavior. memory_contextPack defaults to session-strong consistency: it must include all committed events for the caller's session through the request's eventPosition. project-strong waits for all required project projections. eventual is available only when explicitly requested.

Before returning a strong read, the orchestrator either:

- waits until the required projection reaches the committed globalPosition; or
- combines the last projection snapshot with a deterministic overlay of committed events through that position.

The default projection wait deadline is two seconds for session-strong and five seconds for project-strong, both configurable and reported. The bounded overlay covers committed checkpoints, child reports, decisions, facts, tasks, follow-ups, and artifact/path events through the requested position. It provides exact and bounded lexical matching for those events but does not pretend to provide unavailable vector or graph scores. If project-strong cannot cover a required channel by its deadline, the request returns PROJECTION_LAG instead of silently weakening consistency.

The response reports projectionPosition, eventPosition, overlay range, unavailable channels, consistency mode, and lag. Retrieval never silently omits the caller's committed checkpoint because an asynchronous projector is behind.

## 9. Encrypted raw evidence

Raw evidence is retained permanently by default until explicit deletion.

### 9.1 Eligible evidence

- visible user and assistant messages;
- MCP tool names, redacted inputs, and redacted outputs;
- structured sub-agent reports;
- file, test, Git, and external-source references;
- imported legacy note bodies and metadata;
- retrieval feedback and user corrections.

### 9.2 Redaction and encryption

Secrets are redacted before encryption. Redaction covers configured token patterns, known credential fields, environment-secret values available to the process, private-key blocks, authorization headers, and user-defined patterns. The redaction manifest records rule identifiers and byte ranges, never the secret.

Each evidence item receives a random data-encryption key. Content is encrypted with AES-256-GCM using a fresh 96-bit nonce. Associated authenticated data includes projectId, evidenceId, eventId, schema version, and media type.

The evidence key is wrapped by a per-project key-encryption key supplied through a KeyProvider:

1. operating-system credential store where supported;
2. an explicitly configured managed secret or environment provider for headless use;
3. no plaintext key file inside the project, vault, database, logs, or Git.

Key rotation rewraps evidence keys without decrypting and rewriting event history. Cryptographic erasure deletes ciphertext and the wrapped evidence key, then preserves only hashes and the EvidenceErased event.

If evidence is mandatory for a command and no encryption key is available, the command fails with EVIDENCE_KEY_UNAVAILABLE before appending its semantic event. The system never falls back to plaintext raw evidence.

Canonical projection text remains local but is not encrypted by this first design. Full-volume encryption is delegated to operating-system storage protection and is a separately reviewable future extension.

### 9.3 Evidence capture contract

An MCP server observes MCP calls, not every message in an IDE or agent conversation. Full visible-conversation retention therefore requires an explicit client adapter; the server must never claim complete capture merely because lifecycle tools were called.

The adapter sends memory_recordEvidenceBatch after each completed visible turn and before the final checkpoint. Each frame contains:

- conversationId, stable frameId, ordinal, and idempotencyKey;
- sessionId and optional childSessionId;
- visible role and RFC3339 timestamp;
- content type and redacted content;
- tool-call or tool-result correlation when applicable;
- referenced artifact hashes;
- previousFrameId for gap detection.

Large text is compressed, split into bounded encrypted chunks, and reassembled by ordered frame metadata. Binary attachments remain hash-addressed artifact references unless project policy explicitly imports them. Session handles, encryption material, and hidden reasoning are excluded before capture.

The evidence projection records captureMode as full-adapter, tool-only, imported, or partial, plus firstOrdinal, lastOrdinal, and missingOrdinals. Checkpoints include that coverage. A project may set requireFullEvidence=true; in that mode, a supported adapter cannot complete session end while unexplained frame gaps remain. Generic MCP clients without an adapter operate honestly in partial mode and cannot satisfy a full-evidence quality claim.

For this approved architecture, requireFullEvidence defaults to true before primary cutover. Shadow mode may run with partial coverage to build the adapter, but the parity report must label the gap and primary mode cannot claim complete cross-session evidence until full-adapter tests pass.

## 10. Session and agent orchestration

### 10.1 Ownership model

The normal integration policy is exactly:

1. The primary agent calls memory_sessionStart once for the root task.
2. The primary agent creates or records bounded child work.
3. Sub-agents return structured results to the primary agent.
4. The primary agent records those results in child streams.
5. The primary agent creates the final checkpoint and calls memory_sessionEnd once.

| Role | Allowed lifecycle actions |
| --- | --- |
| primary | Start or resume a root, fork child streams, record child results, checkpoint root, end root |
| sub-agent | Read a capability-scoped context pack, checkpoint its child, and propose child completion when direct integration is enabled |
| maintenance | Replay, verify, migrate, back up, and repair projections; cannot fabricate semantic session completion |

Sub-agents never call memory_sessionStart or memory_sessionEnd for a root task. The default adapter does not pass the root session capability into a forked agent prompt.

Direct child integration is optional. When enabled, memory_sessionFork returns a child capability that can mutate only its child stream. It cannot end, supersede, retract, or promote the parent.

actorRole is injected by the trusted ProjectBinding adapter and is not accepted from ordinary model-controlled tool input. agentId and clientInstanceId are attribution only. A connection without a trusted primary role can neither start nor resume a root. This makes the root-only policy enforceable rather than relying on a child to label itself honestly.

### 10.2 Session capability

memory_sessionStart returns:

- sessionId;
- an opaque sessionHandle;
- an opaque resumeToken delivered to transport-private adapter state;
- ownerGeneration;
- project, workspace, and branch assertions;
- continuityKey;
- state and resumedFromSessionId when applicable.

Only hashes of sessionHandle and resumeToken are stored in session_authority. Each capability is a versioned MAC over project binding, sessionId, capability kind, ownerGeneration, expiry policy, and a stored random nonce using a KeyProvider-held project capability key. This permits deterministic reissuance after a lost response without storing plaintext tokens. Mutating lifecycle calls require a handle whose project binding, session, role, and ownerGeneration match. resumeToken authorizes an ownership transfer across client processes; continuityKey only selects a candidate and is never proof of authority.

The adapter persists resumeToken in an operating-system credential store and holds both tokens outside ordinary model-visible child context. A child receives only its own handle if direct child access is intentionally enabled. Capability loss requires an explicit user-approved recovery command that appends SessionOwnershipRecovered; task similarity never mints root authority.

A generic MCP client that cannot provide transport-private binding and credential storage cannot enable strict resumable-primary mode. It remains in labeled compatibility mode and must use explicit user-approved recovery rather than exposing a resume capability in model-visible text.

Resume uses compare-and-swap on ownerGeneration. It rejects takeover while another nonexpired owner lease is active unless an explicit, recorded recovery policy permits it. A successful resume increments ownerGeneration, rotates both capabilities, and invalidates every prior-generation handle. Simultaneous resumes race on the same CAS; exactly one can succeed.

### 10.3 Session streams and states

Root and child sessions are separate streams connected by parentSessionId. Events include:

- SessionStarted;
- SessionResumed;
- SessionForked;
- SessionOwnerTransferred;
- SessionOwnershipRecovered;
- CheckpointRecorded;
- ChildWorkReported;
- ChildSessionCompleted;
- ChildSessionSuspended;
- ChildWorkTransferCreated;
- ChildWorkTransferClaimed;
- SessionSuspendRequested;
- SessionSuspended;
- SessionEndRequested;
- SessionEndAmended;
- SessionEndCancelled;
- SessionEndVerificationPassed;
- SessionEndVerificationFailed;
- SessionEnded;
- SessionRecovered;
- SessionAbandoned.

The session projection exposes these principal transitions:

    new -> active -> suspended -> active
    active -> ending -> ended
    ending -> active | suspended | abandoned

Lease renewal and wall-clock expiry live only in mutable session_leases and are not semantic events or projector inputs. Lease expiry does not append SessionEnded and does not imply abandonment; it only permits an authorized ownership CAS. SessionOwnerTransferred records a successful semantic ownership change. Abandonment is an explicit primary/user action or a policy action with recorded reason.

Multiple root sessions may be active in one project when they have distinct sessionId and namespaced continuityKey. session_authority enforces uniqueness for clientNamespace plus continuityKey among nonterminal roots in the same project and workspace. A collision returns the existing authorized session or CONTINUITY_CONFLICT before mutation. Starting one session never supersedes another.

### 10.4 Safe resume

memory_sessionStart supports resumePolicy values:

- new — always create a new root;
- exact — require an explicit sessionId or exact continuityKey match;
- latest-safe — resume only when all hard scope checks pass and exactly one compatible candidate exists.

Resolution order:

1. resolved projectId and vaultId;
2. trusted primary ProjectBinding;
3. explicit sessionId;
4. clientNamespace plus exact continuityKey;
5. workspaceId and compatible branch visibility;
6. root role and resumable state;
7. checkpoint and source-state compatibility;
8. resumeToken proof and owner-generation CAS.

Semantic similarity of taskArea is never sufficient by itself to resume. If more than one candidate survives, the call returns SESSION_AMBIGUOUS with safe candidate summaries and performs no mutation.

latest-safe selects at most one candidate; it still requires the private resumeToken before ownership changes. Without that proof it returns a nonmutating recovery requirement, not a new handle.

When a client can persist a stable task or thread identifier, it should derive continuityKey from clientNamespace, that identifier, and projectId. Otherwise the server returns a generated continuityKey that the adapter persists for the task. It persists resumeToken separately as a secret.

### 10.5 Checkpoint contract

A checkpoint contains:

- checkpointId, sessionId, and baseEventPosition;
- createdAt and creator identity;
- concise task summary;
- completedItems, inProgressItems, blockers, and nextActions;
- decisions, assumptions, and unresolved conflicts;
- filesTouched with path, action, optional content hash, and branch;
- artifacts and sourceRefs;
- commands or tests run and their concrete results;
- Git branch, HEAD commit, and dirty-worktree fingerprint;
- child session states;
- evidence capture mode, covered ordinal range, and missing ordinals;
- confidence per material claim.

Required checkpoint triggers are:

- after a durable decision, mistake, insight, or high-value memory write;
- after each child result is accepted;
- before and after risky transitions;
- before suspend;
- before session end;
- periodically when the adapter observes a configurable meaningful-turn or elapsed-time threshold.

Raw evidence preserves detail. Checkpoints provide bounded, resumable task state.

### 10.6 Child report contract

The primary records each sub-agent result through memory_recordChildResult:

- childSessionId and parentSessionId;
- assigned subtask and scope;
- outcome summary;
- evidence-backed findings;
- decisions proposed, not silently accepted;
- files observed or changed;
- verification performed;
- open follow-ups and blockers;
- confidence and evidenceRefs.

The event records both the child author and the primary recorder. The primary may accept, partially accept, reject, or supersede the report through a subsequent event.

memory_completeChildSession may be called by the child capability to propose completion or by the primary capability to accept and complete it. Completion revokes the child handle. A child is never reparented because parentSessionId is immutable.

The suspend-and-carry-forward policy appends ChildSessionSuspended and ChildWorkTransferCreated, closes no child as successful, and places an immutable transfer ticket in the root's final checkpoint. A future primary root claims it with ChildWorkTransferClaimed and creates a new child stream referencing the prior child. The original lineage remains intact.

### 10.7 Idempotent session end

memory_sessionEnd creates or wakes a durable workflow_instances saga:

1. Validate root sessionId, current-generation sessionHandle, ProjectBinding, ownership, commandId, and idempotencyKey.
2. Atomically create the end workflow and append SessionEndRequested.
3. Refuse silent closure when children are active; require their completion or an explicit suspend-and-carry-forward policy.
4. Record the final checkpoint.
5. Queue the deterministic session-log and compatibility materialization outbox.
6. Validate durable results from named, preconfigured validation profiles and run the vault gate. The memory server never executes an arbitrary caller-supplied shell command.
7. Append SessionEndVerificationPassed or SessionEndVerificationFailed.
8. Append SessionEnded only after the required gate passes.
9. Queue the completed-status materialization for the SessionEnded event and, when requireMaterialization is true, wait for its fenced content-hash acknowledgement.

A failed gate leaves the session in ending state with a resumable recovery action. Retrying the same idempotencyKey wakes the same workflow and returns its state. New evidence, a changed validation result, child policy, or threshold uses memory_amendSessionEnd with a new idempotency key and increments the workflow generation. memory_cancelSessionEnd appends SessionEndCancelled and returns to active or suspended; explicit abandonment appends SessionAbandoned. A terminal SessionEnded cannot be cancelled or amended.

Outbox workers claim rows with leases and fencing tokens. A session-log target path is derived from sessionId, not retry time. Writes use a temporary file, atomic replacement, and expected content hash, so a crash after the filesystem write but before acknowledgement produces the same artifact on retry. Until SessionEnded, compatibility Markdown is visibly marked ending and is never presented as a completed session.

## 11. Deterministic projections

Projectors consume events in globalPosition order and record a versioned offset plus checksum.

| Projection | Purpose |
| --- | --- |
| project_identity | Current project, vault, store, workspace, and branch metadata |
| session_tree | Deterministic root/child states, ownership generations, latest checkpoints, and open work |
| canonical_facts | Current and historical facts with temporal validity and conflict sets |
| decisions | Accepted, proposed, superseded, and retracted decisions |
| tasks_followups | Open, blocked, completed, carried-forward, and abandoned work |
| artifacts_files | Paths, symbols, commits, hashes, and branch/workspace validity |
| entity_graph | Entities, aliases, typed edges, evidence, and validity |
| evidence_catalog | Evidence metadata, redaction, encryption, and erasure state |
| lexical_chunks | Section-aware FTS chunks for notes, code, decisions, and checkpoints |
| vector_chunks | Versioned vector-cache references with provider, model, chunker, source hash, and output hash |
| retrieval_feedback | Selection, dismissal, correction, and usefulness signals |
| legacy_materialization | Mapping between events and compatibility Markdown artifacts |

Every canonical item has:

- canonicalId and normalized key;
- project and visibility scope;
- validFrom, optional validTo, and knownFromEventPosition;
- status: candidate, provisional, verified, conflicted, superseded, retracted, expired, or erased-evidence;
- confidence and verification method;
- sourceEventIds and evidenceRefs;
- lastVerifiedAt and staleness reason;
- projectionVersion.

Temporal validity is bitemporal:

- valid interval uses inclusive validFrom and exclusive validTo; absent validTo means still valid;
- knownAt is an event position or recordedAt bound and answers what the system had recorded by that point;
- validAt answers when the claim was true in its domain;
- default validAt is request time and default knownAt is the request's consistency eventPosition;
- occurredAt outside the configured clock-skew window is retained but marked clockSkewSuspect and cannot automatically verify a claim;
- a retroactive correction recorded today can change the answer for a past validAt only when knownAt includes the correction.

This distinguishes “what was true then” from “what was known then.”

Projection rebuild writes a unique immutable projections-{schema}-{generation}.sqlite file. A fenced rebuild lease ensures that only the current generation may publish. After counts, offsets, foreign references, and deterministic core checksums pass, the rebuilder atomically replaces the small current-projection manifest. Readers pin the manifest generation for their connection; old files are removed only after all reader leases expire. No process attempts to rename or delete another process's open SQLite file.

Core deterministic checksums exclude provider-generated vector bytes. Stored vector-cache rows are keyed by source hash, provider, model, chunker, dimensions, and output hash. A core replay never calls a provider. A separate vector-cache gate verifies stored bytes and evaluates regenerated retrieval quality; it does not falsely require an external provider to emit byte-identical floating-point output.

## 12. Maximum-accuracy retrieval

### 12.1 Retrieval pipeline

Retrieval executes in this order:

1. Resolve ProjectContext and reject identity ambiguity.
2. Establish the required eventPosition and projection consistency barrier.
3. Parse intent, exact identifiers, paths, symbols, entities, temporal cues, and task-continuity cues.
4. Apply the formal physical project, workspace/branch visibility, session, status, erasure, validAt, and knownAt filters.
5. Fetch candidates from independent channels:
   - exact IDs, paths, hashes, and aliases;
   - FTS5/BM25 lexical chunks;
   - code-symbol and Markdown-section indexes;
   - local vector similarity;
   - entity-graph traversal;
   - root/child session continuity and latest checkpoints;
   - open tasks and follow-ups;
   - recent verified changes and source freshness.
6. Expand conflict-set closure: for every candidate with conflictGroupId, fetch every eligible member before rank fusion.
7. Fuse ranked lists with versioned weighted reciprocal-rank fusion.
8. Rerank using verification, provenance quality, temporal validity, query intent, scope distance, contradiction state, and retrieval feedback.
9. Group conflicts and present alternatives instead of hiding them.
10. Apply source and entity diversity plus the token budget.
11. Return selected content with citations, selection reasons, freshness, confidence, and consistency metadata.

Hard filters occur before vector or lexical ranking. No score can rescue a candidate from the wrong project, an incompatible branch, an erased source, a future knownAt position, or a disallowed global audience. Conflict closure never reintroduces an ineligible item. If an eligible conflict set exceeds the response budget, the result includes all high-impact members, a conflictTruncated marker, total member count, and a follow-up retrieval cursor.

### 12.2 Ranking policy

Verified canonical facts, accepted decisions, current checkpoints, and source-backed active follow-ups outrank provisional memory. Raw evidence is a recall source and citation target; it does not outrank an equivalent verified canonical item unless the query explicitly asks for a transcript or evidence.

RRF channel weights, temporal decay curves, and reranker features are versioned configuration. Initial values are selected against the bilingual evaluation corpus, recorded with the evaluation result, and frozen for a release. Primary cutover cannot use unmeasured ad hoc weights.

Temporal decay changes ranking, not history. Source invalidation, supersession, retraction, and expiry are explicit states.

### 12.3 Embedding and reranker providers

Local embedding and reranking are the default. A project may opt into an external provider through versioned project configuration.

External providers receive only redacted canonical chunks and the minimum query text by default. Sending raw evidence requires a separate explicit project setting. Provider name, model, dimensions, chunker version, input hash, and generation time are recorded so vectors can be invalidated and rebuilt.

Provider failure degrades to exact, lexical, graph, and continuity retrieval. It never widens project scope or silently consults another project's vector index.

### 12.4 Retrieval response

Each result includes:

- canonical or evidence identifier;
- project and visibility scope;
- validAt, knownAt/eventPosition, and the item's eligible temporal interval;
- source event IDs;
- note path, heading, line, file, symbol, or commit anchor where applicable;
- status, confidence, verification method, and freshness;
- retrieval channels and final selection reason;
- conflict group or superseding item;
- whether the result came from explicit global memory and which audience predicate passed.

memory_retrievalExplain returns filtered candidate counts, channel ranks, fusion contribution, rerank features, dropped-result reasons, projection position, and event position without revealing encryption keys or secrets.

## 13. Promotion, correction, and conflict handling

### 13.1 Promotion states

Memory advances through:

    raw evidence -> candidate -> provisional -> verified canonical -> durable active

Promotion is event-driven and reversible. Raw messages never become canonical merely because they were recent or repeated.

A memory can become verified through:

- explicit user confirmation;
- a passing test tied to a source or artifact hash;
- a direct source-of-truth anchor whose content hash matches;
- an accepted ADR or other governed artifact;
- independent consistent observations when the category policy permits it.

Security, authentication, secrets, deployment, schema, migration, and destructive-operation memories cannot become verified through repetition alone. They require a current source, test, or explicit confirmation.

### 13.2 Contradictions

Canonicalization uses normalized subject, predicate, scope, and temporal interval. Incompatible active values create a conflict set. The system:

1. preserves every claim and its provenance;
2. marks the set conflicted;
3. lowers confidence in an unverified winner;
4. asks for verification when the conflict affects the current task;
5. resolves only through a source-backed correction, supersession, or scoped temporal distinction.

Last write time is evidence of recency, not proof of truth.

### 13.3 Consolidation

Consolidation consumes events from a recorded watermark and emits derived proposals or canonical events with complete sourceEventIds. It never overwrites source evidence.

Equivalent items are merged only when project, visibility, entity identity, meaning, and temporal interval are compatible. A consolidation run records algorithm version, input range, output IDs, conflicts, and evaluation summary.

### 13.4 Retention and forgetting

- Events and encrypted raw evidence are retained permanently by default.
- Canonical memory remains until superseded, retracted, expired, or explicitly erased.
- Source hash changes mark dependent facts stale.
- Expiry policies append FactExpired; they do not delete history.
- User-requested forgetting appends a reasoned retraction and optionally performs cryptographic evidence erasure.
- Erasure preserves a tombstone hash and lineage so missing evidence cannot be mistaken for corruption.

## 14. MCP contract changes

### 14.1 Existing lifecycle tools

Every mutating tool adds required commandId and idempotencyKey. Every content-bearing tool executes under the transport-private ProjectBinding and may include expected identity assertions only as additional checks.

memory_sessionStart adds:

- agentId for attribution; trusted role and client identity come from the binding;
- continuityKey;
- resumePolicy;
- transport-private resumeToken for resume, never a model-visible continuity substitute;
- expectedProjectId, expectedVaultId, and expectedWorkspaceId assertions;

It returns ProjectContext, sessionId, sessionHandle, ownerGeneration, continuityKey, resume state, latest checkpoint, context pack, eventPosition, and projectionPosition. resumeToken is delivered only to the trusted adapter's private credential channel.

memory_contextPack adds:

- optional sessionId and capability-scoped handle;
- expected identity assertions;
- visibility scopes;
- includeGlobal, default false;
- validAt and knownAt/eventPosition;
- consistency target, default session-strong when sessionId is present and project-strong for explicit verification reads;
- explain, default false.

memory_selfCheck adds explicit sessionId and handle for durable association with the correct task.

memory_sessionEnd adds:

- required sessionId, current-generation sessionHandle, commandId, idempotencyKey, and expected identity assertions;
- child end policy;
- final checkpoint fields;
- named allowlisted validationProfileIds, durable validationResults, and required quality threshold.

During shadow compatibility only, a missing sessionId may be associated for parity when the trusted ProjectBinding has exactly one eligible root in the resolved project and workspace. The response emits a deprecation warning. More than one candidate returns SESSION_AMBIGUOUS. Primary strict mode requires explicit identity and never infers authority.

### 14.2 New tools

| Tool | Purpose |
| --- | --- |
| memory_projectStatus | Show resolved project, vault, store, worktree, branch, and identity checks |
| memory_orchestratorStatus | Show mode, runtime capabilities, writer health, outbox, and recovery state |
| memory_sessionTree | Show roots, children, owners, leases, checkpoints, and unresolved work |
| memory_recoverSession | Explicit user-approved recovery when the private resume capability is lost |
| memory_sessionFork | Let the primary create a capability-limited child stream |
| memory_checkpoint | Append a root or capability-scoped child checkpoint |
| memory_recordEvidenceBatch | Idempotently capture ordered visible-conversation evidence frames and coverage |
| memory_recordChildResult | Let the primary persist and disposition a structured child report |
| memory_completeChildSession | Let a child propose or a primary accept completion and revoke the child handle |
| memory_amendSessionEnd | Add a new end-workflow generation after a failed gate |
| memory_cancelSessionEnd | Return a nonterminal ending session to active or suspended |
| memory_eventTail | Read a bounded, filtered event tail with hashes and lineage |
| memory_projectionStatus | Show offsets, versions, checksums, lag, and rebuild status |
| memory_retrievalExplain | Return scope filtering, candidate, fusion, and reranking evidence |
| memory_promote | Explicitly promote scope or verification state |
| memory_retract | Retract, supersede, expire, or correct canonical memory |
| memory_forgetEvidence | Perform governed cryptographic erasure and append a tombstone event |
| memory_integrityCheck | Verify SQLite integrity, event hashes, lineage, identities, and projections |
| memory_migrateV2 | Import legacy data and report shadow or cutover parity |

Heavy or destructive operations retain the current warn-then-run policy. Reads, additive events, checkpoints, and verification remain auto-invocable.

## 15. Typed failures

Every failure response includes code, safe message, project and session assertions when available, retryability, and recovery actions.

| Code | Meaning |
| --- | --- |
| PROJECT_BINDING_REQUIRED | No trusted connection-level project selection authorizes content access |
| PROJECT_REPLICA_DECISION_REQUIRED | A copied or cloned descriptor needs an explicit same-project, attach, or fork decision |
| PROJECT_ID_MISMATCH | Resolved project differs from descriptor, store, or caller assertion |
| VAULT_ID_MISMATCH | Vault identity does not match the project store |
| WORKSPACE_AMBIGUOUS | Workspace or worktree cannot be resolved safely |
| STORE_UNAVAILABLE | The isolated event store cannot be opened |
| SQLITE_CAPABILITY_MISSING | Runtime lacks a required proven storage capability |
| EVENT_CONFLICT | Optimistic stream version changed |
| IDEMPOTENCY_CONFLICT | A key was reused for a different command |
| SESSION_NOT_FOUND | No session exists in the resolved scope |
| SESSION_AMBIGUOUS | More than one safe resume or compatibility target exists |
| SESSION_ALREADY_OWNED | Another nonexpired owner generation currently holds the root |
| SESSION_HANDLE_STALE | The handle belongs to a revoked owner generation |
| SESSION_OWNERSHIP_MISMATCH | Handle or role cannot mutate the requested session |
| CONTINUITY_CONFLICT | A nonterminal root already owns the namespaced continuity key |
| SESSION_CHILDREN_ACTIVE | Root end requires child completion or explicit suspension |
| SESSION_END_INCOMPLETE | End workflow is durable but has not passed all gates |
| PROJECTION_LAG | Required consistency could not be reached by the deadline |
| INTEGRITY_FAILURE | Database, hash chain, lineage, or projection check failed |
| EVIDENCE_KEY_UNAVAILABLE | Required evidence cannot be encrypted |
| EVIDENCE_CAPTURE_INCOMPLETE | A full-evidence gate found unexplained frame gaps |
| PROVIDER_UNAVAILABLE | Optional embedding or reranker provider failed; local fallback applies |
| GLOBAL_SCOPE_DENIED | Cross-project/global access was not explicitly enabled |
| GLOBAL_WORKFLOW_INCOMPLETE | Promotion, correction, or revocation saga is not yet terminal |

Identity, integrity, and evidence-encryption failures fail closed. Optional provider failures degrade locally.

## 16. Backup, recovery, and replay

### 16.1 Startup recovery

Startup performs:

1. project descriptor and database identity comparison;
2. SQLite quick_check, escalating to integrity_check after an unclean shutdown or error;
3. schema migration checksum verification;
4. event tail and hash-chain verification from the last trusted checkpoint;
5. outbox recovery;
6. session-ending workflow recovery;
7. projection version, offset, and checksum inspection;
8. read-only recovery mode when authoritative integrity is uncertain.

The server never repairs authoritative events by guessing. It can rebuild projections and retry outbox work automatically because those are derived.

### 16.2 Backup

On runtimes with a proven node:sqlite online backup capability, the BackupProvider uses it and verifies the resulting SQLite file and manifest.

The quiesced snapshot fallback:

1. uses compare-and-swap to acquire a maintenance epoch with owner, fencing token, and deadline;
2. makes every new write transaction observe that epoch inside BEGIN IMMEDIATE and wait or fail before appending;
3. waits for every live ProjectStoreExecutor lease to drain, acknowledge the epoch, and close its event connection;
4. aborts safely if all live writers do not acknowledge before the deadline;
5. runs PRAGMA wal_checkpoint(TRUNCATE) from the fenced maintenance connection and closes it;
6. copies events.sqlite and the store manifest to a new snapshot directory;
7. reopens executors and clears the epoch only when the fencing token is still current;
8. runs integrity and hash checks against the snapshot;
9. rebuilds projections from the snapshot rather than trusting a copied projection database.

A crashed maintenance owner cannot clear or publish work from an older epoch. Recovery expires the lease, increments the fence, discards incomplete snapshots, and then permits writers. A process that does not participate in the epoch protocol cannot pass the required maintenance check inside an event append transaction.

Backups include event range, last event hash, project/vault/store IDs, schema version, creation time, and file hashes. A backup is not marked usable until verification passes.

### 16.3 Replay

Replay starts from event position zero or a verified projection snapshot, applies pure versioned projectors, and produces:

- terminal projection offset;
- row counts by projection;
- deterministic checksums;
- unresolved schema or lineage errors;
- source and evidence erasure status.

Replay never calls external embedding providers implicitly. Vector regeneration is a separate derived-cache job identified by provider, model, source, chunker, and output hashes; only its manifest and measured retrieval behavior are expected to be reproducible.

## 17. Migration and reversible rollout

### 17.1 Legacy import

The importer reads, without modifying:

- Markdown note bodies and frontmatter;
- note paths, timestamps, types, tags, aliases, and links;
- current lifecycle history as untrusted legacy evidence;
- usage and index metadata as noncanonical migration diagnostics;
- existing embedding metadata when provenance is sufficient.

Each imported artifact records canonical path, source hash, source mtime, importer version, and source type. Idempotency keys use the normalized source identity plus content hash. Changed legacy content creates a new import event and supersession relationship rather than rewriting the original import.

Every import also records originating workspaceId, branchScopeId, branchRef, HEAD, and dirty-state evidence. Legacy lifecycle records receive status legacy-unverified, are never automatically resumable, and cannot prove ownership because the known Version 1 inversion may already have occurred. Imported notes begin as evidence or candidate memory in their narrowest derived scope; governed source types may be promoted only through the normal verification policy. Usage counters, old index rankings, and embedding scores never become semantic events or canonical facts.

### 17.2 Modes

off:

- Version 1 remains the only reader and writer.
- Version 2 may run diagnostics but writes no semantic events.

shadow:

- Version 1 remains authoritative and supplies user-visible results.
- The interceptor records command intent, then the Version 1 outcome, under one correlation ID in Version 2.
- Version 2 builds projections and executes the same reads without returning them.
- A stable legacySourceKey maps Version 1 path/section/content identity to Version 2 source events and canonical items.
- Both readers are aligned to the same captured source snapshot and Version 2 event position.
- A parity service compares hard eligibility filters, project/workspace/branch scope, open-work state, lifecycle ownership, rank order, source hashes, citations, temporal state, conflicts, latency, and failure codes.
- Reports separate invariant parity, which must match exactly, from measured intentional retrieval improvements, whose judged relevance must meet section 20.
- Shadow failures never silently disappear; they enter diagnostics and reconciliation.

primary:

- Version 2 commits the authoritative event first.
- An outbox materializes compatible Markdown and legacy metadata.
- Reads use Version 2 projections.
- Compatibility artifacts record materializedEventPosition and remain continuously measurable; asynchronous lag does not authorize an immediate Version 1 rollback.

### 17.3 Cutover gates

Primary mode is blocked until all of these pass:

- zero cross-project contamination in automated and shadow corpora;
- zero lost or duplicate committed events in concurrency and crash tests;
- zero incorrect root ownership transitions;
- deterministic core projection checksums and verified vector-cache manifests;
- complete legacy import counts and source-hash parity;
- retrieval quality thresholds in section 20;
- successful backup restore and full replay;
- no unresolved critical integrity or privacy findings;
- explicit user approval of the parity report.

Rollback is a fenced workflow. It captures rollbackEventPosition, keeps Version 2 authoritative while the compatibility outbox drains through that exact position, verifies legacy artifact hashes and invariant parity, then changes the read/write mode. If parity cannot be reached, the system remains Version 2 primary or enters read-only recovery; it never exposes stale Version 1 memory as current. Version 2 data remains available for diagnosis and replay, and migration does not delete Version 1 notes.

## 18. Observability

Structured diagnostics include:

- command, correlation, causation, project binding generation, project, workspace, branch scope, session, owner generation, and event IDs;
- append latency, SQLite busy retries, and transaction outcomes;
- last event position and hash;
- projector offsets, lag, immutable generation, reader leases, core checksum, and vector-cache manifest;
- active root and child counts;
- incomplete end/global workflows, outbox age, materializedEventPosition, and rollback fence;
- evidence capture mode, covered ordinals, and unexplained gaps;
- maintenance epoch, writer acknowledgements, fencing token, and backup status;
- retrieval candidate counts, filters, fusion, citations, and conflict rate;
- embedding/reranker provider, model, failures, and local fallback;
- encryption key availability, redaction counts, and erasure status without secret values;
- migration parity and rollback readiness.

Operational logs never include session handles, encryption keys, unredacted evidence, authorization headers, or secret-bearing command fields.

## 19. Security and privacy boundaries

- Canonical paths are realpath-resolved and constrained to the selected workspace or vault.
- Content access requires a transport-private ProjectBinding; model arguments cannot select or authorize another project.
- SQL uses prepared statements for all untrusted values.
- SQLite extension loading is disabled.
- Project stores are physically separated and validated at open time.
- Session handles are capability-scoped and stored only as hashes.
- Root role, resume authority, and validation runners come from trusted adapters; ordinary tool input cannot self-assert them or submit arbitrary shell commands.
- Raw evidence is redacted before authenticated encryption.
- External providers are per-project opt-in and receive redacted minimum inputs.
- Global promotion is explicit, attributable, and reversible.
- Evidence export requires explicit paths and applies the same scope and redaction policy.
- Hash chains detect accidental or unsophisticated historical modification; signed backup manifests provide a stronger cross-snapshot anchor.

## 20. Verification strategy and release thresholds

### 20.1 Unit and contract tests

- Event canonicalization and hash vectors.
- Event schema validation and upcasting.
- Multi-event command idempotency replay, stable commandEventIndex ordering, and conflicting-key rejection.
- Optimistic stream concurrency.
- Rejection when a self-consistent heuristic candidate differs from the trusted ProjectBinding.
- Project/workspace/branch eligibility, lineage, and freshness resolution.
- Explicit clone/replica/fork identity decision and projectId collision handling.
- Session capability permissions, owner-generation CAS, stale-handle rejection, and root/child state transitions.
- Checkpoint serialization and resume selection.
- Evidence-frame ordering, idempotent batches, capture gaps, and full-evidence gates.
- Secret redaction, encryption, rotation, and erasure.
- Projection functions, deterministic core checksums, and vector-cache manifests.
- Bitemporal boundary semantics, clock skew, retroactive correction, conflict sets, supersession, and retraction.
- Global audience, pending promotion, correction, revocation, and erasure sagas.
- Retrieval filtering, RRF, provenance, diversity, and token budgets.
- Backward-compatible shadow schemas and typed errors.

### 20.2 Concurrency and fault injection

- Run 16 independent Node.js processes, each appending 250 correlated events, over at least 10 randomized seeds.
- Verify exactly 4,000 unique committed events per seed, contiguous stream versions, valid global hash chain, and no duplicate command effects.
- Run one primary root with 32 concurrent child streams; verify no child can supersede or end the root.
- Inject process termination before and after every durable boundary in append, checkpoint, outbox, projection, and session-end workflows.
- After each restart, verify that every committed command exists exactly once and every uncommitted command has no semantic effect.
- Retry every interrupted command with its original idempotencyKey.
- Lose responses and retry start, fork, evidence batch, checkpoint, child result, child completion, promotion, and end commands.
- Race two clients resuming one root; exactly one owner-generation CAS succeeds and every old handle is rejected.
- Crash after Markdown replacement but before outbox acknowledgement; retry must leave one deterministic artifact.
- Exercise failed-end amendment, cancellation, abandonment, and child carry-forward without duplicate completion.
- Rebuild projections while multiple Windows processes hold reader leases; readers stay on a valid generation and only the fenced rebuilder publishes.
- Race backup maintenance epochs with active writers and a crashed maintenance owner; no unfenced append or incomplete snapshot may pass.

### 20.3 Isolation tests

Use at least two projects containing deliberately identical task names, entities, paths, and contradictory facts.

- Cross-project contamination must equal exactly zero for all default retrieval calls.
- includeGlobal=false must never open or query the global content store.
- includeGlobal=true may return only active promotions whose audience contains the bound target project.
- Test all-projects and allowlist audiences across Projects P, Q, and R, plus correction, revocation, and source erasure after promotion.
- Same-branch-scope items are visible across worktrees; workspace items are not.
- Different branch scopes remain absent until explicit promotion.
- Test detached HEAD, branch rename, deleted-name reuse, rebase, merge, revert, and changed source hashes.
- Identity mismatch, a missing ProjectBinding, and substitution of a self-consistent heuristic candidate for the trusted binding must fail before content access.
- A cloned descriptor without a registered store must require an explicit replica, attach, or fork decision.

### 20.4 Replay and migration tests

- Rebuild every core projection three times from the same event store and compare byte-stable logical checksums; verify vector caches separately by manifest and retrieval quality.
- Restore a verified backup into an empty location and reproduce terminal event hash and projection checksums.
- Import the current vault twice and prove the second run has no duplicate semantic effect.
- Compare legacy source counts, paths, content hashes, frontmatter fields, scope provenance, lifecycle records, and follow-ups.
- Import the documented ownership-inversion fixture and prove legacy sessions are unverified and never resumable.
- Import divergent legacy vault states from two worktrees and prove neither becomes project-visible without promotion.
- Prove rollback does not switch until compatibility materializedEventPosition reaches rollbackEventPosition and exact invariant parity passes.

### 20.5 Retrieval evaluation

Maintain a versioned, immutable Thai, English, and mixed-language corpus with at least 500 judged queries and at least 50 queries in each critical class. Two independent relevance judgments are adjudicated and stored with the corpus version. It contains:

- exact file, symbol, hash, ADR, mistake, and task lookups;
- multi-session continuation questions;
- stale and superseded facts;
- intentional contradictions;
- near-identical content across projects and branches;
- paraphrases requiring semantic retrieval;
- raw-evidence queries;
- open follow-up and next-action queries.
- validAt versus knownAt temporal boundary queries;
- conflict-set and global-audience queries.

Primary release thresholds:

- cross-project contamination: 0;
- citation precision: at least 0.95;
- citation recall: at least 0.95;
- stale active-memory rate: at most 0.01;
- root-session resume accuracy: 1.00 for hard-key cases;
- ambiguous resume mutation rate: 0;
- overall Recall at 10: at least 0.95;
- overall MRR: at least 0.90;
- overall nDCG at 10: at least 0.90;
- Recall at 10, MRR, and nDCG at 10: also no regression from the frozen best Version 1 or shadow baseline;
- semantic-paraphrase Recall at 10: at least 0.90;
- current-session checkpoint, open-follow-up, and next-action Recall at 10: 1.00;
- bitemporal answer accuracy: at least 0.95;
- conflict detection and surfacing recall: 1.00 for high-impact conflicts and at least 0.95 overall, with precision at least 0.95;
- exact identifier and path recall: 1.00 when the source is indexed and eligible at the requested project, visibility, validAt, knownAt, status, and erasure position;
- unsupported high-impact verified claims: 0.

Latency is measured on the same machine and corpus. Context-pack p95 may not exceed twice the Version 1 baseline without an explicit accuracy-based acceptance decision. Correctness gates cannot be waived by faster performance.

### 20.6 Existing project gates

Every implementation slice must pass:

- npm run typecheck;
- npm test, with the current 406 tests as the minimum regression floor;
- targeted new tests for the slice;
- memory vault verification;
- staged-diff review before commit.

## 21. Acceptance scenarios

### 21.1 Primary plus sub-agents

Given root A and child streams B through E, child completion events update A's session tree. Starting or completing any child leaves A active. Only A's primary handle can request A's end. The final log includes accepted child outcomes and unresolved child follow-ups.

### 21.2 Cross-session continuation

Given a suspended root with continuityKey K, private resumeToken R, and a verified checkpoint, a new trusted primary binding in the same worktree selects with K, proves authority with R, wins the owner-generation CAS, and receives rotated capabilities plus the latest checkpoint, open work, source state, and cited relevant memory. The old handle and an unrelated root remain unusable and untouched respectively.

### 21.3 Ambiguous continuation

Given two resumable roots without an exact continuity key, latest-safe returns SESSION_AMBIGUOUS and candidate summaries. It does not mutate either root.

### 21.4 Multi-project isolation

Given Projects P and Q with the same filenames and contradictory decisions, a connection explicitly bound to P returns only P. A heuristic that finds internally consistent Q cannot authorize access. No vector score, recency signal, or global setting default can introduce Q.

### 21.5 Worktree isolation and promotion

Given worktrees W1 and W2 of P, stable project decisions are shared. When both resolve the same branchScopeId, branch facts are shared but uncommitted workspace evidence from W1 is hidden from W2. A different branch scope remains hidden. After an explicit branch promotion linked to a merge commit, verified promoted knowledge becomes project-visible.

### 21.6 Crash during session end

Given a crash after SessionEndRequested but before verification, restart shows the root in ending state. Retrying the same idempotency key continues the workflow. No other session is closed, and SessionEnded appears only after the required gate passes.

### 21.7 Evidence erasure

Given an explicit authorized erase request, every dependent global promotion is disabled first, then the ciphertext and wrapped data key become unrecoverable, EvidenceErased is appended, and retrieval excludes the content. Integrity replay sees a valid tombstone rather than reporting unexplained loss.

### 21.8 Full evidence capture

Given a full-adapter session, ordered evidence batches cover every visible frame and the final checkpoint records no missing ordinal. A lost batch response is retried without duplication. If one ordinal is absent, requireFullEvidence blocks completed session end and reports the exact gap.

### 21.9 Fenced rollback

Given committed Version 2 events beyond the legacy materialization position, a rollback request keeps Version 2 authoritative until the outbox reaches rollbackEventPosition and invariant parity passes. A failed catch-up never exposes stale Version 1 memory as current.

## 22. Delivery decomposition

The program is intentionally divided so each slice has one coherent invariant and can be shipped behind a disabled flag.

### Subproject 1 — Identity and append-only event core

Deliver:

- runtime floor and capability probe;
- project descriptor, transport-private ProjectBinding, branch scopes, and fail-closed resolver;
- Git common-directory store routing;
- SqliteDriver and worker-thread ProjectStoreExecutor;
- schema, migrations, immutable events, hashes, idempotency, workflow rows, maintenance fencing, and integrity checks;
- per-project isolation tests and multi-process append stress tests.

Exit criterion: two simultaneous projects and multiple worktrees cannot cross-route, and committed events survive retry and crash tests.

### Subproject 2 — Root/child lifecycle and checkpoints

Deliver:

- explicit IDs, private resume capabilities, session handles, and owner-generation CAS;
- root-only start/end ownership;
- child streams and structured child reports;
- safe resume, evidence-capture adapter, checkpoints, operational leases, end saga, and recovery;
- compatibility behavior in shadow mode.

Exit criterion: the original ownership-inversion reproduction is impossible across processes and all lifecycle fault-injection tests pass.

### Subproject 3 — Projections and explainable retrieval

Deliver:

- versioned rebuildable session, canonical, task, artifact, graph, lexical, and vector-cache projections;
- consistency barriers and overlays;
- strict scope filters;
- hybrid fusion, provenance reranking, conflict grouping, context packs, and explanation;
- bilingual evaluation harness.

Exit criterion: retrieval and isolation thresholds pass with deterministic replay.

### Subproject 4 — Promotion, retention, encryption, and global scope

Deliver:

- evidence redaction and envelope encryption;
- verification and promotion policies;
- conflict, supersession, retraction, expiry, and cryptographic erasure;
- separate explicit global store with audience and revocation sagas;
- provider consent controls.

Exit criterion: privacy, erasure, high-impact verification, and global opt-in tests pass.

### Subproject 5 — Migration, shadow parity, backup, and cutover

Deliver:

- idempotent legacy importer;
- off, shadow, and primary modes;
- snapshot-aligned parity reports, compatibility materializer, and rollback fence;
- backup, restore, replay, monitoring, and rollback;
- operational runbooks.

Exit criterion: all cutover gates pass and the user explicitly approves primary mode.

Each subproject must follow its own specification-review, implementation-plan, test-driven implementation, code-review, and verification cycle. No later subproject may weaken project isolation or root lifecycle ownership established by the earlier slices.

## 23. Deferred extensions

The following are valid future programs but do not block this design:

- signed remote snapshot anchoring;
- cross-machine replica synchronization and conflict-free merge;
- full-database encryption for canonical projections;
- learned retrieval reranking from privacy-reviewed feedback;
- automatic branch-promotion proposals informed by verified merge state;
- remote backup targets;
- multi-user authorization beyond the local-process trust boundary.

## 24. References

- Accepted ADR: memory/04_Architecture_Decisions/adopt-a-strictly-isolated-full-event-sourced-project-memory-orchestrator.md
- Current lifecycle implementation: src/services/memory-lifecycle.service.ts
- Current lifecycle schemas: src/schemas/memory.ts
- Current workflow implementation: src/services/memory-workflow.service.ts
- Current configuration and workspace detection: src/config/memory.config.ts
- Node.js SQLite API: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- Node.js command-line SQLite availability: https://nodejs.org/docs/latest-v24.x/api/cli.html
- SQLite WAL-reset bug and fixed-version guidance: https://www.sqlite.org/wal.html#the_wal_reset_bug
- SQLite 3.51.3 release: https://sqlite.org/releaselog/3_51_3.html
- Node.js 24.16.0 release: https://nodejs.org/en/blog/release/v24.16.0
- Audit insight: memory/07_Insights/single-active-lifecycle-causes-session-ownership-inversion-in-multi-agent-workfl.md
