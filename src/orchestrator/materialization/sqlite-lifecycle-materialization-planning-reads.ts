import type { ProjectId } from "../identity/contracts.js";
import {
  decodeLifecycleMaterializationPayloadV1,
  type LifecycleMaterializationPlanningReads,
  type LifecycleOutboxPlannedRevision,
} from "../lifecycle/materialization-queue.port.js";
import {
  parseCanonicalUuid,
  parseLifecycleId,
  type SessionId,
} from "../lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { LifecycleOutboxRepository } from "../storage/lifecycle-outbox.repository.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { SqliteLifecycleRenderClosureReader } from "./sqlite-lifecycle-render-closure.reader.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const COMPATIBILITY_ARTIFACT_KIND = "compatibility-session-log" as const;

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return integrity();
  }
}

function sqliteInteger(value: unknown, minimum: bigint): bigint {
  const result = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
        ? BigInt(value)
        : integrity();
  if (result < minimum || result > SQLITE_INT64_MAX) integrity();
  return result;
}

function strictPayload(row: SqliteRow): ReturnType<typeof decodeLifecycleMaterializationPayloadV1> {
  const payloadJson = row.payload_json;
  if (typeof payloadJson !== "string" || canonicalJson(JSON.parse(payloadJson)) !== payloadJson) {
    return integrity();
  }
  return decodeLifecycleMaterializationPayloadV1(JSON.parse(payloadJson));
}

/** Narrow, indexed planning reads used by the connection-bound materialization queue. */
export class SqliteLifecycleMaterializationPlanningReads implements LifecycleMaterializationPlanningReads {
  readonly #connection: SqliteConnection;
  readonly #closureReader: SqliteLifecycleRenderClosureReader;
  readonly #outboxRepository: LifecycleOutboxRepository;

  constructor(
    connection: SqliteConnection,
    options: Readonly<{
      readonly closureReader?: SqliteLifecycleRenderClosureReader;
      readonly outboxRepository?: LifecycleOutboxRepository;
    }> = {},
  ) {
    this.#connection = connection;
    this.#closureReader = options.closureReader ?? new SqliteLifecycleRenderClosureReader(connection);
    this.#outboxRepository = options.outboxRepository ?? new LifecycleOutboxRepository();
  }

  readGlobalTailPosition(): bigint {
    return boundary(() => {
      const row = this.#connection.prepare(`
        SELECT COALESCE(MAX(global_position), 0) AS maximum_position
        FROM events
      `).get();
      if (row === undefined) integrity();
      return sqliteInteger(row.maximum_position, 0n);
    });
  }

  readStrictLifecycleClosure(
    projectId: ProjectId,
    rootSessionId: SessionId,
    throughPositionExclusive: bigint,
  ) {
    return boundary(() => this.#closureReader.readStrictLifecycleClosure(
      projectId,
      rootSessionId,
      throughPositionExclusive,
    ));
  }

  readVerifiedImmediatePredecessor(
    projectId: ProjectId,
    sessionId: SessionId,
    artifactKind: "compatibility-session-log",
    beforeRevision: bigint,
  ): LifecycleOutboxPlannedRevision | null {
    return boundary(() => {
      parseCanonicalUuid(projectId, "projectId");
      parseLifecycleId<SessionId>(sessionId, "sessionId");
      if (artifactKind !== COMPATIBILITY_ARTIFACT_KIND) integrity();
      if (typeof beforeRevision !== "bigint" || beforeRevision < 1n || beforeRevision > SQLITE_INT64_MAX) {
        integrity();
      }
      const row = this.#connection.prepare(`
        SELECT materialization_revision, payload_json
        FROM outbox
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND artifact_kind = $artifactKind
          AND materialization_revision < $beforeRevision
        ORDER BY materialization_revision DESC
        LIMIT 1
      `).get({
        $projectId: projectId,
        $sessionId: sessionId,
        $artifactKind: artifactKind,
        $beforeRevision: beforeRevision,
      });
      if (row === undefined) return null;
      const payload = strictPayload(row);
      const revision = BigInt(payload.materializationRevision);
      if (revision !== beforeRevision - 1n) integrity();
      const common = {
        projectId,
        sessionId,
        artifactKind: COMPATIBILITY_ARTIFACT_KIND,
        materializationRevision: revision,
        triggeringEventPosition: revision,
      };
      if (payload.origin.kind === "workflow") {
        return this.#outboxRepository.assertExactPlannedRevision(this.#connection, {
          ...common,
          origin: payload.origin,
          triggeringEventType: payload.triggeringEventType,
        });
      }
      return this.#outboxRepository.assertExactPlannedRevision(this.#connection, {
        ...common,
        origin: payload.origin,
        triggeringEventType: "SessionAbandoned",
      });
    });
  }
}
