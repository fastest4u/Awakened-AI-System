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
} from "../src/orchestrator/rollout/rollout-cohort.js";
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
