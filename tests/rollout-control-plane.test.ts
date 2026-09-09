import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  cohortBucket,
  decodeRolloutRevision,
  isSelectedCanaryCohort,
  RolloutControlPlaneError,
  type RolloutMode,
  type RolloutRevision,
} from "../src/orchestrator/rollout/rollout-cohort.js";
import {
  RolloutControlPlane,
  type RolloutApproval,
  type RolloutPromotionGate,
  type RolloutTransitionRequest,
} from "../src/orchestrator/rollout/rollout-control-plane.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import {
  type RolloutStateCasInput,
  type RolloutTransition,
  SqliteRolloutControlPlaneRepository,
} from "../src/orchestrator/storage/rollout-control-plane.repository.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const VAULT_ID = "33333333-3333-4333-8333-333333333333";
const STORE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-31T00:00:00.000Z";
const APPROVAL: RolloutApproval = Object.freeze({
  approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  nonceDigest: "1".repeat(64),
  actorFingerprint: "2".repeat(64),
  evidenceDigest: "3".repeat(64),
  reasonCode: "approved-shadow",
  recordedAt: "2026-08-31T00:01:00.000Z",
});
const migrationDriver = new NodeSqliteDriver({ DatabaseSync });
const migrationConnections: SqliteConnection[] = [];
const migrationRoots: string[] = [];

interface RolloutRevisionInput {
  projectId: string;
  revisionId: string;
  parentRevisionId: string | null;
  buildIdentityHash: string;
  migrationIdentityHash: string;
  configurationChecksum: string;
  v1BaselineChecksum: string;
  cohortAlgorithmVersion: number;
  cohortSalt: string;
  cohortBasisPoints: number;
  createdAt: string;
}

type RevisionHashField =
  | "build_identity_hash"
  | "migration_identity_hash"
  | "configuration_checksum"
  | "v1_baseline_checksum"
  | "cohort_salt";

type TransitionDigestField = "approval_nonce_digest" | "actor_fingerprint" | "evidence_digest";

const REVISION_INPUT: Readonly<RolloutRevisionInput> = Object.freeze({
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

const BINDING = Object.freeze({
  projectId: PROJECT_ID,
  workspaceId: "workspace-alpha",
});

function inputWith(overrides: Partial<RolloutRevisionInput>): Readonly<RolloutRevisionInput> {
  return Object.freeze({ ...REVISION_INPUT, ...overrides });
}

function assertInputInvalid(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    return error instanceof RolloutControlPlaneError && error.code === "ROLLOUT_INPUT_INVALID";
  });
}

function currentMigrationConnection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "rollout-control-plane-"));
  migrationRoots.push(root);
  const connection = migrationDriver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  migrationConnections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  return connection;
}

function insertRevision(
  connection: SqliteConnection,
  overrides: Partial<Record<RevisionHashField, string>> = {},
): void {
  connection.prepare(`
    INSERT INTO rollout_revisions(
      project_id, revision_id, parent_revision_id,
      build_identity_hash, migration_identity_hash, configuration_checksum,
      v1_baseline_checksum, cohort_algorithm_version, cohort_salt,
      cohort_basis_points, created_at
    ) VALUES (
      $projectId, $revisionId, NULL,
      $buildIdentityHash, $migrationIdentityHash, $configurationChecksum,
      $v1BaselineChecksum, 1, $cohortSalt, 500, $createdAt
    )
  `).run({
    $projectId: PROJECT_ID,
    $revisionId: REVISION_INPUT.revisionId,
    $buildIdentityHash: overrides.build_identity_hash ?? REVISION_INPUT.buildIdentityHash,
    $migrationIdentityHash: overrides.migration_identity_hash ?? REVISION_INPUT.migrationIdentityHash,
    $configurationChecksum: overrides.configuration_checksum ?? REVISION_INPUT.configurationChecksum,
    $v1BaselineChecksum: overrides.v1_baseline_checksum ?? REVISION_INPUT.v1BaselineChecksum,
    $cohortSalt: overrides.cohort_salt ?? REVISION_INPUT.cohortSalt,
    $createdAt: NOW,
  });
}

function insertTransition(
  connection: SqliteConnection,
  overrides: Partial<Record<TransitionDigestField, string>> = {},
): void {
  connection.prepare(`
    INSERT INTO rollout_transitions(
      project_id, transition_id, revision_id,
      from_mode, to_mode, prior_state_generation, next_state_generation,
      approval_id, approval_nonce_digest, actor_fingerprint, evidence_digest,
      reason_code, recorded_at
    ) VALUES (
      $projectId, $transitionId, $revisionId,
      'off', 'shadow', 0, 1,
      $approvalId, $approvalNonceDigest, $actorFingerprint, $evidenceDigest,
      'operator-approved', $recordedAt
    )
  `).run({
    $projectId: PROJECT_ID,
    $transitionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    $revisionId: REVISION_INPUT.revisionId,
    $approvalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    $approvalNonceDigest: overrides.approval_nonce_digest ?? "f".repeat(64),
    $actorFingerprint: overrides.actor_fingerprint ?? "1".repeat(64),
    $evidenceDigest: overrides.evidence_digest ?? "2".repeat(64),
    $recordedAt: NOW,
  });
}

const REPOSITORY_TRANSITION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPOSITORY_APPROVAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPOSITORY_NONCE_DIGEST = "f".repeat(64);

function rolloutTransition(overrides: Partial<RolloutTransition> = {}): RolloutTransition {
  return Object.freeze({
    projectId: PROJECT_ID,
    transitionId: REPOSITORY_TRANSITION_ID,
    revisionId: REVISION_INPUT.revisionId,
    fromMode: "off",
    toMode: "shadow",
    priorStateGeneration: 0n,
    nextStateGeneration: 1n,
    approvalId: REPOSITORY_APPROVAL_ID,
    approvalNonceDigest: REPOSITORY_NONCE_DIGEST,
    actorFingerprint: "1".repeat(64),
    evidenceDigest: "2".repeat(64),
    reasonCode: "operator-approved",
    recordedAt: NOW,
    ...overrides,
  });
}

function rolloutCas(overrides: Partial<RolloutStateCasInput> = {}): RolloutStateCasInput {
  return Object.freeze({
    expectedMode: "off",
    expectedGeneration: 0n,
    revisionId: REVISION_INPUT.revisionId,
    nextMode: "shadow",
    nextGeneration: 1n,
    transitionId: REPOSITORY_TRANSITION_ID,
    updatedAt: NOW,
    ...overrides,
  });
}

function persistShadowState(repository: SqliteRolloutControlPlaneRepository): void {
  repository.transact(PROJECT_ID, (transaction) => {
    transaction.insertRevision(decodeRolloutRevision(REVISION_INPUT));
    transaction.appendTransition(rolloutTransition());
    transaction.compareAndSetState(rolloutCas());
  });
}

function assertRolloutError(code: RolloutControlPlaneError["code"], action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    return error instanceof RolloutControlPlaneError && error.code === code;
  });
}

function approvalWith(overrides: Partial<RolloutApproval> = {}): RolloutApproval {
  return Object.freeze({ ...APPROVAL, ...overrides });
}

function revisionWith(
  revisionId: string,
  parentRevisionId: string | null,
  cohortBasisPoints: number,
  overrides: Partial<RolloutRevisionInput> = {},
): Readonly<RolloutRevisionInput> {
  return inputWith({
    revisionId,
    parentRevisionId,
    cohortBasisPoints,
    createdAt: `2026-08-31T00:00:00.${String(cohortBasisPoints % 1000).padStart(3, "0")}Z`,
    ...overrides,
  });
}

function transitionRequest(
  revisionId: string | null,
  expectedMode: RolloutMode,
  expectedGeneration: bigint,
  nextMode: RolloutMode,
  approval: RolloutApproval = APPROVAL,
): RolloutTransitionRequest {
  return Object.freeze({
    projectId: PROJECT_ID,
    revisionId,
    expectedMode,
    expectedGeneration,
    nextMode,
    approval,
  });
}

function allowAllGate(assertion?: (input: Parameters<RolloutPromotionGate["assertAllowed"]>[0]) => void): RolloutPromotionGate {
  return Object.freeze({
    assertAllowed(input: Parameters<RolloutPromotionGate["assertAllowed"]>[0]): void {
      assertion?.(input);
    },
  });
}

function rawInsertRevision(connection: SqliteConnection, revision: Readonly<RolloutRevisionInput>): void {
  connection.prepare(`
    INSERT INTO rollout_revisions(
      project_id, revision_id, parent_revision_id,
      build_identity_hash, migration_identity_hash, configuration_checksum,
      v1_baseline_checksum, cohort_algorithm_version, cohort_salt,
      cohort_basis_points, created_at
    ) VALUES (
      $projectId, $revisionId, $parentRevisionId,
      $buildIdentityHash, $migrationIdentityHash, $configurationChecksum,
      $v1BaselineChecksum, $cohortAlgorithmVersion, $cohortSalt,
      $cohortBasisPoints, $createdAt
    )
  `).run({
    $projectId: revision.projectId,
    $revisionId: revision.revisionId,
    $parentRevisionId: revision.parentRevisionId,
    $buildIdentityHash: revision.buildIdentityHash,
    $migrationIdentityHash: revision.migrationIdentityHash,
    $configurationChecksum: revision.configurationChecksum,
    $v1BaselineChecksum: revision.v1BaselineChecksum,
    $cohortAlgorithmVersion: revision.cohortAlgorithmVersion,
    $cohortSalt: revision.cohortSalt,
    $cohortBasisPoints: revision.cohortBasisPoints,
    $createdAt: revision.createdAt,
  });
}

afterEach(() => {
  for (const connection of migrationConnections.splice(0)) connection.close();
  for (const root of migrationRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rollout control-plane deterministic cohorts", () => {
  it("decodes and deep-freezes an immutable canonical revision", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);

    assert.deepEqual(revision, REVISION_INPUT);
    assert.equal(Object.isFrozen(revision), true);
  });

  it("assigns the same revision, project, and workspace to the same bucket", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);

    assert.equal(cohortBucket(revision, BINDING), cohortBucket(revision, BINDING));
  });

  it("assigns a bucket from 0 through 9999", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);
    const bucket = cohortBucket(revision, BINDING);

    assert.ok(bucket >= 0);
    assert.ok(bucket <= 9999);
  });

  it("never deselects an already selected cohort when its threshold grows", () => {
    const selectedRevision = decodeRolloutRevision(inputWith({ cohortBasisPoints: 508 }));
    const largerRevision = decodeRolloutRevision(inputWith({ cohortBasisPoints: 509 }));

    assert.equal(cohortBucket(selectedRevision, BINDING), 507);
    assert.equal(isSelectedCanaryCohort(selectedRevision, BINDING), true);
    assert.equal(isSelectedCanaryCohort(largerRevision, BINDING), true);
  });

  it("rejects revisions with inherited fields", () => {
    assertInputInvalid(() => decodeRolloutRevision(Object.create(REVISION_INPUT)));
  });

  it("rejects an unsupported cohort algorithm", () => {
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ cohortAlgorithmVersion: 101 })));
  });

  it("accepts all integer basis-point values from 0 through 10000", () => {
    assert.equal(decodeRolloutRevision(inputWith({ cohortBasisPoints: 0 })).cohortBasisPoints, 0);
    assert.equal(decodeRolloutRevision(inputWith({ cohortBasisPoints: 101 })).cohortBasisPoints, 101);
    assert.equal(decodeRolloutRevision(inputWith({ cohortBasisPoints: 10000 })).cohortBasisPoints, 10000);
  });

  it("rejects invalid basis-point values", () => {
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ cohortBasisPoints: 10001 })));
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ cohortBasisPoints: 100.5 })));
  });

  it("rejects a binding outside the revision project scope", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);
    const foreignBinding = Object.freeze({ ...BINDING, projectId: OTHER_PROJECT_ID });

    assert.throws(
      () => cohortBucket(revision, foreignBinding),
      (error: unknown) => error instanceof RolloutControlPlaneError && error.code === "ROLLOUT_SCOPE_DENIED",
    );
  });

  it("rejects malformed hashes and timestamps", () => {
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ buildIdentityHash: "A".repeat(64) })));
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ createdAt: "2026-08-31T00:00:00Z" })));
  });

  it("rejects arrays, unknown keys, and missing keys", () => {
    assertInputInvalid(() => decodeRolloutRevision([]));
    assertInputInvalid(() => decodeRolloutRevision(Object.freeze({ ...REVISION_INPUT, unexpected: true })));

    const { cohortSalt: _cohortSalt, ...withoutCohortSalt } = REVISION_INPUT;
    assertInputInvalid(() => decodeRolloutRevision(Object.freeze(withoutCohortSalt)));
  });

  it("rejects accessors, symbols, and non-enumerable revision properties", () => {
    const accessorInput = { ...REVISION_INPUT };
    Object.defineProperty(accessorInput, "projectId", {
      enumerable: true,
      get: () => PROJECT_ID,
    });
    assertInputInvalid(() => decodeRolloutRevision(accessorInput));

    const symbolInput = { ...REVISION_INPUT, [Symbol("hostile")]: true };
    assertInputInvalid(() => decodeRolloutRevision(symbolInput));

    const hiddenInput = { ...REVISION_INPUT };
    Object.defineProperty(hiddenInput, "hidden", { value: true, enumerable: false });
    assertInputInvalid(() => decodeRolloutRevision(hiddenInput));
  });

  it("normalizes hostile proxy trap errors to input-invalid", () => {
    const scopeDenied = () => new RolloutControlPlaneError("ROLLOUT_SCOPE_DENIED");
    const hostileRevision = new Proxy(REVISION_INPUT, {
      getPrototypeOf: () => {
        throw scopeDenied();
      },
    });
    const hostileBinding = new Proxy(BINDING, {
      getPrototypeOf: () => {
        throw scopeDenied();
      },
    });

    assertInputInvalid(() => decodeRolloutRevision(hostileRevision));
    assertInputInvalid(() => cohortBucket(decodeRolloutRevision(REVISION_INPUT), hostileBinding));
  });

  it("strictly validates cohort bindings", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);
    const inheritedBinding = Object.create(BINDING) as typeof BINDING;
    assertInputInvalid(() => cohortBucket(revision, inheritedBinding));

    const accessorBinding = { ...BINDING };
    Object.defineProperty(accessorBinding, "workspaceId", {
      enumerable: true,
      get: () => "workspace-alpha",
    });
    assertInputInvalid(() => cohortBucket(revision, accessorBinding));

    assertInputInvalid(() => cohortBucket(revision, Object.freeze({ ...BINDING, workspaceId: "" })));
  });
});

describe("schema-6 rollout control-plane storage", () => {
  it("installs strict immutable rollout records and an initial off control state", () => {
    const connection = currentMigrationConnection();

    assert.deepEqual(
      connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
        .map((row) => Number(row.version)),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(
      connection.prepare("SELECT schema_version FROM project_meta WHERE singleton = 1")
        .get()?.schema_version,
      6n,
    );

    const expectedColumns = new Map<string, readonly string[]>([
      ["rollout_revisions", [
        "project_id", "revision_id", "parent_revision_id",
        "build_identity_hash", "migration_identity_hash", "configuration_checksum",
        "v1_baseline_checksum", "cohort_algorithm_version", "cohort_salt",
        "cohort_basis_points", "created_at",
      ]],
      ["rollout_transitions", [
        "project_id", "transition_id", "revision_id",
        "from_mode", "to_mode", "prior_state_generation", "next_state_generation",
        "approval_id", "approval_nonce_digest", "actor_fingerprint", "evidence_digest",
        "reason_code", "recorded_at",
      ]],
      ["rollout_control_state", [
        "singleton", "project_id", "active_revision_id", "mode",
        "state_generation", "last_transition_id", "updated_at",
      ]],
    ]);
    for (const [table, columns] of expectedColumns) {
      const tableMetadata = connection.prepare("PRAGMA table_list").all()
        .find((row) => String(row.name) === table);
      assert.equal(tableMetadata?.strict, 1n);
      assert.equal(tableMetadata?.wr, table === "rollout_control_state" ? 0n : 1n);
      assert.deepEqual(
        connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)),
        columns,
      );
    }

    const state = connection.prepare(`
      SELECT singleton, project_id, active_revision_id, mode,
        state_generation, last_transition_id
      FROM rollout_control_state WHERE singleton = 1
    `).get();
    assert.equal(state?.singleton, 1n);
    assert.equal(state?.project_id, PROJECT_ID);
    assert.equal(state?.active_revision_id, null);
    assert.equal(state?.mode, "off");
    assert.equal(state?.state_generation, 0n);
    assert.equal(state?.last_transition_id, null);
  });

  it("rejects direct revision and transition rewrites or deletes", () => {
    const connection = currentMigrationConnection();
    insertRevision(connection);
    insertTransition(connection);

    for (const mutation of [
      "UPDATE rollout_revisions SET created_at = '2026-09-01T00:00:00.000Z'",
      "DELETE FROM rollout_revisions",
      "UPDATE rollout_transitions SET reason_code = 'rewritten'",
      "DELETE FROM rollout_transitions",
    ]) {
      assert.throws(() => connection.exec(mutation), /ROLLOUT_IMMUTABLE/);
    }
  });

  for (const field of [
    "build_identity_hash",
    "migration_identity_hash",
    "configuration_checksum",
    "v1_baseline_checksum",
    "cohort_salt",
  ] as const) {
    it(`rejects a revision INSERT with a NUL-suffixed ${field}`, () => {
      const connection = currentMigrationConnection();
      const malformedValue = `${"a".repeat(64)}${String.fromCharCode(0)}suffix`;

      assert.throws(
        () => insertRevision(connection, { [field]: malformedValue }),
        /CHECK constraint failed/,
      );
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 0n);
    });
  }

  for (const field of ["approval_nonce_digest", "actor_fingerprint", "evidence_digest"] as const) {
    it(`rejects a transition INSERT with a NUL-suffixed ${field}`, () => {
      const connection = currentMigrationConnection();
      insertRevision(connection);
      const malformedValue = `${"a".repeat(64)}${String.fromCharCode(0)}suffix`;

      assert.throws(
        () => insertTransition(connection, { [field]: malformedValue }),
        /CHECK constraint failed/,
      );
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);
    });
  }

  it("rejects a state update without its matching appended transition", () => {
    const connection = currentMigrationConnection();

    assert.throws(
      () => connection.exec(`
        UPDATE rollout_control_state
        SET state_generation = 1
        WHERE singleton = 1
      `),
      /ROLLOUT_STATE_TRANSITION_INVALID/,
    );
  });

  it("rejects replacement inserts that reuse an immutable revision key", () => {
    const connection = currentMigrationConnection();
    insertRevision(connection);

    assert.throws(() => connection.exec(`
      INSERT OR REPLACE INTO rollout_revisions
      SELECT project_id, revision_id, parent_revision_id,
        build_identity_hash, migration_identity_hash, configuration_checksum,
        v1_baseline_checksum, cohort_algorithm_version, cohort_salt,
        cohort_basis_points, '2026-09-01T00:00:00.000Z'
      FROM rollout_revisions
    `), /ROLLOUT_IMMUTABLE/);

    assert.equal(
      connection.prepare("SELECT created_at FROM rollout_revisions").get()?.created_at,
      NOW,
    );
  });

  it("rejects rowid replacement inserts with fresh revision keys", () => {
    const connection = currentMigrationConnection();
    insertRevision(connection);

    assert.throws(() => connection.prepare(`
      INSERT OR REPLACE INTO rollout_revisions(
        rowid, project_id, revision_id, parent_revision_id,
        build_identity_hash, migration_identity_hash, configuration_checksum,
        v1_baseline_checksum, cohort_algorithm_version, cohort_salt,
        cohort_basis_points, created_at
      ) VALUES (
        1, $projectId, $revisionId, NULL,
        $buildIdentityHash, $migrationIdentityHash, $configurationChecksum,
        $v1BaselineChecksum, 1, $cohortSalt, 500, $createdAt
      )
    `).run({
      $projectId: PROJECT_ID,
      $revisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      $buildIdentityHash: "a".repeat(64),
      $migrationIdentityHash: "b".repeat(64),
      $configurationChecksum: "c".repeat(64),
      $v1BaselineChecksum: "d".repeat(64),
      $cohortSalt: "e".repeat(64),
      $createdAt: "2026-09-01T00:00:00.000Z",
    }), /rowid/);

    assert.deepEqual({ ...connection.prepare(`
      SELECT project_id, revision_id, created_at FROM rollout_revisions
    `).get() }, {
      project_id: PROJECT_ID,
      revision_id: REVISION_INPUT.revisionId,
      created_at: NOW,
    });
  });

  for (const conflictKey of ["transition_id", "approval_id", "approval_nonce_digest"] as const) {
    it(`rejects replacement inserts that reuse an immutable transition ${conflictKey}`, () => {
      const connection = currentMigrationConnection();
      insertRevision(connection);
      insertTransition(connection);

      assert.throws(() => connection.prepare(`
        INSERT OR REPLACE INTO rollout_transitions
        SELECT project_id, $transitionId, revision_id,
          from_mode, to_mode, prior_state_generation, next_state_generation,
          $approvalId, $approvalNonceDigest, actor_fingerprint, evidence_digest,
          'rewritten', recorded_at
        FROM rollout_transitions
      `).run({
        $transitionId: conflictKey === "transition_id"
          ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        $approvalId: conflictKey === "approval_id"
          ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
          : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        $approvalNonceDigest: (conflictKey === "approval_nonce_digest" ? "f" : "a").repeat(64),
      }), /ROLLOUT_IMMUTABLE/);

      assert.deepEqual({ ...connection.prepare(`
        SELECT transition_id, approval_id, approval_nonce_digest, reason_code
        FROM rollout_transitions
      `).get() }, {
        transition_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        approval_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        approval_nonce_digest: "f".repeat(64),
        reason_code: "operator-approved",
      });
    });
  }

  it("rejects rowid replacement inserts with fresh transition keys", () => {
    const connection = currentMigrationConnection();
    insertRevision(connection);
    insertTransition(connection);

    assert.throws(() => connection.prepare(`
      INSERT OR REPLACE INTO rollout_transitions(
        rowid, project_id, transition_id, revision_id,
        from_mode, to_mode, prior_state_generation, next_state_generation,
        approval_id, approval_nonce_digest, actor_fingerprint, evidence_digest,
        reason_code, recorded_at
      ) VALUES (
        1, $projectId, $transitionId, $revisionId,
        'off', 'shadow', 0, 1,
        $approvalId, $approvalNonceDigest, $actorFingerprint, $evidenceDigest,
        'rewritten', $recordedAt
      )
    `).run({
      $projectId: PROJECT_ID,
      $transitionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      $revisionId: REVISION_INPUT.revisionId,
      $approvalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      $approvalNonceDigest: "3".repeat(64),
      $actorFingerprint: "4".repeat(64),
      $evidenceDigest: "5".repeat(64),
      $recordedAt: "2026-09-01T00:00:00.000Z",
    }), /rowid/);

    assert.deepEqual({ ...connection.prepare(`
      SELECT project_id, transition_id, approval_id, approval_nonce_digest,
        reason_code, recorded_at
      FROM rollout_transitions
    `).get() }, {
      project_id: PROJECT_ID,
      transition_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      approval_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      approval_nonce_digest: "f".repeat(64),
      reason_code: "operator-approved",
      recorded_at: NOW,
    });
  });

  it("permits a one-generation state advance linked to its appended transition", () => {
    const connection = currentMigrationConnection();
    insertRevision(connection);
    insertTransition(connection);

    connection.prepare(`
      UPDATE rollout_control_state
      SET active_revision_id = $revisionId,
        mode = 'shadow',
        state_generation = 1,
        last_transition_id = $transitionId,
        updated_at = $updatedAt
      WHERE singleton = 1
    `).run({
      $revisionId: REVISION_INPUT.revisionId,
      $transitionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      $updatedAt: NOW,
    });

    assert.deepEqual({ ...connection.prepare(`
      SELECT active_revision_id, mode, state_generation, last_transition_id
      FROM rollout_control_state WHERE singleton = 1
    `).get() }, {
      active_revision_id: REVISION_INPUT.revisionId,
      mode: "shadow",
      state_generation: 1n,
      last_transition_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });
});

describe("SQLite rollout control-plane repository", () => {
  for (const field of [
    "projectId", "revisionId", "buildIdentityHash", "migrationIdentityHash",
    "configurationChecksum", "v1BaselineChecksum", "cohortSalt",
  ] as const) {
    it(`rejects a revision with a newline-suffixed ${field} before writing`, () => {
      const connection = currentMigrationConnection();
      const repository = new SqliteRolloutControlPlaneRepository(connection);
      const revision = inputWith({ [field]: `${REVISION_INPUT[field]}\n` }) as ReturnType<typeof decodeRolloutRevision>;

      assertInputInvalid(() => repository.transact(PROJECT_ID, (transaction) => transaction.insertRevision(revision)));
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 0n);
    });
  }

  it("persists and returns a deep-frozen revision and off-to-shadow state transition atomically", () => {
    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);

    const state = repository.transact(PROJECT_ID, (transaction) => {
      const initial = transaction.readState();
      assert.deepEqual(initial, {
        projectId: PROJECT_ID,
        revisionId: null,
        mode: "off",
        stateGeneration: 0n,
        lastTransitionId: null,
        updatedAt: NOW,
      });
      assert.equal(Object.isFrozen(initial), true);

      transaction.insertRevision(decodeRolloutRevision(REVISION_INPUT));
      const storedRevision = transaction.readRevision(REVISION_INPUT.revisionId);
      assert.deepEqual(storedRevision, REVISION_INPUT);
      assert.equal(Object.isFrozen(storedRevision), true);

      transaction.appendTransition(rolloutTransition());
      const compareAndSetResult = transaction.compareAndSetState(rolloutCas());
      assert.equal(compareAndSetResult, undefined);
      return transaction.readState();
    });

    assert.deepEqual(state, {
      projectId: PROJECT_ID,
      revisionId: REVISION_INPUT.revisionId,
      mode: "shadow",
      stateGeneration: 1n,
      lastTransitionId: REPOSITORY_TRANSITION_ID,
      updatedAt: NOW,
    });
    assert.equal(Object.isFrozen(state), true);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 1n);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 1n);
  });

  it("maps a malformed stored state row to rollout integrity failure", () => {
    const connection = currentMigrationConnection();
    const wrappedConnection: SqliteConnection = {
      exec: (sql) => connection.exec(sql),
      prepare(sql) {
        const statement = connection.prepare(sql);
        if (!sql.includes("FROM rollout_control_state WHERE singleton = 1")) return statement;
        return {
          run: (params) => statement.run(params),
          get(params) {
            const row = statement.get(params);
            return row === undefined ? undefined : { ...row, state_generation: "malformed" };
          },
          all: (params) => statement.all(params),
          iterate: (params) => statement.iterate(params),
        };
      },
      close: () => connection.close(),
    };
    const repository = new SqliteRolloutControlPlaneRepository(wrappedConnection);

    assertRolloutError("ROLLOUT_INTEGRITY_FAILURE", () => repository.transact(
      PROJECT_ID,
      (transaction) => transaction.readState(),
    ));
  });

  it("maps an unexpected successful CAS change count to rollout integrity failure and rolls back", () => {
    const connection = currentMigrationConnection();
    const wrappedConnection: SqliteConnection = {
      exec: (sql) => connection.exec(sql),
      prepare(sql) {
        const statement = connection.prepare(sql);
        if (!/^\s*UPDATE rollout_control_state/.test(sql)) return statement;
        return {
          run(params) {
            const result = statement.run(params);
            return { ...result, changes: 2n };
          },
          get: (params) => statement.get(params),
          all: (params) => statement.all(params),
          iterate: (params) => statement.iterate(params),
        };
      },
      close: () => connection.close(),
    };
    const repository = new SqliteRolloutControlPlaneRepository(wrappedConnection);

    assertRolloutError("ROLLOUT_INTEGRITY_FAILURE", () => repository.transact(PROJECT_ID, (transaction) => {
      transaction.insertRevision(decodeRolloutRevision(REVISION_INPUT));
      transaction.appendTransition(rolloutTransition());
      transaction.compareAndSetState(rolloutCas());
    }));

    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 0n);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);
    assert.equal(connection.prepare("SELECT mode FROM rollout_control_state").get()?.mode, "off");
  });

  it("rolls back a distinct revision and transition when the state CAS is stale", () => {
    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);
    persistShadowState(repository);
    const revision = decodeRolloutRevision(inputWith({
      revisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      parentRevisionId: REVISION_INPUT.revisionId,
      createdAt: "2026-08-31T00:00:00.001Z",
    }));
    const transition = rolloutTransition({
      transitionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      revisionId: revision.revisionId,
      fromMode: "shadow",
      toMode: "canary",
      priorStateGeneration: 1n,
      nextStateGeneration: 2n,
      approvalId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      approvalNonceDigest: "3".repeat(64),
      recordedAt: "2026-08-31T00:00:00.001Z",
    });

    assertRolloutError("ROLLOUT_STATE_CONFLICT", () => repository.transact(PROJECT_ID, (transaction) => {
      transaction.insertRevision(revision);
      transaction.appendTransition(transition);
      transaction.compareAndSetState(rolloutCas({
        expectedMode: "off",
        expectedGeneration: 0n,
        revisionId: revision.revisionId,
        nextMode: "canary",
        nextGeneration: 1n,
        transitionId: transition.transitionId,
        updatedAt: transition.recordedAt,
      }));
    }));

    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 1n);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 1n);
    assert.equal(repository.transact(PROJECT_ID, (transaction) => transaction.readState()).mode, "shadow");
  });

  for (const conflict of ["approval ID", "approval nonce"] as const) {
    it(`maps a duplicate ${conflict} to state conflict and rolls back the whole transaction`, () => {
      const connection = currentMigrationConnection();
      const repository = new SqliteRolloutControlPlaneRepository(connection);
      persistShadowState(repository);
      const revision = decodeRolloutRevision(inputWith({
        revisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        parentRevisionId: REVISION_INPUT.revisionId,
        createdAt: "2026-08-31T00:00:00.001Z",
      }));
      const transition = rolloutTransition({
        transitionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        revisionId: revision.revisionId,
        fromMode: "shadow",
        toMode: "canary",
        priorStateGeneration: 1n,
        nextStateGeneration: 2n,
        approvalId: conflict === "approval ID"
          ? REPOSITORY_APPROVAL_ID
          : "ffffffff-ffff-4fff-8fff-ffffffffffff",
        approvalNonceDigest: conflict === "approval nonce"
          ? REPOSITORY_NONCE_DIGEST
          : "3".repeat(64),
        recordedAt: "2026-08-31T00:00:00.001Z",
      });

      assertRolloutError("ROLLOUT_STATE_CONFLICT", () => repository.transact(PROJECT_ID, (transaction) => {
        transaction.insertRevision(revision);
        transaction.appendTransition(transition);
      }));

      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 1n);
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 1n);
      assert.equal(repository.transact(PROJECT_ID, (transaction) => transaction.readState()).stateGeneration, 1n);
    });
  }

  it("preserves a callback error and rolls back partial writes even when rollback reports failure", () => {
    const connection = currentMigrationConnection();
    const rollbackFailure = new Error("synthetic rollback failure");
    const wrappedConnection: SqliteConnection = {
      exec(sql) {
        if (sql === "ROLLBACK") {
          connection.exec(sql);
          throw rollbackFailure;
        }
        connection.exec(sql);
      },
      prepare: (sql) => connection.prepare(sql),
      close: () => connection.close(),
    };
    const repository = new SqliteRolloutControlPlaneRepository(wrappedConnection);
    const callbackFailure = new Error("callback failed");

    assert.throws(() => repository.transact(PROJECT_ID, (transaction) => {
      transaction.insertRevision(decodeRolloutRevision(REVISION_INPUT));
      transaction.appendTransition(rolloutTransition());
      throw callbackFailure;
    }), (error: unknown) => error === callbackFailure);

    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 0n);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);
    assert.equal(connection.prepare("SELECT mode FROM rollout_control_state").get()?.mode, "off");
  });

  it("quarantines a connection when rollback fails before execution while preserving the callback error", () => {
    const connection = currentMigrationConnection();
    let beginCount = 0;
    const wrappedConnection: SqliteConnection = {
      exec(sql) {
        if (sql === "BEGIN IMMEDIATE") beginCount += 1;
        if (sql === "ROLLBACK") throw new Error("synthetic rollback failure");
        connection.exec(sql);
      },
      prepare: (sql) => connection.prepare(sql),
      close: () => connection.close(),
    };
    const repository = new SqliteRolloutControlPlaneRepository(wrappedConnection);
    const callbackFailure = new Error("callback failed");

    assert.throws(() => repository.transact(PROJECT_ID, (transaction) => {
      transaction.insertRevision(decodeRolloutRevision(REVISION_INPUT));
      throw callbackFailure;
    }), (error: unknown) => error === callbackFailure);

    assertRolloutError("ROLLOUT_INTEGRITY_FAILURE", () => repository.transact(
      PROJECT_ID,
      (transaction) => transaction.readState(),
    ));
    assert.equal(beginCount, 1);
  });

  it("rejects Promise and thenable callback results and rolls back before commit", () => {
    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);
    const results: readonly unknown[] = [
      Promise.resolve("asynchronous"),
      Object.freeze({ then: () => undefined }),
    ];

    for (const result of results) {
      assertRolloutError("ROLLOUT_INPUT_INVALID", () => repository.transact(PROJECT_ID, (transaction) => {
        transaction.insertRevision(decodeRolloutRevision(REVISION_INPUT));
        return result;
      }));
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 0n);
      assert.equal(connection.prepare("SELECT mode FROM rollout_control_state").get()?.mode, "off");
    }
  });

  it("rejects a nested transaction without corrupting its outer transaction", () => {
    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);

    const state = repository.transact(PROJECT_ID, (transaction) => {
      assertRolloutError("ROLLOUT_STATE_CONFLICT", () => repository.transact(
        PROJECT_ID,
        (nested) => nested.readState(),
      ));
      return transaction.readState();
    });

    assert.equal(state.mode, "off");
    assert.equal(repository.transact(PROJECT_ID, (transaction) => transaction.readState()).mode, "off");
  });
});

describe("default-deny rollout control plane", () => {
  const ROOT_ID = "10000000-0000-4000-8000-000000000001";
  const CHILD_5_ID = "10000000-0000-4000-8000-000000000005";
  const CHILD_25_ID = "10000000-0000-4000-8000-000000000025";
  const CHILD_50_ID = "10000000-0000-4000-8000-000000000050";
  const CHILD_100_ID = "10000000-0000-4000-8000-000000000100";

  function sequenceApproval(prefix: string, index: number): RolloutApproval {
    return approvalWith({
      approvalId: `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`,
      nonceDigest: index.toString(16).repeat(64),
    });
  }

  function createExactCanaryLineage(control: RolloutControlPlane): void {
    for (const revision of [
      revisionWith(ROOT_ID, null, 100),
      revisionWith(CHILD_5_ID, ROOT_ID, 500),
      revisionWith(CHILD_25_ID, CHILD_5_ID, 2500),
      revisionWith(CHILD_50_ID, CHILD_25_ID, 5000),
      revisionWith(CHILD_100_ID, CHILD_50_ID, 10000),
    ]) {
      control.createRevision(revision);
    }
  }

  function advanceToCanary10000(control: RolloutControlPlane, approvalPrefix: string): void {
    const progression = [
      [ROOT_ID, "off", 0n, "shadow"],
      [ROOT_ID, "shadow", 1n, "canary"],
      [CHILD_5_ID, "canary", 2n, "canary"],
      [CHILD_25_ID, "canary", 3n, "canary"],
      [CHILD_50_ID, "canary", 4n, "canary"],
      [CHILD_100_ID, "canary", 5n, "canary"],
    ] as const;
    for (const [index, [revisionId, expectedMode, expectedGeneration, nextMode]] of progression.entries()) {
      control.transition(transitionRequest(
        revisionId,
        expectedMode,
        expectedGeneration,
        nextMode,
        sequenceApproval(approvalPrefix, index + 1),
      ));
    }
  }

  it("persists immutable revisions and rejects missing parents and duplicate IDs", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
    const root = control.createRevision(revisionWith(ROOT_ID, null, 100));

    assert.deepEqual(root, revisionWith(ROOT_ID, null, 100));
    assert.equal(Object.isFrozen(root), true);
    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.createRevision(
      revisionWith(CHILD_5_ID, "20000000-0000-4000-8000-000000000002", 500),
    ));
    assertRolloutError("ROLLOUT_STATE_CONFLICT", () => control.createRevision(
      revisionWith(ROOT_ID, null, 100),
    ));
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, 1n);
  });

  it("reads an immutable revision by exact project and revision identity", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
    const expected = control.createRevision(revisionWith(ROOT_ID, null, 100));

    const revision = control.revision(PROJECT_ID, ROOT_ID);

    assert.deepEqual(revision, expected);
    assert.equal(Object.isFrozen(revision), true);
    assertRolloutError(
      "ROLLOUT_TRANSITION_DENIED",
      () => control.revision(PROJECT_ID, "20000000-0000-4000-8000-000000000002"),
    );
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.revision(`${PROJECT_ID}\n`, ROOT_ID));
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.revision(PROJECT_ID, `${ROOT_ID}\n`));
  });

  it("uses the persisted lineage root so 1%-to-100% cohort growth never deselects a workspace", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
    const revisions = [
      control.createRevision(revisionWith(ROOT_ID, null, 100)),
      control.createRevision(revisionWith(CHILD_5_ID, ROOT_ID, 500)),
      control.createRevision(revisionWith(CHILD_25_ID, CHILD_5_ID, 2500)),
      control.createRevision(revisionWith(CHILD_50_ID, CHILD_25_ID, 5000)),
      control.createRevision(revisionWith(CHILD_100_ID, CHILD_50_ID, 10000)),
    ];
    const selectedAtOnePercent = Array.from({ length: 20_000 }, (_, index) => `workspace-${index}`)
      .find((workspaceId) => cohortBucket(revisions[0]!, { projectId: PROJECT_ID, workspaceId }) < 100);
    assert.notEqual(selectedAtOnePercent, undefined);

    const membership = revisions.map((revision) => control.isSelectedCanaryCohort({
      projectId: PROJECT_ID,
      revisionId: revision.revisionId,
      workspaceId: selectedAtOnePercent!,
    }));
    assert.deepEqual(membership, [true, true, true, true, true]);

    const finalOnly = Array.from({ length: 20_000 }, (_, index) => `late-workspace-${index}`)
      .find((workspaceId) => {
        const bucket = cohortBucket(revisions[0]!, { projectId: PROJECT_ID, workspaceId });
        return bucket >= 5000;
      });
    assert.notEqual(finalOnly, undefined);
    assert.equal(control.isSelectedCanaryCohort({
      projectId: PROJECT_ID,
      revisionId: CHILD_50_ID,
      workspaceId: finalOnly!,
    }), false);
    assert.equal(control.isSelectedCanaryCohort({
      projectId: PROJECT_ID,
      revisionId: CHILD_100_ID,
      workspaceId: finalOnly!,
    }), true);
  });

  for (const corruption of ["missing", "cyclic", "foreign", "malformed", "salt-change", "decreasing"] as const) {
    it(`rejects a ${corruption} persisted parent lineage without changing durable state`, () => {
      const connection = currentMigrationConnection();
      connection.exec("PRAGMA foreign_keys = OFF");
      const leafId = "60000000-0000-4000-8000-000000000001";
      const parentId = "60000000-0000-4000-8000-000000000002";
      const leaf = revisionWith(leafId, parentId, corruption === "decreasing" ? 100 : 500, {
        cohortAlgorithmVersion: corruption === "malformed" ? 2 : 1,
        cohortSalt: corruption === "salt-change" ? "f".repeat(64) : REVISION_INPUT.cohortSalt,
      });
      rawInsertRevision(connection, leaf);
      if (corruption === "cyclic") {
        rawInsertRevision(connection, revisionWith(parentId, leafId, 100));
      } else if (corruption === "foreign") {
        rawInsertRevision(connection, revisionWith(parentId, null, 100, { projectId: OTHER_PROJECT_ID }));
      } else if (corruption !== "missing" && corruption !== "malformed") {
        rawInsertRevision(connection, revisionWith(parentId, null, corruption === "decreasing" ? 500 : 100));
      }
      const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
      const revisionCount = connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count;

      assertRolloutError("ROLLOUT_INTEGRITY_FAILURE", () => control.isSelectedCanaryCohort({
        projectId: PROJECT_ID,
        revisionId: leafId,
        workspaceId: "workspace-corrupt",
      }));
      assertRolloutError("ROLLOUT_INTEGRITY_FAILURE", () => control.createRevision(
        revisionWith("60000000-0000-4000-8000-000000000003", leafId, 1000, {
          cohortSalt: leaf.cohortSalt,
        }),
      ));
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_revisions").get()?.count, revisionCount);
      assert.equal(control.state(PROJECT_ID).mode, "off");
    });
  }

  it("strictly decodes exact own-enumerable transition and cohort-query inputs before a transaction", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
    control.createRevision(revisionWith(ROOT_ID, null, 100));
    const request = transitionRequest(ROOT_ID, "off", 0n, "shadow");
    const query = Object.freeze({ projectId: PROJECT_ID, revisionId: ROOT_ID, workspaceId: "workspace-a" });

    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.transition(Object.create(request)));
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.transition({ ...request, unexpected: true }));
    const accessorApproval = { ...APPROVAL };
    Object.defineProperty(accessorApproval, "approvalId", { enumerable: true, get: () => APPROVAL.approvalId });
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.transition({ ...request, approval: accessorApproval }));
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.isSelectedCanaryCohort(Object.create(query)));
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.isSelectedCanaryCohort({ ...query, [Symbol("hostile")]: true }));
    const hiddenQuery = { ...query };
    Object.defineProperty(hiddenQuery, "hidden", { value: true, enumerable: false });
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.isSelectedCanaryCohort(hiddenQuery));
    const hostile = new Proxy(query, { ownKeys: () => { throw new Error("hostile trap"); } });
    assertRolloutError("ROLLOUT_INPUT_INVALID", () => control.isSelectedCanaryCohort(hostile));
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);
    assert.equal(control.state(PROJECT_ID).stateGeneration, 0n);
  });

  it("appends the supplied redacted approval before CAS and returns frozen off-to-shadow state", () => {
    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);
    let callerRequest!: Record<string, unknown>;
    let callerApproval!: Record<string, unknown>;
    const gate = allowAllGate((input) => {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.revision), true);
      callerRequest.nextMode = "off";
      callerApproval.reasonCode = "mutated-after-decode";
    });
    const control = new RolloutControlPlane(repository, gate);
    control.createRevision(revisionWith(ROOT_ID, null, 100));
    callerApproval = { ...APPROVAL };
    callerRequest = {
      projectId: PROJECT_ID,
      revisionId: ROOT_ID,
      expectedMode: "off",
      expectedGeneration: 0n,
      nextMode: "shadow",
      approval: callerApproval,
    };

    const shadow = control.transition(callerRequest);

    assert.equal(Object.isFrozen(shadow), true);
    assert.equal(shadow.mode, "shadow");
    assert.equal(shadow.stateGeneration, 1n);
    const audit = connection.prepare(`
      SELECT approval_id, approval_nonce_digest, actor_fingerprint,
        evidence_digest, reason_code, from_mode, to_mode
      FROM rollout_transitions
    `).get();
    assert.deepEqual({ ...audit }, {
      approval_id: APPROVAL.approvalId,
      approval_nonce_digest: APPROVAL.nonceDigest,
      actor_fingerprint: APPROVAL.actorFingerprint,
      evidence_digest: APPROVAL.evidenceDigest,
      reason_code: APPROVAL.reasonCode,
      from_mode: "off",
      to_mode: "shadow",
    });
  });

  it("rolls back stale expectations and invalid graph edges", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
    control.createRevision(revisionWith(ROOT_ID, null, 100));

    assertRolloutError("ROLLOUT_STATE_CONFLICT", () => control.transition(
      transitionRequest(ROOT_ID, "off", 1n, "shadow"),
    ));
    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
      transitionRequest(ROOT_ID, "off", 0n, "primary"),
    ));
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);
    assert.equal(control.state(PROJECT_ID).mode, "off");
  });

  for (const replay of ["approval-id", "approval-nonce"] as const) {
    it(`rolls back a replayed ${replay}`, () => {
      const connection = currentMigrationConnection();
      const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
      control.createRevision(revisionWith(ROOT_ID, null, 100));
      control.transition(transitionRequest(ROOT_ID, "off", 0n, "shadow"));
      const replayApproval = approvalWith({
        approvalId: replay === "approval-id" ? APPROVAL.approvalId : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        nonceDigest: replay === "approval-nonce" ? APPROVAL.nonceDigest : "4".repeat(64),
        recordedAt: "2026-08-31T00:02:00.000Z",
      });

      assertRolloutError("ROLLOUT_STATE_CONFLICT", () => control.transition(
        transitionRequest(null, "shadow", 1n, "off", replayApproval),
      ));
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 1n);
      assert.equal(control.state(PROJECT_ID).mode, "shadow");
      assert.equal(control.state(PROJECT_ID).stateGeneration, 1n);
    });
  }

  it("default-denies every recovery or V2-serving activation before append", () => {
    const offConnection = currentMigrationConnection();
    const offControl = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(offConnection));
    offControl.createRevision(revisionWith(ROOT_ID, null, 100));
    assertRolloutError("ROLLOUT_V2_ROUTING_DISABLED", () => offControl.transition(
      transitionRequest(ROOT_ID, "off", 0n, "read-only-recovery"),
    ));
    assert.equal(offControl.state(PROJECT_ID).mode, "off");
    assert.equal(offConnection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);

    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);
    const setup = new RolloutControlPlane(repository, allowAllGate());
    createExactCanaryLineage(setup);
    setup.transition(transitionRequest(ROOT_ID, "off", 0n, "shadow", approvalWith({
      approvalId: "70000000-0000-4000-8000-000000000001", nonceDigest: "4".repeat(64),
    })));
    const sealedAtShadow = new RolloutControlPlane(repository);
    assertRolloutError("ROLLOUT_V2_ROUTING_DISABLED", () => sealedAtShadow.transition(
      transitionRequest(ROOT_ID, "shadow", 1n, "canary", approvalWith({
        approvalId: "70000000-0000-4000-8000-000000000002", nonceDigest: "5".repeat(64),
      })),
    ));
    assert.equal(sealedAtShadow.state(PROJECT_ID).mode, "shadow");

    setup.transition(transitionRequest(ROOT_ID, "shadow", 1n, "canary", approvalWith({
      approvalId: "70000000-0000-4000-8000-000000000003", nonceDigest: "6".repeat(64),
    })));
    for (const [index, revisionId] of [CHILD_5_ID, CHILD_25_ID, CHILD_50_ID, CHILD_100_ID].entries()) {
      setup.transition(transitionRequest(
        revisionId,
        "canary",
        BigInt(index + 2),
        "canary",
        approvalWith({
          approvalId: `70000000-0000-4000-8000-${String(index + 7).padStart(12, "0")}`,
          nonceDigest: (index + 10).toString(16).repeat(64),
        }),
      ));
    }
    const sealedAtCanary = new RolloutControlPlane(repository);
    for (const nextMode of ["primary", "rollback-pending", "read-only-recovery"] as const) {
      assertRolloutError("ROLLOUT_V2_ROUTING_DISABLED", () => sealedAtCanary.transition(
        transitionRequest(CHILD_100_ID, "canary", 6n, nextMode, approvalWith({
          approvalId: nextMode === "primary"
            ? "70000000-0000-4000-8000-000000000004"
            : nextMode === "rollback-pending"
              ? "70000000-0000-4000-8000-000000000005"
              : "70000000-0000-4000-8000-000000000006",
          nonceDigest: nextMode === "primary" ? "7".repeat(64) : nextMode === "rollback-pending" ? "8".repeat(64) : "9".repeat(64),
        })),
      ));
    }
    assert.equal(sealedAtCanary.state(PROJECT_ID).mode, "canary");
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 6n);
  });

  for (const skippedEntryBasisPoints of [500, 2500, 5000, 10000] as const) {
    it(`rejects shadow-to-canary entry that skips 100 basis points for ${skippedEntryBasisPoints}`, () => {
      const connection = currentMigrationConnection();
      const control = new RolloutControlPlane(
        new SqliteRolloutControlPlaneRepository(connection),
        allowAllGate(),
      );
      const revisionId = `90000000-0000-4000-8000-${String(skippedEntryBasisPoints).padStart(12, "0")}`;
      control.createRevision(revisionWith(revisionId, null, skippedEntryBasisPoints));
      control.transition(transitionRequest(revisionId, "off", 0n, "shadow", approvalWith({
        approvalId: "90000000-0000-4000-8000-000000000001",
        nonceDigest: "4".repeat(64),
      })));

      assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
        transitionRequest(revisionId, "shadow", 1n, "canary", approvalWith({
          approvalId: "90000000-0000-4000-8000-000000000002",
          nonceDigest: "5".repeat(64),
        })),
      ));
      assert.equal(control.state(PROJECT_ID).mode, "shadow");
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 1n);
    });
  }

  it("enforces approved canary thresholds and strict child growth for same-mode canary changes", () => {
    const connection = currentMigrationConnection();
    const repository = new SqliteRolloutControlPlaneRepository(connection);
    const control = new RolloutControlPlane(repository, allowAllGate());
    const invalidRoot = "80000000-0000-4000-8000-000000000101";
    control.createRevision(revisionWith(invalidRoot, null, 101));
    control.transition(transitionRequest(invalidRoot, "off", 0n, "shadow", approvalWith({
      approvalId: "80000000-0000-4000-8000-000000000001", nonceDigest: "4".repeat(64),
    })));
    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
      transitionRequest(invalidRoot, "shadow", 1n, "canary", approvalWith({
        approvalId: "80000000-0000-4000-8000-000000000002", nonceDigest: "5".repeat(64),
      })),
    ));

    const secondConnection = currentMigrationConnection();
    const second = new RolloutControlPlane(
      new SqliteRolloutControlPlaneRepository(secondConnection),
      allowAllGate(),
    );
    second.createRevision(revisionWith(ROOT_ID, null, 100));
    second.createRevision(revisionWith(CHILD_5_ID, ROOT_ID, 500));
    second.createRevision(revisionWith(CHILD_25_ID, ROOT_ID, 2500));
    const equalChildId = "80000000-0000-4000-8000-000000000500";
    second.createRevision(revisionWith(equalChildId, ROOT_ID, 100));
    second.transition(transitionRequest(ROOT_ID, "off", 0n, "shadow", approvalWith({
      approvalId: "80000000-0000-4000-8000-000000000003", nonceDigest: "6".repeat(64),
    })));
    second.transition(transitionRequest(ROOT_ID, "shadow", 1n, "canary", approvalWith({
      approvalId: "80000000-0000-4000-8000-000000000004", nonceDigest: "7".repeat(64),
    })));
    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => second.transition(
      transitionRequest(equalChildId, "canary", 2n, "canary", approvalWith({
        approvalId: "80000000-0000-4000-8000-000000000005", nonceDigest: "8".repeat(64),
      })),
    ));
    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => second.transition(
      transitionRequest(CHILD_25_ID, "canary", 2n, "canary", approvalWith({
        approvalId: "80000000-0000-4000-8000-000000000007", nonceDigest: "a".repeat(64),
      })),
    ));
    const expanded = second.transition(
      transitionRequest(CHILD_5_ID, "canary", 2n, "canary", approvalWith({
        approvalId: "80000000-0000-4000-8000-000000000006", nonceDigest: "9".repeat(64),
      })),
    );
    assert.equal(expanded.mode, "canary");
    assert.equal(expanded.revisionId, CHILD_5_ID);
    assert.equal(expanded.stateGeneration, 3n);
  });

  it("rejects a direct-child canary advance after the active revision reaches 10000 basis points", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(
      new SqliteRolloutControlPlaneRepository(connection),
      allowAllGate(),
    );
    const terminalChildId = "a0000000-0000-4000-8000-000000010001";
    for (const revision of [
      revisionWith(ROOT_ID, null, 100),
      revisionWith(CHILD_5_ID, ROOT_ID, 500),
      revisionWith(CHILD_25_ID, CHILD_5_ID, 2500),
      revisionWith(CHILD_50_ID, CHILD_25_ID, 5000),
      revisionWith(CHILD_100_ID, CHILD_50_ID, 10000),
      revisionWith(terminalChildId, CHILD_100_ID, 10000),
    ]) {
      control.createRevision(revision);
    }
    const progression = [
      [ROOT_ID, "off", 0n, "shadow"],
      [ROOT_ID, "shadow", 1n, "canary"],
      [CHILD_5_ID, "canary", 2n, "canary"],
      [CHILD_25_ID, "canary", 3n, "canary"],
      [CHILD_50_ID, "canary", 4n, "canary"],
      [CHILD_100_ID, "canary", 5n, "canary"],
    ] as const;
    for (const [index, [revisionId, expectedMode, expectedGeneration, nextMode]] of progression.entries()) {
      control.transition(transitionRequest(revisionId, expectedMode, expectedGeneration, nextMode, approvalWith({
        approvalId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        nonceDigest: String(index + 1).repeat(64),
      })));
    }
    const before = control.state(PROJECT_ID);
    const auditCount = connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count;

    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
      transitionRequest(terminalChildId, "canary", 6n, "canary", approvalWith({
        approvalId: "a0000000-0000-4000-8000-000000000007",
        nonceDigest: "7".repeat(64),
      })),
    ));
    assert.deepEqual(control.state(PROJECT_ID), before);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, auditCount);
  });

  it("allows primary only from the same active 10000-basis-point revision after exact progression", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(
      new SqliteRolloutControlPlaneRepository(connection),
      allowAllGate(),
    );
    createExactCanaryLineage(control);
    control.transition(transitionRequest(ROOT_ID, "off", 0n, "shadow", sequenceApproval("b0000000", 1)));
    control.transition(transitionRequest(ROOT_ID, "shadow", 1n, "canary", sequenceApproval("b0000000", 2)));
    const canary100 = control.state(PROJECT_ID);
    const auditAt100 = connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count;

    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
      transitionRequest(ROOT_ID, "canary", 2n, "primary", sequenceApproval("b0000000", 3)),
    ));
    assert.deepEqual(control.state(PROJECT_ID), canary100);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, auditAt100);

    for (const [index, revisionId] of [CHILD_5_ID, CHILD_25_ID, CHILD_50_ID, CHILD_100_ID].entries()) {
      control.transition(transitionRequest(
        revisionId,
        "canary",
        BigInt(index + 2),
        "canary",
        sequenceApproval("b0000000", index + 3),
      ));
    }
    const primary = control.transition(transitionRequest(
      CHILD_100_ID,
      "canary",
      6n,
      "primary",
      sequenceApproval("b0000000", 7),
    ));
    assert.equal(primary.mode, "primary");
    assert.equal(primary.revisionId, CHILD_100_ID);
    assert.equal(primary.stateGeneration, 7n);
  });

  it("rejects shadow-to-canary activation through an unrelated 100-basis-point root", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(
      new SqliteRolloutControlPlaneRepository(connection),
      allowAllGate(),
    );
    const unrelatedRootId = "c0000000-0000-4000-8000-000000000100";
    control.createRevision(revisionWith(ROOT_ID, null, 100));
    control.createRevision(revisionWith(unrelatedRootId, null, 100));
    control.transition(transitionRequest(ROOT_ID, "off", 0n, "shadow", sequenceApproval("c0000000", 1)));
    const before = control.state(PROJECT_ID);
    const auditCount = connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count;

    assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
      transitionRequest(unrelatedRootId, "shadow", 1n, "canary", sequenceApproval("c0000000", 2)),
    ));
    assert.deepEqual(control.state(PROJECT_ID), before);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, auditCount);
  });

  it("preserves the active revision across non-expansion transitions and permits selection only from off", () => {
    const connection = currentMigrationConnection();
    const control = new RolloutControlPlane(
      new SqliteRolloutControlPlaneRepository(connection),
      allowAllGate(),
    );
    const unrelatedRootId = "d0000000-0000-4000-8000-000000000100";
    createExactCanaryLineage(control);
    control.createRevision(revisionWith(unrelatedRootId, null, 100));
    advanceToCanary10000(control, "d0000000");
    control.transition(transitionRequest(
      CHILD_100_ID,
      "canary",
      6n,
      "primary",
      sequenceApproval("d0000000", 7),
    ));

    for (const [nextMode, expectedGeneration, approvalIndex] of [
      ["rollback-pending", 7n, 8],
      ["read-only-recovery", 8n, 10],
    ] as const) {
      const before = control.state(PROJECT_ID);
      const auditCount = connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count;
      assertRolloutError("ROLLOUT_TRANSITION_DENIED", () => control.transition(
        transitionRequest(
          unrelatedRootId,
          before.mode,
          expectedGeneration,
          nextMode,
          sequenceApproval("d0000000", approvalIndex),
        ),
      ));
      assert.deepEqual(control.state(PROJECT_ID), before);
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, auditCount);
      control.transition(transitionRequest(
        CHILD_100_ID,
        before.mode,
        expectedGeneration,
        nextMode,
        sequenceApproval("d0000000", approvalIndex + 1),
      ));
    }

    control.transition(transitionRequest(
      null,
      "read-only-recovery",
      9n,
      "off",
      sequenceApproval("d0000000", 12),
    ));
    const recovery = control.transition(transitionRequest(
      unrelatedRootId,
      "off",
      10n,
      "read-only-recovery",
      sequenceApproval("d0000000", 13),
    ));
    assert.equal(recovery.revisionId, unrelatedRootId);
    assert.equal(recovery.stateGeneration, 11n);
  });

  for (const gateResult of [
    ["false primitive", () => false],
    ["zero primitive", () => 0],
    ["string primitive", () => "denied"],
    ["null primitive", () => null],
    ["bigint primitive", () => 0n],
    ["symbol primitive", () => Symbol("denied")],
    ["function", () => () => undefined],
    ["plain object", () => Object.freeze({})],
    ["hostile Promise-detection proxy", () => new Proxy({}, {
      getPrototypeOf: () => { throw new Error("hostile getPrototypeOf"); },
    })],
    ["resolved Promise", () => Promise.resolve()],
    ["rejected Promise", () => Promise.reject(new Error("gate rejected"))],
    ["thenable", () => Object.freeze({ then: () => undefined })],
  ] as const) {
    it(`fails closed when a promotion gate returns a ${gateResult[0]}`, async () => {
      const connection = currentMigrationConnection();
      const gate: RolloutPromotionGate = Object.freeze({
        assertAllowed: () => gateResult[1](),
      });
      const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection), gate);
      control.createRevision(revisionWith(ROOT_ID, null, 100));

      assertRolloutError("ROLLOUT_INTEGRITY_FAILURE", () => control.transition(
        transitionRequest(ROOT_ID, "off", 0n, "shadow", sequenceApproval("e0000000", 1)),
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(control.state(PROJECT_ID).mode, "off");
      assert.equal(control.state(PROJECT_ID).stateGeneration, 0n);
      assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM rollout_transitions").get()?.count, 0n);
    });
  }
});
