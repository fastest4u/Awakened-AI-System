# V2 Shadow Migration and Compatibility Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, restart-safe internal pipeline that verifies an immutable V1 source copy, imports it as committed V2 shadow events, publishes V2 projections, proves snapshot-aligned parity, and materializes compatibility artifacts into an isolated target without changing caller-facing V1 routing.

**Architecture:** A strict migration contract binds one rollout revision to one verified source manifest, canonical migration package, append-only schema-7 ledger, deterministic import stream, verified V2 projection generation, typed parity report, and isolated compatibility target. Every durable phase is hash-chained and idempotent; unknown outcomes reconcile from committed events, ledger rows, projection manifests, parity checksums, and target bytes before retry. The existing production composition remains V1-only, and this slice runs only against an explicitly configured production-shaped copy.

**Tech Stack:** TypeScript, Node.js 24.16 or newer, `node:crypto`, `node:fs`, `node:path`, `node:sqlite` through the existing `SqliteDriver`/`SqliteConnection` abstractions, SQLite STRICT tables and triggers, canonical JSON, the current event-store and projection implementations, `node:test`, PowerShell release commands, and the existing Windows/Linux GitHub Actions matrix.

**Spec:** `docs/superpowers/specs/2026-09-09-v2-shadow-migration-and-compatibility-parity-design.md`

## Global Constraints

- Version 1 remains the sole caller-facing authority. Do not modify `src/app.ts`, `src/index.ts`, `src/controllers/**`, `src/schemas/**`, `src/services/**`, or register a V2 MCP tool.
- Do not activate a rollout revision on a user store, enable live shadow/canary/primary traffic, dual-write caller commands, or point any mutation-capable component at the live V1 store or live vault.
- Node.js runtime floor remains `>=24.16.0`; add no production dependency.
- Source-copy paths, package paths, projection paths, and compatibility targets must be absolute, normalized, existing where required, non-symbolic, and verified by file identity rather than path text alone.
- The source is opened with `mode: "read-only-existing"`; pre-run and post-run identities and SHA-256 hashes must match exactly.
- Migration policy bounds are exact: `maxEvents` 1..100,000; `maxAggregateBytes` 1..67,108,864; `maxEventBytes` 1..1,048,576; `maxBatchEvents` 1..1,000; `maxBatchBytes` 1..8,388,608; `deadlineMs` 1..300,000; `maxRetries` 0..3; `initialBackoffMs` 10..500; `maxBackoffMs` from `initialBackoffMs` through 2,000; `maxExpectedDifferenceRuleAgeMs` 1..604,800,000.
- The rollout revision `configurationChecksum` must bind the canonical migration configuration, which includes the sealed policy checksum, and `migrationIdentityHash` must equal the domain-separated identity calculated from the verified source and sealed package.
- Durable phases are exactly `snapshot-verified`, `package-sealed`, `import-committed`, `projection-verified`, `parity-complete`, and `compatibility-complete`, in that order.
- Import commits only V2 shadow wrapper events through the current `EventStore`; V2 projection input is reconstructed exclusively from those authenticated committed wrapper events.
- No expected-difference rule may cover identity, authority, project/workspace/session/visibility scope, event-chain integrity, privacy, erasure, duplicate/lost events, ordering, terminal position/hash, plaintext leakage, or projection core-checksum divergence.
- Migration packages and source copies are sensitive. Diagnostics and evidence expose only typed categories, opaque IDs, schema/algorithm versions, positions, hashes, counts, timings, and resource measurements.
- Compatibility bytes are written only below a separately configured isolated root. The live V1 vault root is always rejected, even if a relative artifact path is valid.
- Tests use production decoders, event hashes, source authentication, real SQLite/WAL behavior, real projection publication, and atomic replacement. Hand-built tests may generate data only through current production writers/helpers.
- Passing Slice 2 authorizes only planning for Slice 3 privacy/retention/global-scope work. It does not make V2 production-primary or authorize deployment.

---

## Execution Status

- [x] Task 1: strict migration contracts, policy/configuration checksums, and identity binding.
- [x] Task 2: production-compatible projection identity codecs.
- [x] Task 3: immutable production-shaped V1 source verification.
- [x] Task 4: canonical content-addressed migration package.
- [x] Task 5: schema-7 append-only ledger, attempts, parity, and compatibility evidence.
- [x] Task 6: deterministic committed V2 shadow import.
- [x] Task 7: projection input reconstructed only from committed imports.
- [ ] Task 8: verified V1-reference and V2-shadow projection publication.
- [ ] Task 9: expected-difference governance, row parity, and sealed retrieval parity.
- [ ] Task 10: isolated compatibility materialization.
- [ ] Task 11: durable orchestration, retry, and reconciliation.
- [ ] Task 12: three-run rehearsal plus fourth-run no-op evidence.
- [ ] Task 13: schema registry, focused gate, CI, and bundled smoke sealing.
- [ ] Task 14: production-shaped rehearsal and independent specification, quality, and security reviews.

Task 7 closure (2026-09-11): implementation `f314c58e86040c332846e65fd7b094896ea0f69f`, reviewed correction `b6c9dab575bbe18e18b6463072adcbb31cb0220c`; focused gate 148/148, build/typecheck passed, independent specification/quality review approved. Tasks 8–14 remain open; V2 is not activated.

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/orchestrator/migration/v2-shadow-migration.contracts.ts` | Exact migration policy, phases, error taxonomy, canonical checksums, deterministic IDs, and rollout-revision binding. |
| `src/orchestrator/migration/v1-source-copy.ts` | Stable source manifest decoding, path/file-identity verification, read-only event-chain authentication, legacy-artifact inventory, and post-run mutation detection. |
| `src/orchestrator/migration/v2-migration-package.ts` | Streaming canonical package writer/reader, same-directory atomic publication, record descriptors, and package/migration identity verification. |
| `src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts` | Immutable schema-7 run, transition, imported-record, parity, rule, compatibility-outbox, and acknowledgement tables with guards. |
| `src/orchestrator/storage/v2-shadow-migration.repository.ts` | One-connection `BEGIN IMMEDIATE` repository, strict row decoders, ledger-chain verification, exact claims, and reconciliation reads. |
| `src/orchestrator/migration/v2-shadow-importer.ts` | Bounded package reader, deterministic V2 wrapper-event append, batch checkpointing, deduplication, and unknown-outcome reconciliation. |
| `src/orchestrator/migration/v2-imported-event-reader.ts` | Reads authenticated committed wrapper events, verifies ledger mappings, reconstructs the original stored-event chain, and exposes a `ProjectionEventReader`. |
| `src/orchestrator/migration/v2-shadow-projection.ts` | Builds/publishes schema-V2 projections from committed imports and verifies terminal identity and core checksums. |
| `src/orchestrator/parity/v2-expected-difference.ts` | Exact immutable rule decoder, forbidden-category guard, time/revision/migration binding, and unique-match resolution. |
| `src/orchestrator/parity/v2-snapshot-parity.ts` | Snapshot-aligned row/field comparison, typed classifications, redacted report construction, and checksum calculation. |
| `src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts` | Exact compatibility-outbox claim, isolated path enforcement, atomic byte publication, durable acknowledgement, and reconciliation. |
| `src/orchestrator/migration/v2-shadow-migration-runner.ts` | Phase orchestration, bounded retry/backoff, durable resume, fail-closed reconciliation, source re-verification, and final result. |
| `src/orchestrator/migration/v2-shadow-migration-evidence.ts` | Canonical redacted release-evidence document and checksum. |
| `scripts/run-v2-shadow-migration-rehearsal.js` | Explicit command-line entry for three clean runs plus a fourth no-op against configured isolated roots. |
| `tests/support/v2-shadow-migration-fixture.ts` | Generates production-shaped SQLite/WAL sources, manifests, rollout revisions, isolated targets, and deterministic fault seams using production writers. |
| `tests/v2-shadow-migration-contracts.test.ts` | Policy, identity, phase, error, and revision-binding contract tests. |
| `tests/v1-source-copy.test.ts` | Source alias/symlink/replacement/schema/scope/limit/chain and mutation tests. |
| `tests/v2-migration-package.test.ts` | Canonical package, bounded streaming, publication, tamper, and determinism tests. |
| `tests/v2-shadow-migration-repository.test.ts` | Schema-7 immutability, chain order, row decoding, claim, acknowledgement, and rollback tests. |
| `tests/v2-shadow-importer.test.ts` | Deterministic wrapper-event import, batch bounds, no-op replay, conflict, and unknown-outcome tests. |
| `tests/v2-imported-event-reader.test.ts` | Committed-wrapper receipt, reconstruction, source-chain authentication, and close-semantics tests. |
| `tests/v2-shadow-projection.test.ts` | Committed-import reader, real schema-V2 publication, terminal identity, and projection integrity tests. |
| `tests/v2-snapshot-parity.test.ts` | Equal, governed expected, blocking, forbidden, multiple-rule, and report-redaction tests. |
| `tests/v2-shadow-compatibility.test.ts` | Isolated exact-claim publication, live-root rejection, lag, crash, and acknowledgement reconciliation tests. |
| `tests/v2-shadow-migration-runner.test.ts` | End-to-end phases, retry classes, restart points, source re-verification, and V1 isolation tests. |
| `tests/v2-shadow-migration-rehearsal.test.ts` | Three-run determinism, fourth-run no-op, evidence, performance bounds, and source byte-identity tests. |
| `src/orchestrator/storage/migrations/registry.ts` | Registers schema 7 and advances the current version. |
| `tests/migration-registry.test.ts` | Pins migration 0007 and preserves all frozen prior checksums. |
| `tests/project-store-bootstrap.test.ts` | Verifies a new store records migrations 1 through 7 and installs guarded Slice-2 tables. |
| `tests/project-store-upgrade.test.ts` | Verifies atomic upgrade through schema 7 and restart behavior. |
| `tests/project-store-upgrade-phase-runner.test.ts` | Verifies worker upgrade reports version 7. |
| `tests/ci-lifecycle-gates.test.ts` | Seals new internal-only source paths, exact focused gate, V1 routing protection, and artifact retention policy. |
| `scripts/smoke-worker.js` | Verifies bundled bootstrap/upgrade through schema 7 and keeps lifecycle V2 disabled. |
| `package.json` | Adds the exact focused Slice-2 and rehearsal commands. |
| `.github/workflows/ci.yml` | Runs the focused Slice-2 gate on Windows/Linux before artifact tests without changing V1 protection. |

`tests/support/v2-shadow-migration-fixture.ts` owns the shared test vocabulary used below. It exports `createV2ShadowMigrationFixture`, `sealedPackageFixture`, `importedPackageFixture`, `repositoryFixture`, `committedRepositoryFixture`, `parityFixture`, `sealedRetrievalParityFixture`, `compatibilityFixture`, `runnerFixture`, and `rehearsalFixture`, plus bounded read/tamper helpers. Each factory returns a typed object with only the properties used by its task tests, registers cleanup with `TestContext.after`, and creates data through current production migrations/EventStore/projection writers rather than direct semantic row inserts. Task-local helpers such as `approvedRule`, `transition`, and `transitionHash` remain in their named test file and must construct values through the production decoder/hash exported by the task under test.

### Task 1: Define strict migration contracts, policy checksum, and identity binding

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration.contracts.ts`
- Create: `tests/v2-shadow-migration-contracts.test.ts`
- Modify: `src/orchestrator/rollout/rollout-control-plane.ts:1-180`
- Test: `tests/rollout-control-plane.test.ts:680-760`

**Interfaces:**
- Consumes: `canonicalJson(value: unknown): string`, `RolloutRevision`, and `RolloutControlPlaneError`.
- Produces: `ShadowMigrationPhase`, `ShadowMigrationPolicyV1`, `ShadowMigrationConfigurationV1`, `ShadowMigrationError`, `decodeShadowMigrationPolicyV1`, `decodeShadowMigrationConfigurationV1`, `shadowMigrationPolicyChecksum`, `shadowMigrationConfigurationChecksum`, `shadowMigrationIdentity`, `deterministicMigrationUuid`, and `RolloutControlPlane.revision(projectId, revisionId)`.

- [x] **Step 1: Write failing exact-input and boundary tests.**

Create tests that use null-prototype records, accessors, symbols, unknown fields, every minimum/maximum, and one value beyond every bound. Pin canonical output and domain strings:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  SHADOW_MIGRATION_PHASES,
  ShadowMigrationError,
  decodeShadowMigrationConfigurationV1,
  decodeShadowMigrationPolicyV1,
  deterministicMigrationUuid,
  shadowMigrationConfigurationChecksum,
  shadowMigrationIdentity,
  shadowMigrationPolicyChecksum,
} from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";

const POLICY = Object.freeze({
  schemaVersion: 1,
  maxEvents: 100_000,
  maxAggregateBytes: 67_108_864,
  maxEventBytes: 1_048_576,
  maxBatchEvents: 1_000,
  maxBatchBytes: 8_388_608,
  deadlineMs: 300_000,
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 2_000,
  expectedDifferencePolicyVersion: 1,
  maxExpectedDifferenceRuleAgeMs: 604_800_000,
});

test("migration policy is exact, canonical, and bounded", () => {
  const decoded = decodeShadowMigrationPolicyV1(POLICY);
  assert.deepEqual(decoded, POLICY);
  assert.equal(Object.isFrozen(decoded), true);
  assert.match(shadowMigrationPolicyChecksum(decoded), /^[0-9a-f]{64}$/);
  const configuration = decodeShadowMigrationConfigurationV1({
    schemaVersion: 1,
    policyChecksum: shadowMigrationPolicyChecksum(decoded),
    packageFormatVersion: 1,
    migrationAlgorithmVersion: 1,
    expectedDifferencePolicyVersion: 1,
  });
  assert.match(shadowMigrationConfigurationChecksum(configuration), /^[0-9a-f]{64}$/);
  assert.throws(
    () => decodeShadowMigrationPolicyV1({ ...POLICY, maxEvents: 100_001 }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_POLICY_INVALID",
  );
  assert.throws(() => decodeShadowMigrationPolicyV1({ ...POLICY, extra: true }));
});

test("phase order and deterministic identities are frozen", () => {
  assert.deepEqual(SHADOW_MIGRATION_PHASES, [
    "snapshot-verified", "package-sealed", "import-committed",
    "projection-verified", "parity-complete", "compatibility-complete",
  ]);
  const identity = shadowMigrationIdentity({
    projectId: "11111111-1111-4111-8111-111111111111",
    storeId: "33333333-3333-4333-8333-333333333333",
    sourceManifestChecksum: "3".repeat(64), terminalEventHash: "4".repeat(64),
    packageChecksum: "5".repeat(64), migrationAlgorithmVersion: 1,
    buildIdentityHash: "6".repeat(64), configurationChecksum: "7".repeat(64),
  });
  assert.equal(identity, shadowMigrationIdentity({
    projectId: "11111111-1111-4111-8111-111111111111",
    storeId: "33333333-3333-4333-8333-333333333333",
    sourceManifestChecksum: "3".repeat(64), terminalEventHash: "4".repeat(64),
    packageChecksum: "5".repeat(64), migrationAlgorithmVersion: 1,
    buildIdentityHash: "6".repeat(64), configurationChecksum: "7".repeat(64),
  }));
  assert.match(deterministicMigrationUuid("attempt", identity, 0), /^[0-9a-f-]{36}$/);
});
```

- [x] **Step 2: Run the focused tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-contracts.test.js dist-test/tests/rollout-control-plane.test.js
```

Expected: compilation fails because the migration contract module and `RolloutControlPlane.revision` do not exist.

- [x] **Step 3: Add the exact contract and hash implementation.**

Use these public shapes and domains; the decoder must inspect own enumerable data descriptors before value access and deep-freeze its result:

```ts
export const SHADOW_MIGRATION_PHASES = Object.freeze([
  "snapshot-verified", "package-sealed", "import-committed",
  "projection-verified", "parity-complete", "compatibility-complete",
] as const);
export type ShadowMigrationPhase = (typeof SHADOW_MIGRATION_PHASES)[number];

export type ShadowMigrationErrorCode =
  | "MIGRATION_POLICY_INVALID" | "MIGRATION_SOURCE_INVALID"
  | "MIGRATION_SOURCE_MUTATED" | "MIGRATION_LIMIT_EXCEEDED"
  | "MIGRATION_IDENTITY_CONFLICT" | "MIGRATION_LEDGER_INTEGRITY_FAILURE"
  | "MIGRATION_OUTCOME_UNKNOWN" | "MIGRATION_RETRY_EXHAUSTED"
  | "PROJECTION_INTEGRITY_FAILURE" | "PARITY_RULE_INVALID"
  | "PARITY_BLOCKING_DIVERGENCE" | "COMPATIBILITY_INTEGRITY_FAILURE";

export class ShadowMigrationError extends Error {
  constructor(
    readonly code: ShadowMigrationErrorCode,
    readonly safeDetails: Readonly<Record<string, string | number>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ShadowMigrationError";
  }
}

export interface ShadowMigrationPolicyV1 {
  readonly schemaVersion: 1;
  readonly maxEvents: number;
  readonly maxAggregateBytes: number;
  readonly maxEventBytes: number;
  readonly maxBatchEvents: number;
  readonly maxBatchBytes: number;
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly expectedDifferencePolicyVersion: number;
  readonly maxExpectedDifferenceRuleAgeMs: number;
}

export interface ShadowMigrationConfigurationV1 {
  readonly schemaVersion: 1;
  readonly policyChecksum: string;
  readonly packageFormatVersion: 1;
  readonly migrationAlgorithmVersion: 1;
  readonly expectedDifferencePolicyVersion: number;
}

export interface ShadowMigrationIdentityInput {
  readonly projectId: string;
  readonly storeId: string;
  readonly sourceManifestChecksum: string;
  readonly terminalEventHash: string;
  readonly packageChecksum: string;
  readonly migrationAlgorithmVersion: 1;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
}

const POLICY_DOMAIN = "project-memory/v2-shadow-migration-policy/v1";
const CONFIGURATION_DOMAIN = "project-memory/v2-shadow-migration-configuration/v1";
const IDENTITY_DOMAIN = "project-memory/v2-shadow-migration-identity/v1";
const UUID_DOMAIN = "project-memory/v2-shadow-migration-uuid/v1";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function shadowMigrationPolicyChecksum(policy: ShadowMigrationPolicyV1): string {
  return sha256(`${POLICY_DOMAIN}\n${canonicalJson(policy)}`);
}

export function shadowMigrationConfigurationChecksum(
  configuration: ShadowMigrationConfigurationV1,
): string {
  return sha256(`${CONFIGURATION_DOMAIN}\n${canonicalJson(configuration)}`);
}

export function shadowMigrationIdentity(input: ShadowMigrationIdentityInput): string {
  return sha256(`${IDENTITY_DOMAIN}\n${canonicalJson(input)}`);
}

export function deterministicMigrationUuid(
  purpose: "attempt" | "command" | "event" | "claim",
  migrationIdentity: string,
  ordinal: number,
): string {
  const bytes = Buffer.from(sha256(`${UUID_DOMAIN}\n${canonicalJson({ purpose, migrationIdentity, ordinal })}`), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

Add `revision(projectId, revisionId)` as a read-only service method that uses the repository transaction, validates both UUIDs, returns the immutable decoded revision, and fails `ROLLOUT_TRANSITION_DENIED` when absent. Do not expose this method through a controller or worker protocol.

`decodeShadowMigrationConfigurationV1` must require `policyChecksum === shadowMigrationPolicyChecksum(policy)` at the runner boundary and require `expectedDifferencePolicyVersion` to equal the policy field. The rollout revision binds the result of `shadowMigrationConfigurationChecksum`, not the policy checksum alone.

- [x] **Step 4: Run contract and rollout tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-contracts.test.js dist-test/tests/rollout-control-plane.test.js
npm run typecheck
```

Expected: all tests pass; malformed objects fail before accessor execution; policy hashes and deterministic UUIDs are stable.

- [x] **Step 5: Commit the migration contract.**

```powershell
git add src/orchestrator/migration/v2-shadow-migration.contracts.ts src/orchestrator/rollout/rollout-control-plane.ts tests/v2-shadow-migration-contracts.test.ts tests/rollout-control-plane.test.ts
git commit -m "feat: define V2 shadow migration contracts"
```

### Task 2: Align projection identity codecs with production project-store identities

**Files:**
- Modify: `src/orchestrator/projections/contracts.ts:1-45`
- Modify: `src/orchestrator/projections/event-reader.ts:20-142`
- Modify: `src/orchestrator/projections/source-event-codec.ts:1-170,420-640`
- Modify: `src/orchestrator/projections/folds.ts:120-160`
- Modify: `src/orchestrator/projections/manifest.ts:210-370`
- Modify: `src/orchestrator/projections/checksum.ts:70-110`
- Modify: `tests/projection-source-event-codec.test.ts`
- Modify: `tests/projection-folds.test.ts`
- Modify: `tests/projection-manifest.test.ts`
- Modify: `tests/projection-integrity.test.ts`

**Interfaces:**
- Consumes: production `ProjectId`/`VaultId`/`StoreId` UUIDv4 values, SHA-256 `WorkspaceId`, optional UUID branch scope, and the existing sealed evaluator's SHA-256 synthetic identity fixtures.
- Produces: one shared `decodeProjectionIdentityToken(value, kind)` rule used by reader, source codec, folds, manifest, and checksums without relaxing any arbitrary-string boundary.

- [x] **Step 1: Add production-identity RED cases before changing decoders.**

Copy one existing valid projection source/manifest/fold fixture and replace only project, vault, and store identities with canonical UUIDv4 values while keeping the workspace identity as lowercase SHA-256. Pin the compatibility boundary:

```ts
const PRODUCTION_BINDING: ProjectBinding = Object.freeze({
  projectId: "11111111-1111-4111-8111-111111111111" as ProjectId,
  vaultId: "22222222-2222-4222-8222-222222222222" as VaultId,
  storeId: "33333333-3333-4333-8333-333333333333" as StoreId,
  workspaceId: "a".repeat(64) as WorkspaceId,
  branchScopeId: null,
  branchRef: null,
  sessionId: null,
});

test("projection authority accepts production UUID store identities", () => {
  const decoded = decodeProjectionEvent(storedMemorySourceEvent({ binding: PRODUCTION_BINDING }));
  assert.equal(decoded.kind, "memory-source");
  if (decoded.kind === "memory-source") assert.deepEqual(decoded.binding, PRODUCTION_BINDING);
});

test("projection authority retains sealed SHA-256 evaluator identities", () => {
  assert.doesNotThrow(() => decodeProjectionEvent(storedMemorySourceEvent({ binding: HASH_BINDING })));
});

test("projection authority rejects noncanonical and mixed-case identity tokens", () => {
  for (const projectId of ["project", "11111111-1111-1111-1111-111111111111", "A".repeat(64)]) {
    assert.throws(() => decodeProjectionEvent(storedMemorySourceEvent({
      binding: { ...PRODUCTION_BINDING, projectId: projectId as ProjectId },
    })), /INTEGRITY_FAILURE/);
  }
});
```

Add equivalent UUID cases to manifest parsing, fold restoration, projection checksum, and event-reader snapshot tests.

- [x] **Step 2: Run projection identity tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-integrity.test.js
```

Expected: the new production UUID cases fail with `INTEGRITY_FAILURE` or `PROJECTION_CHECKSUM_INVALID`; existing hash fixtures remain green.

- [x] **Step 3: Centralize the transitional strict identity rule.**

Export from `contracts.ts` and reuse everywhere:

```ts
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function isProjectionProjectStoreIdentity(value: unknown): value is string {
  return typeof value === "string" && (UUID_V4.test(value) || SHA256.test(value));
}

export function isProjectionWorkspaceIdentity(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
```

Project, vault, and store accept only UUIDv4 (production) or lowercase SHA-256 (sealed evaluator compatibility). Workspace remains lowercase SHA-256. Branch scope remains UUID and branch refs retain the current NUL/non-empty checks. Replace local all-fields-are-hash checks in event reader, source codec, folds, manifest, and checksum with the shared predicates. Do not change event payload decoding, fold semantics, checksum domains, manifest schema versions, or public routing.

- [x] **Step 4: Run the complete projection gate.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js
npm run typecheck
```

Expected: production UUID and sealed hash identities both pass; malformed strings, wrong UUID versions, uppercase hashes, and scope mismatches fail closed.

- [x] **Step 5: Commit production identity compatibility.**

```powershell
git add src/orchestrator/projections/contracts.ts src/orchestrator/projections/event-reader.ts src/orchestrator/projections/source-event-codec.ts src/orchestrator/projections/folds.ts src/orchestrator/projections/manifest.ts src/orchestrator/projections/checksum.ts tests/projection-source-event-codec.test.ts tests/projection-folds.test.ts tests/projection-manifest.test.ts tests/projection-integrity.test.ts
git commit -m "fix: accept production projection identities"
```

### Task 3: Verify an immutable production-shaped V1 source copy

**Files:**
- Create: `src/orchestrator/migration/v1-source-copy.ts`
- Create: `tests/support/v2-shadow-migration-fixture.ts`
- Create: `tests/v1-source-copy.test.ts`
- Reuse: `src/orchestrator/projections/event-reader.ts:43-497`
- Reuse: `src/orchestrator/integrity/stored-event-authenticator.ts`

**Interfaces:**
- Consumes: `ShadowMigrationPolicyV1`, `ProjectBinding`, `SqliteDriver`, `replayCommittedProjectionEvents`, and canonical path helpers.
- Produces: `V1SourceCopyManifestV1`, `VerifiedV1SourceCopy`, `decodeV1SourceCopyManifestV1`, and `verifyV1SourceCopy(input)`.

- [x] **Step 1: Generate a real source fixture and write failing verification tests.**

The support helper must bootstrap the current store, append events through `EventStore`, checkpoint WAL consistently, write two UTF-8 legacy artifacts, calculate a canonical manifest, and return cleanup paths. Test success plus alias, symlink, hostile relative path, bad sidecar hash, wrong binding, unsupported schema, event-chain tamper, source limit, and post-run mutation:

```ts
test("verifies the complete read-only source and detects later mutation", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const verified = await verifyV1SourceCopy({
    driver: fixture.driver,
    sourceRoot: fixture.sourceRoot,
    manifestPath: fixture.manifestPath,
    liveEventStorePath: fixture.liveEventStorePath,
    liveLegacyArtifactRoot: fixture.liveVaultRoot,
    expectedBinding: fixture.projectionBinding,
    policy: fixture.policy,
  });
  assert.equal(verified.manifest.eventCount, fixture.sourceEvents.length);
  assert.equal(verified.manifest.terminalEventHash, fixture.sourceEvents.at(-1)!.eventHash);
  assert.equal([...verified.events()].length, fixture.sourceEvents.length);
  verified.assertUnchanged();
  appendFileSync(fixture.sourceDatabasePath, Buffer.from([0]));
  assert.throws(
    () => verified.assertUnchanged(),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_SOURCE_MUTATED",
  );
  verified.close();
});

test("rejects a source whose file identity aliases live authority", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t, { aliasLiveStore: true });
  await assert.rejects(
    verifyV1SourceCopy({ ...fixture.verificationInput }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_SOURCE_INVALID",
  );
});
```

- [x] **Step 2: Run the source-copy tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v1-source-copy.test.js
```

Expected: compilation fails because the verifier and fixture helper do not exist.

- [x] **Step 3: Implement stable manifest and file-identity verification.**

Use exact manifest keys and return only a frozen handle. The handle owns the read-only snapshot and closes it exactly once:

```ts
export interface SourceFileDescriptorV1 {
  readonly relativePath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly ctimeNs: string;
  readonly sha256: string;
}

export interface LegacyArtifactDescriptorV1 extends SourceFileDescriptorV1 {
  readonly mediaType: "text/markdown; charset=utf-8";
}

export interface VerifiedLegacyArtifact {
  readonly descriptor: LegacyArtifactDescriptorV1;
  readChunks(): Iterable<Uint8Array>;
  assertUnchanged(): void;
}

export interface V1SourceCopyManifestV1 {
  readonly schemaVersion: 1;
  readonly copyFormatVersion: 1;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly branchScopeId: string | null;
  readonly branchRef: string | null;
  readonly sourceSchemaVersion: number;
  readonly database: SourceFileDescriptorV1;
  readonly sqliteSidecars: readonly SourceFileDescriptorV1[];
  readonly legacyArtifacts: readonly LegacyArtifactDescriptorV1[];
  readonly eventCount: number;
  readonly aggregateSourceBytes: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly createdAt: string;
  readonly authorizedActorFingerprint: string;
  readonly manifestChecksum: string;
}

export interface VerifiedV1SourceCopy {
  readonly sourceRoot: string;
  readonly manifest: V1SourceCopyManifestV1;
  readonly projectionSnapshot: ProjectionEventSnapshot;
  events(): Iterable<StoredEvent>;
  legacyArtifacts(): Iterable<VerifiedLegacyArtifact>;
  assertUnchanged(): void;
  close(): void;
}
```

Verification order is fixed:

1. Canonicalize the declared roots and reject equality/containment with either live root.
2. `lstat` every component and reject symbolic links, reparse substitutions, non-regular files, duplicate identities, `..`, absolute artifact paths, NULs, and case-folded path collisions.
3. Read the manifest once, validate exact own data fields, recompute `manifestChecksum` over the manifest without that field, and validate policy limits before opening SQLite.
4. Capture `{device,inode,size,ctimeNs,sha256}` for database, sidecars, artifacts, and manifest; compare database identity to the live database identity and artifact-root identity to the live root.
5. Open the database with `read-only-existing`, call `replayCommittedProjectionEvents` through the declared terminal position, and require exact count/bytes/terminal hash and binding.
6. Re-stat and re-hash every captured file before returning. `assertUnchanged()` repeats step 6 and throws `MIGRATION_SOURCE_MUTATED` on any difference.

`aggregateSourceBytes` is the sum of authenticated canonical source-event bytes plus declared legacy-artifact bytes. Database file size and SQLite sidecars are recorded and hashed independently but do not consume the logical 64 MiB import ceiling. Every individual source-event or legacy-artifact record must also fit `maxEventBytes`.

Always close the projection snapshot on a failed verification path. Error `safeDetails` may contain only a category and ordinal, never a source path or artifact name.

- [x] **Step 4: Run verifier, projection-reader, and integrity tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v1-source-copy.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js
npm run typecheck
```

Expected: all tests pass; source files remain byte-identical; all negative cases return only typed redacted errors.

- [x] **Step 5: Commit immutable source verification.**

```powershell
git add src/orchestrator/migration/v1-source-copy.ts tests/support/v2-shadow-migration-fixture.ts tests/v1-source-copy.test.ts
git commit -m "feat: verify immutable V1 migration sources"
```

### Task 4: Seal a canonical content-addressed migration package

**Files:**
- Create: `src/orchestrator/migration/v2-migration-package.ts`
- Create: `tests/v2-migration-package.test.ts`
- Reuse: `src/orchestrator/materialization/atomic-artifact-replacer.ts:21-180`
- Reuse: `src/orchestrator/identity/directory-durability.ts:1-80`

**Interfaces:**
- Consumes: `VerifiedV1SourceCopy`, `ShadowMigrationPolicyV1`, `shadowMigrationIdentity`, build/configuration hashes, and canonical JSON.
- Produces: `V2MigrationPackageManifestV1`, `SealedV2MigrationPackage`, `sealV2MigrationPackage(input)`, and `openSealedV2MigrationPackage(input)`.

- [x] **Step 1: Write failing deterministic-package and tamper tests.**

Pin record order as source events by `globalPosition`, followed by legacy artifacts by normalized relative path. Verify same input in two different absolute staging roots produces the same logical checksums and migration identity:

```ts
test("seals identical logical packages independent of absolute path", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const left = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const right = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB });
  assert.equal(left.manifest.packageChecksum, right.manifest.packageChecksum);
  assert.equal(left.migrationIdentity, right.migrationIdentity);
  assert.deepEqual([...left.records()].map((record) => record.descriptor), [...right.records()].map((record) => record.descriptor));
  source.assertUnchanged();
  source.close();
});

test("rejects package replacement and descriptor/value tamper", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source });
  replaceOnePackageRecord(sealed.rootPath);
  assert.throws(
    () => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: sealed.migrationIdentity }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_IDENTITY_CONFLICT",
  );
});
```

- [x] **Step 2: Run package tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js
```

Expected: compilation fails because the package writer/reader are absent.

- [x] **Step 3: Implement canonical streaming package publication.**

The package layout is exact and contains no absolute source path:

```text
<packageRoot>/<migrationIdentity>/
  package-manifest.json
  events.ndjson
  artifacts/
    <normalized legacy relative paths>
```

Use these public shapes:

```ts
export type V2MigrationRecordDescriptorV1 = Readonly<{
  schemaVersion: 1;
  ordinal: number;
  kind: "source-event" | "legacy-artifact";
  sourceIdentity: string;
  relativePath: string | null;
  byteLength: number;
  contentSha256: string;
}>;

export interface V2MigrationPackageManifestV1 {
  readonly schemaVersion: 1;
  readonly packageFormatVersion: 1;
  readonly migrationAlgorithmVersion: 1;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly sourceManifestChecksum: string;
  readonly eventCount: number;
  readonly legacyArtifactCount: number;
  readonly aggregateSourceBytes: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly recordDescriptors: readonly V2MigrationRecordDescriptorV1[];
  readonly recordsChecksum: string;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
  readonly creationReasonCode: "production-shaped-rehearsal";
  readonly packageChecksum: string;
}

export interface V2MigrationPackageRecordV1 {
  readonly descriptor: V2MigrationRecordDescriptorV1;
  readChunks(): Iterable<Uint8Array>;
}

export interface SealedV2MigrationPackage {
  readonly rootPath: string;
  readonly migrationIdentity: string;
  readonly manifest: V2MigrationPackageManifestV1;
  records(): Iterable<V2MigrationPackageRecordV1>;
  assertUnchanged(): void;
  close(): void;
}
```

Write every source event as one canonical JSON line containing the exact stored-event envelope including `payloadJson`, `payloadHash`, and event-chain hashes. Copy legacy bytes under `artifacts/` only after verifying their pre-read and post-read identities. Feed record descriptors incrementally into SHA-256 and stop before writing when an event, aggregate, batch, or deadline limit would be exceeded.

Create a sibling temporary directory, fsync every file and directory, verify the complete package through `openSealedV2MigrationPackage`, then rename it to `<migrationIdentity>`. If the target exists, verify and adopt only an exact package; otherwise quarantine the temporary directory. The final directory and every descendant must reject symbolic links and path replacement.

Before publication calculate:

```ts
const packageChecksum = sha256(
  `project-memory/v2-shadow-migration-package/v1\n${canonicalJson(manifestWithoutChecksum)}`,
);
const migrationIdentity = shadowMigrationIdentity({
  projectId, storeId, sourceManifestChecksum, terminalEventHash,
  packageChecksum, migrationAlgorithmVersion: 1,
  buildIdentityHash, configurationChecksum,
});
```

Package sealing does not require a rollout revision because the revision cannot know `migrationIdentityHash` until this checksum exists. Return the verified `migrationIdentity`, `packageChecksum`, and `configurationChecksum`; Task 8 prepares the V1 baseline, and Task 11 requires the immutable rollout revision to match all three values before the first import append.

- [x] **Step 4: Run deterministic package tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js dist-test/tests/v1-source-copy.test.js
npm run typecheck
```

Expected: all tests pass; two paths yield identical logical checksums; all tamper and replacement cases fail closed; source re-verification remains green.

- [x] **Step 5: Commit package sealing.**

```powershell
git add src/orchestrator/migration/v2-migration-package.ts tests/v2-migration-package.test.ts
git commit -m "feat: seal V2 migration packages"
```

### Task 5: Add schema 7 append-only migration, parity, and compatibility evidence

**Files:**
- Create: `src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts`
- Create: `src/orchestrator/storage/v2-shadow-migration.repository.ts`
- Create: `tests/v2-shadow-migration-repository.test.ts`

**Interfaces:**
- Consumes: migration phases and errors from Task 1, `RolloutRevision`, `SqliteConnection`, and canonical JSON/hash helpers.
- Produces: `V2ShadowMigrationRun`, `V2ShadowMigrationTransition`, `ImportedRecordReceipt`, `StoredParityReport`, `CompatibilityOutboxRecord`, `CompatibilityAcknowledgement`, `V2ShadowMigrationTransaction`, and `SqliteV2ShadowMigrationRepository`.

- [x] **Step 1: Write migration/repository RED tests against real SQLite.**

Cover clean schema creation, exact columns/indexes/triggers, strict types, cross-project foreign keys, duplicate identities, out-of-order phases, transition-hash tamper, imported-record conflicts, immutable rules/reports/outbox/acknowledgements, nested transactions, synchronous callback enforcement, rollback, and connection poison after rollback failure:

```ts
test("schema 7 accepts only the exact hash-chained phase sequence", () => {
  const fixture = repositoryFixture();
  fixture.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
    tx.insertRun(RUN);
    tx.appendTransition(transition(0, "snapshot-verified", GENESIS_TRANSITION_HASH));
    assert.throws(
      () => tx.appendTransition(transition(2, "import-committed", "f".repeat(64))),
      (error: unknown) => error instanceof ShadowMigrationError
        && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
    );
    tx.appendTransition(transition(1, "package-sealed", transitionHash(0)));
  });
  assert.deepEqual(
    fixture.repository.readVerifiedTransitions(PROJECT_ID, MIGRATION_IDENTITY).map((row) => row.phase),
    ["snapshot-verified", "package-sealed"],
  );
});

test("all semantic evidence rows are immutable", () => {
  const fixture = committedRepositoryFixture();
  for (const table of [
    "v2_shadow_migration_runs", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts",
    "v2_shadow_imported_records", "v2_shadow_expected_difference_rules",
    "v2_shadow_parity_reports", "v2_shadow_compatibility_outbox",
    "v2_shadow_compatibility_claims", "v2_shadow_compatibility_acknowledgements",
  ]) {
    assert.throws(() => fixture.connection.exec(`UPDATE ${table} SET project_id = project_id`));
    assert.throws(() => fixture.connection.exec(`DELETE FROM ${table}`));
  }
});
```

- [x] **Step 2: Run repository tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-repository.test.js
```

Expected: compilation fails because migration 0007 and its repository do not exist.

- [x] **Step 3: Create the guarded schema.**

Migration `version: 7`, name `v2-shadow-migration`, must create these STRICT, WITHOUT ROWID tables:

```sql
CREATE TABLE v2_shadow_migration_runs (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL CHECK (length(migration_identity) = 64 AND migration_identity NOT GLOB '*[^0-9a-f]*'),
  rollout_revision_id TEXT NOT NULL,
  package_checksum TEXT NOT NULL CHECK (length(package_checksum) = 64 AND package_checksum NOT GLOB '*[^0-9a-f]*'),
  source_manifest_checksum TEXT NOT NULL CHECK (length(source_manifest_checksum) = 64 AND source_manifest_checksum NOT GLOB '*[^0-9a-f]*'),
  source_terminal_position INTEGER NOT NULL CHECK (source_terminal_position >= 0),
  source_terminal_hash TEXT NOT NULL CHECK (length(source_terminal_hash) = 64 AND source_terminal_hash NOT GLOB '*[^0-9a-f]*'),
  configuration_checksum TEXT NOT NULL CHECK (length(configuration_checksum) = 64 AND configuration_checksum NOT GLOB '*[^0-9a-f]*'),
  policy_checksum TEXT NOT NULL CHECK (length(policy_checksum) = 64 AND policy_checksum NOT GLOB '*[^0-9a-f]*'),
  build_identity_hash TEXT NOT NULL CHECK (length(build_identity_hash) = 64 AND build_identity_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity),
  FOREIGN KEY (project_id, rollout_revision_id) REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_migration_transitions (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('snapshot-verified','package-sealed','import-committed','projection-verified','parity-complete','compatibility-complete')),
  prior_transition_hash TEXT NOT NULL CHECK (length(prior_transition_hash) = 64 AND prior_transition_hash NOT GLOB '*[^0-9a-f]*'),
  transition_hash TEXT NOT NULL CHECK (length(transition_hash) = 64 AND transition_hash NOT GLOB '*[^0-9a-f]*'),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, ordinal),
  UNIQUE (project_id, migration_identity, phase),
  UNIQUE (project_id, migration_identity, transition_hash),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_migration_attempts (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('snapshot-verified','package-sealed','import-committed','projection-verified','parity-complete','compatibility-complete')),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 64),
  operation_attempt_index INTEGER NOT NULL CHECK (operation_attempt_index >= 0),
  outcome_category TEXT NOT NULL CHECK (outcome_category IN ('retryable-failure','unknown-outcome','retry-exhausted','terminal-failure')),
  safe_error_code TEXT NOT NULL CHECK (length(trim(safe_error_code)) BETWEEN 1 AND 64),
  prior_committed_phase TEXT,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, attempt_ordinal),
  UNIQUE (project_id, migration_identity, attempt_id),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_imported_records (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('source-event','legacy-artifact')),
  source_record_hash TEXT NOT NULL CHECK (length(source_record_hash) = 64 AND source_record_hash NOT GLOB '*[^0-9a-f]*'),
  imported_event_id TEXT NOT NULL,
  imported_global_position INTEGER NOT NULL CHECK (imported_global_position > 0),
  imported_event_hash TEXT NOT NULL CHECK (length(imported_event_hash) = 64 AND imported_event_hash NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, source_ordinal),
  UNIQUE (project_id, imported_event_id),
  UNIQUE (project_id, imported_global_position),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;
```

Create the remaining immutable tables with these exact logical columns and constraints; apply the same lowercase-hash byte-length checks used above to every `*_hash`, `*_checksum`, `*_digest`, and `*_fingerprint` column:

```sql
CREATE TABLE v2_shadow_expected_difference_rules (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  category TEXT NOT NULL CHECK (category IN ('semantic-value','representation')),
  projection_name TEXT NOT NULL CHECK (projection_name IN ('sessionTree','sessionCheckpoints','canonicalItems','tasksFollowups','artifactsFiles','entityGraph','lexicalChunks','retrievalFeedback','sealedRetrieval')),
  selector_json TEXT NOT NULL,
  predicate_json TEXT NOT NULL,
  rationale_digest TEXT NOT NULL,
  approver_fingerprint TEXT NOT NULL,
  approval_reference_digest TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rollout_revision_id TEXT NOT NULL,
  rule_checksum TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, rule_id),
  UNIQUE (project_id, migration_identity, rule_checksum),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity),
  FOREIGN KEY (project_id, rollout_revision_id) REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_parity_reports (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  report_id TEXT NOT NULL,
  package_checksum TEXT NOT NULL,
  compared_event_position INTEGER NOT NULL CHECK (compared_event_position >= 0),
  compared_event_hash TEXT NOT NULL,
  v1_manifest_checksum TEXT NOT NULL,
  v2_manifest_checksum TEXT NOT NULL,
  v1_core_checksums_digest TEXT NOT NULL,
  v2_core_checksums_digest TEXT NOT NULL,
  retrieval_vector_checksum TEXT NOT NULL,
  equal_count INTEGER NOT NULL CHECK (equal_count >= 0),
  expected_difference_count INTEGER NOT NULL CHECK (expected_difference_count >= 0),
  blocking_divergence_count INTEGER NOT NULL CHECK (blocking_divergence_count >= 0),
  report_json TEXT NOT NULL,
  report_checksum TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, report_id),
  UNIQUE (project_id, migration_identity, report_checksum),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_outbox (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  imported_event_id TEXT NOT NULL,
  imported_global_position INTEGER NOT NULL CHECK (imported_global_position > 0),
  imported_event_hash TEXT NOT NULL,
  triggering_payload_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_sha256 TEXT NOT NULL,
  materialization_revision INTEGER NOT NULL CHECK (materialization_revision > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id),
  UNIQUE (project_id, migration_identity, source_ordinal),
  FOREIGN KEY (project_id, migration_identity, source_ordinal)
    REFERENCES v2_shadow_imported_records(project_id, migration_identity, source_ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_claims (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_owner_fingerprint TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id),
  UNIQUE (project_id, migration_identity, claim_id),
  FOREIGN KEY (project_id, migration_identity, outbox_id)
    REFERENCES v2_shadow_compatibility_outbox(project_id, migration_identity, outbox_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_acknowledgements (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  acknowledgement_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  acknowledged_imported_position INTEGER NOT NULL CHECK (acknowledged_imported_position > 0),
  materialization_revision INTEGER NOT NULL CHECK (materialization_revision > 0),
  target_content_sha256 TEXT NOT NULL,
  acknowledgement_checksum TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id),
  UNIQUE (project_id, migration_identity, acknowledgement_id),
  FOREIGN KEY (project_id, migration_identity, outbox_id)
    REFERENCES v2_shadow_compatibility_claims(project_id, migration_identity, outbox_id)
) STRICT, WITHOUT ROWID;
```

Strict row decoders must canonical-parse `selector_json`, `predicate_json`, and `report_json` and verify their stored checksums. No table stores an absolute root. Compatibility claims and acknowledgements are append-only and unique per outbox record.

Add `BEFORE UPDATE` and `BEFORE DELETE` abort triggers named `<table>_no_update` and `<table>_no_delete` for every table. Add `BEFORE INSERT` guards that reject replacement conflicts with `V2_SHADOW_IMMUTABLE`; a transition guard requires `ordinal = prior ordinal + 1`, exact next phase, and prior hash equality. Attempt rows have their own monotonically increasing `attempt_ordinal` and never consume or unblock a committed phase.

- [x] **Step 4: Implement strict transaction and reconciliation reads.**

Use a synchronous callback transaction like the rollout repository. Public operations are exact:

```ts
export interface V2ShadowMigrationRun {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly rolloutRevisionId: string;
  readonly packageChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly sourceTerminalPosition: bigint;
  readonly sourceTerminalHash: string;
  readonly configurationChecksum: string;
  readonly policyChecksum: string;
  readonly buildIdentityHash: string;
  readonly createdAt: string;
}

export interface V2ShadowMigrationTransition {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly ordinal: number;
  readonly attemptId: string;
  readonly phase: ShadowMigrationPhase;
  readonly priorTransitionHash: string;
  readonly transitionHash: string;
  readonly evidenceDigest: string;
  readonly recordedAt: string;
}

export interface V2ShadowMigrationAttemptEvidence {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly attemptOrdinal: number;
  readonly attemptId: string;
  readonly phase: ShadowMigrationPhase;
  readonly operation: string;
  readonly operationAttemptIndex: number;
  readonly outcomeCategory: "retryable-failure" | "unknown-outcome" | "retry-exhausted" | "terminal-failure";
  readonly safeErrorCode: string;
  readonly priorCommittedPhase: ShadowMigrationPhase | null;
  readonly evidenceDigest: string;
  readonly recordedAt: string;
}

export interface ImportedRecordReceipt {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly sourceOrdinal: number;
  readonly sourceKind: "source-event" | "legacy-artifact";
  readonly sourceRecordHash: string;
  readonly importedEventId: string;
  readonly importedGlobalPosition: bigint;
  readonly importedEventHash: string;
  readonly recordedAt: string;
}

export interface StoredExpectedDifferenceRule {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly ruleId: string;
  readonly policyVersion: number;
  readonly category: "semantic-value" | "representation";
  readonly projectionName: ProjectionName;
  readonly selector: Readonly<{ rowIdentityHash: string; fieldPath: string }>;
  readonly predicate: Readonly<{
    operator: "exact-value-hashes";
    v1ValueHash: string;
    v2ValueHash: string;
  }>;
  readonly rationaleDigest: string;
  readonly approverFingerprint: string;
  readonly approvalReferenceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly rolloutRevisionId: string;
  readonly ruleChecksum: string;
}

export interface StoredParityReport {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly reportId: string;
  readonly packageChecksum: string;
  readonly comparedEventPosition: bigint;
  readonly comparedEventHash: string;
  readonly v1ManifestChecksum: string;
  readonly v2ManifestChecksum: string;
  readonly v1CoreChecksumsDigest: string;
  readonly v2CoreChecksumsDigest: string;
  readonly retrievalVectorChecksum: string;
  readonly equalCount: number;
  readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number;
  readonly report: Readonly<Record<string, unknown>>;
  readonly reportChecksum: string;
  readonly recordedAt: string;
}

export interface CompatibilityClaim {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly outboxId: string;
  readonly claimId: string;
  readonly claimOwnerFingerprint: string;
  readonly claimedAt: string;
}

export interface CompatibilityAcknowledgement {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly outboxId: string;
  readonly acknowledgementId: string;
  readonly claimId: string;
  readonly acknowledgedImportedPosition: bigint;
  readonly materializationRevision: bigint;
  readonly targetContentSha256: string;
  readonly acknowledgementChecksum: string;
  readonly acknowledgedAt: string;
}

export interface V2ShadowMigrationTransaction {
  readRun(): V2ShadowMigrationRun | null;
  insertRun(run: V2ShadowMigrationRun): void;
  readTransitions(): readonly V2ShadowMigrationTransition[];
  appendTransition(transition: V2ShadowMigrationTransition): void;
  readAttemptEvidence(): readonly V2ShadowMigrationAttemptEvidence[];
  appendAttemptEvidence(attempt: V2ShadowMigrationAttemptEvidence): void;
  readImportedRecords(): readonly ImportedRecordReceipt[];
  insertImportedRecords(records: readonly ImportedRecordReceipt[]): void;
  insertExpectedDifferenceRules(rules: readonly StoredExpectedDifferenceRule[]): void;
  readExpectedDifferenceRules(): readonly StoredExpectedDifferenceRule[];
  insertParityReport(report: StoredParityReport): void;
  readParityReport(): StoredParityReport | null;
  enqueueCompatibility(records: readonly CompatibilityOutboxRecord[]): void;
  readPendingCompatibility(): readonly CompatibilityOutboxRecord[];
  claimCompatibility(claim: CompatibilityClaim): CompatibilityClaim;
  acknowledgeCompatibility(ack: CompatibilityAcknowledgement): void;
  readCompatibilityAcknowledgements(): readonly CompatibilityAcknowledgement[];
}

export class SqliteV2ShadowMigrationRepository {
  transact<T>(projectId: string, migrationIdentity: string, callback: (tx: V2ShadowMigrationTransaction) => T): T;
  readVerifiedTransitions(projectId: string, migrationIdentity: string): readonly V2ShadowMigrationTransition[];
}
```

Decode every SQLite row with exact keys, bigint int64 checks, canonical timestamps, UUID/hash checks, and canonical JSON round-trip. Recompute transition hashes using domain `project-memory/v2-shadow-migration-transition/v1` on every read. SQLite busy errors remain available to the runner for retry classification; immutability, decoding, order, or hash errors become `MIGRATION_LEDGER_INTEGRITY_FAILURE`.

- [x] **Step 5: Run schema/repository verification.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-repository.test.js dist-test/tests/rollout-control-plane.test.js
npm run typecheck
```

Expected: all tests pass; the repository is transaction-bound, append-only, fail-closed, and returns frozen decoded data.

- [x] **Step 6: Commit schema 7 repository work.**

```powershell
git add src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts src/orchestrator/storage/v2-shadow-migration.repository.ts tests/v2-shadow-migration-repository.test.ts
git commit -m "feat: persist V2 shadow migration evidence"
```

### Task 6: Import package records as deterministic committed V2 shadow events

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-importer.ts`
- Create: `tests/v2-shadow-importer.test.ts`
- Correct upstream dependency: `src/orchestrator/migration/v2-migration-package.ts`
- Test upstream dependency: `tests/v2-migration-package.test.ts`
- Reuse: `src/orchestrator/storage/event-store.ts:40-110`
- Reuse: `src/orchestrator/storage/event-append-transaction.ts:48-49,1480-1833`

**Interfaces:**
- Consumes: `SealedV2MigrationPackage`, `EventStore`, `SqliteEventAppendStatements`, `MaintenanceFence`, `BranchScopeRepository`, migration repository transactions, and policy batch limits.
- Produces: `V2ShadowImportResult`, `V2ShadowImporter.import(input)`, exact wrapper payloads, and deterministic replay receipts.

**Implementation correction (2026-09-11):** Task 4 omitted the `createdAt` field consumed by Step 4 below. Add the required canonical timestamp to the exact package manifest, copying only the verified `source.manifest.createdAt`; include it in the existing package checksum and migration identity. Reject missing or invalid timestamps without a fallback. This corrects the local producer/consumer contract; it does not change the approved rollout boundary. Task 6 is complete at `8f2c3d6` after independent specification and quality approval; round 2 package-inclusive gate passed 98/98 and round 3 importer/EventStore gate passed 76/76, with build and typecheck passing.

- [x] **Step 1: Write import RED tests with production EventStore.**

Prove wrapper events are committed/authenticated, batch limits use the stricter of migration policy and event-store bounds, three isolated imports produce identical event IDs/hashes, replay is a no-op, package identity reuse with changed bytes conflicts, and a crash after commit is reconciled by the same deterministic command:

```ts
test("imports every package record exactly once as authenticated V2 events", async (t) => {
  const fixture = await sealedPackageFixture(t);
  const first = await fixture.importer.import(fixture.importInput);
  const second = await fixture.importer.import(fixture.importInput);
  assert.equal(first.recordCount, fixture.package.manifest.recordDescriptors.length);
  assert.deepEqual(second, { ...first, deduplicated: true });
  const stored = readAllStoredEvents(fixture.targetConnection);
  assert.equal(stored.length, first.recordCount);
  let cursor = { expectedPosition: 1n, previousEventHash: GENESIS_GLOBAL_HASH };
  for (const event of stored) cursor = authenticateStoredEvent(event, cursor).nextCursor;
});

test("reconciles after commit-before-ledger-receipt without a second semantic append", async (t) => {
  const fixture = await sealedPackageFixture(t, { failAfterBatchCommit: 1 });
  await assert.rejects(fixture.importer.import(fixture.importInput), isUnknownOutcome);
  fixture.disableFaults();
  const recovered = await fixture.importer.import(fixture.importInput);
  assert.equal(recovered.recordCount, fixture.package.manifest.recordDescriptors.length);
  assert.equal(countImportedEvents(fixture.targetConnection), recovered.recordCount);
  assert.equal(new Set(recovered.eventIds).size, recovered.eventIds.length);
});
```

- [x] **Step 2: Run importer tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js
```

Expected: compilation fails because the importer and wrapper contracts do not exist.

- [x] **Step 3: Define exact wrapper events and deterministic batch planning.**

Use two event types in one migration stream `v2-shadow-import/<migrationIdentity>`:

```ts
export interface V1ProjectionSourceImportedV1 {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly sourceOrdinal: number;
  readonly sourceRecordHash: string;
  readonly sourceEvent: Readonly<{
    globalPosition: string;
    eventId: string;
    projectId: string;
    vaultId: string;
    storeId: string;
    workspaceId: string;
    branchScopeId: string | null;
    branchRef: string | null;
    streamId: string;
    streamType: string;
    streamVersion: string;
    eventType: string;
    eventSchemaVersion: number;
    sessionId: string | null;
    parentSessionId: string | null;
    actorRole: string;
    agentId: string;
    clientInstanceId: string;
    correlationId: string;
    causationId: string | null;
    commandId: string;
    idempotencyKey: string;
    commandEventIndex: number;
    occurredAt: string;
    recordedAt: string;
    visibilityScope: string;
    confidence: string;
    verificationStatus: string;
    sourceRefs: readonly string[];
    evidenceRefs: readonly [];
    evidenceDigests: readonly [];
    payloadJson: string;
    payloadHash: string;
    previousGlobalHash: string;
    eventHash: string;
    lifecycleIntentJson: string | null;
  }>;
}

export interface V1LegacyArtifactImportedV1 {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly sourceOrdinal: number;
  readonly sourceRecordHash: string;
  readonly relativePath: string;
  readonly contentSha256: string;
  readonly contentUtf8: string;
}

export interface V2ShadowImportResult {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly packageChecksum: string;
  readonly recordCount: number;
  readonly eventIds: readonly string[];
  readonly firstImportedPosition: bigint | null;
  readonly terminalImportedPosition: bigint | null;
  readonly terminalImportedEventHash: string;
  readonly importedEventsChecksum: string;
  readonly deduplicated: boolean;
}
```

The package reader validates values before the importer constructs these payloads. Artifact bytes must round-trip through `TextDecoder("utf-8", { fatal: true })` and `Buffer.from(contentUtf8, "utf8")` to the declared byte length/hash.

Batch planning must satisfy all four limits simultaneously:

```ts
const maxEvents = Math.min(policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND);
const maxBytes = Math.min(policy.maxBatchBytes, MAX_CANONICAL_COMMAND_BYTES);
```

Start a new batch before either next event would exceed `maxEvents` or the canonical command would exceed `maxBytes`; a single event beyond `maxEventBytes` fails `MIGRATION_LIMIT_EXCEEDED`.

- [x] **Step 4: Append deterministic commands and reconcile receipts.**

For batch ordinal `b`, derive command ID, idempotency key, correlation ID, event IDs, recorded time, and public response exclusively from migration identity/package contents. Instantiate an `EventStore` per batch with a deterministic UUID closure seeded by the source ordinals in that batch and a deterministic clock derived from `manifest.createdAt + b milliseconds`.

Wrapper principal metadata is internal migration metadata: use the existing least-authority `untrusted` role and a domain-prefixed client instance identity derived from `migrationIdentity`. Presenting caller role/client identity and checkout branch metadata must not change wrapper hashes. Preserve the original principal and scope provenance exactly inside authenticated `sourceEvent`; do not mutate the caller context or add lifecycle authority. Verify determinism across genuinely distinct input contexts as well as isolated stores.

Each pending event uses `visibilityScope: "project"`, empty evidence arrays, `confidence: "high"`, `verificationStatus: "verified"`, and a source reference `migration:<migrationIdentity>:<sourceOrdinal>`. Use `eventType: "V1ProjectionSourceImported"` for source events and `eventType: "V1LegacyArtifactImported"` for artifacts.

After `EventStore.append`, read the exact committed stored events by returned positions, match payload migration identity/ordinal/hash, and insert `ImportedRecordReceipt` rows in the ledger transaction. If append returns `COMMAND_OUTCOME_UNKNOWN`, repeat the same deterministic append: a committed batch returns the deduplicated stored response; an absent batch commits once; a conflicting response fails `MIGRATION_IDENTITY_CONFLICT`. Never issue a new command ID for the same batch.

- [x] **Step 5: Run importer and event-store regression tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/event-store.test.js dist-test/tests/event-append-transaction.test.js
npm run typecheck
```

Expected: all tests pass; imported event IDs/hashes are deterministic across isolated stores; replay adds no events; unknown outcome cannot duplicate data.

- [x] **Step 6: Commit deterministic import.**

```powershell
git add src/orchestrator/migration/v2-shadow-importer.ts tests/v2-shadow-importer.test.ts
git commit -m "feat: import deterministic V2 shadow events"
```

### Task 7: Reconstruct authenticated projection input only from committed imports

**Files:**
- Create: `src/orchestrator/migration/v2-imported-event-reader.ts`
- Create: `tests/v2-imported-event-reader.test.ts`
- Reuse: `src/orchestrator/projections/event-reader.ts:43-79`
- Reuse: `src/orchestrator/integrity/stored-event-authenticator.ts`

**Interfaces:**
- Consumes: `ProjectionEventReader`, committed wrapper events, package manifest, import receipts, and production stored-event authentication.
- Produces: `V2ImportedProjectionEventReader` and a `ProjectionEventSnapshot` whose binding/terminal position/hash are the verified original V1 snapshot values.

- [x] **Step 1: Write committed-authority RED tests.**

```ts
test("reconstructs source events only when wrapper and ledger receipts agree", async (t) => {
  const fixture = await importedPackageFixture(t);
  const snapshot = await fixture.reader.openCommittedSnapshot(fixture.sourceBinding);
  assert.deepEqual([...snapshot.events()], fixture.sourceEvents);
  assert.equal(snapshot.terminalEventPosition, BigInt(fixture.package.manifest.terminalEventPosition));
  assert.equal(snapshot.terminalEventHash, fixture.package.manifest.terminalEventHash);
  snapshot.close();
});

test("rejects package bytes that were never committed as wrapper events", async (t) => {
  const fixture = await importedPackageFixture(t, { omitImportedReceiptOrdinal: 1 });
  await assert.rejects(
    fixture.reader.openCommittedSnapshot(fixture.sourceBinding),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
  );
});
```

Also cover duplicate/missing/reordered ordinals, wrapper payload tamper, receipt event-ID/position/hash mismatch, artifact wrapper appearing as a projection source, nested import wrapper, wrong migration identity, wrong source binding, broken original event chain, and close idempotence.

- [x] **Step 2: Run imported-reader tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-imported-event-reader.test.js
```

Expected: compilation fails because the committed-import reader does not exist.

- [x] **Step 3: Implement the authenticated reconstruction boundary.**

The public reader surface is exact:

```ts
export class V2ImportedProjectionEventReader implements ProjectionEventReader {
  constructor(options: V2ImportedProjectionEventReaderOptions);
  openSnapshot(binding: ProjectBinding): Promise<ProjectionEventSnapshot>;
  openCommittedSnapshot(binding: ProjectBinding): Promise<ProjectionEventSnapshot>;
}
```

`openCommittedSnapshot(binding)` must:

1. Read and authenticate the target store's complete wrapper-event chain through the last import receipt.
2. Require one ledger receipt for every package record and exact equality of wrapper event ID, global position, event hash, source ordinal, and source record hash.
3. Ignore `V1LegacyArtifactImported` only after verifying its receipt; reject every unknown event in the migration stream.
4. Decode each `V1ProjectionSourceImported.sourceEvent` with exact fields, canonical `payloadJson`, `payloadHash`, UUID/hash/timestamp/int64 checks, and reject a nested import event type.
5. Re-run `authenticateStoredEvent` sequentially over reconstructed source events, beginning at `GENESIS_GLOBAL_HASH`, and require count, aggregate bytes, terminal position, and terminal hash from the sealed package.
6. Return a frozen snapshot whose `events()` can be iterated once per call without exposing mutable payload objects and whose `close()` closes all SQLite snapshots exactly once.

Use the package's source binding as snapshot authority; do not substitute the target wrapper-event binding or wrapper terminal position.

- [x] **Step 4: Run reader and source-codec tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js
npm run typecheck
```

Expected: all tests pass; only committed/authenticated wrappers can become projection input; original event identity and chain remain exact.

- [x] **Step 5: Commit the committed-import reader.**

```powershell
git add src/orchestrator/migration/v2-imported-event-reader.ts tests/v2-imported-event-reader.test.ts
git commit -m "feat: read projections from committed imports"
```

### Task 8: Publish and verify V1-reference and V2-shadow projections at one source position

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-projection.ts`
- Create: `tests/v2-shadow-projection.test.ts`
- Modify: `src/orchestrator/projections/integrity.ts` (narrow committed-snapshot verification seam; preserve existing `verify()` behavior)
- Test: `tests/projection-integrity.test.ts`
- Reuse: `src/orchestrator/projections/builder.ts:829-1018`
- Reuse: `src/orchestrator/projections/coordinator.ts:544-705`
- Reuse: `src/orchestrator/projections/integrity.ts:1183-1240`

**Interfaces:**
- Consumes: the verified V1 source snapshot, `V2ImportedProjectionEventReader`, `ImmutableProjectionBuilder`, `V2ProjectionBuildCoordinator`, `ProjectionIntegrityService`, package/ledger identities, and rollout `v1BaselineChecksum`.
- Produces: `PreparedV1ProjectionBaseline`, `ShadowProjectionResult`, `v1ProjectionBaselineChecksum`, `V2ShadowProjectionPublisher.prepareV1Baseline(input)`, and `V2ShadowProjectionPublisher.publishV2(input)`.

**Producer/consumer correction (2026-09-11):** The current integrity service can replay only an event-store path; it cannot consume the Task 7 reader. Add a separate committed-snapshot verification method that authenticates original events and enforces binding, terminal, count, and byte limits while reusing the existing row/image checks. Keep the existing SQLite `verify()` entry unchanged. The publisher must obtain this snapshot from Task 7 and close it reliably. Use `preparedV1.generation.manifest`, as declared by the interface below. Fixture setup must prepare the baseline before target import, then bind the rollout revision and import; the original shorthand example below is not permission to import before baseline preparation.

- [ ] **Step 1: Write real publication RED tests.**

Use separate absolute directories for the V1 reference and V2 shadow generations. Prove both manifests bind to the original source terminal position/hash, V2 integrity replays from committed imports, rollout baseline checksum is exact, and a target wrapper event or published database tamper fails before the phase transition:

```ts
test("publishes both projection generations at the exact source position", async (t) => {
  const fixture = await importedPackageFixture(t);
  const preparedV1 = await fixture.projectionPublisher.prepareV1Baseline(fixture.v1BaselineInput);
  fixture.assertRevisionBinding(preparedV1);
  const result = await fixture.projectionPublisher.publishV2({
    ...fixture.projectionInput,
    preparedV1,
  });
  assert.equal(result.v1.generation.manifest.terminalEventPosition, fixture.package.manifest.terminalEventPosition);
  assert.equal(result.v2.manifest.terminalEventPosition, fixture.package.manifest.terminalEventPosition);
  assert.equal(result.v1.generation.manifest.terminalEventHash, fixture.package.manifest.terminalEventHash);
  assert.equal(result.v2.manifest.terminalEventHash, fixture.package.manifest.terminalEventHash);
  assert.equal(result.v1BaselineChecksum, fixture.rolloutRevision.v1BaselineChecksum);
  assert.deepEqual(fixture.repository.phases(), [
    "snapshot-verified", "package-sealed", "import-committed", "projection-verified",
  ]);
});

test("does not record projection-verified after generation tamper", async (t) => {
  const fixture = await importedPackageFixture(t, { corruptV2BeforeIntegrityCheck: true });
  await assert.rejects(
    fixture.projectionPublisher.publishV2(fixture.projectionInput),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "PROJECTION_INTEGRITY_FAILURE",
  );
  assert.equal(fixture.repository.phases().includes("projection-verified"), false);
});
```

- [ ] **Step 2: Run projection publication tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js
```

Expected: compilation fails because the Slice-2 projection publisher and baseline checksum do not exist.

- [ ] **Step 3: Build deterministic reference and shadow generations.**

Before import, open a snapshot directly from the verified read-only V1 source. Instantiate the V1 builder with `now: () => package.manifest.createdAt`, call `ImmutableProjectionBuilder.build(snapshot, 1)` in the isolated V1-reference directory, reopen/verify its immutable bytes, and return `PreparedV1ProjectionBaseline`. This value supplies `v1BaselineChecksum` when the rollout revision is created or checked.

After import, open only the committed-import reader from Task 7, instantiate the V2 builder with the same deterministic `now`, and call `V2ProjectionBuildCoordinator.ensurePublished(binding, terminalPosition, remainingDeadlineMs)` in the isolated V2 directory. The publisher must re-read and verify the already prepared V1 generation before comparison; it never rebuilds V1 from package bytes or target wrapper events.

Calculate the baseline only from canonical logical fields:

```ts
export function v1ProjectionBaselineChecksum(manifest: ProjectionManifestV1): string {
  return sha256(
    `project-memory/v1-shadow-baseline/v1\n${canonicalJson({
      projectId: manifest.projectId,
      vaultId: manifest.vaultId,
      storeId: manifest.storeId,
      workspaceId: manifest.workspaceId,
      branchScopeId: manifest.branchScopeId,
      branchRef: manifest.branchRef,
      terminalEventPosition: manifest.terminalEventPosition,
      terminalEventHash: manifest.terminalEventHash,
      coreChecksums: manifest.coreChecksums,
    })}`,
  );
}

export interface ShadowProjectionResult {
  readonly v1: PreparedV1ProjectionBaseline;
  readonly v2: PublishedProjectionGenerationV2;
  readonly v1BaselineChecksum: string;
  readonly v2ManifestChecksum: string;
}
```

```ts
export interface PreparedV1ProjectionBaseline {
  readonly generation: BuiltProjectionGeneration;
  readonly baselineChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
}
```

Require V1 and V2 binding fields, terminal position, and terminal hash to equal the sealed package; require the calculated V1 baseline to equal the rollout revision. Run the separate `ProjectionIntegrityService` committed-snapshot verification method for V2 with a snapshot from the committed-import reader, and verify the V1 database SHA/core checksums by reopening its immutable image. Only then append `projection-verified` with evidence digest over both manifests and baseline hashes.

- [ ] **Step 4: Run full projection regression.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/v2-reader-lease.test.js
npm run typecheck
```

Expected: all tests pass; both generations are position-aligned; no path-based trust or uncommitted package read can enter the V2 projection.

- [ ] **Step 5: Commit verified projection publication.**

```powershell
git add src/orchestrator/migration/v2-shadow-projection.ts tests/v2-shadow-projection.test.ts
git commit -m "feat: verify V2 shadow projections"
```

### Task 9: Govern expected differences and emit typed snapshot-aligned parity

**Files:**
- Create: `src/orchestrator/parity/v2-expected-difference.ts`
- Create: `src/orchestrator/parity/v2-snapshot-parity.ts`
- Create: `tests/v2-snapshot-parity.test.ts`
- Modify: `src/orchestrator/projections/integrity.ts:400-470,1183-1240`
- Test: `tests/projection-integrity.test.ts`

**Interfaces:**
- Consumes: verified V1/V2 projection generations, rollout revision/migration identity, migration policy rule version/age, repository rule/report operations, existing canonical projection row readers, `SealedRetrievalEvaluationCorpusV2`, and two internal retrieval services bound to the pinned V1/V2 generations.
- Produces: `ExpectedDifferenceRuleV1`, `decodeExpectedDifferenceRuleV1`, `ParityClassification`, `RedactedParityFindingV1`, `SealedRetrievalParityV1`, `SnapshotParityReportV1`, `readVerifiedCanonicalProjectionSnapshot`, and `compareV1V2Snapshots(input)`.

- [ ] **Step 1: Write parity/rule RED tests.**

Cover exact equality, one exact governed difference, blocking semantic difference, every never-excludable category, expired/future/revision-mismatched/migration-mismatched/checksum-mismatched rule, wildcard selector, multiple matching rules, projection-position mismatch, an internally invalid declared/recomputed core checksum, sealed retrieval result/citation/ranking drift, plaintext absence, and deterministic report checksum:

```ts
test("classifies one exact approved difference without exposing values", () => {
  const fixture = parityFixture({ difference: "summary-hash" });
  const rule = approvedRule({
    category: "semantic-value",
    projection: "canonicalItems",
    rowIdentityHash: fixture.rowIdentityHash,
    fieldPath: "summary",
    v1ValueHash: fixture.v1ValueHash,
    v2ValueHash: fixture.v2ValueHash,
  });
  const report = compareV1V2Snapshots({ ...fixture.input, rules: [rule] });
  assert.equal(report.equalCount > 0, true);
  assert.equal(report.expectedDifferenceCount, 1);
  assert.equal(report.blockingDivergenceCount, 0);
  assert.equal(JSON.stringify(report).includes(fixture.plaintextSummary), false);
});

test("never permits a rule to normalize authority or core checksum", () => {
  for (const category of [
    "identity", "authority", "scope", "event-chain-integrity", "privacy",
    "erasure", "duplicate-event", "lost-event", "ordering",
    "terminal-position", "terminal-hash", "core-checksum", "plaintext-leakage",
  ] as const) {
    assert.throws(
      () => decodeExpectedDifferenceRuleV1(approvedRule({ category })),
      (error: unknown) => error instanceof ShadowMigrationError
        && error.code === "PARITY_RULE_INVALID",
    );
  }
});

test("compares the sealed retrieval corpus through both pinned generations", async () => {
  const fixture = sealedRetrievalParityFixture();
  const report = await compareV1V2Snapshots(fixture.input);
  assert.equal(report.retrieval.queryCount, fixture.corpus.queries.length);
  assert.equal(report.retrieval.blockingDivergenceCount, 0);
  assert.equal(report.retrieval.v1ThresholdsPassed, true);
  assert.equal(report.retrieval.v2ThresholdsPassed, true);
  assert.equal(JSON.stringify(report).includes(fixture.queryPlaintextSentinel), false);
});
```

- [ ] **Step 2: Run parity tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/projection-integrity.test.js
```

Expected: compilation fails because the rule decoder, verified canonical snapshot reader, and parity engine do not exist.

- [ ] **Step 3: Expose canonical rows only after projection verification.**

Refactor the existing integrity reader without duplicating table definitions:

```ts
export interface VerifiedCanonicalProjectionSnapshot {
  readonly schemaVersion: 1 | 2;
  readonly binding: ProjectBinding;
  readonly terminalEventPosition: bigint;
  readonly terminalEventHash: string;
  readonly coreChecksums: Readonly<Record<ProjectionName, string>>;
  readonly rows: Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;
}

export function readVerifiedCanonicalProjectionSnapshot(
  binding: ProjectBinding,
  manifestValue: unknown,
  options: ProjectionIntegrityServiceOptions,
): VerifiedCanonicalProjectionSnapshot;
```

This function must use the existing manifest parser, stable file identity, immutable image, schema/table/index checks, canonical row conversion, and core-checksum verification. It returns deep-frozen logical rows only after all checks pass and never returns the database handle or path. V1 schema-1 and V2 schema-2 core checksum strings are not required to equal one another; each side's declared checksum must equal its own recomputed canonical rows. A declared/recomputed mismatch on either side is the never-excludable `core-checksum` integrity category.

- [ ] **Step 4: Implement immutable rule decoding and unique matching.**

Use exact fields:

```ts
export interface ExpectedDifferenceRuleV1 {
  readonly schemaVersion: 1;
  readonly ruleId: string;
  readonly policyVersion: number;
  readonly category: "semantic-value" | "representation";
  readonly projection: ProjectionName;
  readonly rowIdentityHash: string;
  readonly fieldPath: string;
  readonly predicate: Readonly<{
    operator: "exact-value-hashes";
    v1ValueHash: string;
    v2ValueHash: string;
  }>;
  readonly rationaleDigest: string;
  readonly approverFingerprint: string;
  readonly approvalReferenceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly ruleChecksum: string;
}
```

Reject `*`, empty path segments, array wildcards, prototype keys, executable strings, fields outside the canonical comparison value, noncanonical timestamps, issued time after run start, expiry at/before run start, age beyond `maxExpectedDifferenceRuleAgeMs`, or any binding/checksum mismatch. A finding must match zero or one rule; two matches are `PARITY_RULE_INVALID`.

- [ ] **Step 5: Compare aligned snapshots and persist a redacted report.**

Before row comparison require exact equality of binding and terminal position/hash. Compare projections in `PROJECTION_NAMES` order; rows by canonical identity key; fields by sorted name. Classify each comparison as:

```ts
export type ParityClassification =
  | "PARITY_EQUAL"
  | "PARITY_EXPECTED_DIFFERENCE"
  | "PARITY_BLOCKING_DIVERGENCE";

export interface RedactedParityFindingV1 {
  readonly schemaVersion: 1;
  readonly classification: ParityClassification;
  readonly category: string;
  readonly projection: ProjectionName;
  readonly rowIdentityHash: string;
  readonly fieldPathHash: string;
  readonly v1ValueHash: string;
  readonly v2ValueHash: string;
  readonly ruleId: string | null;
}
```

Hash canonical scalar values with domain `project-memory/v2-parity-value/v1`; hash field paths before report output. The report contains only terminal identities, manifest/core-checksum digests, counts, findings, matched rule IDs, sealed retrieval parity, and `reportChecksum` over canonical redacted JSON.

For sealed retrieval parity, pin reader leases for both generations, build two `InternalRetrievalService` instances with `SqliteRetrievalCandidateRepository`, call `evaluateSealedRetrieval` for absolute threshold evidence, and also run every sealed query through both services. Canonicalize each result to item IDs, statuses, visibility, source-event positions, citation identities, ranks, conflict closure, and temporal eligibility; hash the canonical result and citation vector per query. Vector/provider channels remain disabled as required by `assertSealedEvaluationVectorDisabled`. Classify mismatched result/citation/order hashes through the same exact-rule engine; identity/scope/temporal/conflict/citation-integrity drift is never excludable.

```ts
export interface SealedRetrievalParityV1 {
  readonly corpusVersion: string;
  readonly queryCount: number;
  readonly v1ThresholdsPassed: boolean;
  readonly v2ThresholdsPassed: boolean;
  readonly equalCount: number;
  readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number;
  readonly resultVectorChecksum: string;
}

export interface SnapshotParityReportV1 {
  readonly schemaVersion: 1;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly packageChecksum: string;
  readonly comparedEventPosition: bigint;
  readonly comparedEventHash: string;
  readonly v1ManifestChecksum: string;
  readonly v2ManifestChecksum: string;
  readonly v1CoreChecksumsDigest: string;
  readonly v2CoreChecksumsDigest: string;
  readonly comparisonPolicyVersion: number;
  readonly equalCount: number;
  readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number;
  readonly findings: readonly RedactedParityFindingV1[];
  readonly matchedRuleIds: readonly string[];
  readonly sealedRetrieval: SealedRetrievalParityV1;
  readonly reportChecksum: string;
}
```

Persist rules first, then the report. If any row or retrieval blocking count is nonzero, persist the red report and throw `PARITY_BLOCKING_DIVERGENCE` without appending `parity-complete`; otherwise append the phase with the report checksum as evidence.

- [ ] **Step 6: Run parity, integrity, and redaction verification.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/projection-schema.test.js dist-test/tests/retrieval-evaluation.test.js
npm run typecheck
```

Expected: all tests pass; blocking reports are durably visible but cannot advance the ledger; no raw row value appears in stored reports or thrown errors.

- [ ] **Step 7: Commit parity governance.**

```powershell
git add src/orchestrator/parity/v2-expected-difference.ts src/orchestrator/parity/v2-snapshot-parity.ts src/orchestrator/projections/integrity.ts tests/v2-snapshot-parity.test.ts tests/projection-integrity.test.ts
git commit -m "feat: prove V1 V2 snapshot parity"
```

### Task 10: Materialize committed compatibility artifacts only into an isolated target

**Files:**
- Create: `src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts`
- Create: `tests/v2-shadow-compatibility.test.ts`
- Modify: `src/orchestrator/migration/v2-shadow-importer.ts`
- Test: `tests/v2-shadow-importer.test.ts`
- Reuse: `src/orchestrator/materialization/atomic-artifact-replacer.ts:21-180`

**Interfaces:**
- Consumes: committed `V1LegacyArtifactImported` wrapper events, import receipts, compatibility outbox/claim/acknowledgement repository operations, isolated root, live V1 vault root, and atomic replacement.
- Produces: `V2ShadowCompatibilityMaterializer.materializePending(input)` and `CompatibilityMaterializationResult`.

- [ ] **Step 1: Add importer-outbox and materializer RED tests.**

Extend importer tests to require one immutable outbox record per legacy artifact after the corresponding wrapper event/receipt commits. Add materializer tests for exact bytes/path/hash, live-root alias rejection, symlink and replacement attacks, stale/wrong claims, crash after replace before acknowledgement, acknowledgement after durable observation, target lag, rerun no-op, and plaintext-free diagnostics:

```ts
test("publishes exact committed artifact bytes below only the isolated root", async (t) => {
  const fixture = await compatibilityFixture(t);
  const result = await fixture.materializer.materializePending(fixture.input);
  assert.equal(result.acknowledgedCount, fixture.package.manifest.legacyArtifactCount);
  for (const expected of fixture.expectedArtifacts) {
    assert.deepEqual(readFileSync(join(fixture.isolatedRoot, expected.relativePath)), expected.bytes);
  }
  assert.deepEqual(fixture.repository.pendingCompatibility(), []);
});

test("rejects a compatibility target that aliases live V1 authority", async (t) => {
  const fixture = await compatibilityFixture(t, { compatibilityRoot: "live-vault" });
  await assert.rejects(
    fixture.materializer.materializePending(fixture.input),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "COMPATIBILITY_INTEGRITY_FAILURE",
  );
});
```

- [ ] **Step 2: Run compatibility tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-compatibility.test.js
```

Expected: importer tests fail because no outbox rows are enqueued; materializer module is absent.

- [ ] **Step 3: Enqueue compatibility records in the import transaction.**

After each artifact wrapper event is durably read back and its import receipt is inserted, enqueue this exact immutable record in the same migration-repository transaction:

```ts
export interface CompatibilityOutboxRecord {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly outboxId: string;
  readonly sourceOrdinal: number;
  readonly importedEventId: string;
  readonly importedGlobalPosition: bigint;
  readonly importedEventHash: string;
  readonly triggeringPayloadHash: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly materializationRevision: bigint;
  readonly recordedAt: string;
}

export interface CompatibilityMaterializationResult {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly acknowledgedCount: number;
  readonly highestAcknowledgedSourceOrdinal: number | null;
  readonly acknowledgedImportedPosition: bigint | null;
  readonly materializationRevision: bigint | null;
  readonly aggregateBytes: number;
  readonly artifactSetChecksum: string;
  readonly deduplicated: boolean;
}
```

Derive `outboxId` with deterministic migration UUID purpose `claim` plus source ordinal. `materializationRevision` equals the source ordinal plus one. Replaying the batch must find the exact existing outbox row; any field difference is `MIGRATION_IDENTITY_CONFLICT`.

- [ ] **Step 4: Implement exact claim, committed-event read, and atomic publication.**

`materializePending` must canonicalize isolated/live roots, reject identity equality or containment, capture the isolated root identity, and process outbox rows by source ordinal. For each row:

1. Insert or read the deterministic claim and require exact outbox/import identities.
2. Read the wrapper event from the target event store by exact global position; authenticate it and decode `V1LegacyArtifactImportedV1`.
3. Require payload migration identity, source ordinal, record hash, relative path, UTF-8 byte length, triggering payload hash, and content SHA-256 to match both receipt and outbox.
4. Resolve the path with `resolveContainedProjectPath`, reject symbolic ancestors/target, and call `AtomicArtifactReplacer.replace` with the exact bytes.
5. Reopen the target through a file descriptor, verify root/target identities and SHA-256, fsync the file and parent directory, then append the acknowledgement.
6. On a replace/acknowledgement interruption, verify target bytes plus claim/outbox/import rows; append the same acknowledgement only if all identities match. Otherwise throw `MIGRATION_OUTCOME_UNKNOWN` or `COMPATIBILITY_INTEGRITY_FAILURE` without replacing again.

Use an injected deterministic acknowledgement clock derived from `sourceManifest.createdAt + sourceOrdinal milliseconds`; performance timing uses a separate monotonic observer. Return only counts, highest acknowledged source ordinal, target position, aggregate bytes, and an artifact-set checksum over `(relativePathHash, byteLength, contentSha256, materializationRevision)`.

- [ ] **Step 5: Run compatibility and existing materializer regression.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/compatibility-log-materializer.test.js dist-test/tests/lifecycle-materialization-queue.test.js
npm run typecheck
```

Expected: all tests pass; live V1 bytes are untouched; committed wrapper events are the only compatibility payload source; rerun is a verified no-op.

- [ ] **Step 6: Commit isolated compatibility materialization.**

```powershell
git add src/orchestrator/migration/v2-shadow-importer.ts src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts tests/v2-shadow-importer.test.ts tests/v2-shadow-compatibility.test.ts
git commit -m "feat: materialize isolated V2 compatibility artifacts"
```

### Task 11: Orchestrate durable phases, bounded retries, and unknown-outcome reconciliation

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration-runner.ts`
- Create: `tests/v2-shadow-migration-runner.test.ts`
- Modify: `tests/support/v2-shadow-migration-fixture.ts`

**Interfaces:**
- Consumes: rollout revision/state, verified source, sealed package, repository, importer, projection publisher, parity engine, compatibility materializer, policy, exact rules, and injected clock/sleep/fault boundaries.
- Produces: `V2ShadowMigrationRunInput`, `V2ShadowMigrationRunResult`, `ShadowMigrationFaultInjector`, and `V2ShadowMigrationRunner.run(input)`.

- [ ] **Step 1: Write end-to-end phase and recovery RED tests.**

Cover a clean run, completed-run no-op, restart before and after every durable boundary, retryable SQLite busy, transient I/O, interrupted worker, retry exhaustion, commit-unknown proved committed, commit-unknown proved absent, unresolved unknown, source mutation between phases, blocking parity, compatibility lag, rollout revision mismatch, active non-off rollout state, and unchanged V1 caller result:

```ts
test("commits all phases in order and returns a verified result", async (t) => {
  const fixture = await runnerFixture(t);
  const result = await fixture.runner.run(fixture.input);
  assert.equal(result.status, "compatibility-complete");
  assert.deepEqual(fixture.repository.phases(), [
    "snapshot-verified", "package-sealed", "import-committed",
    "projection-verified", "parity-complete", "compatibility-complete",
  ]);
  assert.equal(result.parity.blockingDivergenceCount, 0);
  assert.equal(result.compatibility.acknowledgedCount, fixture.expectedArtifacts.length);
  assert.deepEqual(await fixture.invokeV1Probe(), fixture.v1ProbeBefore);
});

test("resumes after every acknowledged durable boundary", async (t) => {
  for (const boundary of SHADOW_MIGRATION_FAULT_BOUNDARIES) {
    const fixture = await runnerFixture(t, { failOnceAt: boundary });
    await assert.rejects(fixture.runner.run(fixture.input));
    fixture.disableFaults();
    const recovered = await fixture.runner.run(fixture.input);
    assert.equal(recovered.status, "compatibility-complete", boundary);
    assert.deepEqual(fixture.repository.phases(), [...SHADOW_MIGRATION_PHASES], boundary);
    assert.equal(new Set(recovered.import.eventIds).size, recovered.import.eventIds.length, boundary);
  }
});
```

- [ ] **Step 2: Run runner tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runner.test.js
```

Expected: compilation fails because the orchestrator and fault boundaries do not exist.

- [ ] **Step 3: Define exact run input/result and phase gates.**

```ts
export const SHADOW_MIGRATION_FAULT_BOUNDARIES = Object.freeze([
  "after-source-verified", "after-package-published", "after-run-created",
  "after-import-commit", "after-projection-publish", "after-parity-report",
  "after-compatibility-replace", "after-compatibility-ack",
] as const);

export type ShadowMigrationFaultBoundary = (typeof SHADOW_MIGRATION_FAULT_BOUNDARIES)[number];

export interface ShadowMigrationFaultInjector {
  hit(boundary: ShadowMigrationFaultBoundary): void | Promise<void>;
}

export interface V2ShadowMigrationRunInput {
  readonly projectId: string;
  readonly rolloutRevisionId: string;
  readonly targetContext: ProjectContext;
  readonly sourceRoot: string;
  readonly sourceManifestPath: string;
  readonly liveEventStorePath: string;
  readonly liveLegacyArtifactRoot: string;
  readonly packageRoot: string;
  readonly v1ProjectionRoot: string;
  readonly v2ProjectionRoot: string;
  readonly compatibilityRoot: string;
  readonly buildIdentityHash: string;
  readonly configuration: ShadowMigrationConfigurationV1;
  readonly expectedDifferenceRules: readonly ExpectedDifferenceRuleV1[];
  readonly creationReasonCode: "production-shaped-rehearsal";
}

export interface V2ShadowMigrationRunResult {
  readonly schemaVersion: 1;
  readonly status: "compatibility-complete";
  readonly migrationIdentity: string;
  readonly rolloutRevisionId: string;
  readonly sourceManifestChecksum: string;
  readonly packageChecksum: string;
  readonly import: V2ShadowImportResult;
  readonly projection: ShadowProjectionResult;
  readonly parity: SnapshotParityReportV1;
  readonly compatibility: CompatibilityMaterializationResult;
  readonly deduplicated: boolean;
}
```

At entry read rollout state and require `mode === "off"`, `activeRevisionId === null`, and no caller-facing activation. Verify source, seal the package, and call `prepareV1Baseline` before reading the named immutable revision. Require the revision's project, build, configuration, migration identity, and V1 baseline checksum to match those prepared values. The runner must then insert the run and append `snapshot-verified` and `package-sealed` in separate committed repository transactions before import. It never creates or changes a rollout revision itself.

Before every phase call `source.assertUnchanged()`, re-read/verify the ledger chain, and verify all prior artifact checksums. Derive committed transition `recordedAt` values from `sourceManifest.createdAt + phase ordinal milliseconds`; measure real elapsed time through a separate monotonic clock that never enters a transition hash. Append a committed phase only after its component has been durably re-read and verified. A completed chain returns the reconstructed verified result with `deduplicated: true` and adds no semantic row/event/artifact.

- [ ] **Step 4: Add bounded retry and attempt evidence.**

Classify only primary SQLite busy, explicitly injected transient filesystem codes (`EBUSY`, `EAGAIN`, `EINTR`), and interrupted-worker errors as retryable. Use the exact sealed backoff:

```ts
const delay = Math.min(
  policy.maxBackoffMs,
  policy.initialBackoffMs * (2 ** attemptIndex),
);
```

Before sleeping or retrying, append a redacted attempt-evidence row containing operation, phase, attempt index, category, safe error code, prior durable phase, and evidence digest. Do not persist `error.message`, stack, paths, payloads, or command text. Re-verify source and durable phase after every delay. Stop when elapsed monotonic time exceeds `deadlineMs` or attempt index exceeds `maxRetries`; append `retry-exhausted` attempt evidence and throw `MIGRATION_RETRY_EXHAUSTED`.

Initial source/package preflight can fail before a migration identity exists. Buffer those exact redacted attempt records in a frozen preflight list. If package sealing later succeeds, insert the buffered rows into `v2_shadow_migration_attempts` immediately after the run row. If preflight terminates before identity creation, return the frozen attempt list to the CLI error handler, which writes a new append-only `preflight-failure-evidence.json` containing rollout revision ID, source-manifest checksum when available, attempt IDs/categories/digests, and no source path or payload. Never create a provisional migration identity.

For `MIGRATION_OUTCOME_UNKNOWN`, call a component-specific reconciler exactly once per retry cycle. It returns `committed`, `absent`, or `unknown`; committed advances only after verification, absent may repeat the same deterministic operation, and unknown records evidence then exits without another write.

- [ ] **Step 5: Run end-to-end, crash, and V1-isolation verification.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/lifecycle-compatibility.test.js
npm run typecheck
```

Expected: all tests pass; every restart converges or blocks safely; no V1 result or live source/target byte changes.

- [ ] **Step 6: Commit durable orchestration.**

```powershell
git add src/orchestrator/migration/v2-shadow-migration-runner.ts tests/support/v2-shadow-migration-fixture.ts tests/v2-shadow-migration-runner.test.ts
git commit -m "feat: orchestrate V2 shadow migration"
```

### Task 12: Generate immutable redacted rehearsal evidence across three clean runs and one no-op

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration-evidence.ts`
- Create: `scripts/run-v2-shadow-migration-rehearsal.js`
- Create: `tests/v2-shadow-migration-rehearsal.test.ts`

**Interfaces:**
- Consumes: four verified runner results, source pre/post identities, process/runtime versions, performance/resource observations, test summaries, and review dispositions.
- Produces: `V2ShadowMigrationEvidenceV1`, `buildV2ShadowMigrationEvidence(input)`, `writeV2ShadowMigrationEvidence(input)`, and a command-line rehearsal exit status.

- [ ] **Step 1: Write evidence and rehearsal RED tests.**

Generate three empty isolated target stores/projection roots/compatibility roots for clean runs, then rerun the third target for the no-op. Assert identical migration/package/import/projection/parity/compatibility checksums across clean runs, no-op deduplication, byte-identical source identity, bounded metrics, no plaintext/absolute paths, canonical evidence checksum, and nonzero exit for every red gate:

```ts
test("three clean runs are identical and the fourth run is a verified no-op", async (t) => {
  const fixture = await rehearsalFixture(t);
  const rehearsal = await fixture.runFourPasses();
  assert.deepEqual(
    rehearsal.cleanRuns.map((run) => run.determinismVector),
    [rehearsal.cleanRuns[0]!.determinismVector, rehearsal.cleanRuns[0]!.determinismVector, rehearsal.cleanRuns[0]!.determinismVector],
  );
  assert.equal(rehearsal.noOp.deduplicated, true);
  assert.deepEqual(rehearsal.sourceBefore, rehearsal.sourceAfter);
  assert.equal(rehearsal.evidence.gates.every((gate) => gate.status === "passed"), true);
  assert.match(rehearsal.evidence.evidenceChecksum, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run rehearsal tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-rehearsal.test.js
```

Expected: compilation fails because evidence builder and rehearsal script are absent.

- [ ] **Step 3: Build a canonical redacted evidence document.**

Use this top-level shape and reject unknown fields:

```ts
export interface DeterministicRunEvidenceV1 {
  readonly runOrdinal: 1 | 2 | 3 | 4;
  readonly deduplicated: boolean;
  readonly determinismVector: Readonly<{
    migrationIdentity: string;
    packageChecksum: string;
    importedEventsChecksum: string;
    transitionChainChecksum: string;
    v2ProjectionManifestChecksum: string;
    parityReportChecksum: string;
    compatibilityArtifactSetChecksum: string;
    sourceRecordCount: number;
    importedEventCount: number;
    compatibilityAcknowledgementCount: number;
  }>;
}

export interface V2ShadowMigrationEvidenceV1 {
  readonly schemaVersion: 1;
  readonly commit: string;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly operatingSystem: string;
  readonly projectStoreSchemaVersion: number;
  readonly buildIdentityHash: string;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly configurationChecksum: string;
  readonly policyChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly sourceBeforeChecksum: string;
  readonly sourceAfterChecksum: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly deterministicRuns: readonly DeterministicRunEvidenceV1[];
  readonly noOpRun: DeterministicRunEvidenceV1;
  readonly parity: Readonly<{ equal: number; expected: number; blocking: number; ruleIds: readonly string[] }>;
  readonly compatibility: Readonly<{ acknowledged: number; terminalPosition: string; artifactSetChecksum: string }>;
  readonly performance: Readonly<{ elapsedMs: number; throughputPerSecond: number; peakRssBytes: number; maxBatchEvents: number; maxBatchBytes: number; retries: number; projectionLag: number; materializationLag: number }>;
  readonly tests: readonly Readonly<{ name: string; passed: number; failed: number; skipped: number }>[];
  readonly reviews: readonly Readonly<{ kind: "specification" | "implementation-quality" | "security"; disposition: "approved" | "changes-required"; evidenceDigest: string }>[];
  readonly gates: readonly Readonly<{ name: string; status: "passed" | "failed"; evidenceDigest: string }>[];
  readonly createdAt: string;
  readonly evidenceChecksum: string;
}
```

`DeterministicRunEvidenceV1.determinismVector` includes migration/package/imported-event/ledger-transition/projection/parity/compatibility identities, counts, and hashes. It excludes observed elapsed/RSS metrics and the aggregate evidence document's `createdAt`; those observations remain reported separately and bounded by gates.

Root paths, artifact relative paths, payload values, rule rationale, approver identity, error text, and environment secrets are forbidden. The builder recursively scans key names and string values for drive/UNC/POSIX paths, PEM/API-key patterns, source plaintext sentinels, and unauthorized fields before calculating `evidenceChecksum` with domain `project-memory/v2-shadow-migration-evidence/v1`.

- [ ] **Step 4: Add the explicit rehearsal command.**

The script accepts only named flags and refuses defaults for safety:

```text
node scripts/run-v2-shadow-migration-rehearsal.js \
  --config <absolute canonical config.json> \
  --source-root <verified copy root> \
  --package-root <isolated package root> \
  --work-root <empty isolated run root> \
  --evidence-output <new evidence.json>
```

It requires `NODE_ENV=production-rehearsal`, a clean Git worktree, exact commit/build identity, an output path outside source/live roots, three newly created empty run directories, and an explicit configuration containing the live authority paths used only for alias rejection. It never acquires a live copy, changes rollout mode, opens a public server, or deploys.

Before the four passes, the script performs a preparation-only source/package/V1-baseline calculation and verifies that the supplied rollout revision template's build/configuration fields match. For each isolated target it creates the same immutable revision through the internal `RolloutControlPlane.createRevision` using the prepared `migrationIdentityHash` and `v1BaselineChecksum`, then confirms state remains `off`. This revision creation occurs only inside each empty rehearsal target; the script never writes a live/user rollout store.

Write evidence through a same-directory temporary file, fsync, reopen/validate/checksum, and rename. Refuse overwrite; a second command requires a new output path. Print only the evidence checksum, migration identity, gate summary, and output path hash.

- [ ] **Step 5: Run deterministic rehearsal tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-rehearsal.test.js dist-test/tests/v2-shadow-migration-runner.test.js
npm run typecheck
```

Expected: all tests pass; the three-run vector is byte-identical; the fourth run adds no semantic row/event/artifact; every red fixture exits nonzero without leaking plaintext.

- [ ] **Step 6: Commit rehearsal evidence tooling.**

```powershell
git add src/orchestrator/migration/v2-shadow-migration-evidence.ts scripts/run-v2-shadow-migration-rehearsal.js tests/v2-shadow-migration-rehearsal.test.ts
git commit -m "test: add V2 shadow migration rehearsal"
```

### Task 13: Register schema 7 and seal the focused CI/release contract

**Files:**
- Modify: `src/orchestrator/storage/migrations/registry.ts:1-20`
- Modify: `tests/migration-registry.test.ts:100-190`
- Modify: `tests/project-store-bootstrap.test.ts:230-270,800-930`
- Modify: `tests/project-store-upgrade.test.ts:1140-1210,2400-2730`
- Modify: `tests/project-store-upgrade-phase-runner.test.ts:270-305`
- Modify: `scripts/smoke-worker.js:520-650`
- Modify: `tests/ci-lifecycle-gates.test.ts:1-150,420-460,730-840`
- Modify: `package.json:24-34`
- Modify: `.github/workflows/ci.yml:45-65`

**Interfaces:**
- Consumes: every focused test and source path from Tasks 1 through 12.
- Produces: current project-store schema 7, `npm run test:v2-shadow-migration`, `npm run rehearse:v2-shadow-migration`, and a CI step that preserves V1-only routing.

- [ ] **Step 1: Update registry/upgrade/CI contract tests first.**

Change expectations to migration names `[event-core, session-lifecycle, qualified-checkpoint-coverage, session-end-effective-state, session-end-final-checkpoint-transition, v2-rollout-control-plane, v2-shadow-migration]`, current schema `7`, and upgrade results ending in `7`. Preserve all frozen migration 1..6 names/checksums and append only migration 7.

In `ci-lifecycle-gates.test.ts`, require exact scripts:

```json
"test:v2-shadow-migration": "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-contracts.test.js dist-test/tests/v1-source-copy.test.js dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-migration-repository.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v2-shadow-migration-rehearsal.test.js dist-test/tests/ci-lifecycle-gates.test.js",
"rehearse:v2-shadow-migration": "npm run build && node scripts/run-v2-shadow-migration-rehearsal.js"
```

Require a release-gates step named `Run V2 shadow migration gate` with command `npm run test:v2-shadow-migration`, immediately after the rollout-control-plane gate and before build-artifact tests. Keep `Protect Version 1 production routing` byte-for-byte unchanged.

- [ ] **Step 2: Run CI-contract and migration tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/ci-lifecycle-gates.test.js
```

Expected: tests fail because registry, smoke, package scripts, CI, and sealed source list still represent schema 6/Slice 1.

- [ ] **Step 3: Register migration 0007 without editing frozen migrations.**

Import `v2ShadowMigration` after 0006, append it to `PROJECT_STORE_MIGRATIONS`, and set `CURRENT_PROJECT_STORE_SCHEMA_VERSION = 7`. Update shared bootstrap/upgrade expected arrays from `[1,2,3,4,5,6]` to `[1,2,3,4,5,6,7]` or from `[2,3,4,5,6]` to `[2,3,4,5,6,7]` as applicable. Update bundled smoke to require schema 7 and its exact migration name/checksum while keeping the disabled lifecycle probe and V1 routing assertions.

- [ ] **Step 4: Update the exact internal-only source allowance and focused gate.**

Extend the sorted sealed source list with only these new/modified internal paths plus the pre-existing seven Slice-1 paths:

```ts
const APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF = Object.freeze([
  "src/orchestrator/identity/git-workspace.resolver.ts",
  "src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts",
  "src/orchestrator/migration/v1-source-copy.ts",
  "src/orchestrator/migration/v2-imported-event-reader.ts",
  "src/orchestrator/migration/v2-migration-package.ts",
  "src/orchestrator/migration/v2-shadow-importer.ts",
  "src/orchestrator/migration/v2-shadow-migration-evidence.ts",
  "src/orchestrator/migration/v2-shadow-migration-runner.ts",
  "src/orchestrator/migration/v2-shadow-migration.contracts.ts",
  "src/orchestrator/migration/v2-shadow-projection.ts",
  "src/orchestrator/parity/v2-expected-difference.ts",
  "src/orchestrator/parity/v2-snapshot-parity.ts",
  "src/orchestrator/projections/checksum.ts",
  "src/orchestrator/projections/contracts.ts",
  "src/orchestrator/projections/event-reader.ts",
  "src/orchestrator/projections/folds.ts",
  "src/orchestrator/projections/integrity.ts",
  "src/orchestrator/projections/manifest.ts",
  "src/orchestrator/projections/source-event-codec.ts",
  "src/orchestrator/rollout/rollout-cohort.ts",
  "src/orchestrator/rollout/rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts",
  "src/orchestrator/storage/migrations/registry.ts",
  "src/orchestrator/storage/rollout-control-plane.repository.ts",
  "src/orchestrator/storage/session-end.repository.ts",
  "src/orchestrator/storage/v2-shadow-migration.repository.ts",
]);
```

The test must still scan every production entry surface and reject imports of migration/parity/materialization modules, public `memory_(retrieval|projection|migration|parity)` tools, environment-activated V2 routing, and changes to protected V1 paths. Add checks that CI uploads redacted evidence JSON only, with `retention-days: 14`, and excludes source copies, packages, SQLite files/sidecars, compatibility bytes, secrets, and Markdown payloads.

- [ ] **Step 5: Implement package/CI/smoke updates and run focused release verification.**

Run:

```powershell
npm run check:runtime
npm run test:v2-shadow-migration
npm run test:rollout-control-plane
npm run test:subproject-3
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
```

Expected: every command exits 0; schema 7 is recognized; CI order is exact; public/production entry paths remain V1-only; built worker upgrades through 7 and keeps lifecycle V2 disabled.

- [ ] **Step 6: Commit the sealed release contract.**

```powershell
git add src/orchestrator/storage/migrations/registry.ts tests/migration-registry.test.ts tests/project-store-bootstrap.test.ts tests/project-store-upgrade.test.ts tests/project-store-upgrade-phase-runner.test.ts scripts/smoke-worker.js tests/ci-lifecycle-gates.test.ts package.json .github/workflows/ci.yml
git commit -m "test: seal V2 shadow migration release gate"
```

### Task 14: Run the production-shaped rehearsal and complete independent release reviews

**Files:**
- Verify: every file in Tasks 1 through 13
- Verify: `docs/superpowers/specs/2026-09-09-v2-shadow-migration-and-compatibility-parity-design.md`
- Generate outside Git: one source-authorized `v2-shadow-migration-evidence.json`

**Interfaces:**
- Consumes: exact committed branch, authorized production-shaped copy/config, all focused/full gates, and three independent reviewers.
- Produces: a green immutable Slice-2 evidence checksum and review dispositions; no runtime activation or deployment.

- [ ] **Step 1: Run all deterministic code gates from a clean worktree.**

Run from `C:\Users\Server\.codex\worktrees\subproject-3-projections`:

```powershell
npm run check:runtime
npm run typecheck
npm run test:build
npm run test:v2-shadow-migration
npm run test:rollout-control-plane
npm run test:subproject-3
npm test
npm run build
npm run test:build-artifacts
git diff --check
git status --short --branch
```

Expected: every command exits 0; full suite reports zero failures; only documented expected platform skips remain; worktree is clean after task commits.

- [ ] **Step 2: Audit V1 isolation and sensitive-artifact boundaries.**

Run:

```powershell
rg -n "orchestrator/(migration|parity)|v2-shadow-compatibility|registerTool\(|memory_(retrieval|projection|migration|parity)" src/app.ts src/index.ts src/controllers src/schemas src/services src/workers src/orchestrator/runtime
git diff --name-only 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services
git diff --name-only 68e77fa10165c99243ded1e8c1c80d1e0f7da92f -- src
rg -n "sourceRoot|packageRoot|contentUtf8|payloadJson|BEGIN (RSA|OPENSSH)|api[_-]?key|secret" src/orchestrator/migration src/orchestrator/parity src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts
```

Expected: production entry search has no import/registration; protected V1 diff is empty; source diff equals the sealed list; diagnostics/report serializers do not emit sensitive values.

- [ ] **Step 3: Run the authorized production-shaped rehearsal.**

Set `NODE_ENV=production-rehearsal` and run the command from Task 12 with explicit canonical paths supplied through the approved config. Expected exit is 0 and printed gates all pass. Independently hash the source manifest/database/sidecars/artifacts before and after and compare them to evidence. Confirm:

- three clean determinism vectors are identical;
- fourth run is `deduplicated: true` with no new semantic event/ledger/artifact;
- blocking parity count is zero;
- every expected rule is exact, current, revision/migration-bound, and reviewed;
- compatibility acknowledged count equals declared artifact count and terminal position/hash is exact;
- elapsed time, RSS, batch use, retries, projection lag, and materialization lag stay inside the sealed policy; and
- evidence contains no plaintext, secret, absolute path, SQLite/package bytes, or compatibility content.

- [ ] **Step 4: Request specification review.**

Use a fresh reviewer to compare every safety invariant, architecture subsection, error class, security constraint, test requirement, and release gate in the approved spec to implementation plus evidence. Resolve every Critical or Important finding with a new failing regression test before changing code. Rerun Steps 1 through 3 after every fix. Record the final approved disposition digest in a newly generated evidence file; never rewrite the prior evidence file.

- [ ] **Step 5: Request implementation-quality review.**

After specification review is approved, use a fresh reviewer to inspect strict own-data decoding, canonical hashes, UUID/identity compatibility, bounded streaming, descriptor-before-value access, transaction/rollback behavior, immutable triggers, deterministic IDs/timestamps, unknown-outcome reconciliation, path/file identity, source re-verification, projection authority, report redaction, and no-op idempotence. Resolve every Critical or Important finding through TDD, rerun Steps 1 through 3, and record the approved digest in another new evidence file.

- [ ] **Step 6: Request security review.**

After quality review is approved, use a fresh security reviewer to attempt source/live aliasing, symlink/junction/reparse replacement, package/manifest/ledger/event/projection/report/artifact tamper, path traversal/case collision, expected-rule bypass, plaintext/secret leakage, resource exhaustion, replay/duplicate/lost-event attacks, and public routing activation. No unresolved Critical or Important finding is allowed. Fix through TDD and rerun all gates/rehearsal when needed.

- [ ] **Step 7: Record Slice-2 completion without activating V2.**

Update this plan's execution-status section with task commit hashes, focused/full totals, evidence checksum, exact source-copy authorization reference digest, and three review disposition digests. Commit only the documentation update. Keep rollout state `off`, do not create live shadow/canary transitions, do not deploy, and state explicitly that the next authorized work is Slice 3 privacy, retention, and global scope.

```powershell
git add docs/superpowers/plans/2026-09-09-v2-shadow-migration-and-compatibility-parity.md
git commit -m "docs: record V2 shadow migration evidence"
```
