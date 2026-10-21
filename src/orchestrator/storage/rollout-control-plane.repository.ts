import {
  decodeRolloutRevision,
  RolloutControlPlaneError,
  type RolloutMode,
  type RolloutRevision,
} from "../rollout/rollout-cohort.js";
import type { SqliteConnection, SqliteParams } from "./sqlite-driver.js";

export interface RolloutControlState {
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly mode: RolloutMode;
  readonly stateGeneration: bigint;
  readonly lastTransitionId: string | null;
  readonly updatedAt: string;
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

export interface RolloutControlPlaneTransaction {
  readState(): RolloutControlState;
  readRevision(revisionId: string): RolloutRevision | null;
  insertRevision(revision: RolloutRevision): void;
  appendTransition(transition: RolloutTransition): void;
  compareAndSetState(input: RolloutStateCasInput): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_GENERATION = 9223372036854775807n;
const MODES: readonly string[] = ["off", "shadow", "canary", "primary", "rollback-pending", "read-only-recovery"];
const TRANSITION_KEYS = [
  "projectId", "transitionId", "revisionId", "fromMode", "toMode",
  "priorStateGeneration", "nextStateGeneration", "approvalId", "approvalNonceDigest",
  "actorFingerprint", "evidenceDigest", "reasonCode", "recordedAt",
] as const;
const CAS_KEYS = [
  "expectedMode", "expectedGeneration", "revisionId", "nextMode", "nextGeneration", "transitionId", "updatedAt",
] as const;
const STATE_COLUMNS = [
  "singleton", "project_id", "active_revision_id", "mode", "state_generation", "last_transition_id", "updated_at",
] as const;
const REVISION_COLUMNS = [
  "project_id", "revision_id", "parent_revision_id", "build_identity_hash", "migration_identity_hash",
  "configuration_checksum", "v1_baseline_checksum", "cohort_algorithm_version", "cohort_salt",
  "cohort_basis_points", "created_at",
] as const;
const activeConnections = new WeakSet<SqliteConnection>();
const poisonedConnections = new WeakSet<SqliteConnection>();

export class SqliteRolloutControlPlaneRepository {
  public constructor(private readonly connection: SqliteConnection) {}

  public transact<T>(projectId: string, callback: (transaction: RolloutControlPlaneTransaction) => T): T {
    if (poisonedConnections.has(this.connection)) fail("ROLLOUT_INTEGRITY_FAILURE");
    uuid(projectId);
    if (typeof callback !== "function") invalid();
    if (activeConnections.has(this.connection)) fail("ROLLOUT_STATE_CONFLICT");
    activeConnections.add(this.connection);
    let begun = false;
    let active = false;
    const guard = (): void => {
      if (!active) fail("ROLLOUT_STATE_CONFLICT");
    };
    const readState = (): RolloutControlState => {
      guard();
      const row = this.connection.prepare(`SELECT ${STATE_COLUMNS.join(", ")}
        FROM rollout_control_state WHERE singleton = 1`).get();
      return stored(() => {
        const value = record(row, STATE_COLUMNS, true);
        if (value.singleton !== 1n) invalid();
        const state = Object.freeze({
          projectId: uuid(value.project_id),
          revisionId: nullableUuid(value.active_revision_id),
          mode: mode(value.mode),
          stateGeneration: generation(value.state_generation),
          lastTransitionId: nullableUuid(value.last_transition_id),
          updatedAt: timestamp(value.updated_at),
        });
        if (state.projectId !== projectId) invalid();
        revisionForMode(state.revisionId, state.mode);
        if ((state.stateGeneration === 0n) !== (state.lastTransitionId === null)) invalid();
        if (state.stateGeneration === 0n && state.mode !== "off") invalid();
        return state;
      });
    };
    const transaction: RolloutControlPlaneTransaction = Object.freeze({
      readState,
      readRevision: (revisionId: string): RolloutRevision | null => {
        guard();
        uuid(revisionId);
        const row = this.connection.prepare(`SELECT ${REVISION_COLUMNS.join(", ")}
          FROM rollout_revisions WHERE project_id = $projectId AND revision_id = $revisionId`)
          .get({ $projectId: projectId, $revisionId: revisionId });
        if (row === undefined) return null;
        return stored(() => {
          const value = record(row, REVISION_COLUMNS, true);
          const algorithm = generation(value.cohort_algorithm_version);
          const basisPoints = generation(value.cohort_basis_points);
          if (algorithm !== 1n || basisPoints > 10000n) invalid();
          const revision = decodeRolloutRevision({
            projectId: value.project_id,
            revisionId: value.revision_id,
            parentRevisionId: value.parent_revision_id,
            buildIdentityHash: value.build_identity_hash,
            migrationIdentityHash: value.migration_identity_hash,
            configurationChecksum: value.configuration_checksum,
            v1BaselineChecksum: value.v1_baseline_checksum,
            cohortAlgorithmVersion: Number(algorithm),
            cohortSalt: value.cohort_salt,
            cohortBasisPoints: Number(basisPoints),
            createdAt: value.created_at,
          });
          if (revision.projectId !== projectId || revision.revisionId !== revisionId
            || revision.parentRevisionId === revision.revisionId) invalid();
          return revision;
        });
      },
      insertRevision: (input: RolloutRevision): void => {
        guard();
        const revision = decodeRolloutRevision(input);
        if (revision.projectId !== projectId) fail("ROLLOUT_SCOPE_DENIED");
        if (revision.parentRevisionId === revision.revisionId) invalid();
        this.insert(`INSERT INTO rollout_revisions (${REVISION_COLUMNS.join(", ")})
          VALUES ($projectId, $revisionId, $parentRevisionId, $buildIdentityHash,
            $migrationIdentityHash, $configurationChecksum, $v1BaselineChecksum,
            $cohortAlgorithmVersion, $cohortSalt, $cohortBasisPoints, $createdAt)`, {
          $projectId: projectId, $revisionId: revision.revisionId,
          $parentRevisionId: revision.parentRevisionId, $buildIdentityHash: revision.buildIdentityHash,
          $migrationIdentityHash: revision.migrationIdentityHash, $configurationChecksum: revision.configurationChecksum,
          $v1BaselineChecksum: revision.v1BaselineChecksum, $cohortAlgorithmVersion: revision.cohortAlgorithmVersion,
          $cohortSalt: revision.cohortSalt, $cohortBasisPoints: revision.cohortBasisPoints, $createdAt: revision.createdAt,
        });
      },
      appendTransition: (input: RolloutTransition): void => {
        guard();
        const transition = decodeTransition(input);
        if (transition.projectId !== projectId) fail("ROLLOUT_SCOPE_DENIED");
        this.insert(`INSERT INTO rollout_transitions (
          project_id, transition_id, revision_id, from_mode, to_mode,
          prior_state_generation, next_state_generation, approval_id, approval_nonce_digest,
          actor_fingerprint, evidence_digest, reason_code, recorded_at
        ) VALUES ($projectId, $transitionId, $revisionId, $fromMode, $toMode,
          $priorStateGeneration, $nextStateGeneration, $approvalId, $approvalNonceDigest,
          $actorFingerprint, $evidenceDigest, $reasonCode, $recordedAt)`, {
          $projectId: projectId, $transitionId: transition.transitionId, $revisionId: transition.revisionId,
          $fromMode: transition.fromMode, $toMode: transition.toMode,
          $priorStateGeneration: transition.priorStateGeneration, $nextStateGeneration: transition.nextStateGeneration,
          $approvalId: transition.approvalId, $approvalNonceDigest: transition.approvalNonceDigest,
          $actorFingerprint: transition.actorFingerprint, $evidenceDigest: transition.evidenceDigest,
          $reasonCode: transition.reasonCode, $recordedAt: transition.recordedAt,
        });
      },
      compareAndSetState: (input: RolloutStateCasInput): void => {
        guard();
        const value = decodeCas(input);
        const result = this.connection.prepare(`UPDATE rollout_control_state
          SET active_revision_id = $revisionId, mode = $nextMode, state_generation = $nextGeneration,
            last_transition_id = $transitionId, updated_at = $updatedAt
          WHERE singleton = 1 AND project_id = $projectId
            AND mode = $expectedMode AND state_generation = $expectedGeneration`).run({
          $projectId: projectId, $revisionId: value.revisionId, $nextMode: value.nextMode,
          $nextGeneration: value.nextGeneration, $transitionId: value.transitionId, $updatedAt: value.updatedAt,
          $expectedMode: value.expectedMode, $expectedGeneration: value.expectedGeneration,
        });
        if (result.changes === 0n) fail("ROLLOUT_STATE_CONFLICT");
        if (result.changes !== 1n) fail("ROLLOUT_INTEGRITY_FAILURE");
        const state = readState();
        if (state.revisionId !== value.revisionId || state.mode !== value.nextMode
          || state.stateGeneration !== value.nextGeneration || state.lastTransitionId !== value.transitionId
          || state.updatedAt !== value.updatedAt) fail("ROLLOUT_INTEGRITY_FAILURE");
      },
    });
    try {
      this.connection.exec("BEGIN IMMEDIATE");
      begun = true;
      active = true;
      readState();
      let result: T;
      try {
        result = callback(transaction);
      } finally {
        active = false;
      }
      synchronous(result);
      this.connection.exec("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try {
          this.connection.exec("ROLLBACK");
        } catch {
          poisonedConnections.add(this.connection);
          // Rollback can itself fail; the operation's original failure remains authoritative.
        }
      }
      throw error;
    } finally {
      active = false;
      activeConnections.delete(this.connection);
    }
  }

  private insert(sql: string, params: SqliteParams): void {
    try {
      const result = this.connection.prepare(sql).run(params);
      if (result.changes !== 1n) fail("ROLLOUT_INTEGRITY_FAILURE");
    } catch (error) {
      if (error instanceof Error && (error.message === "ROLLOUT_IMMUTABLE"
        || /^UNIQUE constraint failed: rollout_(?:revisions|transitions)\./.test(error.message))) {
        fail("ROLLOUT_STATE_CONFLICT");
      }
      throw error;
    }
  }
}

function record(input: unknown, keys: readonly string[], row = false): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && !(row && prototype === null)) invalid();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function decodeTransition(input: unknown): RolloutTransition {
  try {
    const value = record(input, TRANSITION_KEYS);
    const transition: RolloutTransition = {
      projectId: uuid(value.projectId), transitionId: uuid(value.transitionId), revisionId: nullableUuid(value.revisionId),
      fromMode: mode(value.fromMode), toMode: mode(value.toMode),
      priorStateGeneration: generation(value.priorStateGeneration), nextStateGeneration: generation(value.nextStateGeneration),
      approvalId: uuid(value.approvalId), approvalNonceDigest: hash(value.approvalNonceDigest),
      actorFingerprint: hash(value.actorFingerprint), evidenceDigest: hash(value.evidenceDigest),
      reasonCode: reason(value.reasonCode), recordedAt: timestamp(value.recordedAt),
    };
    consecutive(transition.priorStateGeneration, transition.nextStateGeneration);
    revisionForMode(transition.revisionId, transition.toMode);
    return Object.freeze(transition);
  } catch {
    return invalid();
  }
}

function decodeCas(input: unknown): RolloutStateCasInput {
  try {
    const value = record(input, CAS_KEYS);
    const cas: RolloutStateCasInput = {
      expectedMode: mode(value.expectedMode), expectedGeneration: generation(value.expectedGeneration),
      revisionId: nullableUuid(value.revisionId), nextMode: mode(value.nextMode),
      nextGeneration: generation(value.nextGeneration), transitionId: uuid(value.transitionId), updatedAt: timestamp(value.updatedAt),
    };
    consecutive(cas.expectedGeneration, cas.nextGeneration);
    revisionForMode(cas.revisionId, cas.nextMode);
    return Object.freeze(cas);
  } catch {
    return invalid();
  }
}

function synchronous(value: unknown): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  try {
    if (value instanceof Promise) {
      void Promise.prototype.then.call(value, undefined, () => undefined);
      invalid();
    }
    if (typeof Reflect.get(value, "then") === "function") invalid();
  } catch {
    invalid();
  }
}

function stored<T>(decode: () => T): T {
  try { return decode(); } catch { return fail("ROLLOUT_INTEGRITY_FAILURE"); }
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) invalid();
  return value;
}
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function hash(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !HASH.test(value)) invalid();
  return value;
}
function mode(value: unknown): RolloutMode {
  if (typeof value !== "string" || !MODES.includes(value)) invalid();
  return value as RolloutMode;
}
function generation(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_GENERATION) invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24 || !TIMESTAMP.test(value)) invalid();
  if (new Date(value).toISOString() !== value) invalid();
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function consecutive(prior: bigint, next: bigint): void { if (next !== prior + 1n) invalid(); }
function revisionForMode(revisionId: string | null, nextMode: RolloutMode): void {
  if ((revisionId === null) !== (nextMode === "off")) invalid();
}
function fail(code: RolloutControlPlaneError["code"]): never { throw new RolloutControlPlaneError(code); }
function invalid(): never { return fail("ROLLOUT_INPUT_INVALID"); }
