import { decodeFreshStartGenesis, decodeFreshStartIdentity, decodeFreshStartRelease, FreshStartError,
  type FreshStartGenesis, type FreshStartIdentity, type FreshStartMode, type FreshStartRelease, type FreshStartState } from "../fresh-start/contracts.js";
import { parseProjectionManifestV2, type ProjectionManifestV2 } from "../projections/manifest-codec.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { assertBoundSqliteConnectionIdentity } from "../storage/node-sqlite-driver.js";
import { inspectStoreSchema, requireCurrentStoreSchema } from "../storage/schema-compatibility.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import type { ReadFence, VerifiedReadBinding, VerifiedReadRequest } from "./contracts.js";
import { decodeReadBootstrap, decodeVerifiedReadRequest } from "./protocol.js";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITION = /^(0|[1-9][0-9]{0,18})$/u;
const MAX_POSITION = 9_223_372_036_854_775_807n;
function fail(code: ConstructorParameters<typeof FreshStartError>[0]): never { throw new FreshStartError(code); }
function integrity(): never { throw new Error("INTEGRITY_FAILURE"); }
function string(row: SqliteRow, key: string): string {
  if (typeof row[key] !== "string") return fail("FRESH_START_STORAGE_FAILURE");
  return row[key];
}
function integer(row: SqliteRow, key: string): bigint {
  if (typeof row[key] !== "bigint" || row[key] < 0n || row[key] > MAX_POSITION) return fail("FRESH_START_STORAGE_FAILURE");
  return row[key];
}
function nullableString(row: SqliteRow, key: string): string | null { return row[key] === null ? null : string(row, key); }
function nullableInteger(row: SqliteRow, key: string): bigint | null { return row[key] === null ? null : integer(row, key); }
function position(value: unknown): string {
  if (typeof value !== "string" || !POSITION.test(value) || BigInt(value) > MAX_POSITION) return integrity();
  return value;
}
function decoded<T>(operation: () => T): T {
  try { return operation(); } catch { return fail("FRESH_START_STORAGE_FAILURE"); }
}
function readFence(value: ReadFence): ReadFence {
  const keys = ["controlGeneration", "releaseId", "capturedPosition", "capturedHash", "requiredPosition"];
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return integrity();
  const source: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return integrity();
    source[key] = descriptor.value;
  }
  const capturedPosition = position(source.capturedPosition), requiredPosition = position(source.requiredPosition);
  if (BigInt(requiredPosition) < BigInt(capturedPosition) || typeof source.releaseId !== "string"
    || typeof source.capturedHash !== "string" || !HASH.test(source.capturedHash)) return integrity();
  return Object.freeze({ controlGeneration: position(source.controlGeneration), releaseId: source.releaseId,
    capturedPosition, capturedHash: source.capturedHash, requiredPosition });
}

type Authority = Readonly<{ genesis: FreshStartGenesis; position: bigint; hash: string }>;

/** Internal metadata admission only. Caller owns a genuine bound readonly-existing connection,
 * opened with a busy timeout no greater than its original request's remaining budget. */
export class SqliteVerifiedReadAdmission {
  readonly #connection: SqliteConnection;
  readonly #binding: VerifiedReadBinding;
  readonly #measuredBuildHash: string;

  constructor(connection: SqliteConnection, binding: VerifiedReadBinding, independentlyMeasuredBuildHash: string) {
    // Reuse the descriptor-first bounded Task 1 snapshot; the dummy request never reads caller properties.
    this.#binding = decodeReadBootstrap({ version: 1, ids: { requestId: "admission", attemptId: "admission", laneEpoch: "admission" },
      binding, request: { operation: "verify-published-view", consistency: "project-strong", minimumEventPosition: MAX_POSITION.toString(), budgetMs: 0 },
      lockToken: "0".repeat(32), remainingMs: 0 }).binding;
    if (typeof independentlyMeasuredBuildHash !== "string" || !HASH.test(independentlyMeasuredBuildHash)) fail("FRESH_START_BUILD_MISMATCH");
    this.#connection = connection;
    this.#measuredBuildHash = independentlyMeasuredBuildHash;
  }

  capture(request: VerifiedReadRequest): ReadFence {
    const input = decodeVerifiedReadRequest(request, this.#binding.session);
    return this.#snapshot(() => {
      const authority = this.#authority();
      const minimum = BigInt(input.minimumEventPosition);
      const sessionMinimum = BigInt(this.#binding.session?.minimumEventPosition ?? "0");
      const required = [authority.position, minimum, sessionMinimum].reduce((left, right) => left > right ? left : right);
      return Object.freeze({ controlGeneration: this.#binding.controlGeneration, releaseId: this.#binding.expectedRelease.releaseId,
        capturedPosition: authority.position.toString(), capturedHash: authority.hash, requiredPosition: required.toString() });
    });
  }

  revalidate(fence: ReadFence, manifest: ProjectionManifestV2): void {
    this.#snapshot(() => {
      // Mode is observed before comparing a stale fence, so recovery never acquires a read receipt.
      const authority = this.#authority();
      const captured = readFence(fence);
      if (captured.releaseId !== this.#binding.expectedRelease.releaseId) fail("FRESH_START_RELEASE_MISMATCH");
      if (captured.controlGeneration !== this.#binding.controlGeneration) fail("FRESH_START_ADMISSION_STALE");
      let image: ProjectionManifestV2;
      try { image = parseProjectionManifestV2(manifest, this.#binding.projectionBinding); }
      catch { return integrity(); }
      const capturedPosition = BigInt(captured.capturedPosition), imagePosition = BigInt(image.terminalEventPosition);
      if (capturedPosition > authority.position || imagePosition > authority.position) return integrity();
      this.#anchor(capturedPosition, captured.capturedHash, authority.genesis);
      this.#anchor(imagePosition, image.terminalEventHash, authority.genesis);
      if (imagePosition < BigInt(captured.requiredPosition)) throw Object.assign(new Error("PROJECTION_LAG"), {
        code: "PROJECTION_LAG", positions: Object.freeze({ required: captured.requiredPosition, observed: image.terminalEventPosition }),
      });
    });
  }

  #fileIdentity(): void {
    const file = this.#binding.eventsFile;
    try { assertBoundSqliteConnectionIdentity(this.#connection, file.path, file); }
    catch { fail("FRESH_START_PATH_CHANGED"); }
  }

  #snapshot<T>(read: () => T): T {
    this.#fileIdentity();
    let begun = false;
    try {
      this.#connection.exec("BEGIN"); begun = true;
      const result = read();
      this.#fileIdentity();
      this.#connection.exec("COMMIT"); begun = false;
      this.#fileIdentity();
      return result;
    } catch (error) {
      if (begun) {
        try { this.#connection.exec("ROLLBACK"); } catch { /* preserve primary admission/closure failure */ }
      }
      // Observe pathname even on a failed read; preserve the original failure classification.
      try { this.#fileIdentity(); } catch { /* preserve primary failure */ }
      throw error;
    }
  }

  #identity(row: SqliteRow | undefined): FreshStartIdentity {
    const expected = this.#binding.expectedRelease;
    if (!row || row.project_id !== expected.projectId || row.vault_id !== expected.vaultId || row.store_id !== expected.storeId)
      return fail("FRESH_START_IDENTITY_MISMATCH");
    return decoded(() => decodeFreshStartIdentity({ projectId: row.project_id, vaultId: row.vault_id, storeId: row.store_id }));
  }

  #authority(): Authority {
    let schemaHash: string;
    try { schemaHash = requireCurrentStoreSchema(inspectStoreSchema(this.#connection)).observedFingerprint; }
    catch { return fail("FRESH_START_SCHEMA_MISMATCH"); }
    const expected = this.#binding.expectedRelease;
    this.#identity(this.#connection.prepare("SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1").get());
    const params = { $projectId: expected.projectId };
    const installation = this.#connection.prepare("SELECT * FROM fresh_start_installation WHERE project_id = $projectId").get(params);
    if (!installation) return fail("FRESH_START_NOT_INITIALIZED");
    const installedIdentity = this.#identity(installation);
    const genesis = decoded(() => decodeFreshStartGenesis({ ...installedIdentity,
      initializationId: string(installation, "initialization_id"), releaseId: string(installation, "release_id"),
      semanticPosition: integer(installation, "semantic_position").toString(), terminalHash: string(installation, "terminal_hash"),
      projectionChecksums: JSON.parse(string(installation, "projection_checksums_json")) as unknown,
      preparationIntentDigest: string(installation, "preparation_intent_digest"), actorFingerprint: string(installation, "actor_fingerprint"),
      createdAt: string(installation, "created_at") }));
    const stateRow = this.#connection.prepare("SELECT * FROM fresh_start_control_state WHERE project_id = $projectId").get(params);
    if (!stateRow) return fail("FRESH_START_NOT_INITIALIZED");
    const stateIdentity = this.#identity(stateRow);
    const mode = string(stateRow, "mode");
    if (!["prepared", "active", "read-only-recovery", "disabled"].includes(mode)) return fail("FRESH_START_STORAGE_FAILURE");
    const state: FreshStartState = Object.freeze({ ...stateIdentity, mode: mode as FreshStartMode,
      releaseId: string(stateRow, "release_id"), generation: integer(stateRow, "generation"),
      recoveryPosition: nullableInteger(stateRow, "recovery_position"), recoveryHash: nullableString(stateRow, "recovery_hash"),
      lastTransitionId: nullableString(stateRow, "last_transition_id"), updatedAt: string(stateRow, "updated_at") });
    if ((state.recoveryPosition === null) !== (state.recoveryHash === null)
      || (state.recoveryHash !== null && !HASH.test(state.recoveryHash))
      || (state.generation === 0n) !== (state.lastTransitionId === null)
      || (state.lastTransitionId !== null && !UUID.test(state.lastTransitionId))
      || state.updatedAt.length !== 24 || !Number.isFinite(Date.parse(state.updatedAt))
      || new Date(state.updatedAt).toISOString() !== state.updatedAt) return fail("FRESH_START_STORAGE_FAILURE");
    if (mode === "read-only-recovery") return fail("FRESH_START_CONTENT_UNVERIFIED");
    if (mode === "prepared" || mode === "disabled") return fail("FRESH_START_ADMISSION_DENIED");
    if (state.releaseId !== expected.releaseId) return fail("FRESH_START_RELEASE_MISMATCH");
    const row = this.#connection.prepare("SELECT * FROM fresh_start_releases WHERE project_id = $projectId AND release_id = $releaseId")
      .get({ ...params, $releaseId: expected.releaseId });
    if (!row) return fail("FRESH_START_RELEASE_MISMATCH");
    const releaseIdentity = this.#identity(row);
    const release = decoded(() => decodeFreshStartRelease({ ...releaseIdentity, profileVersion: Number(integer(row, "profile_version")),
      releaseId: string(row, "release_id"), buildIdentityHash: string(row, "build_identity_hash"), schemaIdentityHash: string(row, "schema_identity_hash"),
      configurationHash: string(row, "configuration_hash"), capabilityManifestHash: string(row, "capability_manifest_hash"),
      recoveryPolicyHash: string(row, "recovery_policy_hash"), evidenceDigest: string(row, "evidence_digest"), createdAt: string(row, "created_at") }));
    this.#release(release, schemaHash);
    if (state.generation.toString() !== this.#binding.controlGeneration) return fail("FRESH_START_ADMISSION_STALE");
    const tail = this.#connection.prepare("SELECT global_position, event_hash FROM events ORDER BY global_position DESC LIMIT 1").get();
    if (!tail) return Object.freeze({ genesis, position: 0n, hash: GENESIS_GLOBAL_HASH });
    const tailPosition = integer(tail, "global_position"), hash = string(tail, "event_hash");
    if (tailPosition < 1n || !HASH.test(hash)) return integrity();
    this.#anchor(tailPosition, hash, genesis);
    return Object.freeze({ genesis, position: tailPosition, hash });
  }

  #release(release: FreshStartRelease, schemaHash: string): void {
    const expected = this.#binding.expectedRelease;
    if (release.buildIdentityHash !== this.#measuredBuildHash || expected.buildIdentityHash !== this.#measuredBuildHash)
      fail("FRESH_START_BUILD_MISMATCH");
    if (release.schemaIdentityHash !== schemaHash || expected.schemaIdentityHash !== schemaHash) fail("FRESH_START_SCHEMA_MISMATCH");
    for (const key of ["profileVersion", "releaseId", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest", "createdAt"] as const)
      if (release[key] !== expected[key]) fail("FRESH_START_RELEASE_MISMATCH");
  }

  #anchor(eventPosition: bigint, hash: string, genesis: FreshStartGenesis): void {
    if (eventPosition === 0n) {
      if (hash !== genesis.terminalHash || hash !== GENESIS_GLOBAL_HASH) return integrity();
      return;
    }
    const row = this.#connection.prepare("SELECT project_id, vault_id, store_id, global_position, event_hash FROM events WHERE global_position = $position")
      .get({ $position: eventPosition });
    if (!row || row.global_position !== eventPosition || row.event_hash !== hash) return integrity();
    this.#identity(row);
  }
}
