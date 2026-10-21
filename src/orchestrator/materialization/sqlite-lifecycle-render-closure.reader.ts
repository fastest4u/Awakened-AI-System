import type { StoredEvent } from "../contracts/event.js";
import type { ProjectId } from "../identity/contracts.js";
import {
  decodeLifecycleEventPayload,
  type LifecycleEventType,
} from "../lifecycle/contracts/events.js";
import {
  parseCanonicalTimestamp,
  parseCanonicalUuid,
  parseLifecycleId,
  type SessionId,
} from "../lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type { LifecycleIntentAuthorizationKind } from "../lifecycle/lifecycle-intent.js";
import {
  decodeLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
} from "../lifecycle/lifecycle-intent-witness.js";
import type {
  LifecycleRenderClosureV1,
  LifecycleRenderEventV1,
} from "../lifecycle/materialization-queue.port.js";
import type { SessionEndEffectiveStateV1 } from "../lifecycle/session-end-effective-state.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { readLegacySessionEndEffectiveStateSourceV1 } from "../storage/legacy-session-end-effective-state-source.js";
import { normalizeCommittedLifecycleClosureEvent } from "./lifecycle-render-event.js";

export interface AuthenticatedLifecycleCommandV1 {
  readonly commandHash: string;
  readonly lifecycleAuthorizationKind: LifecycleIntentAuthorizationKind | null;
  readonly intentWitnessJson: string | null;
  readonly witnessEventId: string | null;
  readonly legacyEffectiveState?: SessionEndEffectiveStateV1 | null;
}

interface RawEvent {
  readonly row: SqliteRow;
  readonly event: StoredEvent;
}

interface AuthenticatedCommand {
  readonly command: AuthenticatedLifecycleCommandV1;
  readonly events: readonly RawEvent[];
}

interface SourceTicket {
  readonly ticketId: string;
  readonly sourceEvent: RawEvent;
  readonly sourceChildSessionId: SessionId;
  readonly checkpointId: string;
  readonly row: SqliteRow;
}

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const AUTH_KINDS = new Set<LifecycleIntentAuthorizationKind>([
  "initial-authority", "protected", "internal-workflow",
]);
const ACTOR_ROLES = new Set(["primary", "maintenance", "untrusted"]);

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return integrity();
  return value;
}

function nullableString(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return requiredString(row, key);
}

function sqliteInt64(row: SqliteRow, key: string, minimum = 1n): bigint {
  const value = row[key];
  const decoded = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : integrity();
  if (decoded < minimum || decoded > SQLITE_INT64_MAX) return integrity();
  return decoded;
}

function safeInteger(row: SqliteRow, key: string, minimum: number): number {
  const value = row[key];
  const decoded = typeof value === "bigint"
    ? Number(value)
    : typeof value === "number"
      ? value
      : integrity();
  if (!Number.isSafeInteger(decoded) || decoded < minimum) return integrity();
  return decoded;
}

function nullableInteger(row: SqliteRow, key: string): bigint | null {
  return row[key] === null ? null : sqliteInt64(row, key);
}

function strictJson(source: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return integrity();
  }
  if (canonicalJson(value) !== source) return integrity();
  return value;
}

function stringArrayJson(row: SqliteRow, key: string): readonly string[] {
  const value = strictJson(requiredString(row, key));
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return integrity();
  if (value.some((item) => typeof item !== "string" || item.length === 0)) return integrity();
  return Object.freeze([...value]) as readonly string[];
}

function emptyArrayJson(row: SqliteRow, key: string): readonly [] {
  const value = strictJson(requiredString(row, key));
  if (!Array.isArray(value) || value.length !== 0) return integrity();
  return Object.freeze([]);
}

function sameSourceIdentity(left: StoredEvent, right: StoredEvent): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.branchScopeId === right.branchScopeId
    && left.branchRef === right.branchRef;
}

function sameStoreIdentity(left: StoredEvent, right: StoredEvent): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId;
}

function binaryCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Read-only, index-bounded reconstruction of the authenticated render closure. */
export class SqliteLifecycleRenderClosureReader {
  readonly #connection: SqliteConnection;
  readonly #commandCache = new Map<string, AuthenticatedCommand>();

  constructor(connection: SqliteConnection) {
    this.#connection = connection;
  }

  readStrictLifecycleClosure(
    projectIdValue: ProjectId,
    rootSessionIdValue: SessionId,
    throughPositionExclusive: bigint,
  ): LifecycleRenderClosureV1 {
    try {
      const projectId = parseLifecycleId<ProjectId>(projectIdValue, "projectId");
      const rootSessionId = parseLifecycleId<SessionId>(rootSessionIdValue, "rootSessionId");
      if (
        typeof throughPositionExclusive !== "bigint"
        || throughPositionExclusive < 1n
        || throughPositionExclusive > SQLITE_INT64_MAX
      ) return integrity();
      this.#commandCache.clear();

      const rootRaw = this.#readStream(
        projectId,
        `session/${rootSessionId}`,
        throughPositionExclusive,
      );
      const rootStart = rootRaw[0]?.event;
      if (
        rootStart === undefined
        || rootStart.eventType !== "SessionStarted"
        || rootStart.eventSchemaVersion !== 1
        || rootStart.streamVersion !== 1n
        || rootStart.sessionId !== rootSessionId
        || rootStart.parentSessionId !== null
      ) return integrity();
      for (const item of rootRaw) {
        if (
          item.event.sessionId !== rootSessionId
          || item.event.parentSessionId !== null
          || !sameSourceIdentity(item.event, rootStart)
        ) return integrity();
      }

      const discoveredForks = this.#connection.prepare(`
        SELECT e.*
        FROM events AS e INDEXED BY events_lifecycle_direct_child_v4
        WHERE e.project_id = $projectId
          AND e.parent_session_id = $rootSessionId
          AND e.global_position < $cutoff
          AND e.stream_type = 'session'
          AND e.event_type = 'SessionForked'
          AND e.event_schema_version = 1
        ORDER BY e.global_position ASC
      `).all({
        $projectId: projectId,
        $rootSessionId: rootSessionId,
        $cutoff: throughPositionExclusive,
      }).map((row) => this.#raw(row));
      if (discoveredForks.length > 1_000) return integrity();

      const directChildrenRaw = new Map<SessionId, readonly RawEvent[]>();
      for (const fork of discoveredForks) {
        const childSessionId = parseLifecycleId<SessionId>(fork.event.sessionId, "childSessionId");
        if (directChildrenRaw.has(childSessionId)) return integrity();
        const events = this.#readStream(projectId, fork.event.streamId, throughPositionExclusive);
        if (events[0]?.event.eventId !== fork.event.eventId) return integrity();
        for (const item of events) {
          if (
            item.event.sessionId !== childSessionId
            || item.event.parentSessionId !== rootSessionId
            || !sameSourceIdentity(item.event, rootStart)
          ) return integrity();
        }
        directChildrenRaw.set(childSessionId, events);
      }

      const tickets = this.#sourceTickets(
        projectId,
        rootSessionId,
        throughPositionExclusive,
        directChildrenRaw,
      );
      const foreignRaw: Array<Readonly<{ fork: RawEvent; claim: RawEvent }>> = [];
      for (const ticket of tickets) {
        const pair = this.#claimPair(projectId, rootStart, ticket);
        if (
          pair !== null
          && pair.fork.event.globalPosition < throughPositionExclusive
          && pair.claim.event.globalPosition < throughPositionExclusive
        ) foreignRaw.push(pair);
      }

      const occupied = new Set<string>();
      const assertPosition = (event: StoredEvent): void => {
        if (event.globalPosition >= throughPositionExclusive) return integrity();
        const key = event.globalPosition.toString();
        if (occupied.has(key)) return integrity();
        occupied.add(key);
      };
      rootRaw.forEach(({ event }) => assertPosition(event));
      for (const events of directChildrenRaw.values()) events.forEach(({ event }) => assertPosition(event));
      for (const pair of foreignRaw) {
        assertPosition(pair.fork.event);
        assertPosition(pair.claim.event);
      }

      const normalize = (item: RawEvent): LifecycleRenderEventV1 =>
        normalizeCommittedLifecycleClosureEvent({
          event: item.event,
          command: this.#authenticateCommand(item.event).command,
        });
      const directChildren = [...directChildrenRaw.entries()]
        .sort(([left], [right]) => binaryCompare(left, right))
        .map(([childSessionId, events]) => Object.freeze({
          childSessionId,
          events: Object.freeze(events.map(normalize)),
        }));
      foreignRaw.sort((left, right) =>
        left.claim.event.globalPosition < right.claim.event.globalPosition ? -1
          : left.claim.event.globalPosition > right.claim.event.globalPosition ? 1
            : integrity());
      return Object.freeze({
        root: Object.freeze(rootRaw.map(normalize)),
        directChildren: Object.freeze(directChildren),
        foreignClaims: Object.freeze(foreignRaw.map((pair) => Object.freeze({
          fork: normalize(pair.fork),
          claim: normalize(pair.claim),
        }))),
      });
    } catch {
      return integrity();
    }
  }

  #readStream(projectId: ProjectId, streamId: string, cutoff: bigint): readonly RawEvent[] {
    const rows = this.#connection.prepare(`
      SELECT e.*
      FROM events AS e INDEXED BY events_stream_range
      WHERE e.project_id = $projectId
        AND e.stream_id = $streamId
        AND e.global_position < $cutoff
      ORDER BY e.stream_version ASC
    `).all({ $projectId: projectId, $streamId: streamId, $cutoff: cutoff });
    if (rows.length === 0) return integrity();
    const events = rows.map((row) => this.#raw(row));
    let previousPosition = 0n;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!.event;
      if (
        event.streamVersion !== BigInt(index + 1)
        || event.streamId !== streamId
        || event.globalPosition <= previousPosition
      ) return integrity();
      previousPosition = event.globalPosition;
      this.#authenticateCommand(event);
    }
    return Object.freeze(events);
  }

  #sourceTickets(
    projectId: ProjectId,
    rootSessionId: SessionId,
    cutoff: bigint,
    children: ReadonlyMap<SessionId, readonly RawEvent[]>,
  ): readonly SourceTicket[] {
    const byTicket = new Map<string, Omit<SourceTicket, "row">>();
    const childWithTicket = new Set<SessionId>();
    for (const [childSessionId, events] of children) {
      for (const sourceEvent of events) {
        if (sourceEvent.event.eventType !== "ChildWorkTransferCreated") continue;
        const payload = decodeLifecycleEventPayload(
          "ChildWorkTransferCreated",
          sourceEvent.event.eventSchemaVersion,
          sourceEvent.event.payload,
        ) as Record<string, unknown>;
        const ticketId = parseCanonicalUuid(payload.transferTicketId, "transferTicketId");
        const checkpointId = parseCanonicalUuid(payload.checkpointId, "checkpointId");
        if (byTicket.has(ticketId) || childWithTicket.has(childSessionId)) return integrity();
        childWithTicket.add(childSessionId);
        byTicket.set(ticketId, { ticketId, sourceEvent, sourceChildSessionId: childSessionId, checkpointId });
      }
    }
    const rows = this.#connection.prepare(`
      SELECT t.*
      FROM child_transfer_tickets AS t
      WHERE t.project_id = $projectId
        AND t.source_parent_session_id = $rootSessionId
        AND t.created_event_position < $cutoff
      ORDER BY t.created_event_position ASC
    `).all({ $projectId: projectId, $rootSessionId: rootSessionId, $cutoff: cutoff });
    if (rows.length !== byTicket.size || rows.length > 1_000) return integrity();
    const result: SourceTicket[] = [];
    for (const row of rows) {
      const ticketId = parseCanonicalUuid(requiredString(row, "transfer_ticket_id"), "transferTicketId");
      const expected = byTicket.get(ticketId);
      if (
        expected === undefined
        || requiredString(row, "project_id") !== projectId
        || requiredString(row, "source_parent_session_id") !== rootSessionId
        || requiredString(row, "source_child_session_id") !== expected.sourceChildSessionId
        || requiredString(row, "checkpoint_id") !== expected.checkpointId
        || sqliteInt64(row, "created_event_position") !== expected.sourceEvent.event.globalPosition
      ) return integrity();
      parseCanonicalTimestamp(requiredString(row, "created_at"), "createdAt");
      result.push(Object.freeze({ ...expected, row }));
      byTicket.delete(ticketId);
    }
    if (byTicket.size !== 0) return integrity();
    return Object.freeze(result);
  }

  #claimPair(
    projectId: ProjectId,
    sourceRoot: StoredEvent,
    ticket: SourceTicket,
  ): Readonly<{ fork: RawEvent; claim: RawEvent }> | null {
    const claimRows = this.#connection.prepare(`
      SELECT e.*
      FROM events AS e INDEXED BY events_lifecycle_transfer_claim_v4
      WHERE e.project_id = $projectId
        AND json_extract(e.payload_json, '$.transferTicketId') = $ticketId
        AND e.stream_type = 'session'
        AND e.event_type = 'ChildWorkTransferClaimed'
        AND e.event_schema_version = 1
      ORDER BY e.global_position ASC
      LIMIT 2
    `).all({ $projectId: projectId, $ticketId: ticket.ticketId });
    const pointerValues = [
      ticket.row.claimed_by_root_session_id,
      ticket.row.claimed_child_session_id,
      ticket.row.claimed_event_position,
      ticket.row.claimed_at,
    ];
    const nullPointers = pointerValues.filter((value) => value === null).length;
    if (claimRows.length === 0) {
      if (nullPointers !== pointerValues.length) return integrity();
      return null;
    }
    if (claimRows.length !== 1 || nullPointers !== 0) return integrity();
    const claim = this.#raw(claimRows[0]!);
    const authenticated = this.#authenticateCommand(claim.event);
    if (authenticated.events.length !== 2) return integrity();
    const fork = authenticated.events[0];
    const pairedClaim = authenticated.events[1];
    if (fork === undefined || pairedClaim === undefined || pairedClaim.event.eventId !== claim.event.eventId) {
      return integrity();
    }
    normalizeCommittedLifecycleClosureEvent({ event: fork.event, command: authenticated.command });
    normalizeCommittedLifecycleClosureEvent({ event: pairedClaim.event, command: authenticated.command });
    const forkPayload = decodeLifecycleEventPayload(
      "SessionForked", 1, fork.event.payload,
    ) as Record<string, unknown>;
    const claimPayload = decodeLifecycleEventPayload(
      "ChildWorkTransferClaimed", 1, pairedClaim.event.payload,
    ) as Record<string, unknown>;
    const witnessJson = authenticated.command.intentWitnessJson;
    if (witnessJson === null) return integrity();
    const witnessCommand = decodeLifecycleIntentWitness(witnessJson).intent.command as unknown as Record<string, unknown>;
    if (
      fork.event.eventType !== "SessionForked"
      || fork.event.eventSchemaVersion !== 1
      || pairedClaim.event.eventType !== "ChildWorkTransferClaimed"
      || pairedClaim.event.eventSchemaVersion !== 1
      || fork.event.streamVersion !== 1n
      || pairedClaim.event.streamVersion !== 2n
      || fork.event.commandEventIndex !== 0
      || pairedClaim.event.commandEventIndex !== 1
      || fork.event.globalPosition + 1n !== pairedClaim.event.globalPosition
      || fork.event.streamId !== pairedClaim.event.streamId
      || fork.event.sessionId !== pairedClaim.event.sessionId
      || fork.event.parentSessionId === null
      || fork.event.parentSessionId === sourceRoot.sessionId
      || pairedClaim.event.parentSessionId !== fork.event.parentSessionId
      || pairedClaim.event.causationId !== fork.event.eventId
      || fork.event.causationId !== ticket.sourceEvent.event.eventId
      || !sameStoreIdentity(fork.event, sourceRoot)
      || !sameStoreIdentity(pairedClaim.event, sourceRoot)
      || !sameSourceIdentity(fork.event, pairedClaim.event)
      || forkPayload.parentSessionId !== fork.event.parentSessionId
      || forkPayload.sourceTransferTicketId !== ticket.ticketId
      || claimPayload.transferTicketId !== ticket.ticketId
      || claimPayload.previousChildSessionId !== ticket.sourceChildSessionId
      || claimPayload.previousTransferEventPosition !== ticket.sourceEvent.event.globalPosition.toString()
      || witnessCommand.commandType !== "claim-child-transfer"
      || witnessCommand.rootSessionId !== fork.event.parentSessionId
      || witnessCommand.transferTicketId !== ticket.ticketId
      || witnessCommand.expectedStreamVersion !== "0"
      || ticket.row.claimed_by_root_session_id !== fork.event.parentSessionId
      || ticket.row.claimed_child_session_id !== fork.event.sessionId
      || nullableInteger(ticket.row, "claimed_event_position") !== pairedClaim.event.globalPosition
      || ticket.row.claimed_at !== pairedClaim.event.occurredAt
    ) return integrity();
    return Object.freeze({ fork, claim: pairedClaim });
  }

  #authenticateCommand(event: StoredEvent): AuthenticatedCommand {
    const cacheKey = `${event.projectId}\n${event.commandId}`;
    const cached = this.#commandCache.get(cacheKey);
    if (cached !== undefined) {
      if (!cached.events.some((item) => item.event.eventId === event.eventId)) return integrity();
      return cached;
    }
    const dedupRows = this.#connection.prepare(`
      SELECT d.*
      FROM command_dedup AS d
      WHERE d.project_id = $projectId
        AND d.command_id = $commandId
        AND d.idempotency_key = $idempotencyKey
    `).all({
      $projectId: event.projectId,
      $commandId: event.commandId,
      $idempotencyKey: event.idempotencyKey,
    });
    if (dedupRows.length !== 1) return integrity();
    const dedup = dedupRows[0]!;
    const groupRows = this.#connection.prepare(`
      SELECT e.*
      FROM events AS e
      WHERE e.project_id = $projectId
        AND e.command_id = $commandId
      ORDER BY e.command_event_index ASC
    `).all({ $projectId: event.projectId, $commandId: event.commandId });
    if (groupRows.length === 0 || groupRows.length > 1_000) return integrity();
    const events = groupRows.map((row) => this.#raw(row));
    const first = events[0]!.event;
    const eventIds = strictJson(requiredString(dedup, "event_ids_json"));
    if (
      !Array.isArray(eventIds)
      || eventIds.length !== events.length
      || requiredString(dedup, "project_id") !== event.projectId
      || requiredString(dedup, "command_id") !== event.commandId
      || requiredString(dedup, "idempotency_key") !== event.idempotencyKey
      || dedup.state !== "committed"
      || sqliteInt64(dedup, "first_global_position") !== first.globalPosition
      || sqliteInt64(dedup, "last_global_position") !== events.at(-1)!.event.globalPosition
      || sqliteInt64(dedup, "final_stream_version") !== events.at(-1)!.event.streamVersion
      || eventIds.some((id, index) => id !== events[index]!.event.eventId)
    ) return integrity();
    for (let index = 0; index < events.length; index += 1) {
      const current = events[index]!.event;
      if (
        current.commandEventIndex !== index
        || current.commandId !== first.commandId
        || current.idempotencyKey !== first.idempotencyKey
        || current.projectId !== first.projectId
        || current.vaultId !== first.vaultId
        || current.storeId !== first.storeId
        || current.workspaceId !== first.workspaceId
        || current.branchScopeId !== first.branchScopeId
        || current.branchRef !== first.branchRef
        || current.streamId !== first.streamId
        || current.streamType !== first.streamType
        || current.actorRole !== first.actorRole
        || current.agentId !== first.agentId
        || current.clientInstanceId !== first.clientInstanceId
        || current.correlationId !== first.correlationId
        || current.recordedAt !== first.recordedAt
        || current.streamVersion !== first.streamVersion + BigInt(index)
        || current.globalPosition !== first.globalPosition + BigInt(index)
        || (index === 0 ? current.lifecycleIntentJson === null : current.lifecycleIntentJson !== null)
      ) return integrity();
    }
    const witnessJson = first.lifecycleIntentJson;
    if (witnessJson === undefined || witnessJson === null) return integrity();
    const witness = decodeLifecycleIntentWitness(witnessJson);
    const commandHash = requiredString(dedup, "command_hash");
    const kind = dedup.lifecycle_authorization_kind;
    if (
      !LOWER_HASH.test(commandHash)
      || lifecycleIntentHashFromWitnessSource(witnessJson) !== commandHash
      || typeof kind !== "string"
      || !AUTH_KINDS.has(kind as LifecycleIntentAuthorizationKind)
      || witness.persistedAssertions.authorizationKind !== kind
      || requiredString(dedup, "command_type") !== (witness.intent.command as { commandType: string }).commandType
    ) return integrity();
    this.#assertAuthorizationRow(dedup, witness.persistedAssertions);
    const legacyEffectiveState = (
      (first.eventType === "SessionEndRequested" || first.eventType === "SessionEndAmended")
      && (first.eventSchemaVersion === 1 || first.eventSchemaVersion === 2)
    )
      ? readLegacySessionEndEffectiveStateSourceV1(this.#connection, {
        projectId: first.projectId,
        sourceEventPosition: first.globalPosition,
      }).effectiveState
      : null;
    const command = Object.freeze({
      commandHash,
      lifecycleAuthorizationKind: kind as LifecycleIntentAuthorizationKind,
      intentWitnessJson: witnessJson,
      witnessEventId: first.eventId,
      legacyEffectiveState,
    });
    const authenticated = Object.freeze({ command, events: Object.freeze(events) });
    this.#commandCache.set(cacheKey, authenticated);
    return authenticated;
  }

  #assertAuthorizationRow(
    row: SqliteRow,
    assertions: ReturnType<typeof decodeLifecycleIntentWitness>["persistedAssertions"],
  ): void {
    const kind = assertions.authorizationKind;
    if (
      row.lifecycle_authorization_kind !== kind
      || row.authorization_session_id !== assertions.authorizationSessionId
      || row.target_session_id !== assertions.targetSessionId
      || row.presenting_actor_role !== assertions.presentingActorRole
      || row.presenting_client_instance_id !== assertions.presentingClientInstanceId
      || row.target_actor_role !== assertions.targetActorRole
      || row.target_client_instance_id !== assertions.targetClientInstanceId
    ) return integrity();
    if (!ACTOR_ROLES.has(assertions.presentingActorRole) || !ACTOR_ROLES.has(assertions.targetActorRole)) {
      return integrity();
    }
    const proof = [
      row.authorization_proof_version,
      row.authorization_proof_nonce,
      row.authorization_proof_digest,
    ];
    const approval = [row.authorization_approval_id, row.authorization_approval_digest];
    const proofPresent = proof.every((value) => value !== null);
    const approvalPresent = approval.every((value) => value !== null);
    if (proof.some((value) => value !== null) !== proofPresent
      || approval.some((value) => value !== null) !== approvalPresent) return integrity();
    if (proofPresent) {
      if (
        sqliteInt64(row, "authorization_proof_version") !== 1n
        || parseCanonicalUuid(row.authorization_proof_nonce, "proofNonce") !== row.authorization_proof_nonce
        || typeof row.authorization_proof_digest !== "string"
        || !LOWER_HASH.test(row.authorization_proof_digest)
      ) return integrity();
    }
    if (approvalPresent) {
      if (
        parseCanonicalUuid(row.authorization_approval_id, "approvalId") !== row.authorization_approval_id
        || typeof row.authorization_approval_digest !== "string"
        || !LOWER_HASH.test(row.authorization_approval_digest)
      ) return integrity();
    }
    if (kind === "initial-authority") {
      if (
        assertions.authorizationSessionId !== null
        || proofPresent
        || approvalPresent
        || row.internal_workflow_id !== null
        || row.internal_workflow_generation !== null
        || row.internal_planned_work_id !== null
        || row.internal_claim_owner_id !== null
        || row.internal_claim_token !== null
      ) return integrity();
      return;
    }
    parseCanonicalUuid(assertions.authorizationSessionId, "authorizationSessionId");
    if (kind === "protected") {
      if (
        (!proofPresent && !approvalPresent)
        || ((proofPresent && approvalPresent) !== (row.command_type === "abandon-session"))
        || row.internal_workflow_id !== null
        || row.internal_workflow_generation !== null
        || row.internal_planned_work_id !== null
        || row.internal_claim_owner_id !== null
        || row.internal_claim_token !== null
      ) return integrity();
      return;
    }
    if (
      proofPresent
      || approvalPresent
      || row.internal_workflow_id !== assertions.internalWorkflowId
      || nullableInteger(row, "internal_workflow_generation") !== BigInt(assertions.internalWorkflowGeneration ?? 0)
      || row.internal_planned_work_id !== assertions.internalPlannedWorkId
      || nullableString(row, "internal_claim_owner_id") === null
      || nullableInteger(row, "internal_claim_token") === null
    ) return integrity();
  }

  #raw(row: SqliteRow): RawEvent {
    return Object.freeze({ row, event: this.#stored(row) });
  }

  #stored(row: SqliteRow): StoredEvent {
    const payloadJson = requiredString(row, "payload_json");
    const payload = strictJson(payloadJson);
    const sourceRefs = stringArrayJson(row, "source_refs_json");
    const evidenceRefs = emptyArrayJson(row, "evidence_refs_json");
    const evidenceDigests = emptyArrayJson(row, "evidence_digests_json");
    const branchScopeId = nullableString(row, "branch_scope_id");
    const lifecycleIntentJson = row.lifecycle_intent_json === null
      ? null
      : requiredString(row, "lifecycle_intent_json");
    return Object.freeze({
      globalPosition: sqliteInt64(row, "global_position"),
      eventId: requiredString(row, "event_id"),
      projectId: requiredString(row, "project_id") as StoredEvent["projectId"],
      vaultId: requiredString(row, "vault_id") as StoredEvent["vaultId"],
      storeId: requiredString(row, "store_id") as StoredEvent["storeId"],
      workspaceId: requiredString(row, "workspace_id") as StoredEvent["workspaceId"],
      branchScopeId: branchScopeId as StoredEvent["branchScopeId"],
      branchRef: nullableString(row, "branch_ref"),
      streamId: requiredString(row, "stream_id"),
      streamType: requiredString(row, "stream_type"),
      streamVersion: sqliteInt64(row, "stream_version"),
      eventType: requiredString(row, "event_type"),
      eventSchemaVersion: safeInteger(row, "event_schema_version", 1),
      sessionId: nullableString(row, "session_id"),
      parentSessionId: nullableString(row, "parent_session_id"),
      actorRole: requiredString(row, "actor_role") as StoredEvent["actorRole"],
      agentId: requiredString(row, "agent_id"),
      clientInstanceId: requiredString(row, "client_instance_id"),
      correlationId: requiredString(row, "correlation_id"),
      causationId: nullableString(row, "causation_id"),
      commandId: requiredString(row, "command_id"),
      idempotencyKey: requiredString(row, "idempotency_key"),
      commandEventIndex: safeInteger(row, "command_event_index", 0),
      occurredAt: requiredString(row, "occurred_at"),
      recordedAt: requiredString(row, "recorded_at"),
      visibilityScope: requiredString(row, "visibility_scope") as StoredEvent["visibilityScope"],
      confidence: requiredString(row, "confidence") as StoredEvent["confidence"],
      verificationStatus: requiredString(row, "verification_status") as StoredEvent["verificationStatus"],
      sourceRefs,
      evidenceRefs,
      evidenceDigests,
      payload: payload as StoredEvent["payload"],
      payloadJson,
      payloadHash: requiredString(row, "payload_hash"),
      previousGlobalHash: requiredString(row, "previous_global_hash"),
      eventHash: requiredString(row, "event_hash"),
      lifecycleIntentJson,
    });
  }
}
