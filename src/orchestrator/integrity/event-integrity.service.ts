import { readFileSync } from "node:fs";
import {
  commandHash,
  eventHash,
  outboxHash,
  payloadHash,
  responseHash,
} from "../crypto/event-hash.js";
import type { ProjectContext } from "../identity/contracts.js";
import { parseProjectDescriptor } from "../identity/project-descriptor.schema.js";
import { parseStoreManifest } from "../identity/store-manifest.schema.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../runtime/runtime-capabilities.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-store.js";
import type { Migration } from "../storage/migration.js";
import { migrationChecksum } from "../storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import {
  expectedSchemaFingerprint,
  schemaFingerprint,
  type SchemaQueryConnection,
} from "../storage/schema-fingerprint.js";
import type {
  SqliteConnection,
  SqliteRow,
} from "../storage/sqlite-driver.js";
import {
  IntegrityInputError,
  type IntegrityIssue,
  type IntegrityIssueCode,
  type IntegrityMode,
  type IntegrityReport,
} from "./integrity.types.js";

export const DEFAULT_QUICK_TAIL_EVENTS = 256;
export const MAX_QUICK_TAIL_EVENTS = 4096;
export const MAX_INTEGRITY_RANGE_EVENTS = 4096;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const STORED_RESPONSE_KEYS = [
  "eventIds",
  "finalStreamVersion",
  "firstGlobalPosition",
  "lastGlobalPosition",
  "response",
].sort().join("\n");
const COMMAND_WITNESS_DATA_ERRORS = new Set([
  "CANONICAL_JSON_INVALID",
  "INTEGRITY_JSON_NONCANONICAL",
  "INTEGRITY_ROW_INVALID",
]);

const ISSUE_MESSAGES: Record<IntegrityIssueCode, string> = {
  PROJECT_ID_MISMATCH: "Project identity does not match the bound project",
  VAULT_ID_MISMATCH: "Vault identity does not match the bound vault",
  STORE_ID_MISMATCH: "Store identity does not match the bound store",
  STORE_APPLICATION_ID_MISMATCH: "SQLite application identity does not match project memory",
  SQLITE_QUICK_CHECK_FAILED: "SQLite quick_check reported corruption",
  SQLITE_INTEGRITY_CHECK_FAILED: "SQLite integrity_check reported corruption",
  SQLITE_FOREIGN_KEY_CHECK_FAILED: "SQLite foreign-key verification reported corruption",
  MIGRATION_CHECKSUM_MISMATCH: "Recorded migration history does not match the required migrations",
  PROJECT_SCHEMA_VERSION_MISMATCH: "Project schema version does not match the required migrations",
  SCHEMA_FINGERPRINT_MISMATCH: "Authoritative SQLite schema fingerprint does not match",
  STREAM_HEAD_VERSION_MISMATCH: "Stream head version does not match its maximum event version",
  STREAM_TYPE_MISMATCH: "Stream metadata type does not match its events",
  COMMAND_RANGE_FOREIGN_EVENT: "Command range contains an event owned by another command",
  COMMAND_RANGE_MISSING_EVENT: "Command range does not contain every event owned by the command",
  COMMAND_EVENT_INDEX_MISMATCH: "Command event indexes are not zero-based and contiguous",
  COMMAND_HASH_MISMATCH: "Stored command hash does not match reconstructable command material",
  COMMAND_METADATA_MISMATCH: "Committed command metadata does not match its indexed events",
  COMMAND_RESPONSE_HASH_MISMATCH: "Stored command response does not match its response hash",
  GLOBAL_POSITION_NONCONTIGUOUS: "Global event positions are not contiguous",
  STREAM_VERSION_NONCONTIGUOUS: "Per-stream event versions are not contiguous",
  EVENT_PAYLOAD_HASH_MISMATCH: "Stored event payload does not match its payload hash",
  EVENT_PREVIOUS_HASH_MISMATCH: "Stored event predecessor hash does not match the prior event",
  EVENT_HASH_MISMATCH: "Stored event does not match its event hash",
  EVENT_TIMESTAMP_INVALID: "Stored event timestamp is not strict RFC3339",
  ORPHAN_COMMAND: "Committed command has no owned event",
  ORPHAN_EVENT: "Event has no committed command record",
  RANGE_INVALID: "Requested integrity range is invalid or exceeds the bounded maximum",
  RANGE_OUT_OF_BOUNDS: "Requested integrity range extends beyond the authoritative event tail",
  TAIL_LIMIT_INVALID: "Requested quick-check tail limit is invalid or exceeds the bounded maximum",
};

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface EventIndexRow {
  globalPosition: bigint;
  eventId: string;
  projectId: string;
  vaultId: string;
  storeId: string;
  streamId: string;
  streamType: string;
  streamVersion: bigint;
  commandId: string;
  idempotencyKey: string;
  commandEventIndex: bigint;
  eventHash: string;
}

interface StreamRow {
  projectId: string;
  streamId: string;
  streamType: string;
  currentVersion: bigint;
}

interface CommandRow {
  projectId: string;
  idempotencyKey: string;
  commandId: string;
  commandType: string;
  commandHash: string;
  workspaceHeadCommit: string | null;
  outboxOrderJson: string;
  state: string;
  firstGlobalPosition: bigint;
  lastGlobalPosition: bigint;
  finalStreamVersion: bigint;
  eventIdsJson: string;
  responseJson: string;
  responseHash: string;
  committedAt: string;
}

interface StructuralCheck {
  schemaFingerprint: string;
  events: EventIndexRow[];
  streams: StreamRow[];
  commands: CommandRow[];
}

class CommandWitnessInvalidError extends Error {}

function isCommandWitnessInvalid(error: unknown): boolean {
  return error instanceof CommandWitnessInvalidError
    || error instanceof SyntaxError
    || (error instanceof Error && COMMAND_WITNESS_DATA_ERRORS.has(error.message));
}

class IssueCollector {
  readonly #issues = new Map<string, IntegrityIssue>();

  add(
    code: IntegrityIssueCode,
    location: Omit<IntegrityIssue, "code" | "message"> = {},
  ): void {
    const issue: IntegrityIssue = { code, message: ISSUE_MESSAGES[code], ...location };
    const key = [
      code,
      issue.globalPosition ?? "",
      issue.streamId ?? "",
      issue.commandId ?? "",
    ].join("\u0000");
    if (!this.#issues.has(key)) this.#issues.set(key, issue);
  }

  sorted(): IntegrityIssue[] {
    return [...this.#issues.values()].sort((left, right) => {
      const code = left.code.localeCompare(right.code);
      if (code !== 0) return code;
      if (left.globalPosition !== right.globalPosition) {
        if (left.globalPosition === undefined) return -1;
        if (right.globalPosition === undefined) return 1;
        const leftPosition = BigInt(left.globalPosition);
        const rightPosition = BigInt(right.globalPosition);
        if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1;
      }
      const stream = (left.streamId ?? "").localeCompare(right.streamId ?? "");
      return stream !== 0
        ? stream
        : (left.commandId ?? "").localeCompare(right.commandId ?? "");
    });
  }
}

function stringValue(row: SqliteRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error("INTEGRITY_ROW_INVALID");
  return value;
}

function nullableStringValue(row: SqliteRow, name: string): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") {
    throw new Error("INTEGRITY_ROW_INVALID");
  }
  return value;
}

function bigintValue(row: SqliteRow, name: string): bigint {
  const value = row[name];
  if (typeof value !== "bigint") throw new Error("INTEGRITY_ROW_INVALID");
  return value;
}

function safeNumber(value: bigint): number | undefined {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : undefined;
}

function jsonValue(source: string): unknown {
  return JSON.parse(source) as unknown;
}

function canonicalJsonValue(source: string): unknown {
  const value = jsonValue(source);
  if (canonicalJson(value) !== source) throw new Error("INTEGRITY_JSON_NONCANONICAL");
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictRfc3339(value: string): boolean {
  const match = RFC3339.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1
    && month >= 1 && month <= 12
    && day >= 1 && day <= (monthDays[month - 1] ?? 0)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
}

function eventIndex(row: SqliteRow): EventIndexRow {
  return {
    globalPosition: bigintValue(row, "global_position"),
    eventId: stringValue(row, "event_id"),
    projectId: stringValue(row, "project_id"),
    vaultId: stringValue(row, "vault_id"),
    storeId: stringValue(row, "store_id"),
    streamId: stringValue(row, "stream_id"),
    streamType: stringValue(row, "stream_type"),
    streamVersion: bigintValue(row, "stream_version"),
    commandId: stringValue(row, "command_id"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    commandEventIndex: bigintValue(row, "command_event_index"),
    eventHash: stringValue(row, "event_hash"),
  };
}

function lowerBoundGlobalPosition(
  events: readonly EventIndexRow[],
  target: bigint,
): number {
  let lower = 0;
  let upper = events.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (events[middle]!.globalPosition < target) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function upperBoundGlobalPosition(
  events: readonly EventIndexRow[],
  target: bigint,
): number {
  let lower = 0;
  let upper = events.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (events[middle]!.globalPosition <= target) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function eventCountInRange(
  events: readonly EventIndexRow[],
  first: bigint,
  last: bigint,
): number {
  if (last < first) return 0;
  return upperBoundGlobalPosition(events, last) - lowerBoundGlobalPosition(events, first);
}

function streamRow(row: SqliteRow): StreamRow {
  return {
    projectId: stringValue(row, "project_id"),
    streamId: stringValue(row, "stream_id"),
    streamType: stringValue(row, "stream_type"),
    currentVersion: bigintValue(row, "current_version"),
  };
}

function commandRow(row: SqliteRow): CommandRow {
  return {
    projectId: stringValue(row, "project_id"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    commandId: stringValue(row, "command_id"),
    commandType: stringValue(row, "command_type"),
    commandHash: stringValue(row, "command_hash"),
    workspaceHeadCommit: nullableStringValue(row, "workspace_head_commit"),
    outboxOrderJson: stringValue(row, "outbox_order_json"),
    state: stringValue(row, "state"),
    firstGlobalPosition: bigintValue(row, "first_global_position"),
    lastGlobalPosition: bigintValue(row, "last_global_position"),
    finalStreamVersion: bigintValue(row, "final_stream_version"),
    eventIdsJson: stringValue(row, "event_ids_json"),
    responseJson: stringValue(row, "response_json"),
    responseHash: stringValue(row, "response_hash"),
    committedAt: stringValue(row, "committed_at"),
  };
}

function transactionRollback(connection: SqliteConnection): void {
  try { connection.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
}

export class EventIntegrityService {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly migrations: readonly Migration[] = PROJECT_STORE_MIGRATIONS,
  ) {}

  quickCheck(
    context: ProjectContext,
    tailLimit = DEFAULT_QUICK_TAIL_EVENTS,
  ): IntegrityReport {
    if (
      !Number.isSafeInteger(tailLimit)
      || tailLimit < 1
      || tailLimit > MAX_QUICK_TAIL_EVENTS
    ) {
      throw new IntegrityInputError("TAIL_LIMIT_INVALID");
    }
    return this.inTransaction(() => this.quickReport(context, tailLimit));
  }

  fullCheck(context: ProjectContext): IntegrityReport {
    return this.inTransaction(() => this.fullReport(context));
  }

  verifyRange(
    context: ProjectContext,
    first: bigint,
    last: bigint,
  ): IntegrityReport {
    if (
      first < 1n
      || last < first
      || first > SQLITE_INT64_MAX
      || last > SQLITE_INT64_MAX
      || last - first + 1n > BigInt(MAX_INTEGRITY_RANGE_EVENTS)
    ) {
      throw new IntegrityInputError("RANGE_INVALID");
    }
    return this.inTransaction(() => this.rangeReport(context, first, last));
  }

  private inTransaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN DEFERRED");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      transactionRollback(this.connection);
      throw error;
    }
  }

  private quickReport(context: ProjectContext, tailLimit: number): IntegrityReport {
    const issues = new IssueCollector();
    this.checkPragma("quick_check", "SQLITE_QUICK_CHECK_FAILED", issues);
    this.checkForeignKeys(issues);
    const structural = this.checkStructural(context, issues);
    this.checkStreams(structural.streams, structural.events, issues);
    this.checkCommands(structural.commands, structural.events, issues);
    const rows = this.connection.prepare(`
      SELECT * FROM (
        SELECT * FROM events ORDER BY global_position DESC LIMIT $limit
      ) ORDER BY global_position
    `).all({ $limit: tailLimit });
    const indexedRows = rows.map(eventIndex);
    const predecessor = indexedRows.length === 0
      ? undefined
      : this.predecessor(indexedRows[0]!.globalPosition, structural.events);
    this.checkEventRows(context, rows, {
      expectedFirst: indexedRows[0]?.globalPosition ?? 1n,
      expectedPreviousHash: indexedRows[0]?.globalPosition === 1n
        ? GENESIS_GLOBAL_HASH
        : predecessor?.eventHash,
      verifyTimestamps: false,
      verifyStreamVersions: false,
      initialStreamVersions: new Map(),
    }, issues);
    return this.report(
      "quick",
      context,
      structural.schemaFingerprint,
      indexedRows,
      structural.streams.length,
      structural.commands.length,
      issues,
    );
  }

  private fullReport(context: ProjectContext): IntegrityReport {
    const issues = new IssueCollector();
    this.checkPragma("quick_check", "SQLITE_QUICK_CHECK_FAILED", issues);
    this.checkPragma("integrity_check", "SQLITE_INTEGRITY_CHECK_FAILED", issues);
    this.checkForeignKeys(issues);
    const structural = this.checkStructural(context, issues);
    this.checkProjectSchemaVersion(issues);
    this.checkStreams(structural.streams, structural.events, issues);
    const rows = this.connection.prepare(`
      SELECT * FROM events ORDER BY global_position
    `).all();
    this.checkCommands(structural.commands, structural.events, issues, rows);
    this.checkEventRows(context, rows, {
      expectedFirst: 1n,
      expectedPreviousHash: GENESIS_GLOBAL_HASH,
      verifyTimestamps: true,
      verifyStreamVersions: true,
      initialStreamVersions: new Map(),
    }, issues);
    return this.report(
      "full",
      context,
      structural.schemaFingerprint,
      structural.events,
      structural.streams.length,
      structural.commands.length,
      issues,
    );
  }

  private rangeReport(
    context: ProjectContext,
    first: bigint,
    last: bigint,
  ): IntegrityReport {
    const issues = new IssueCollector();
    const structural = this.checkStructural(context, issues, false);
    const tail = structural.events.at(-1)?.globalPosition ?? 0n;
    if (last > tail) throw new IntegrityInputError("RANGE_OUT_OF_BOUNDS");
    const rows = this.connection.prepare(`
      SELECT * FROM events
      WHERE global_position BETWEEN $first AND $last
      ORDER BY global_position
    `).all({ $first: first, $last: last });
    const indexedRows = rows.map(eventIndex);
    if (BigInt(indexedRows.length) !== last - first + 1n) {
      const positions = new Set(indexedRows.map((event) => event.globalPosition));
      let missing = first;
      while (missing <= last && positions.has(missing)) missing += 1n;
      issues.add("GLOBAL_POSITION_NONCONTIGUOUS", {
        globalPosition: (missing <= last ? missing : first).toString(),
      });
    }
    const predecessor = first === 1n ? undefined : this.predecessor(first, structural.events);
    const initialStreamVersions = new Map<string, bigint>();
    for (const event of structural.events) {
      if (event.globalPosition >= first) break;
      initialStreamVersions.set(event.streamId, event.streamVersion);
    }
    this.checkEventRows(context, rows, {
      expectedFirst: first,
      expectedPreviousHash: first === 1n ? GENESIS_GLOBAL_HASH : predecessor?.eventHash,
      verifyTimestamps: true,
      verifyStreamVersions: true,
      initialStreamVersions,
    }, issues);
    const selectedStreams = new Set(indexedRows.map((event) => event.streamId));
    const selectedCommands = new Set(indexedRows.map((event) => event.commandId));
    return this.report(
      "range",
      context,
      structural.schemaFingerprint,
      indexedRows,
      selectedStreams.size,
      selectedCommands.size,
      issues,
      first,
      last,
    );
  }

  private checkStructural(
    context: ProjectContext,
    issues: IssueCollector,
    includeStreamsAndCommands = true,
  ): StructuralCheck {
    this.checkIdentity(context, issues);
    this.checkApplicationId(issues);
    this.checkMigrations(issues);
    const observedSchemaFingerprint = schemaFingerprint(
      this.connection as unknown as SchemaQueryConnection,
    );
    if (observedSchemaFingerprint !== expectedSchemaFingerprint(this.migrations)) {
      issues.add("SCHEMA_FINGERPRINT_MISMATCH");
    }
    const events = this.connection.prepare(`
      SELECT global_position, event_id, project_id, vault_id, store_id,
             stream_id, stream_type, stream_version, command_id, idempotency_key,
             command_event_index, event_hash
      FROM events ORDER BY global_position
    `).all().map(eventIndex);
    this.checkEventIdentities(context, events, issues);
    const streams = includeStreamsAndCommands
      ? this.connection.prepare(`
          SELECT project_id, stream_id, stream_type, current_version
          FROM streams ORDER BY project_id, stream_id
        `).all().map(streamRow)
      : [];
    const commands = includeStreamsAndCommands
      ? this.connection.prepare(`
          SELECT project_id, idempotency_key, command_id, first_global_position,
                 command_type, command_hash, workspace_head_commit,
                 outbox_order_json, state, last_global_position, final_stream_version,
                 event_ids_json, response_json, response_hash, committed_at
          FROM command_dedup
          ORDER BY project_id, first_global_position, command_id
        `).all().map(commandRow)
      : [];
    return { schemaFingerprint: observedSchemaFingerprint, events, streams, commands };
  }

  private checkIdentity(context: ProjectContext, issues: IssueCollector): void {
    const binding = context.binding;
    try {
      const descriptor = parseProjectDescriptor(
        JSON.parse(readFileSync(binding.descriptorPath, "utf8")) as unknown,
      );
      if (descriptor.projectId !== binding.projectId) issues.add("PROJECT_ID_MISMATCH");
      if (descriptor.vaultId !== binding.vaultId) issues.add("VAULT_ID_MISMATCH");
    } catch {
      issues.add("PROJECT_ID_MISMATCH");
      issues.add("VAULT_ID_MISMATCH");
    }
    try {
      const manifest = parseStoreManifest(
        JSON.parse(readFileSync(binding.storeRoute.storeManifestPath, "utf8")) as unknown,
      );
      if (manifest.projectId !== binding.projectId) issues.add("PROJECT_ID_MISMATCH");
      if (manifest.vaultId !== binding.vaultId) issues.add("VAULT_ID_MISMATCH");
      if (manifest.storeId !== binding.storeId) issues.add("STORE_ID_MISMATCH");
    } catch {
      issues.add("PROJECT_ID_MISMATCH");
      issues.add("VAULT_ID_MISMATCH");
      issues.add("STORE_ID_MISMATCH");
    }
    const metaRows = this.connection.prepare(`
      SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1
    `).all();
    if (metaRows.length !== 1) {
      issues.add("PROJECT_ID_MISMATCH");
      issues.add("VAULT_ID_MISMATCH");
      issues.add("STORE_ID_MISMATCH");
      return;
    }
    const meta = metaRows[0]!;
    if (meta.project_id !== binding.projectId) issues.add("PROJECT_ID_MISMATCH");
    if (meta.vault_id !== binding.vaultId) issues.add("VAULT_ID_MISMATCH");
    if (meta.store_id !== binding.storeId) issues.add("STORE_ID_MISMATCH");
  }

  private checkApplicationId(issues: IssueCollector): void {
    const value = this.connection.prepare("PRAGMA application_id").get()?.application_id;
    if ((typeof value !== "bigint" && typeof value !== "number")
      || Number(value) !== PROJECT_MEMORY_APPLICATION_ID) {
      issues.add("STORE_APPLICATION_ID_MISMATCH");
    }
  }

  private checkMigrations(issues: IssueCollector): void {
    const rows = this.connection.prepare(`
      SELECT version, name, checksum FROM schema_migrations ORDER BY version
    `).all();
    if (rows.length !== this.migrations.length) {
      issues.add("MIGRATION_CHECKSUM_MISMATCH");
      return;
    }
    for (let index = 0; index < this.migrations.length; index += 1) {
      const migration = this.migrations[index]!;
      const row = rows[index]!;
      const version = row.version;
      if (
        (typeof version !== "bigint" && typeof version !== "number")
        || Number(version) !== migration.version
        || row.name !== migration.name
        || row.checksum !== migrationChecksum(migration)
      ) {
        issues.add("MIGRATION_CHECKSUM_MISMATCH");
        return;
      }
    }
  }

  private checkProjectSchemaVersion(issues: IssueCollector): void {
    const expectedVersion = this.migrations.at(-1)?.version;
    const rows = this.connection.prepare(`
      SELECT schema_version FROM project_meta WHERE singleton = 1
    `).all();
    if (
      expectedVersion === undefined
      || rows.length !== 1
      || (typeof rows[0]?.schema_version !== "bigint"
        && typeof rows[0]?.schema_version !== "number")
      || Number(rows[0]!.schema_version) !== expectedVersion
    ) {
      issues.add("PROJECT_SCHEMA_VERSION_MISMATCH");
    }
  }

  private checkPragma(
    pragma: "quick_check" | "integrity_check",
    code: "SQLITE_QUICK_CHECK_FAILED" | "SQLITE_INTEGRITY_CHECK_FAILED",
    issues: IssueCollector,
  ): void {
    const rows = this.connection.prepare(`PRAGMA ${pragma}`).all();
    if (rows.length === 0 || rows.some((row) => row[pragma] !== "ok")) issues.add(code);
  }

  private checkForeignKeys(issues: IssueCollector): void {
    if (this.connection.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      issues.add("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    }
  }

  private checkEventIdentities(
    context: ProjectContext,
    events: readonly EventIndexRow[],
    issues: IssueCollector,
  ): void {
    for (const event of events) {
      const location = { globalPosition: event.globalPosition.toString() };
      if (event.projectId !== context.binding.projectId) {
        issues.add("PROJECT_ID_MISMATCH", location);
      }
      if (event.vaultId !== context.binding.vaultId) {
        issues.add("VAULT_ID_MISMATCH", location);
      }
      if (event.storeId !== context.binding.storeId) {
        issues.add("STORE_ID_MISMATCH", location);
      }
    }
  }

  private checkStreams(
    streams: readonly StreamRow[],
    events: readonly EventIndexRow[],
    issues: IssueCollector,
  ): void {
    const byKey = new Map(streams.map((stream) => [
      `${stream.projectId}\u0000${stream.streamId}`,
      stream,
    ]));
    const maximumVersions = new Map<string, bigint>();
    for (const event of events) {
      const key = `${event.projectId}\u0000${event.streamId}`;
      const current = maximumVersions.get(key) ?? 0n;
      if (event.streamVersion > current) maximumVersions.set(key, event.streamVersion);
      const stream = byKey.get(key);
      if (stream === undefined || stream.streamType !== event.streamType) {
        issues.add("STREAM_TYPE_MISMATCH", { streamId: event.streamId });
      }
    }
    for (const stream of streams) {
      const key = `${stream.projectId}\u0000${stream.streamId}`;
      if (stream.currentVersion !== (maximumVersions.get(key) ?? 0n)) {
        issues.add("STREAM_HEAD_VERSION_MISMATCH", { streamId: stream.streamId });
      }
    }
  }

  private checkCommands(
    commands: readonly CommandRow[],
    events: readonly EventIndexRow[],
    issues: IssueCollector,
    fullEventRows?: readonly SqliteRow[],
  ): void {
    const commandIds = new Set(commands.map((command) => command.commandId));
    const eventsByCommand = new Map<string, EventIndexRow[]>();
    const fullRowsByCommand = new Map<string, SqliteRow[]>();
    for (const row of fullEventRows ?? []) {
      const commandId = stringValue(row, "command_id");
      const rows = fullRowsByCommand.get(commandId) ?? [];
      rows.push(row);
      fullRowsByCommand.set(commandId, rows);
    }
    for (const event of events) {
      const ownEvents = eventsByCommand.get(event.commandId) ?? [];
      ownEvents.push(event);
      eventsByCommand.set(event.commandId, ownEvents);
      if (!commandIds.has(event.commandId)) {
        issues.add("ORPHAN_EVENT", {
          globalPosition: event.globalPosition.toString(),
          commandId: event.commandId,
        });
      }
    }
    for (const command of commands) {
      const ownEvents = eventsByCommand.get(command.commandId) ?? [];
      const firstOwnEvent = ownEvents[0];
      const lastOwnEvent = ownEvents.at(-1);
      const rangeEventCount = eventCountInRange(
        events,
        command.firstGlobalPosition,
        command.lastGlobalPosition,
      );
      const ownRangeEventCount = eventCountInRange(
        ownEvents,
        command.firstGlobalPosition,
        command.lastGlobalPosition,
      );
      const span = command.lastGlobalPosition - command.firstGlobalPosition + 1n;
      if (ownEvents.length === 0) {
        issues.add("ORPHAN_COMMAND", { commandId: command.commandId });
      }
      const hasForeignRangeEvent = rangeEventCount > ownRangeEventCount;
      if (hasForeignRangeEvent) {
        issues.add("COMMAND_RANGE_FOREIGN_EVENT", { commandId: command.commandId });
      }
      if (
        ownEvents.length !== ownRangeEventCount
        || BigInt(rangeEventCount) < span
        || (lastOwnEvent !== undefined
          && command.finalStreamVersion !== lastOwnEvent.streamVersion)
      ) {
        issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
      }
      for (let index = 0; index < ownEvents.length; index += 1) {
        if (ownEvents[index]!.commandEventIndex !== BigInt(index)) {
          issues.add("COMMAND_EVENT_INDEX_MISMATCH", { commandId: command.commandId });
          break;
        }
      }
      try {
        const storedEventIds = canonicalJsonValue(command.eventIdsJson);
        const observedEventIds = ownEvents.map((event) => event.eventId);
        if (
          !Array.isArray(storedEventIds)
          || storedEventIds.length !== observedEventIds.length
          || storedEventIds.some((value, index) => value !== observedEventIds[index])
        ) {
          issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
        }
      } catch {
        issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
      }
      try {
        const response = jsonValue(command.responseJson);
        if (
          canonicalJson(response) !== command.responseJson
          || responseHash(response) !== command.responseHash
        ) {
          issues.add("COMMAND_RESPONSE_HASH_MISMATCH", { commandId: command.commandId });
        }
        const observedEventIds = ownEvents.map((event) => event.eventId);
        if (
          !plainRecord(response)
          || Object.keys(response).sort().join("\n") !== STORED_RESPONSE_KEYS
          || !Array.isArray(response.eventIds)
          || response.eventIds.length !== observedEventIds.length
          || response.eventIds.some((value, index) => value !== observedEventIds[index])
          || firstOwnEvent === undefined
          || lastOwnEvent === undefined
          || response.firstGlobalPosition !== firstOwnEvent.globalPosition.toString()
          || response.lastGlobalPosition !== lastOwnEvent.globalPosition.toString()
          || response.finalStreamVersion !== lastOwnEvent.streamVersion.toString()
        ) {
          issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
        }
      } catch {
        issues.add("COMMAND_RESPONSE_HASH_MISMATCH", { commandId: command.commandId });
        issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
      }
      if (fullEventRows !== undefined && ownEvents.length !== 0) {
        const commandEventRows = fullRowsByCommand.get(command.commandId) ?? [];
        this.checkCommandMetadata(command, ownEvents, commandEventRows, issues);
      }
    }
  }

  private checkCommandMetadata(
    command: CommandRow,
    events: readonly EventIndexRow[],
    rows: readonly SqliteRow[],
    issues: IssueCollector,
  ): void {
    const location = { commandId: command.commandId };
    const first = rows[0];
    let metadataMatches = rows.length === events.length
      && command.state === "committed"
      && command.commandType.trim().length !== 0
      && strictRfc3339(command.committedAt);
    if (first !== undefined) {
      const commonFields = [
        "project_id",
        "store_id",
        "workspace_id",
        "stream_id",
        "stream_type",
        "correlation_id",
        "agent_id",
        "branch_scope_id",
        "branch_ref",
      ] as const;
      for (const row of rows) {
        if (
          stringValue(row, "command_id") !== command.commandId
          || stringValue(row, "project_id") !== command.projectId
          || stringValue(row, "idempotency_key") !== command.idempotencyKey
          || stringValue(row, "recorded_at") !== command.committedAt
          || commonFields.some((field) => row[field] !== first[field])
        ) {
          metadataMatches = false;
        }
      }
    }
    if (events.some((event) => event.idempotencyKey !== command.idempotencyKey)) {
      metadataMatches = false;
    }
    if (!metadataMatches) issues.add("COMMAND_METADATA_MISMATCH", location);

    try {
      const expectedHash = this.reconstructCommandHash(command, rows);
      if (expectedHash !== command.commandHash) {
        issues.add("COMMAND_HASH_MISMATCH", location);
      }
    } catch (error) {
      if (!isCommandWitnessInvalid(error)) throw error;
      issues.add("COMMAND_METADATA_MISMATCH", location);
    }
  }

  private reconstructCommandHash(
    command: CommandRow,
    sourceRows: readonly SqliteRow[],
  ): string {
    const invalid = (): never => {
      throw new CommandWitnessInvalidError("COMMAND_WITNESS_INVALID");
    };
    const rows = [...sourceRows].sort((left, right) => {
      const leftIndex = bigintValue(left, "command_event_index");
      const rightIndex = bigintValue(right, "command_event_index");
      return leftIndex === rightIndex ? 0 : leftIndex < rightIndex ? -1 : 1;
    });
    const first = rows[0];
    if (first === undefined) return invalid();
    const tupleFields = [
      "project_id",
      "store_id",
      "workspace_id",
      "stream_id",
      "stream_type",
      "correlation_id",
      "agent_id",
      "branch_scope_id",
      "branch_ref",
    ] as const;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (
        bigintValue(row, "command_event_index") !== BigInt(index)
        || tupleFields.some((field) => row[field] !== first[field])
        || !this.matchesEventHash(row)
      ) {
        return invalid();
      }
      const payload = canonicalJsonValue(stringValue(row, "payload_json"));
      if (payloadHash(payload) !== stringValue(row, "payload_hash")) return invalid();
    }

    const branchScopeId = nullableStringValue(first, "branch_scope_id");
    const branchRef = nullableStringValue(first, "branch_ref");
    const workspaceHeadCommit = command.workspaceHeadCommit;
    let git: {
      headCommit: string;
      branchRef: string | null;
      detached: boolean;
    } | null;
    if (branchScopeId === null) {
      if (branchRef !== null || workspaceHeadCommit !== null) return invalid();
      git = null;
    } else {
      if (
        branchScopeId.length === 0
        || workspaceHeadCommit === null
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(workspaceHeadCommit)
        || (branchRef !== null && branchRef.length === 0)
      ) {
        return invalid();
      }
      const scopeRows = this.connection.prepare(`
        SELECT created_head
        FROM branch_scopes
        WHERE project_id = $projectId AND branch_scope_id = $branchScopeId
      `).all({
        $projectId: stringValue(first, "project_id"),
        $branchScopeId: branchScopeId,
      });
      if (
        scopeRows.length !== 1
        || (branchRef === null
          && stringValue(scopeRows[0]!, "created_head") !== workspaceHeadCommit)
      ) {
        return invalid();
      }
      git = {
        headCommit: workspaceHeadCommit,
        branchRef,
        detached: branchRef === null,
      };
    }

    const parsedOrder = canonicalJsonValue(command.outboxOrderJson);
    if (
      !Array.isArray(parsedOrder)
      || parsedOrder.some((target) => typeof target !== "string" || target.length === 0)
      || new Set(parsedOrder).size !== parsedOrder.length
    ) {
      return invalid();
    }
    const outboxRows = this.connection.prepare(`
      SELECT outbox.target_key, outbox.kind, outbox.payload_json,
             outbox.content_hash, outbox.event_position, events.command_event_index
      FROM outbox
      JOIN events ON events.global_position = outbox.event_position
      WHERE outbox.project_id = $projectId
        AND events.project_id = $projectId
        AND events.command_id = $commandId
    `).all({
      $projectId: command.projectId,
      $commandId: command.commandId,
    });
    if (outboxRows.length !== parsedOrder.length) return invalid();
    const outboxByTarget = new Map<string, SqliteRow>();
    for (const row of outboxRows) {
      const targetKey = stringValue(row, "target_key");
      if (outboxByTarget.has(targetKey)) return invalid();
      outboxByTarget.set(targetKey, row);
    }
    const outbox = parsedOrder.map((targetKey) => {
      const row = outboxByTarget.get(targetKey as string);
      if (row === undefined) return invalid();
      const eventIndex = safeNumber(bigintValue(row, "command_event_index"));
      const payload = canonicalJsonValue(stringValue(row, "payload_json"));
      if (
        eventIndex === undefined
        || rows[eventIndex] === undefined
        || bigintValue(row, "event_position") !== bigintValue(rows[eventIndex]!, "global_position")
        || outboxHash(payload) !== stringValue(row, "content_hash")
      ) {
        return invalid();
      }
      const kind = stringValue(row, "kind");
      if (kind.length === 0) return invalid();
      return {
        targetKey: targetKey as string,
        kind,
        eventIndex,
        payload,
      };
    });
    const normalizedEvents = rows.map((row) => {
      const eventSchemaVersion = safeNumber(bigintValue(row, "event_schema_version"));
      if (eventSchemaVersion === undefined) return invalid();
      return {
        eventType: stringValue(row, "event_type"),
        eventSchemaVersion,
        occurredAt: stringValue(row, "occurred_at"),
        visibilityScope: stringValue(row, "visibility_scope"),
        sessionId: nullableStringValue(row, "session_id"),
        parentSessionId: nullableStringValue(row, "parent_session_id"),
        causationId: nullableStringValue(row, "causation_id"),
        confidence: stringValue(row, "confidence"),
        verificationStatus: stringValue(row, "verification_status"),
        payload: canonicalJsonValue(stringValue(row, "payload_json")),
        sourceRefs: canonicalJsonValue(stringValue(row, "source_refs_json")),
        evidenceRefs: canonicalJsonValue(stringValue(row, "evidence_refs_json")),
        evidenceDigests: canonicalJsonValue(stringValue(row, "evidence_digests_json")),
      };
    });
    const firstStreamVersion = bigintValue(first, "stream_version");
    if (firstStreamVersion < 1n) return invalid();
    return commandHash({
      commandId: command.commandId,
      commandType: command.commandType,
      projectId: command.projectId,
      storeId: stringValue(first, "store_id"),
      workspaceId: stringValue(first, "workspace_id"),
      git,
      streamId: stringValue(first, "stream_id"),
      streamType: stringValue(first, "stream_type"),
      expectedStreamVersion: (firstStreamVersion - 1n).toString(),
      correlationId: stringValue(first, "correlation_id"),
      agentId: stringValue(first, "agent_id"),
      events: normalizedEvents,
      outbox,
    });
  }

  private checkEventRows(
    context: ProjectContext,
    rows: readonly SqliteRow[],
    options: {
      expectedFirst: bigint;
      expectedPreviousHash: string | undefined;
      verifyTimestamps: boolean;
      verifyStreamVersions: boolean;
      initialStreamVersions: Map<string, bigint>;
    },
    issues: IssueCollector,
  ): void {
    let expectedPosition = options.expectedFirst;
    let expectedPreviousHash = options.expectedPreviousHash;
    const streamVersions = new Map(options.initialStreamVersions);
    for (const row of rows) {
      const position = bigintValue(row, "global_position");
      const globalPosition = position.toString();
      const streamId = stringValue(row, "stream_id");
      if (position !== expectedPosition) {
        issues.add("GLOBAL_POSITION_NONCONTIGUOUS", { globalPosition });
      }
      if (
        expectedPreviousHash === undefined
        || stringValue(row, "previous_global_hash") !== expectedPreviousHash
      ) {
        issues.add("EVENT_PREVIOUS_HASH_MISMATCH", { globalPosition });
      }
      let payload: unknown;
      try {
        payload = canonicalJsonValue(stringValue(row, "payload_json"));
        if (payloadHash(payload) !== stringValue(row, "payload_hash")) {
          issues.add("EVENT_PAYLOAD_HASH_MISMATCH", { globalPosition });
        }
      } catch {
        issues.add("EVENT_PAYLOAD_HASH_MISMATCH", { globalPosition });
      }
      if (options.verifyTimestamps) {
        if (
          !strictRfc3339(stringValue(row, "occurred_at"))
          || !strictRfc3339(stringValue(row, "recorded_at"))
        ) {
          issues.add("EVENT_TIMESTAMP_INVALID", { globalPosition });
        }
      }
      if (options.verifyStreamVersions) {
        const observedVersion = bigintValue(row, "stream_version");
        const expectedVersion = (streamVersions.get(streamId) ?? 0n) + 1n;
        if (observedVersion !== expectedVersion) {
          issues.add("STREAM_VERSION_NONCONTIGUOUS", { globalPosition, streamId });
        }
        streamVersions.set(streamId, observedVersion);
      }
      if (!this.matchesEventHash(row)) {
        issues.add("EVENT_HASH_MISMATCH", { globalPosition });
      }
      const event = eventIndex(row);
      this.checkEventIdentities(context, [event], issues);
      expectedPosition = position + 1n;
      expectedPreviousHash = event.eventHash;
    }
  }

  private matchesEventHash(row: SqliteRow): boolean {
    try {
      const eventSchemaVersion = safeNumber(bigintValue(row, "event_schema_version"));
      const commandEventIndex = safeNumber(bigintValue(row, "command_event_index"));
      if (eventSchemaVersion === undefined || commandEventIndex === undefined) return false;
      const material = {
        globalPosition: bigintValue(row, "global_position").toString(),
        eventId: stringValue(row, "event_id"),
        projectId: stringValue(row, "project_id"),
        vaultId: stringValue(row, "vault_id"),
        storeId: stringValue(row, "store_id"),
        workspaceId: stringValue(row, "workspace_id"),
        branchScopeId: nullableStringValue(row, "branch_scope_id"),
        branchRef: nullableStringValue(row, "branch_ref"),
        streamId: stringValue(row, "stream_id"),
        streamType: stringValue(row, "stream_type"),
        streamVersion: bigintValue(row, "stream_version").toString(),
        eventType: stringValue(row, "event_type"),
        eventSchemaVersion,
        sessionId: nullableStringValue(row, "session_id"),
        parentSessionId: nullableStringValue(row, "parent_session_id"),
        actorRole: stringValue(row, "actor_role"),
        agentId: stringValue(row, "agent_id"),
        clientInstanceId: stringValue(row, "client_instance_id"),
        correlationId: stringValue(row, "correlation_id"),
        causationId: nullableStringValue(row, "causation_id"),
        commandId: stringValue(row, "command_id"),
        idempotencyKey: stringValue(row, "idempotency_key"),
        commandEventIndex,
        occurredAt: stringValue(row, "occurred_at"),
        recordedAt: stringValue(row, "recorded_at"),
        visibilityScope: stringValue(row, "visibility_scope"),
        confidence: stringValue(row, "confidence"),
        verificationStatus: stringValue(row, "verification_status"),
        sourceRefs: canonicalJsonValue(stringValue(row, "source_refs_json")),
        evidenceRefs: canonicalJsonValue(stringValue(row, "evidence_refs_json")),
        evidenceDigests: canonicalJsonValue(stringValue(row, "evidence_digests_json")),
        payloadHash: stringValue(row, "payload_hash"),
        previousGlobalHash: stringValue(row, "previous_global_hash"),
      };
      return eventHash(material) === stringValue(row, "event_hash");
    } catch {
      return false;
    }
  }

  private predecessor(
    firstPosition: bigint,
    events: readonly EventIndexRow[],
  ): EventIndexRow | undefined {
    if (firstPosition <= 1n) return undefined;
    return events.find((event) => event.globalPosition === firstPosition - 1n);
  }

  private report(
    mode: IntegrityMode,
    context: ProjectContext,
    observedSchemaFingerprint: string,
    events: readonly EventIndexRow[],
    streamsVerified: number,
    commandsVerified: number,
    collector: IssueCollector,
    requestedFirst?: bigint,
    requestedLast?: bigint,
  ): IntegrityReport {
    const issues = collector.sorted();
    const first = requestedFirst ?? events[0]?.globalPosition ?? 0n;
    const last = requestedLast ?? events.at(-1)?.globalPosition ?? 0n;
    const terminal = events.find((event) => event.globalPosition === last)?.eventHash
      ?? events.at(-1)?.eventHash
      ?? GENESIS_GLOBAL_HASH;
    return {
      ok: issues.length === 0,
      mode,
      projectId: context.binding.projectId,
      storeId: context.binding.storeId,
      firstGlobalPosition: first.toString(),
      lastGlobalPosition: last.toString(),
      eventsVerified: events.length,
      streamsVerified,
      commandsVerified,
      schemaFingerprint: observedSchemaFingerprint,
      terminalEventHash: terminal,
      issues,
    };
  }
}
