# V2 fresh-start production design

**Status:** Written spec approved by the user on 2026-09-29; implementation planning authorized. Production activation remains separately gated.
**Date:** 2026-09-29
**Source baseline:** `9aa3a46` on `codex/subproject-3-projections`. Existing uncommitted Task 13B changes are excluded from this design's implementation claims.

## 1. Agreed outcome and approval boundary

The user wants to use V2 as the primary production memory system, starting with empty memory. V1 is a Markdown vault. Its historical content must not be imported, searched, displayed, or used as a fallback by V2. The user's response to the recommended archive approach is recorded as agreement to retain V1 as a separate read-only archive after cutover. No archive conversion or production configuration changes occur during design work.

Success means that the user's normal memory workflow can start a session, record durable memory and checkpoints, retrieve it in later sessions, close sessions correctly, and recover acknowledged writes after a process failure through the public V2 service. An internal evaluator passing tests is not this outcome.

This document defines the approved implementation and activation contract for that outcome. It does not claim that the public runtime, privacy controls, or operational recovery are already complete. Approval of this written spec permits implementation planning; production activation remains a separate decision against actual release evidence.

## 2. Alternatives and selected direction

| Approach | Benefit | Cost or mismatch |
| --- | --- | --- |
| Separate V2 entry point, empty store, independent activation record (recommended) | Clear data authority; existing V1 use can continue during development; V2 can be exercised end to end before switching clients | Requires public V2 composition and an explicit client cutover |
| Add a mode switch inside the existing Markdown service | One executable and familiar configuration | Every old controller and automatic write path becomes a mixed-runtime routing boundary; mistakes could read or change V1 |
| Continue the V1 shadow migration rollout | Preserves historical memory and the existing V1 rollback model | Conflicts with the selected empty start and requires a source the live Markdown vault does not provide to the current SQLite migration runner |

The approved approach uses the first option. A distinct V2 entry point composes the existing event store, lifecycle runtime, projection runtime, and retrieval service with V2 public adapters. It never constructs the V1 note repository or scans the archive.

## 3. Verified starting point and remaining gaps

Repository inspection establishes these boundaries:

- `src/app.ts` constructs `VaultService`, `NoteRepository`, and the current Markdown controllers. `src/index.ts` exports this entry point. These are the current public service, not a V2 production adapter.
- `src/orchestrator/storage/project-store-bootstrap.service.ts` and the identity modules provide durable store initialization and identity validation.
- `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts` supplies an internal lifecycle runtime. `src/orchestrator/runtime/projection-runtime.ts` composes internal projection and retrieval services.
- The existing rollout revision requires `v1BaselineChecksum`; its state machine assumes V1-backed off/shadow/canary operation. Its default promotion gate rejects V2 caller routing.
- The umbrella design still requires promotion governance, privacy, retention, backup, restore, replay, and public composition. Existing components are inputs to this work, not proof that all those requirements have been delivered.
- The prior full test run is historical evidence for its frozen source tree. The interrupted Task 13B migration gate has no completion record. Neither result proves this new deployment profile works.

The work therefore includes public V2 tool adapters, the fresh-start activation contract, user-facing durable memory writes, privacy enforcement, and operational recovery. It is not just a configuration flag or removal of a failing test.

## 4. Fresh identity, storage, and archive boundary

Use an explicit V2 vault root separate from `memory`, with `memory-v2` under the project as the default proposed to the operator. Resolve its real location before initialization and reject overlap with the V1 archive, including nested paths and filesystem aliases. Do not create it automatically as a side effect of an ordinary memory request.

The existing descriptor and router remain authoritative for actual placement:

- descriptor: `<V2 vault>/.memory-mcp/project-identity.json`;
- Git-backed store: `<gitCommonDir>/project-memory/<projectId>/v2`;
- non-Git store: `<V2 vault>/.memory-mcp/v2`.

The fresh descriptor receives new project/vault/store identities. Human project naming may stay familiar; identity reuse or copying a V1 descriptor is not part of fresh initialization. Git worktrees use the existing binding and branch/workspace isolation rules.

Initialization records a genesis receipt with those identities, schema/build/configuration identities, the empty semantic event position, and deterministic empty-projection checksums. Administrative activation records do not count as imported memory. The first user session is the first user semantic activity.

An already-populated destination is an error for `initialize fresh`; it must never be emptied or silently accepted as fresh. Restart/resume is a separate operation that validates and reopens the same store. A missing database after prior initialization enters recovery; it does not recreate an empty database and hide data loss. Partially completed initialization uses the existing bootstrap recovery semantics.

V1 remains usable by its current service while V2 is being built. At the approved cutover, stop V1 writers, create and verify the archive snapshot, record its manifest, and remove the old writable client registration. Keep the archive outside V2 registration, indexing, retrieval, and backup discovery. Archive access is explicit and read-only, with no automatic agent retrieval. Filesystem protection and a denied-write check enforce read-only operation; a filename convention alone is insufficient. Do not delete V1 or its history.

Development-session memory continues using the existing project-memory service until cutover. The archive decision does not freeze the live vault prematurely.

## 5. Public V2 service and supported workflow

The new executable starts only from explicit trusted project/V2-vault bindings and a matching activation record. The implementation plan must choose and document its exact executable and configuration names; no command suggested in this design is a currently available deployment command.

Keep familiar tool names where their meaning can be preserved, with a versioned V2 schema/response contract. Return stable V2 IDs, source-event references, scope, event/projection positions, and truthful empty results. Do not fabricate Markdown paths for records that have no Markdown artifact.

| Workflow | Required public behavior before production activation |
| --- | --- |
| Start, continue, checkpoint, and end work | Bound root/child session ownership, explicit continuation, durable checkpoints, named verification profiles, and recoverable session end |
| Save session logs, insights, mistakes, and decisions | Governed V2 commands append durable records with provenance and confidence; repeated commands return the same result |
| Search, get, list, recent, context pack, and follow-up radar | Read V2 projections only, enforce scope and consistency before ranking, and return empty collections when no eligible records exist |
| Self-check, awaken, status, and verification | Use V2 state and evidence; never report V1 vault health as V2 health |
| Administrative initialization, backup, restore, and rebuild | Explicit operator-only commands, separate from ordinary content tools |

The implementation must publish a capability manifest covering every existing tool name: V2-supported, superseded with a documented V2 equivalent, or unavailable with a typed explanation. The required workflows above cannot be deferred while claiming the everyday V2 replacement is ready. Markdown-specific frontmatter repair, directory templates, and archive maintenance are not registered as V2 content mutations. Unsupported operations must fail clearly without invoking V1. Reuse pure formatting helpers only when they do not access V1 storage.

Use the existing transport-private identity/capability boundary. The model cannot choose its trusted role, supply another project's binding, or receive private resume credentials. Mutating V2 schemas require stable command and idempotency identities. Reconnection and retries preserve those identities; an uncertain commit returns a recovery identity rather than generating another command. Mutations are acknowledged only after the authoritative transaction commits. Strong reads observe the required committed event position or return a bounded consistency error.

Ordinary V2 note-style writes need a production command service that validates content and provenance before emitting governed events. Direct public access to generic event append is not an acceptable shortcut. Existing checkpoint/session-end materialization, where required, writes only derived V2 artifacts inside the V2 boundary.

## 6. Independent activation and error behavior

Add a distinct persisted fresh-start release profile. Do not manufacture a V1 checksum, feed synthetic migration results into the old canary gate, or reinterpret historical rollout records. Reuse established approval validation, redacted auditing, and compare-and-set generation patterns where they fit, while keeping the old rollout strategy closed to public V2 routing.

The new profile requires a checksummed schema migration registered after the current schema version; existing migration files and historical checksums remain unchanged. A release record binds profile version, project/vault/store IDs, build identity, schema identity, configuration and capability-manifest hashes, recovery-policy hash, and verified evidence digest. The durable control state and append-only transition records refer to that exact release.

| State | User-facing behavior |
| --- | --- |
| Prepared | Operator diagnostics and isolated rehearsal only; no production content requests |
| Active | Supported reads and mutations run through the one V2 authority |
| Read-only recovery | Mutations denied; reads allowed only from a verified view with its position and explicit recovery status |
| Disabled | Content requests denied; operator recovery/status remains available |

Allowed transitions are Prepared -> Active/Disabled, Active -> Read-only recovery/Disabled, Read-only recovery -> Active/Disabled, and Disabled -> Prepared. Initial preparation, activation, reactivation, or release replacement requires operator approval and current evidence. Automatic fault handling may only reduce availability to recovery/disabled. A stale generation, wrong identity/build, missing evidence, or unsupported profile fails closed. No deployment or environment variable alone makes a release Active.

The admission check runs on requests and at the mutation transaction boundary. A recovery transition fences new mutations, drains or identifies already admitted work, and records the final acknowledged position before claiming that writes have stopped. A change to the executable cannot bypass persisted admission state. Ordinary callers cannot submit operator approvals.

There is no V1 fallback before or after commit. Before commit, a definitive rejection may be retried with the same identity after repair. After a possible commit, recover against V2's stored command result. A failure to verify a readable snapshot disables content reads rather than exposing uncertain data.

## 7. Privacy and memory governance

Fresh start removes the legacy import requirement; it does not remove privacy requirements for newly captured data. Before the public V2 service accepts production content, implement and verify the umbrella's applicable redaction, evidence encryption/key recovery, verification/promotion, conflict, supersession, retraction, expiry, and erasure contracts. Authentication/capability key handling already present in the lifecycle runtime is not evidence that raw-memory privacy is complete.

Raw evidence must be redacted before encrypted durable storage. Logs, errors, metrics, backup manifests, and evidence reports carry only permitted redacted metadata. Backups preserve required encrypted evidence and usable key-recovery references without placing plaintext keys in manifests. Missing keys fail closed for the affected operation.

Cross-project global sharing and external providers remain disabled by default, as in the umbrella design. Requests for them fail explicitly until their own audience, revocation, and consent controls are implemented and verified. The production capability manifest discloses this limit; releasing project-local V2 does not mark all global-scope work complete. No information is silently sent to a provider to make a release check pass.

The default retains source events; projection cleanup is derived-data maintenance, not user-data erasure. Governed erasure must also apply to restored state: before reads resume, apply the current erasure/revocation record so an older backup cannot resurrect forgotten evidence.

## 8. V2-only backup, rollback, and recovery

Distinguish software rollback from data restore:

1. **Software rollback:** enter recovery, preserve the latest acknowledged event position, and use a previously verified V2 build only if it can read the current schema and event versions. Rebuild projections and prove the same acknowledged state before reopening writes. If no compatible older V2 build exists, remain in recovery for a forward fix. The first V2 release has no assumed earlier V2 binary.
2. **Data restore:** restore a verified V2 backup into a separate empty location; authenticate and replay any available later events through the recorded recovery fence; verify identities, event hashes, deterministic projections, command/idempotency results, and privacy state. Switch authority only after verification, keeping the damaged store for diagnosis.

A snapshot from before a successful write is not a lossless rollback. If verified data cannot reach the last acknowledged position, report the missing range and remain unavailable for mutations. Discarding acknowledged data requires a separate explicit data-loss decision and is not authorized by this spec. An empty genesis snapshot is useful for rehearsal, not recovery of later user data.

Implement the backup service using the proven SQLite backup capability and existing maintenance-fence primitives; their availability alone does not prove that the complete backup/restore workflow exists. Never copy a live WAL database as an ordinary file and call it verified. Include descriptor/manifest, events, required encrypted evidence, key-recovery dependencies, integrity hashes, schema/build metadata, and replay/erasure positions. Core replay does not call external providers.

Initial operational policy: verified backup before an upgrade, at least hourly while the service is active, and on orderly shutdown when new committed data exists. Surface an overdue backup as unhealthy and block further release promotion; never report an incomplete backup as usable. The release report must state measured recovery time and the actual data-loss exposure for complete storage loss. It may not promise zero loss when the only surviving copy is an older backup. Backup retention and capacity are explicit operator configuration; this design authorizes no automatic deletion of historical V1/V2 content or existing backups.

## 9. Verification and activation evidence

Create one focused fresh-start release gate, then run the repository's applicable release checks on the final implementation. An unchanged documentation-only revision does not require another full test run. After a frozen release candidate passes required checks, rerun only checks invalidated by new changes, failures, or identified risks; preserve the result and source identities.

The focused gate must exercise the actual compiled public service in temporary isolated stores and prove:

1. Empty first start, deterministic empty reads, the first durable write, read-after-write, restart, and retrieval from a later session.
2. At least one complete session/checkpoint/end workflow and each required public workflow in section 5, with retries and stable identifiers.
3. No V1 access using an instrumented archive containing unique sentinel data; denied V1 writes, absent V1 results, and fail-closed path alias/overlap cases.
4. Rejection of foreign project/workspace/session bindings, invalid capabilities, wrong release/build, stale control generations, and unsupported tools.
5. Process failure before and after commit, unknown-result recovery, and concurrent recovery fencing without duplicate/lost acknowledged commits.
6. Verified backup, isolated restore, full replay, a compatible software rollback when such a build exists, and explicit refusal of incomplete or incompatible recovery.
7. Redaction/encryption and key-loss handling for enabled content features; erasure remains effective after restoration.
8. Bounded failures for projection lag, unavailable optional providers, and configured operational limits; no indefinite caller wait or hidden fallback.

The release gate report binds the build/schema/configuration/capability identities, test evidence, known limitations, backup proof, recovery proof, and target bindings. Existing applicable integrity/isolation/retrieval thresholds remain mandatory. Migration/parity tests may remain regression coverage for the retained migration feature; they are not proof obligations about the live V1 archive for this profile. Existing CI changes are reviewed deliberately, not removed wholesale.

For this fresh-start profile, replace the old V1 shadow period and percentage canary with isolated rehearsal followed by one explicitly approved project/workspace deployment. Expanding to another binding requires its own approval and evidence. The old five-stage 24-hour/1,000-operation canary schedule is not inherited. After activation, verify a real normal session, durable write, subsequent retrieval, and backup/status on the deployed build before reporting live operation verified. This is functional deployment evidence, not a claim that a short pilot proves long-term reliability.

Status language is explicit: **implementation incomplete**, **ready for activation**, **active pending live verification**, or **live operation verified for the declared capabilities**. Approval of this spec cannot be cited as activation approval.

## 10. Delivery scope and relationship to prior work

This document is an umbrella amendment for the selected deployment profile. Keep the implementation in coherent increments:

1. Fresh-start identity/initialization, persisted activation profile, and isolated V2 composition contract.
2. Required public lifecycle, memory-write, retrieval, and status adapters with content governance and privacy enforcement.
3. V2 backup/restore/replay, recovery fencing, redacted operational status, and fresh-start release evidence.
4. Deployment preparation, verified read-only V1 archive, approved client switch, and live verification.

The implementation plan must enumerate concrete files, acceptance evidence, and remaining dependencies for these increments. If a prerequisite requires a separate subsystem design, identify it there rather than silently removing the requirement or claiming this umbrella is complete. Each increment is independently reviewable; production traffic begins only when all applicable release prerequisites pass.

This approved profile supersedes the V1-source migration, V1/V2 parity, compatibility catch-up, V1 fallback, V1 rollback, and percentage-canary requirements of the 2026-08-31 rollout design **for this fresh-start deployment only**. Other safety requirements remain applicable. The older migration-capable rollout remains a separate supported development path; do not rewrite its historical results.

Slice 2 Task 14 live-V1 migration rehearsal is not required for this profile. It is not marked passed or completed: record it as outside the selected fresh-start release scope when updating the roadmap after approval. Preserve the current uncommitted Task 13B files and evidence until reviewed under their actual scope. Neither that task nor Subprojects 4/5 become complete merely because fresh start removes migration.

## 11. Source references

- `docs/superpowers/specs/2026-07-11-full-event-sourced-memory-orchestrator-design.md`, sections 11-16, 19-22.
- `docs/superpowers/specs/2026-08-31-v2-progressive-canary-production-rollout-design.md`.
- `docs/superpowers/specs/2026-09-09-v2-shadow-migration-and-compatibility-parity-design.md`.
- `src/app.ts`; `src/controllers/`; `src/orchestrator/identity/`; `src/orchestrator/storage/project-store-bootstrap.service.ts`.
- `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts`; `src/orchestrator/runtime/projection-runtime.ts`; `src/orchestrator/retrieval/service.ts`.
- `src/orchestrator/rollout/rollout-control-plane.ts`; `src/orchestrator/rollout/rollout-cohort.ts`.

## 12. Self-review record

Checked against the inspected source and prior approved designs: no fictional V1 SQLite source, no destructive fresh reset, no empty-snapshot rollback after real writes, no silent V1 fallback, no implied global/provider support, and no claim that historical tests verify unimplemented public composition. The user approved this written profile after reviewing commit `96bc4ea`; deployment still requires actual release evidence and separate activation approval.
