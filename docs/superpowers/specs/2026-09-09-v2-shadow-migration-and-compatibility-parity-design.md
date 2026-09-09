# V2 Shadow Migration and Compatibility Parity Design

**Status:** Design approved in chat; written specification awaiting approval; implementation is not yet authorized
**Date:** 2026-09-09
**Parent design:** [V2 progressive-canary production rollout](2026-08-31-v2-progressive-canary-production-rollout-design.md)
**Delivery slice:** 2 of 5

## 1. Purpose and boundary

This slice implements the migration and parity capabilities required before Version 2 can participate in production shadow operation. It uses a snapshot-first deterministic pipeline so the same verified Version 1 source state can be imported, projected, compared, and materialized repeatedly with identical results.

Version 1 remains the sole caller-facing authority throughout this slice. Version 2 does not answer a production caller, receive a caller command through public composition, or dual-write a Version 1 command. A Version 2 shadow failure cannot fail a Version 1 caller, but it blocks rollout promotion and preserves evidence for review.

The implementation and release rehearsal run against a verified, non-mutating, production-shaped copy. This slice does not activate shadow mode on a live user store, enable canary traffic, change public MCP routing, deploy Version 2, or claim that Version 2 is production-ready. Passing this slice authorizes only preparation of the next separately approved rollout slice.

## 2. Safety invariants

1. The migration source is opened read-only, is never rewritten, and has identical sealed file identities before and after every run.
2. One run is bound to one project/store/workspace scope, one immutable source snapshot, one terminal event position and hash, one migration algorithm identity, one build identity, and one configuration checksum.
3. Import is idempotent. Repeating an identical migration identity is a verified no-op or returns the previously committed result. Reusing an identity with different bytes, counts, positions, or hashes fails closed.
4. The importer preserves source identity, relative paths, content hashes, record counts, metadata, scope provenance, lifecycle records, follow-ups, and deterministic order. It never infers structured authority or lifecycle state from free text.
5. Version 1 and Version 2 parity is evaluated at the same immutable source event position. Comparing different positions is an integrity failure, not a semantic difference.
6. Expected-difference governance cannot excuse identity, authority, project/workspace/session/visibility scope, integrity, privacy, erasure, event-order, duplicate/lost-event, or checksum failures.
7. Migration packages may contain authoritative payload material and are therefore sensitive artifacts. Logs, diagnostics, parity reports, approvals, and telemetry contain only redacted categories, opaque identifiers, counters, positions, and hashes.
8. Compatibility materialization writes only to an isolated target during this slice. It never overwrites the live Version 1 authority or becomes an unnoticed caller fallback.
9. Every phase is bounded by an immutable migration policy whose canonical checksum is included in the rollout revision `configurationChecksum`.
10. Evidence is append-only and retained on failure. A failing run never deletes or rewrites evidence to make a later gate appear green.

## 3. Selected architecture

The approved architecture is a snapshot-first deterministic pipeline:

```text
verified V1 copy
  -> sealed snapshot identity
  -> canonical migration package
  -> idempotent V2 shadow import
  -> verified V2 projection
  -> V1/V2 comparison at position P
  -> typed parity report
  -> isolated compatibility materialization
  -> immutable release evidence
```

There is no data-flow edge from the Version 2 shadow pipeline to a production caller in this slice.

### 3.1 Verified source-copy contract

The source verifier accepts only an explicitly declared sealed-copy location. It rejects any source whose resolved file identity aliases the configured live event store or live legacy-artifact root, symbolic-link substitution, non-regular source files, unsupported schema versions, hostile path components, and any project/store/workspace binding that differs from the requested scope.

Copy acquisition is outside the authoritative Version 1 transaction. The copy must be produced through a quiesced or SQLite-consistent mechanism and supplied with a manifest containing:

- project, vault, store, workspace, and optional branch identities;
- source schema version and copy format version;
- main database and any included SQLite sidecar identities, sizes, and SHA-256 hashes;
- a canonical inventory of legacy artifacts with normalized relative paths, sizes, and SHA-256 hashes;
- event count, aggregate source bytes, terminal event position, and terminal event hash;
- copy creation time and opaque authorized-actor fingerprint; and
- canonical manifest checksum.

The verifier opens the copy read-only, authenticates the complete stored-event chain through the terminal position, validates every declared database, sidecar, and legacy-artifact identity, and records fresh pre-run hashes. It repeats all file-identity and hash checks after the run. A changed source is `MIGRATION_SOURCE_MUTATED` even when the imported result would otherwise match.

### 3.2 Sealed migration policy

Each run receives a strict canonical policy document. Its SHA-256 checksum is included in the rollout revision `configurationChecksum`. The policy has no unknown fields and defines:

- `maxEvents`: 1 through 100,000;
- `maxAggregateBytes`: 1 through 67,108,864 bytes;
- `maxEventBytes`: 1 through 1,048,576 bytes;
- `maxBatchEvents`: 1 through 1,000;
- `maxBatchBytes`: 1 through 8,388,608 bytes;
- `deadlineMs`: 1 through 300,000;
- `maxRetries`: 0 through 3;
- `initialBackoffMs`: 10 through 500;
- `maxBackoffMs`: at least `initialBackoffMs` and no more than 2,000; and
- an expected-difference policy version; and
- `maxExpectedDifferenceRuleAgeMs`: 1 through 604,800,000 milliseconds.

The implementation streams bounded batches and never loads the complete snapshot into memory. Exceeding any limit stops the run with `MIGRATION_LIMIT_EXCEEDED`; it never truncates data, silently raises a limit, or auto-tunes the policy.

### 3.3 Canonical migration package

The package builder consumes only the verified snapshot and emits a canonical, content-addressed package with:

- package format and migration algorithm versions;
- all source bindings and the source-manifest checksum;
- event count, aggregate bytes, terminal event position, and terminal event hash;
- ordered source-record descriptors and hashes;
- deterministic mappings for lifecycle records, checkpoints, follow-ups, artifacts, and scope provenance;
- build identity, configuration checksum, and creation reason; and
- a package checksum over the canonical logical content.

The package is written to an isolated staging root with restrictive permissions. Payload-bearing bytes are not copied into logs or reports. Temporary files use same-directory atomic publication, are verified before adoption, and are either adopted or quarantined without path-based trust.

The migration identity is a domain-separated SHA-256 digest of the project/store binding, source-manifest checksum, terminal event hash, package checksum, migration algorithm version, build identity, and configuration checksum. The rollout revision `migrationIdentityHash` must equal this value before import starts.

### 3.4 Append-only import ledger and checkpoints

The Version 2 shadow store owns an append-only ledger keyed by project ID and migration identity. A ledger attempt records the package checksum, source terminal position/hash, configuration checksum, attempt identity, phase, prior transition hash, transition hash, recorded time, and redacted outcome category.

The ordered phases are:

```text
snapshot-verified
package-sealed
import-committed
projection-verified
parity-complete
compatibility-complete
```

Only an exact next-phase transition may be appended. Resume re-authenticates the ledger chain and re-verifies every prior artifact hash before continuing. A missing, duplicated, reordered, or conflicting transition is `MIGRATION_LEDGER_INTEGRITY_FAILURE`.

When an identical migration identity is already `compatibility-complete`, the runner returns its verified result without appending semantic data. When a process stops after a possible commit, the runner reads the ledger, imported event identities, and terminal hashes before deciding whether to continue. It never blindly repeats an unknown write.

### 3.5 Idempotent Version 2 shadow import

The importer reads the package in canonical batches, validates descriptors before value access, and uses the production event decoders, canonical JSON, source authenticator, payload hashes, and witness bindings. It creates only deterministic source-derived Version 2 import events without inventing new authority, timestamps, identifiers, or lifecycle meaning. Projection rows are rebuilt exclusively from committed Version 2 events; the migration package never writes projection rows directly.

Every imported semantic item is bound to its source identity and package identity. Duplicate delivery of the same source item is a no-op only when every canonical byte and hash matches. A duplicate identity with different content is `MIGRATION_IDENTITY_CONFLICT`. Commit boundaries are explicit, and the ledger transition to `import-committed` is recorded only after durable imported state is observable and verifiable.

Confirmed Version 1 outcomes may later feed the same internal shadow ingestion seam under their original correlation, command, idempotency, and event identities. That ingestion is asynchronous and outside the caller transaction. It is not activated on live user stores by this slice.

### 3.6 Verified projection publication

The existing internal Version 2 projection coordinator builds from the imported terminal event position. Publication requires full integrity replay, matching terminal event hash, deterministic core projection checksums, strict manifest identity, and a verified reader lease.

The parity engine pins the published generation. It never compares mutable staging data, an unverified file, a retired lease, or a generation beyond or behind the source position recorded by the migration identity.

### 3.7 Snapshot-aligned parity engine

The parity engine constructs canonical Version 1 and Version 2 comparison views at the same terminal event position. It compares at least:

- project, vault, store, workspace, branch, session, and visibility identities;
- source counts, event positions, event-chain hashes, and deterministic order;
- lifecycle authority, active/terminal states, checkpoints, follow-ups, and next actions;
- artifact identities, relative paths, content hashes, and metadata;
- projection row counts and deterministic core checksums; and
- sealed retrieval results, citations, conflict closure, temporal filtering, and ranking invariants.

The report contains the rollout revision, migration identity, package checksum, compared event position/hash, V1 and V2 checksums, comparison policy version, counts by typed category, bounded redacted samples, and a canonical report checksum. Reports are deterministically ordered and contain no raw memory or evidence plaintext.

Each difference is one of:

- `PARITY_EQUAL`: canonical values match;
- `PARITY_EXPECTED_DIFFERENCE`: one exact approved rule matches; or
- `PARITY_BLOCKING_DIVERGENCE`: no rule matches or the category is never excludable.

Zero `PARITY_BLOCKING_DIVERGENCE` results are required for completion.

### 3.8 Expected-difference governance

An expected-difference rule is immutable and revision-bound. It contains a rule ID, comparison-policy version, exact typed category, bounded canonical field selector, deterministic predicate, rationale digest, approver fingerprint, approval reference digest, issued time, expiry time, rollout revision ID, migration identity, and rule checksum.

Rules cannot use an unrestricted wildcard, free-text matching, caller-provided executable code, or a predicate that reads fields outside the canonical comparison value. Multiple matching rules are an integrity failure. Expired, future-dated, differently bound, malformed, or checksum-mismatched rules fail closed.

No rule may normalize identity, authority, project/workspace/session/visibility scope, event-chain integrity, duplicate/lost events, privacy, erasure, plaintext leakage, ordering, terminal position/hash, or core checksum divergence.

### 3.9 Isolated compatibility materialization

The compatibility materializer consumes committed Version 2 events through the existing exact-claim/outbox model and writes only to an isolated compatibility target. It preserves the source event position, expected legacy relative path, content fingerprint, materialization revision, triggering payload hash, and acknowledged position.

Publication uses verified bytes and atomic same-directory replacement. Acknowledgement occurs only after the target bytes and fingerprint are durably observable. An unknown acknowledgement outcome is reconciled from the target bytes, outbox claim, materialization revision, and durable acknowledgement record.

The materializer must reach the exact target event position and produce the expected legacy artifact hashes before the `compatibility-complete` ledger phase. Lag or mismatch leaves Version 1 serving callers but blocks rollout progression. This slice never points the materializer at the live Version 1 authority.

## 4. Error, retry, and resume semantics

### 4.1 Terminal integrity errors

These errors are not retried against the same source/package identity:

- `MIGRATION_SOURCE_INVALID`;
- `MIGRATION_SOURCE_MUTATED`;
- `MIGRATION_LIMIT_EXCEEDED`;
- `MIGRATION_IDENTITY_CONFLICT`;
- `MIGRATION_LEDGER_INTEGRITY_FAILURE`;
- `PROJECTION_INTEGRITY_FAILURE`;
- `PARITY_RULE_INVALID`;
- `PARITY_BLOCKING_DIVERGENCE`;
- `COMPATIBILITY_INTEGRITY_FAILURE`; and
- any cross-scope, authority, identity, privacy, erasure, duplicate/lost-event, or plaintext-leak finding.

The run preserves its redacted evidence and requires a new source copy, package, configuration, build, rule approval, or code remediation as appropriate.

### 4.2 Retryable infrastructure errors

Only explicitly classified busy, transient I/O, and interrupted-worker errors are retryable. Retries use the same operation and migration identity, bounded exponential backoff, and the limits sealed in the migration policy. A retry re-verifies the source and durable checkpoint before work resumes.

Exhausted retries produce a failed attempt transition and block progression. They do not convert an infrastructure error into a semantic rejection and do not affect the Version 1 caller.

### 4.3 Unknown outcomes

A timeout, process exit, lost worker response, or acknowledgement interruption after a possible durable write is `MIGRATION_OUTCOME_UNKNOWN`. The runner reconciles from the append-only ledger, imported identities, event positions/hashes, published manifest, parity report checksum, materialized target bytes, and acknowledgement state.

Reconciliation may prove committed, prove not committed, or remain unknown. A proven commit resumes after the committed phase. A proven absence retries within policy. An unresolved outcome blocks the run and preserves evidence; it is never replayed as a new semantic operation.

### 4.4 Version 1 isolation during failure

All Slice 2 work is internal and asynchronous. A migration, projection, parity, or compatibility failure cannot alter the already confirmed Version 1 outcome or turn a successful Version 1 request into a failure. The failure increments only redacted shadow health evidence and blocks a future rollout transition.

## 5. Security, privacy, and artifact handling

Migration packages and source copies are sensitive payload-bearing artifacts. They remain inside explicitly configured isolated roots, inherit or strengthen existing Version 1 access restrictions, reject symbolic-link and path replacement, and are never embedded in reports or committed fixtures.

Logs and reports allow only opaque project-scoped identifiers, rollout/migration identities, schema and algorithm versions, positions, hashes, counts, timings, resource utilization, and typed outcomes. Raw memory, evidence plaintext, credentials, handles, capability material, provider keys, command text, and encryption keys are forbidden.

This slice proves redacted diagnostic behavior but does not replace the separate privacy, encryption, retention, erasure, consent, audience, revocation, and global-scope work required by rollout Slice 3. No live customer shadow activation occurs before that slice is complete and independently verified.

## 6. Testing strategy

Implementation follows test-driven development. Every task begins with a failing test against the approved contract.

### 6.1 Contract and unit coverage

Tests cover strict own-data decoding, hostile prototypes/descriptors, canonical serialization, manifest and package checksums, migration identity, policy bounds, ledger transitions, resume rules, idempotence, conflicting identities, typed parity categories, expected-difference governance, redaction, and materialization fingerprints.

### 6.2 Real storage integration

Integration tests use real SQLite/WAL stores, the migration registry, production stored-event authentication, production payload hashes and witness bindings, the actual projection build/publish/lease path, and the existing compatibility materializer. Hand-built fixtures cannot bypass production decoding or integrity checks.

### 6.3 Determinism and idempotence

The same sealed source copy is processed by three independent clean runs. All three must produce identical logical migration identity, imported semantic identities, counts, terminal event position/hash, core projection checksums, parity report checksum, compatibility artifact hashes, and materialized position.

A fourth delivery of the same package against an already complete ledger proves a no-op with no additional semantic event, projection generation, or compatibility revision.

### 6.4 Fault injection and restart

Tests inject faults before and after source verification, package publication, each import commit, ledger phase append, projection publication, parity report publication, compatibility write, and acknowledgement. Restart tests prove exact reconciliation, no lost or duplicate semantic data, and no false terminal rejection of an unknown outcome.

Concurrency tests cover readers during publication, simultaneous duplicate attempts, stale checkpoints, source replacement, target path replacement, materializer lag, busy locks, exhausted retries, and deadline expiry.

### 6.5 Isolation and security

Executable CI gates prove:

- production controllers, schemas, services, `src/app.ts`, and `src/index.ts` do not import or construct the Version 2 shadow runtime;
- off and shadow modes cannot serve a caller through Version 2 or dual-write a Version 1 command;
- the importer rejects cross-project/workspace/branch/session/visibility data;
- parity exceptions cannot normalize forbidden categories;
- diagnostics contain no forbidden plaintext or secrets;
- source and staging path handling resists symbolic-link and replacement attacks; and
- checksums are based on canonical logical content rather than checkout-specific line endings or platform paths.

Windows and Linux CI must exercise the portable logical hashes and path behavior. Platform-specific expected skips require a documented reason and cannot cover authority, integrity, parity, or isolation behavior.

## 7. Production-shaped rehearsal and performance evidence

The release rehearsal uses a representative, verified production-shaped copy produced under existing authorization. It runs from an isolated location and never points mutation-capable code at the live source.

The evidence report records:

- commit, Node.js, SQLite, OS, schema, build, migration, configuration, and policy identities;
- source manifest and pre/post file hashes;
- event, artifact, lifecycle, checkpoint, follow-up, and scope-provenance counts;
- all three deterministic-run outputs and checksums;
- parity counts by category and every expected-difference rule identity;
- compatibility target position and artifact hashes;
- elapsed time, throughput, peak memory, batch-size utilization, retries, projection lag, and materialization lag;
- focused/full test totals and expected skips; and
- independent specification, implementation-quality, and security review dispositions.

Performance evidence must show bounded streaming behavior and compliance with the sealed migration policy. Version 1 caller latency and availability cannot regress because no caller-facing Version 2 path is added. Any limit breach, unexplained divergence, source mutation, plaintext diagnostic, or incomplete materialization makes the rehearsal red.

## 8. Release gates and completion

Slice 2 is complete only when all of the following are true for the exact commit and rollout revision under review:

1. runtime compatibility, typecheck, test compilation, focused Slice 2 tests, the full test suite, production build, and built-artifact tests pass;
2. the source copy is byte-identical before and after the rehearsal;
3. three clean runs produce identical migration, projection, parity, and compatibility results;
4. there are zero unexplained parity, integrity, identity, authority, scope, privacy, duplicate/lost-event, ordering, terminal-position/hash, or core-checksum findings;
5. every expected difference is exact, immutable, unexpired, revision-bound, and independently reviewed;
6. the compatibility target reaches the exact terminal event position with matching expected hashes;
7. resource use stays within the sealed policy and no unbounded retry, memory growth, queue growth, or fallback path exists;
8. the protected production composition paths remain Version 1-only;
9. independent specification, implementation-quality, and security reviewers report no unresolved Critical or Important finding; and
10. an immutable evidence report records all commands, versions, counts, hashes, performance measurements, and review dispositions.

Passing these gates does not activate shadow on a live store, canary, primary routing, rollback cutback, or deployment. It permits only the next approved rollout slice: privacy, retention, and global scope.

## 9. Implementation boundaries

The later implementation plan may add narrowly scoped modules for source-copy verification, migration policy/package contracts, import ledger storage, deterministic import, parity reporting, expected-difference governance, shadow orchestration, focused release tests, and evidence generation. It may extend the existing internal projection and compatibility seams.

The plan must not modify public routing or register a Version 2 MCP tool. It must not activate a rollout revision on a user store, point the compatibility materializer at the live Version 1 authority, add external vector/provider calls, or perform the Slice 3 privacy and Slice 4 backup/rollback work opportunistically.

## 10. References

- [V2 progressive-canary production rollout design](2026-08-31-v2-progressive-canary-production-rollout-design.md)
- [Subproject 3 projections and explainable retrieval design](2026-08-23-subproject-3-projections-and-explainable-retrieval-design.md)
- [Task 7 sealed real evaluation design](2026-08-28-task-7-sealed-real-evaluation-design.md)
- `src/orchestrator/projections/event-reader.ts`
- `src/orchestrator/projections/coordinator.ts`
- `src/orchestrator/projections/v2-reader-lease.ts`
- `src/orchestrator/compatibility/lifecycle-v2-disabled.adapter.ts`
- `src/orchestrator/compatibility/lifecycle-v2-shadow.mapper.ts`
- `src/orchestrator/materialization/compatibility-log.materializer.ts`
- `src/orchestrator/rollout/rollout-control-plane.ts`
- `src/orchestrator/storage/rollout-control-plane.repository.ts`
- `memory/04_Architecture_Decisions/use-progressive-canary-for-v2-primary-production-cutover.md`
- `memory/04_Architecture_Decisions/use-snapshot-first-deterministic-migration-for-v2-shadow-parity.md`
