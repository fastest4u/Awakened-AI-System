# V2 progressive-canary production rollout design

**Status:** Approved design — implementation and deployment are not yet authorized
**Date:** 2026-08-31
**Decision:** Version 2 becomes the eventual production-primary runtime through a progressive canary, an auditable control plane, and a fenced rollback.

## 1. Purpose and current boundary

The intended end state is real Version 2 primary production traffic. It is not the current state. The current runtime deliberately returns LIFECYCLE_V2_DISABLED when no V2 runtime is installed, and the sealed CI release gate rejects public V2 routing. Those protections are correct for the evaluator-only boundary and must not be removed or bypassed.

This document defines the replacement safety architecture. Later implementation plans may change V2 runtime construction, public composition, deployment configuration, and CI rules only when they implement the controls and executable proofs below. A hidden environment variable, a route-only change, dual writes, or a direct V1-to-V2 switch does not satisfy this design.

This design extends the umbrella architecture's Subproject 4 and Subproject 5 exit criteria. It does not itself enable V2 traffic, create a deployment, or claim V2 is production-ready.

## 2. Safety invariants

1. Every request runs under one explicit rollout revision and one authoritative runtime. It is never authoritative in both V1 and V2.
2. A V2 canary request may fall back to V1 only before V2 durably commits a semantic event. A possibly committed outcome is returned as the existing recovery/unknown outcome and replayed using its original command and idempotency identity; it is never retried as a fresh V1 command.
3. After a V2 commit, V2 stays authoritative until a fenced rollback proves that V1 compatibility state has caught up exactly. No caller may see stale V1 memory as current.
4. V1 legacy artifacts, V2 data, backups, parity reports, approvals, and audit records are retained through cutover and rollback. Rollback never deletes evidence to make a gate green.
5. Project, workspace, visibility, session, lifecycle, and global-scope isolation remain fail-closed in every mode. A parity exception cannot normalize a cross-scope result.
6. Observability is redacted by construction: opaque IDs, revision IDs, counters, hashes, and categorized failures are allowed; raw memory, evidence plaintext, credentials, handles, and key material are not.

## 3. Rollout control plane

The implementation creates one durable, append-only RolloutRevision record per attempted release. It contains:

- immutable revision ID, V2 build/manifest identity, schema/migration identity, and configuration checksum;
- requested mode, cohort percentage, deterministic cohort algorithm version, and cohort salt/version;
- frozen V1 baseline and accepted operational-threshold policy;
- exact event positions and hashes for shadow snapshots, parity reports, backups, restore/replay evidence, and any rollback fence;
- trusted actor identity, time, reason, and explicit approval for every transition; and
- terminal disposition: superseded, promoted, rolled back, or recovery-only.

The control plane owns these finite states:

| Mode | Authoritative runtime | External behavior |
| --- | --- | --- |
| **off** | V1 | V1 serves all reads and writes. V2 has no traffic and writes no semantic events. |
| **shadow** | V1 | V1 serves the caller. Confirmed V1 outcomes feed V2 migration/projection/parity work under the same correlation ID; V2 never answers the caller or dual-writes the command. |
| **canary** | V2 for selected cohort; V1 otherwise | The selected deterministic cohort reaches the V2 primary path. V1 compatibility materialization and parity continue. |
| **primary** | V2 | V2 serves all eligible production traffic. V1 compatibility remains for fenced recovery, not as an unnoticed fallback. |
| **rollback-pending** | V2 until the fence clears | New V2 assignment stops. The system captures a rollback event position and drains compatibility work through it. |
| **read-only-recovery** | Neither accepts new mutation | Reads expose their last verified authority state with an explicit recovery status while operators restore, replay, or repair parity. |

Only the control plane may move between modes. A transition requires the prior state, current health evidence, requested target, typed reason, and fresh trusted approval. It writes an audit event before becoming effective. Deploying a binary cannot alter the active mode.

## 4. Deterministic cohort and request semantics

For **canary**, the same canonical project ID and workspace ID always resolve to the same result for one rollout revision. The router computes a stable cryptographic digest of revision ID, cohort-algorithm version, cohort salt, project ID, and workspace ID; maps it to 10,000 buckets; and selects V2 when its bucket is below the approved basis-point percentage. Increasing a percentage only adds cohorts and never reshuffles existing ones. Raw inputs and the digest are never emitted in telemetry.

The only percentage sequence is **1% → 5% → 25% → 50% → 100%**. Each increase creates a new approved revision derived from the previous one, not an in-place mutation. Cohorts with incomplete identity, ambiguous scope, unsupported schema, or an unverified capability fail closed; they do not become V2 traffic by default.

For a selected V2 request:

1. Persist the rollout revision and correlation identity before invoking V2.
2. If V2 fails conclusively before durable semantic commit, execute once through V1 with the same command and idempotency identity and audit the fallback.
3. If V2 commits, or commit outcome is unknown, never invoke V1. Return the exact recovery identity/result and resume through idempotent V2 recovery.
4. The compatibility materializer consumes committed V2 events and records its materialized event position and invariant/hash result. It is outside the caller's commit transaction and never performs a second authoritative semantic write.

## 5. Promotion gates

Every promotion is denied unless every gate is green for its target revision. The gate report is immutable, references evidence positions and checksums, and becomes part of the approval record.

### 5.1 Release and integrity

- Supported Node.js and SQLite capability probes pass, including verified WAL, FTS5, hardened connection settings, and a verified backup mechanism.
- The exact build passes typecheck, build, runtime capability checks, the full test suite, sealed lifecycle/retrieval evaluation, and all applicable concurrency, crash, integrity, isolation, and security gates.
- There are zero unresolved critical integrity, authority, identity, duplicate-commit, lost-commit, or cross-project/workspace/global-scope findings.
- The former CI assertion that merely protects V1 routing is replaced only by executable tests proving: V2 is unreachable in **off**; **shadow** cannot serve or dual-write; **canary** is deterministic and approved; public V2 composition is impossible without a green revision; and the rollback fence is enforced.

### 5.2 Data, migration, and parity

- Migration preflight completes against a representative production-shaped copy without mutating the source. Legacy import is idempotent and preserves source identity, counts, paths, hashes, metadata, scope provenance, lifecycle records, and follow-ups.
- Shadow reports compare V1 and V2 at a shared immutable event position. Every expected compatibility difference is typed and reviewed; unexplained semantic, authority, scope, identity, ordering, checksum, or retrieval divergence blocks promotion.
- Core projection checksums, terminal event hash, invariant reports, and the sealed retrieval corpus meet umbrella-architecture thresholds with no regression from the frozen V1/shadow baseline.

### 5.3 Privacy and retention

- Subproject 4 encryption, redaction, key availability/rotation, retention, governed erasure, explicit global promotion, audience, revocation, and provider-consent controls are complete and independently verified.
- V2 telemetry, parity reports, backups, restores, and diagnostics prove the same redaction and scope policy. A plaintext or secret-bearing diagnostic blocks release even if functional parity is green.

### 5.4 Recovery and operations

- A verified backup manifest records project/vault/store identities, schema, event range, terminal event hash, creation time, and file hashes. It is not usable until integrity verification passes.
- Restore into an empty isolated location reproduces the terminal event hash, deterministic core projection checksums, and migration/parity report. Core replay never calls external providers.
- Before entering **shadow**, the revision receives a frozen, user-approved operational-threshold policy. It includes error, latency, backlog, projection lag, lease/reconciliation, backup freshness, and capacity limits relative to the recorded V1 baseline. Missing or altered thresholds fail closed; they are not chosen during a canary incident.
- Each canary percentage remains under observation for at least 24 hours and at least 1,000 eligible operations, whichever is later. All correctness gates remain green throughout, and an operator records a separate approval before the next percentage.

## 6. Monitoring and incident behavior

The rollout dashboard and alerts expose only redacted metrics grouped by revision, mode, cohort, project-scoped opaque key, and time window:

- request, mutation, retry, and recovery outcome categories;
- V1/V2 parity category and exact compared event position;
- isolation, authority, identity, integrity, privacy, and retention failure counts;
- projection generation, checksum, event position, lag, outbox age, materialized position, lease/reconciliation status, and rollback fence;
- maintenance epoch/fence, backup freshness, restore/replay verification, and operational-threshold state.

Any critical integrity, isolation, privacy, scope, unknown-commit, parity, or recovery failure immediately blocks promotion. The automatic safe action pauses the revision and stops new V2 canary assignments. It does **not** switch already-committed V2 requests to V1. A human-approved rollback or recovery workflow follows after preserving incident evidence.

## 7. Fenced rollback and recovery

Rollback is an explicit sequence, not a configuration toggle:

1. An authorized actor moves the revision to **rollback-pending**, records the incident, and stops new V2 canary assignment. Existing V2-committed work continues under V2 recovery semantics.
2. Under a maintenance/rollback fence, capture rollbackEventPosition and its terminal hash. New events beyond the fence are V2-authoritative and captured by a later fence, or rejected while read-only recovery is required; they cannot be silently omitted.
3. Keep V2 authoritative while the V1 compatibility outbox drains through that exact position. Verify materialized position, legacy artifact hashes, invariant parity, and V1 readability from a fenced snapshot.
4. If every proof passes, append an audited V1 cutback transition and allow V1 to become authoritative for the next approved revision. Preserve V2 data, reports, and backups for diagnosis and deterministic replay.
5. If catch-up or parity fails, enter **read-only-recovery**. Do not expose stale V1 state. Restore and replay from a verified backup or repair the compatibility path, then create a new explicitly approved revision.

Required tests include pre-commit V1 fallback, post-commit unknown-outcome recovery, rollback-fence capture under concurrent writers, compatibility lag, failed catch-up, V1 checksum mismatch, and restore/replay before V1 cutback.

## 8. Delivery slices and approval boundaries

This is an umbrella rollout design, not one implementation task. Work stays behind **off** and is independently reviewed in these slices:

1. **Rollout control plane and sealed routing contract.** Add durable revision, approval, cohort, state-machine, and redacted-audit primitives; replace the V1-only CI assertion with the stronger executable routing contract. V2 remains **off**.
2. **Shadow migration and compatibility parity.** Implement the idempotent importer, snapshot-aligned V1/V2 comparison, expected-difference governance, and compatibility materializer. V1 remains authoritative.
3. **Privacy, retention, and global scope.** Complete Subproject 4 before caller traffic and prove controls apply equally to production telemetry and recovery artifacts.
4. **Backup, restore, replay, and rollback.** Implement verified backup, isolated restore/replay, operational monitoring, and exact-position rollback tests before a canary revision can be approved.
5. **V2 public composition and progressive operations.** Wire the public V2 runtime only through a green control-plane revision, run shadow, then execute the approved canary sequence and primary transition with live evidence.

Every slice requires an approved implementation plan, red tests before production code, relevant release verification, independent review, and a written evidence report. Completing one slice does not authorize the next or a production transition.

## 9. Acceptance evidence for primary mode

V2 is eligible for **primary** only when an approved report proves, for the exact target revision:

- every promotion gate passed and stayed green at every prior canary level;
- every critical stop condition was exercised in a non-production drill or safe isolated environment, including failed rollback catch-up;
- the control-plane audit trail contains shadow, canary, recovery, and primary approvals with evidence hashes;
- backup restore and full replay reproduce expected terminal event hash and deterministic core projections;
- the final 100% observation period completed under the frozen operational policy with no unresolved critical finding; and
- the user explicitly approves the final primary transition.

Until this evidence exists, the truthful status is **V2 production rollout in design/implementation**, not V2 production-ready.

## 10. References

- docs/superpowers/specs/2026-07-11-full-event-sourced-memory-orchestrator-design.md — backup, replay, cutover, monitoring, delivery decomposition, and rollback invariants.
- docs/superpowers/specs/2026-08-28-task-7-sealed-real-evaluation-design.md — current evaluator-only boundary.
- memory/04_Architecture_Decisions/use-progressive-canary-for-v2-primary-production-cutover.md — accepted rollout decision.
