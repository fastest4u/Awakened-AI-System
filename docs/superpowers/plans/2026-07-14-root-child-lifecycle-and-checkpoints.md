# Root/Child Lifecycle and Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the disabled-by-default Subproject 2 lifecycle engine that gives one authenticated primary durable root authority, lets explicitly bound children report without superseding that root, records resumable checkpoints and coverage-only evidence, and closes sessions through an idempotent verified workflow without changing the production Version 1 MCP path.

**Architecture:** Version 2 remains isolated under `src/orchestrator/`. A pure session aggregate folds append-only lifecycle events; transactional authority, lease, coverage, workflow, validation, transfer-ticket, approval-consumption, and outbox indexes are checked against that fold inside the existing per-project SQLite worker. Bearer capabilities stay in the trusted adapter: the worker receives only command-bound proofs or signed approvals, atomically appends events through the semantic command store, and returns nonsecret authority-material descriptors for private reconstruction. A separate operational store owns exact eventless workflow/outbox fencing and can neither append events nor use semantic dedup. Session end is a durable generation-fenced saga, while compatibility Markdown is a deterministic derived artifact written and acknowledged by one fenced materialize operation.

**Tech Stack:** TypeScript 5.8 in strict NodeNext mode, Node.js 22.22.3 minimum / 24.16.0 recommended, Node core crypto/fs/worker_threads/child_process, `node:sqlite` with SQLite 3.51.3+, existing Zod 3, esbuild, native `node:test`, PowerShell-compatible npm scripts.

## Global Constraints

- This plan implements only the approved design in `docs/superpowers/specs/2026-07-14-root-child-lifecycle-and-checkpoints-design.md`; any implementation-changing deviation requires a written spec amendment and review before code changes continue.
- Version 1 remains authoritative. Do not modify `src/app.ts`, `src/index.ts`, MCP controller/schema registration, `src/services/memory-lifecycle.service.ts`, `src/services/memory-workflow.service.ts`, retrieval ranking, embedding providers, or legacy note-writing behavior.
- Primary mode remains disabled. New Version 2 lifecycle request variants are callable only from direct services, worker fixtures, and tests; no production MCP tool routes to them in this subproject.
- The production-isolation comparison base for this plan is immutable commit `0e375d4643d4b630f36f874a3bb192e96739ac46`; release gates fetch and compare the protected Version 1 paths against that exact commit.
- Preserve the existing regression floor of 824 tests total, 814 passing, zero failing, and 10 intentionally skipped before counting new Subproject 2 tests.
- Every semantic mutation is bound to one re-established `ProjectContext` and commits authority checks, stream CAS, events, command deduplication, invariant-index changes, workflow changes, and outbox rows in one `BEGIN IMMEDIATE` transaction.
- `events` are the semantic source of truth. `session_authority`, `session_leases`, coverage, transfer, workflow, validation, approval, and outbox tables are transactional indexes or operational state; a fold/index disagreement returns `INTEGRITY_FAILURE` and is never repaired implicitly.
- Root and child streams are deterministic `session/{sessionId}` streams. Session IDs, command IDs, report/item IDs, approval IDs, proof nonces, adapter-session IDs, batch IDs, and checkpoint IDs are canonical lowercase UUIDs.
- `ownerGeneration` starts at 1 and is the root lease fencing value. Child capability generation is independent. Lease expiry permits an authorized attempt but never changes semantic state by itself.
- Issued handles, resume tokens, raw provider keys, raw proof MACs, raw approvals, plaintext evidence, environment dumps, and raw command output never enter events, command responses, SQLite text columns, outbox payloads, logs, snapshots, errors, or retained fixtures.
- Worker authorization requests contain only strict `CapabilityProofV1`, signed lifecycle approval, a fork-only signed child-binding grant alongside the current root proof, or internal generation-fenced work identity. Issuance responses contain only a nonsecret `AuthorityMaterialDescriptorV1`; only the authenticated target adapter reconstructs authority, while a different presenter routes the descriptor without reconstructing it.
- Capability, approval, child-binding-grant, continuity, evidence, validation-output, and materialization domains are distinct. Secret comparisons use `timingSafeEqual`; proof derivation uses the exact HKDF-SHA-256 parameters approved in the spec.
- Every compatibility-log rewrite has an immutable `materializationRevision` equal to its triggering committed event position. Revision—not workflow generation alone—fences ending, failed, invalidated, completed, cancelled, and abandoned bytes.
- Coverage batches retain ordinals and keyed fingerprints only. They always report `contentRetained: false`, never claim `full-adapter`, and can never satisfy `requireFullEvidence` in this subproject.
- A checkpoint canonical body is at most 256 KiB and obeys every per-field/list/path/missing-interval bound from the approved spec. Paths are project-relative, normalized, and containment checked.
- Source-state witnesses use trusted `SourceStateScopeV1`: exact internal store/private-state paths and committed materialization target/temp paths are filtered, never a caller glob or whole vault/log directory. The scope version is stored with every witness so lifecycle self-writes cannot race validation while ordinary project edits remain visible.
- No caller chooses `ProjectBinding`, actor/client audiences, time, lease duration, key provider, validation command, source-state provider, operating mode, child binding grant, or recovery/abandonment approval.
- All authoritative SQLite access stays inside the project-store worker. The explicit offline bootstrap/upgrade administration path may own only its short-lived maintenance connection and must close every handle on success and failure.
- Ordinary open, read, append, status, integrity, and MCP activity never upgrades a Version 1 store. A valid Version 1 prefix reports `SCHEMA_UPGRADE_REQUIRED` until the explicit maintenance-fenced upgrade is applied.
- Migration identifier `0001-event-core` retains the already-published `schema_migrations.name = 'event-core'`; changing it would corrupt valid history. Migration identifier `0002-session-lifecycle` records the name `session-lifecycle`. Manifest `schemaVersion` remains document-format version 1 while `project_meta.schema_version` advances to 2.
- No process-random production key fallback, caller-selected shell command, arbitrary SQL, timing sleep, Unix-only signal assumption, or replacement of an open SQLite file is allowed.
- Correctness tests use injected clocks, deterministic UUID sources, IPC/process barriers, fault injectors, and cooperative closure. Timeouts are bounded cleanup only.
- Use Node core and the repository's existing dependencies; do not add a production dependency. Keep ESM imports suffixed with `.js`.
- Subproject 3 still owns lifecycle/retrieval projections and context-pack integration; Subproject 4 owns encrypted raw evidence and privacy/retention; Subproject 5 owns live off/shadow/primary configuration, legacy import, backup/restore, parity reporting, and production cutover. Do not describe Subproject 2 alone as production-ready memory.

---

## File Structure

### Lifecycle contracts and pure domain

| File | Responsibility |
| --- | --- |
| `src/orchestrator/lifecycle/contracts/identifiers.ts` | Branded lifecycle identifiers, canonical UUID/decimal/RFC3339 guards, root/child states, resume and child-end policies. |
| `src/orchestrator/lifecycle/contracts/commands.ts` | Strict semantic command, bounded-operation, audience, authorization, and public-result contracts. |
| `src/orchestrator/lifecycle/contracts/events.ts` | Version 1 lifecycle event names and typed payload union. |
| `src/orchestrator/lifecycle/contracts/checkpoint.ts` | Bounded `CheckpointV1`, source/file/artifact/test/claim, and child-summary contracts. |
| `src/orchestrator/lifecycle/contracts/child.ts` | Child assignment, report, disposition partition, completion, suspension, and immutable transfer-ticket contracts. |
| `src/orchestrator/lifecycle/contracts/session-end.ts` | End request, trusted quality policy, durable phases, validation result, outbox, amendment, cancellation, and abandonment contracts. |
| `src/orchestrator/lifecycle/errors.ts` | Stable lifecycle error codes, safe details, retryability, and bounded recovery actions. |
| `src/orchestrator/lifecycle/session-aggregate.ts` | Pure root/child fold, transition checks, terminal protection, generation/commitment/checkpoint invariants. |
| `src/orchestrator/lifecycle/lifecycle-intent.ts` | Shared canonical semantic intent and bounded-operation hashes with authorization material excluded. |

### Capability, authority, and storage

| File | Responsibility |
| --- | --- |
| `src/orchestrator/lifecycle/authority/redacted-secret.ts` | Nonserializable wrapper for live bearer and approval material. |
| `src/orchestrator/lifecycle/authority/capability-key-provider.ts` | Opaque purpose-scoped current-key, MAC, verify, fingerprint, seal, and open interface; no raw key export. |
| `src/orchestrator/lifecycle/authority/capability-codec.ts` | Strict `pmcap1` issue/reconstruct/verify, exact HKDF proof derivation, and proof digesting. |
| `src/orchestrator/lifecycle/authority/approval-codec.ts` | Strict replay-resistant `pmrap1` recovery/abandonment approval verification and consumption witness. |
| `src/orchestrator/lifecycle/authority/authority-commitment.ts` | Canonical committed-authority field set and domain-separated commitment. |
| `src/orchestrator/lifecycle/authority/authority-material-adapter.ts` | Candidate intent construction, private proof creation, descriptor reconstruction, audience routing, and terminal cleanup. |
| `src/orchestrator/lifecycle/authority/pending-authorization.store.ts` | Trusted crash-durable complete semantic-command/private-authorization retry interface. |
| `src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.ts` | Atomic/fsynced encrypted complete pending-command persistence below an explicit host-private root. |
| `src/orchestrator/storage/event-append-transaction.ts` | Transaction-scoped replay check, event materialization, stream CAS, outbox insert, and dedup persistence shared by V1 and V2. |
| `src/orchestrator/storage/lifecycle-storage.types.ts` / `src/orchestrator/runtime/clock.ts` | Shared SQLite connection/transaction shapes and injected wall/monotonic clock contracts. |
| `src/orchestrator/storage/session-authority.repository.ts` | Authority row load/insert/CAS/revoke/terminal/checkpoint-marker operations and fold comparison. |
| `src/orchestrator/storage/session-lease.repository.ts` | Root-only acquisition, clamped renewal, release, transfer, and lease fencing. |
| `src/orchestrator/storage/lifecycle-approval.repository.ts` | Single-use approval ID/nonce-digest consumption. |
| `src/orchestrator/storage/child-transfer.repository.ts` | Immutable transfer tickets and one-winner claims. |
| `src/orchestrator/storage/evidence-coverage.repository.ts` | Coverage batch/frame conflict checks, canonical gaps, 200-interval bound, and invariant rows. |
| `src/orchestrator/storage/session-end.repository.ts` | Workflow generation/phase/claim CAS, complete validation attempt plans, cancelled-row reopening, and recoverable scans; not immutable result ownership. |
| `src/orchestrator/storage/migrations/0002-session-lifecycle.ts` | STRICT lifecycle tables, columns, indexes, guards, and project-meta version trigger replacement. |
| `src/orchestrator/storage/migrations/registry.ts` | One frozen contiguous ordered registry for migrations 1 and 2. |
| `src/orchestrator/storage/schema-compatibility.ts` | Exact-prefix inspection and typed current/upgrade-required schema classification. |
| `src/orchestrator/storage/project-store-upgrade.service.ts` | Dry-run plan and explicit maintenance-fenced, prefix-checked, post-verified upgrade. |
| `src/orchestrator/runtime/project-store-upgrade-executor.ts` / `src/orchestrator/runtime/project-store-upgrade-probe.ts` | Dedicated stateful maintenance owner for apply and read-only offline inspection for dry-run. |
| `src/orchestrator/integrity/lifecycle-integrity.service.ts` | Lifecycle fold/index/workflow/lease/coverage/approval/transfer/validation/outbox integrity verification. |

### Lifecycle services and worker integration

| File | Responsibility |
| --- | --- |
| `src/orchestrator/lifecycle/capability.service.ts` | In-transaction proof/approval authorization, capability issue/rotation/reissue, descriptor and stale-status generation. |
| `src/orchestrator/lifecycle/lifecycle-command.store.ts` | Own the semantic `BEGIN IMMEDIATE`, exact dedup-first ordering, fold/index checks, event append, and rollback/outcome-unknown handling. |
| `src/orchestrator/lifecycle/lifecycle-operational.store.ts` | Own short nonsemantic workflow/outbox `BEGIN IMMEDIATE` operations with exact fences, no event append, and no `command_dedup`. |
| `src/orchestrator/lifecycle/lifecycle-command.processor.ts` | New/exact/latest-safe root start/resume, lease heartbeat, suspension, and explicit recovery. |
| `src/orchestrator/lifecycle/lifecycle-query.service.ts` | Bounded authoritative session folds and redacted tree/status summaries. |
| `src/orchestrator/lifecycle/child-workflow.service.ts` | Fork/assignment-amend/report/disposition/proposal/completion/suspension/transfer/claim commands. |
| `src/orchestrator/lifecycle/checkpoint.service.ts` / `src/orchestrator/lifecycle/source-state.provider.ts` | Checkpoint validation/markers plus trusted versioned self-write exclusions and branch/HEAD/dirty source-state capture. |
| `src/orchestrator/lifecycle/evidence-coverage.service.ts` | Strict coverage-only evidence batch recording and honest result metadata. |
| `src/orchestrator/lifecycle/session-end-policy.ts` | Exact integer quality-policy arithmetic, merge rules, and child/checkpoint/evidence prerequisites. |
| `src/orchestrator/lifecycle/session-end-workflow.service.ts` | Generation-fenced durable phase claims, retries, immutable validation binding, and completion acknowledgement. |
| `src/orchestrator/lifecycle/session-end.coordinator.ts` | Durable end request, child resolution, checkpoint, amendment, cancellation, abandonment, terminal append, and generation fencing. |
| `src/orchestrator/lifecycle/materialization-queue.port.ts` | Pre-Task-16 queue preparation/persistence seam with recording fakes for workflow tests. |
| `src/orchestrator/lifecycle/validation-profile.registry.ts` | Trusted validation profile resolution. |
| `src/orchestrator/lifecycle/validation-profile.runner.ts` | Trusted allowlisted profile execution and immutable attested result production. |
| `src/orchestrator/storage/lifecycle-validation-result.repository.ts` | Immutable workflow/generation/profile/config/checkpoint/source-bound validation result rows. |
| `src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts` | Integrity-first recovery scans and idempotent workflow/outbox resumption without inferred success. |
| `src/orchestrator/materialization/vault-artifact-path.ts` / `src/orchestrator/materialization/compatibility-log.renderer.ts` | Contained deterministic artifact path and pure canonical UTF-8 Version 2 Markdown bytes. |
| `src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts` | Concrete renderer/fingerprint/connection-bound outbox adapter for `LifecycleMaterializationQueuePort`. |
| `src/orchestrator/materialization/atomic-artifact-replacer.ts` / `src/orchestrator/materialization/compatibility-log.materializer.ts` | Revision-claimed temp-write, fingerprint-history check, atomic replace, fsync, and acknowledgement. |
| `src/orchestrator/compatibility/lifecycle-v2-disabled.adapter.ts` / `src/orchestrator/compatibility/lifecycle-v2-shadow.mapper.ts` | Disabled byte-preserving pass-through and pure bounded nonmutating shadow comparison. |
| `src/orchestrator/lifecycle/lifecycle-faults.ts` | Default-noop boundary-specific fault injection contract used only by explicit process fixtures. |
| `src/orchestrator/runtime/lifecycle-worker-protocol.ts` | Strict lifecycle wire DTOs/codecs kept separate from domain and bearer types. |
| `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts` | Bind one lifecycle runtime to the already-open ActiveStore connection; open no second SQLite handle. |
| `src/orchestrator/runtime/worker-protocol.ts` | Add only discriminated lifecycle request/response variants and dispatch to the focused codec. |
| `src/orchestrator/runtime/project-store-worker-backend.ts` | Create/store/dispose lifecycle runtime from an optional factory; otherwise fail closed as disabled. |
| `src/orchestrator/runtime/project-store-executor.ts` | Typed semantic, bounded, read, and internal fenced-operation methods; mutation-unknown poisoning, descriptor handoff, and no auto-generated retry identity. |

### Existing storage, administration, tests, and CI

| File | Responsibility |
| --- | --- |
| `src/orchestrator/storage/event-store.ts` | Delegate existing append behavior to the shared transaction writer without changing the V1 contract. |
| `src/orchestrator/storage/migration-runner.ts` | Exact prefix inspection, contiguous registry enforcement, atomic project-meta advancement, and typed upgrade-required/too-new results. |
| `src/orchestrator/storage/project-store-bootstrap.service.ts` | Fresh stores apply both migrations and insert database schema version 2 while the manifest remains version 1. |
| `src/orchestrator/storage/schema-fingerprint.ts` | Compute expected prefix and complete-registry fingerprints from the same registry. |
| `src/orchestrator/integrity/integrity.types.ts` / `event-integrity.service.ts` | Lifecycle schema, event-fold/index, workflow, lease, coverage, approval, transfer, validation, and outbox integrity issues/checks. |
| `src/orchestrator/diagnostics/project-status.service.ts` | Report schema upgrade required/too new without mutating the store. |
| `src/cli/parse-args.ts` / `src/cli/run-command.ts` | Add explicit `orchestrator-upgrade` dry-run and `--apply`; never upgrade through status/integrity/init reads. |
| `tests/lifecycle-contracts.test.ts` / `tests/session-aggregate.test.ts` | Strict domain decoding and exhaustive pure transition invariants. |
| `tests/session-lifecycle-migration.test.ts` / `tests/project-store-upgrade.test.ts` | Registry, 0002, explicit upgrade, race, rollback, post-commit recovery, and handle closure. |
| `tests/event-append-transaction.test.ts` / `tests/lifecycle-operational-store.test.ts` | Existing append parity, V2 authorization-witness dedup, and isolated nonsemantic transaction ownership. |
| `tests/capability-service.test.ts` / `tests/authority-material-adapter.test.ts` | Capability, proof, approval, commitment, reconstruction, encrypted retry, audience, and leakage behavior. |
| `tests/support/lifecycle-authority-reference.ts` | Independent runtime HKDF/HMAC proof reference without retained bearer/raw-proof fixtures. |
| `tests/session-authority.repository.test.ts` / `tests/session-lease.repository.test.ts` | Authority/index coherence, trigger enforcement, clamped clocks, and one-winner leases. |
| `tests/lifecycle-command-processor.test.ts` / `tests/child-workflow.test.ts` | Root and child semantic workflows, safe resume, recovery, disposition, completion, and transfer. |
| `tests/checkpoint.service.test.ts` / `tests/source-state.provider.test.ts` / `tests/evidence-coverage.test.ts` | Checkpoint bounds/triggers/source witnesses and coverage gap/conflict/idempotency behavior. |
| `tests/lifecycle-worker-protocol.test.ts` / `tests/lifecycle-executor.test.ts` | Exact wire codecs, private authority delivery, poisoning, and disabled backend behavior. |
| `tests/session-end.coordinator.test.ts` / `tests/lifecycle-recovery.test.ts` | End phases, policy arithmetic, validation/source races, generation fencing, cancellation, abandonment, and restart. |
| `tests/compatibility-log-materializer.test.ts` / `tests/lifecycle-compatibility.test.ts` | Deterministic bytes/path, fenced replacement, disabled passthrough, and nonmutating shadow DTOs. |
| `tests/support/lifecycle-fixture-client.ts` / `tests/support/lifecycle-test-key-broker.ts` | Shared process harness and parent-hosted in-memory provider broker with no key-byte export. |
| `tests/fixtures/project-store-lifecycle-child.ts` / `tests/fixtures/project-store-lifecycle-crash-child.ts` / `tests/fixtures/lifecycle-validation-profile-child.ts` | Real process protocol, barriers, validation child, and durable-boundary crash injection. |
| `tests/lifecycle.concurrent.test.ts` / `tests/lifecycle.crash.test.ts` / `tests/lifecycle.security.test.ts` / `tests/lifecycle.stress.test.ts` | Cross-project/process ownership, lost response, fault corpus, secret scans, 32-child proof, and serialized stress. |
| `tests/ci-lifecycle-gates.test.ts` | Release workflow/script contract, forbidden upload-path checks, and immutable Version 1 production-isolation base. |
| `scripts/run-lifecycle-stress.js`, `package.json`, `.github/workflows/ci.yml`, `.github/workflows/sqlite-stress.yml` | Focused stress command and minimum/recommended-runtime release gates without uploading memory databases. |

---

## Specification Coverage Matrix

| Approved specification area | Owning tasks |
| --- | --- |
| Goals, non-goals, phase/runtime boundary, production isolation (Sections 1-6, 21, 27-28) | Global constraints, Tasks 17 and 19 |
| Architecture, identity, continuity, correlation, state machines, authoritative fold (Sections 7-9) | Tasks 1-2, 8-10 |
| Capability kinds/encoding, dedup-first proof verification, stored authority, leases, recovery approvals (Section 10) | Tasks 5-9 |
| New/exact/latest-safe start and lost response (Section 11) | Task 9 and Task 18 |
| Checkpoint contract, bounds, triggers, and required markers (Section 12) | Task 11 |
| Fork, report/disposition, completion, suspension, and carry-forward (Section 13) | Task 10 |
| Coverage-only evidence adapter and interval bound (Section 14) | Task 12 |
| Session-end request, phases, validation, amendment, cancellation, abandonment (Section 15) | Tasks 14-15 |
| Deterministic revision-fenced compatibility materialization (Section 16) | Tasks 14-16 |
| Integrity-first recovery (Section 17) | Tasks 4, 15-16 |
| Ordered registry, migration 0002, and explicit upgrade (Section 18) | Tasks 3-4 |
| Worker/executor protocol and Version 2 DTOs (Sections 19-20) | Task 13 |
| Typed failures and security requirements (Sections 22-23) | Tasks 1, 5-9, 13, 18 |
| Unit, migration, cross-process, concurrency, fault, secret, and evidence tests (Section 24) | Tasks 1-18 |
| Verification and exit gates (Section 25) | Tasks 18-19 |
| Ordered delivery decomposition and focused-module rule (Section 26) | Tasks 1-19 in order |

---

### Task 1: Freeze Lifecycle Contracts, Bounds, and Safe Failures

**Files:**
- Create: `src/orchestrator/lifecycle/contracts/identifiers.ts`
- Create: `src/orchestrator/lifecycle/contracts/commands.ts`
- Create: `src/orchestrator/lifecycle/contracts/events.ts`
- Create: `src/orchestrator/lifecycle/contracts/checkpoint.ts`
- Create: `src/orchestrator/lifecycle/contracts/child.ts`
- Create: `src/orchestrator/lifecycle/contracts/session-end.ts`
- Create: `src/orchestrator/lifecycle/errors.ts`
- Create: `tests/lifecycle-contracts.test.ts`

**Interfaces:**
- Consumes: `ProjectContext`, `ProjectId`, `VaultId`, `StoreId`, `WorkspaceId`, `TrustedActorRole`, `JsonValue`, and the approved Version 1 bounds.
- Produces: branded `SessionId`, `CheckpointId`, `ReportId`, `ReportItemId`, `WorkflowId`, `ApprovalId`, `AdapterSessionId`, `EvidenceBatchId`, `EvidenceFrameId`, `TransferTicketId`, and `ValidationResultId`; `RootSessionState`; `ChildSessionState`; `ResumePolicy`; `ChildEndPolicy`; server-derived `LifecycleAudience`; `SemanticCommandAuthorization`; `BoundedOperationAuthorization`; `LifecycleSemanticCommandDraft`; `InternalWorkflowSemanticCommand`; `SemanticSessionEndAction`; `PreparedLifecycleWorkerCommand`; `LifecycleEventV1`; `CheckpointV1`; `ChildReportV1`; `ChildDispositionV1`; `SessionEndRequestV1`; `QualityPolicyV1`; `LifecycleErrorCode`; and `LifecycleError`.
- Export exact decoders `parseCanonicalUuid(value, field)`, `parseUnsignedDecimal(value, field)`, `parseCanonicalTimestamp(value, field)`, `decodeLifecycleSemanticCommandDraft(value)`, `decodeCheckpointV1(value)`, `decodeChildReportV1(value)`, `decodeChildDispositionV1(value)`, and `decodeSessionEndRequestV1(value)`.
- `LifecycleError` exposes only `{ code, retryable, safeMessage, projectId?, sessionId?, recoveryActions }`; its `details` accept safe scalar identity/position assertions only.

- [ ] **Step 1: Write failing strict-contract and privacy tests**

Create table-driven tests that cover canonical lowercase UUIDs, unsigned decimal positions through SQLite int64, millisecond UTC timestamps, unknown-field rejection, every checkpoint/list/path bound, every report-disposition partition, integer quality weights/thresholds, and the full typed-error allowlist. Include these representative assertions:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCanonicalUuid,
  parseUnsignedDecimal,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import { decodeChildDispositionV1 } from "../src/orchestrator/lifecycle/contracts/child.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";

describe("lifecycle Version 1 contracts", () => {
  it("accepts only canonical identities and SQLite-safe decimal positions", () => {
    assert.equal(
      parseCanonicalUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sessionId"),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    assert.throws(
      () => parseCanonicalUuid("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "sessionId"),
      /LIFECYCLE_INPUT_INVALID/,
    );
    assert.equal(parseUnsignedDecimal("9223372036854775807", "position"), 9_223_372_036_854_775_807n);
    assert.throws(() => parseUnsignedDecimal("01", "position"), /LIFECYCLE_INPUT_INVALID/);
  });

  it("requires a complete disposition partition", () => {
    assert.throws(() => decodeChildDispositionV1({
      dispositionVersion: 1,
      reportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "partially-accepted",
      acceptedItemIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      rejectedItemIds: [],
      deferredItemIds: [],
      supersededByReportId: null,
      explanation: "No rejected or deferred item",
      allReportItemIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    }), /CHILD_DISPOSITION_INVALID/);
  });

  it("never serializes unsafe error material", () => {
    const error = new LifecycleError("SESSION_CAPABILITY_INVALID", {
      projectId: "11111111-1111-4111-8111-111111111111",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    assert.deepEqual(error.toJSON(), {
      code: "SESSION_CAPABILITY_INVALID",
      retryable: false,
      safeMessage: "Session authority could not be verified",
      projectId: "11111111-1111-4111-8111-111111111111",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      recoveryActions: ["request-authorized-recovery"],
    });
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing-contract failure**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js
```

Expected: `npm run test:build` fails because the lifecycle contract and error modules do not exist.

- [ ] **Step 3: Implement canonical identifiers and the stable failure vocabulary**

Use exact guards and branded return values. Do not normalize malformed input:

```ts
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

export type SessionId = string & { readonly __sessionId: unique symbol };
export type CheckpointId = string & { readonly __checkpointId: unique symbol };
export type ReportId = string & { readonly __reportId: unique symbol };
export type RootSessionState = "active" | "suspended" | "ending" | "ended" | "abandoned";
export type ChildSessionState = "active" | "completion-proposed" | "completed" | "suspended" | "transferred";
export type ResumePolicy = "new" | "exact" | "latest-safe";
export type ChildEndPolicy = "require-completed" | "suspend-and-carry-forward";

export function parseCanonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !LOWER_UUID.test(value)) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  return value;
}

export function parseUnsignedDecimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  const decoded = BigInt(value);
  if (decoded > SQLITE_INT64_MAX) throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  return decoded;
}
```

Define `LIFECYCLE_ERROR_CODES` as a frozen tuple containing every code in approved Section 22 plus internal `LIFECYCLE_INPUT_INVALID`, `LIFECYCLE_V2_DISABLED`, `COMMAND_OUTCOME_UNKNOWN`, `OPERATION_OUTCOME_UNKNOWN`, `STORE_ID_MISMATCH`, and `WORKER_PROTOCOL_ERROR`. Map every code to one fixed message, retryability flag, and allowlisted recovery-action tuple. Reject unknown detail keys in the constructor and make `toJSON()` return the fixed public envelope only.

- [ ] **Step 4: Implement the strict Version 1 DTOs and decoders**

Use exact-key checks before field decoding and freeze decoded arrays/objects. The command base is:

```ts
export interface LifecycleCommandBase {
  commandId: string;
  idempotencyKey: string;
  agentId: string;
  expectedProjectId: string;
  expectedVaultId: string;
  expectedWorkspaceId: string;
  expectedBranchRef: string | null;
}

export interface LifecycleAudience {
  presentingActorRole: "primary" | "maintenance" | "untrusted";
  presentingClientInstanceId: string;
  targetActorRole: "primary" | "maintenance" | "untrusted";
  targetClientInstanceId: string;
}

export interface PreparedLifecycleWorkerCommand<C extends LifecycleSemanticCommandDraft> {
  command: C;
  candidateIntentHash: string;
  authorization: SemanticCommandAuthorization;
}

export type SemanticCommandAuthorization =
  | {
      kind: "initial-authority";
      authoritySessionId: null;
      targetSessionId: null;
      proof: null;
      approval: null;
      childBindingGrant: null;
    }
  | {
      kind: "protected";
      authoritySessionId: SessionId;
      targetSessionId: SessionId;
      proof: CapabilityProofV1 | null;
      approval: RedactedLifecycleApproval | null;
      childBindingGrant: RedactedChildBindingGrant | null;
    };
```

Define a discriminated `LifecycleSemanticCommandDraft` for root start/resume/recovery/suspend, fork, child-assignment amendment, checkpoint, evidence batch, child report/disposition/completion/suspension/transfer/claim, and end request/amend/cancel/abandon. Request and amendment DTOs accept no validation result ID or observation. Define a separate `InternalWorkflowSemanticCommand` union from the start: `InternalValidationResultCommand` is tied to one durable attempt-plan command/idempotency identity, while `InternalWorkflowPhaseCommand` carries one exact event-appending `SemanticSessionEndAction` (final checkpoint plus ending queue, verification fail/pass/invalidation, or terminal completion) and deterministic command/idempotency/planned-work identity. Both carry the current workflow claim assertion for fresh authorization, and no external decoder accepts either. Every external semantic variant carries `commandId` and `idempotencyKey`; only a new root uses `initial-authority`. Draft decoders reject authorization and audience fields because the trusted adapter adds them later.

Keep protected reads and lease renewal in a separate `BoundedLifecycleOperation` union. Define an internal-only `LifecycleFencedOperation` union for workflow claim/renew/release/eventless-phase/recovery and outbox claim/renew/materialize/failure, carrying deterministic workflow/revision/owner/token work identity. Neither union enters semantic command deduplication, neither may append a lifecycle event, no external draft decoder accepts a fenced operation, and acknowledgement exists only inside the byte-reconciling materialize operation.

Strict decoding rejects a `protected` authorization when proof, approval, and child-binding grant are all null. Ordinary protected capability commands require proof only; approved recovery may use approval only; abandonment requires both the current root proof and an abandonment approval; fork may add one transport-private child-binding grant alongside the current root proof. No other command accepts a grant, and no command other than a new root accepts `initial-authority`.

Implement checkpoint totals by counting file, artifact, source, command, test, and material-claim entries together; count Unicode scalar values with `Array.from(value).length`; reject absolute, drive-qualified, UNC, empty, dot, and parent-traversal paths; reject raw output/command-line/environment fields by exact-key decoding. Implement disposition validation as set equality over `allReportItemIds` with pairwise-disjoint accepted/rejected/deferred sets and the kind-specific rules from Section 9.3.

- [ ] **Step 5: Run contract tests and typecheck**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js
npm run typecheck
```

Expected: all lifecycle contract/privacy cases pass and TypeScript exits `0`.

- [ ] **Step 6: Commit**

```powershell
git add src/orchestrator/lifecycle/contracts src/orchestrator/lifecycle/errors.ts tests/lifecycle-contracts.test.ts
git commit -m "feat: define lifecycle v2 contracts"
```

---

### Task 2: Implement the Pure Root and Child Aggregate

**Files:**
- Create: `src/orchestrator/lifecycle/session-aggregate.ts`
- Create: `tests/support/lifecycle-fixtures.ts`
- Create: `tests/session-aggregate.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/events.ts`

**Interfaces:**
- Consumes: ordered `LifecycleEventV1` records with `streamId`, `streamVersion`, `globalPosition`, `sessionId`, `parentSessionId`, `eventType`, typed payload, and authority commitment.
- Produces: `RootAggregateState`, `ChildAggregateState`, `SessionAggregateState`, `foldSession(events)`, `evolveSession(state, event)`, `assertAuthorityMirror(aggregate, authority)`, and `isTerminalSession(state)`.
- `foldSession` accepts one deterministic stream only, requires stream versions `1..N`, rejects duplicate/nonmonotonic global positions, and never consults SQLite, time, process state, or caller similarity.

- [ ] **Step 1: Write the failing transition matrix tests**

Cover every valid and invalid root/child transition, first-event rule, immutable identity/parent/correlation, owner generation `1` then `+1`, independent child generation, authority-commitment changes, checkpoint base not in the future, monotonically increasing checkpoint/event positions, and exactly one terminal event. Include a regression proving child activity cannot change a root aggregate:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evolveSession, foldSession } from "../src/orchestrator/lifecycle/session-aggregate.js";
import { lifecycleEvent } from "./support/lifecycle-fixtures.js";

describe("SessionAggregate", () => {
  it("folds one root through suspend, resume, verified end", () => {
    const aggregate = foldSession([
      lifecycleEvent(1, "SessionStarted", { ownerGeneration: 1, authorityCommitment: "a".repeat(64) }),
      lifecycleEvent(2, "SessionSuspendRequested", { checkpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      lifecycleEvent(3, "SessionSuspended", { authorityCommitment: "b".repeat(64) }),
      lifecycleEvent(4, "SessionOwnerTransferred", { previousOwnerGeneration: 1, ownerGeneration: 2, authorityCommitment: "c".repeat(64) }),
      lifecycleEvent(5, "SessionResumed", { ownerGeneration: 2 }),
      lifecycleEvent(6, "SessionEndRequested", { previousState: "active", workflowGeneration: 1 }),
      lifecycleEvent(7, "SessionEndVerificationPassed", { workflowGeneration: 1 }),
      lifecycleEvent(8, "SessionEnded", { workflowGeneration: 1, authorityCommitment: "d".repeat(64) }),
    ]);
    assert.equal(aggregate.kind, "root");
    assert.equal(aggregate.state, "ended");
    assert.equal(aggregate.ownerGeneration, 2);
    assert.equal(aggregate.terminalEventPosition, 8n);
  });

  it("rejects post-terminal and cross-stream mutation", () => {
    const ended = foldSession([
      lifecycleEvent(1, "SessionStarted", { ownerGeneration: 1, authorityCommitment: "a".repeat(64) }),
      lifecycleEvent(2, "SessionAbandoned", { authorityCommitment: "b".repeat(64) }),
    ]);
    assert.throws(
      () => evolveSession(ended, lifecycleEvent(3, "SessionCheckpointRecorded", { baseEventPosition: "2" })),
      /SESSION_STATE_CONFLICT/,
    );
  });
});
```

Create shared deterministic event, UUID, timestamp, authority, and aggregate builders in `tests/support/lifecycle-fixtures.ts`; Tasks 8 and 9 extend this same fixture module instead of defining competing builders.

- [ ] **Step 2: Run the aggregate test and observe the missing implementation**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/session-aggregate.test.js
```

Expected: build fails because `session-aggregate.ts` and its exported reducer do not exist.

- [ ] **Step 3: Define exhaustive Version 1 event payloads**

Make `LifecycleEventV1` a discriminated union over exactly these semantic event names:

```ts
export const LIFECYCLE_EVENT_TYPES = [
  "SessionStarted",
  "SessionOwnerTransferred",
  "SessionOwnershipRecovered",
  "SessionSuspendRequested",
  "SessionSuspended",
  "SessionResumed",
  "SessionCheckpointRecorded",
  "EvidenceCoverageRecorded",
  "SessionForked",
  "ChildAssignmentAmended",
  "ChildWorkReported",
  "ChildWorkDispositioned",
  "ChildCompletionProposed",
  "ChildSessionCompleted",
  "ChildSessionSuspended",
  "ChildWorkTransferCreated",
  "ChildWorkTransferClaimed",
  "SessionEndRequested",
  "SessionEndAmended",
  "SessionValidationResultRecorded",
  "SessionEndVerificationPassed",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];
```

Authority-mutating payloads require the new commitment; transfer/recovery require `previousOwnerGeneration` and `ownerGeneration`; checkpoints require both base and committed positions; terminal payloads require terminal workflow/approval assertions. `SessionForked` is always child stream version 1. A transfer-ticket claim appends `SessionForked` first and `ChildWorkTransferClaimed` second in the new child stream so the approved child-creation invariant remains intact.

- [ ] **Step 4: Implement a total reducer with explicit transition tables**

Use closed transition tables and event-specific invariant functions, not permissive default mutation:

```ts
const ROOT_TRANSITIONS: Readonly<Record<string, readonly RootSessionState[]>> = Object.freeze({
  SessionOwnerTransferred: ["active", "suspended"],
  SessionOwnershipRecovered: ["active", "suspended", "ending"],
  SessionSuspendRequested: ["active"],
  SessionSuspended: ["active"],
  SessionResumed: ["suspended"],
  SessionEndRequested: ["active", "suspended"],
  SessionEndAmended: ["ending"],
  SessionEndVerificationPassed: ["ending"],
  SessionEndVerificationFailed: ["ending"],
  SessionEndVerificationInvalidated: ["ending"],
  SessionEndCancelled: ["ending"],
  SessionAbandoned: ["active", "suspended", "ending"],
  SessionEnded: ["ending"],
});

const CHILD_TRANSITIONS: Readonly<Record<string, readonly ChildSessionState[]>> = Object.freeze({
  ChildAssignmentAmended: ["active", "completion-proposed", "suspended"],
  ChildCompletionProposed: ["active"],
  ChildWorkDispositioned: ["active", "completion-proposed"],
  ChildSessionCompleted: ["active", "completion-proposed"],
  ChildSessionSuspended: ["active", "completion-proposed"],
  ChildWorkTransferCreated: ["suspended"],
  ChildWorkTransferClaimed: ["active"],
});
```

`SessionOwnerTransferred` increments generation exactly once and retains active/suspended state; a suspended transfer must then apply `SessionResumed` without another generation change. `SessionOwnershipRecovered` increments generation exactly once and preserves active, suspended, or ending state. No other event changes root owner generation. `SessionSuspendRequested`, checkpoints, evidence, reports, ordinary dispositions, assignment amendments, end amendments, and verification records retain the current semantic state unless their typed payload explicitly carries the approved transition. `SessionEndCancelled` restores only the state captured by `SessionEndRequested`. A rejected completion disposition may restore `completion-proposed` to `active`. Every unsupported event/kind/state combination throws a typed `SESSION_STATE_CONFLICT`; identity, version, commitment, or terminal invariant failure throws `INTEGRITY_FAILURE`.

Implement `assertAuthorityMirror` to compare session kind, parent, semantic/terminal state, generation, latest authority commitment, latest checkpoint position, and terminal event position; compare `bigint` values directly and expose no repair method.

- [ ] **Step 5: Run aggregate, event-core, and type gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/session-aggregate.test.js dist-test/tests/event-store.test.js
npm run typecheck
```

Expected: aggregate transition tests and the unchanged event-store suite pass; TypeScript exits `0`.

- [ ] **Step 6: Commit**

```powershell
git add src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/lifecycle/session-aggregate.ts tests/session-aggregate.test.ts tests/support/lifecycle-fixtures.ts
git commit -m "feat: fold lifecycle session streams"
```

---

### Task 3: Add the Ordered Registry and Lifecycle Schema

**Files:**
- Create: `src/orchestrator/storage/migrations/0002-session-lifecycle.ts`
- Create: `src/orchestrator/storage/migrations/registry.ts`
- Create: `src/orchestrator/storage/schema-compatibility.ts`
- Create: `tests/migration-registry.test.ts`
- Create: `tests/session-lifecycle-migration.test.ts`
- Modify: `src/orchestrator/storage/migration-runner.ts`
- Modify: `src/orchestrator/storage/schema-fingerprint.ts`
- Modify: `src/orchestrator/storage/project-store-bootstrap.service.ts`
- Modify: `src/orchestrator/runtime/project-store-worker-backend.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Modify: `tests/migration-runner.test.ts`
- Modify: `tests/project-store-bootstrap.test.ts`

**Interfaces:**
- `PROJECT_STORE_MIGRATIONS: readonly Migration[]` is the only current-schema registry; `CURRENT_PROJECT_STORE_SCHEMA_VERSION` is `2`.
- `inspectStoreSchema(connection, registry?)` returns `StoreSchemaInspection`; `requireCurrentStoreSchema(inspection)` throws `SCHEMA_UPGRADE_REQUIRED` for an exact older prefix.
- `expectedSchemaFingerprintAtVersion(registry, version, DatabaseSync?)` delegates to the existing schema-fingerprint algorithm using `registry.slice(0, version)`.
- `MigrationRunner.apply(connection, registry, appliedAt, mode)` accepts only `{ kind: "bootstrap-empty" }` or `{ kind: "explicit-upgrade"; expectedAppliedVersion }`, owns one transaction for every pending migration, and returns the versions applied.

```ts
export type StoreSchemaStatus = "current" | "upgrade-required";

export interface StoreSchemaInspection {
  status: StoreSchemaStatus;
  appliedVersion: number;
  targetVersion: number;
  pending: readonly { version: number; name: string; checksum: string }[];
  observedFingerprint: string;
  expectedFingerprint: string;
}

export type MigrationApplyMode =
  | { kind: "bootstrap-empty" }
  | { kind: "explicit-upgrade"; expectedAppliedVersion: number };
```

- [ ] **Step 1: Write the failing registry-prefix tests**

Test that registry versions equal array index plus one; names are nonblank/unique; the frozen registry is `[eventCoreMigration, sessionLifecycleMigration]`; an exact Version 1 history is `upgrade-required`; a future row is `SCHEMA_TOO_NEW`; gap/name/checksum drift is `MIGRATION_CHECKSUM_MISMATCH`; and a valid history with object drift is `SCHEMA_FINGERPRINT_MISMATCH`.

```ts
describe("project-store migration registry", () => {
  it("accepts only an exact immutable prefix", () => {
    const connection = v1Connection();
    const inspection = inspectStoreSchema(connection);
    assert.equal(inspection.status, "upgrade-required");
    assert.equal(inspection.appliedVersion, 1);
    assert.equal(inspection.targetVersion, 2);
    assert.deepEqual(inspection.pending.map((item) => item.version), [2]);
    assert.throws(() => requireCurrentStoreSchema(inspection), /SCHEMA_UPGRADE_REQUIRED/);
  });

  it("rejects a noncontiguous binary registry before touching SQLite", () => {
    const connection = emptyConnection();
    assert.throws(() => new MigrationRunner().apply(
      connection,
      [eventCoreMigration, { ...sessionLifecycleMigration, version: 3 }],
      NOW,
      { kind: "bootstrap-empty" },
    ), /MIGRATION_SET_INVALID/);
    assert.equal(connection.prepare("PRAGMA application_id").get()?.application_id, 0n);
  });
});
```

- [ ] **Step 2: Write the failing migration-0002 object and guard tests**

Create a new database and assert the exact table, column, index, trigger, and foreign-key inventory after both migrations. Include hostile insert/update cases for root/child group coherence, lease authority/generation, command authorization shapes, approval immutability, 201 missing intervals, evidence fingerprint immutability, validation-result immutability/event linkage, stale workflow claims, validation-attempt-plan null groups/generation/cardinality/write-once rules, and immutable outbox planned metadata versus mutable operational fields. Also prove a Version 1 command-dedup row keeps every new column null and an abandonment row may contain both proof and approval witnesses.

The 0002 object contract is:

```text
STRICT tables:
  session_authority
  session_leases
  session_evidence_coverage
  session_evidence_fingerprints
  lifecycle_approval_consumptions
  child_transfer_tickets
  lifecycle_validation_results

ALTER command_dedup:
  lifecycle_authorization_kind
  authorization_proof_version, authorization_proof_nonce, authorization_proof_digest
  authorization_approval_id, authorization_approval_digest
  authorization_session_id, target_session_id
  presenting_actor_role, presenting_client_instance_id
  target_actor_role, target_client_instance_id
  internal_workflow_id, internal_workflow_generation, internal_planned_work_id
  internal_claim_owner_id, internal_claim_token

ALTER workflow_instances:
  session_id, triggering_event_position, expected_authority_commitment
  coordinator_owner_id, coordinator_claim_token, coordinator_claim_expires_at
  coordinator_attempt_count, coordinator_failure_class, coordinator_error_code
  coordinator_next_attempt_at
  validation_attempt_plan_generation, validation_attempt_plans_json

ALTER outbox:
  session_id, origin_kind, workflow_id, workflow_generation
  artifact_kind, artifact_path, materialization_revision
  expected_prior_fingerprint, next_fingerprint, fingerprint_algorithm
  fingerprint_schema_version, fingerprint_key_id, fingerprint_domain
  failure_class, safe_error_code, next_attempt_at
```

- [ ] **Step 3: Run the new tests and observe the missing registry/schema failures**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/migration-registry.test.js dist-test/tests/session-lifecycle-migration.test.js
```

Expected: build fails because registry, compatibility inspection, and migration 0002 do not exist.

- [ ] **Step 4: Implement one immutable registry and exact prefix inspection**

```ts
import { eventCoreMigration } from "./0001-event-core.js";
import { sessionLifecycleMigration } from "./0002-session-lifecycle.js";

export const PROJECT_STORE_MIGRATIONS = Object.freeze([
  eventCoreMigration,
  sessionLifecycleMigration,
] as const);

export const CURRENT_PROJECT_STORE_SCHEMA_VERSION = 2;
```

Validate the complete binary registry before any PRAGMA or DDL. Require `migration.version === index + 1`. Read `schema_migrations` in version order; require row `i` to be version `i + 1` with the exact immutable name and checksum. Map any name/checksum/gap mismatch to `MIGRATION_CHECKSUM_MISMATCH`, not a separate public name error. Verify `project_meta.schema_version === appliedVersion` whenever one identity row exists, and fingerprint the exact prefix before querying any 0002-only table.

An empty database is valid only in `bootstrap-empty` mode. `inspectStoreSchema` is read-only and never sets `application_id`, creates schema, or repairs a partial migration.

- [ ] **Step 5: Implement migration 0002 with exact structural guards**

Start the migration with the trigger replacement; leave migration 0001 bytes unchanged:

```sql
DROP TRIGGER project_meta_no_update;

CREATE TRIGGER project_meta_identity_immutable
BEFORE UPDATE OF singleton, project_id, vault_id, store_id, created_at ON project_meta
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_META_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER project_meta_schema_version_monotonic
BEFORE UPDATE OF schema_version ON project_meta
WHEN NEW.schema_version <> OLD.schema_version + 1
  OR NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = NEW.schema_version
  )
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_META_SCHEMA_VERSION_INVALID');
END;
```

`session_authority` uses primary key `(project_id, session_id)`, unique `(project_id, stream_id)`, `CHECK (stream_id = 'session/' || session_id)`, a composite stream foreign key, and a self-FK to the parent. Store session kind/parent/workspace/client namespace/state; root owner generation; child capability generation/direct-access; keyed continuity fields; complete canonical root-handle/resume-token/child-handle reconstruction groups and verifiers; audit issuance IDs; authority commitment/event position; checkpoint/latest-required groups; revocation group; terminal group; and timestamps. Fixed authority nonces, digests, verifiers, and commitments are lowercase 64-hex; `command_dedup.internal_planned_work_id` uses the same lowercase 64-hex shape. Named insert/update guards enforce complete root/child groups, all-null/all-present grouped fields, and immutable lineage.

Create these exact authority/lease indexes:

```sql
CREATE UNIQUE INDEX session_authority_nonterminal_root_continuity
ON session_authority(project_id, workspace_id, client_namespace, continuity_fingerprint)
WHERE session_kind = 'root' AND terminal_event_position IS NULL;

CREATE INDEX session_authority_parent_terminal
ON session_authority(project_id, parent_session_id, terminal_event_position, session_id);

CREATE INDEX session_authority_safe_resume
ON session_authority(project_id, workspace_id, client_namespace, semantic_state, updated_at, session_id)
WHERE session_kind = 'root' AND terminal_event_position IS NULL;

CREATE UNIQUE INDEX session_leases_one_unreleased
ON session_leases(project_id, session_id)
WHERE released_at IS NULL;
```

`session_leases` stores integer `last_observed_at_ms`, one row per generation, and retained release history. Insert/update plus authority-update triggers require every unreleased row to reference a nonterminal root at exactly the authority's current generation.

`session_evidence_coverage` stores one canonical aggregate per `(project, session, adapter_session)` and rejects more than 200 missing intervals. Immutable `session_evidence_fingerprints` stores one keyed fingerprint per ordinal, unique frame ID, source kind, canonical observation time, fingerprint algorithm/schema/key/domain, batch ID, and recorded event position; it contains no body or evidence reference.

`lifecycle_approval_consumptions` is immutable, unique by approval ID and nonce digest, and permits only `recover-root-authority` or `abandon-root`. `child_transfer_tickets` permits one compare-and-swap claim but no lineage rewrite. `lifecycle_validation_results` is immutable and stores project/session/result/workflow/generation/profile/version/configuration, persisted run ID and runner identity, final-checkpoint ID/fingerprint, versioned validation-start and validation-completion source-state witnesses (scope version plus project/workspace/branch/HEAD/dirty fingerprint), started/completed times, status, normalized exit class, redacted summary, output fingerprint algorithm/schema/key/domain/value, artifact references, freshness result, and a NOT NULL deferred foreign key `recorded_event_position` to its `SessionValidationResultRecorded` event.

SQLite cannot add cross-column table checks to existing tables. Add named `BEFORE INSERT` guards for the new immutable `command_dedup` shape and paired named `BEFORE INSERT` plus `BEFORE UPDATE` guards for mutable workflow/outbox rows. Proof and approval groups are independently optional—do not make them mutually exclusive because abandonment uses both. A Version 2 row has `lifecycle_authorization_kind` equal to `initial-authority`, `protected`, or `internal-workflow`; null means Version 1 only. Initial rows retain both server-derived audiences and generated target session with null proof/approval. Internal rows require the complete workflow/generation/planned-work/claim group and null proof/approval. Protected rows require proof or approval and allow both only for abandonment.

Workflow guards enforce lifecycle identity/generation plus claim owner/token/expiry and retry/failure/backoff group coherence on every update. They permit a terminal `cancelled` row to return to `requested` only while generation increments exactly once and request/policy/trigger/claim/retry/failure/plan groups reset coherently; `abandoned` and `completed` rows can never reopen. `validation_attempt_plan_generation` and `validation_attempt_plans_json` are null together or present together; the latter is canonical JSON, a 1..64-entry array with one exact plan per effective profile, and the former must equal current generation. One complete array is written once per generation and is immutable while generation is unchanged; amendment or cancelled-workflow reopening increments generation and clears the pair atomically before a new array is written.

Outbox guards enforce origin, lifecycle identity, fingerprint, claim/status, and failure/backoff groups on every update. `origin_kind = 'workflow'` requires workflow ID/generation; `origin_kind = 'terminal-event'` requires both null. `materialization_revision` equals `outbox.event_position`, the triggering committed position. Reuse `outbox.claim_token` as the monotonic claim token. Require unique `(project_id, session_id, artifact_kind, materialization_revision)`, recovery/claim indexes ordered by triggering position/workflow ID, and a descending latest-artifact lookup on the same target/revision columns. Add an explicit `BEFORE UPDATE` abort trigger that keeps origin, target key/session/kind/path, legacy kind/payload/content hash, triggering position/revision, workflow binding, and expected/next fingerprint algorithm/schema/key/domain/value byte-immutable while allowing only guarded claim/status/attempt/failure/backoff/acknowledgement fields to change. A completed row retains its exact acknowledgement owner/token/revision/fingerprint tuple; completion cannot null or rewrite it. Hostile direct-update tests cover every immutable group.

- [ ] **Step 6: Make registry application atomic and update fresh bootstrap**

Change `MigrationRunner.apply` to one `BEGIN IMMEDIATE`. Under the lock, re-inspect the exact prefix. For each pending migration: execute its SQL, insert its immutable migration row, then—when exactly one project identity exists—advance `project_meta.schema_version` from the previous version and require `changes === 1n`. Roll back every pending DDL/history/meta change on any failure.

Fresh bootstrap applies the complete registry first, then inserts `project_meta.schema_version = CURRENT_PROJECT_STORE_SCHEMA_VERSION`. Keep store manifest `schemaVersion: 1`. Replace current-schema expectations in bootstrap, worker open, and integrity construction with the canonical registry; retain explicit one-migration fixtures in tests that intentionally build a Version 1 prefix.

- [ ] **Step 7: Run migration, bootstrap, and existing integrity tests**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/migration-registry.test.js dist-test/tests/session-lifecycle-migration.test.js dist-test/tests/migration-runner.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/event-integrity.test.js
npm run typecheck
```

Expected: fresh history is `[1, 2]` once, database schema version is `2`, manifest format remains `1`, every DDL/guard assertion passes, and existing event hashes/responses remain unchanged.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/storage/migrations src/orchestrator/storage/migration-runner.ts src/orchestrator/storage/schema-fingerprint.ts src/orchestrator/storage/schema-compatibility.ts src/orchestrator/storage/project-store-bootstrap.service.ts src/orchestrator/runtime/project-store-worker-backend.ts src/orchestrator/integrity/event-integrity.service.ts tests/migration-registry.test.ts tests/session-lifecycle-migration.test.ts tests/migration-runner.test.ts tests/project-store-bootstrap.test.ts
git commit -m "feat: add lifecycle store schema"
```

---

### Task 4: Make Upgrade Explicit, Fenced, and Integrity-Checked

**Files:**
- Create: `src/orchestrator/storage/project-store-upgrade.service.ts`
- Create: `src/orchestrator/runtime/project-store-upgrade-executor.ts`
- Create: `src/orchestrator/runtime/project-store-upgrade-probe.ts`
- Create: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Create: `tests/project-store-upgrade.test.ts`
- Modify: `src/orchestrator/storage/maintenance-fence.ts`
- Modify: `src/orchestrator/integrity/integrity.types.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Modify: `src/orchestrator/identity/project-binding.service.ts`
- Modify: `src/orchestrator/runtime/project-store-identity-probe.ts`
- Modify: `src/orchestrator/runtime/project-store-executor.ts`
- Modify: `src/orchestrator/runtime/worker-protocol.ts`
- Modify: `src/orchestrator/runtime/project-store-worker-backend.ts`
- Modify: `src/workers/project-store.worker.ts`
- Modify: `src/orchestrator/diagnostics/project-status.service.ts`
- Modify: `src/cli/parse-args.ts`
- Modify: `src/cli/run-command.ts`
- Modify: `tests/maintenance-fence.test.ts`
- Modify: `tests/project-store-executor.test.ts`
- Modify: `tests/event-integrity.test.ts`
- Modify: `tests/cli.orchestrator-admin.test.ts`

**Interfaces:**
- Ordinary identity/open/status/integrity paths call `requireCurrentStoreSchema`; only `ProjectStoreUpgradeProbe` accepts an exact older prefix.
- `ProjectStoreUpgradeService.inspect(context)` is read-only. `apply(context)` re-inspects under a live maintenance fence and never trusts a stale plan.
- `MaintenanceFence.assertReady(connection, lease, now)` requires a current unexpired lease plus acknowledgements and physical-close confirmations for every snapshotted executor.
- `MaintenanceFence.renewOwner(connection, lease, now, trustedTtlMs): MaintenanceLease` compare-and-swaps the same owner/epoch/token, advances expiry monotonically under trusted policy, and returns the lease that must be threaded into every later mutable or post-commit publication boundary; any loss stops that owner immediately.
- `ProjectStoreExecutorRegistry.quiesceStore(context, lease)` drains matching executors without exposing registry internals or opening a transient confirmer connection.
- The upgrade owner connection is explicitly nonregistered and therefore cannot appear in its own required-executor snapshot.
- `EventIntegrityService` accepts `IntegrityExtension[]`; `LifecycleIntegrityService` implements quick and full lifecycle checks.

```ts
export interface ProjectStoreUpgradePlan {
  projectId: string;
  storeId: string;
  appliedVersion: number;
  targetVersion: number;
  pending: readonly { version: number; name: string; checksum: string }[];
  status: "current" | "upgrade-required";
}

export interface ProjectStoreUpgradeResult {
  plan: ProjectStoreUpgradePlan;
  appliedVersions: readonly number[];
  resumedPostCommit: boolean;
  integrity: IntegrityReport;
}

export type ProjectStoreUpgradeFaultBoundary =
  | "after-fence-before-prefix-integrity"
  | "after-0002-ddl-before-migration-row"
  | "after-migration-row-before-project-version"
  | "after-project-version-before-commit"
  | "after-commit-before-full-integrity"
  | "after-full-integrity-before-manifest-record"
  | "after-manifest-record-before-fence-release";

export interface IntegrityExtension {
  quickCheck(context: ProjectContext, sink: IntegrityIssueSink): void;
  fullCheck(context: ProjectContext, sink: IntegrityIssueSink): void;
}
```

- [ ] **Step 1: Write failing ordinary-open compatibility tests**

Build a byte-snapshotted valid Version 1 store, then prove bootstrap inspection, worker open, project status, and ordinary integrity all return `SCHEMA_UPGRADE_REQUIRED` with zero writes. Prove a Version 1 binary registry opening Version 2 returns `SCHEMA_TOO_NEW`; partial DDL/name/checksum/fingerprint drift remains a hard typed failure rather than upgrade-required. Add a quick-integrity case where only `project_meta.schema_version` is corrupt.

- [ ] **Step 2: Write failing explicit-upgrade and recovery tests**

Test dry-run, active executor drain/ack/physical closure, two concurrent upgrade owners, every declared fault boundary, current-schema retry after post-commit failure, manifest-recording failure, expired maintenance lease at every mutable boundary, and handle closure. Use an IPC barrier for the two-upgrader race and a recording connection for the owner-lifetime assertion. Prove the fence-acquisition transaction is committed before quiesce begins, closure confirmations can write while drain waits, the upgrade owner is absent from its own snapshot, owner renewal is a same-epoch/token compare-and-swap that applies only trusted TTL and returns a monotonically later lease, every boundary uses that returned lease, bounded deferred integrity snapshots remain allowed, and a takeover cannot overlap post-commit integrity or manifest publication.

```ts
it("serializes two explicit upgraders and preserves one semantic upgrade", async () => {
  const store = await createV1Store();
  const barrier = new ProcessBarrier(2);
  const [left, right] = await Promise.all([
    runUpgradeChild(store, barrier),
    runUpgradeChild(store, barrier),
  ]);
  assert.deepEqual(
    [left.appliedVersions, right.appliedVersions].sort((a, b) => b.length - a.length),
    [[2], []],
  );
  assert.equal(readProjectSchemaVersion(store), 2);
  assert.deepEqual(readMigrationVersions(store), [1, 2]);
  assert.equal((await fullIntegrity(store)).ok, true);
});
```

- [ ] **Step 3: Run the focused tests and observe missing upgrade behavior**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/project-store-upgrade.test.js dist-test/tests/event-integrity.test.js dist-test/tests/maintenance-fence.test.js dist-test/tests/project-store-executor.test.js dist-test/tests/cli.orchestrator-admin.test.js
```

Expected: tests fail because valid-prefix errors are collapsed, the upgrade operation/role is absent, and lifecycle integrity extensions are not implemented.

- [ ] **Step 4: Preserve schema compatibility errors and extend integrity**

Add `SCHEMA_UPGRADE_REQUIRED`, `SCHEMA_TOO_NEW`, `MIGRATION_CHECKSUM_MISMATCH`, and `SCHEMA_FINGERPRINT_MISMATCH` to the binding/probe safe failure path. The ordinary identity probe still requires current schema; the separate upgrade probe verifies identity plus an exact prefix and returns its plan without creating or changing files.

Add these integrity issue codes:

```ts
export const LIFECYCLE_INTEGRITY_ISSUE_CODES = [
  "COMMAND_AUTHORIZATION_METADATA_MISMATCH",
  "SESSION_AUTHORITY_FOLD_MISMATCH",
  "SESSION_LEASE_INVARIANT_MISMATCH",
  "SESSION_EVIDENCE_COVERAGE_MISMATCH",
  "LIFECYCLE_APPROVAL_CONSUMPTION_MISMATCH",
  "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
  "LIFECYCLE_VALIDATION_RESULT_MISMATCH",
  "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
] as const;
```

Quick mode validates application/meta/schema prefix, authorization-kind tuple shape, latest authority commitment/event linkage, unreleased lease generation, and active workflow/outbox revision shape. Full mode folds every lifecycle stream and compares kind, parent, state, generations, commitment, checkpoint marker, revocation, and terminal fields; it then verifies coverage aggregates against immutable ordinal rows, complete approval-consumption tuples, transfer claims, validation bindings, workflow claims, and immutable materialization-revision/fingerprint history.

Keep existing Version 1 command-hash reconstruction for rows whose lifecycle authorization tuple is all null. For Version 2, reconstruct the authoritative intent from the complete typed semantic event payload plus persisted nonsecret audience/session assertions; never pass a V2 `intentHash` through the V1 command-hash algorithm.

- [ ] **Step 5: Implement the dedicated upgrade owner and maintenance readiness**

Add worker role `upgrade` with one writable, nonregistered connection held from fence acquisition through full post-commit integrity, parent manifest recording, fence release, and close. The parent routes every executor's existing `MaintenanceClosureConfirmation` back to that owner connection in separate short transactions. Never create a short-lived connection to confirm closure and never register the upgrade owner as a normal executor.

The apply state machine is exact:

```text
read-only exact-prefix inspect
owner BEGIN IMMEDIATE: acquire maintenance fence and snapshot required executors
owner COMMIT before any wait
request quiesce, await acknowledgement and physical close
record acknowledgements/physical-close confirmations in separate short owner transactions
renew same owner/epoch/token lease with trusted TTL and replace the in-memory lease; assert every required executor closed
run full prefix integrity with registry.slice(0, appliedVersion)
renew and replace the live owner lease
MigrationRunner.apply(ownerConnection, PROJECT_STORE_MIGRATIONS, clock.now(), { kind: "explicit-upgrade", expectedAppliedVersion: plan.appliedVersion })
renew and replace the live owner lease
run full current-registry integrity including lifecycle invariants
renew and replace the live owner lease
record the integrity manifest through the same fenced owner while its connection remains open
renew and release the exact owner/epoch/token in a short transaction
close worker connection and every filesystem handle
```

No long-lived maintenance or write transaction is open while waiting for quiesce, filesystem work, integrity scans, or manifest I/O. `EventIntegrityService` may own its existing bounded `BEGIN DEFERRED` read snapshot so one integrity report sees one state. If the schema is already current after a crash, set `resumedPostCommit: true`, reacquire or recover only an expired/stale fence using its existing fencing rules, renew/recheck with the returned lease before each remaining boundary, rerun full integrity and fenced manifest recording, then release. Never label committed Version 2 as Version 1 and never roll back after commit.

- [ ] **Step 6: Add explicit CLI inspection and apply**

Add `orchestrator-upgrade` to the command union/help. With no `--apply`, establish the maintenance binding, run only the read-only upgrade probe, print `ProjectStoreUpgradePlan`, and close. With `--apply`, invoke the dedicated upgrade executor and print `ProjectStoreUpgradeResult`. `orchestrator-init`, `orchestrator-status`, `orchestrator-integrity`, MCP startup, and any ordinary open must never call `MigrationRunner.apply`.

- [ ] **Step 7: Run compatibility, upgrade, integrity, and handle gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/project-store-upgrade.test.js dist-test/tests/migration-registry.test.js dist-test/tests/session-lifecycle-migration.test.js dist-test/tests/event-integrity.test.js dist-test/tests/maintenance-fence.test.js dist-test/tests/project-store-executor.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/cli.orchestrator-admin.test.js
npm run typecheck
```

Expected: dry-run writes zero bytes; one concurrent upgrader applies version 2; pre-commit faults leave exact Version 1; post-commit faults resume verification/manifest/fence release; quick/full integrity pass; every database can be renamed after closure.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/storage/project-store-upgrade.service.ts src/orchestrator/runtime/project-store-upgrade-executor.ts src/orchestrator/runtime/project-store-upgrade-probe.ts src/orchestrator/storage/maintenance-fence.ts src/orchestrator/integrity src/orchestrator/identity/project-binding.service.ts src/orchestrator/runtime/project-store-identity-probe.ts src/orchestrator/runtime/project-store-executor.ts src/orchestrator/runtime/worker-protocol.ts src/orchestrator/runtime/project-store-worker-backend.ts src/workers/project-store.worker.ts src/orchestrator/diagnostics/project-status.service.ts src/cli/parse-args.ts src/cli/run-command.ts tests/project-store-upgrade.test.ts tests/maintenance-fence.test.ts tests/project-store-executor.test.ts tests/event-integrity.test.ts tests/cli.orchestrator-admin.test.ts
git commit -m "feat: add explicit lifecycle store upgrade"
```

---

### Task 5: Extract the Transaction-Scoped Event Writer and Lifecycle Transaction Stores

**Files:**
- Create: `src/orchestrator/storage/event-append-transaction.ts`
- Create: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Create: `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- Create: `tests/event-append-transaction.test.ts`
- Create: `tests/lifecycle-command-store.test.ts`
- Create: `tests/lifecycle-operational-store.test.ts`
- Modify: `src/orchestrator/storage/event-store.ts`
- Modify: `src/orchestrator/contracts/event.ts`
- Modify: `src/orchestrator/crypto/event-hash.ts`
- Modify: `tests/event-store.test.ts`
- Modify: `tests/event-store.crash.test.ts`

**Interfaces:**
- `EventAppendTransaction` contains validation, replay lookup, stream/event/outbox insertion, response building, and dedup insertion, but never executes `BEGIN`, `COMMIT`, or `ROLLBACK`.
- Existing `EventStore.append` keeps its public API, transaction ownership, fault boundaries, retry behavior, and Version 1 `commandHash`; it delegates its inside-transaction work to `EventAppendTransaction`.
- `LifecycleCommandStore.execute` is the only semantic lifecycle transaction owner. It recomputes authoritative intent before entering, checks exact dedup before current authority, exposes focused repositories rather than raw SQLite, commits public-only results, and maps uncertain commit outcomes to the original command identity.
- `LifecycleOperationalStore.execute` is the only nonsemantic lifecycle transaction owner. It accepts an exact trusted workflow/outbox work identity, exposes only focused operational facades, never exposes event append, authority, validation, arbitrary SQL, or `command_dedup`, and maps uncertain commit outcomes to that unchanged work identity.

```ts
export type LifecycleCommandOrigin =
  | {
      kind: "initial-authority";
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    }
  | {
      kind: "protected";
      proof: null | { version: 1; nonce: string; digest: string };
      approval: null | { approvalId: string; digest: string };
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    }
  | {
      kind: "internal-workflow";
      workflowId: string;
      workflowGeneration: bigint;
      plannedWorkId: string;
      claimOwnerId: string;
      claimToken: bigint;
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    };

export type PersistedLifecycleAuthorizationRecord =
  | (Extract<LifecycleCommandOrigin, { kind: "initial-authority" }> & {
      authorizationSessionId: null;
      targetSessionId: string;
      proof: null;
      approval: null;
    })
  | Extract<LifecycleCommandOrigin, { kind: "protected" | "internal-workflow" }>;

export type LifecycleReplayExpectation =
  | Extract<LifecycleCommandOrigin, { kind: "initial-authority" | "protected" }>
  | {
      kind: "internal-workflow";
      workflowId: string;
      workflowGeneration: bigint;
      plannedWorkId: string;
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    };

export interface LifecycleCommandEnvelope {
  context: ProjectContext;
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  candidateIntentHash: string;
  authoritativeIntentHash: string;
  replayExpectation: LifecycleReplayExpectation;
}

export interface PreparedLifecycleCommit<T extends JsonValue> {
  append: AppendCommand<T>;
  authorizationRecord: PersistedLifecycleAuthorizationRecord;
  beforeAppend?(
    planned: PlannedEventAppend<T>,
    transaction: LifecycleCommandTransaction,
  ): void;
  afterAppend(
    committed: EventAppendBatch<T>,
    transaction: LifecycleCommandTransaction,
  ): void;
}

export interface LifecycleCommandTransaction {
  readonly authority: ConnectionBoundSessionAuthority;
  readonly leases: ConnectionBoundSessionLeases;
  readonly approvals: ConnectionBoundLifecycleApprovals;
  readonly transfers: ConnectionBoundChildTransfers;
  readonly coverage: ConnectionBoundEvidenceCoverage;
  readonly workflows: ConnectionBoundSessionEndWorkflows;
  readonly validation: ConnectionBoundValidationResults;
  readonly outbox: ConnectionBoundLifecycleOutbox;
}

export class LifecycleCommandStore {
  execute<T extends JsonValue>(
    command: LifecycleCommandEnvelope,
    onNew: (transaction: LifecycleCommandTransaction) => PreparedLifecycleCommit<T>,
  ): LifecycleExecutionResult<T>;
}

export type LifecycleOperationalWorkIdentity =
  | WorkflowOperationalWorkIdentity
  | OutboxOperationalWorkIdentity;

export interface LifecycleOperationalTransaction {
  readonly workflows: ConnectionBoundSessionEndWorkflowOperations;
  readonly outbox: ConnectionBoundLifecycleOutboxOperations;
}

export class LifecycleOperationalStore {
  execute<T extends JsonValue>(
    work: LifecycleOperationalWorkIdentity,
    onCurrent: (transaction: LifecycleOperationalTransaction) => T,
  ): LifecycleOperationalResult<T>;
}
```

`plannedWorkId` is lowercase 64-hex SHA-256 over canonical JSON with an exact domain: `pm-lifecycle-internal-validation-work-v1` binds workflow/generation/result/command/idempotency identity, while `pm-lifecycle-internal-phase-work-v1` binds workflow/generation/source phase/action/command/idempotency identity. It is nonsecret, persisted in `command_dedup`, and never includes the volatile claim owner/token.

- [ ] **Step 1: Write failing extraction-parity tests**

Move no existing assertions yet. Add a recording `SqliteConnection` around the current event-store fixture and prove `EventAppendTransaction` emits no transaction statements while `EventStore.append` still emits exactly one begin/commit, produces byte-identical stored responses/hashes, deduplicates exact retry, rolls back injected failures, and preserves `COMMAND_OUTCOME_UNKNOWN` after an uncertain commit.

- [ ] **Step 2: Write failing lifecycle atomicity/dedup-order tests**

Create a Version 2 database and one root authority fixture. Assert:

- an exact rotating-command replay matches intent hash, proof nonce/digest, approval ID/digest when present, both audience tuples, authority/target sessions, and stable project/vault/store/workspace/namespace binding before consulting current generation; it does not compare binding generation, branch/HEAD/dirty state, or a whole-context fingerprint;
- an initial-authority replay uses a nonpersisted replay expectation, matches its retained Version 2 kind/audiences/intent, adopts the stored generated target session, never invokes `onNew` or a session-ID generator, and can never be mistaken for a Version 1 null tuple;
- an internal-workflow replay matches workflow/generation/stable planned-work identity before current claim inspection, validates that the stored authorization record contains the original claim fence, and cannot be fabricated by the external wire decoder;
- after a committed internal result response is lost, exact replay still succeeds after claim expiry or takeover without invoking `onNew`; a different planned-work identity conflicts;
- a new command verifies the current authority inside the transaction;
- abandonment may match both proof and approval witnesses;
- event, authority, lease, workflow, outbox, approval consumption, and dedup either all commit or all roll back;
- dedup response JSON and database text contain no bearer, raw proof MAC, or raw approval; and
- the lifecycle store has no `EventStore` dependency and cannot call `EventStore.append`.
- transaction callbacks cannot access a raw connection, `prepare`, `exec`, arbitrary SQL, or a second event append seam; a compile-time negative fixture proves `tx.events`, `tx.events.append`, and raw connection methods do not exist.
- the operational store owns exactly one begin/commit for workflow/outbox CAS, does not query or write `command_dedup`, cannot append an event, and returns `OPERATION_OUTCOME_UNKNOWN` with the original work identity after uncertain commit.

```ts
it("replays a rotating command before checking now-stale authority", () => {
  const fixture = lifecycleStoreFixture();
  const first = fixture.store.execute(fixture.resumeEnvelope(), fixture.rotateOwner);
  fixture.authority.advanceToGeneration(3n);
  const replay = fixture.store.execute(fixture.resumeEnvelope(), () => {
    throw new Error("fresh path must not run");
  });
  assert.equal(first.publicResult.eventPosition, replay.publicResult.eventPosition);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.authorityMaterialStatus, "stale");
});
```

- [ ] **Step 3: Run the focused tests and observe nested-transaction seam failure**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-append-transaction.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/event-store.test.js dist-test/tests/event-store.crash.test.js
```

Expected: new tests fail because every append primitive and transaction boundary is private to `EventStore.append`, and no isolated nonsemantic lifecycle transaction owner exists.

- [ ] **Step 4: Extract event preparation and inside-transaction primitives**

Move strict command validation, stored-response decoding, event materialization, and prepared statements without changing their canonical inputs. Use this contract:

```ts
export interface PreparedEventAppend<T extends JsonValue> {
  command: AppendCommand<T>;
  recordedAt: string;
  commandHash: string;
  storedEventIds: readonly string[];
}

export interface EventAppendBatch<T extends JsonValue> {
  events: readonly StoredEvent[];
  storedResponse: StoredCommandResponse<T>;
  responseHash: string;
}

export interface PlannedEventAppend<T extends JsonValue> extends EventAppendBatch<T> {
  readonly plannedOnly: true;
}

export interface EventAppendReplay<T extends JsonValue> extends AppendResult<T> {
  authorizationRecord: PersistedLifecycleAuthorizationRecord | null;
}

export class EventAppendTransaction {
  prepare<T extends JsonValue>(
    command: AppendCommand<T>,
    recordedAt: string,
    commandHashOverride?: string,
  ): PreparedEventAppend<T>;

  findReplay<T extends JsonValue>(
    prepared: PreparedEventAppend<T>,
    expectation: LifecycleReplayExpectation | null,
  ): EventAppendReplay<T> | null;

  planPrepared<T extends JsonValue>(
    prepared: PreparedEventAppend<T>,
  ): PlannedEventAppend<T>;

  appendPlanned<T extends JsonValue>(
    planned: PlannedEventAppend<T>,
  ): EventAppendBatch<T>;

  insertDedup<T extends JsonValue>(
    prepared: PreparedEventAppend<T>,
    batch: EventAppendBatch<T>,
    authorization: PersistedLifecycleAuthorizationRecord | null,
  ): void;
}
```

For Version 1, `commandHashOverride` and replay expectation are absent and the current canonical hash is unchanged. For Version 2, the override is the authoritative lifecycle `intentHash`; replay uses `LifecycleReplayExpectation`, while only `insertDedup` accepts a complete persisted authorization record. An initial expectation has no generated target session: `findReplay` compares kind and both audiences, then adopts and validates the stored target session/response without invoking the fresh callback. An internal expectation compares stable planned work and audiences; the volatile current claim assertion is excluded from `intentHash` and replay input, retained only for a fresh-path live check, while the claim actually authorizing the commit is stored for audit. Lifecycle append plans are privately materialized after the aggregate fold; no caller-selected stream version reaches `planPrepared` or `appendPlanned`.

Raw repository classes may keep connection-taking methods internally and in repository-focused tests. `LifecycleCommandStore` constructs connection-bound facades over its private connection; service callbacks receive only `LifecycleCommandTransaction`, whose methods omit the connection argument and expose no SQL escape hatch.

- [ ] **Step 5: Implement one lifecycle transaction and exact replay tuple**

Reject candidate/authoritative intent mismatch before proof verification or dedup replay. Then execute this exact order:

```text
BEGIN IMMEDIATE (semantic store)
find command_dedup by (projectId, idempotencyKey)
  if present: compare commandId + intentHash + complete replay expectation/binding tuple
              initial-authority compares retained audiences and reuses stored generated target
              internal-workflow compares stable workflow/generation/plannedWorkId,
              requires a complete stored original claim fence, but does not require that claim to remain live
              ROLLBACK read transaction and return stored public effect
reject reused commandId
assert maintenance append is allowed
run onNew: fold event stream, compare authority mirror, then either
           verify current proof/approval or verify live internal workflow claim
privately materialize exact event positions/hashes under the same write lock
run optional beforeAppend with planned positions for trigger-ordered authority/lease CAS
append only that privately planned server-built event batch
run afterAppend for coverage/workflow/outbox/approval/result changes using committed positions
insert public-only command_dedup with origin kind and complete nonsecret assertions
COMMIT
return public effect plus ephemeral authority-material descriptor/status
```

The initial-authority fresh path generates the target session in the worker and records it in `authorizationRecord`; exact replay does not accept a caller target assertion and never runs `onNew`. `EventAppendTransaction` remains private to the semantic store, and neither lifecycle callbacks nor `LifecycleCommandTransaction` expose an append method. For internal workflow commands, the trusted runtime constructs the stable replay expectation from a persisted or deterministically derived planned-work identity before `execute`; only a dedup miss enters `onNew`, verifies the current live workflow-generation/claim, and creates the complete persisted `internal-workflow` authorization record. This permits exact committed replay after the original claim expires while still rejecting a fresh stale-claim mutation. No external decoder accepts either form. Make authority/result event-position foreign keys deferred where trigger-safe pre-append mutation requires same-transaction forward references, and assert every planned position equals the inserted position before dedup/commit.

Implement `LifecycleOperationalStore` over the same private ActiveStore connection. It wraps one `BEGIN IMMEDIATE` around only exact workflow claim/renew/release/eventless-phase or outbox claim/renew/materialize/failure operations, delegates idempotency to fenced row state, commits before success, and never calls `EventAppendTransaction`. A rollback failure or uncertain non-busy commit returns `OPERATION_OUTCOME_UNKNOWN` with the exact supplied workflow/revision/owner/token identity. Its materialize callback may use only the focused outbox facade; Task 16 binds replace-and-ack into that one operation.

Exact replay compares the original command's persisted semantic branch assertion as part of `intentHash`, but does not require current branch/HEAD/dirty state or binding generation to equal the post-commit environment. Current branch/source compatibility checks run only on the fresh path after dedup has missed.

If rollback fails or a non-busy commit attempt throws, return `COMMAND_OUTCOME_UNKNOWN` with the original `commandId` and `idempotencyKey`. Do not generate or retry with replacement identity.

- [ ] **Step 6: Run event parity, lifecycle atomicity, and crash gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-append-transaction.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/event-store.test.js dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js
npm run typecheck
```

Expected: every existing Version 1 append hash/result stays unchanged; semantic and operational stores each prove one effect or zero; exact stale-authority/internal-workflow replay succeeds only with the original stable expectation.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/storage/event-append-transaction.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/lifecycle/lifecycle-operational.store.ts src/orchestrator/storage/event-store.ts src/orchestrator/contracts/event.ts src/orchestrator/crypto/event-hash.ts tests/event-append-transaction.test.ts tests/lifecycle-command-store.test.ts tests/lifecycle-operational-store.test.ts tests/event-store.test.ts tests/event-store.crash.test.ts
git commit -m "refactor: share atomic event append primitives"
```

---

### Task 6: Implement Capability, Proof, Approval, and Authority Commitments

**Files:**
- Create: `src/orchestrator/lifecycle/lifecycle-intent.ts`
- Create: `src/orchestrator/lifecycle/authority/redacted-secret.ts`
- Create: `src/orchestrator/lifecycle/authority/capability-key-provider.ts`
- Create: `src/orchestrator/lifecycle/authority/capability-codec.ts`
- Create: `src/orchestrator/lifecycle/authority/approval-codec.ts`
- Create: `src/orchestrator/lifecycle/authority/authority-commitment.ts`
- Create: `src/orchestrator/lifecycle/capability.service.ts`
- Create: `tests/support/lifecycle-authority-reference.ts`
- Create: `tests/lifecycle-intent.test.ts`
- Create: `tests/capability-service.test.ts`
- Create: `tests/lifecycle-approval.test.ts`

**Interfaces:**
- Consumes: canonical JSON, `ProjectContext`, lifecycle semantic DTOs, server-derived audiences, injected `CapabilityKeyProvider`, injected deterministic nonce/UUID source, and injected clock.
- Produces: `CapabilityClaimsV1`, `CapabilityProofV1`, `SemanticCommandProofTargetV1`, `BoundedOperationProofTargetV1`, `RecoveryApprovalClaimsV1`, `AbandonmentApprovalClaimsV1`, `AuthorityMaterialDescriptorV1`, `AuthorityMaterialStatus`, and pure intent/commitment functions.
- Provider operations are purpose-scoped and never return key bytes. Production construction fails if no durable external provider profile is configured.

```ts
export type CapabilityKind =
  | "root-session-handle"
  | "root-resume-token"
  | "child-session-handle";

export type CapabilityKeyPurpose =
  | CapabilityKind
  | "child-binding-grant"
  | "continuity-index"
  | "evidence-fingerprint"
  | "validation-output-fingerprint"
  | "materialization-fingerprint"
  | "recovery-approval"
  | "abandonment-approval"
  | "pending-authorization-encryption";

export interface CapabilityKeyProvider {
  currentKey(scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef;
  status(scope: KeyScope, purpose: CapabilityKeyPurpose, keyId: string):
    | "available" | "revoked" | "unavailable";
  mac(input: KeyedMacInput): Uint8Array;
  verify(input: KeyedVerifyInput): boolean;
  fingerprint(input: KeyedFingerprintInput): string;
  seal(input: KeyedSealInput): SealedValueV1;
  open(input: KeyedOpenInput): Uint8Array;
}
```

- [ ] **Step 1: Write failing golden intent and proof tests**

Use a deterministic test provider and fixed timestamps/nonces. Golden tests must prove:

- every semantic input and stable identity/audience assertion changes `intentHash`;
- proof value, proof nonce/digest, bearer, ephemeral `projectBindingId`, binding generation, branch name, Git HEAD, and raw evidence do not enter `intentHash`;
- semantic-command and bounded-operation targets cannot verify across domains;
- root handle binds one primary client, resume token is portable but use-time proof binds presenter and target primary, and child handle binds its exact untrusted child;
- HKDF parameters and base64url/canonical-claims bytes are stable; and
- invalid structure and invalid MAC return the same safe capability error.

Create `tests/support/lifecycle-authority-reference.ts` as an independent Node-core `hkdfSync`/`createHmac` reference implementation, not an import from production crypto. At runtime it constructs a complete four-segment synthetic `pmcap1` byte string from fixed canonical key-ID/claims/invalid-capability-MAC components. The string is deliberately not issued and must fail capability verification, but proof derivation still consumes its exact complete UTF-8 serialization. The test compares the production proof MAC and safe proof digest against independently computed runtime bytes, then zeroes all reference buffers and destroys the `SecretString`. No bearer, raw proof, approval, or expected MAC is committed to a fixture, snapshot, or log. A separate nonsecret intent vector commits only canonical input JSON and the expected SHA-256 digest.

- [ ] **Step 2: Write failing approval, commitment, rotation, and privacy tests**

Test strict `pmrap1` recovery and abandonment claims, action-domain separation, ten-minute maximum lifetime, expiry under fake clock, executor/target mismatch, intent mismatch, constant-time verification path, and missing/revoked historical key failure. Test that every reconstruction/continuity/audience/revocation/terminal field changes authority commitment while audit-only issuance binding IDs do not. Assert `JSON.stringify`, structured clone, error formatting, and snapshots never reveal `SecretString`.

- [ ] **Step 3: Run the focused tests and observe missing cryptographic modules**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-intent.test.js dist-test/tests/capability-service.test.js dist-test/tests/lifecycle-approval.test.js
```

Expected: build fails because the lifecycle authority modules do not exist.

- [ ] **Step 4: Implement redacted live-secret and provider boundaries**

```ts
export class SecretString {
  #value: string | null;

  static from(value: string): SecretString {
    if (value.length === 0) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    return new SecretString(value);
  }

  private constructor(value: string) { this.#value = value; }

  withValue<T>(operation: (value: string) => T): T {
    if (this.#value === null) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    return operation(this.#value);
  }

  destroy(): void { this.#value = null; }
  toString(): "[REDACTED]" { return "[REDACTED]"; }
  toJSON(): undefined {
    if (process.env.NODE_ENV !== "production") throw new Error("SECRET_SERIALIZATION_BLOCKED");
    return undefined;
  }
}
```

The provider receives exact `{ projectId, storeId, purpose, keyId, domain, bytes }` requests, performs MAC/verify/fingerprint/seal/open internally, and exposes only opaque key IDs plus outputs. No process-random default is provided. Tests may use a deterministic in-memory provider whose fixture values are discarded and never written to snapshots.

- [ ] **Step 5: Implement canonical intent, capability wire format, and proofs**

`lifecycleIntentHash` is exactly SHA-256 of canonical JSON, with no additional prefix. Its object includes the complete decoded semantic command draft plus resolved project/vault/store/workspace/client namespace, authority/target session IDs when applicable, capability kind/generation when applicable, and both server-derived audience tuples; it excludes authorization material itself.

Issue the bearer as exactly:

```text
pmcap1.BASE64URL(KEY_ID_UTF8).BASE64URL(CANONICAL_CLAIMS_UTF8).BASE64URL(HMAC_SHA256)
```

Claims contain capability version/key, project/vault/store/workspace/client namespace/session, kind, generation, issuedAt, policy, expiry, nonce, and kind-specific role/client audience. Strict decoding rejects padding, noncanonical base64url, unknown claim fields, noncanonical JSON/timestamps/UUIDs, wrong purpose, or claims that re-encode to different bytes.

Derive proof keys with this exact code contract:

```ts
const PROOF_DOMAIN = Buffer.from("pm-lifecycle-command-proof-v1", "utf8");
const ZERO_SALT = Buffer.alloc(32, 0);

export function proofKey(bearer: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(bearer, "utf8"),
    ZERO_SALT,
    PROOF_DOMAIN,
    32,
  ));
}
```

The semantic proof MAC covers canonical `SemanticCommandProofTargetV1` prefixed by the same domain bytes. The bounded-operation target covers operation type/ID/request ID/hash, authority/target sessions, both audiences, generation, nonce, and policy-limited expiry; it contains no command identity and never enters semantic dedup. Compare fixed-length MACs with `timingSafeEqual`. Persist only canonical proof nonce and `SHA-256("project-memory/proof-digest/v1\n" || proofMacBytes)`.

- [ ] **Step 6: Implement signed approvals and authority commitments**

Use strict wire `pmrap1.KEY_ID.CLAIMS.MAC` with separate provider purpose/domain for recovery and abandonment. Recovery claims contain approval version/ID/action, exact project/vault/store/workspace/root session/current generation, command/idempotency/intent, executor role/client, target primary/client, issue/expiry, 256-bit nonce, allowlisted reason, and redacted approval reference. Abandonment has action `abandon-root` and is accepted only alongside a current root-handle proof in the command authorization tuple.

`authorityCommitment` hashes a canonical object containing all fields approved in Section 10.3 and excludes only audit issuance binding IDs:

```ts
export function authorityCommitment(authority: CommittedAuthorityV1): string {
  return createHash("sha256")
    .update(`project-memory/authority-commitment/v1\n${canonicalJson(authority)}`, "utf8")
    .digest("hex");
}
```

`CapabilityService` may reconstruct a current bearer transiently only inside worker proof verification for a command that actually presents a capability proof, using the recorded historical key/purpose and exact stored claims; it destroys those bytes immediately and never substitutes the current key. Descriptor generation—including approval-only maintenance recovery—uses stored canonical claims/commitment plus opaque provider verifier operations and never reconstructs the target bearer. Only the authenticated target adapter reconstructs for delivery. A missing/revoked key returns stale status with `SESSION_CAPABILITY_KEY_UNAVAILABLE`.

- [ ] **Step 7: Run cryptographic, privacy, and type gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-intent.test.js dist-test/tests/capability-service.test.js dist-test/tests/lifecycle-approval.test.js
npm run typecheck
```

Expected: golden vectors, audience/domain separation, expiry, commitment coverage, key-revocation, and secret serialization tests all pass.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/lifecycle/lifecycle-intent.ts src/orchestrator/lifecycle/authority src/orchestrator/lifecycle/capability.service.ts tests/support/lifecycle-authority-reference.ts tests/lifecycle-intent.test.ts tests/capability-service.test.ts tests/lifecycle-approval.test.ts
git commit -m "feat: secure lifecycle authority proofs"
```

---

### Task 7: Persist Exact Private Retry Inputs and Route Authority Material

**Files:**
- Create: `src/orchestrator/lifecycle/authority/pending-authorization.store.ts`
- Create: `src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.ts`
- Create: `src/orchestrator/lifecycle/authority/authority-material-adapter.ts`
- Create: `tests/private-retry-store.test.ts`
- Create: `tests/authority-material-adapter.test.ts`
- Modify: `src/orchestrator/lifecycle/authority/capability-key-provider.ts`

**Interfaces:**
- `EncryptedPendingAuthorizationStore` stores sealed records below one explicit trusted-host private state root, never below the project vault/store, and uses exclusive temp files, file fsync, atomic same-directory replace, and parent-directory fsync.
- `AuthorityMaterialAdapter` accepts a decoded command draft, transport-private authorization, and a revalidated trusted context. It derives audiences itself, computes the candidate intent with the shared pure canonicalizer, persists the complete canonical draft plus exact proof/approval before posting, and deletes the pending record only after a terminal worker response. A local target adapter reconstructs/verifies its descriptor with the external provider; any different presenter routes the descriptor to that target without reconstructing it.

```ts
export type PendingPrivateAuthorization =
  | { kind: "initial-authority"; proof: null; approval: null; childBindingGrant: null }
  | { kind: "protected"; proof: CapabilityProofV1 | null; approval: SecretString | null; childBindingGrant: SecretString | null };

export interface StableLifecycleBindingWitnessV1 {
  projectId: string;
  vaultId: string;
  storeId: string;
  workspaceId: string;
  clientNamespace: string;
  audience: LifecycleAudience;
}

export interface PendingSemanticCommandRecordV1 {
  recordVersion: 1;
  projectId: string;
  storeId: string;
  commandId: string;
  idempotencyKey: string;
  command: LifecycleSemanticCommandDraft;
  authoritySessionId: string | null;
  targetSessionId: string | null;
  stableBinding: StableLifecycleBindingWitnessV1;
  candidateIntentHash: string;
  authorization: PendingPrivateAuthorization;
  createdAt: string;
}

export interface PendingAuthorizationStore {
  put(record: PendingSemanticCommandRecordV1): Promise<void>;
  get(projectId: string, commandId: string, idempotencyKey: string): Promise<PendingSemanticCommandRecordV1 | null>;
  list(projectId: string): Promise<readonly PendingSemanticCommandRecordV1[]>;
  delete(projectId: string, commandId: string, idempotencyKey: string): Promise<void>;
}

export interface PrivateAuthorityChannel {
  isAttached(target: LifecycleAuthorityTarget): boolean;
  isLocalTarget(target: LifecycleAuthorityTarget): boolean;
  deliverLocal(target: LifecycleAuthorityTarget, material: RootOrChildAuthorityMaterial): Promise<void>;
  routeDescriptor(target: LifecycleAuthorityTarget, descriptor: AuthorityMaterialDescriptorV1): Promise<void>;
}
```

- [ ] **Step 1: Write failing encrypted-store crash and privacy tests**

Test write/reopen/read/delete; same identity plus different plaintext rejection; corrupt/torn/seal-key-missing files; injected death before and after replace; concurrent writers; path containment; and Windows rename/handle closure. Scan every retained file and error string for the bearer, proof MAC, approval, child-binding grant, provider fixture key, and semantic input. The only on-disk record must be a strict envelope `{ version, keyId, algorithm, nonce, ciphertext, tag }` returned by the provider's `seal` operation.

- [ ] **Step 2: Write failing adapter retry, descriptor, and target-routing tests**

Prove the adapter:

- writes the pending record before worker `postMessage`;
- persists enough encrypted canonical input to reconstruct both initial and protected commands without asking a caller to recreate omitted fields;
- reuses the exact command ID, idempotency key, proof nonce/MAC, approval, fork-only child-binding grant, intent hash, and audience after simulated restart;
- rejects resume when stable project/vault/store/workspace/namespace fields or server-derived audience differ from the sealed witness, but permits binding-generation, branch, HEAD, dirty-state, and whole-context fingerprint changes;
- retains the record after timeout, worker death, or `COMMAND_OUTCOME_UNKNOWN`;
- deletes it after success or a terminal typed rejection;
- rejects unknown/extra/tampered descriptor fields and verifier mismatch;
- delivers a fork result only to its granted untrusted child;
- lets a maintenance presenter route only the descriptor to the approval's attached primary target adapter;
- lets a fork presenter route only the descriptor to the granted child adapter; and
- proves with provider spies that maintenance and every non-target source adapter make zero reconstruction/verifier calls and never receive a bearer.

- [ ] **Step 3: Run focused tests and observe missing private-state implementation**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/private-retry-store.test.js dist-test/tests/authority-material-adapter.test.js
```

Expected: build fails because the pending-store and authority adapter modules do not exist.

- [ ] **Step 4: Implement sealed atomic pending records**

Derive the record path from domain-separated hashes of project/store/command/idempotency identity, never from raw caller strings. Validate that configured `privateStateRoot` is absolute/canonical and every derived path remains contained after parent `realpath`. Use the existing directory durability pattern.

```ts
export interface PendingAuthorizationEnvelopeV1 {
  version: 1;
  keyId: string;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
```

Canonicalize the plaintext record in memory, call provider `seal` under purpose `pending-authorization-encryption`, destroy temporary secret buffers, write the envelope with mode `0o600`, fsync, replace, and fsync the directory. On open, strict-decode the envelope, provider-open it, strict-decode the plaintext, and confirm its identity matches the requested path. Do not silently skip corrupt entries from `list`; fail closed with `SESSION_CAPABILITY_INVALID`.

- [ ] **Step 5: Implement proof preparation, descriptor reconstruction, and delivery**

```ts
export class AuthorityMaterialAdapter {
  async prepare(
    command: LifecycleSemanticCommandDraft,
    authorization: PrivateLifecycleAuthorization,
    context: RevalidatedTrustedLifecycleContext,
  ): Promise<PreparedLifecycleWorkerCommand>;

  async resumePending(
    identity: PendingCommandIdentity,
    context: RevalidatedTrustedLifecycleContext,
  ): Promise<PreparedLifecycleWorkerCommand>;

  async complete<T extends JsonValue>(
    identity: PendingCommandIdentity,
    result: WorkerLifecycleResult<T>,
  ): Promise<LifecycleExecutionResult<T>>;

  async acceptRoutedDescriptor(
    target: LifecycleAuthorityTarget,
    descriptor: AuthorityMaterialDescriptorV1,
  ): Promise<void>;
}
```

`PrivateLifecycleAuthorization` is a trusted union: `{ kind: "initial-authority" }` or `{ kind: "protected"; bearer: SecretString | null; approval: SecretString | null; childBindingGrant: SecretString | null }`. `prepare` strict-decodes the draft, derives presenter/target audiences from revalidated context plus trusted grant/approval routing, computes candidate intent, derives the proof without placing the bearer in the worker DTO, seals the complete pending record, then returns the prepared worker command. For initial authority, session IDs and proof/approval/grant remain null in the pending record; the worker-generated target session is learned only from the committed result.

`resumePending` loads the complete sealed draft and authorization, revalidates context, re-derives audiences and candidate intent, compares only the stored stable binding fields/audiences plus original semantic assertions, and returns the original prepared command identity. It never accepts a replacement draft or caller-supplied audience, and it never compares binding generation, branch/HEAD/dirty state, or a whole-context fingerprint.

`complete` strict-decodes and checks descriptor target/commitment/generation. If `channel.isLocalTarget(target)` is true, this target adapter reconstructs with its own provider, recomputes the verifier with constant-time comparison, and calls `deliverLocal`. If presenter and target differ, the source adapter calls only `routeDescriptor(target, descriptor)`; the broker invokes `acceptRoutedDescriptor` on the authenticated target adapter, which repeats strict target/commitment/generation checks before reconstructing/verifying/delivering locally. Maintenance recovery and fork-to-child always use descriptor routing, so the maintenance/primary source process never reconstructs or receives the target bearer.

If status is `stale`, descriptor is absent, or target is detached, return only public result plus safe status/recovery code; retain no reconstructed secret. Maintenance recovery requires an attached target primary and calls `channel.routeDescriptor(targetPrimary, descriptor)` without any provider reconstruction in maintenance.

- [ ] **Step 6: Run adapter/store, capability, and filesystem gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/private-retry-store.test.js dist-test/tests/authority-material-adapter.test.js dist-test/tests/capability-service.test.js dist-test/tests/directory-durability.test.js
npm run typecheck
```

Expected: exact pending authorization survives restart, no plaintext is retained, audience routing is exact, and all handles close.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/lifecycle/authority tests/private-retry-store.test.ts tests/authority-material-adapter.test.ts
git commit -m "feat: persist private lifecycle retries"
```

---

### Task 8: Build Authority, Lease, Approval, and Transfer Repositories

**Files:**
- Create: `src/orchestrator/runtime/clock.ts`
- Create: `src/orchestrator/storage/lifecycle-storage.types.ts`
- Create: `src/orchestrator/storage/session-authority.repository.ts`
- Create: `src/orchestrator/storage/session-lease.repository.ts`
- Create: `src/orchestrator/storage/lifecycle-approval.repository.ts`
- Create: `src/orchestrator/storage/child-transfer.repository.ts`
- Create: `tests/lifecycle-storage.repositories.test.ts`
- Create: `tests/session-authority.repository.test.ts`
- Create: `tests/session-lease.repository.test.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`

**Interfaces:**
- All repository methods accept a caller-owned `SqliteConnection`; none begins, commits, rolls back, opens, or closes a database.
- All generations, positions, claim tokens, and epoch milliseconds remain `bigint` internally.
- `SessionAuthorityRepository` strict-decodes complete rows, folds and compares streams before mutation, and exposes focused insert/CAS/query/checkpoint/revocation/terminal methods.
- `SessionLeaseRepository` owns clamped time calculations and root-only generation fencing.
- `LifecycleApprovalRepository.consume` writes the complete verified nonsecret consumption tuple and never stores the raw approval.
- `ChildTransferRepository.claim` is one-winner and never reparents or rewrites the source child.

```ts
export interface Clock { nowMs(): bigint; }

export class SessionAuthorityRepository {
  get(connection: SqliteConnection, projectId: string, sessionId: string): SessionAuthorityRecord | null;
  insertRoot(connection: SqliteConnection, input: RootAuthorityInsert): void;
  insertChild(connection: SqliteConnection, input: ChildAuthorityInsert): void;
  compareAndSwap(connection: SqliteConnection, input: AuthorityCompareAndSwap): boolean;
  listNonterminalChildren(connection: SqliteConnection, projectId: string, rootSessionId: string): readonly SessionAuthorityRecord[];
  listSafeResumeCandidates(connection: SqliteConnection, query: SafeResumeCandidateQuery): readonly SessionAuthorityRecord[];
  requireFoldMatch(connection: SqliteConnection, authority: SessionAuthorityRecord): SessionAggregateState;
  markCheckpointRequired(connection: SqliteConnection, input: CheckpointRequirement): void;
  clearCheckpointRequired(connection: SqliteConnection, input: CheckpointClear): boolean;
}

export class SessionLeaseRepository {
  current(connection: SqliteConnection, projectId: string, sessionId: string): RootLeaseRecord | null;
  insertGeneration(connection: SqliteConnection, input: RootLeaseInsert): RootLeaseRecord;
  renewCurrent(connection: SqliteConnection, input: RootLeaseRenewal): RootLeaseRecord;
  releaseCurrent(connection: SqliteConnection, input: RootLeaseRelease): void;
}

export interface ApprovalConsumptionInput {
  approvalId: string;
  nonceDigest: string;
  projectId: string;
  sessionId: string;
  action: "recover-root-authority" | "abandon-root";
  commandId: string;
  targetActorRole: "primary";
  targetClientInstanceId: string;
  redactedApprovalReference: string;
  consumedEventPosition: bigint;
  consumedAtMs: bigint;
}
```

- [ ] **Step 1: Write failing strict row/CAS/transaction-ownership tests**

Test malformed/null-group rows, bigint boundaries, deterministic stream identity, root/child insert groups, immutable lineage, expected commitment/state/both-generation CAS, parent queries, safe-resume ordering, checkpoint marker monotonicity, terminal/revocation fields, the complete approval consumption tuple plus approval ID/nonce single-use, transfer one-winner claim, and every repository method against a recording connection that rejects `BEGIN`, `COMMIT`, or `ROLLBACK`.

- [ ] **Step 2: Write failing fake-clock lease tests**

Cover generation 1 acquisition, same-generation semantic renewal, `effectiveNow = max(clock.nowMs(), lastObservedAtMs)`, backward clock movement, equality-at-expiry, renewal-first/takeover-first ordering, stale release/renewal, child lease rejection, terminal-root rejection, and trigger enforcement. No test may sleep.

```ts
it("clamps a backward clock and cannot revive an old lease", () => {
  const clock = new FakeClock(1_000n);
  const first = leases.insertGeneration(connection, rootLeaseInsert(clock.nowMs()));
  clock.set(900n);
  const renewed = leases.renewCurrent(connection, {
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    ownerGeneration: 1n,
    ownerClientInstanceId: "primary-1",
    leaseDurationMs: 120_000n,
    observedNowMs: clock.nowMs(),
  });
  assert.equal(renewed.lastObservedAtMs, first.lastObservedAtMs);
  assert.equal(renewed.expiresAtMs, first.lastObservedAtMs + 120_000n);
});
```

- [ ] **Step 3: Run repository tests and observe missing modules**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-storage.repositories.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/session-lease.repository.test.js
```

Expected: build fails because lifecycle repository modules do not exist.

- [ ] **Step 4: Implement strict authority row mapping and focused CAS operations**

Decode every SQLite row field explicitly; do not spread raw rows into domain objects. Require fixed enum, canonical UUID/timestamp/hex, group coherence, bigint ranges, `streamId === session/{sessionId}`, root/child generation rules, and event-position ordering again at the application boundary.

Every authority mutation receives exact expected values:

```ts
export interface AuthorityCompareAndSwap {
  projectId: string;
  sessionId: string;
  expectedState: RootSessionState | ChildSessionState;
  expectedOwnerGeneration: bigint | null;
  expectedChildCapabilityGeneration: bigint | null;
  expectedAuthorityCommitment: string;
  next: SessionAuthorityMutation;
}
```

Build one prepared authority update from the exact mutable columns in `SessionAuthorityMutation`. Its complete compare-and-swap predicate is `project_id = $projectId AND session_id = $sessionId AND semantic_state = $expectedState AND authority_commitment = $expectedCommitment AND owner_generation IS $expectedOwnerGeneration AND child_capability_generation IS $expectedChildCapabilityGeneration`; require `changes === 1n` and return `false` only for a clean compare-and-swap loss. Before any processor calls it, `requireFoldMatch` loads the deterministic stream, folds it, and calls aggregate mirror validation. Tests rotate a direct child concurrently and prove a stale child generation cannot mutate or revoke the newer authority.

`listSafeResumeCandidates` performs only the approved identity/workspace/namespace/state shortlist and deterministic ordering. It never uses task text, similarity, timestamp recency, or agent name as identity/tie-breaker.

- [ ] **Step 5: Implement clamped root leases and single-use repositories**

`renewCurrent` reads the unreleased generation under the caller's transaction, computes `effectiveNow`, and updates only the exact generation/client row while its authority remains a nonterminal root at that generation. `expiresAtMs <= effectiveNow` means expired. Expiry alone does not release or mutate authority. Transfer callers must execute release G, authority CAS G+1, insert lease G+1, then append/commit within the lifecycle transaction plan.

Approval consumption rejects an existing approval ID or nonce digest with `LIFECYCLE_APPROVAL_REPLAYED`, except exact command replay is already returned by `LifecycleCommandStore` before this method runs. Transfer claim updates only null claim fields under `(project, ticket, source event position)` and returns `EVENT_CONFLICT` to losers.

- [ ] **Step 6: Run repository, schema-guard, aggregate, and type gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-storage.repositories.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/session-lease.repository.test.js dist-test/tests/session-lifecycle-migration.test.js dist-test/tests/session-aggregate.test.js
npm run typecheck
```

Expected: strict row decoding, CAS loss, root-only clamped leases, single-use approvals, one-winner transfers, and no nested transaction statements all pass.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/runtime/clock.ts src/orchestrator/storage/lifecycle-storage.types.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/session-lease.repository.ts src/orchestrator/storage/lifecycle-approval.repository.ts src/orchestrator/storage/child-transfer.repository.ts src/orchestrator/lifecycle/session-aggregate.ts tests/lifecycle-storage.repositories.test.ts tests/session-authority.repository.test.ts tests/session-lease.repository.test.ts
git commit -m "feat: persist lifecycle authority indexes"
```

---

### Task 9: Implement Safe Root Start, Resume, Lease, Suspension, and Recovery

**Files:**
- Create: `src/orchestrator/lifecycle/lifecycle-command.processor.ts`
- Create: `src/orchestrator/lifecycle/lifecycle-query.service.ts`
- Create: `tests/lifecycle-command-processor.test.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Modify: `src/orchestrator/lifecycle/capability.service.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/storage/session-lease.repository.ts`

**Interfaces:**
- `LifecycleCommandProcessor.startRoot`, `resumeRoot`, `recoverRoot`, and `suspendRoot` execute semantic commands through `LifecycleCommandStore`; `renewRootLease` is a bounded operation with generation CAS and no semantic dedup/event.
- `LifecycleQueryService` returns bounded redacted authoritative folds and tree/status summaries; protected reads require a bounded proof.
- Every issuance result uses the common executor envelope, and the stored public result contains no dynamic descriptor/status.

```ts
export interface RootSessionPublicResultV2 {
  resultVersion: 2;
  project: {
    projectId: string;
    vaultId: string;
    storeId: string;
    workspaceId: string;
    clientNamespace: string;
  };
  sessionId: string;
  ownerGeneration: string;
  continuityKey: string;
  state: RootSessionState;
  resumedFromSessionId: string | null;
  latestCheckpointEventPosition: string | null;
  eventPosition: string;
  handleIssued: boolean;
  resumeTokenIssued: boolean;
  contextPackUnavailable: true;
}

export interface WorkerLifecycleResult<T extends JsonValue> {
  deduplicated: boolean;
  publicResult: T;
  authorityMaterialStatus: "reissued" | "stale" | "not-applicable";
  authorityMaterial?: AuthorityMaterialDescriptorV1;
  recoveryCode?: "SESSION_HANDLE_STALE" | "SESSION_CAPABILITY_KEY_UNAVAILABLE";
}

export class LifecycleCommandProcessor {
  startRoot(context: ProjectContext, command: StartRootCommandV2): WorkerLifecycleResult<RootSessionPublicResultV2>;
  resumeRoot(context: ProjectContext, command: ResumeRootCommandV2): WorkerLifecycleResult<RootSessionPublicResultV2>;
  recoverRoot(context: ProjectContext, command: RecoverRootCommandV2): WorkerLifecycleResult<RootSessionPublicResultV2>;
  suspendRoot(context: ProjectContext, command: SuspendRootCommandV2): WorkerLifecycleResult<RootSessionPublicResultV2>;
  renewRootLease(context: ProjectContext, operation: RenewRootLeaseOperationV1): RootLeaseRenewalResultV1;
}
```

- [ ] **Step 1: Write failing new/exact/latest-safe root tests**

Test new root identity/generation/lease/capability/commitment; same continuity collision without supersession; exact session and exact namespaced continuity; every latest-safe filter in approved order; zero/multiple candidates; same-owner reissue; active foreign-owner transfer only after expiry; suspended resume; ending exclusion; terminal exclusion; no similarity/timestamp tie-break; one generation winner; and old handle/token rejection.

```ts
it("does not let a second root supersede the current continuity owner", () => {
  const first = processor.startRoot(primaryContext("primary-1"), startCommand("new", "thread-7"));
  assert.throws(
    () => processor.startRoot(primaryContext("primary-2"), startCommand("new", "thread-7")),
    /CONTINUITY_CONFLICT/,
  );
  const current = queries.getRoot(first.publicResult.sessionId, proofFor(first));
  assert.equal(current.state, "active");
  assert.equal(current.ownerGeneration, "1");
  assert.equal(current.ownerClientInstanceId, "primary-1");
});
```

- [ ] **Step 2: Write failing lost-response, suspension, heartbeat, and recovery tests**

Cover:

- start/resume response loss and exact original retry;
- post-resume G proof tuple replay before current G+1 authority, then stale descriptor after G+2;
- root semantic mutation implicitly renewing its current lease;
- bounded heartbeat proof, expiry, clock clamp, and generation CAS;
- suspension requiring a pre-transition checkpoint and marking a post-transition checkpoint requirement;
- recovery approval expiry/single-use/action/audience/intent/generation binding;
- recovery release-G → authority-CAS-G+1 → insert-lease-G+1 → append ordering, all-old-capability revocation, new commitment, and same-transaction approval consumption; and
- maintenance presenter routing only the descriptor to the attached approved primary target, with zero maintenance-provider reconstruction calls.

- [ ] **Step 3: Run focused tests and observe missing processor behavior**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/session-lease.repository.test.js dist-test/tests/capability-service.test.js
```

Expected: build fails because root processor/query services do not exist.

- [ ] **Step 4: Implement new-root creation without supersession**

Require a re-established trusted primary binding and authorization kind `initial-authority`. Inside one lifecycle transaction:

1. derive the continuity fingerprint with the one configured continuity-index key;
2. reject a nonterminal unique-namespace owner unless exact command dedup already returned;
3. generate root session ID and correlation ID inside the worker;
4. prepare generation-1 root handle and portable resume token plus stored verifier/commitment;
5. append `SessionStarted` as stream version 1;
6. insert authority and a 120-second generation-1 lease; and
7. store the public result with `contextPackUnavailable: true`, then return an ephemeral descriptor.

Never search current sessions by task area, topic, filename, agent, or timestamps and never append a supersede event.

- [ ] **Step 5: Implement exact/latest-safe transfer and deterministic replay**

Exact selection requires explicit session ID or exact namespaced continuity. Latest-safe applies the ten approved filters in order and returns redacted summaries on ambiguity. After selection, verify the candidate intent hash, stored proof tuple, reconstructed resume-token proof, resumable state, and lease under the same transaction.

Transfer order is:

```text
fold/verify state, lease, commitment, proof, and planned G+1 authority
privately materialize the exact SessionOwnerTransferred position (and suspended SessionResumed position) under BEGIN IMMEDIATE
before append: release generation G lease
before append: CAS authority expected state/commitment/G -> G+1 using the planned authority event position
before append: insert generation G+1 lease for the target primary
append the privately planned SessionOwnerTransferred carrying previous G, new G+1, and new commitment
append the privately planned SessionResumed without another generation change when prior state was suspended
persist the public result and complete one transaction
```

`PreparedLifecycleCommit.beforeAppend` performs the release/CAS/insert sequence through connection-bound facades; the authority event-position foreign key is deferred and `appendPlanned` must insert exactly the reserved position before commit. Any append failure rolls back all three pre-append mutations. Only one transaction wins. A same-owner active reissue may retain generation when no transfer is needed. Exact dedup returns the stored public result plus a current descriptor for the recorded target; only that target adapter reconstructs authority. After authority advances again it returns the same effect with status `stale` and no material.

- [ ] **Step 6: Implement bounded renewal, suspension, and signed recovery**

Renewal verifies the short-lived bounded-operation proof and exact owner/client/generation, clamps time, updates the lease, and appends no event. Suspension verifies the root semantic proof and a pre-transition checkpoint base covering all prior relevant events; append `SessionSuspendRequested` and `SessionSuspended`, update state/commitment, and set the post-transition checkpoint marker at the committed position.

Recovery requires a verified unconsumed `RecoveryApprovalV1`, exact executor/target private attachment, healthy quick integrity, and the expected current generation. It plans rotated authority and the exact recovery event position under the write lock; `beforeAppend` releases lease G, CAS-updates authority to G+1 with the new commitment/planned position, and inserts lease G+1 in that trigger-safe order. It then appends the privately planned `SessionOwnershipRecovered`, preserving active/suspended/ending semantic state, and writes the complete `ApprovalConsumptionInput` at that committed position. Any failure rolls back the entire sequence. It does not infer success, alter child outcomes, resume a suspended root, leave ending state, reconstruct replacement material in maintenance, or make maintenance the target authority.

- [ ] **Step 7: Run root lifecycle, dedup, repository, and integrity gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/session-lease.repository.test.js dist-test/tests/lifecycle-approval.test.js dist-test/tests/event-integrity.test.js
npm run typecheck
```

Expected: safe selection, one-owner transfer, lost-response replay, clock-clamped renewal, checkpoint-gated suspension, approval recovery, and stale-material behavior all pass.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/lifecycle/lifecycle-command.processor.ts src/orchestrator/lifecycle/lifecycle-query.service.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/lifecycle/capability.service.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/session-lease.repository.ts tests/lifecycle-command-processor.test.ts
git commit -m "feat: enforce root lifecycle ownership"
```

---

### Task 10: Implement Child Fork, Report, Disposition, Completion, and Transfer

**Files:**
- Create: `src/orchestrator/lifecycle/child-workflow.service.ts`
- Create: `tests/child-workflow.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/child.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/authority/capability-key-provider.ts`
- Modify: `src/orchestrator/lifecycle/capability.service.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-query.service.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/storage/child-transfer.repository.ts`

**Interfaces:**
- Only a current-generation root semantic proof may fork, amend child assignment, disposition, accept completion, suspend, create transfer, or claim a transfer.
- A transport-private signed `ChildBindingGrantV1` may enable direct child authority for exactly one untrusted `clientInstanceId`; without it, only the primary may record/complete that child.
- Direct child proof permits only child checkpoint, report, and completion proposal on that same child.
- Worker-generated IDs and immutable assignment/lineage are returned through command dedup on exact retry.

```ts
export interface ChildBindingGrantV1 {
  grantVersion: 1;
  grantId: string;
  projectId: string;
  storeId: string;
  parentSessionId: string;
  targetActorRole: "untrusted";
  targetClientInstanceId: string;
  issuedAt: string;
  expiresAt: string;
  bindingFingerprint: string;
  mac: string;
}

export class ChildWorkflowService {
  fork(tx: LifecycleCommandTransaction, command: ForkChildCommandV2): FreshLifecycleEffect<ForkChildResultV2>;
  amendAssignment(tx: LifecycleCommandTransaction, command: AmendChildAssignmentCommandV2): FreshLifecycleEffect<ChildAssignmentAmendedResultV2>;
  recordReport(tx: LifecycleCommandTransaction, command: RecordChildReportCommandV2): FreshLifecycleEffect<ChildReportResultV2>;
  dispositionReport(tx: LifecycleCommandTransaction, command: DispositionChildReportCommandV2): FreshLifecycleEffect<ChildDispositionResultV2>;
  proposeCompletion(tx: LifecycleCommandTransaction, command: ProposeChildCompletionCommandV2): FreshLifecycleEffect<ChildCompletionProposalResultV2>;
  complete(tx: LifecycleCommandTransaction, command: CompleteChildCommandV2): FreshLifecycleEffect<ChildCompletionResultV2>;
  suspendAndTransfer(tx: LifecycleCommandTransaction, command: SuspendChildCommandV2): FreshLifecycleEffect<ChildTransferResultV2>;
  claimTransfer(tx: LifecycleCommandTransaction, command: ClaimChildTransferCommandV2): FreshLifecycleEffect<ClaimChildTransferResultV2>;
}
```

- [ ] **Step 1: Write failing fork and child-authority tests**

Prove `SessionForked` is child stream version 1, parent/correlation/original assignment/root generation are immutable, root authority and lease are unchanged, no grant yields `directAccessEnabled: false`, a valid grant routes one generation-1 child descriptor only to its target, malformed/expired/wrong-binding/model-supplied grants fail, and no child proof can mutate/end/resume/recover the root or another child. Add root-authorized assignment-amendment cases for expected revision, strict bounded scope changes, immutable amendment history, exact retry, stale revision, terminal/transferred rejection, and direct-child denial.

- [ ] **Step 2: Write failing report/disposition/completion/transfer tests**

Cover worker-generated report/item IDs; direct-child author plus separate primary recorder; exact report retry; complete partition rules; accepted/partial/rejected/superseded disposition history; completion proposal versus root acceptance; handle revocation; completed terminal protection; default root-end active-child diagnostic; suspension ticket contents; single-winner future claim; new lineage without reparenting; and one root plus 32 child operations leaving root owner generation unchanged.

```ts
it("cannot let a child completion proposal complete or supersede its root", () => {
  const { root, child, childProof } = forkDirectChild();
  const proposed = childWorkflow.proposeCompletion(tx, propose(child, childProof));
  assert.equal(proposed.publicResult.state, "completion-proposed");
  assert.equal(loadRoot(root).state, "active");
  assert.equal(loadRoot(root).ownerGeneration, 1n);
  assert.throws(() => completeWithChildProof(root, childProof), /SESSION_OWNERSHIP_MISMATCH/);
});
```

- [ ] **Step 3: Run focused tests and observe missing child workflow**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/child-workflow.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-command-processor.test.js
```

Expected: build fails because `ChildWorkflowService` and child command implementations are absent.

- [ ] **Step 4: Implement signed grant verification and atomic fork**

Add provider purpose `child-binding-grant` and verify its strict canonical claims inside the worker. The grant is transport-private, target-bound, short-lived, and cannot be synthesized from command payload fields. Fork verifies the current root fold/authority/proof, generates child ID, appends one `SessionForked`, inserts child authority, and—only with a valid grant—prepares a child-handle descriptor for that untrusted target. Do not append a duplicate fork fact to the root stream.

- [ ] **Step 5: Implement immutable assignment amendments and report/disposition coupling**

`AmendChildAssignmentCommandV2` carries the child ID, expected assignment revision, bounded replacement assignment/scope, reason code, and root proof. Fold the immutable lineage, require the same parent root/current authority, append `ChildAssignmentAmended` with previous/new revision and changed fields, and retain every earlier assignment. It does not reparent, change root correlation, rotate authority, or change child semantic state.

Strict-decode a report draft, generate canonical report/item IDs, record immutable assignment identity, evidence references/keyed coverage fingerprints, child author when proven, and primary recorder when present. A duplicate report ID under another command is a conflict.

Disposition validates a complete set partition and appends `ChildWorkDispositioned` without rewriting the report. Accepted and partially accepted dispositions call `authority.markCheckpointRequired` on the root at the disposition event position. Rejected completion may return `completion-proposed` to active; supersession cites the prior disposition and `supersededByReportId` while retaining history.

- [ ] **Step 6: Implement proposal, primary completion, suspension, and transfer claim**

Child proof appends only `ChildCompletionProposed`. Root proof may append `ChildSessionCompleted`, set terminal fields/commitment, and revoke direct child authority. Suspension appends `ChildSessionSuspended`, creates an immutable ticket carrying assignment/scope/checkpoint/blockers/follow-ups/source fingerprint/old lineage/event position, appends `ChildWorkTransferCreated`, and revokes direct mutation.

Claim verifies a current future-root proof and one unclaimed ticket, creates a new child stream with `SessionForked` then `ChildWorkTransferClaimed`, cites the old transfer event, adopts the future root correlation, and atomically fills ticket claim fields. The original child's parent never changes.

- [ ] **Step 7: Run child, authority, transfer, and root-isolation gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/child-workflow.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/lifecycle-command-store.test.js
npm run typecheck
```

Expected: every child flow passes, accepted reports mark root checkpoint-required, transfer is one-winner, and root authority never changes through child activity.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/lifecycle/child-workflow.service.ts src/orchestrator/lifecycle/contracts/child.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/authority/capability-key-provider.ts src/orchestrator/lifecycle/capability.service.ts src/orchestrator/lifecycle/lifecycle-query.service.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/child-transfer.repository.ts tests/child-workflow.test.ts
git commit -m "feat: add scoped child lifecycle"
```

---

### Task 11: Record Versioned Checkpoints and Enforce Transition Markers

**Files:**
- Create: `src/orchestrator/lifecycle/checkpoint.service.ts`
- Create: `src/orchestrator/lifecycle/source-state.provider.ts`
- Create: `tests/checkpoint.service.test.ts`
- Create: `tests/source-state.provider.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/checkpoint.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/identity/canonical-path.ts`

**Interfaces:**
- Caller input is `CheckpointDraftV1`; the worker produces the authoritative `CheckpointV1` by deriving identity, branch/workspace/HEAD, dirty-state fingerprint, child fold summaries, base/event positions, stream version, creator attribution, and evidence capture status.
- `CheckpointService.record` operates inside `LifecycleCommandStore`; `recordFinal` is the same validator/append path used by the session-end workflow.
- `SourceStateProvider` is introduced before first use. It derives trusted versioned project/workspace/branch/HEAD/dirty witnesses after applying only `SourceStateScopeV1`; checkpoint and terminal transaction methods are synchronous, while validation capture is asynchronous outside SQLite transactions.
- `baseEventPosition` is read under `BEGIN IMMEDIATE` immediately before append and means the project snapshot through which relevant session streams were folded.

```ts
export interface RecordCheckpointCommandV2 extends LifecycleCommandBase {
  commandType: "record-checkpoint";
  sessionId: string;
  expectedStreamVersion: string;
  expectedBaseEventPosition: string | null;
  draft: CheckpointDraftV1;
}

export interface SourceStateProvider {
  capture(context: ProjectContext, scope: SourceStateScopeV1): Promise<SourceStateFingerprintV1>;
  captureForCheckpoint(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1;
  captureForFinalization(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1;
}

export interface SourceStateScopeV1 {
  scopeVersion: 1;
  descriptorPath: string;
  storeRoot: string;
  privateStateRoot: string;
  exactMaterializationTargets: readonly string[];
  exactCommittedTempPaths: readonly string[];
}

export interface CheckpointRecordedResultV1 {
  checkpointVersion: 1;
  checkpointId: string;
  sessionId: string;
  baseEventPosition: string;
  checkpointEventPosition: string;
  finalStreamVersion: string;
  checkpointRequiredCleared: boolean;
}

export class CheckpointService {
  record(tx: LifecycleCommandTransaction, command: RecordCheckpointCommandV2): FreshLifecycleEffect<CheckpointRecordedResultV1>;
  recordFinal(tx: LifecycleCommandTransaction, input: FinalCheckpointPhaseInput): FreshLifecycleEffect<CheckpointRecordedResultV1>;
}
```

- [ ] **Step 1: Write failing contract/bounds/path/redaction tests**

Cover canonical UTF-8 body size 256 KiB; 2,000 scalar task summary; 100 entries per work/decision list; 200 combined file/artifact/source/command/test/material-claim entries; 512-scalar relative paths; 4,000-scalar result/summary; 200 intervals; confidence on material claims; canonical timestamps; keyed output fingerprint metadata; and rejection of absolute/drive/UNC/parent/external/symlink-substituted paths, raw output, raw commands, env dumps, secrets, and caller-asserted authoritative identity. In `source-state.provider.test.ts`, cover Git branch/detached HEAD, tracked/untracked/renamed/deleted dirty state, linked worktrees, non-Git workspaces, fixed no-shell invocation, bounded output/time, deterministic fingerprints, caller-field rejection, and an injected deterministic fake. Prove the exact descriptor, contained store/private roots, committed compatibility targets, and only temp paths whose session/revision/claim tuple matches an outbox row are excluded; whole-vault/log-directory globs and arbitrary caller paths are rejected, and an ordinary edit still changes the witness.

- [ ] **Step 2: Write failing base/CAS/marker/trigger tests**

Test worker-derived base and event positions, expected stream/base conflict, unrelated streams below the watermark ignored semantically, root child summaries folded through base, accepted-report marker clearing only when base covers the disposition, pre/post risky-transition markers, suspension/end checkpoint requirement, checkpoint-age diagnostics without fabricated events, exact retry, and crash after disposition before checkpoint.

```ts
it("does not clear a marker with a checkpoint based before the triggering event", () => {
  markRootCheckpointRequired(ROOT_ID, 41n, "accepted-child-report");
  assert.throws(
    () => checkpoints.record(tx, checkpointCommand({ expectedBaseEventPosition: "40" })),
    /CHECKPOINT_BASE_INVALID/,
  );
  assert.equal(loadAuthority(ROOT_ID).checkpointRequiredEventPosition, 41n);
});
```

- [ ] **Step 3: Run the focused test and observe missing checkpoint service**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/checkpoint.service.test.js dist-test/tests/lifecycle-contracts.test.js
```

Expected: build fails because `CheckpointService` is absent.

- [ ] **Step 4: Implement strict draft validation and authoritative enrichment**

Canonicalize the draft only after strict decode. Count UTF-8 bytes with `Buffer.byteLength(canonicalJson(value), "utf8")` and Unicode scalars with `Array.from`. Normalize project-relative paths without changing case/content, reject dot/parent/root forms, resolve their governed artifact roots, and verify containment/symlink identity with existing canonical-path helpers.

Inside the transaction, fold the target stream and every nonterminal child relevant to a root, read the current global tail as base, compare optional expected assertions, call synchronous `captureForCheckpoint(context)`, and generate checkpoint ID. Caller-supplied identity/position/child/branch values are assertions only and do not enter the stored checkpoint unless equal.

The production provider uses only re-established `ProjectContext` plus fixed trusted host configuration. A worker-owned scope resolver canonicalizes the exact descriptor/store/private roots, derives exact compatibility targets from committed `SessionStarted` identities, and admits a temp path only when its parsed target/session/revision/claim tuple matches committed outbox state. It filters fixed Git status/inventory records before hashing; it never adds a caller exclusion, arbitrary glob, whole vault, or whole `05_Agent_Session_Logs` directory. Every witness stores `sourceStateScopeVersion: 1`, not the volatile resolved path list.

Git workspaces use a fixed executable and fixed argument arrays under `shell: false`, bounded timeout/output, and no caller-selected path/command/environment; non-Git workspaces use the same versioned bounded scope/inventory strategy. The synchronous checkpoint/finalization methods never return a promise or perform unrelated validation work, so the store never `await`s while its transaction is open.

- [ ] **Step 5: Append one checkpoint and update marker invariants**

Append `SessionCheckpointRecorded` to roots and children with the complete Version 1 body, capture mode `coverage-only`, ordinal coverage/missing intervals, and `contentRetained: false`. After committed positions are known, CAS authority latest-checkpoint fields. Clear a checkpoint-required marker only when `baseEventPosition >= markerEventPosition`.

Implement `RiskyTransitionPolicyV1` as the fixed server enum:

```ts
export const RISKY_TRANSITIONS_V1 = Object.freeze([
  "ownership-transfer",
  "ownership-recovery",
  "suspension",
  "carry-forward-claim",
  "end-amendment",
  "end-cancellation",
  "abandonment",
] as const);
```

Every risky command checks a pre-transition checkpoint whose base covers prior relevant events. Every nonterminal risky transition sets a post-transition marker at its committed position. Abandonment stores the pre-checkpoint reference in its terminal event and queues materialization; it does not create an impossible terminal marker.

- [ ] **Step 6: Run checkpoint, child-marker, root-transition, and type gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/checkpoint.service.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/child-workflow.test.js dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/session-aggregate.test.js
npm run typecheck
```

Expected: bounds/redaction/base/CAS tests pass, markers clear only after covered checkpoints, and no transition fabricates a checkpoint.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/lifecycle/checkpoint.service.ts src/orchestrator/lifecycle/source-state.provider.ts src/orchestrator/lifecycle/contracts/checkpoint.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/session-aggregate.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/identity/canonical-path.ts tests/checkpoint.service.test.ts tests/source-state.provider.test.ts
git commit -m "feat: enforce durable lifecycle checkpoints"
```

---

### Task 12: Record Coverage-Only Evidence with Durable Ordinal Conflict Detection

**Files:**
- Create: `src/orchestrator/storage/evidence-coverage.repository.ts`
- Create: `src/orchestrator/lifecycle/evidence-coverage.service.ts`
- Create: `tests/evidence-coverage.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/contracts/events.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`

**Interfaces:**
- `EvidenceCoverageRepository` compares immutable ordinal fingerprints, computes canonical inclusive missing intervals, enforces one fingerprint lineage per adapter session, and never stores evidence bodies/references.
- `prepareBatch` is read-only and returns a frozen prospective batch/coverage plan; `persistPrepared` inserts immutable rows and the aggregate only after the event append supplies its committed position.
- Root proof may target its root or a verified descendant. Child proof may target only itself.
- Exact semantic retry is handled before repository access; identical overlap under a new batch is harmless, contradictory overlap fails before event append.

```ts
export interface EvidenceCoverageFrameV1 {
  frameId: string;
  ordinal: string;
  sourceKind: "model-turn" | "tool-request" | "tool-result" | "adapter-event" | "external-observation";
  observedAt: string;
  contentFingerprint: string;
}

export interface RecordEvidenceBatchCommandV2 extends LifecycleCommandBase {
  commandType: "record-evidence-batch";
  adapterSessionId: string;
  batchId: string;
  sessionId: string;
  firstOrdinal: string;
  lastOrdinal: string;
  fingerprintSchemaVersion: 1;
  fingerprintKeyId: string;
  fingerprintDomain: "pm-evidence-frame-v1";
  redactionStatus: "content-not-retained";
  frames: readonly EvidenceCoverageFrameV1[];
}

export class EvidenceCoverageRepository {
  prepareBatch(connection: SqliteConnection, input: EvidenceCoverageBatchInput): PreparedEvidenceCoverageBatch;
  persistPrepared(connection: SqliteConnection, prepared: PreparedEvidenceCoverageBatch, recordedEventPosition: bigint): void;
}

export interface EvidenceCoverageResultV1 {
  sessionId: string;
  adapterSessionId: string;
  highestContiguousOrdinal: string | null;
  missingIntervals: readonly { first: string; last: string }[];
  captureMode: "coverage-only";
  contentRetained: false;
  eventPosition: string;
}
```

- [ ] **Step 1: Write failing strict batch/overlap/gap tests**

Test UUID/timestamp/source kind/decimal/fingerprint strictness; internal contiguous ordering; declared bounds; duplicate frame IDs; identical overlap; contradictory ordinal or frame ID; gaps merging/splitting; first ordinal above zero; 200 versus 201 intervals; changed schema/key/domain within one adapter session; rejection of caller-selected algorithm fields; root-to-descendant and child scope; exact retry; and no raw evidence field accepted. Add an immediate event-position foreign-key fixture plus a fault after event append/before `persistPrepared`; the complete transaction must roll back the event and every prospective coverage change.

```ts
it("rejects contradictory overlap before appending an event", () => {
  recordBatch(batch({ ordinals: [[0n, "a".repeat(64)], [1n, "b".repeat(64)]] }));
  const before = eventCount();
  assert.throws(
    () => recordBatch(batch({ batchId: UUID_2, ordinals: [[1n, "c".repeat(64)]] })),
    /EVIDENCE_CAPTURE_INCOMPLETE/,
  );
  assert.equal(eventCount(), before);
});
```

- [ ] **Step 2: Run the focused test and observe missing repository/service**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/evidence-coverage.test.js dist-test/tests/session-lifecycle-migration.test.js
```

Expected: build fails because coverage repository/service do not exist.

- [ ] **Step 3: Implement immutable ordinal comparison and canonical intervals**

For every frame, `prepareBatch` queries `(project, session, adapter_session, ordinal)` and the unique frame ID. Accept an existing row only when frame ID, source kind, timestamp, fingerprint, fixed provider algorithm/schema/key/domain are byte-equal. Reject any contradiction before an event or aggregate update. The algorithm is resolved from the trusted provider/key profile and is never caller-selected.

Merge existing and prospective ordinals in memory using bigint arithmetic. Intervals are inclusive, sorted, nonoverlapping, and coalesced; reject the prospective transaction if interval count exceeds 200. `highestContiguousOrdinal` is null when ordinal zero is absent, otherwise the last position in the zero-based contiguous prefix. Freeze the canonical plan with new rows, aggregate JSON, and domain-separated keyed coverage digest; `prepareBatch` writes nothing.

- [ ] **Step 4: Implement authorized batch recording and honest events/results**

Strict-decode and authoritative-recompute the batch intent. Verify root/descendant lineage or exact child scope, capability generation, and semantic proof. Inside `LifecycleCommandStore`, call read-only `prepareBatch`, append one `EvidenceCoverageRecorded`, then call `persistPrepared(prepared, committedEventPosition)` through the connection-bound facade. The event contains ordinals, keyed fingerprints, canonical intervals, server-derived algorithm plus schema/key/domain, and `contentRetained: false`; it contains no body or raw evidence reference.

Return only `captureMode: "coverage-only"`. Any status adapter maps externally is `partial` or `tool-only`; never `full-adapter`. Do not add a branch that can satisfy `requireFullEvidence`.

- [ ] **Step 5: Extend lifecycle integrity for aggregate/frame agreement**

Quick mode checks aggregate row shape, key lineage, latest event linkage, and interval count. Full mode replays all immutable ordinal rows, recomputes first/last/highest/missing intervals and coverage digest, and compares the `EvidenceCoverageRecorded` event. Any mismatch is `SESSION_EVIDENCE_COVERAGE_MISMATCH` and blocks lifecycle mutation.

- [ ] **Step 6: Run evidence, checkpoint, integrity, and type gates**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/evidence-coverage.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/event-integrity.test.js dist-test/tests/session-lifecycle-migration.test.js
npm run typecheck
```

Expected: exact overlap is idempotent, contradictions/fragmentation roll back, aggregates match immutable ordinals, and all outputs remain coverage-only.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/storage/evidence-coverage.repository.ts src/orchestrator/lifecycle/evidence-coverage.service.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/evidence-coverage.test.ts
git commit -m "feat: track lifecycle evidence coverage"
```

---

### Task 13: Add Strict Lifecycle Worker and Executor Operations

**Files:**
- Create: `src/orchestrator/runtime/lifecycle-worker-protocol.ts`
- Create: `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts`
- Create: `tests/lifecycle-worker-protocol.test.ts`
- Create: `tests/lifecycle-executor.test.ts`
- Modify: `src/orchestrator/runtime/worker-protocol.ts`
- Modify: `src/orchestrator/runtime/project-store-executor.ts`
- Modify: `src/orchestrator/runtime/project-store-worker-backend.ts`
- Modify: `src/orchestrator/runtime/project-store-worker-runtime.ts`
- Modify: `src/workers/project-store.worker.ts`
- Modify: `src/orchestrator/lifecycle/authority/authority-material-adapter.ts`
- Modify: `tests/project-store-executor.test.ts`

**Interfaces:**
- The existing protocol adds one tagged request `{ type: "lifecycle", operation }`; strict nested discriminators live in the focused lifecycle codec so success decoding is never structural guesswork.
- Existing executor request kind `"lifecycle"` is renamed `"control"`; open/quiesce/close are control. External and internal event-appending lifecycle commands are `"mutation"` and carry their original command/idempotency identity. Bounded operations use `"bounded"`; queries use `"read"`; deterministic workflow claim/renew/release/eventless-phase/recovery and outbox work uses a separate internal `"operational"` kind and never semantic dedup.
- `ProjectStoreWorkerBackend` dispatches lifecycle only when an injected `LifecycleWorkerRuntimeFactory` exists. During worker open, the factory binds exactly one runtime, one semantic `LifecycleCommandStore`, and one nonsemantic `LifecycleOperationalStore` to the already-open `ActiveStore` connection and its maintenance fence/provider/clock/facades; production composition injects no factory and returns `LIFECYCLE_V2_DISABLED`.

```ts
export interface LifecycleWorkerRequest {
  id: string;
  type: "lifecycle";
  binding: WorkerBindingAssertion;
  operation: LifecycleWorkerOperationWire;
}

export interface LifecycleWorkerSuccessWire {
  operation: LifecycleWorkerOperationWire["operation"];
  result: JsonValue;
}

export interface LifecycleWorkerRuntime {
  execute(operation: LifecycleWorkerOperation, context: ProjectContext): Promise<LifecycleWorkerSuccessWire>;
  dispose(): void;
}

export interface LifecycleWorkerRuntimeFactory {
  create(input: {
    connection: SqliteConnection;
    maintenanceFence: MaintenanceFence;
    keyProvider: CapabilityKeyProvider;
    clock: Clock;
    transactionFacadeFactory: LifecycleTransactionFacadeFactory;
  }): LifecycleWorkerRuntime;
}

export class ProjectStoreExecutor {
  executeLifecycleMutation<C extends LifecycleSemanticCommandDraft>(command: PreparedLifecycleWorkerCommand<C>): Promise<LifecycleExecutionResult<LifecycleResultFor<C>>>;
  executeLifecycleInternalMutation<I extends InternalWorkflowSemanticCommand>(command: I): Promise<LifecycleInternalResultFor<I>>;
  executeLifecycleBounded<O extends BoundedLifecycleOperation>(operation: O): Promise<LifecycleBoundedResultFor<O>>;
  queryLifecycle<Q extends LifecycleQuery>(query: Q): Promise<LifecycleQueryResultFor<Q>>;
  executeLifecycleFenced<O extends LifecycleFencedOperation>(operation: O): Promise<LifecycleFencedResultFor<O>>;
}
```

- [ ] **Step 1: Write failing strict wire-contract tests**

Cover every request/response variant for root start/resume/recovery/suspend, lease renewal, child flow, checkpoint, evidence, session tree, end request/amend/cancel/status/abandon, internal validation result, internal event-appending workflow phase, workflow claim/renew/release/eventless phase/recovery scan, and outbox claim/renew/materialize/failure. Reject unknown/missing fields, unsafe numbers, noncanonical decimal/UUID/timestamp/base64url, oversized JSON, malformed binding, mismatched result tag, bearer-shaped `pmcap1` values, caller-selected actor/audience/time/path/validation command, standalone outbox acknowledgement, and untagged lifecycle success. Permit a signed redacted child-binding grant only on fork and only alongside the current root proof; reject it on every other variant without echoing it.

- [ ] **Step 2: Write failing executor/private-delivery/unknown-outcome tests**

Prove external semantic mutation accepts only a `PreparedLifecycleWorkerCommand`, persists pending authorization before post, posts only proof/approval plus an optional fork-only signed grant, uses original IDs on timeout/death, poisons after uncertain posted mutation, requires revalidation/new executor, never auto-retries, and hands a strict descriptor to the adapter. A local target reconstructs; maintenance and fork source adapters route descriptors and provider spies observe zero reconstruction. Prove no public executor overload accepts a raw draft/private bearer/audience. Prove `executeLifecycleInternalMutation` accepts only a trusted attempt-plan or deterministic phase identity, constructs the stable replay expectation before store execution, lets the fresh callback create the persisted `internal-workflow` authorization record only after a live claim check, uses semantic dedup, replays a committed result after claim expiry without invoking the fresh callback, and preserves its planned command/idempotency identity on uncertainty. Prove workflow/outbox operational methods require exact work identity, expose renew explicitly, never call semantic dedup or event append, reject standalone acknowledgement, and return `OPERATION_OUTCOME_UNKNOWN` without inventing identity. Prove a backend without an injected factory returns disabled before SQLite mutation; a test factory receives the exact active connection, opens no second handle, and both stores are disposed before that connection closes.

```ts
it("keeps semantic lifecycle commands in the mutation unknown-outcome path", async () => {
  const pending = executor.executeLifecycleMutation(preparedResumeCommand());
  const posted = fakeWorker.posted.at(-1)!;
  assert.equal(posted.type, "lifecycle");
  assert.equal(posted.operation.operation, "root-resume");
  fakeWorker.exit(137);
  await assert.rejects(pending, (error: ProjectStoreWorkerError) => {
    assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
    assert.equal(error.details.commandId, RESUME_COMMAND_ID);
    assert.equal(error.details.idempotencyKey, RESUME_IDEMPOTENCY_KEY);
    return true;
  });
});
```

- [ ] **Step 3: Run focused tests and observe missing lifecycle protocol**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-executor.test.js dist-test/tests/project-store-executor.test.js
```

Expected: build fails because lifecycle wire and executor methods do not exist.

- [ ] **Step 4: Implement strict tagged lifecycle codecs**

Use the existing exact-object, safe-integer, decimal, and binding patterns but keep domain conversion in `lifecycle-worker-protocol.ts`. The operation union is:

```ts
export type LifecycleWorkerOperationWire =
  | RootStartWire | RootResumeWire | RootRecoveryWire | RootSuspendWire
  | RootLeaseRenewalWire | SessionTreeWire
  | ChildForkWire | ChildAssignmentAmendWire | ChildReportWire | ChildDispositionWire
  | ChildCompletionProposalWire | ChildCompletionWire
  | ChildSuspensionWire | ChildTransferClaimWire
  | CheckpointWire | EvidenceBatchWire
  | SessionEndRequestWire | SessionEndAmendWire | SessionEndCancelWire
  | SessionEndStatusWire | SessionAbandonWire | ValidationResultWire
  | InternalWorkflowPhaseMutationWire
  | LifecycleWorkflowClaimWire | LifecycleWorkflowRenewWire
  | LifecycleWorkflowReleaseWire | LifecycleWorkflowAdvanceOperationalWire
  | LifecycleRecoveryScanWire
  | LifecycleOutboxClaimWire | LifecycleOutboxRenewWire
  | LifecycleOutboxMaterializeWire | LifecycleOutboxFailureWire;
```

Every external semantic variant has `commandId` and `idempotencyKey`, candidate intent, and adapter-prepared authorization; audience fields are not accepted from a raw command draft. Decode raw signed approvals and the optional fork-only child-binding grant directly into redacted wrappers and never include them in protocol errors. Internal validation and event-appending phase mutations carry only a trusted stable planned-work identity plus the current claim assertion. The runtime builds the replay expectation from the stable identity before semantic-store execution; only the fresh callback may validate the current claim and create the persisted `internal-workflow` authorization record. No wire field can select an origin or persisted claim record. No issued handle/token type exists in the request union. The only issuance response field is strict `AuthorityMaterialDescriptorV1`; public result, dynamic status, descriptor, and operation tag are decoded separately.

- [ ] **Step 5: Extend backend dispatch with an explicit disabled default**

Add optional `lifecycleRuntimeFactory` to backend options. During successful store open, invoke it with the exact `ActiveStore` SQLite connection and connection-bound dependencies, store its runtime inside `ActiveStore`, and dispose it during close before the connection. On `type: "lifecycle"`, revalidate the current worker binding first. If the factory/runtime is absent, throw `LIFECYCLE_V2_DISABLED` without constructing a lifecycle repository or writing SQLite. If present, pass the already re-established context and strict domain operation to it. The factory must not open, own, or discover another SQLite handle.

Keep the production `src/workers/project-store.worker.ts` role `store` construction unchanged with respect to lifecycle injection. Test fixtures construct their own worker backend with deterministic external-provider profile and lifecycle runtime. No provider key or provider object crosses `workerData`.

- [ ] **Step 6: Implement typed executor operations and request classification**

Rename and add the explicit operational class:

```ts
type RequestKind = "read" | "mutation" | "bounded" | "operational" | "control";
```

Open, quiesce, and close use control. The trusted adapter prepares the draft before calling the executor; `executeLifecycleMutation` accepts only that prepared command, posts it as mutation with original identity, decodes the tagged result, and calls adapter completion. It has no bearer/approval/audience parameters. `executeLifecycleInternalMutation` is exposed only to the injected trusted coordinator; it posts a persisted validation-attempt-plan identity or deterministic workflow-phase identity as mutation. The worker constructs its replay expectation before `LifecycleCommandStore.execute`; on a dedup miss only, the fresh callback verifies the live generation/claim and constructs the persisted `internal-workflow` record. It uses normal semantic dedup and returns the original command/idempotency identity on uncertainty. `executeLifecycleBounded` retains operation/request identity and returns `OPERATION_OUTCOME_UNKNOWN` without inventing an identity if delivery is uncertain. Queries are read-only and use bounded proof where protected.

`executeLifecycleFenced` is available only to injected trusted coordinators/materializers. Its strict union covers workflow claim/renew/release/eventless-phase/recovery and outbox claim/renew/materialize/failure with deterministic project/workflow/generation/revision/owner/token identity. It posts as `operational`, runs through `LifecycleOperationalStore`, performs no semantic command-dedup lookup or event append, never accepts capability/approval/grant fields, and returns `OPERATION_OUTCOME_UNKNOWN` with the exact work identity on uncertain delivery so the caller may explicitly inspect/retry the fenced operation. Materialize includes the byte recheck, replacement, fsync, and repository acknowledgement; there is no standalone acknowledgement operation. No automatic retry or replacement identity is generated.

On a posted semantic timeout, exit, message error, protocol error, or uncertain commit, poison the executor just like append mutation. Exact retry occurs only after binding revalidation and a new executor, using `resumePending` from the crash-durable store.

- [ ] **Step 7: Run protocol, executor, root/child/checkpoint/evidence, and build gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-executor.test.js dist-test/tests/project-store-executor.test.js dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/evidence-coverage.test.js
npm run typecheck
npm run build
npm run test:build-artifacts
```

Expected: strict tagged codecs pass, raw authority never crosses, mutation poisoning preserves IDs, existing executor behavior remains green, and the production worker stays lifecycle-disabled.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/runtime/lifecycle-worker-protocol.ts src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts src/orchestrator/runtime/worker-protocol.ts src/orchestrator/runtime/project-store-executor.ts src/orchestrator/runtime/project-store-worker-backend.ts src/orchestrator/runtime/project-store-worker-runtime.ts src/workers/project-store.worker.ts src/orchestrator/lifecycle/authority/authority-material-adapter.ts tests/lifecycle-worker-protocol.test.ts tests/lifecycle-executor.test.ts tests/project-store-executor.test.ts
git commit -m "feat: add disabled lifecycle worker protocol"
```

---

### Task 14: Create the Generation-Fenced Session-End Workflow

**Files:**
- Create: `src/orchestrator/lifecycle/session-end-policy.ts`
- Create: `src/orchestrator/storage/session-end.repository.ts`
- Create: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Create: `src/orchestrator/lifecycle/session-end.coordinator.ts`
- Create: `src/orchestrator/lifecycle/materialization-queue.port.ts`
- Create: `tests/session-end-policy.test.ts`
- Create: `tests/session-end.coordinator.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/session-end.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/checkpoint.service.ts`
- Modify: `src/orchestrator/lifecycle/child-workflow.service.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`

**Interfaces:**
- `SessionEndRepository` owns deterministic workflow identity, generation/phase/claim CAS, immutable request/policy JSON decoding, complete generation-bound validation-attempt plans, cancelled-row reopening, and event-position ordered recovery scans; it never owns immutable validation-result rows or a transaction.
- `SessionEndWorkflowService` classifies one next action at a time. Eventless claim/plan/phase CAS uses `LifecycleOperationalTransaction`; any action that appends a lifecycle event uses `LifecycleCommandTransaction` through `executeLifecycleInternalMutation` and normal semantic dedup.
- `SessionEndCoordinator.driveOnce` uses `ProjectStoreExecutor.executeLifecycleFenced` to claim/renew/release and for an eventless phase, then uses `executeLifecycleInternalMutation` for an event-appending phase. It claims at most one workflow, performs no asynchronous validation while SQLite is in a transaction, and advances at most one durable phase per call.
- `LifecycleMaterializationQueuePort` is introduced before workflow code depends on materialization. Tasks 14-15 use a recording fake; Task 16 supplies the only SQLite/renderer/fingerprint implementation.

```ts
export type SessionEndPhase =
  | "requested"
  | "children-resolved"
  | "final-checkpoint-recorded"
  | "ending-materialization-queued"
  | "validating"
  | "verification-passed"
  | "verification-failed"
  | "completion-appended"
  | "completed-materialization-confirmed"
  | "completed"
  | "cancelled"
  | "abandoned";

export interface SessionEndWorkflowClaim {
  workflowId: string;
  sessionId: string;
  generation: bigint;
  phase: SessionEndPhase;
  claimOwnerId: string;
  claimToken: bigint;
  claimExpiresAtMs: bigint;
  triggeringEventPosition: bigint;
}

export interface LifecycleMaterializationQueuePort {
  prepare(input: MaterializationProjectionInput): PreparedMaterializationQueue;
  persist(transaction: LifecycleCommandTransaction, prepared: PreparedMaterializationQueue, triggeringEvent: StoredEvent): void;
}

export class SessionEndWorkflowService {
  request(tx: LifecycleCommandTransaction, command: RequestSessionEndCommandV2): FreshLifecycleEffect<SessionEndStatusV2>;
  amend(tx: LifecycleCommandTransaction, command: AmendSessionEndCommandV2): FreshLifecycleEffect<SessionEndStatusV2>;
  cancel(tx: LifecycleCommandTransaction, command: CancelSessionEndCommandV2): FreshLifecycleEffect<SessionEndStatusV2>;
  classifyNext(claim: SessionEndWorkflowClaim): SessionEndNextAction;
  advanceOperational(tx: LifecycleOperationalTransaction, claim: SessionEndWorkflowClaim, action: EventlessSessionEndAction): SessionEndPhaseResultV2;
  advanceSemantic(tx: LifecycleCommandTransaction, claim: SessionEndWorkflowClaim, action: SemanticSessionEndAction): FreshLifecycleEffect<SessionEndPhaseResultV2>;
}

export class SessionEndCoordinator {
  driveOnce(executor: ProjectStoreExecutor, signal: AbortSignal): Promise<SessionEndCoordinatorResult>;
}
```

- [ ] **Step 1: Write failing quality-policy and request-gate tests**

Test threshold integer range 0..10,000; at most 64 profiles; canonical profile/version order; weight 1..1,000,000; positive total; required profile inclusion/no reweight; caller adds only allowlisted optional profiles; trusted boolean OR; max trusted/caller threshold; exact checked bigint formula; required failure blocking regardless of score; and coverage-only `requireFullEvidence` failure.

```ts
it("computes deterministic weighted basis points without floating point", () => {
  const policy = effectivePolicy({
    threshold: 6_667,
    profiles: [
      { profileId: "a", profileVersion: 1, required: true, weight: 2n },
      { profileId: "b", profileVersion: 1, required: false, weight: 1n },
    ],
  });
  assert.equal(scorePolicy(policy, new Map([["a@1", "pass"], ["b@1", "fail"]])).score, 6_666);
});
```

- [ ] **Step 2: Write failing workflow request/phase/claim/amend/cancel tests**

Cover deterministic `session-end/{sessionId}`, active/suspended previous state, pre-mutation fold of every nonterminal child, require-completed zero effect, carry-forward suspension/tickets/final checkpoint inclusion, one `SessionEndRequested`, different end command while ending, exact retry, final checkpoint, recording materialization-port calls, claim expiry/takeover/token, one phase per call, stale generation/token zero effect, verification-failed waiting, amendment earliest affected phase/new generation, cancellation restore/rewrite, and crash/restart after each phase. Prove the final `SessionCheckpointRecorded` semantic transaction queues the ending projection at that exact event position; the following eventless phase only verifies that immutable row before advancing to `ending-materialization-queued`, with no invented queue event. Also prove eventless phase CAS never touches event append/dedup, event-appending phase retries use one deterministic planned-work/command identity through semantic dedup, request/amend DTOs reject result IDs/observations, a complete 1..64-profile validation-attempt-plan array is persisted once per generation, and a request → cancel → request sequence reopens the same workflow at G+1 without a second insert while all old exact retries remain historical.

- [ ] **Step 3: Run focused tests and observe missing workflow implementation**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js
```

Expected: build fails because session-end policy/repository/workflow/coordinator modules are absent.

- [ ] **Step 4: Implement effective policy and deterministic request**

Use checked bigint arithmetic:

```ts
export function qualityScore(
  passingWeight: bigint,
  totalEffectiveWeight: bigint,
): number {
  if (totalEffectiveWeight <= 0n) throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
  return Number((10_000n * passingWeight) / totalEffectiveWeight);
}
```

Persist requested/effective child policy, threshold, policy version, canonical profile entries, `requireFullEvidence`, and `requireMaterialization` in strict Version 1 workflow JSON. Caller cannot omit/reweight trusted profiles or weaken trusted defaults, and no request/amendment field accepts a validation result ID or observation. Only server-planned result IDs from the current generation may later satisfy validation.

Before `SessionEndRequested`, shortlist children from authority but fold each child stream. Under require-completed, active/completion-proposed/suspended returns `SESSION_CHILDREN_ACTIVE` with zero event/workflow change. Under carry-forward, suspend eligible children and create immutable tickets in the same lifecycle command plan. Verify current root proof and required pre-end checkpoint, append one request, set root to ending, capture prior state, create generation 1 only when no workflow exists, or reopen the durable cancelled row at G+1 under the exact reset rules, and renew the root lease.

- [ ] **Step 5: Implement fenced repository claims and one-phase advancement**

```ts
export class SessionEndRepository {
  createOrReopenSessionEnd(connection: SqliteConnection, input: SessionEndWorkflowInsert): SessionEndWorkflowRecord;
  claimNext(connection: SqliteConnection, input: WorkflowClaimRequest): SessionEndWorkflowClaim | null;
  renewClaim(connection: SqliteConnection, claim: SessionEndWorkflowClaim, nowMs: bigint, ttlMs: bigint): SessionEndWorkflowClaim;
  compareAndSwapPhase(connection: SqliteConnection, input: WorkflowPhaseCompareAndSwap): boolean;
  incrementGeneration(connection: SqliteConnection, input: WorkflowAmendment): SessionEndWorkflowRecord;
  releaseClaim(connection: SqliteConnection, claim: SessionEndWorkflowClaim): void;
  scanRecoverable(connection: SqliteConnection, nowMs: bigint, limit: number): readonly SessionEndWorkflowRecord[];
}
```

Every phase update matches project/workflow/generation/current phase/current owner/current token and a live claim expiry. Takeover increments `coordinator_claim_token`; PID/liveness never authorizes mutation. Scan order is triggering event position then workflow ID. Claim, renew, release, scan, validation-attempt-plan persistence, and eventless phase CAS cross the Task 13 internal fenced-operation executor port and `LifecycleOperationalStore`; they never touch semantic dedup or event append. A phase action that appends an event crosses only `executeLifecycleInternalMutation` and `LifecycleCommandStore`.

One classified action performs exactly one of: resolve children; record the final checkpoint through `CheckpointService.recordFinal` and queue the position-independent ending projection in that same semantic command's `afterAppend`, passing the actual committed `SessionCheckpointRecorded` as the triggering event; verify that exact outbox row and eventlessly advance from `final-checkpoint-recorded` to `ending-materialization-queued`; move to validating; persist one complete canonical deterministic validation-attempt-plan array for every effective profile; or record a phase already proven by durable result/materialization completion. The ending row's `materializationRevision` is the final checkpoint event position; there is no `MaterializationQueued` lifecycle event. Each action commits before returning. Eventless actions use `advanceOperational`; final checkpoint plus every verification or terminal event that queues materialization uses `advanceSemantic`. Recording fakes prove workflow behavior here; concrete rendering/fingerprints/outbox rows are Task 16 integration tests. The coordinator releases/renews claims between external work and never loops asynchronously while SQLite holds a transaction.

Every coordinator-origin event-appending mutation uses a stable internal replay expectation containing workflow ID, generation, server-derived internal audience, and deterministic `plannedWorkId`; on a dedup miss, the semantic-store callback checks the live claim owner/token and persists them in the `internal-workflow` authorization record. For a phase action, canonicalize `(projectId, workflowId, generation, sourcePhase, action)` once, derive `commandId` with UUIDv5 under the fixed namespace `a7b47792-6ad9-5b32-9f20-6f53f5dc2f31`, derive `idempotencyKey = lifecycle-phase-v1/{sha256(canonical action)}`, then compute the domain-separated phase `plannedWorkId` over that action plus both derived identities. Thus there is no derivation cycle and takeover reproduces the exact command before checking the expired original claim. Before any external validation, persist the paired `validation_attempt_plan_generation` and complete canonical `validation_attempt_plans_json` once for the current generation. It contains exactly one unique plan per effective profile—run ID, result ID, result command ID, and result idempotency key—and at most 64 entries. Crash retry reuses that array; amendment or cancelled-row reopening increments generation and atomically clears it before one new array may be written. There is no ambiguous choice among multiple results in one generation.

- [ ] **Step 6: Implement amendment and cancellation generation fencing**

Amendment requires current root proof and pre-transition checkpoint, increments workflow generation, fences all prior coordinator/outbox claims, clears earlier attempt plans, records only changed evidence/profile/threshold/materialization/child-policy fields, resets the earliest affected phase, appends `SessionEndAmended`, queues a new materialization revision through the port, and sets a post-transition checkpoint marker.

Cancellation requires the same authority/pre-checkpoint rules, appends `SessionEndCancelled`, restores only the persisted active/suspended state, increments/fences generation, clears claims/attempt plans, moves the workflow to durable `cancelled`, and queues a deterministic cancelled/restored artifact revision equal to the cancellation event position. It cannot affect ended/abandoned roots. A new ordinary end command while ending still returns `SESSION_END_INCOMPLETE`; only amendment/cancellation may alter that generation.

A later authorized end request from the restored active/suspended root calls `createOrReopenSessionEnd`: it detects the existing cancelled deterministic row, increments generation, replaces prior-state/request/effective-policy/triggering-event fields, clears claim/retry/failure/attempt-plan state, appends a fresh `SessionEndRequested`, queues the new ending revision, and returns to `requested` atomically. It never inserts a second row. A crash/lost response retries by the original command identity, and all earlier request/cancel dedup rows remain immutable historical effects.

- [ ] **Step 7: Run policy/workflow/child/checkpoint/transaction gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/lifecycle-command-store.test.js
npm run typecheck
```

Expected: policy arithmetic, child gates, split semantic/operational transaction ownership, generation/token fencing, one-phase durability, amendment reset, cancellation restore, and restart tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/lifecycle/session-end-policy.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/session-end.coordinator.ts src/orchestrator/lifecycle/materialization-queue.port.ts src/orchestrator/lifecycle/contracts/session-end.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/checkpoint.service.ts src/orchestrator/lifecycle/child-workflow.service.ts src/orchestrator/storage/session-authority.repository.ts tests/session-end-policy.test.ts tests/session-end.coordinator.test.ts
git commit -m "feat: persist session end workflow"
```

---

### Task 15: Run Trusted Validation, Complete or Abandon, and Recover Safely

**Files:**
- Create: `src/orchestrator/lifecycle/validation-profile.registry.ts`
- Create: `src/orchestrator/lifecycle/validation-profile.runner.ts`
- Modify: `src/orchestrator/lifecycle/source-state.provider.ts`
- Create: `src/orchestrator/storage/lifecycle-validation-result.repository.ts`
- Create: `src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts`
- Create: `tests/validation-profile-runner.test.ts`
- Create: `tests/lifecycle-recovery.test.ts`
- Modify: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/session-end.coordinator.ts`
- Modify: `src/orchestrator/lifecycle/materialization-queue.port.ts`
- Modify: `src/orchestrator/lifecycle/contracts/events.ts`
- Modify: `src/orchestrator/lifecycle/contracts/session-end.ts`
- Modify: `src/orchestrator/storage/session-end.repository.ts`
- Modify: `src/orchestrator/storage/lifecycle-approval.repository.ts`
- Modify: `tests/session-end.coordinator.test.ts`

**Interfaces:**
- `ValidationProfileRegistry` resolves IDs only from trusted configuration. A lifecycle request contains no command, executable, path, environment, CWD, script, timeout, or weight.
- `ValidationProfileRunner` runs resolved definitions outside SQLite transactions and returns normalized redacted observations; `LifecycleValidationResultRepository` persists immutable bound results inside a semantic lifecycle command.
- Reuse Task 11's `SourceStateProvider`: async capture runs outside SQLite transactions and synchronous finalization capture runs inside the short `SessionEnded` transaction.
- `LifecycleRecoveryCoordinator` runs integrity first and may resume only existing idempotent workflow/outbox work.

```ts
export interface ValidationProfileDefinition {
  profileId: string;
  profileVersion: number;
  configurationHash: string;
  required: boolean;
  weight: bigint;
  timeoutMs: number;
  execute(context: ValidationExecutionContext, signal: AbortSignal): Promise<ValidationObservation>;
}

export interface SourceStateProvider {
  capture(context: ProjectContext, scope: SourceStateScopeV1): Promise<SourceStateFingerprintV1>;
  captureForCheckpoint(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1;
  captureForFinalization(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1;
}

export class ValidationProfileRunner {
  run(plan: ValidationRunPlanV1, signal: AbortSignal): Promise<readonly ValidationResultSubmissionV1[]>;
}

export interface LifecycleRecoveryScanResult {
  workflows: readonly SessionEndWorkflowClaimCandidate[];
  outbox: readonly LifecycleOutboxClaimCandidate[];
  endingWithoutCoordinator: readonly EndingSessionDiagnostic[];
  invariantFailures: readonly LifecycleInvariantFailure[];
  expiredRootLeases: readonly ExpiredRootLeaseDiagnostic[];
}
```

- [ ] **Step 1: Write failing trusted-profile and immutable-result tests**

Cover allowlisted resolution, required/optional canonical order, caller-supplied command/path/env/CWD/script/result-ID/observation rejection at wire decode, timeout normalization, pass/fail/unavailable, no raw stdout/stderr retention, keyed output fingerprint and artifact refs, scoped source state at start/completion, exact persisted run/result/command/idempotency identity, runner identity, workflow/generation/profile/config/checkpoint binding, stale/future/wrong-project result rejection, duplicate immutable result, missing/wrong recorded event position, and handle/process closure. Prove only the complete persisted attempt-plan array for the current generation is selectable; a committed result replays by its stable plan identity after the original claim expires/takes over without invoking fresh validation, while a dedup miss must verify the current live claim.

- [ ] **Step 2: Write failing pass/fail/source-race/terminal tests**

Cover required failure, threshold failure, unavailable weight zero, coverage-only full-evidence failure, fresh all-pass path, source change before pass, source change between pass and terminal transaction, `SessionEndVerificationInvalidated`, exactly one `SessionEnded`, authority revocation, terminal amendment/cancel/resume/abandon rejection, optional/required completion materialization behavior, and response loss after validation result/pass/end. Prove ending/failed/completed compatibility target and committed temp writes leave the scoped witness unchanged, while a normal tracked or untracked project edit still causes `SESSION_SOURCE_STATE_CONFLICT`.

- [ ] **Step 3: Write failing abandonment and recovery tests**

Test root proof plus signed abandonment approval, action separation, pre-checkpoint reference, single-use consumption, no capability recipient, terminal `SessionAbandoned`, queued abandoned rewrite, active/suspended/ending entry, generation fencing of an ending workflow, and no successful-completion claim. Test recovery scan ordering, integrity failure read-only mode, ending without coordinator, expired lease diagnostics only, retryable versus permanent work, and prohibition on inferred end/transfer/abandonment.

- [ ] **Step 4: Run focused tests and observe missing validation/recovery modules**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/validation-profile-runner.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/lifecycle-recovery.test.js
```

Expected: build fails because trusted validation, immutable result repository, and recovery coordinator do not exist; Task 11's source-state provider exists but has not yet been integrated with validation.

- [ ] **Step 5: Implement trusted execution and immutable result persistence**

Resolve profile definitions from the persisted effective policy and trusted registry; reject version/configuration/weight drift. Load the complete current-generation attempt-plan array from Task 14 and run each definition with its unique exact run/result/command/idempotency identity plus an internal `AbortController` deadline, never a caller command. A retry after crash reuses the same array entry; it never generates a second identity. Normalize observation to status, exit classification, concise redacted summary, artifact references, and provider-keyed output fingerprint. Destroy raw output buffers after fingerprint/summary generation.

Persist through:

```ts
export class LifecycleValidationResultRepository {
  insert(connection: SqliteConnection, result: LifecycleValidationResultV1, recordedEventPosition: bigint): void;
  getBound(connection: SqliteConnection, query: BoundValidationResultQuery): LifecycleValidationResultV1 | null;
  listForGeneration(connection: SqliteConnection, projectId: string, workflowId: string, generation: bigint): readonly LifecycleValidationResultV1[];
}
```

The trusted coordinator submits the normalized observation through `executeLifecycleInternalMutation` using the one persisted attempt-plan command/result identity as `plannedWorkId`. Before store execution, the runtime selects that trusted plan and constructs the stable internal replay expectation without treating the current claim as a replay prerequisite. `LifecycleCommandStore` checks dedup first: a committed exact replay returns even after the original claim expires. Only on a dedup miss does the fresh callback verify the current workflow/generation/claim, construct the complete persisted `internal-workflow` authorization record, and prepare `SessionValidationResultRecorded`. In `afterAppend`, it passes the actual committed event position to the connection-bound repository insert, which requires the deferred event foreign key and then deduplicates by the persisted result command. The row stores run/runner identity, both versioned source-state-scope/project/workspace/branch/HEAD/dirty witnesses, output algorithm/schema/key/domain/value, artifact references, freshness, and recorded event position. The event/result retain fingerprints and redacted metadata only.

- [ ] **Step 6: Implement verification branches and terminal compare-and-swap**

At validating phase, load each current generation's server-planned result through `LifecycleValidationResultRepository.getBound`; accept only the single immutable result whose project, workflow generation, attempt plan, profile config, final-checkpoint fingerprint, source-state scope/witnesses, recorded event, and freshness all match. Calculate score with Task 14 arithmetic. Any missing/ambiguous/stale planned result, required failure, low score, unavailable required result, or effective `requireFullEvidence` appends `SessionEndVerificationFailed`, queues a failed-state materialization revision through the port, and moves to the waiting branch through one internal semantic mutation; eventless waiting/claim bookkeeping remains operational.

Before pass, resolve the trusted scope again, recapture source state, and require the same scope version and semantic witness as checkpoint/validation completion; system-owned exact store/pending/materialization target/temp paths are filtered. Otherwise append failed with `SESSION_SOURCE_STATE_CONFLICT` and queue its failed-state revision. On success append `SessionEndVerificationPassed` and move to verification-passed.

The final transaction calls synchronous `captureForFinalization(context, trustedScope)` after `BEGIN IMMEDIATE` and immediately before its terminal compare-and-swap. It compares scope version and semantic witness with the final checkpoint, validation-completion witness, and the witness accepted by `SessionEndVerificationPassed`. This trusted fixed implementation performs no `await`, caller-selected command, or unrelated validation work and keeps the transaction bounded. If changed, append `SessionEndVerificationInvalidated`, queue that event-position revision, and atomically return to verification-failed. Otherwise append exactly one `SessionEnded`, set authority terminal/revocation fields and commitment, revoke root/children as policy requires, queue the completed revision equal to the end event position, and move to completion-appended. If materialization is not required, advance directly to completed; otherwise wait for acknowledgement of that exact revision from Task 16.

- [ ] **Step 7: Implement approved abandonment and integrity-first recovery**

Abandonment verifies both current root semantic proof and `AbandonmentApprovalV1`, current generation/audience/intent, required pre-checkpoint, and healthy integrity. It fences any ending workflow, moves that row to durable `abandoned`, appends `SessionAbandoned`, revokes authority, writes the complete approval-consumption tuple, stores no recipient descriptor, and queues the abandoned-state revision in one transaction. Ending abandonment uses workflow origin/generation plus the new revision; active/suspended abandonment uses `terminal-event` origin with null workflow fields and `materializationRevision = SessionAbandoned` position.

Recovery performs quick integrity first. On failure it returns read-only `INTEGRITY_FAILURE`. Otherwise it scans nonterminal workflows and due outbox revisions in deterministic triggering-position order, ending roots without a live claim, fold/index mismatches, and expired root leases. `recoverOnce` may claim and advance an existing generation or due artifact revision only; it cannot append pass/end, transfer ownership, consume approval, or infer abandonment without the exact durable prerequisites.

- [ ] **Step 8: Run validation, end, recovery, approval, and integrity gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/validation-profile-runner.test.js dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/lifecycle-recovery.test.js dist-test/tests/lifecycle-approval.test.js dist-test/tests/event-integrity.test.js
npm run typecheck
```

Expected: trusted-only execution, immutable binding, deterministic policy, both source-race branches, exactly one terminal event, approved abandonment, and integrity-first recovery all pass.

- [ ] **Step 9: Commit**

```powershell
git add src/orchestrator/lifecycle/validation-profile.registry.ts src/orchestrator/lifecycle/validation-profile.runner.ts src/orchestrator/lifecycle/source-state.provider.ts src/orchestrator/lifecycle/materialization-queue.port.ts src/orchestrator/storage/lifecycle-validation-result.repository.ts src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/session-end.coordinator.ts src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/lifecycle/contracts/session-end.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/storage/lifecycle-approval.repository.ts tests/validation-profile-runner.test.ts tests/lifecycle-recovery.test.ts tests/session-end.coordinator.test.ts
git commit -m "feat: verify and recover session end"
```

---

### Task 16: Materialize Deterministic Compatibility Logs with Revision Fencing

**Files:**
- Create: `src/orchestrator/storage/lifecycle-outbox.repository.ts`
- Create: `src/orchestrator/materialization/vault-artifact-path.ts`
- Create: `src/orchestrator/materialization/compatibility-log.renderer.ts`
- Create: `src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts`
- Create: `src/orchestrator/materialization/atomic-artifact-replacer.ts`
- Create: `src/orchestrator/materialization/compatibility-log.materializer.ts`
- Create: `tests/compatibility-log-renderer.test.ts`
- Create: `tests/compatibility-log-materializer.test.ts`
- Modify: `src/orchestrator/lifecycle/materialization-queue.port.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- Modify: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/session-end.coordinator.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts`
- Modify: `src/orchestrator/storage/session-end.repository.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`

**Interfaces:**
- The target path is derived only from committed `SessionStarted` UTC date and session ID: `05_Agent_Session_Logs/{yyyy-mm-dd}-session-{sessionId}.md`.
- `CompatibilityLogRenderer` is pure and renders committed events only through the outbox triggering position.
- `SqliteLifecycleMaterializationQueue` implements `LifecycleMaterializationQueuePort` by composing the pure renderer, provider-keyed fingerprint service, and connection-bound `tx.outbox.insertLifecycle`; the raw `LifecycleOutboxRepository` remains storage-only. Its `acknowledge` method is private to the materializer's atomic operational callback and is never exposed as a coordinator/executor wire operation.
- Each immutable row retains one planned fingerprint per revision and uses `targetKey = lifecycle-log/{sessionId}/{materializationRevision}` so the Version 1 `(project_id, target_key)` primary key can store history while every revision still derives the same artifact path.
- `CompatibilityLogMaterializer` is bound inside the lifecycle worker runtime and performs the approved temp-write/fingerprint/recheck/replace/fsync/ack sequence. A trusted materialization coordinator invokes only claim/renew/materialize/failure through `ProjectStoreExecutor.executeLifecycleFenced`; `materialize` uses `LifecycleOperationalStore` for the one short replacement-plus-ack transaction. That transaction recognizes an exact already-completed row before enforcing lease expiry, verifies its retained acknowledgement tuple and current latest target bytes, and returns the stored completion. The materializer never recursively calls the executor, semantic dedup, or the Version 1 `NoteRepository`.

```ts
export interface LifecycleOutboxClaim {
  targetKey: string;
  sessionId: string;
  artifactKind: "compatibility-session-log";
  artifactPath: string;
  originKind: "workflow" | "terminal-event";
  workflowId: string | null;
  workflowGeneration: bigint | null;
  triggeringEventPosition: bigint;
  materializationRevision: bigint;
  claimOwnerId: string;
  claimToken: bigint;
  claimExpiresAtMs: bigint;
  expectedPriorFingerprint: KeyedFingerprintV1 | null;
  nextFingerprint: KeyedFingerprintV1;
}

export class LifecycleOutboxRepository {
  insertLifecycle(connection: SqliteConnection, input: LifecycleOutboxInsert): void;
  claimNext(connection: SqliteConnection, input: OutboxClaimRequest): LifecycleOutboxClaim | null;
  renewClaim(connection: SqliteConnection, input: OutboxClaimRenewal): LifecycleOutboxClaim;
  acknowledge(connection: SqliteConnection, input: OutboxAcknowledgement): boolean;
  recordFailure(connection: SqliteConnection, input: OutboxFailure): boolean;
  listCommittedLowerRevisionFingerprints(connection: SqliteConnection, claim: LifecycleOutboxClaim): readonly KeyedFingerprintV1[];
}

export class SqliteLifecycleMaterializationQueue implements LifecycleMaterializationQueuePort {
  prepare(input: MaterializationProjectionInput): PreparedMaterializationQueue;
  persist(tx: LifecycleCommandTransaction, prepared: PreparedMaterializationQueue, triggeringEvent: StoredEvent): void;
}

export class CompatibilityLogRenderer {
  render(input: CompatibilityLogRenderInput): Uint8Array;
}

export class CompatibilityLogMaterializer {
  materialize(claim: LifecycleOutboxClaim): MaterializationResultV1;
}
```

- [ ] **Step 1: Write failing deterministic renderer/path tests**

Create golden byte fixtures for active-ending, failed-validation, cancelled/restored, abandoned, ended-with-accepted-child-results, and ended-with-transfer-follow-ups. Prove same events/position produce identical UTF-8/LF bytes across retry, process, topic changes, workflow generation, and locale; path uses original UTC start date; visible ending marker appears only for folded ending state; materialized position and identity/source/fingerprint metadata are exact; and no raw evidence/output/secret appears.

- [ ] **Step 2: Write failing claim/replacement/crash/fencing tests**

Cover queue-port integration through renderer/fingerprint/connection-bound insert; deterministic revision-bearing target keys with one shared path; ordered claims, expired claim takeover/token increment, live renewal, stale token/revision/workflow generation, expiry during staging, next fingerprint committed before write, absent/equal/acknowledged-prior targets, unknown bytes permanent conflict, write-before-ack lost response, and replacement-before-ack followed by newer ending → validation-failed → completed, amendment, cancellation, and abandonment revisions replacing committed lower-revision fingerprints. Include exact `materialize` retry after committed acknowledgement/lost response and after the original lease expires: matching retained owner/token/revision/fingerprint plus latest target bytes returns the stored completion without reclaim, while missing/changed bytes, a mismatched tuple, or an unacknowledged expired row cannot succeed. Also cover deterministic superseded-after-completion status when a newer revision exists, rejection of any standalone acknowledgement wire, active/suspended abandonment with terminal-event origin/null workflow, retryable backoff, permanent conflict nonretry, file/directory fsync, symlink/path substitution, Windows handle closure, and source-state witnesses that remain unchanged across system target/temp writes.

```ts
it("lets a newer revision replace committed stale bytes after lost acknowledgement", () => {
  const revision41 = queueAndClaimRevision(41n);
  materializerFaults.stopAfterReplace(revision41);
  assert.throws(() => materializer.materialize(revision41), /INJECTED_CRASH/);
  const staleBytes = readFileSync(targetPath);

  const revision52 = amendAndClaimRevision(52n);
  const result = materializer.materialize(revision52);
  assert.equal(result.status, "completed");
  assert.notDeepEqual(readFileSync(targetPath), staleBytes);
  assert.equal(loadOutbox(revision52).status, "completed");
});
```

- [ ] **Step 3: Run focused tests and observe missing materializer implementation**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/compatibility-log-materializer.test.js dist-test/tests/session-end.coordinator.test.js
```

Expected: build fails because renderer, path derivation, outbox repository, and materializer do not exist.

- [ ] **Step 4: Implement canonical path and byte rendering**

Derive start date from the first committed `SessionStarted`, validate lowercase session UUID, construct only the fixed relative path, canonicalize the existing parent, reject symlink substitution/outside containment, and create no other target. Temporary names are a fixed hidden encoding of the exact target/session/materialization-revision/claim-token tuple; the source-state scope resolver excludes one only when that tuple matches a committed outbox claim.

Renderer folds events through `triggeringEventPosition` and emits fixed headings/order, JSON-scalar escaping, LF endings, final newline, explicit semantic state, accepted child items, deferred/rejected/unresolved transfer work, final checkpoint, validation status/fingerprints/artifacts, project/workspace/branch assertions, and materialized position. It never reads wall clock, process ID, current topic, or raw evidence.

- [ ] **Step 5: Implement generation-fenced outbox claims and deterministic fingerprints**

When a lifecycle transaction queues materialization, `SqliteLifecycleMaterializationQueue.prepare` strict-decodes and freezes only the position-independent projected event/fold input. Its `persist` method receives the actual triggering `StoredEvent` in `afterAppend`, requires its identity/type/payload to match the projection, renders bytes through that committed position, computes the provider-keyed `nextFingerprint`, and calls only `tx.outbox.insertLifecycle` with algorithm/schema/key/domain before commit. `materializationRevision` must equal that committed triggering position. Target identity is `(project, session, artifact kind, materialization revision)`, encoded into the revision-bearing `targetKey`, while all revisions derive the same path. The immutable rows are the planned-fingerprint history. Port integration tests prove the persisted fingerprint equals a later independent render; repository tests retain raw connection-taking methods only inside storage-focused fixtures.

Claims, renewals, failures, and a noncompleted materialize operation match project/target/latest revision/status/owner/token/live expiry and, for workflow origin, current workflow generation. `renewClaim` compare-and-swaps project/target/revision/owner/token while the claim is live and the revision remains current; staging that outlives expiry must renew successfully before replacement or stop. On materialize entry, however, exact completed-state replay is checked first under the operational transaction: the row must retain completed status, acknowledgement owner/token/revision and `nextFingerprint`. If it is still latest, current target bytes must match that fingerprint before the stored completion is returned even when the old lease is expired; if a newer revision exists, return bounded `superseded-after-completion` without touching bytes. Only a noncompleted row proceeds to live-lease enforcement and replacement. Each operation is a strict internal `LifecycleFencedOperation`, never a semantic mutation, and uncertain delivery reports the exact work identity for explicit state inspection/retry. Repository acknowledgement is reachable only inside materialize after target-byte/fingerprint reconciliation. Failure rows store only retryable/permanent classification, safe code, bounded attempt count, and next attempt time. Backoff is deterministic and capped; permanent integrity/path/conflict failures are never auto-retried.

- [ ] **Step 6: Implement the exact replace/ack sequence**

The materializer:

1. folds/renders deterministic bytes through triggering position;
2. stages a same-directory exclusive temp file, fsyncs it, and computes keyed fingerprint;
3. enters `LifecycleOperationalStore`, which opens the only short `BEGIN IMMEDIATE` and loads the exact row by project/target/revision/owner/token;
4. if the row is completed and still latest, verifies retained acknowledgement/fingerprint fields and current target bytes equal committed `nextFingerprint`, removes the known temp, commits, and returns the stored completion without checking lease expiry; if a newer revision exists, returns `superseded-after-completion` without a write;
5. otherwise requires claimed/noncompleted status and rechecks live claim token/expiry, latest materialization revision, applicable current workflow generation, fingerprint algorithm/schema/key/domain, and committed `nextFingerprint`;
6. accepts target only when absent, already equal to new bytes, equal to acknowledged expected prior, or equal to a committed `nextFingerprint` of a now-fenced lower revision for the same project/session/kind/path;
7. atomically replaces, fsyncs target and directory where supported;
8. records acknowledgement/fingerprint/token; and
9. commits before success response.

Any other bytes throw permanent `MATERIALIZATION_CONFLICT`. Cleanup removes only the known contained temp path. A lost response retries the complete `materialize` operation with the exact identity; completed-state replay precedes live-lease enforcement and returns the one stored completion only after byte reconciliation. An expired pending/unacknowledged claim must be taken over and retried under its new exact identity. No caller can acknowledge without byte reconciliation. After required completed-materialization acknowledgement, the end workflow advances through confirmed to completed without appending another `SessionEnded`.

- [ ] **Step 7: Integrate cancellation, abandonment, and recovery**

Validation failure/invalidation, completion, amendment, cancellation, and abandonment each queue a new revision targeting the same path. Renderer derives failed, completed, cancelled/restored, or abandoned state, so a stale ending/completed marker cannot remain. Direct active/suspended abandonment uses terminal-event origin; all other session-end rewrites retain their workflow binding. Recovery claims only due current revisions, respects permanent failure and integrity read-only mode, and reports terminal semantic state separately from incomplete materialization.

- [ ] **Step 8: Run materialization, end/recovery, durability, and integrity gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/compatibility-log-materializer.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/lifecycle-recovery.test.js dist-test/tests/directory-durability.test.js dist-test/tests/event-integrity.test.js
npm run typecheck
```

Expected: golden bytes/path, crash retry, lower-revision recognition, conflict fencing, rewrites, completion confirmation, durability, and handle closure all pass.

- [ ] **Step 9: Commit**

```powershell
git add src/orchestrator/storage/lifecycle-outbox.repository.ts src/orchestrator/materialization src/orchestrator/lifecycle/materialization-queue.port.ts src/orchestrator/lifecycle/lifecycle-operational.store.ts src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/session-end.coordinator.ts src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/compatibility-log-renderer.test.ts tests/compatibility-log-materializer.test.ts
git commit -m "feat: fence compatibility log materialization"
```

---

### Task 17: Keep Version 2 Disabled and Shadow Mapping Pure

**Files:**
- Create: `src/orchestrator/compatibility/lifecycle-v2-disabled.adapter.ts`
- Create: `src/orchestrator/compatibility/lifecycle-v2-shadow.mapper.ts`
- Create: `tests/lifecycle-compatibility.test.ts`
- Modify: none of `src/app.ts`, `src/index.ts`, `src/controllers`, `src/schemas`, or `src/services`.

**Interfaces:**
- `LifecycleV2DisabledAdapter` has only a Version 1 port dependency; it has no executor/provider/store factory and returns exact input/output identities unchanged.
- `mapLifecycleShadowComparison` is a pure function over one captured redacted Version 1 exchange, one trusted binding summary, and redacted candidate summaries. It cannot produce or execute a Version 2 command.

```ts
export class LifecycleV2DisabledAdapter {
  constructor(private readonly v1: LifecycleV1Port) {}

  invoke<K extends keyof LifecycleV1Port>(
    operation: K,
    input: Parameters<LifecycleV1Port[K]>[0],
  ): ReturnType<LifecycleV1Port[K]>;
}

export interface ShadowComparisonV1 {
  schemaVersion: 1;
  executable: false;
  v1IntentHash: string;
  v1OutcomeHash: string;
  association: "unique" | "none" | "ambiguous";
  candidate?: RedactedSessionSummary;
  divergence: readonly ShadowDivergence[];
}

export function mapLifecycleShadowComparison(
  captured: CapturedV1LifecycleExchange,
  binding: RedactedTrustedBindingSummary,
  candidates: readonly ShadowCandidateSummary[],
): ShadowComparisonV1;
```

- [ ] **Step 1: Write failing disabled-pass-through tests**

Use spies that throw if an executor/store/provider is constructed. Assert `strictEqual` on the exact input object received by the Version 1 port and exact output object returned. Cover every existing lifecycle/workflow Version 1 operation and thrown error identity; assert zero V2 event, file, database, capability, or binding side effect.

- [ ] **Step 2: Write failing pure shadow DTO/privacy tests**

Cover unique/none/ambiguous candidate association within exact project/workspace; identical continuity keys in another project; intentional supersession divergence; unsupported evidence-retention gap; deterministic hashes; bounded summaries; and absence of raw V1 payload, capability, command/idempotency IDs, callback, executor, or `executable: true`. Deep-freeze inputs and prove no mutation.

- [ ] **Step 3: Run focused tests and observe missing compatibility modules**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-compatibility.test.js dist-test/tests/memory-lifecycle.test.js dist-test/tests/memory-workflow.test.js
```

Expected: build fails because disabled and shadow modules do not exist.

- [ ] **Step 4: Implement exact disabled delegation**

`invoke` calls the selected Version 1 method with the original object and returns/throws exactly what that method returns/throws. Do not clone, parse, enrich, hash, log, establish a binding, open an executor, or infer a Version 2 operation. The adapter is not imported by production composition in this subproject.

- [ ] **Step 5: Implement bounded nonmutating shadow comparison**

Hash strict redacted captures under `project-memory/shadow-v1-intent/v1` and `project-memory/shadow-v1-outcome/v1`. Associate only when exactly one eligible Version 2 root has exact project/store/workspace identity; zero/multiple are diagnostic. Emit explicit divergences for Version 1 supersession, Version 2 selection/authority, invariant parity, identity/event positions, and coverage-only evidence. Freeze the DTO and never include enough data to execute a command.

- [ ] **Step 6: Prove production isolation and Version 1 compatibility**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/lifecycle-compatibility.test.js dist-test/tests/memory-lifecycle.test.js dist-test/tests/memory-workflow.test.js dist-test/tests/memory-usage.test.js dist-test/tests/note.controller.test.js
git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services
npm run typecheck
```

Expected: disabled/shadow tests and Version 1 suites pass, and the production-path diff against the immutable Subproject 2 base prints nothing and exits `0`.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/compatibility tests/lifecycle-compatibility.test.ts
git commit -m "feat: isolate lifecycle v2 compatibility"
```

---

### Task 18: Prove Cross-Process Ownership, Crash Recovery, and Secret Safety

**Files:**
- Create: `src/orchestrator/lifecycle/lifecycle-faults.ts`
- Create: `tests/support/lifecycle-fixture-client.ts`
- Create: `tests/support/lifecycle-test-key-broker.ts`
- Create: `tests/fixtures/project-store-lifecycle-child.ts`
- Create: `tests/fixtures/project-store-lifecycle-crash-child.ts`
- Create: `tests/fixtures/lifecycle-validation-profile-child.ts`
- Create: `tests/lifecycle.concurrent.test.ts`
- Create: `tests/lifecycle.crash.test.ts`
- Create: `tests/lifecycle.security.test.ts`
- Create: `tests/lifecycle.stress.test.ts`
- Create: `scripts/run-lifecycle-stress.js`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- Modify: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/session-end.coordinator.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts`
- Modify: `src/orchestrator/lifecycle/validation-profile.runner.ts`
- Modify: `src/orchestrator/lifecycle/authority/authority-material-adapter.ts`
- Modify: `src/orchestrator/storage/session-end.repository.ts`
- Modify: `src/orchestrator/storage/lifecycle-outbox.repository.ts`
- Modify: `src/orchestrator/materialization/atomic-artifact-replacer.ts`
- Modify: `src/orchestrator/materialization/compatibility-log.materializer.ts`
- Modify: `src/orchestrator/runtime/project-store-executor.ts`
- Modify: `package.json`

**Interfaces:**
- Fault injection is optional/default-noop and each durable boundary exposes only its explicitly valid crash points. Production composition always uses the noop injector.
- Real process fixtures use JSON IPC barriers and one parent-hosted in-memory test key broker; children send provider operations and receive outputs but never receive broker key bytes.
- The fixture client cooperatively closes every executor/worker/database/file handle and uses forced termination only as bounded cleanup.

```ts
export type LifecycleSqliteFaultPoint =
  | "before-write"
  | "after-write-before-commit"
  | "after-commit-before-response";

export type LifecycleExternalFaultPoint =
  | "before-external-start"
  | "after-external-complete-before-result-commit";

export type LifecycleFilesystemFaultPoint =
  | "before-temp-write"
  | "after-temp-fsync-before-replace"
  | "after-replace-before-ack";

export type LifecycleFaultPoint =
  | LifecycleSqliteFaultPoint
  | LifecycleExternalFaultPoint
  | LifecycleFilesystemFaultPoint;

export type LifecycleDurableBoundary =
  | "authority-cas" | "event-append" | "lease-update"
  | "workflow-create" | "workflow-phase" | "final-checkpoint"
  | "validation-result" | "final-source-state-check"
  | "outbox-insert" | "outbox-claim" | "temporary-file-write"
  | "artifact-replace" | "materialization-ack" | "outbox-failure"
  | "session-suspend" | "transfer-create" | "transfer-claim"
  | "ownership-recovery" | "generation-fence"
  | "cancellation-rewrite" | "abandonment-rewrite"
  | "verification-event" | "session-ended" | "response-delivery";

export interface LifecycleFaultInjector {
  hit(boundary: LifecycleDurableBoundary, point: LifecycleFaultPoint, context: LifecycleFaultContext): void;
}
```

- [ ] **Step 1: Write the real process fixture and key-broker protocols**

The parent starts every child and key broker, waits for `ready`, sends explicit project binding/open actions, waits for `started`, then releases named barriers. Define strict messages for start, lifecycle mutation/bounded/query, validation work, fault selection, result/error, and close. No correctness assertion uses `setTimeout`; timeouts only fail/clean up a stuck test.

The key broker generates project-scoped test keys in memory, services current/status/MAC/verify/fingerprint/seal/open requests, and zeroes them at shutdown. Provider requests include purpose/key ID/input, never key bytes. Do not place fixture keys in source, environment, argv, workerData, snapshots, or files.

- [ ] **Step 2: Write the default cross-process ownership/isolation test**

Run one trusted primary root, 32 child sessions, multiple unrelated roots in the same project, a second project with identical continuity keys/session-like payloads, and linked worktrees sharing only project storage. Prove:

- no child fork/report/proposal/completion/crash/reconnect changes root authority;
- no unrelated root is superseded, suspended, ended, or abandoned;
- only current root proof ends the target root;
- maintenance recovery routes only the descriptor to the approval target primary adapter, and the maintenance/provider spy observes zero reconstruction calls;
- project/workspace/continuity isolation is exact;
- final materialization contains accepted child results and unresolved carry-forward work only; and
- quick/full integrity and file-handle rename checks pass after closure.

- [ ] **Step 3: Write concurrency and lost-response tests**

Use barriers for simultaneous new starts and resumes. Assert one continuity owner and one owner-generation transfer winner. For semantic start, resume, suspension, recovery, fork, child-assignment amendment, checkpoint, evidence, child report/disposition/proposal/completion/transfer/claim, end request, internal event-appending workflow phase, validation result, amendment, cancellation, and abandonment: kill after commit/before response, retry the exact original command/idempotency identity, and assert one semantic effect. For an internal command, let the original claim expire/take over before retry and prove the stable planned-work expectation replays before the fresh live-claim callback. After a later generation, old proof replay returns the same public effect with stale material only.

Test workflow claim/renew/release/eventless-phase/recovery and outbox claim, renewal, materialize, and failure separately as operational work through `executeLifecycleFenced`: retry with exact target/revision/workflow/owner/token identity, never semantic `command_dedup` or event append, and assert one phase, claim transition, atomic artifact replacement-plus-acknowledgement, or failure record as applicable. Prove a standalone acknowledgement operation is absent/rejected and a lost materialize response retries the complete byte-reconciling operation after lease expiry through completed-state replay; an expired unacknowledged row still requires takeover. Include request → cancel → reopened request response loss and prove one deterministic workflow row with monotonic generations and immutable historical dedup effects.

- [ ] **Step 4: Write the durable-boundary fault corpus**

Use this explicit oracle; never synthesize unsupported Cartesian combinations:

| Boundary family | Valid crash points | Expected restart oracle |
| --- | --- | --- |
| Semantic event/authority/lease/workflow/checkpoint/coverage/transfer/verification/session-end SQLite transaction | before-write; after-write-before-commit; after-commit-before-response | first two leave zero phase effect; committed response loss replays exactly one semantic effect, including after original internal claim expiry |
| Eventless workflow or outbox claim/renew/failure SQLite transaction | before-write; after-write-before-commit; after-commit-before-response | first two leave the prior operational state; committed loss replays/fences by workflow/target/revision/owner/token without semantic dedup or event append |
| Validation external execution | before-external-start; after-external-complete-before-result-commit | persisted attempt identity is reused; no immutable result exists until its internal result command commits |
| Validation-result SQLite transaction | before-write; after-write-before-commit; after-commit-before-response | zero result/event before commit; exact internal-workflow command replay after commit |
| Temporary file stage | before-temp-write; after-temp-fsync-before-replace | database remains claimed, target remains prior/absent, contained temp is cleaned or safely replaced on retry |
| Atomic materialize-and-ack operational transaction | before-write; after-write-before-commit; after-replace-before-ack; after-commit-before-response | target may contain committed planned bytes while the row remains pending; exact full-operation retry recognizes `nextFingerprint`; after commit, completed-state replay verifies the retained tuple/current latest bytes before lease enforcement and returns one completion |
| Final response/private delivery | after-commit-before-response only | semantic/operational commit remains exactly once; pending encrypted retry survives until terminal redelivery |

Hook ownership is exact:

| Boundary owner | Required hook files |
| --- | --- |
| semantic/event/authority/lease/evidence | `lifecycle-command.store.ts` and connection-bound repositories |
| eventless workflow/outbox transaction | `lifecycle-operational.store.ts` and focused connection-bound operational facades |
| workflow/validation scheduling and result | `session-end.repository.ts`, `session-end-workflow.service.ts`, `validation-profile.runner.ts` |
| outbox claim/renew/failure | `lifecycle-outbox.repository.ts` and `lifecycle-recovery.coordinator.ts` |
| temp stage/replace/private ack | `atomic-artifact-replacer.ts` and `compatibility-log.materializer.ts` |
| post/response/private delivery | `project-store-executor.ts` and `authority-material-adapter.ts` |

For every valid row above, arrange the smallest workflow, trigger process exit, restart with the same pending authorization/work identity, and assert:

- pre-commit death leaves zero effect for that phase;
- committed phase replays with no duplicate;
- earlier committed saga phases remain durable;
- stale capability/workflow/lease generations and stale outbox revisions add zero effect;
- failed validation never reaches `SessionEnded`;
- lower-revision replaced bytes are recognized by a newer revision;
- transfer/recovery pre-append ordering is release G → authority CAS G+1 → insert lease G+1 → exact planned event append, and every injected failure rolls the transaction back;
- scoped source-state witnesses ignore only server-derived store/pending/committed target/temp self-writes while ordinary edits still conflict;
- maintenance and fork source adapters route descriptors with zero target-bearer reconstruction calls;
- recovery never closes a different session.

After every individual lost-response/fault recovery—not only the aggregate stress seed—run quick integrity, full integrity, cooperative close, and database/artifact rename checks before teardown.

- [ ] **Step 5: Write comprehensive retained-secret/evidence scans**

Insert unique canary values for handle, resume token, proof MAC, signed approval, child-binding grant, project provider key, pending-record plaintext, raw evidence body, raw validation output, environment value, and process command. After all success/failure/restart paths, scan:

- raw database/WAL/SHM/journal bytes plus decoded live text/blob fields before any checkpoint, after every success/failure/restart boundary, and again after checkpoint/truncate;
- event/dedup/workflow/outbox/validation/approval payloads;
- Markdown artifacts and temp remnants;
- worker/broker IPC recordings after allowed live fields are immediately discarded;
- logs, errors, JSON, snapshots, retained fixtures, and uploaded-test-log candidates.

Only encrypted pending ciphertext may remain before a terminal response. Coverage output must remain `contentRetained: false`; `requireFullEvidence` must fail.

- [ ] **Step 6: Run new tests and observe missing fixtures/fault hooks**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js
```

Expected: tests fail because process fixtures, key broker, and boundary hooks are not implemented.

- [ ] **Step 7: Implement hooks/fixtures and make default corpus pass**

Inject `LifecycleFaultInjector` as the last dependency with `NO_LIFECYCLE_FAULTS` default. Each owner exposes only the valid points in the oracle table; a test requesting an invalid boundary/point pair fails fixture setup instead of installing a no-op hook. Hooks may throw/exit only in fixtures and never alter production control flow when noop. Task 4 retains its separate upgrade-specific fault enum/corpus; do not duplicate upgrade hooks here.

Implement shared fixture client once; do not duplicate the current event-store concurrent/crash clients. Use `child_process.fork` with `shell: false`, JSON IPC, named barriers, cooperative `close`, awaited exit, then bounded kill cleanup. Discard live proofs/descriptors/approvals as soon as the test assertion completes.

- [ ] **Step 8: Add serialized lifecycle stress**

`tests/lifecycle.stress.test.ts` skips unless `MEMORY_LIFECYCLE_STRESS=1`. For seeds 0..9, exercise one root with 32 children across multiple processes, concurrent reports/dispositions/checkpoints, randomized deterministic crash/retry boundaries, one competing resume pair, and verified end. After each seed assert exact derived event/command counts, one effect per identity, contiguous stream/global versions, one current owner, no active child under require-completed, deterministic artifact fingerprint, zero leaked canaries, quick/full integrity, and zero retained handles.

`scripts/run-lifecycle-stress.js` builds tests then spawns only the compiled lifecycle stress test with inherited stdio, `--test-concurrency=1`, and `MEMORY_LIFECYCLE_STRESS=1`. Add `"test:lifecycle-stress": "node scripts/run-lifecycle-stress.js"` without changing existing `test:stress`.

- [ ] **Step 9: Run default process, security, existing stress, and lifecycle stress gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js
npm run test:stress
npm run test:lifecycle-stress
npm run typecheck
```

Expected: all ten lifecycle stress seeds pass, 32-child root authority remains stable, every fault recovers one-or-zero effect, no canary leaks, and all processes/handles close.

- [ ] **Step 10: Commit**

```powershell
git add src/orchestrator/lifecycle/lifecycle-faults.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/lifecycle/lifecycle-operational.store.ts src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/session-end.coordinator.ts src/orchestrator/lifecycle/lifecycle-recovery.coordinator.ts src/orchestrator/lifecycle/validation-profile.runner.ts src/orchestrator/lifecycle/authority/authority-material-adapter.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/storage/lifecycle-outbox.repository.ts src/orchestrator/materialization/atomic-artifact-replacer.ts src/orchestrator/materialization/compatibility-log.materializer.ts src/orchestrator/runtime/project-store-executor.ts tests/support/lifecycle-fixture-client.ts tests/support/lifecycle-test-key-broker.ts tests/fixtures/project-store-lifecycle-child.ts tests/fixtures/project-store-lifecycle-crash-child.ts tests/fixtures/lifecycle-validation-profile-child.ts tests/lifecycle.concurrent.test.ts tests/lifecycle.crash.test.ts tests/lifecycle.security.test.ts tests/lifecycle.stress.test.ts scripts/run-lifecycle-stress.js package.json
git commit -m "test: prove lifecycle process safety"
```

---

### Task 19: Gate Subproject 2 Without Enabling Production Routing

**Files:**
- Create: `tests/ci-lifecycle-gates.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/sqlite-stress.yml`
- Modify: `scripts/smoke-worker.js`
- Modify: `package.json`

**Interfaces:**
- Default CI on Windows/Ubuntu and Node 22.22.3/24.16.0 runs runtime check, typecheck, complete tests, build, artifact smoke, focused lifecycle process/security corpus, and production-isolation checks.
- Serialized weekly/manual stress runs existing event-store stress and lifecycle stress on Windows/Ubuntu, uploads logs only, and never uploads SQLite databases, vaults, pending credential state, or Markdown memory.
- Production artifact smoke opens/closes the worker and confirms lifecycle operations return `LIFECYCLE_V2_DISABLED` while existing ping/open behavior remains valid.
- Both workflows use `actions/checkout` with `fetch-depth: 0`; the isolation gate first proves the full immutable base commit exists locally.
- `package.json` defines `test:subproject-2` exactly as `npm run test:build && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js`; it adds no dependency.

- [ ] **Step 1: Write the failing artifact/CI contract test**

Create `tests/ci-lifecycle-gates.test.ts`. It reads `package.json`, both workflow YAML files, and `scripts/smoke-worker.js`; assert the exact `test:subproject-2` script, required default/stress commands, `fetch-depth: 0`, existence check plus comparison against immutable `0e375d4643d4b630f36f874a3bb192e96739ac46`, the disabled lifecycle smoke assertion, and absence of upload paths matching `*.sqlite*`, vault directories, pending authorization files, or Markdown session logs.

- [ ] **Step 2: Run the contract test and observe the missing release gates**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-lifecycle-gates.test.js
```

Expected: the test fails because `test:subproject-2`, the lifecycle workflow steps, production-isolation comparison, and disabled lifecycle artifact assertion do not exist yet.

- [ ] **Step 3: Add artifact, default, and scheduled lifecycle gates**

Extend `scripts/smoke-worker.js` to post a strictly valid nonmutating lifecycle status request after ordinary worker open without a V2 runtime and require the exact `LIFECYCLE_V2_DISABLED` error with zero new event/dedup rows.

In both workflows, change checkout to `fetch-depth: 0`. In `.github/workflows/ci.yml`, preserve the current OS/runtime matrix and add after `npm test`:

```powershell
npm run test:subproject-2
git cat-file -e "0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}"
git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services
```

Keep build and `test:build-artifacts`. The minimum-runtime negative job remains unchanged.

In `.github/workflows/sqlite-stress.yml`, keep `max-parallel: 1`, run default event-store and lifecycle concurrent/crash/security tests, then `npm run test:stress` and `npm run test:lifecycle-stress`. Upload only the textual CI log with 14-day retention. Add the exact `test:subproject-2` script from the interface to `package.json`, then rerun `ci-lifecycle-gates.test.ts` and require it to pass.

- [ ] **Step 4: Run the complete release gates locally**

Run:

```powershell
npm ci
npm run check:runtime
npm run typecheck
npm test
npm run test:subproject-2
npm run build
npm run test:build-artifacts
npm run test:stress
npm run test:lifecycle-stress
git diff --check
git cat-file -e "0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}"
git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services
```

Expected: every command exits `0`; both stress suites complete ten seeds; no Version 1 production file differs from full Subproject 2 base commit `0e375d4643d4b630f36f874a3bb192e96739ac46`; artifact smoke proves lifecycle disabled.

- [ ] **Step 5: Reproduce the original ownership inversion and prove construction-time failure**

Run the real-process regression where a primary starts one root, 32 subagents fork/report/reconnect concurrently, and one unrelated primary starts another root. Assert the original root remains active at its expected owner generation until its current root proof requests end; no child has a root capability; a new root has a new session ID; and no start command contains a supersede-current operation.

- [ ] **Step 6: Run independent implementation and security review**

Invoke `superpowers:requesting-code-review` over the complete implementation diff. Assign separate reviewers to:

- transaction/migration/integrity correctness;
- capability/proof/approval/private-state leakage and audience routing;
- child/checkpoint/evidence/end/materialization state-machine correctness; and
- Version 1 production isolation plus cross-process/fault corpus.

Resolve every P0/P1 and rerun the affected focused suite plus complete gates. Record any reusable failure lesson with the primary agent's project-memory tools; delegated reviewers must not start/end project-memory sessions.

- [ ] **Step 7: Commit**

```powershell
git add tests/ci-lifecycle-gates.test.ts .github/workflows/ci.yml .github/workflows/sqlite-stress.yml scripts/smoke-worker.js package.json
git commit -m "ci: gate lifecycle v2 safety"
```

---

## Final Verification and Subproject 2 Exit Review

- [ ] Run `git diff --check`, inspect the complete diff from `0e375d4643d4b630f36f874a3bb192e96739ac46`, and confirm every commit matches one task boundary.
- [ ] Run `npm ci`, `npm run check:runtime`, `npm run typecheck`, `npm test`, `npm run test:subproject-2`, `npm run build`, `npm run test:build-artifacts`, `npm run test:stress`, and `npm run test:lifecycle-stress` from a clean worktree.
- [ ] Confirm a fresh store has migration history `[1, 2]`, database schema version `2`, manifest format version `1`, and full integrity; confirm an exact Version 1 store remains byte-identical until explicit upgrade.
- [ ] Confirm the explicit upgrade dry-run writes nothing; apply drains/physically closes executors, applies once, verifies, records integrity, releases the fence, and closes all handles.
- [ ] Confirm exact dedup precedes stale-current-authority verification, every rotating lost response returns one semantic effect, and old generations release no authority material.
- [ ] Confirm initial-authority replay adopts the stored generated session without invoking fresh generation, transfer/recovery use release-G → CAS-G+1 → insert-lease-G+1 → exact planned append, and maintenance/fork source adapters route descriptors with zero bearer reconstruction.
- [ ] Confirm one primary plus 32 children, unrelated roots, linked worktrees, and a second project remain exactly isolated under real processes.
- [ ] Confirm every lifecycle durable-boundary pre-commit crash leaves zero phase effect and every post-commit crash replays without duplication.
- [ ] Confirm checkpoint bounds/markers, evidence ordinal conflicts/fragmentation, carry-forward lineage, end policy arithmetic, source-state races, terminal protection, and materialization revision fencing pass.
- [ ] Confirm request/amend reject validation result IDs, one complete server-planned validation array exists per workflow generation, request → cancel → request reopens one deterministic row, and scoped system store/pending/materialization writes never invalidate their own source witness while normal edits do.
- [ ] Confirm quick/full integrity pass after every recovery corpus and deliberately corrupted lifecycle indexes produce the exact typed failure.
- [ ] Confirm database/WAL, event/dedup/workflow/outbox/validation/approval data, artifacts, IPC recordings, logs, errors, snapshots, fixtures, and CI upload candidates contain no issued capability, provider key, raw proof/approval, raw evidence, raw validation output, environment canary, or process command.
- [ ] Confirm `git cat-file -e "0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}"` and `git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services` exit `0`; no Version 2 lifecycle tool is registered and primary mode is disabled.
- [ ] Confirm the disabled adapter preserves exact Version 1 object/error identities and the shadow mapper is pure, bounded, redacted, nonmutating, and `executable: false`.
- [ ] Run independent specification, implementation, and security reviews; resolve all P0/P1 findings and attach fresh focused/full verification evidence.
- [ ] Run `memory_verifyVault`, close exactly one root-owned project-memory lifecycle with concrete outcomes/decisions/files/follow-ups and `verify: true`, then confirm `memory_lifecycleStatus.activeSession` is null. No subagent calls any memory lifecycle tool.

Subproject 2 exits only when every box above passes. It still does not make the MCP production-ready: proceed through separately reviewed Subprojects 3 (projections/retrieval), 4 (encrypted evidence/privacy), and 5 (legacy import, backup/restore, parity, live routing, and explicit production cutover approval).
