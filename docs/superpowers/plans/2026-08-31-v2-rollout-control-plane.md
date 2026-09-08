# V2 Rollout Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a durable, audited V2 rollout control plane with deterministic project/workspace cohorts while every production request continues to use V1.

**Architecture:** Schema version 6 adds immutable rollout revisions, append-only approval transitions, and one guarded mutable state row. An internal rollout domain validates hostile inputs and calculates 10,000 deterministic cohort buckets. Its default-deny promotion gate allows only V1 off and V1 shadow state, and production MCP composition remains unchanged.

**Tech Stack:** TypeScript, Node.js 24.16, node:sqlite through the current SqliteConnection abstraction, SQLite STRICT tables and triggers, node:test, current migration runner, and sealed CI contract tests.

---

## Scope

### Execution status — 2026-09-08

- [x] Task 1: implemented in `beb9473` and `56eec64`; spec and quality reviews approved; focused tests 14/14.
- [x] Task 2: committed in `1441b7c` and hardened in `50308d2`; migration gate 236/236, final focused gate 66/66, and spec/quality reviews approved.
- [x] Task 3: committed in `27100d1`; focused gate 49/49, typecheck, spec review, and quality review approved.
- [x] Task 4: committed in `153990b`; focused gate 84/84, typecheck, spec review, and quality review approved.
- [ ] Task 5: sealed CI contract.
- [ ] Task 6: release verification and final reviews.

Task 1 clarification: every integer basis-point value from 0 through 10,000 is valid; the original rejection example using 101 was a typo. Canary activation thresholds are constrained separately in Task 4.

Task 4 correctness clarification: new immutable child IDs must not reshuffle the cohort. Keep the Task 1 hash helper unchanged; resolve the persisted lineage root in the internal service and use that actual root for bucket assignment while comparing against the requested child's threshold. This uses existing parent links and adds no schema fields or public routing.

This plan implements only delivery slice 1 from the approved V2 rollout specification:

- durable revision, approval, transition, state, and redacted evidence-reference records;
- deterministic project/workspace cohort selection;
- default denial of every V2-serving state;
- internal SQLite repository and service;
- schema, upgrade, smoke, package, and CI proof changes.

It does not add an MCP tool, modify src/app.ts, wire a V2 runtime, ingest shadow events, migrate legacy data, implement privacy/retention, back up or restore data, activate a canary, or deploy. Those concerns require their own approved plans.

## File structure

| Path | Responsibility |
| --- | --- |
| src/orchestrator/rollout/rollout-cohort.ts | Exact revision snapshot validation and stable cohort selection. |
| src/orchestrator/rollout/rollout-control-plane.ts | Modes, transition graph, deny gate, and service facade. |
| src/orchestrator/storage/rollout-control-plane.repository.ts | One connection-bound BEGIN IMMEDIATE transaction and SQLite decoders. |
| src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts | Strict tables, indexes, initial off state, and immutability guards. |
| src/orchestrator/storage/migrations/registry.ts | Registers schema 6. |
| tests/rollout-control-plane.test.ts | Real SQLite cohort, schema, repository, state-machine, and tamper tests. |
| tests/migration-registry.test.ts | Pins version 6, checksum, prefix, and schema-fingerprint behavior. |
| tests/project-store-bootstrap.test.ts | Checks a new store records migrations 1 through 6. |
| tests/project-store-upgrade.test.ts | Checks an old store upgrades atomically through version 6. |
| tests/project-store-upgrade-phase-runner.test.ts | Checks the upgrade worker reports version 6. |
| tests/session-end-effective-state-migration.test.ts | Updates only the shared current-registry assertion. |
| tests/qualified-checkpoint-migration.test.ts | Updates only the shared current-registry assertion. |
| tests/ci-lifecycle-gates.test.ts | Narrows the source allowlist and proves the rollout layer is not publicly wired. |
| scripts/smoke-worker.js | Expects schema 6 and retains the disabled lifecycle probe. |
| package.json | Adds a focused rollout control-plane test command. |
| .github/workflows/ci.yml | Executes that focused gate while retaining the V1 path guard. |

### Task 1: Define strict rollout revisions and deterministic cohorts

**Files:**
- Create: src/orchestrator/rollout/rollout-cohort.ts
- Create: tests/rollout-control-plane.test.ts

- [ ] **Step 1: Write failing cohort tests.**

Create the first describe block in tests/rollout-control-plane.test.ts. Use fixed lower-case UUIDs and lower-case 64-character hashes. Prove that the same revision/project/workspace yields the same bucket, that a larger basis-point threshold never deselects an already selected cohort, and that invalid prototypes, malformed hashes, invalid percentages, and a foreign project reject.

~~~ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  cohortBucket,
  decodeRolloutRevision,
  isSelectedCanaryCohort,
  RolloutControlPlaneError,
} from "../src/orchestrator/rollout/rollout-cohort.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REVISION = Object.freeze({
  projectId: PROJECT_ID,
  revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parentRevisionId: null,
  buildIdentityHash: "a".repeat(64),
  migrationIdentityHash: "b".repeat(64),
  configurationChecksum: "c".repeat(64),
  v1BaselineChecksum: "d".repeat(64),
  cohortAlgorithmVersion: 1,
  cohortSalt: "e".repeat(64),
  cohortBasisPoints: 500,
  createdAt: "2026-08-31T00:00:00.000Z",
});

describe("V2 rollout cohorts", () => {
  it("is stable and monotonic", () => {
    const revision = decodeRolloutRevision(REVISION);
    const binding = { projectId: PROJECT_ID, workspaceId: "workspace-a" };
    const bucket = cohortBucket(revision, binding);
    assert.equal(bucket, cohortBucket(revision, binding));
    assert.ok(bucket >= 0 && bucket < 10_000);

    const onePercent = isSelectedCanaryCohort(
      decodeRolloutRevision({ ...REVISION, cohortBasisPoints: 100 }),
      binding,
    );
    assert.equal(onePercent && !isSelectedCanaryCohort(revision, binding), false);
  });

  it("rejects hostile revisions and foreign scope", () => {
    assert.throws(() => decodeRolloutRevision(Object.create(REVISION)), /ROLLOUT_INPUT_INVALID/);
    assert.throws(
      () => decodeRolloutRevision({ ...REVISION, cohortBasisPoints: 10001 }),
      /ROLLOUT_INPUT_INVALID/,
    );
    assert.throws(
      () => cohortBucket(decodeRolloutRevision(REVISION), {
        projectId: "22222222-2222-4222-8222-222222222222",
        workspaceId: "workspace-a",
      }),
      (error: unknown) => error instanceof RolloutControlPlaneError
        && error.code === "ROLLOUT_SCOPE_DENIED",
    );
  });
});
~~~

- [ ] **Step 2: Run the test and verify RED.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js
~~~

Expected: the build fails because rollout-cohort.ts does not exist.

- [ ] **Step 3: Implement strict snapshots and cohort calculation.**

Create src/orchestrator/rollout/rollout-cohort.ts with this public surface:

~~~ts
import { createHash } from "node:crypto";

export type RolloutMode =
  | "off"
  | "shadow"
  | "canary"
  | "primary"
  | "rollback-pending"
  | "read-only-recovery";

export interface RolloutRevision {
  readonly projectId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly buildIdentityHash: string;
  readonly migrationIdentityHash: string;
  readonly configurationChecksum: string;
  readonly v1BaselineChecksum: string;
  readonly cohortAlgorithmVersion: 1;
  readonly cohortSalt: string;
  readonly cohortBasisPoints: number;
  readonly createdAt: string;
}

export interface RolloutCohortBinding {
  readonly projectId: string;
  readonly workspaceId: string;
}

export class RolloutControlPlaneError extends Error {
  constructor(
    readonly code:
      | "ROLLOUT_INPUT_INVALID"
      | "ROLLOUT_SCOPE_DENIED"
      | "ROLLOUT_STATE_CONFLICT"
      | "ROLLOUT_TRANSITION_DENIED"
      | "ROLLOUT_V2_ROUTING_DISABLED"
      | "ROLLOUT_INTEGRITY_FAILURE",
  ) {
    super(code);
    this.name = "RolloutControlPlaneError";
  }
}

export function decodeRolloutRevision(input: unknown): RolloutRevision;
export function cohortBucket(revision: RolloutRevision, binding: RolloutCohortBinding): number;
export function isSelectedCanaryCohort(
  revision: RolloutRevision,
  binding: RolloutCohortBinding,
): boolean;
~~~

Reject inherited keys, accessors, symbols, non-enumerable properties, arrays, invalid timestamps, invalid UUID/hash forms, any algorithm other than 1, and a basis-point value outside 0 through 10,000. Deep-freeze each decoded value.

Calculate a bucket by SHA-256 over these line-feed delimited UTF-8 values, read the first unsigned 32-bit big-endian integer, then take modulo 10,000:

~~~ts
[
  "project-memory/v2-rollout-cohort/v1",
  revision.revisionId,
  String(revision.cohortAlgorithmVersion),
  revision.cohortSalt,
  binding.projectId,
  binding.workspaceId,
].join("\n")
~~~

Reject a binding with a project ID different from revision.projectId. Never return or log the digest, salt, project ID, or workspace ID.

- [ ] **Step 4: Run focused green verification.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js
npm run typecheck
~~~

Expected: all cohort tests pass and typecheck exits 0.

- [ ] **Step 5: Commit the cohort contract.**

~~~powershell
git add src/orchestrator/rollout/rollout-cohort.ts tests/rollout-control-plane.test.ts
git commit -m "feat: add deterministic rollout cohorts"
~~~

### Task 2: Add schema 6 for immutable rollout records

**Files:**
- Create: src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts
- Modify: src/orchestrator/storage/migrations/registry.ts
- Modify: tests/rollout-control-plane.test.ts
- Modify: tests/migration-registry.test.ts
- Modify: tests/project-store-bootstrap.test.ts
- Modify: tests/project-store-upgrade.test.ts
- Modify: tests/project-store-upgrade-phase-runner.test.ts
- Modify: tests/session-end-effective-state-migration.test.ts
- Modify: tests/qualified-checkpoint-migration.test.ts
- Modify: scripts/smoke-worker.js

- [ ] **Step 1: Write failing schema tests.**

Append schema-6 tests that create a real current store with applyCurrentProjectStoreSchema and verify:

- schema_migrations is [1, 2, 3, 4, 5, 6] and project_meta.schema_version is 6;
- rollout_revisions, rollout_transitions, and rollout_control_state are STRICT;
- the singleton state is off with null active revision, generation 0, and null transition;
- direct UPDATE or DELETE of a revision/transition aborts with ROLLOUT_IMMUTABLE; and
- direct state UPDATE without its matching transition aborts with ROLLOUT_STATE_TRANSITION_INVALID.

Update only shared current-registry expectations from version 5 to 6 in every file listed above. Retain historical test registries deliberately frozen at versions 1, 2, or 3.

- [ ] **Step 2: Run the schema tests and verify RED.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js
~~~

Expected: tests fail for absent schema-6 migration and tables.

- [ ] **Step 3: Implement and register migration 0006.**

Create src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts exporting:

~~~ts
export const v2RolloutControlPlaneMigration: Migration = {
  version: 6,
  name: "v2-rollout-control-plane",
  sql: "...",
};
~~~

The SQL must create exactly these fields:

~~~sql
rollout_revisions(
  project_id, revision_id, parent_revision_id,
  build_identity_hash, migration_identity_hash, configuration_checksum,
  v1_baseline_checksum, cohort_algorithm_version, cohort_salt,
  cohort_basis_points, created_at
)

rollout_transitions(
  project_id, transition_id, revision_id,
  from_mode, to_mode, prior_state_generation, next_state_generation,
  approval_id, approval_nonce_digest, actor_fingerprint, evidence_digest,
  reason_code, recorded_at
)

rollout_control_state(
  singleton, project_id, active_revision_id, mode,
  state_generation, last_transition_id, updated_at
)
~~~

All three tables are STRICT. The immutable revision and transition tables also use WITHOUT ROWID to exclude replacement through hidden row identities. Use composite project/revision and project/transition foreign keys, exact lowercase-hash text and byte-length checks, a mode CHECK containing the six modes from Task 1, basis points constrained to 0 through 10,000, and a unique project/approval ID plus project/approval nonce digest. Insert one off state from project_meta.

Create four immutability triggers that reject UPDATE and DELETE on revisions/transitions with ROLLOUT_IMMUTABLE. Also reject INSERT conflicts across every immutable unique key before SQLite can perform replacement. Create an update trigger on rollout_control_state that permits only generation plus one and requires an existing transition matching project, prior mode, next mode, generation pair, active revision, and last transition ID. Every other state-row mutation aborts with ROLLOUT_STATE_TRANSITION_INVALID.

Register the migration after 0005 and set CURRENT_PROJECT_STORE_SCHEMA_VERSION to 6. Update smoke-worker.js from [1,2,3,4,5] and schemaVersion !== 5 to [1,2,3,4,5,6] and schemaVersion !== 6. Do not remove the disabled lifecycle worker smoke probe.

- [ ] **Step 4: Run green migration and upgrade verification.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/qualified-checkpoint-migration.test.js
npm run typecheck
~~~

Expected: new stores are schema 6, old stores upgrade atomically through version 6, and frozen historical migration checksums are unchanged.

- [ ] **Step 5: Commit schema 6.**

~~~powershell
git add src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts src/orchestrator/storage/migrations/registry.ts tests/rollout-control-plane.test.ts tests/migration-registry.test.ts tests/project-store-bootstrap.test.ts tests/project-store-upgrade.test.ts tests/project-store-upgrade-phase-runner.test.ts tests/session-end-effective-state-migration.test.ts tests/qualified-checkpoint-migration.test.ts scripts/smoke-worker.js
git commit -m "feat: add durable V2 rollout control schema"
~~~

### Task 3: Implement a connection-bound SQLite repository

**Files:**
- Create: src/orchestrator/storage/rollout-control-plane.repository.ts
- Modify: tests/rollout-control-plane.test.ts
- Reference: src/orchestrator/storage/lifecycle-approval.repository.ts
- Reference: src/orchestrator/lifecycle/lifecycle-operational.store.ts

- [ ] **Step 1: Write failing repository tests.**

Use a real schema-6 connection. Assert that one repository transaction reads off state, inserts a revision, appends a transition, conditionally advances state, and returns shadow generation 1. Add a stale compare-and-set regression that confirms rollback leaves no partial revision or transition.

~~~ts
const repository = new SqliteRolloutControlPlaneRepository(connection);
const state = repository.transact(PROJECT_ID, (transaction) => {
  transaction.insertRevision(REVISION);
  transaction.appendTransition(TRANSITION);
  transaction.compareAndSetState({
    expectedMode: "off",
    expectedGeneration: 0n,
    revisionId: REVISION.revisionId,
    nextMode: "shadow",
    nextGeneration: 1n,
    transitionId: TRANSITION.transitionId,
    updatedAt: TRANSITION.recordedAt,
  });
  return transaction.readState();
});

assert.equal(state.mode, "shadow");
assert.equal(state.stateGeneration, 1n);
~~~

- [ ] **Step 2: Run the repository test and verify RED.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js
~~~

Expected: the build fails because SqliteRolloutControlPlaneRepository does not exist.

- [ ] **Step 3: Implement repository transactions and exact decoding.**

Create src/orchestrator/storage/rollout-control-plane.repository.ts with:

~~~ts
export interface RolloutControlState {
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly mode: RolloutMode;
  readonly stateGeneration: bigint;
  readonly lastTransitionId: string | null;
  readonly updatedAt: string;
}

export interface RolloutControlPlaneTransaction {
  readState(): RolloutControlState;
  readRevision(revisionId: string): RolloutRevision | null;
  insertRevision(revision: RolloutRevision): void;
  appendTransition(transition: RolloutTransition): void;
  compareAndSetState(input: RolloutStateCasInput): void;
}

export interface RolloutTransition {
  readonly projectId: string;
  readonly transitionId: string;
  readonly revisionId: string | null;
  readonly fromMode: RolloutMode;
  readonly toMode: RolloutMode;
  readonly priorStateGeneration: bigint;
  readonly nextStateGeneration: bigint;
  readonly approvalId: string;
  readonly approvalNonceDigest: string;
  readonly actorFingerprint: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
  readonly recordedAt: string;
}

export interface RolloutStateCasInput {
  readonly expectedMode: RolloutMode;
  readonly expectedGeneration: bigint;
  readonly revisionId: string | null;
  readonly nextMode: RolloutMode;
  readonly nextGeneration: bigint;
  readonly transitionId: string;
  readonly updatedAt: string;
}

export class SqliteRolloutControlPlaneRepository {
  constructor(private readonly connection: SqliteConnection) {}
  transact<T>(
    projectId: string,
    callback: (transaction: RolloutControlPlaneTransaction) => T,
  ): T;
}
~~~

transact executes BEGIN IMMEDIATE, invokes a synchronous callback, commits on success, and rolls back while preserving the original error on failure. Every SQLite row is decoded through exact own enumerable data properties and deep-frozen. No raw approval reference or raw actor identity is written.

compareAndSetState must require exactly one changed row and use all predicates below:

~~~sql
WHERE singleton = 1
  AND project_id = $projectId
  AND mode = $expectedMode
  AND state_generation = $expectedGeneration
~~~

appendTransition must execute before compareAndSetState so the schema trigger verifies the linked audit transition. Map duplicate approval/nonce and stale CAS failures to ROLLOUT_STATE_CONFLICT. Map malformed rows and unexpected change counts to ROLLOUT_INTEGRITY_FAILURE.

- [ ] **Step 4: Run repository green verification.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js
npm run typecheck
git diff --check
~~~

Expected: the stale regression leaves no partial state, typecheck exits 0, and git diff --check has no output.

- [ ] **Step 5: Commit the repository.**

~~~powershell
git add src/orchestrator/storage/rollout-control-plane.repository.ts tests/rollout-control-plane.test.ts
git commit -m "feat: persist rollout control transitions"
~~~

### Task 4: Add the default-deny rollout state machine

**Files:**
- Create: src/orchestrator/rollout/rollout-control-plane.ts
- Modify: tests/rollout-control-plane.test.ts
- Reference: src/orchestrator/rollout/rollout-cohort.ts
- Reference: src/orchestrator/storage/rollout-control-plane.repository.ts

- [ ] **Step 1: Write failing state-machine tests.**

Use a real repository and verify:

- createRevision persists an immutable revision and rejects an invalid parent;
- a child retains its parent's cohort salt and algorithm, and lineage membership never drops a previously selected workspace when the percentage grows through children and grandchildren;
- cohort membership rejects missing, cyclic, foreign, malformed, or inconsistent parent chains without changing durable state;
- a unique approved off-to-shadow transition succeeds;
- stale generation, replayed approval ID, replayed approval nonce, and an invalid graph edge fail closed;
- shadow-to-canary, canary-to-primary, rollback-pending, and read-only-recovery activation throw ROLLOUT_V2_ROUTING_DISABLED; and
- durable state remains off after a rejected V2-serving transition.

Use this approved transition shape:

~~~ts
const APPROVAL = Object.freeze({
  approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  nonceDigest: "1".repeat(64),
  actorFingerprint: "2".repeat(64),
  evidenceDigest: "3".repeat(64),
  reasonCode: "approved-shadow",
  recordedAt: "2026-08-31T00:01:00.000Z",
});

const control = new RolloutControlPlane(repository);
control.createRevision(REVISION);
const shadow = control.transition({
  projectId: PROJECT_ID,
  revisionId: REVISION.revisionId,
  expectedMode: "off",
  expectedGeneration: 0n,
  nextMode: "shadow",
  approval: APPROVAL,
});
assert.equal(shadow.mode, "shadow");
assert.equal(shadow.stateGeneration, 1n);
~~~

- [ ] **Step 2: Run state-machine tests and verify RED.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js
~~~

Expected: the build fails because RolloutControlPlane does not exist.

- [ ] **Step 3: Implement the state graph and deny gate.**

Create src/orchestrator/rollout/rollout-control-plane.ts with these contracts:

~~~ts
import { randomUUID } from "node:crypto";

export interface RolloutApproval {
  readonly approvalId: string;
  readonly nonceDigest: string;
  readonly actorFingerprint: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
  readonly recordedAt: string;
}

export interface RolloutTransitionRequest {
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly expectedMode: RolloutMode;
  readonly expectedGeneration: bigint;
  readonly nextMode: RolloutMode;
  readonly approval: RolloutApproval;
}

export interface RolloutPromotionGate {
  assertAllowed(input: Readonly<{
    fromMode: RolloutMode;
    nextMode: RolloutMode;
    revision: RolloutRevision | null;
  }>): void;
}

export const V2_ROUTING_DISABLED_GATE: RolloutPromotionGate = Object.freeze({
  assertAllowed({ nextMode }): void {
    if (nextMode !== "off" && nextMode !== "shadow") {
      throw new RolloutControlPlaneError("ROLLOUT_V2_ROUTING_DISABLED");
    }
  },
});

export class RolloutControlPlane {
  constructor(
    private readonly repository: SqliteRolloutControlPlaneRepository,
    private readonly promotionGate: RolloutPromotionGate = V2_ROUTING_DISABLED_GATE,
  ) {}
  createRevision(input: unknown): RolloutRevision;
  state(projectId: string): RolloutControlState;
  transition(input: unknown): RolloutControlState;
  isSelectedCanaryCohort(input: unknown): boolean;
}
~~~

`isSelectedCanaryCohort` accepts exactly the own enumerable data fields `projectId`, `revisionId`, and `workspaceId`. In one repository transaction it loads the requested revision and iteratively resolves its persisted root. Reject cycles, missing or foreign parents, malformed revisions, salt/algorithm changes, and decreasing thresholds. Compute `cohortBucket(root, { projectId, workspaceId }) < requested.cohortBasisPoints` using the actual immutable root, never a synthetic revision. This is an internal membership calculation, not permission to route traffic. Prove monotonic membership across at least a root, child, and grandchild with unchanged salt and increasing thresholds. Keep the existing standalone helper's formula and signature unchanged.

Use one frozen transition graph:

~~~ts
const NEXT_MODES: Readonly<Record<RolloutMode, readonly RolloutMode[]>> = Object.freeze({
  off: Object.freeze(["shadow", "read-only-recovery"]),
  shadow: Object.freeze(["off", "canary", "read-only-recovery"]),
  canary: Object.freeze(["canary", "primary", "rollback-pending", "read-only-recovery"]),
  primary: Object.freeze(["rollback-pending", "read-only-recovery"]),
  "rollback-pending": Object.freeze(["off", "read-only-recovery"]),
  "read-only-recovery": Object.freeze(["off"]),
});
~~~

Decode exact input before opening a transaction. Within the repository transaction, load current state, verify expected mode/generation, load the named revision, call the promotion gate before appendTransition, then append the transition and perform CAS. Reject canary revisions unless their basis points are 100, 500, 2500, 5000, or 10000. For a same-mode canary change, require a child revision with a strictly larger basis-point value.

createRevision must decode the revision through decodeRolloutRevision, reject a duplicate revision ID, and, when parentRevisionId is non-null, validate that parent's entire lineage in the same project before insert. A child revision must retain the parent cohort algorithm version and salt and must not have fewer basis points than its parent; a canary child must have strictly more basis points than its canary parent.

Construct the record passed to appendTransition with the current generation and the supplied redacted approval values; do not derive an approval ID or nonce:

~~~ts
const transition: RolloutTransition = Object.freeze({
  projectId: request.projectId,
  transitionId: randomUUID(),
  revisionId: request.revisionId,
  fromMode: current.mode,
  toMode: request.nextMode,
  priorStateGeneration: current.stateGeneration,
  nextStateGeneration: current.stateGeneration + 1n,
  approvalId: request.approval.approvalId,
  approvalNonceDigest: request.approval.nonceDigest,
  actorFingerprint: request.approval.actorFingerprint,
  evidenceDigest: request.approval.evidenceDigest,
  reasonCode: request.approval.reasonCode,
  recordedAt: request.approval.recordedAt,
});
~~~

Do not import or modify src/app.ts, src/index.ts, src/controllers, src/schemas, src/services, src/workers, or src/orchestrator/runtime.

- [ ] **Step 4: Run state-machine green verification.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js
npm run typecheck
~~~

Expected: off-to-shadow succeeds; every V2-serving state is denied; a rejected transition changes no durable row.

- [ ] **Step 5: Commit the state machine.**

~~~powershell
git add src/orchestrator/rollout/rollout-control-plane.ts tests/rollout-control-plane.test.ts
git commit -m "feat: add default-deny rollout control plane"
~~~

### Task 5: Seal the control plane without public V2 routing

**Files:**
- Modify: tests/ci-lifecycle-gates.test.ts
- Modify: package.json
- Modify: .github/workflows/ci.yml
- Verify: src/app.ts
- Verify: src/index.ts
- Verify: src/controllers
- Verify: src/schemas
- Verify: src/services
- Verify: src/workers
- Verify: src/orchestrator/runtime

- [ ] **Step 1: Write failing CI-contract tests.**

In tests/ci-lifecycle-gates.test.ts:

1. add rollout-control-plane to REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS;
2. make production entry scans reject imports containing /orchestrator/rollout/;
3. rename APPROVED_SEALED_SOURCE_DIFF to APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF;
4. require its exact sorted contents below; and
5. require a release-gates step named Run V2 rollout control-plane gate with command npm run test:rollout-control-plane.

~~~ts
const APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF = Object.freeze([
  "src/orchestrator/identity/git-workspace.resolver.ts",
  "src/orchestrator/rollout/rollout-cohort.ts",
  "src/orchestrator/rollout/rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/registry.ts",
  "src/orchestrator/storage/rollout-control-plane.repository.ts",
  "src/orchestrator/storage/session-end.repository.ts",
]);
~~~

Add this package command and include rollout-control-plane immediately before ci-lifecycle-gates in test:subproject-3:

~~~json
"test:rollout-control-plane": "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/ci-lifecycle-gates.test.js"
~~~

- [ ] **Step 2: Run CI-contract test and verify RED.**

Run:

~~~powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-lifecycle-gates.test.js
~~~

Expected: it fails because package.json and ci.yml lack the focused rollout gate and the source allowlist is still the old one.

- [ ] **Step 3: Implement the narrow source allowance and focused gate.**

In .github/workflows/ci.yml, leave Protect Version 1 production routing unchanged. Add immediately after it:

~~~yaml
      - name: Run V2 rollout control-plane gate
        run: npm run test:rollout-control-plane
~~~

Keep existing checks that no V2 retrieval/projection MCP tool is registered. Also keep the smoke assertion that a worker opened without lifecycleRuntimeFactory returns LIFECYCLE_V2_DISABLED with zero lifecycle event, deduplication, and workflow effects. No environment variable, public tool, application bootstrap import, or public V2 controller is permitted.

- [ ] **Step 4: Run focused release-contract verification.**

Run:

~~~powershell
npm run check:runtime
npm run test:rollout-control-plane
npm run test:subproject-3
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
~~~

Expected: every command exits 0; schema 6 and the focused gate are recognized; no production entry imports the rollout layer; disabled lifecycle behavior remains intact.

- [ ] **Step 5: Commit the sealed contract.**

~~~powershell
git add tests/ci-lifecycle-gates.test.ts package.json .github/workflows/ci.yml
git commit -m "test: seal V2 rollout control plane"
~~~

### Task 6: Produce release evidence and two-stage review

**Files:**
- Verify: all files in Tasks 1 through 5
- Verify: docs/superpowers/specs/2026-08-31-v2-progressive-canary-production-rollout-design.md

- [ ] **Step 1: Run complete verification.**

Run from C:\Users\Server\.codex\worktrees\subproject-3-projections:

~~~powershell
npm run check:runtime
npm run typecheck
npm run build
npm run test:build-artifacts
npm run test:rollout-control-plane
npm run test:subproject-3
npm test
git diff --check
git status --short --branch
~~~

Expected: every command exits 0; npm test reports zero failures; git diff --check prints nothing; status is clean after task commits.

- [ ] **Step 2: Audit source boundaries.**

Run:

~~~powershell
rg -n "orchestrator/rollout|registerTool\(|memory_(?:retrieval|projection)" src/app.ts src/index.ts src/controllers src/schemas src/services src/workers src/orchestrator/runtime
git diff --name-only 68e77fa10165c99243ded1e8c1c80d1e0f7da92f -- src
git log --oneline --max-count=6
~~~

Expected: no production entry imports the rollout layer or registers a V2 public tool; source differences contain exactly the seven sealed paths; and the log contains the five focused commits.

- [ ] **Step 3: Request spec review, then quality review.**

First use a fresh reviewer to compare every task acceptance condition to the approved V2 rollout specification. Resolve every Critical or Important finding with a failing regression test before implementation adjustment.

Only after that reviewer has no open Critical or Important finding, use a fresh quality reviewer to inspect exact-input/deep-freeze behavior, hash and UUID validation, BEGIN IMMEDIATE/CAS/rollback behavior, immutable triggers, cohort monotonicity, redaction, default denial of V2-serving modes, and continued V1-only MCP composition. Rerun Step 1 after every fix and record final output.

- [ ] **Step 4: Keep active mode off.**

This slice is complete only as a disabled internal control plane. Do not create a shadow revision in a user store, add public routing, or claim V2 production readiness. The next plan must cover shadow migration and compatibility parity before V2 caller traffic.
