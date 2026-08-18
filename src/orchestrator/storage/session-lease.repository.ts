import { LifecycleError } from "../lifecycle/errors.js";
import type { ProjectId } from "../identity/contracts.js";
import type { SessionId } from "../lifecycle/contracts/identifiers.js";
import {
  NO_LIFECYCLE_FAULTS,
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
} from "../lifecycle/lifecycle-faults.js";
import { MAX_CANONICAL_TIMESTAMP_MS } from "../runtime/clock.js";
import type {
  RootLeaseInsert,
  RootLeaseRecord,
  RootLeaseRelease,
  RootLeaseRenewal,
} from "./lifecycle-storage.types.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LEASE_COLUMNS = [
  "project_id", "session_id", "owner_generation", "owner_client_instance_id",
  "acquired_at", "renewed_at", "last_observed_at_ms", "expires_at", "released_at",
] as const;
const WRITE_KEYS = [
  "projectId", "sessionId", "ownerGeneration", "ownerClientInstanceId",
  "observedNowMs", "leaseDurationMs",
] as const;
const RELEASE_KEYS = [
  "projectId", "sessionId", "ownerGeneration", "ownerClientInstanceId",
  "expectedLastObservedAtMs", "expectedExpiresAtMs", "observedNowMs",
] as const;

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function exact(record: object, keys: readonly string[]): void {
  const prototype = Object.getPrototypeOf(record) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
}

function data(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  return descriptor.value;
}

function exactRow(row: SqliteRow, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(row);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) integrity();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) integrity();
  }
}

function rowData(row: SqliteRow, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) integrity();
  return descriptor.value;
}

function uuid(value: unknown, failure: () => never): string {
  if (typeof value !== "string" || !LOWER_UUID.test(value)) failure();
  return value;
}

function bounded(value: unknown, failure: () => never): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 256) failure();
  return value;
}

function int64(value: unknown, allowZero: boolean, failure: () => never): bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > SQLITE_INT64_MAX) failure();
  return value;
}

function timestamp(milliseconds: bigint, failure: () => never): string {
  if (milliseconds < 0n || milliseconds > MAX_CANONICAL_TIMESTAMP_MS) failure();
  return new Date(Number(milliseconds)).toISOString();
}

function milliseconds(value: unknown): bigint {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) integrity();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) integrity();
  return BigInt(parsed);
}

function checkedExpiry(effectiveNowMs: bigint, durationMs: bigint): bigint {
  if (durationMs < 1n || durationMs > SQLITE_INT64_MAX) invalid();
  const expiry = effectiveNowMs + durationMs;
  if (expiry > MAX_CANONICAL_TIMESTAMP_MS || expiry > SQLITE_INT64_MAX) invalid();
  return expiry;
}

function decode(row: SqliteRow): RootLeaseRecord {
  exactRow(row, LEASE_COLUMNS);
  const acquiredAtMs = milliseconds(rowData(row, "acquired_at"));
  const renewedAtMs = milliseconds(rowData(row, "renewed_at"));
  const lastObservedAtMs = int64(rowData(row, "last_observed_at_ms"), true, integrity);
  const expiresAtMs = milliseconds(rowData(row, "expires_at"));
  const released = rowData(row, "released_at");
  const releasedAtMs = released === null ? null : milliseconds(released);
  if (lastObservedAtMs > MAX_CANONICAL_TIMESTAMP_MS
    || acquiredAtMs > renewedAtMs || renewedAtMs > lastObservedAtMs
    || expiresAtMs <= renewedAtMs || (releasedAtMs !== null && releasedAtMs < lastObservedAtMs)) integrity();
  return Object.freeze({
    projectId: uuid(rowData(row, "project_id"), integrity),
    sessionId: uuid(rowData(row, "session_id"), integrity),
    ownerGeneration: int64(rowData(row, "owner_generation"), false, integrity),
    ownerClientInstanceId: bounded(rowData(row, "owner_client_instance_id"), integrity),
    acquiredAtMs,
    renewedAtMs,
    lastObservedAtMs,
    expiresAtMs,
    releasedAtMs,
  });
}

function validateWrite(source: RootLeaseInsert | RootLeaseRenewal): void {
  if (typeof source !== "object" || source === null || Array.isArray(source)) invalid();
  exact(source, WRITE_KEYS);
  uuid(data(source, "projectId"), invalid);
  uuid(data(source, "sessionId"), invalid);
  int64(data(source, "ownerGeneration"), false, invalid);
  bounded(data(source, "ownerClientInstanceId"), invalid);
  const observed = int64(data(source, "observedNowMs"), true, invalid);
  if (observed > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  checkedExpiry(observed, int64(data(source, "leaseDurationMs"), false, invalid));
}

function validateRelease(source: RootLeaseRelease): void {
  if (typeof source !== "object" || source === null || Array.isArray(source)) invalid();
  exact(source, RELEASE_KEYS);
  uuid(data(source, "projectId"), invalid);
  uuid(data(source, "sessionId"), invalid);
  int64(data(source, "ownerGeneration"), false, invalid);
  bounded(data(source, "ownerClientInstanceId"), invalid);
  for (const key of ["expectedLastObservedAtMs", "expectedExpiresAtMs", "observedNowMs"] as const) {
    const value = int64(data(source, key), true, invalid);
    if (value > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  }
  if (source.expectedExpiresAtMs <= source.expectedLastObservedAtMs) invalid();
}

function authorityMatches(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  generation: bigint,
): boolean {
  const columns = ["session_kind", "semantic_state", "owner_generation", "terminal_event_position"] as const;
  const row = connection.prepare(`
    SELECT ${columns.join(", ")}
    FROM session_authority
    WHERE project_id = $projectId AND session_id = $sessionId
  `).get({ $projectId: projectId, $sessionId: sessionId });
  if (row === undefined) return false;
  exactRow(row, columns);
  const terminal = rowData(row, "terminal_event_position");
  const semanticState = rowData(row, "semantic_state");
  return rowData(row, "session_kind") === "root"
    && rowData(row, "owner_generation") === generation
    && terminal === null
    && (semanticState === "active" || semanticState === "suspended" || semanticState === "ending");
}

function byGeneration(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  generation: bigint,
): RootLeaseRecord | null {
  const row = connection.prepare(`
    SELECT ${LEASE_COLUMNS.join(", ")}
    FROM session_leases
    WHERE project_id = $projectId AND session_id = $sessionId
      AND owner_generation = $ownerGeneration
  `).get({ $projectId: projectId, $sessionId: sessionId, $ownerGeneration: generation });
  return row === undefined ? null : decode(row);
}

function priorGeneration(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
): RootLeaseRecord | null {
  const row = connection.prepare(`
    SELECT ${LEASE_COLUMNS.join(", ")}
    FROM session_leases
    WHERE project_id = $projectId AND session_id = $sessionId
    ORDER BY owner_generation DESC
    LIMIT 1
  `).get({ $projectId: projectId, $sessionId: sessionId });
  return row === undefined ? null : decode(row);
}

function leaseFaultContext(input: {
  readonly projectId: string;
  readonly sessionId: string;
}): LifecycleFaultContext {
  return Object.freeze({
    projectId: input.projectId as ProjectId,
    sessionId: input.sessionId as SessionId,
    workflowId: null,
    commandId: null,
    idempotencyKeyHash: null,
    workId: null,
    eventPosition: null,
    materializationRevision: null,
  });
}

export class SessionLeaseRepository {
  readonly #faults: LifecycleFaultInjector;

  constructor(options: { readonly faultInjector?: LifecycleFaultInjector } = {}) {
    this.#faults = options.faultInjector ?? NO_LIFECYCLE_FAULTS;
  }

  current(
    connection: SqliteConnection,
    projectId: string,
    sessionId: string,
  ): RootLeaseRecord | null {
    uuid(projectId, invalid);
    uuid(sessionId, invalid);
    const row = connection.prepare(`
      SELECT ${LEASE_COLUMNS.join(", ")}
      FROM session_leases
      WHERE project_id = $projectId AND session_id = $sessionId
        AND released_at IS NULL
    `).get({ $projectId: projectId, $sessionId: sessionId });
    return row === undefined ? null : decode(row);
  }

  isExpired(lease: RootLeaseRecord, observedNowMs: bigint): boolean {
    if (observedNowMs < 0n || observedNowMs > MAX_CANONICAL_TIMESTAMP_MS) invalid();
    return lease.expiresAtMs <= (observedNowMs > lease.lastObservedAtMs
      ? observedNowMs
      : lease.lastObservedAtMs);
  }

  insertGeneration(connection: SqliteConnection, input: RootLeaseInsert): RootLeaseRecord {
    validateWrite(input);
    if (!authorityMatches(connection, input.projectId, input.sessionId, input.ownerGeneration)) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (this.current(connection, input.projectId, input.sessionId) !== null) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    const prior = priorGeneration(connection, input.projectId, input.sessionId);
    if ((prior === null && input.ownerGeneration !== 1n)
      || (prior !== null && (
        prior.releasedAtMs === null
        || input.ownerGeneration !== prior.ownerGeneration + 1n
      ))) throw new LifecycleError("EVENT_CONFLICT");
    const effectiveNowMs = prior !== null && prior.lastObservedAtMs > input.observedNowMs
      ? prior.lastObservedAtMs
      : input.observedNowMs;
    const expiresAtMs = checkedExpiry(effectiveNowMs, input.leaseDurationMs);
    const faultContext = leaseFaultContext(input);
    this.#faults.hit("lease-update", "before-write", faultContext);
    try {
      const result = connection.prepare(`
        INSERT INTO session_leases(
          project_id, session_id, owner_generation, owner_client_instance_id,
          acquired_at, renewed_at, last_observed_at_ms, expires_at, released_at
        ) VALUES (
          $projectId, $sessionId, $ownerGeneration, $ownerClientInstanceId,
          $acquiredAt, $renewedAt, $lastObservedAtMs, $expiresAt, NULL
        )
      `).run({
        $projectId: input.projectId,
        $sessionId: input.sessionId,
        $ownerGeneration: input.ownerGeneration,
        $ownerClientInstanceId: input.ownerClientInstanceId,
        $acquiredAt: timestamp(effectiveNowMs, invalid),
        $renewedAt: timestamp(effectiveNowMs, invalid),
        $lastObservedAtMs: effectiveNowMs,
        $expiresAt: timestamp(expiresAtMs, invalid),
      });
      if (result.changes !== 1n) integrity();
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (this.current(connection, input.projectId, input.sessionId) !== null
        || !authorityMatches(connection, input.projectId, input.sessionId, input.ownerGeneration)) {
        throw new LifecycleError("EVENT_CONFLICT");
      }
      throw error;
    }
    this.#faults.hit("lease-update", "after-write-before-commit", faultContext);
    const inserted = byGeneration(connection, input.projectId, input.sessionId, input.ownerGeneration);
    if (inserted === null || inserted.releasedAtMs !== null) integrity();
    return inserted;
  }

  renewCurrent(connection: SqliteConnection, input: RootLeaseRenewal): RootLeaseRecord {
    validateWrite(input);
    const current = this.current(connection, input.projectId, input.sessionId);
    if (current === null
      || current.ownerGeneration !== input.ownerGeneration
      || current.ownerClientInstanceId !== input.ownerClientInstanceId
      || !authorityMatches(connection, input.projectId, input.sessionId, input.ownerGeneration)) {
      throw new LifecycleError("SESSION_HANDLE_STALE");
    }
    const effectiveNowMs = input.observedNowMs > current.lastObservedAtMs
      ? input.observedNowMs
      : current.lastObservedAtMs;
    const expiresAtMs = checkedExpiry(effectiveNowMs, input.leaseDurationMs);
    const faultContext = leaseFaultContext(input);
    this.#faults.hit("lease-update", "before-write", faultContext);
    const result = connection.prepare(`
      UPDATE session_leases
      SET renewed_at = $renewedAt,
          last_observed_at_ms = $lastObservedAtMs,
          expires_at = $expiresAt
      WHERE project_id = $projectId AND session_id = $sessionId
        AND owner_generation = $ownerGeneration
        AND owner_client_instance_id = $ownerClientInstanceId
        AND released_at IS NULL
        AND last_observed_at_ms = $expectedLastObservedAtMs
        AND expires_at = $expectedExpiresAt
        AND EXISTS (
          SELECT 1 FROM session_authority AS authority
          WHERE authority.project_id = session_leases.project_id
            AND authority.session_id = session_leases.session_id
            AND authority.session_kind = 'root'
            AND authority.owner_generation = session_leases.owner_generation
            AND authority.terminal_event_position IS NULL
        )
    `).run({
      $projectId: input.projectId,
      $sessionId: input.sessionId,
      $ownerGeneration: input.ownerGeneration,
      $ownerClientInstanceId: input.ownerClientInstanceId,
      $expectedLastObservedAtMs: current.lastObservedAtMs,
      $expectedExpiresAt: timestamp(current.expiresAtMs, invalid),
      $renewedAt: timestamp(effectiveNowMs, invalid),
      $lastObservedAtMs: effectiveNowMs,
      $expiresAt: timestamp(expiresAtMs, invalid),
    });
    if (result.changes !== 1n) throw new LifecycleError("SESSION_HANDLE_STALE");
    this.#faults.hit("lease-update", "after-write-before-commit", faultContext);
    const renewed = byGeneration(connection, input.projectId, input.sessionId, input.ownerGeneration);
    if (renewed === null || renewed.releasedAtMs !== null) integrity();
    return renewed;
  }

  releaseCurrent(connection: SqliteConnection, input: RootLeaseRelease): void {
    validateRelease(input);
    const current = byGeneration(
      connection,
      input.projectId,
      input.sessionId,
      input.ownerGeneration,
    );
    if (current === null
      || current.ownerClientInstanceId !== input.ownerClientInstanceId
      || current.releasedAtMs !== null
      || current.lastObservedAtMs !== input.expectedLastObservedAtMs
      || current.expiresAtMs !== input.expectedExpiresAtMs
      || !authorityMatches(connection, input.projectId, input.sessionId, input.ownerGeneration)) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    const effectiveNowMs = input.observedNowMs > input.expectedLastObservedAtMs
      ? input.observedNowMs
      : input.expectedLastObservedAtMs;
    const faultContext = leaseFaultContext(input);
    this.#faults.hit("lease-update", "before-write", faultContext);
    const result = connection.prepare(`
      UPDATE session_leases
      SET last_observed_at_ms = $lastObservedAtMs,
          released_at = $releasedAt
      WHERE project_id = $projectId AND session_id = $sessionId
        AND owner_generation = $ownerGeneration
        AND owner_client_instance_id = $ownerClientInstanceId
        AND released_at IS NULL
        AND last_observed_at_ms = $expectedLastObservedAtMs
        AND expires_at = $expectedExpiresAt
        AND EXISTS (
          SELECT 1 FROM session_authority AS authority
          WHERE authority.project_id = session_leases.project_id
            AND authority.session_id = session_leases.session_id
            AND authority.session_kind = 'root'
            AND authority.owner_generation = session_leases.owner_generation
            AND authority.terminal_event_position IS NULL
        )
    `).run({
      $projectId: input.projectId,
      $sessionId: input.sessionId,
      $ownerGeneration: input.ownerGeneration,
      $ownerClientInstanceId: input.ownerClientInstanceId,
      $expectedLastObservedAtMs: input.expectedLastObservedAtMs,
      $expectedExpiresAt: timestamp(input.expectedExpiresAtMs, invalid),
      $lastObservedAtMs: effectiveNowMs,
      $releasedAt: timestamp(effectiveNowMs, invalid),
    });
    if (result.changes !== 1n) throw new LifecycleError("EVENT_CONFLICT");
    this.#faults.hit("lease-update", "after-write-before-commit", faultContext);
  }
}
