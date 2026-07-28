import { LifecycleError } from "../lifecycle/errors.js";
import { MAX_CANONICAL_TIMESTAMP_MS } from "../runtime/clock.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
  ChildTransferClaim,
  ChildTransferTicketInsert,
  ChildTransferTicketRecord,
  LifecycleJsonValue,
} from "./lifecycle-storage.types.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const COLUMNS = [
  "project_id", "transfer_ticket_id", "source_parent_session_id", "source_child_session_id",
  "source_assignment_json", "source_scope_json", "checkpoint_id", "follow_ups_json",
  "source_state_json", "lineage_json", "created_event_position", "created_at",
  "claimed_by_root_session_id", "claimed_child_session_id", "claimed_event_position", "claimed_at",
] as const;
const INSERT_KEYS = [
  "projectId", "transferTicketId", "sourceParentSessionId", "sourceChildSessionId",
  "sourceAssignment", "sourceScope", "checkpointId", "blockers", "followUps", "sourceState", "lineage",
  "createdEventPosition", "createdAtMs",
] as const;
const CLAIM_KEYS = [
  "projectId", "transferTicketId", "expectedCreatedEventPosition", "claimedByRootSessionId",
  "claimedChildSessionId", "claimedEventPosition", "claimedAtMs",
] as const;

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function exact(record: object, keys: readonly string[], failure: () => never): void {
  const prototype = Object.getPrototypeOf(record) as unknown;
  if (prototype !== Object.prototype && prototype !== null) failure();
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) failure();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) failure();
  }
}

function data(record: object, key: string, failure: () => never): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) failure();
  return descriptor.value;
}

function uuid(value: unknown, failure: () => never): string {
  if (typeof value !== "string" || !LOWER_UUID.test(value)) failure();
  return value;
}

function position(value: unknown, failure: () => never): bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) failure();
  return value;
}

function timestampFromMs(value: unknown): string {
  if (typeof value !== "bigint" || value < 0n || value > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  return new Date(Number(value)).toISOString();
}

function timestampToMs(value: unknown): bigint {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) integrity();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) integrity();
  return BigInt(parsed);
}

function json(value: unknown, failure: () => never): string {
  try {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded, "utf8") > 1_000_000) failure();
    return encoded;
  } catch {
    failure();
  }
}

function frozenJson(value: unknown): LifecycleJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenJson));
  if (typeof value !== "object") integrity();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) integrity();
  const output: Record<string, LifecycleJsonValue> = {};
  for (const key of Object.keys(value)) output[key] = frozenJson((value as Record<string, unknown>)[key]);
  return Object.freeze(output);
}

function parseJson(value: unknown): LifecycleJsonValue {
  if (typeof value !== "string") integrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (canonicalJson(parsed) !== value) integrity();
  } catch {
    integrity();
  }
  return frozenJson(parsed);
}

function stringListValue(
  decoded: LifecycleJsonValue,
  failure: () => never,
): readonly string[] {
  if (!Array.isArray(decoded)
    || decoded.length > 200
    || decoded.some((item) => typeof item !== "string"
      || item.length === 0
      || Array.from(item).length > 512)) failure();
  return decoded as readonly string[];
}

function transferAnnotations(value: unknown): {
  readonly blockers: readonly string[];
  readonly followUps: readonly string[];
} {
  const decoded = parseJson(value);
  if (!Array.isArray(decoded)) integrity();
  if (decoded.every((item) => typeof item === "string")) {
    return Object.freeze({
      blockers: Object.freeze([]),
      followUps: stringListValue(decoded, integrity),
    });
  }
  if (decoded.length !== 1 || typeof decoded[0] !== "object" || decoded[0] === null
    || Array.isArray(decoded[0])) integrity();
  const record = decoded[0] as Readonly<Record<string, LifecycleJsonValue>>;
  const keys = Object.keys(record);
  if (keys.length !== 3
    || !keys.includes("childTransferAnnotationsVersion")
    || !keys.includes("blockers")
    || !keys.includes("followUps")
    || record.childTransferAnnotationsVersion !== 1) integrity();
  return Object.freeze({
    blockers: stringListValue(record.blockers as LifecycleJsonValue, integrity),
    followUps: stringListValue(record.followUps as LifecycleJsonValue, integrity),
  });
}

function decode(row: SqliteRow): ChildTransferTicketRecord {
  exact(row, COLUMNS, integrity);
  const claimedByRootSessionId = data(row, "claimed_by_root_session_id", integrity);
  const claimedChildSessionId = data(row, "claimed_child_session_id", integrity);
  const claimedEventPosition = data(row, "claimed_event_position", integrity);
  const claimedAt = data(row, "claimed_at", integrity);
  const claimed = claimedByRootSessionId !== null;
  if ([claimedByRootSessionId, claimedChildSessionId, claimedEventPosition, claimedAt]
    .some((value) => (value !== null) !== claimed)) integrity();
  const annotations = transferAnnotations(data(row, "follow_ups_json", integrity));
  const createdEventPosition = position(data(row, "created_event_position", integrity), integrity);
  const decodedClaimPosition = claimed
    ? position(claimedEventPosition, integrity)
    : null;
  if (decodedClaimPosition !== null && decodedClaimPosition <= createdEventPosition) integrity();
  return Object.freeze({
    projectId: uuid(data(row, "project_id", integrity), integrity),
    transferTicketId: uuid(data(row, "transfer_ticket_id", integrity), integrity),
    sourceParentSessionId: uuid(data(row, "source_parent_session_id", integrity), integrity),
    sourceChildSessionId: uuid(data(row, "source_child_session_id", integrity), integrity),
    sourceAssignment: parseJson(data(row, "source_assignment_json", integrity)),
    sourceScope: parseJson(data(row, "source_scope_json", integrity)),
    checkpointId: uuid(data(row, "checkpoint_id", integrity), integrity),
    blockers: annotations.blockers,
    followUps: annotations.followUps,
    sourceState: parseJson(data(row, "source_state_json", integrity)),
    lineage: parseJson(data(row, "lineage_json", integrity)),
    createdEventPosition,
    createdAtMs: timestampToMs(data(row, "created_at", integrity)),
    claimedByRootSessionId: claimed ? uuid(claimedByRootSessionId, integrity) : null,
    claimedChildSessionId: claimed ? uuid(claimedChildSessionId, integrity) : null,
    claimedEventPosition: decodedClaimPosition,
    claimedAtMs: claimed ? timestampToMs(claimedAt) : null,
  });
}

function insertValues(source: ChildTransferTicketInsert): ChildTransferTicketInsert {
  if (typeof source !== "object" || source === null || Array.isArray(source)) invalid();
  exact(source, INSERT_KEYS, invalid);
  uuid(data(source, "projectId", invalid), invalid);
  uuid(data(source, "transferTicketId", invalid), invalid);
  uuid(data(source, "sourceParentSessionId", invalid), invalid);
  uuid(data(source, "sourceChildSessionId", invalid), invalid);
  if (source.sourceParentSessionId === source.sourceChildSessionId) invalid();
  uuid(data(source, "checkpointId", invalid), invalid);
  position(data(source, "createdEventPosition", invalid), invalid);
  timestampFromMs(data(source, "createdAtMs", invalid));
  for (const field of ["blockers", "followUps"] as const) {
    const list = data(source, field, invalid);
    if (!Array.isArray(list)
      || list.length > 200
      || list.some((item) => typeof item !== "string"
        || item.length === 0
        || Array.from(item).length > 512)) invalid();
  }
  for (const field of ["sourceAssignment", "sourceScope", "blockers", "followUps", "sourceState", "lineage"] as const) {
    json(data(source, field, invalid), invalid);
  }
  return source;
}

function claimValues(source: ChildTransferClaim): ChildTransferClaim {
  if (typeof source !== "object" || source === null || Array.isArray(source)) invalid();
  exact(source, CLAIM_KEYS, invalid);
  for (const field of [
    "projectId", "transferTicketId", "claimedByRootSessionId", "claimedChildSessionId",
  ] as const) uuid(data(source, field, invalid), invalid);
  const created = position(data(source, "expectedCreatedEventPosition", invalid), invalid);
  const claimed = position(data(source, "claimedEventPosition", invalid), invalid);
  if (claimed <= created) invalid();
  timestampFromMs(data(source, "claimedAtMs", invalid));
  return source;
}

const CARRY_PROJECTION_COLUMNS = [
  "project_id",
  "root_session_id",
  "child_session_id",
  "child_state",
  "last_event_position",
  "stream_version",
  "checkpoint_id",
  "checkpoint_event_position",
  "transfer_ticket_id",
  "transfer_ticket_event_position",
  "projection_valid",
] as const;

function decodeCarryProjection(
  row: SqliteRow,
): CarryForwardEndingScopeProjectionRecord {
  exact(row, CARRY_PROJECTION_COLUMNS, integrity);
  if (data(row, "child_state", integrity) !== "transferred") integrity();
  if (data(row, "projection_valid", integrity) !== 1n) integrity();
  return Object.freeze({
    projectId: uuid(data(row, "project_id", integrity), integrity),
    rootSessionId: uuid(data(row, "root_session_id", integrity), integrity),
    childSessionId: uuid(data(row, "child_session_id", integrity), integrity),
    childState: "transferred",
    lastEventPosition: position(data(row, "last_event_position", integrity), integrity),
    streamVersion: position(data(row, "stream_version", integrity), integrity),
    checkpointId: uuid(data(row, "checkpoint_id", integrity), integrity),
    checkpointEventPosition: position(
      data(row, "checkpoint_event_position", integrity),
      integrity,
    ),
    transferTicketId: uuid(data(row, "transfer_ticket_id", integrity), integrity),
    transferTicketEventPosition: position(
      data(row, "transfer_ticket_event_position", integrity),
      integrity,
    ),
  });
}

export class ChildTransferRepository {
  get(
    connection: SqliteConnection,
    projectId: string,
    transferTicketId: string,
  ): ChildTransferTicketRecord | null {
    uuid(projectId, invalid);
    uuid(transferTicketId, invalid);
    const row = connection.prepare(`
      SELECT ${COLUMNS.join(", ")}
      FROM child_transfer_tickets
      WHERE project_id = $projectId AND transfer_ticket_id = $transferTicketId
    `).get({ $projectId: projectId, $transferTicketId: transferTicketId });
    return row === undefined ? null : decode(row);
  }

  listUnclaimedBySourceRoot(
    connection: SqliteConnection,
    projectId: string,
    sourceParentSessionId: string,
    limit: number,
  ): readonly ChildTransferTicketRecord[] {
    uuid(projectId, invalid);
    uuid(sourceParentSessionId, invalid);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid();
    return Object.freeze(connection.prepare(`
      SELECT ${COLUMNS.join(", ")}
      FROM child_transfer_tickets
      WHERE project_id = $projectId
        AND source_parent_session_id = $sourceParentSessionId
        AND claimed_by_root_session_id IS NULL
        AND claimed_child_session_id IS NULL
        AND claimed_event_position IS NULL
        AND claimed_at IS NULL
      ORDER BY source_child_session_id, transfer_ticket_id
      LIMIT $limit
    `).all({
      $projectId: projectId,
      $sourceParentSessionId: sourceParentSessionId,
      $limit: BigInt(limit),
    }).map(decode));
  }

  listUnclaimedEndingScopeProjectionsBySourceRoot(
    connection: SqliteConnection,
    projectId: string,
    sourceParentSessionId: string,
    limit: number,
  ): readonly CarryForwardEndingScopeProjectionRecord[] {
    uuid(projectId, invalid);
    uuid(sourceParentSessionId, invalid);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid();
    return Object.freeze(connection.prepare(`
      SELECT
        ticket.project_id AS project_id,
        ticket.source_parent_session_id AS root_session_id,
        ticket.source_child_session_id AS child_session_id,
        source_child.semantic_state AS child_state,
        ticket.created_event_position AS last_event_position,
        source_stream.current_version AS stream_version,
        ticket.checkpoint_id AS checkpoint_id,
        source_child.latest_checkpoint_event_position AS checkpoint_event_position,
        ticket.transfer_ticket_id AS transfer_ticket_id,
        ticket.created_event_position AS transfer_ticket_event_position,
        CASE WHEN
          source_child.project_id = ticket.project_id
          AND source_child.session_id = ticket.source_child_session_id
          AND source_child.session_kind = 'child'
          AND source_child.parent_session_id = ticket.source_parent_session_id
          AND source_child.semantic_state = 'transferred'
          AND source_child.terminal_event_position = ticket.created_event_position
          AND source_child.authority_event_position = ticket.created_event_position
          AND source_child.latest_checkpoint_id = ticket.checkpoint_id
          AND source_child.latest_checkpoint_event_position IS NOT NULL
          AND source_child.latest_checkpoint_event_position <= ticket.created_event_position
          AND source_child.latest_checkpoint_fingerprint IS NOT NULL
          AND source_stream.project_id = source_child.project_id
          AND source_stream.stream_id = source_child.stream_id
          AND source_stream.stream_type = 'session'
          AND transfer_event.project_id = ticket.project_id
          AND transfer_event.global_position = ticket.created_event_position
          AND transfer_event.stream_id = source_child.stream_id
          AND transfer_event.stream_type = 'session'
          AND transfer_event.stream_version = source_stream.current_version
          AND transfer_event.session_id = ticket.source_child_session_id
          AND transfer_event.parent_session_id = ticket.source_parent_session_id
          AND transfer_event.event_type = 'ChildWorkTransferCreated'
          AND transfer_event.event_schema_version = 1
          AND json_valid(transfer_event.payload_json)
          AND json(transfer_event.payload_json) = transfer_event.payload_json
          AND json_extract(
            transfer_event.payload_json,
            '$.transferTicketId'
          ) = ticket.transfer_ticket_id
          AND json_extract(
            transfer_event.payload_json,
            '$.checkpointId'
          ) = ticket.checkpoint_id
          AND json_extract(
            transfer_event.payload_json,
            '$.authorityCommitment'
          ) = source_child.authority_commitment
          AND checkpoint_event.project_id = ticket.project_id
          AND checkpoint_event.global_position
            = source_child.latest_checkpoint_event_position
          AND checkpoint_event.stream_id = source_child.stream_id
          AND checkpoint_event.stream_type = 'session'
          AND checkpoint_event.session_id = ticket.source_child_session_id
          AND checkpoint_event.parent_session_id = ticket.source_parent_session_id
          AND checkpoint_event.event_type = 'SessionCheckpointRecorded'
          AND checkpoint_event.event_schema_version IN (1, 2)
          AND json_valid(checkpoint_event.payload_json)
          AND json(checkpoint_event.payload_json) = checkpoint_event.payload_json
          AND json_extract(
            checkpoint_event.payload_json,
            '$.checkpoint.checkpointId'
          ) = ticket.checkpoint_id
          AND json_extract(
            checkpoint_event.payload_json,
            '$.checkpoint.sessionId'
          ) = ticket.source_child_session_id
          AND json_extract(
            checkpoint_event.payload_json,
            '$.checkpoint.parentSessionId'
          ) = ticket.source_parent_session_id
          AND json_extract(
            checkpoint_event.payload_json,
            '$.checkpoint.checkpointEventPosition'
          ) = CAST(source_child.latest_checkpoint_event_position AS TEXT)
          AND json_extract(
            checkpoint_event.payload_json,
            '$.checkpointEventPosition'
          ) = CAST(source_child.latest_checkpoint_event_position AS TEXT)
        THEN 1 ELSE 0 END AS projection_valid
      FROM child_transfer_tickets AS ticket
        INDEXED BY child_transfer_tickets_unclaimed_source_root
      LEFT JOIN session_authority AS source_child
        ON source_child.project_id = ticket.project_id
        AND source_child.session_id = ticket.source_child_session_id
      LEFT JOIN streams AS source_stream
        ON source_stream.project_id = source_child.project_id
        AND source_stream.stream_id = source_child.stream_id
      LEFT JOIN events AS transfer_event
        ON transfer_event.project_id = ticket.project_id
        AND transfer_event.global_position = ticket.created_event_position
      LEFT JOIN events AS checkpoint_event
        ON checkpoint_event.project_id = ticket.project_id
        AND checkpoint_event.global_position
          = source_child.latest_checkpoint_event_position
      WHERE ticket.project_id = $projectId
        AND ticket.source_parent_session_id = $sourceParentSessionId
        AND ticket.claimed_by_root_session_id IS NULL
        AND ticket.claimed_child_session_id IS NULL
        AND ticket.claimed_event_position IS NULL
        AND ticket.claimed_at IS NULL
      ORDER BY ticket.source_child_session_id, ticket.transfer_ticket_id
      LIMIT $limit
    `).all({
      $projectId: projectId,
      $sourceParentSessionId: sourceParentSessionId,
      $limit: BigInt(limit),
    }).map(decodeCarryProjection));
  }

  findCreatedEventPosition(
    connection: SqliteConnection,
    projectId: string,
    transferTicketId: string,
  ): bigint | null {
    uuid(projectId, invalid);
    uuid(transferTicketId, invalid);
    const rows = connection.prepare(`
      SELECT global_position
      FROM events
      WHERE project_id = $projectId
        AND event_type = 'ChildWorkTransferCreated'
        AND json_extract(payload_json, '$.transferTicketId') = $transferTicketId
      ORDER BY global_position
      LIMIT 2
    `).all({ $projectId: projectId, $transferTicketId: transferTicketId });
    if (rows.length > 1) integrity();
    if (rows.length === 0) return null;
    const row = rows[0]!;
    exact(row, ["global_position"], integrity);
    return position(data(row, "global_position", integrity), integrity);
  }

  insert(connection: SqliteConnection, source: ChildTransferTicketInsert): void {
    const input = insertValues(source);
    const result = connection.prepare(`
      INSERT INTO child_transfer_tickets(
        project_id, transfer_ticket_id, source_parent_session_id, source_child_session_id,
        source_assignment_json, source_scope_json, checkpoint_id, follow_ups_json,
        source_state_json, lineage_json, created_event_position, created_at,
        claimed_by_root_session_id, claimed_child_session_id, claimed_event_position, claimed_at
      ) VALUES (
        $projectId, $transferTicketId, $sourceParentSessionId, $sourceChildSessionId,
        $sourceAssignmentJson, $sourceScopeJson, $checkpointId, $followUpsJson,
        $sourceStateJson, $lineageJson, $createdEventPosition, $createdAt,
        NULL, NULL, NULL, NULL
      )
    `).run({
      $projectId: input.projectId,
      $transferTicketId: input.transferTicketId,
      $sourceParentSessionId: input.sourceParentSessionId,
      $sourceChildSessionId: input.sourceChildSessionId,
      $sourceAssignmentJson: json(input.sourceAssignment, invalid),
      $sourceScopeJson: json(input.sourceScope, invalid),
      $checkpointId: input.checkpointId,
      $followUpsJson: json([{
        childTransferAnnotationsVersion: 1,
        blockers: [...input.blockers],
        followUps: [...input.followUps],
      }], invalid),
      $sourceStateJson: json(input.sourceState, invalid),
      $lineageJson: json(input.lineage, invalid),
      $createdEventPosition: input.createdEventPosition,
      $createdAt: timestampFromMs(input.createdAtMs),
    });
    if (result.changes !== 1n) integrity();
  }

  claim(connection: SqliteConnection, source: ChildTransferClaim): ChildTransferTicketRecord {
    const input = claimValues(source);
    const result = connection.prepare(`
      UPDATE child_transfer_tickets
      SET claimed_by_root_session_id = $claimedByRootSessionId,
          claimed_child_session_id = $claimedChildSessionId,
          claimed_event_position = $claimedEventPosition,
          claimed_at = $claimedAt
      WHERE project_id = $projectId
        AND transfer_ticket_id = $transferTicketId
        AND created_event_position = $expectedCreatedEventPosition
        AND claimed_by_root_session_id IS NULL
        AND claimed_child_session_id IS NULL
        AND claimed_event_position IS NULL
        AND claimed_at IS NULL
    `).run({
      $projectId: input.projectId,
      $transferTicketId: input.transferTicketId,
      $expectedCreatedEventPosition: input.expectedCreatedEventPosition,
      $claimedByRootSessionId: input.claimedByRootSessionId,
      $claimedChildSessionId: input.claimedChildSessionId,
      $claimedEventPosition: input.claimedEventPosition,
      $claimedAt: timestampFromMs(input.claimedAtMs),
    });
    if (result.changes === 0n) throw new LifecycleError("EVENT_CONFLICT");
    if (result.changes !== 1n) integrity();
    const claimed = this.get(connection, input.projectId, input.transferTicketId);
    if (claimed === null || claimed.claimedEventPosition !== input.claimedEventPosition) integrity();
    return claimed;
  }
}
