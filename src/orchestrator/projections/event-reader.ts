import type { ReadonlyJsonValue, StoredEvent } from "../contracts/event.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-store.js";
import type {
  SqliteConnection,
  SqliteDriver,
  SqliteRow,
  SqliteValue,
} from "../storage/sqlite-driver.js";
import type { ProjectBinding } from "./contracts.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const MAX_INTEGRITY_REPLAY_EVENTS = 100_000;
export const MAX_INTEGRITY_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_INTEGRITY_EVENT_BYTES = 1024 * 1024;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const EVENT_FIELDS = Object.freeze([
  "global_position", "event_id", "project_id", "vault_id", "store_id", "workspace_id",
  "branch_scope_id", "branch_ref", "stream_id", "stream_type", "stream_version",
  "event_type", "event_schema_version", "session_id", "parent_session_id",
  "actor_role", "agent_id", "client_instance_id", "correlation_id", "causation_id",
  "command_id", "idempotency_key", "command_event_index", "occurred_at", "recorded_at",
  "visibility_scope", "confidence", "verification_status", "source_refs_json",
  "evidence_refs_json", "evidence_digests_json", "payload_json", "payload_hash",
  "previous_global_hash", "event_hash", "lifecycle_intent_json",
] as const);
const EVENT_COLUMNS = EVENT_FIELDS.join(", ");
const EVENT_ROW_BYTE_EXPRESSION = EVENT_FIELDS.map((field) => `
  CASE
    WHEN ${field} IS NULL THEN 8
    WHEN typeof(${field}) IN ('text', 'blob') THEN length(CAST(${field} AS BLOB))
    ELSE 8
  END
`).join(" + ");

export interface ProjectionEventSnapshot {
  readonly binding: ProjectBinding;
  readonly events: readonly StoredEvent[];
  readonly terminalEventPosition: bigint;
  readonly terminalEventHash: string;
  close(): void;
}

export interface ProjectionEventReader {
  openCommittedSnapshot(binding: ProjectBinding): Promise<ProjectionEventSnapshot>;
}

export interface SqliteProjectionEventReaderOptions {
  readonly driver: SqliteDriver;
  readonly eventStorePath: string;
  readonly busyTimeoutMs?: number;
}

export interface CommittedProjectionSnapshotOptions extends SqliteProjectionEventReaderOptions {
  readonly terminalEventPosition?: bigint;
}

export interface CommittedProjectionReplayOptions extends SqliteProjectionEventReaderOptions {
  readonly terminalEventPosition: bigint;
  readonly maxEvents?: number;
  readonly maxAggregateBytes?: number;
}

export interface CommittedProjectionReplayResult {
  readonly eventCount: number;
  readonly aggregateBytes: number;
  readonly terminalEventPosition: bigint;
  readonly terminalEventHash: string;
}

function integrity(): never {
  throw new Error("INTEGRITY_FAILURE");
}

function string(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") return integrity();
  return value;
}

function nullableString(row: SqliteRow, field: string): string | null {
  return row[field] === null ? null : string(row, field);
}

function bigint(row: SqliteRow, field: string): bigint {
  const value = row[field];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return integrity();
}

function integer(row: SqliteRow, field: string): number {
  const value = bigint(row, field);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return integrity();
  return Number(value);
}

function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return integrity();
  }
}

function stringArray(row: SqliteRow, field: string): readonly string[] {
  const value = json(string(row, field));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return integrity();
  return Object.freeze([...value]);
}

function emptyArray(row: SqliteRow, field: string): readonly [] {
  const value = json(string(row, field));
  if (!Array.isArray(value) || value.length !== 0) return integrity();
  return Object.freeze([]);
}

function bindingParams(binding: ProjectBinding): Record<`$${string}`, SqliteValue> {
  return {
    $projectId: binding.projectId,
    $workspaceId: binding.workspaceId,
    $branchScopeId: binding.branchScopeId,
    $branchRef: binding.branchRef,
  };
}

function validateBinding(binding: ProjectBinding): ProjectBinding {
  if (
    typeof binding !== "object"
    || binding === null
    || !HASH.test(binding.projectId)
    || !HASH.test(binding.vaultId)
    || !HASH.test(binding.storeId)
    || !HASH.test(binding.workspaceId)
    || (binding.branchScopeId !== null && !UUID.test(binding.branchScopeId))
    || (binding.branchRef !== null && (binding.branchRef.length === 0 || binding.branchRef.includes("\0")))
    || binding.sessionId !== null
  ) return integrity();
  return Object.freeze({ ...binding });
}

function storedEvent(row: SqliteRow): StoredEvent {
  const actorRole = string(row, "actor_role");
  const visibilityScope = string(row, "visibility_scope");
  const confidence = string(row, "confidence");
  const verificationStatus = string(row, "verification_status");
  if (
    (actorRole !== "primary" && actorRole !== "maintenance" && actorRole !== "untrusted")
    || (
      visibilityScope !== "session"
      && visibilityScope !== "workspace"
      && visibilityScope !== "branch"
      && visibilityScope !== "project"
    )
    || (confidence !== "high" && confidence !== "medium" && confidence !== "low" && confidence !== "guess")
    || (
      verificationStatus !== "unverified"
      && verificationStatus !== "provisional"
      && verificationStatus !== "verified"
      && verificationStatus !== "conflicted"
    )
  ) return integrity();
  const payloadJson = string(row, "payload_json");
  // The object cache is deliberately content-free. Known-event decoding authenticates
  // and parses payloadJson against payloadHash; it never consumes this redundant cache.
  const payload = Object.freeze({}) as ReadonlyJsonValue;
  const result: StoredEvent = Object.freeze({
    globalPosition: bigint(row, "global_position"),
    eventId: string(row, "event_id"),
    projectId: string(row, "project_id") as StoredEvent["projectId"],
    vaultId: string(row, "vault_id") as StoredEvent["vaultId"],
    storeId: string(row, "store_id") as StoredEvent["storeId"],
    workspaceId: string(row, "workspace_id") as StoredEvent["workspaceId"],
    branchScopeId: nullableString(row, "branch_scope_id") as StoredEvent["branchScopeId"],
    branchRef: nullableString(row, "branch_ref"),
    streamId: string(row, "stream_id"),
    streamType: string(row, "stream_type"),
    streamVersion: bigint(row, "stream_version"),
    eventType: string(row, "event_type"),
    eventSchemaVersion: integer(row, "event_schema_version"),
    sessionId: nullableString(row, "session_id"),
    parentSessionId: nullableString(row, "parent_session_id"),
    actorRole,
    agentId: string(row, "agent_id"),
    clientInstanceId: string(row, "client_instance_id"),
    correlationId: string(row, "correlation_id"),
    causationId: nullableString(row, "causation_id"),
    commandId: string(row, "command_id"),
    idempotencyKey: string(row, "idempotency_key"),
    commandEventIndex: integer(row, "command_event_index"),
    occurredAt: string(row, "occurred_at"),
    recordedAt: string(row, "recorded_at"),
    visibilityScope,
    confidence,
    verificationStatus,
    sourceRefs: stringArray(row, "source_refs_json"),
    evidenceRefs: emptyArray(row, "evidence_refs_json"),
    evidenceDigests: emptyArray(row, "evidence_digests_json"),
    payload,
    payloadJson,
    payloadHash: string(row, "payload_hash"),
    previousGlobalHash: string(row, "previous_global_hash"),
    eventHash: string(row, "event_hash"),
    lifecycleIntentJson: nullableString(row, "lifecycle_intent_json"),
  });
  return result;
}

function sameBinding(event: StoredEvent, expected: ProjectBinding): boolean {
  return event.projectId === expected.projectId
    && event.vaultId === expected.vaultId
    && event.storeId === expected.storeId
    && event.workspaceId === expected.workspaceId
    && event.branchScopeId === expected.branchScopeId
    && event.branchRef === expected.branchRef;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, hardMaximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) return integrity();
  return resolved;
}

function rowBytes(row: SqliteRow): number {
  let bytes = 0;
  for (const value of Object.values(row)) {
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else bytes += 8;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_INTEGRITY_EVENT_BYTES) return integrity();
  }
  return bytes;
}

function preflightReplayRows(
  connection: SqliteConnection,
  binding: ProjectBinding,
  terminalEventPosition: bigint,
  maxEvents: number,
  maxAggregateBytes: number,
): void {
  const row = connection.prepare(`
    SELECT count(*) AS event_count,
           coalesce(max(row_bytes), 0) AS maximum_row_bytes,
           coalesce(sum(row_bytes), 0) AS aggregate_bytes
    FROM (
      SELECT ${EVENT_ROW_BYTE_EXPRESSION} AS row_bytes
      FROM events
      WHERE project_id = $projectId
        AND workspace_id = $workspaceId
        AND (
          (branch_scope_id IS NULL AND $branchScopeId IS NULL)
          OR branch_scope_id = $branchScopeId
        )
        AND (
          (branch_ref IS NULL AND $branchRef IS NULL)
          OR branch_ref = $branchRef
        )
        AND global_position <= $terminalEventPosition
    )
  `).get({
    ...bindingParams(binding),
    $terminalEventPosition: terminalEventPosition,
  });
  if (
    row === undefined
    || bigint(row, "event_count") > BigInt(maxEvents)
    || bigint(row, "maximum_row_bytes") > BigInt(MAX_INTEGRITY_EVENT_BYTES)
    || bigint(row, "aggregate_bytes") > BigInt(maxAggregateBytes)
  ) return integrity();
}

/**
 * Reads one authenticated event row at a time in authoritative position order.
 * The callback is invoked synchronously before SQLite advances the iterator, so
 * replay retains at most one source row plus its aggregate working state.
 */
export function replayCommittedProjectionEvents(
  bindingValue: ProjectBinding,
  options: CommittedProjectionReplayOptions,
  consume: (event: StoredEvent) => void,
): CommittedProjectionReplayResult {
  const binding = validateBinding(bindingValue);
  const terminalEventPosition = options.terminalEventPosition;
  if (
    typeof terminalEventPosition !== "bigint"
    || terminalEventPosition < 0n
    || terminalEventPosition > SQLITE_INT64_MAX
    || typeof consume !== "function"
  ) return integrity();
  const maxEvents = boundedPositiveInteger(
    options.maxEvents,
    MAX_INTEGRITY_REPLAY_EVENTS,
    MAX_INTEGRITY_REPLAY_EVENTS,
  );
  const maxAggregateBytes = boundedPositiveInteger(
    options.maxAggregateBytes,
    MAX_INTEGRITY_REPLAY_BYTES,
    MAX_INTEGRITY_REPLAY_BYTES,
  );
  const connection = options.driver.open(options.eventStorePath, {
    mode: "read-only-existing",
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });
  let transactionOpen = false;
  try {
    connection.exec("BEGIN");
    transactionOpen = true;
    const identity = connection.prepare(`
      SELECT project_id, vault_id, store_id
      FROM project_meta WHERE singleton = 1
    `).get();
    if (
      identity === undefined
      || string(identity, "project_id") !== binding.projectId
      || string(identity, "vault_id") !== binding.vaultId
      || string(identity, "store_id") !== binding.storeId
    ) return integrity();
    preflightReplayRows(
      connection,
      binding,
      terminalEventPosition,
      maxEvents,
      maxAggregateBytes,
    );
    const iterator = connection.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM events
      WHERE project_id = $projectId
        AND workspace_id = $workspaceId
        AND (
          (branch_scope_id IS NULL AND $branchScopeId IS NULL)
          OR branch_scope_id = $branchScopeId
        )
        AND (
          (branch_ref IS NULL AND $branchRef IS NULL)
          OR branch_ref = $branchRef
        )
        AND global_position <= $terminalEventPosition
      ORDER BY global_position
    `).iterate({
      ...bindingParams(binding),
      $terminalEventPosition: terminalEventPosition,
    });
    let eventCount = 0;
    let aggregateBytes = 0;
    let priorPosition = 0n;
    let replayTerminalPosition = 0n;
    let replayTerminalHash = GENESIS_GLOBAL_HASH;
    for (const row of iterator) {
      if (eventCount >= maxEvents) return integrity();
      const bytes = rowBytes(row);
      aggregateBytes += bytes;
      if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > maxAggregateBytes) {
        return integrity();
      }
      const event = storedEvent(row);
      if (!sameBinding(event, binding) || event.globalPosition <= priorPosition) return integrity();
      consume(event);
      eventCount += 1;
      priorPosition = event.globalPosition;
      replayTerminalPosition = event.globalPosition;
      replayTerminalHash = event.eventHash;
    }
    connection.exec("COMMIT");
    transactionOpen = false;
    return Object.freeze({
      eventCount,
      aggregateBytes,
      terminalEventPosition: replayTerminalPosition,
      terminalEventHash: replayTerminalHash,
    });
  } catch (error) {
    if (transactionOpen) {
      try { connection.exec("ROLLBACK"); } catch { /* preserve replay failure */ }
    }
    throw error;
  } finally {
    try { connection.close(); } catch { /* preserve replay failure */ }
  }
}

export class SqliteProjectionEventReader implements ProjectionEventReader {
  readonly #driver: SqliteDriver;
  readonly #eventStorePath: string;
  readonly #busyTimeoutMs: number;

  constructor(options: SqliteProjectionEventReaderOptions) {
    this.#driver = options.driver;
    this.#eventStorePath = options.eventStorePath;
    this.#busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  }

  async openCommittedSnapshot(bindingValue: ProjectBinding): Promise<ProjectionEventSnapshot> {
    return openCommittedProjectionEventSnapshot(bindingValue, {
      driver: this.#driver,
      eventStorePath: this.#eventStorePath,
      busyTimeoutMs: this.#busyTimeoutMs,
    });
  }
}

/**
 * Synchronous core used by full integrity replay so the public verifier can
 * return a report or typed failure without changing the Task 4 contract. The
 * existing asynchronous reader remains a compatibility wrapper around this
 * exact authenticated event-store read.
 */
export function openCommittedProjectionEventSnapshot(
  bindingValue: ProjectBinding,
  options: CommittedProjectionSnapshotOptions,
): ProjectionEventSnapshot {
  const binding = validateBinding(bindingValue);
  const terminalEventPosition = options.terminalEventPosition;
  if (
    terminalEventPosition !== undefined
    && (
      typeof terminalEventPosition !== "bigint"
      || terminalEventPosition < 0n
      || terminalEventPosition > SQLITE_INT64_MAX
    )
  ) return integrity();
  const connection = options.driver.open(options.eventStorePath, {
    mode: "read-only-existing",
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });
    let transactionOpen = false;
    try {
      connection.exec("BEGIN");
      transactionOpen = true;
      const identity = connection.prepare(`
        SELECT project_id, vault_id, store_id
        FROM project_meta WHERE singleton = 1
      `).get();
      if (
        identity === undefined
        || string(identity, "project_id") !== binding.projectId
        || string(identity, "vault_id") !== binding.vaultId
        || string(identity, "store_id") !== binding.storeId
      ) return integrity();
      const upperBound = terminalEventPosition === undefined
        ? ""
        : "AND global_position <= $terminalEventPosition";
      const rows = connection.prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE project_id = $projectId
          AND workspace_id = $workspaceId
          AND (
            (branch_scope_id IS NULL AND $branchScopeId IS NULL)
            OR branch_scope_id = $branchScopeId
          )
          AND (
            (branch_ref IS NULL AND $branchRef IS NULL)
            OR branch_ref = $branchRef
          )
          ${upperBound}
        ORDER BY global_position
      `).all(terminalEventPosition === undefined
        ? bindingParams(binding)
        : {
            ...bindingParams(binding),
            $terminalEventPosition: terminalEventPosition,
          });
      const events = rows.map(storedEvent);
      if (events.some((event) => !sameBinding(event, binding))) return integrity();
      for (let index = 1; index < events.length; index += 1) {
        if (events[index]!.globalPosition <= events[index - 1]!.globalPosition) return integrity();
      }
      const terminal = events.at(-1);
      connection.exec("COMMIT");
      transactionOpen = false;
      connection.close();
      let closed = false;
      return Object.freeze({
        binding,
        events: Object.freeze(events),
        terminalEventPosition: terminal?.globalPosition ?? 0n,
        terminalEventHash: terminal?.eventHash ?? GENESIS_GLOBAL_HASH,
        close(): void {
          if (closed) return;
          closed = true;
        },
      });
    } catch (error) {
      if (transactionOpen) {
        try {
          connection.exec("ROLLBACK");
        } catch {
          // Preserve the snapshot failure.
        }
      }
      try {
        connection.close();
      } catch {
        // Preserve the snapshot failure.
      }
      throw error;
    }
}
