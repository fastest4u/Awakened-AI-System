import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import {
  decodeFreshStartGenesis, decodeFreshStartIdentity, decodeFreshStartRelease,
  decodeFreshStartStateChange, FreshStartError,
  type FreshStartGenesis, type FreshStartIdentity, type FreshStartMode,
  type FreshStartRelease, type FreshStartState, type FreshStartStateChange,
} from "./contracts.js";

export interface FreshStartTransaction {
  installation(): FreshStartGenesis | null;
  state(): FreshStartState | null;
  release(releaseId: string): FreshStartRelease | null;
  install(genesis: FreshStartGenesis, release: FreshStartRelease): void;
  insertRelease(release: FreshStartRelease): void;
  transition(input: FreshStartStateChange): FreshStartState;
}

function fail(code: ConstructorParameters<typeof FreshStartError>[0]): never { throw new FreshStartError(code); }
function string(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") return fail("FRESH_START_STORAGE_FAILURE");
  return value;
}
function bigint(row: SqliteRow, key: string): bigint {
  const value = row[key];
  if (typeof value !== "bigint") return fail("FRESH_START_STORAGE_FAILURE");
  return value;
}
function nullableString(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return string(row, key);
}
function nullableBigint(row: SqliteRow, key: string): bigint | null {
  const value = row[key];
  if (value === null) return null;
  return bigint(row, key);
}
function sameIdentity(left: FreshStartIdentity, right: FreshStartIdentity): boolean {
  return left.projectId === right.projectId && left.vaultId === right.vaultId && left.storeId === right.storeId;
}
function storage<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof FreshStartError) throw error;
    return fail("FRESH_START_STORAGE_FAILURE");
  }
}

export class SqliteFreshStartRepository {
  readonly #connection: SqliteConnection;
  #inTransaction = false;

  constructor(connection: SqliteConnection) { this.#connection = connection; }

  transact<T>(identity: FreshStartIdentity, operation: (tx: FreshStartTransaction) => T): T {
    if (this.#inTransaction) return fail("FRESH_START_TRANSACTION_REENTRANT");
    const expected = decodeFreshStartIdentity(identity);
    if (typeof operation !== "function") return fail("FRESH_START_INPUT_INVALID");
    this.#inTransaction = true;
    let begun = false;
    let live = true;
    try {
      storage(() => this.#connection.exec("BEGIN IMMEDIATE"));
      begun = true;
      const meta = storage(() => this.#connection.prepare("SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1").get());
      if (!meta || meta.project_id !== expected.projectId || meta.vault_id !== expected.vaultId || meta.store_id !== expected.storeId) {
        fail("FRESH_START_IDENTITY_MISMATCH");
      }
      const requireLive = (): void => { if (!live) fail("FRESH_START_TRANSACTION_CLOSED"); };
      const installation = (): FreshStartGenesis | null => {
        requireLive();
        const row = storage(() => this.#connection.prepare("SELECT * FROM fresh_start_installation WHERE project_id = $projectId").get({ $projectId: expected.projectId }));
        if (!row) return null;
        let parsed: unknown;
        try { parsed = JSON.parse(string(row, "projection_checksums_json")); }
        catch { return fail("FRESH_START_STORAGE_FAILURE"); }
        try {
          return decodeFreshStartGenesis({ ...expected,
            initializationId: string(row, "initialization_id"), releaseId: string(row, "release_id"),
            semanticPosition: bigint(row, "semantic_position").toString(), terminalHash: string(row, "terminal_hash"),
            projectionChecksums: parsed, preparationIntentDigest: string(row, "preparation_intent_digest"),
            actorFingerprint: string(row, "actor_fingerprint"), createdAt: string(row, "created_at") });
        } catch { return fail("FRESH_START_STORAGE_FAILURE"); }
      };
      const release = (releaseId: string): FreshStartRelease | null => {
        requireLive();
        if (typeof releaseId !== "string") fail("FRESH_START_INPUT_INVALID");
        const row = storage(() => this.#connection.prepare("SELECT * FROM fresh_start_releases WHERE project_id = $projectId AND release_id = $releaseId").get({ $projectId: expected.projectId, $releaseId: releaseId }));
        if (!row) return null;
        try {
          return decodeFreshStartRelease({ ...expected, profileVersion: Number(bigint(row, "profile_version")),
            releaseId: string(row, "release_id"), buildIdentityHash: string(row, "build_identity_hash"),
            schemaIdentityHash: string(row, "schema_identity_hash"), configurationHash: string(row, "configuration_hash"),
            capabilityManifestHash: string(row, "capability_manifest_hash"), recoveryPolicyHash: string(row, "recovery_policy_hash"),
            evidenceDigest: string(row, "evidence_digest"), createdAt: string(row, "created_at") });
        } catch { return fail("FRESH_START_STORAGE_FAILURE"); }
      };
      const state = (): FreshStartState | null => {
        requireLive();
        const row = storage(() => this.#connection.prepare("SELECT * FROM fresh_start_control_state WHERE project_id = $projectId").get({ $projectId: expected.projectId }));
        if (!row) {
          if (installation() !== null) fail("FRESH_START_STORAGE_FAILURE");
          return null;
        }
        const mode = string(row, "mode");
        if (!["prepared", "active", "read-only-recovery", "disabled"].includes(mode)) fail("FRESH_START_STORAGE_FAILURE");
        return Object.freeze({ ...expected, releaseId: string(row, "release_id"), mode: mode as FreshStartMode,
          generation: bigint(row, "generation"), recoveryPosition: nullableBigint(row, "recovery_position"),
          recoveryHash: nullableString(row, "recovery_hash"), lastTransitionId: nullableString(row, "last_transition_id"),
          updatedAt: string(row, "updated_at") });
      };
      const writeRelease = (input: FreshStartRelease): void => {
        const decoded = decodeFreshStartRelease(input);
        if (!sameIdentity(expected, decoded)) fail("FRESH_START_IDENTITY_MISMATCH");
        storage(() => this.#connection.prepare(`INSERT INTO fresh_start_releases(
          project_id, vault_id, store_id, release_id, profile_version, build_identity_hash, schema_identity_hash,
          configuration_hash, capability_manifest_hash, recovery_policy_hash, evidence_digest, created_at
        ) VALUES ($projectId, $vaultId, $storeId, $releaseId, 1, $buildHash, $schemaHash,
          $configurationHash, $capabilityHash, $recoveryHash, $evidenceDigest, $createdAt)`).run({
          $projectId: expected.projectId, $vaultId: expected.vaultId, $storeId: expected.storeId,
          $releaseId: decoded.releaseId, $buildHash: decoded.buildIdentityHash, $schemaHash: decoded.schemaIdentityHash,
          $configurationHash: decoded.configurationHash, $capabilityHash: decoded.capabilityManifestHash,
          $recoveryHash: decoded.recoveryPolicyHash, $evidenceDigest: decoded.evidenceDigest,
          $createdAt: decoded.createdAt,
        }));
      };
      const tx: FreshStartTransaction = Object.freeze({
        installation, state, release,
        install: (genesisInput: FreshStartGenesis, releaseInput: FreshStartRelease): void => {
          requireLive();
          if (installation() !== null) fail("FRESH_START_ALREADY_INITIALIZED");
          const genesis = decodeFreshStartGenesis(genesisInput);
          const initialRelease = decodeFreshStartRelease(releaseInput);
          if (!sameIdentity(expected, genesis) || !sameIdentity(expected, initialRelease)) fail("FRESH_START_IDENTITY_MISMATCH");
          if (genesis.releaseId !== initialRelease.releaseId) fail("FRESH_START_RELEASE_MISMATCH");
          if (storage(() => this.#connection.prepare(`SELECT
            EXISTS(SELECT 1 FROM events) OR EXISTS(SELECT 1 FROM streams)
            OR EXISTS(SELECT 1 FROM command_dedup) OR EXISTS(SELECT 1 FROM rollout_revisions)
            OR EXISTS(SELECT 1 FROM v2_shadow_migration_runs) AS populated`).get())?.populated !== 0n) {
            fail("FRESH_START_ALREADY_INITIALIZED");
          }
          writeRelease(initialRelease);
          storage(() => this.#connection.prepare(`INSERT INTO fresh_start_installation(
            project_id, vault_id, store_id, initialization_id, release_id, semantic_position, terminal_hash,
            projection_checksums_json, preparation_intent_digest, actor_fingerprint, created_at
          ) VALUES ($projectId, $vaultId, $storeId, $initializationId, $releaseId, 0, $terminalHash,
            $projectionChecksums, $intentDigest, $actorFingerprint, $createdAt)`).run({
            $projectId: expected.projectId, $vaultId: expected.vaultId, $storeId: expected.storeId,
            $initializationId: genesis.initializationId, $releaseId: genesis.releaseId,
            $terminalHash: genesis.terminalHash, $projectionChecksums: JSON.stringify(genesis.projectionChecksums),
            $intentDigest: genesis.preparationIntentDigest, $actorFingerprint: genesis.actorFingerprint,
            $createdAt: genesis.createdAt,
          }));
          storage(() => this.#connection.prepare(`INSERT INTO fresh_start_control_state(
            project_id, vault_id, store_id, release_id, mode, generation, recovery_position, recovery_hash,
            last_transition_id, updated_at
          ) VALUES ($projectId, $vaultId, $storeId, $releaseId, 'prepared', 0, NULL, NULL, NULL, $updatedAt)`).run({
            $projectId: expected.projectId, $vaultId: expected.vaultId, $storeId: expected.storeId,
            $releaseId: genesis.releaseId, $updatedAt: genesis.createdAt,
          }));
        },
        insertRelease: (releaseInput: FreshStartRelease): void => {
          requireLive();
          if (installation() === null) fail("FRESH_START_NOT_INITIALIZED");
          writeRelease(releaseInput);
        },
        transition: (input: FreshStartStateChange): FreshStartState => {
          requireLive();
          const change = decodeFreshStartStateChange(input);
          const current = state();
          if (!current) fail("FRESH_START_NOT_INITIALIZED");
          if (current.mode !== change.expectedMode || current.generation !== change.expectedGeneration || current.releaseId !== change.expectedReleaseId) fail("FRESH_START_STALE_STATE");
          if (release(change.nextReleaseId) === null) fail("FRESH_START_RELEASE_MISMATCH");
          const approval = change.authorization.kind === "operator" ? change.authorization : null;
          if (approval) {
            const used = storage(() => this.#connection.prepare("SELECT 1 AS present FROM fresh_start_transitions WHERE project_id = $projectId AND (approval_id = $approvalId OR nonce_digest = $nonceDigest)").get({ $projectId: expected.projectId, $approvalId: approval.approvalId, $nonceDigest: approval.nonceDigest }));
            if (used) fail("FRESH_START_APPROVAL_REUSED");
          }
          const generation = current.generation + 1n;
          storage(() => this.#connection.prepare(`INSERT INTO fresh_start_transitions(
            project_id, transition_id, previous_generation, generation, previous_mode, mode,
            previous_release_id, release_id, authorization_kind, approval_id, nonce_digest,
            actor_fingerprint, request_digest, reason_code, evidence_digest, recovery_position,
            recovery_hash, recorded_at
          ) VALUES ($projectId, $transitionId, $previousGeneration, $generation, $previousMode, $mode,
            $previousReleaseId, $releaseId, $authorizationKind, $approvalId, $nonceDigest,
            $actorFingerprint, $requestDigest, $reasonCode, $evidenceDigest, $recoveryPosition,
            $recoveryHash, $recordedAt)`).run({
            $projectId: expected.projectId, $transitionId: change.transitionId,
            $previousGeneration: current.generation, $generation: generation, $previousMode: current.mode,
            $mode: change.nextMode, $previousReleaseId: current.releaseId, $releaseId: change.nextReleaseId,
            $authorizationKind: change.authorization.kind, $approvalId: approval?.approvalId ?? null,
            $nonceDigest: approval?.nonceDigest ?? null, $actorFingerprint: approval?.actorFingerprint ?? null,
            $requestDigest: approval?.requestDigest ?? null,
            $reasonCode: change.authorization.kind === "automatic-stop" ? change.authorization.reasonCode : null,
            $evidenceDigest: change.evidenceDigest, $recoveryPosition: change.recoveryPosition,
            $recoveryHash: change.recoveryHash, $recordedAt: change.recordedAt,
          }));
          const updated = storage(() => this.#connection.prepare(`UPDATE fresh_start_control_state SET
            release_id = $releaseId, mode = $mode, generation = $generation,
            recovery_position = $recoveryPosition, recovery_hash = $recoveryHash,
            last_transition_id = $transitionId, updated_at = $recordedAt
            WHERE project_id = $projectId AND release_id = $expectedReleaseId AND mode = $expectedMode
              AND generation = $expectedGeneration`).run({
            $releaseId: change.nextReleaseId, $mode: change.nextMode, $generation: generation,
            $recoveryPosition: change.recoveryPosition, $recoveryHash: change.recoveryHash,
            $transitionId: change.transitionId, $recordedAt: change.recordedAt,
            $projectId: expected.projectId, $expectedReleaseId: change.expectedReleaseId,
            $expectedMode: change.expectedMode, $expectedGeneration: change.expectedGeneration,
          }));
          if (updated.changes !== 1n) fail("FRESH_START_STALE_STATE");
          return state()!;
        },
      });
      const result = operation(tx);
      if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
        fail("FRESH_START_ASYNC_TRANSACTION");
      }
      live = false;
      storage(() => this.#connection.exec("COMMIT"));
      begun = false;
      return result;
    } catch (error) {
      live = false;
      if (begun) { try { this.#connection.exec("ROLLBACK"); } catch { /* preserve original error */ } }
      throw error;
    } finally { live = false; this.#inTransaction = false; }
  }
}
