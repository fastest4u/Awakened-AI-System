import type { StoredEvent } from "../contracts/event.js";
import { eventHash, payloadHash } from "../crypto/event-hash.js";
import { decodeLifecycleIntentWitness } from "../lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export interface StoredEventChainCursor {
  readonly expectedPosition: bigint;
  readonly previousEventHash: string;
}

export interface AuthenticatedStoredEvent {
  readonly event: StoredEvent;
  readonly canonicalPayloadJson: string;
  readonly byteLength: number;
  readonly nextCursor: StoredEventChainCursor;
}

export interface StoredEventAuthenticationFailures {
  readonly payload: boolean;
  readonly position: boolean;
  readonly predecessor: boolean;
  readonly eventHash: boolean;
}

export class StoredEventAuthenticationError extends Error {
  constructor(readonly failures: StoredEventAuthenticationFailures) {
    super("INTEGRITY_FAILURE");
    this.name = "StoredEventAuthenticationError";
  }
}

function eventHashInput(event: StoredEvent): Record<string, unknown> {
  const lifecycleIntent = event.lifecycleIntentJson === undefined
    || event.lifecycleIntentJson === null
    ? undefined
    : decodeLifecycleIntentWitness(event.lifecycleIntentJson);
  return {
    globalPosition: event.globalPosition.toString(),
    eventId: event.eventId,
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    branchScopeId: event.branchScopeId,
    branchRef: event.branchRef,
    streamId: event.streamId,
    streamType: event.streamType,
    streamVersion: event.streamVersion.toString(),
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    actorRole: event.actorRole,
    agentId: event.agentId,
    clientInstanceId: event.clientInstanceId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    commandEventIndex: event.commandEventIndex,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    visibilityScope: event.visibilityScope,
    confidence: event.confidence,
    verificationStatus: event.verificationStatus,
    sourceRefs: event.sourceRefs,
    evidenceRefs: event.evidenceRefs,
    evidenceDigests: event.evidenceDigests,
    payloadHash: event.payloadHash,
    previousGlobalHash: event.previousGlobalHash,
    ...(lifecycleIntent === undefined ? {} : { lifecycleIntent }),
  };
}

export function authenticateStoredEvent(
  event: StoredEvent,
  cursor: StoredEventChainCursor,
): AuthenticatedStoredEvent {
  let canonicalPayloadJson: string | undefined;
  let computedPayloadHash: string | undefined;
  try {
    const payload = JSON.parse(event.payloadJson) as unknown;
    canonicalPayloadJson = canonicalJson(payload);
    computedPayloadHash = payloadHash(payload);
  } catch {
    // Report all authentication dimensions below with one fail-closed error.
  }

  let computedEventHash: string | undefined;
  try {
    computedEventHash = eventHash(eventHashInput(event));
  } catch {
    // A malformed hash-domain field is an event-hash authentication failure.
  }

  const failures = Object.freeze({
    payload: canonicalPayloadJson !== event.payloadJson
      || computedPayloadHash !== event.payloadHash,
    position: event.globalPosition !== cursor.expectedPosition,
    predecessor: event.previousGlobalHash !== cursor.previousEventHash,
    eventHash: computedEventHash !== event.eventHash,
  });
  if (Object.values(failures).some(Boolean)) {
    throw new StoredEventAuthenticationError(failures);
  }

  return Object.freeze({
    event,
    canonicalPayloadJson: canonicalPayloadJson!,
    byteLength: Buffer.byteLength(canonicalPayloadJson!, "utf8"),
    nextCursor: Object.freeze({
      expectedPosition: event.globalPosition + 1n,
      previousEventHash: event.eventHash,
    }),
  });
}
