import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { expectedSchemaFingerprint } from "../storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { decodeFreshStartIdentity, FreshStartError, FRESH_START_MAX_GENERATION, type FreshStartIdentity } from "./contracts.js";

export type FreshStartTrustedContext = Readonly<{
  identity: FreshStartIdentity; releaseId: string; measuredBuildHash: string; generation: bigint;
}>;
export type FreshStartAdmissionInput = FreshStartTrustedContext & Readonly<{
  operation: "content-read" | "semantic-mutation" | "command-recovery";
}>;
export type FreshStartRecoveryFence = Readonly<{
  identity: FreshStartIdentity; releaseId: string; generation: bigint; eventPosition: bigint; eventHash: string;
}>;
export type FreshStartAdmission = FreshStartRecoveryFence;
const contexts = new WeakMap<SqliteConnection, FreshStartTrustedContext>();
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code: ConstructorParameters<typeof FreshStartError>[0]): never { throw new FreshStartError(code); }
export function snapshotFreshStartContext(value: FreshStartTrustedContext): FreshStartTrustedContext {
  if (!value || !UUID.test(value.releaseId) || !HASH.test(value.measuredBuildHash)
    || typeof value.generation !== "bigint" || value.generation < 0n || value.generation > FRESH_START_MAX_GENERATION) fail("FRESH_START_INPUT_INVALID");
  return Object.freeze({ identity: decodeFreshStartIdentity(value.identity), releaseId: value.releaseId,
    measuredBuildHash: value.measuredBuildHash, generation: value.generation });
}
/** Trusted server composition only. Never sourced from a public command or tool argument. */
export function bindFreshStartAdmissionContext(connection: SqliteConnection, input: FreshStartTrustedContext): void {
  if (contexts.has(connection)) fail("FRESH_START_CONTEXT_REQUIRED");
  contexts.set(connection, snapshotFreshStartContext(input));
}
function installation(connection: SqliteConnection): SqliteRow | undefined {
  const exists = connection.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'fresh_start_installation'").get();
  return exists ? connection.prepare("SELECT * FROM fresh_start_installation").get() : undefined;
}
function state(connection: SqliteConnection, identity: FreshStartIdentity): SqliteRow {
  const receipt = installation(connection);
  if (!receipt) fail("FRESH_START_NOT_INITIALIZED");
  const meta = connection.prepare("SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1").get();
  for (const row of [receipt, meta]) {
    if (!row || row.project_id !== identity.projectId || row.vault_id !== identity.vaultId || row.store_id !== identity.storeId) fail("FRESH_START_IDENTITY_MISMATCH");
  }
  const current = connection.prepare("SELECT * FROM fresh_start_control_state WHERE project_id = $projectId").get({ $projectId: identity.projectId });
  if (!current || typeof current.generation !== "bigint" || typeof current.release_id !== "string") fail("FRESH_START_STORAGE_FAILURE");
  return current;
}
function tail(connection: SqliteConnection): { eventPosition: bigint; eventHash: string } {
  const row = connection.prepare("SELECT global_position, event_hash FROM events ORDER BY global_position DESC LIMIT 1").get();
  if (!row) return { eventPosition: 0n, eventHash: "0".repeat(64) };
  if (typeof row.global_position !== "bigint" || row.global_position < 1n || typeof row.event_hash !== "string" || !HASH.test(row.event_hash)) fail("FRESH_START_STORAGE_FAILURE");
  return { eventPosition: row.global_position, eventHash: row.event_hash };
}
export class FreshStartAdmissionGuard {
  constructor(private readonly connection: SqliteConnection) {}
  assertRequestAllowed(input: FreshStartAdmissionInput): FreshStartAdmission {
    const trusted = snapshotFreshStartContext(input);
    const current = state(this.connection, trusted.identity);
    if (current.release_id !== trusted.releaseId) fail("FRESH_START_RELEASE_MISMATCH");
    const release = this.connection.prepare("SELECT build_identity_hash, schema_identity_hash FROM fresh_start_releases WHERE project_id = $projectId AND release_id = $releaseId").get({ $projectId: trusted.identity.projectId, $releaseId: trusted.releaseId });
    if (!release || release.build_identity_hash !== trusted.measuredBuildHash) fail("FRESH_START_BUILD_MISMATCH");
    if (release.schema_identity_hash !== expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)) fail("FRESH_START_SCHEMA_MISMATCH");
    if (input.operation === "content-read") fail("FRESH_START_CONTENT_UNVERIFIED");
    if (input.operation !== "command-recovery" && current.generation !== trusted.generation) fail("FRESH_START_ADMISSION_STALE");
    if (input.operation === "command-recovery" && trusted.generation > (current.generation as bigint)) fail("FRESH_START_ADMISSION_STALE");
    if (input.operation !== "semantic-mutation" && input.operation !== "command-recovery") fail("FRESH_START_INPUT_INVALID");
    if (current.mode !== "active" && !(input.operation === "command-recovery" && current.mode === "read-only-recovery")) fail("FRESH_START_ADMISSION_DENIED");
    const fence = tail(this.connection);
    if (current.mode === "read-only-recovery" && (current.recovery_position !== fence.eventPosition || current.recovery_hash !== fence.eventHash)) fail("FRESH_START_RECOVERY_REQUIRED");
    return Object.freeze({ identity: trusted.identity, releaseId: trusted.releaseId, generation: current.generation as bigint, ...fence });
  }
  assertMutationAllowed(input: FreshStartAdmissionInput): void {
    this.assertRequestAllowed({ ...input, operation: "semantic-mutation" });
  }
  /** Called only by the owning writer transaction; never opens or commits a transaction. */
  captureRecoveryFence(identity: FreshStartIdentity, expectedGeneration: bigint): FreshStartRecoveryFence {
    const expected = decodeFreshStartIdentity(identity);
    const current = state(this.connection, expected);
    if (current.generation !== expectedGeneration) fail("FRESH_START_ADMISSION_STALE");
    return Object.freeze({ identity: expected, releaseId: current.release_id as string, generation: expectedGeneration, ...tail(this.connection) });
  }
}
/** Every authoritative transaction checks here; legacy stores retain their existing policy. */
export function assertFreshStartConnectionAllowed(connection: SqliteConnection, operation: FreshStartAdmissionInput["operation"]): void {
  const context = contexts.get(connection);
  if (!context) {
    if (installation(connection)) fail("FRESH_START_CONTEXT_REQUIRED");
    return;
  }
  new FreshStartAdmissionGuard(connection).assertRequestAllowed({ ...context, operation });
}
/** Only lease methods without semantic, authority, or materialization effects may call this. */
export function assertFreshStartHousekeepingAllowed(connection: SqliteConnection): void {
  assertFreshStartConnectionAllowed(connection, "command-recovery");
}
export function isFreshStartConnection(connection: SqliteConnection): boolean {
  return contexts.has(connection) || installation(connection) !== undefined;
}
