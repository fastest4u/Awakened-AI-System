import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import { outboxHash, payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type { ProjectId, WorkspaceId, VaultId, StoreId } from "../src/orchestrator/identity/contracts.js";
import {
  COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
  decodePendingLifecycleOutboxV1,
  type ExactPlannedRevisionQuery,
  type PendingLifecycleOutboxV1,
} from "../src/orchestrator/lifecycle/materialization-queue.port.js";
import type { SessionId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type { LifecycleFaultInjector } from "../src/orchestrator/lifecycle/lifecycle-faults.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { LifecycleOutboxRepository } from "../src/orchestrator/storage/lifecycle-outbox.repository.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const SESSION_ID = "44444444-4444-4444-8444-444444444444" as SessionId;
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_ID = "a".repeat(64) as WorkspaceId;
const PAYLOAD_HASH = "b".repeat(64);
const FINGERPRINT_A = "c".repeat(64);
const FINGERPRINT_B = "d".repeat(64);
const NOW = "2026-08-09T00:10:00.000Z";

function db(): SqliteConnection {
  const connection = new DatabaseSync(":memory:") as unknown as SqliteConnection;
  connection.exec(`
    CREATE TABLE events (
      project_id TEXT NOT NULL,
      global_position INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      session_id TEXT,
      stream_type TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      command_event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_schema_version INTEGER NOT NULL,
      parent_session_id TEXT,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workflow_instances (
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE outbox (
      project_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      event_position INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      claim_owner TEXT,
      claim_token INTEGER,
      claim_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_id TEXT,
      origin_kind TEXT,
      workflow_id TEXT,
      workflow_generation INTEGER,
      artifact_kind TEXT,
      artifact_path TEXT,
      materialization_revision INTEGER,
      expected_prior_fingerprint TEXT,
      next_fingerprint TEXT,
      fingerprint_algorithm TEXT,
      fingerprint_schema_version INTEGER,
      fingerprint_key_id TEXT,
      fingerprint_domain TEXT,
      failure_class TEXT,
      safe_error_code TEXT,
      next_attempt_at TEXT
    ) STRICT;
  `);
  return connection;
}

function fingerprint(value: string, keyId = "key-1"): Record<string, unknown> {
  return {
    algorithm: "hmac-sha256",
    schemaVersion: 1,
    keyId,
    domain: "pm-materialization-fingerprint-v1",
    value,
  };
}

function pending(
  revision: bigint,
  eventType = "SessionEndVerificationFailed",
  origin: Record<string, unknown> = {
    kind: "workflow",
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
  },
  nextFingerprint = FINGERPRINT_A,
  triggeringPayloadHash = PAYLOAD_HASH,
  keyId = "key-1",
): PendingLifecycleOutboxV1 {
  const targetKey = `lifecycle-log/${SESSION_ID}/${revision.toString()}`;
  return decodePendingLifecycleOutboxV1({
    targetKey,
    kind: "materialize-lifecycle-log",
    eventIndex: 0,
    payload: {
      payloadVersion: 1,
      targetKey,
      sessionId: SESSION_ID,
      artifactKind: COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
      artifactPath: `05_Agent_Session_Logs/2026-08-09-session-${SESSION_ID}.md`,
      materializationRevision: revision.toString(),
      triggeringPayloadHash,
      nextFingerprint: fingerprint(nextFingerprint, keyId),
      origin,
      triggeringEventType: eventType,
    },
  });
}

function event(
  globalPosition: bigint,
  eventType = "SessionEndVerificationFailed",
  eventSchemaVersion = 1,
  payload: Record<string, unknown> = {
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    validationResultIds: [],
    safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
  },
): StoredEvent {
  const payloadJson = canonicalJson(payload);
  return {
    globalPosition,
    eventId: `66666666-6666-4666-8666-${globalPosition.toString().padStart(12, "0")}`,
    projectId: PROJECT_ID,
    vaultId: "22222222-2222-4222-8222-222222222222" as VaultId,
    storeId: "33333333-3333-4333-8333-333333333333" as StoreId,
    workspaceId: WORKSPACE_ID,
    branchScopeId: null,
    branchRef: null,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: globalPosition,
    eventType,
    eventSchemaVersion,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "agent-1",
    clientInstanceId: "client-1",
    correlationId: "77777777-7777-4777-8777-777777777777",
    causationId: null,
    commandId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: `idempotency-${globalPosition.toString()}`,
    commandEventIndex: 0,
    occurredAt: "2026-08-09T00:09:00.000Z",
    recordedAt: NOW,
    visibilityScope: "project",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payload,
    payloadJson,
    payloadHash: payloadHash(payload),
    previousGlobalHash: "0".repeat(64),
    eventHash: "1".repeat(64),
  } as unknown as StoredEvent;
}

function insertEvent(connection: SqliteConnection, stored: StoredEvent): void {
  connection.prepare(`
    INSERT INTO events(
      project_id, global_position, event_id, session_id, stream_type, stream_id,
      stream_version, command_event_index, event_type, event_schema_version, parent_session_id, payload_json,
      payload_hash, occurred_at
    ) VALUES (
      $projectId, $position, $eventId, $sessionId, $streamType, $streamId,
      $streamVersion, $eventIndex, $eventType, $eventSchemaVersion, $parentSessionId, $payloadJson,
      $payloadHash, $occurredAt
    )
  `).run({
    $projectId: stored.projectId,
    $position: stored.globalPosition,
    $eventId: stored.eventId,
    $sessionId: stored.sessionId,
    $streamType: stored.streamType,
    $streamId: stored.streamId,
    $streamVersion: stored.streamVersion,
    $eventIndex: stored.commandEventIndex,
    $eventType: stored.eventType,
    $eventSchemaVersion: stored.eventSchemaVersion,
    $parentSessionId: stored.parentSessionId,
    $payloadJson: stored.payloadJson,
    $payloadHash: stored.payloadHash,
    $occurredAt: stored.occurredAt,
  });
}

function seedStartedAndWorkflow(connection: SqliteConnection): void {
  connection.prepare(`
    INSERT INTO events(
      project_id, global_position, event_id, session_id, stream_type, stream_id,
      stream_version, command_event_index, event_type, event_schema_version, parent_session_id, payload_json,
      payload_hash, occurred_at
    ) VALUES ($projectId, 1, $eventId, $sessionId, 'session', $streamId, 1, 0,
      'SessionStarted', 1, NULL, '{}', $payloadHash, '2026-08-09T00:00:00.000Z')
  `).run({
    $projectId: PROJECT_ID,
    $eventId: "66666666-6666-4666-8666-666666666666",
    $sessionId: SESSION_ID,
    $streamId: `session/${SESSION_ID}`,
    $payloadHash: payloadHash({}),
  });
  connection.prepare(`
    INSERT INTO workflow_instances(project_id, workflow_id, session_id, generation)
    VALUES ($projectId, $workflowId, $sessionId, 1)
  `).run({
    $projectId: PROJECT_ID,
    $workflowId: WORKFLOW_ID,
    $sessionId: SESSION_ID,
  });
}

function query(revision: bigint, origin: ExactPlannedRevisionQuery["origin"] = {
  kind: "workflow",
  workflowId: WORKFLOW_ID as never,
  workflowGeneration: 1,
}): ExactPlannedRevisionQuery {
  return {
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    artifactKind: COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
    materializationRevision: revision,
    triggeringEventPosition: revision,
    origin,
    triggeringEventType: "SessionEndVerificationFailed",
  } as ExactPlannedRevisionQuery;
}

function setup(revision = 7n, insertTrigger = true): {
  connection: SqliteConnection;
  repository: LifecycleOutboxRepository;
  storedEvent: StoredEvent;
  pendingOutbox: PendingLifecycleOutboxV1;
} {
  const connection = db();
  seedStartedAndWorkflow(connection);
  const storedEvent = event(revision);
  if (insertTrigger) insertEvent(connection, storedEvent);
  const pendingOutbox = pending(revision, "SessionEndVerificationFailed", undefined, FINGERPRINT_A, storedEvent.payloadHash);
  return {
    connection,
    repository: new LifecycleOutboxRepository(),
    storedEvent,
    pendingOutbox,
  };
}

describe("LifecycleOutboxRepository", () => {
  it("normalizes a before-write insert fault without persisting an outbox row", () => {
    const fixture = setup();
    const hits: Array<{
      readonly boundary: string;
      readonly point: string;
      readonly context: unknown;
    }> = [];
    const faultInjector: LifecycleFaultInjector = {
      hit(boundary, point, context): void {
        hits.push({ boundary, point, context });
        throw new Error("INJECTED_OUTBOX_INSERT_FAULT");
      },
    };
    const repository = new LifecycleOutboxRepository({ faultInjector });

    assert.throws(
      () => repository.insertLifecycle(
        fixture.connection,
        fixture.pendingOutbox,
        fixture.storedEvent,
        NOW,
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof LifecycleError);
        assert.equal(error.code, "INTEGRITY_FAILURE");
        return true;
      },
    );
    assert.deepEqual(hits, [{
      boundary: "outbox-insert",
      point: "before-write",
      context: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        workflowId: WORKFLOW_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        idempotencyKeyHash: null,
        workId: `lifecycle-log/${SESSION_ID}/7`,
        eventPosition: "7",
        materializationRevision: "7",
      },
    }]);
    assert.equal(
      fixture.connection.prepare("SELECT count(*) AS count FROM outbox").get()?.count,
      0,
    );
  });

  it("claims the current pending revision with a fresh fenced token", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(
      fixture.connection,
      fixture.pendingOutbox,
      fixture.storedEvent,
      NOW,
    );

    const claim = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });

    assert.equal(claim?.planned.materializationRevision, 7n);
    assert.equal(claim?.status, "claimed");
    assert.equal(claim?.claimOwner, "materializer-a");
    assert.equal(claim?.claimToken, 1n);
    assert.equal(claim?.claimExpiresAt, "2026-08-09T00:10:30.000Z");
    assert.equal(fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-b",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    }), null);
  });

  it("takes over an expired claim with an incremented token", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(
      fixture.connection,
      fixture.pendingOutbox,
      fixture.storedEvent,
      NOW,
    );
    const first = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.equal(first?.claimToken, 1n);

    const takeover = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-b",
      observedNowMs: BigInt(Date.parse("2026-08-09T00:10:31.000Z")),
      leaseDurationMs: 30_000n,
    });
    assert.equal(takeover?.claimOwner, "materializer-b");
    assert.equal(takeover?.claimToken, 2n);
    assert.equal(takeover?.attemptCount, 2n);
  });

  it("claims only the newest revision for a canonical artifact", () => {
    const fixture = setup(7n);
    fixture.repository.insertLifecycle(
      fixture.connection,
      fixture.pendingOutbox,
      fixture.storedEvent,
      NOW,
    );
    const nextEvent = event(8n);
    insertEvent(fixture.connection, nextEvent);
    fixture.repository.insertLifecycle(
      fixture.connection,
      pending(8n, "SessionEndVerificationFailed", undefined, FINGERPRINT_B, nextEvent.payloadHash),
      nextEvent,
      NOW,
    );

    const claim = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.equal(claim?.planned.materializationRevision, 8n);
    assert.equal(fixture.connection.prepare(
      "SELECT status FROM outbox WHERE materialization_revision = 7",
    ).get()?.status, "pending");
  });

  it("returns an exact live claim and renews only its owner and token", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(
      fixture.connection,
      fixture.pendingOutbox,
      fixture.storedEvent,
      NOW,
    );
    const claim = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.ok(claim);

    const exact = fixture.repository.getExactClaim(fixture.connection, {
      projectId: PROJECT_ID,
      targetKey: fixture.pendingOutbox.targetKey,
      materializationRevision: 7n,
      ownerId: "materializer-a",
      claimToken: claim.claimToken,
    });
    assert.equal(exact.status, "claimed");
    assert.equal(exact.claimExpiresAt, "2026-08-09T00:10:30.000Z");

    const renewed = fixture.repository.renewClaim(fixture.connection, {
      projectId: PROJECT_ID,
      targetKey: fixture.pendingOutbox.targetKey,
      materializationRevision: 7n,
      ownerId: "materializer-a",
      claimToken: claim.claimToken,
      observedNowMs: BigInt(Date.parse("2026-08-09T00:10:05.000Z")),
      leaseDurationMs: 60_000n,
    });
    assert.equal(renewed?.claimExpiresAt, "2026-08-09T00:11:05.000Z");
    assert.equal(fixture.repository.renewClaim(fixture.connection, {
      projectId: PROJECT_ID,
      targetKey: fixture.pendingOutbox.targetKey,
      materializationRevision: 7n,
      ownerId: "stale-owner",
      claimToken: claim.claimToken,
      observedNowMs: BigInt(Date.parse("2026-08-09T00:10:06.000Z")),
      leaseDurationMs: 60_000n,
    }), null);
  });

  it("lists only committed lower-revision fingerprints for the exact artifact lineage", () => {
    const fixture = setup(7n);
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    fixture.connection.exec("UPDATE outbox SET status = 'completed', attempt_count = 1, claim_owner = 'worker', claim_token = 1");
    const nextEvent = event(8n);
    insertEvent(fixture.connection, nextEvent);
    fixture.repository.insertLifecycle(
      fixture.connection,
      pending(8n, "SessionEndVerificationFailed", undefined, FINGERPRINT_B, nextEvent.payloadHash),
      nextEvent,
      NOW,
    );
    const claim = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.ok(claim);
    assert.deepEqual(
      fixture.repository.listCommittedLowerRevisionFingerprints(fixture.connection, claim),
      [fixture.pendingOutbox.payload.nextFingerprint],
    );
  });

  it("records bounded retry backoff and permanent failure under the live fence", () => {
    const retry = setup();
    retry.repository.insertLifecycle(retry.connection, retry.pendingOutbox, retry.storedEvent, NOW);
    const retryClaim = retry.repository.claimNext(retry.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.ok(retryClaim);
    assert.equal(retry.repository.recordFailure(retry.connection, {
      projectId: PROJECT_ID,
      targetKey: retry.pendingOutbox.targetKey,
      materializationRevision: 7n,
      ownerId: retryClaim.claimOwner,
      claimToken: retryClaim.claimToken,
      observedNowMs: BigInt(Date.parse(NOW)),
      failureClass: "retryable",
      safeErrorCode: "MATERIALIZATION_CONFLICT",
      nextAttemptAt: "2026-08-09T00:10:01.000Z",
    }), true);
    assert.equal(retry.connection.prepare("SELECT status, next_attempt_at FROM outbox").get()?.status, "failed");
    assert.equal(retry.connection.prepare("SELECT next_attempt_at FROM outbox").get()?.next_attempt_at, "2026-08-09T00:10:01.000Z");

    const permanent = setup();
    permanent.repository.insertLifecycle(permanent.connection, permanent.pendingOutbox, permanent.storedEvent, NOW);
    const permanentClaim = permanent.repository.claimNext(permanent.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.ok(permanentClaim);
    assert.equal(permanent.repository.recordFailure(permanent.connection, {
      projectId: PROJECT_ID,
      targetKey: permanent.pendingOutbox.targetKey,
      materializationRevision: 7n,
      ownerId: permanentClaim.claimOwner,
      claimToken: permanentClaim.claimToken,
      observedNowMs: BigInt(Date.parse(NOW)),
      failureClass: "permanent",
      safeErrorCode: "INTEGRITY_FAILURE",
      nextAttemptAt: null,
    }), true);
    const permanentRow = permanent.connection.prepare("SELECT status, next_attempt_at FROM outbox").get();
    assert.equal(permanentRow?.status, "failed");
    assert.equal(permanentRow?.next_attempt_at, null);
  });

  it("acknowledges only the exact replaced fingerprint and retains the completion fence", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    const claim = fixture.repository.claimNext(fixture.connection, {
      projectId: PROJECT_ID,
      ownerId: "materializer-a",
      observedNowMs: BigInt(Date.parse(NOW)),
      leaseDurationMs: 30_000n,
    });
    assert.ok(claim);
    const result = fixture.repository.acknowledgeAfterReplacement(fixture.connection, {
      projectId: PROJECT_ID,
      targetKey: fixture.pendingOutbox.targetKey,
      materializationRevision: 7n,
      ownerId: claim.claimOwner,
      claimToken: claim.claimToken,
      completedAt: NOW,
      targetPath: fixture.pendingOutbox.payload.artifactPath,
      targetFingerprint: fixture.pendingOutbox.payload.nextFingerprint,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.claim.status, "completed");
    assert.equal(result.claim.claimExpiresAt, null);
    assert.equal(fixture.connection.prepare("SELECT status FROM outbox").get()?.status, "completed");
  });

  it("requires a Version 3 checkpoint and direct workflow-origin binding", () => {
    const fixture = setup();
    assert.doesNotThrow(() => fixture.repository.insertLifecycle(
      fixture.connection,
      fixture.pendingOutbox,
      fixture.storedEvent,
      NOW,
    ));

    const checkpoint = setup(7n, false);
    const nestedCheckpoint = checkpointFixture({
      sessionId: SESSION_ID,
      parentSessionId: null,
      baseEventPosition: "6",
      checkpointEventPosition: "7",
    });
    const checkpointEvent = event(7n, "SessionCheckpointRecorded", 3, {
      checkpoint: {
        ...nestedCheckpoint,
        sourceState: {
          ...nestedCheckpoint.sourceState,
          workspaceId: WORKSPACE_ID,
        },
      },
      baseEventPosition: "6",
      checkpointEventPosition: "7",
      finalCheckpointBindingVersion: 1,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
    });
    insertEvent(checkpoint.connection, checkpointEvent);
    assert.doesNotThrow(() => checkpoint.repository.insertLifecycle(
      checkpoint.connection,
      pending(7n, "SessionCheckpointRecorded", undefined, FINGERPRINT_A, checkpointEvent.payloadHash),
      checkpointEvent,
      NOW,
    ));

    const legacyCheckpoint = setup(7n, false);
    const legacyCheckpointEvent = event(7n, "SessionCheckpointRecorded", 2, nestedCheckpoint as unknown as Record<string, unknown>);
    insertEvent(legacyCheckpoint.connection, legacyCheckpointEvent);
    assert.throws(() => legacyCheckpoint.repository.insertLifecycle(
      legacyCheckpoint.connection,
      pending(7n, "SessionCheckpointRecorded", undefined, FINGERPRINT_A, legacyCheckpointEvent.payloadHash),
      legacyCheckpointEvent,
      NOW,
    ), /INTEGRITY_FAILURE/);

    const foreign = setup();
    assert.throws(() => foreign.repository.insertLifecycle(
      foreign.connection,
      pending(7n, "SessionEndVerificationFailed", {
        kind: "workflow",
        workflowId: "99999999-9999-4999-8999-999999999999",
        workflowGeneration: 1,
      }, FINGERPRINT_A, foreign.storedEvent.payloadHash),
      foreign.storedEvent,
      NOW,
    ), /INTEGRITY_FAILURE/);
  });

  it("recomputes lifecycle content hash before insert and read", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(
      fixture.connection,
      fixture.pendingOutbox,
      fixture.storedEvent,
      NOW,
    );
    assert.equal(
      fixture.connection.prepare("SELECT content_hash FROM outbox").get()?.content_hash,
      outboxHash(fixture.pendingOutbox.payload),
    );
    fixture.connection.exec(`UPDATE outbox SET content_hash = '${"e".repeat(64)}'`);
    assert.throws(
      () => fixture.repository.getExactPlannedRevision(
        fixture.connection,
        query(7n),
      ),
      /INTEGRITY_FAILURE/,
    );
  });

  it("derives prior fingerprint from the immediate lower revision regardless of status", () => {
    const fixture = setup(7n);
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    fixture.connection.exec("UPDATE outbox SET status = 'completed', attempt_count = 1, claim_owner = 'worker', claim_token = 1");
    const nextEvent = event(8n);
    insertEvent(fixture.connection, nextEvent);
    fixture.repository.insertLifecycle(
      fixture.connection,
      pending(8n, "SessionEndVerificationFailed", undefined, FINGERPRINT_B, nextEvent.payloadHash),
      nextEvent,
      NOW,
    );
    const row = fixture.connection.prepare(`
      SELECT expected_prior_fingerprint, fingerprint_key_id, next_fingerprint
      FROM outbox WHERE materialization_revision = 8
    `).get();
    assert.equal(row?.expected_prior_fingerprint, FINGERPRINT_A);
    assert.equal(row?.fingerprint_key_id, "key-1");
    assert.equal(row?.next_fingerprint, FINGERPRINT_B);
  });

  it("uses null prior only when no lower revision exists", () => {
    const fixture = setup(7n);
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    assert.equal(
      fixture.connection.prepare("SELECT expected_prior_fingerprint FROM outbox").get()?.expected_prior_fingerprint,
      null,
    );
    const gap = setup(9n);
    gap.repository.insertLifecycle(gap.connection, gap.pendingOutbox, gap.storedEvent, NOW);
    const gapNext = event(11n);
    insertEvent(gap.connection, gapNext);
    assert.throws(() => gap.repository.insertLifecycle(
      gap.connection,
      pending(11n, "SessionEndVerificationFailed", undefined, FINGERPRINT_A, gapNext.payloadHash),
      gapNext,
      NOW,
    ), /INTEGRITY_FAILURE/);
  });

  it("rejects a lower revision on a foreign canonical path", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    fixture.connection.exec("UPDATE outbox SET artifact_path = '05_Agent_Session_Logs/foreign.md'");
    const nextEvent = event(8n);
    insertEvent(fixture.connection, nextEvent);
    assert.throws(() => fixture.repository.insertLifecycle(
      fixture.connection,
      pending(8n, "SessionEndVerificationFailed", undefined, FINGERPRINT_A, nextEvent.payloadHash),
      nextEvent,
      NOW,
    ), /INTEGRITY_FAILURE/);
  });

  it("preserves historical key tuples without replacing them after rotation", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    const nextEvent = event(8n);
    insertEvent(fixture.connection, nextEvent);
    fixture.repository.insertLifecycle(
      fixture.connection,
      pending(8n, "SessionEndVerificationFailed", undefined, FINGERPRINT_B, nextEvent.payloadHash, "key-2"),
      nextEvent,
      NOW,
    );
    const predecessor = fixture.repository.getExactPlannedRevision(fixture.connection, query(7n));
    const current = fixture.repository.getExactPlannedRevision(fixture.connection, query(8n));
    assert.equal(predecessor?.nextFingerprint.keyId, "key-1");
    assert.equal(current?.expectedPriorFingerprint?.value, FINGERPRINT_A);
    assert.equal(current?.nextFingerprint.keyId, "key-2");
  });

  it("returns the exact planned revision in every operational status", () => {
    for (const status of ["pending", "claimed", "completed", "failed"] as const) {
      const fixture = setup();
      fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
      if (status === "claimed" || status === "completed") {
        fixture.connection.prepare(`
          UPDATE outbox
          SET status = $status, attempt_count = 1, claim_owner = 'worker', claim_token = 1,
              claim_expires_at = $expires, failure_class = NULL, safe_error_code = NULL,
              next_attempt_at = NULL
        `).run({
          $status: status,
          $expires: status === "claimed" ? NOW : null,
        });
      } else if (status === "failed") {
        fixture.connection.exec("UPDATE outbox SET status = 'failed', attempt_count = 1, failure_class = 'permanent', safe_error_code = 'FAILED'");
      }
      const plan = fixture.repository.getExactPlannedRevision(fixture.connection, query(7n));
      assert.ok(plan);
      const asserted = fixture.repository.assertExactPlannedRevision(fixture.connection, query(7n));
      assert.equal(plan.targetKey, fixture.pendingOutbox.targetKey);
      assert.deepEqual(plan.nextFingerprint, fixture.pendingOutbox.payload.nextFingerprint);
      assert.deepEqual(asserted, plan);
    }
  });

  it("confirms the exact planned row before advancing phase", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    assert.equal(fixture.repository.getExactPlannedRevision(fixture.connection, query(6n)), null);
    assert.throws(() => fixture.repository.assertExactPlannedRevision(fixture.connection, query(6n)), /INTEGRITY_FAILURE/);
    assert.throws(() => fixture.repository.getExactPlannedRevision(
      fixture.connection,
      { ...query(7n), triggeringEventType: "SessionEndAmended" } as ExactPlannedRevisionQuery,
    ), /INTEGRITY_FAILURE/);
  });

  it("rejects malformed rows instead of reporting absence", () => {
    const fixture = setup();
    fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
    fixture.connection.exec("UPDATE outbox SET payload_json = '{}' ");
    assert.throws(() => fixture.repository.getExactPlannedRevision(fixture.connection, query(7n)), /INTEGRITY_FAILURE/);
  });

  it("rejects persisted kind and cross-bound target-key corruption", () => {
    const kind = setup();
    kind.repository.insertLifecycle(kind.connection, kind.pendingOutbox, kind.storedEvent, NOW);
    kind.connection.exec("UPDATE outbox SET kind = 'notify-observer'");
    assert.throws(() => kind.repository.getExactPlannedRevision(kind.connection, query(7n)), /INTEGRITY_FAILURE/);

    const bound = setup();
    bound.repository.insertLifecycle(bound.connection, bound.pendingOutbox, bound.storedEvent, NOW);
    bound.connection.prepare("UPDATE outbox SET session_id = $foreignSession").run({
      $foreignSession: "99999999-9999-4999-8999-999999999999",
    });
    assert.throws(() => bound.repository.getExactPlannedRevision(bound.connection, query(7n)), /INTEGRITY_FAILURE/);
  });

  it("recomputes and canonicalizes the triggering event payload on reads", () => {
    const noncanonical = setup();
    noncanonical.repository.insertLifecycle(
      noncanonical.connection,
      noncanonical.pendingOutbox,
      noncanonical.storedEvent,
      NOW,
    );
    noncanonical.connection.prepare("UPDATE events SET payload_json = $payload").run({
      $payload: `{"workflowId":"${WORKFLOW_ID}","workflowGeneration":1,"validationResultIds":[],"safeFailureCode":"SESSION_VALIDATION_RESULT_INVALID"}`,
    });
    assert.throws(
      () => noncanonical.repository.getExactPlannedRevision(noncanonical.connection, query(7n)),
      /INTEGRITY_FAILURE/,
    );

    const hash = setup();
    hash.repository.insertLifecycle(hash.connection, hash.pendingOutbox, hash.storedEvent, NOW);
    hash.connection.prepare("UPDATE events SET payload_json = $payload").run({
      $payload: canonicalJson({
        workflowId: WORKFLOW_ID,
        workflowGeneration: 2,
        validationResultIds: [],
        safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
      }),
    });
    assert.throws(() => hash.repository.getExactPlannedRevision(hash.connection, query(7n)), /INTEGRITY_FAILURE/);
  });

  it("rejects malformed trigger envelope fields on reads", () => {
    for (const columnValue of [
      ["parent_session_id", SESSION_ID],
      ["stream_version", 0],
      ["event_id", "not-a-uuid"],
    ] as const) {
      const fixture = setup();
      fixture.repository.insertLifecycle(fixture.connection, fixture.pendingOutbox, fixture.storedEvent, NOW);
      fixture.connection.prepare(`UPDATE events SET ${columnValue[0]} = $value`).run({ $value: columnValue[1] });
      assert.throws(() => fixture.repository.getExactPlannedRevision(fixture.connection, query(7n)), /INTEGRITY_FAILURE/);
    }
  });
});
