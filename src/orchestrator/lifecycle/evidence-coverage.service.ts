import type {
  JsonValue,
  PendingEvent,
  PersistedLifecycleAuthorizationRecord,
  StoredEvent,
} from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
  CurrentChildEndingScopeProjectionRecord,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import {
  decodeLifecycleSemanticCommandDraft,
  type RecordEvidenceBatchCommandV2,
} from "./contracts/commands.js";
import type { MissingOrdinalIntervalV1 } from "./contracts/checkpoint.js";
import { decodeEvidenceCoverageRecordedV2 } from "./contracts/events.js";
import {
  exactRecord,
  parseCanonicalTimestamp,
  parseDecimalString,
  parseLifecycleId,
  strictArray,
} from "./contracts/identifiers.js";
import type {
  AdapterSessionId,
  EvidenceBatchId,
  SessionId,
} from "./contracts/identifiers.js";
import {
  decodeFinalEndingScopeBindingsV1,
  type FinalEndingScopeBindingV1,
} from "./contracts/session-end.js";
import { LifecycleError } from "./errors.js";
import type { FreshLifecycleEffect } from "./checkpoint.service.js";
import type { LifecycleCommandTransaction } from "./lifecycle-command.store.js";
import type { SessionAggregateState } from "./session-aggregate.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { LifecycleFaultInjector } from "./lifecycle-faults.js";

const LOWER_HASH = /^[0-9a-f]{64}$/u;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_ENDING_SCOPE_BINDINGS = 605;
const ENDING_SCOPE_LIMIT_PLUS_ONE = MAX_ENDING_SCOPE_BINDINGS + 1;

export type EvidenceCoverageRecordedResultV2 = JsonValue & {
  readonly resultVersion: 2;
  readonly operation: "record-evidence-batch";
  readonly sessionId: SessionId;
  readonly adapterSessionId: AdapterSessionId;
  readonly batchId: EvidenceBatchId;
  readonly batchFirstOrdinal: string;
  readonly batchLastOrdinal: string;
  readonly coverageFirstOrdinal: "0";
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly eventPosition: string;
  readonly finalStreamVersion: string;
};

export interface TrustedEvidenceCoverageInvocationV2 {
  readonly context: ProjectContext;
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord;
  readonly freshCapabilityGeneration: string;
  readonly authorizationAuthority: SessionAuthorityRecord;
  readonly targetAuthority: SessionAuthorityRecord;
  readonly targetAggregate: SessionAggregateState;
  readonly occurredAt: string;
}

export interface EvidenceCoverageInvocationScope {
  current(
    transaction: LifecycleCommandTransaction,
    command: RecordEvidenceBatchCommandV2,
  ): TrustedEvidenceCoverageInvocationV2;
}

export interface EvidenceCoverageServiceOptions {
  readonly invocationScope: EvidenceCoverageInvocationScope;
  readonly faultInjector?: LifecycleFaultInjector;
}

interface EvidenceAuthorityOperations {
  nextGlobalPosition(): bigint;
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  listNonterminalChildEndingScopeProjectionsBounded(
    projectId: string,
    rootSessionId: string,
    limit: number,
  ): readonly CurrentChildEndingScopeProjectionRecord[];
}

interface EvidenceTransferOperations {
  listUnclaimedEndingScopeProjectionsBySourceRoot(
    projectId: string,
    sourceParentSessionId: string,
    limit: number,
  ): readonly CarryForwardEndingScopeProjectionRecord[];
}

function invalid(
  code: "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "LIFECYCLE_INPUT_INVALID",
): never {
  throw new LifecycleError(code);
}

function requiredMethod<T extends (...arguments_: never[]) => unknown>(
  value: object,
  name: string,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
  ) invalid("INTEGRITY_FAILURE");
  return descriptor.value as T;
}

function authorityOperations(
  transaction: LifecycleCommandTransaction,
): EvidenceAuthorityOperations {
  return Object.freeze({
    nextGlobalPosition: requiredMethod<EvidenceAuthorityOperations["nextGlobalPosition"]>(
      transaction.authority as object,
      "nextGlobalPosition",
    ),
    get: requiredMethod<EvidenceAuthorityOperations["get"]>(
      transaction.authority as object,
      "get",
    ),
    listNonterminalChildEndingScopeProjectionsBounded: requiredMethod<
      EvidenceAuthorityOperations["listNonterminalChildEndingScopeProjectionsBounded"]
    >(
      transaction.authority as object,
      "listNonterminalChildEndingScopeProjectionsBounded",
    ),
  });
}

function transferOperations(
  transaction: LifecycleCommandTransaction,
): EvidenceTransferOperations {
  return Object.freeze({
    listUnclaimedEndingScopeProjectionsBySourceRoot: requiredMethod<
      EvidenceTransferOperations["listUnclaimedEndingScopeProjectionsBySourceRoot"]
    >(
      transaction.transfers as object,
      "listUnclaimedEndingScopeProjectionsBySourceRoot",
    ),
  });
}

function coverageOperations(transaction: LifecycleCommandTransaction) {
  const value = transaction.coverage as object;
  return Object.freeze({
    prepareBatch: requiredMethod<NonNullable<
      LifecycleCommandTransaction["coverage"]["prepareBatch"]
    >>(value, "prepareBatch"),
    persistPrepared: requiredMethod<NonNullable<
      LifecycleCommandTransaction["coverage"]["persistPrepared"]
    >>(value, "persistPrepared"),
  });
}

function interval(value: unknown, index: number): MissingOrdinalIntervalV1 {
  const record = exactRecord(
    value,
    ["firstOrdinal", "lastOrdinal"],
    `result.missingIntervals[${index}]`,
  );
  const firstOrdinal = parseDecimalString(
    record.firstOrdinal,
    `result.missingIntervals[${index}].firstOrdinal`,
  );
  const lastOrdinal = parseDecimalString(
    record.lastOrdinal,
    `result.missingIntervals[${index}].lastOrdinal`,
  );
  if (BigInt(firstOrdinal) > BigInt(lastOrdinal)) invalid();
  return Object.freeze({ firstOrdinal, lastOrdinal });
}

export function decodeEvidenceCoverageRecordedResultV2(
  value: unknown,
): EvidenceCoverageRecordedResultV2 {
  const result = exactRecord(value, [
    "resultVersion",
    "operation",
    "sessionId",
    "adapterSessionId",
    "batchId",
    "batchFirstOrdinal",
    "batchLastOrdinal",
    "coverageFirstOrdinal",
    "coverageLastOrdinal",
    "highestContiguousOrdinal",
    "missingIntervals",
    "captureMode",
    "contentRetained",
    "eventPosition",
    "finalStreamVersion",
  ], "evidenceCoverageRecordedResult");
  if (
    result.resultVersion !== 2
    || result.operation !== "record-evidence-batch"
    || result.coverageFirstOrdinal !== "0"
    || result.captureMode !== "coverage-only"
    || result.contentRetained !== false
  ) invalid();
  const batchFirstOrdinal = parseDecimalString(result.batchFirstOrdinal, "result.batchFirstOrdinal");
  const batchLastOrdinal = parseDecimalString(result.batchLastOrdinal, "result.batchLastOrdinal");
  const coverageLastOrdinal = parseDecimalString(result.coverageLastOrdinal, "result.coverageLastOrdinal");
  if (
    BigInt(batchFirstOrdinal) > BigInt(batchLastOrdinal)
    || BigInt(batchLastOrdinal) > BigInt(coverageLastOrdinal)
  ) invalid();
  const highestContiguousOrdinal = result.highestContiguousOrdinal === null
    ? null
    : parseDecimalString(result.highestContiguousOrdinal, "result.highestContiguousOrdinal");
  if (
    highestContiguousOrdinal !== null
    && BigInt(highestContiguousOrdinal) > BigInt(coverageLastOrdinal)
  ) invalid();
  const source = strictArray(result.missingIntervals, "result.missingIntervals");
  if (source.length > 200) invalid();
  const missingIntervals = Object.freeze(source.map(interval));
  let previousLast = -2n;
  for (const missing of missingIntervals) {
    const first = BigInt(missing.firstOrdinal);
    const last = BigInt(missing.lastOrdinal);
    if (
      first <= previousLast + 1n
      || last > BigInt(coverageLastOrdinal)
      || (
        first <= BigInt(batchLastOrdinal)
        && last >= BigInt(batchFirstOrdinal)
      )
    ) invalid();
    previousLast = last;
  }
  const firstMissing = missingIntervals[0];
  const expectedHighest = firstMissing === undefined
    ? coverageLastOrdinal
    : BigInt(firstMissing.firstOrdinal) === 0n
      ? null
      : (BigInt(firstMissing.firstOrdinal) - 1n).toString();
  if (highestContiguousOrdinal !== expectedHighest) invalid();
  const eventPosition = parseDecimalString(result.eventPosition, "result.eventPosition");
  const finalStreamVersion = parseDecimalString(result.finalStreamVersion, "result.finalStreamVersion");
  if (eventPosition === "0" || finalStreamVersion === "0") invalid();
  return Object.freeze({
    resultVersion: 2,
    operation: "record-evidence-batch",
    sessionId: parseLifecycleId<SessionId>(result.sessionId, "result.sessionId"),
    adapterSessionId: parseLifecycleId<AdapterSessionId>(
      result.adapterSessionId,
      "result.adapterSessionId",
    ),
    batchId: parseLifecycleId<EvidenceBatchId>(result.batchId, "result.batchId"),
    batchFirstOrdinal,
    batchLastOrdinal,
    coverageFirstOrdinal: "0",
    coverageLastOrdinal,
    highestContiguousOrdinal,
    missingIntervals,
    captureMode: "coverage-only",
    contentRetained: false,
    eventPosition,
    finalStreamVersion,
  }) as unknown as EvidenceCoverageRecordedResultV2;
}

function assertInvocation(
  command: RecordEvidenceBatchCommandV2,
  invocation: TrustedEvidenceCoverageInvocationV2,
): void {
  const context = invocation.context.binding;
  const authorization = invocation.authorizationRecord;
  const authority = invocation.authorizationAuthority;
  const target = invocation.targetAuthority;
  const aggregate = invocation.targetAggregate;
  if (
    command.expectedProjectId !== context.projectId
    || command.expectedVaultId !== context.vaultId
    || command.expectedWorkspaceId !== context.workspaceId
    || authorization.kind !== "protected"
    || authorization.proof === null
    || authorization.proof.version !== 1
    || !LOWER_HASH.test(authorization.proof.digest)
    || authorization.approval !== null
    || authorization.targetSessionId !== command.sessionId
    || target.projectId !== context.projectId
    || target.sessionId !== command.sessionId
    || target.workspaceId !== context.workspaceId
    || target.clientNamespace !== context.clientNamespace
    || target.terminalEventPosition !== null
    || target.terminalEventType !== null
    || target.terminalAt !== null
    || target.revocationEventPosition !== null
    || target.revokedAt !== null
    || aggregate.projectId !== context.projectId
    || aggregate.vaultId !== context.vaultId
    || aggregate.storeId !== context.storeId
    || aggregate.workspaceId !== context.workspaceId
    || aggregate.sessionId !== target.sessionId
    || aggregate.streamId !== target.streamId
    || aggregate.parentSessionId !== target.parentSessionId
    || aggregate.streamVersion < 1n
    || aggregate.eventPosition < 1n
    || aggregate.terminalEventPosition !== null
  ) invalid("INTEGRITY_FAILURE");
  const self = authorization.authorizationSessionId === target.sessionId;
  if (
    authority.projectId !== context.projectId
    || authority.sessionId !== authorization.authorizationSessionId
    || authority.workspaceId !== context.workspaceId
    || authority.clientNamespace !== context.clientNamespace
    || authority.terminalEventPosition !== null
    || authority.revocationEventPosition !== null
    || authority.revokedAt !== null
    || (
      self
        ? authority.sessionId !== target.sessionId
          || authority.sessionKind !== target.sessionKind
          || authority.authorityCommitment !== target.authorityCommitment
        : target.sessionKind !== "child"
          || target.parentSessionId !== authority.sessionId
          || authority.sessionKind !== "root"
          || authority.parentSessionId !== null
    )
  ) invalid("INTEGRITY_FAILURE");
  const generation = authority.sessionKind === "root"
    ? authority.ownerGeneration
    : authority.childCapabilityGeneration;
  if (
    generation === null
    || generation.toString() !== invocation.freshCapabilityGeneration
    || (
      authority.sessionKind === "root"
        ? authorization.presenting.actorRole !== "primary"
        : authorization.presenting.actorRole !== "untrusted"
    )
    || authorization.target.actorRole !== authorization.presenting.actorRole
    || authorization.target.clientInstanceId !== authorization.presenting.clientInstanceId
  ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
  if (
    aggregate.kind !== target.sessionKind
    || (
      aggregate.kind === "root"
        ? target.ownerGeneration !== BigInt(aggregate.ownerGeneration)
        : target.childCapabilityGeneration !== (
            aggregate.childCapabilityGeneration === null
              ? null
              : BigInt(aggregate.childCapabilityGeneration)
          )
    )
  ) invalid("INTEGRITY_FAILURE");
  try {
    parseCanonicalTimestamp(invocation.occurredAt, "occurredAt");
  } catch {
    invalid("INTEGRITY_FAILURE");
  }
}

function assertConnectionAuthorityMatches(
  expected: SessionAuthorityRecord,
  actual: SessionAuthorityRecord,
): void {
  if (
    actual.projectId !== expected.projectId
    || actual.sessionId !== expected.sessionId
    || actual.streamId !== expected.streamId
    || actual.sessionKind !== expected.sessionKind
    || actual.parentSessionId !== expected.parentSessionId
    || actual.workspaceId !== expected.workspaceId
    || actual.clientNamespace !== expected.clientNamespace
    || actual.ownerGeneration !== expected.ownerGeneration
    || actual.childCapabilityGeneration !== expected.childCapabilityGeneration
    || actual.authorityCommitment !== expected.authorityCommitment
    || actual.revocationEventPosition !== expected.revocationEventPosition
    || actual.terminalEventPosition !== expected.terminalEventPosition
  ) invalid("INTEGRITY_FAILURE");
}

function requirePositiveInt64(value: bigint): void {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) {
    invalid("INTEGRITY_FAILURE");
  }
}

function currentChildBinding(
  root: SessionAuthorityRecord,
  projection: CurrentChildEndingScopeProjectionRecord,
): FinalEndingScopeBindingV1 {
  if (
    projection.projectId !== root.projectId
    || projection.rootSessionId !== root.sessionId
    || !LOWER_UUID.test(projection.childSessionId)
    || (
      projection.childState !== "active"
      && projection.childState !== "completion-proposed"
      && projection.childState !== "suspended"
    )
    || (projection.checkpointId === null)
      !== (projection.checkpointEventPosition === null)
  ) invalid("INTEGRITY_FAILURE");
  requirePositiveInt64(projection.lastEventPosition);
  requirePositiveInt64(projection.streamVersion);
  if (projection.checkpointEventPosition !== null) {
    requirePositiveInt64(projection.checkpointEventPosition);
    if (projection.checkpointEventPosition > projection.lastEventPosition) {
      invalid("INTEGRITY_FAILURE");
    }
  }
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: projection.childSessionId as SessionId,
    childState: projection.childState,
    lastEventPosition: projection.lastEventPosition.toString(),
    streamVersion: projection.streamVersion.toString(),
    checkpointId: projection.checkpointId as FinalEndingScopeBindingV1["checkpointId"],
    checkpointEventPosition: projection.checkpointEventPosition?.toString() ?? null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  });
}

function carryForwardBinding(
  root: SessionAuthorityRecord,
  projection: CarryForwardEndingScopeProjectionRecord,
): FinalEndingScopeBindingV1 {
  if (
    projection.projectId !== root.projectId
    || projection.rootSessionId !== root.sessionId
    || !LOWER_UUID.test(projection.childSessionId)
    || !LOWER_UUID.test(projection.checkpointId)
    || !LOWER_UUID.test(projection.transferTicketId)
    || projection.childState !== "transferred"
    || projection.lastEventPosition !== projection.transferTicketEventPosition
  ) invalid("INTEGRITY_FAILURE");
  requirePositiveInt64(projection.lastEventPosition);
  requirePositiveInt64(projection.streamVersion);
  requirePositiveInt64(projection.checkpointEventPosition);
  requirePositiveInt64(projection.transferTicketEventPosition);
  if (projection.checkpointEventPosition > projection.lastEventPosition) {
    invalid("INTEGRITY_FAILURE");
  }
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: projection.childSessionId as SessionId,
    childState: "transferred",
    lastEventPosition: projection.lastEventPosition.toString(),
    streamVersion: projection.streamVersion.toString(),
    checkpointId: projection.checkpointId as FinalEndingScopeBindingV1["checkpointId"],
    checkpointEventPosition: projection.checkpointEventPosition.toString(),
    transferTicketId:
      projection.transferTicketId as FinalEndingScopeBindingV1["transferTicketId"],
    transferTicketEventPosition:
      projection.transferTicketEventPosition.toString(),
  });
}

function deriveProspectiveEndingScopeBindings(
  invocation: TrustedEvidenceCoverageInvocationV2,
  authority: EvidenceAuthorityOperations,
  transfers: EvidenceTransferOperations,
): readonly FinalEndingScopeBindingV1[] {
  const target = invocation.targetAuthority;
  const rootSessionId = target.sessionKind === "root"
    ? target.sessionId
    : target.parentSessionId;
  if (rootSessionId === null || !LOWER_UUID.test(rootSessionId)) {
    invalid("INTEGRITY_FAILURE");
  }
  const root = authority.get(invocation.context.binding.projectId, rootSessionId);
  if (
    root === null
    || root.sessionKind !== "root"
    || root.parentSessionId !== null
    || root.streamId !== `session/${root.sessionId}`
    || root.workspaceId !== invocation.context.binding.workspaceId
    || root.clientNamespace !== invocation.context.binding.clientNamespace
    || root.ownerGeneration === null
    || root.childCapabilityGeneration !== null
  ) invalid("INTEGRITY_FAILURE");
  requirePositiveInt64(root.ownerGeneration);
  if (target.sessionKind === "root") {
    assertConnectionAuthorityMatches(target, root);
  }
  if (invocation.authorizationAuthority.sessionKind === "root") {
    assertConnectionAuthorityMatches(invocation.authorizationAuthority, root);
  }
  const children = authority.listNonterminalChildEndingScopeProjectionsBounded(
    root.projectId,
    root.sessionId,
    ENDING_SCOPE_LIMIT_PLUS_ONE,
  );
  const tickets = transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
    root.projectId,
    root.sessionId,
    ENDING_SCOPE_LIMIT_PLUS_ONE,
  );
  if (
    !Array.isArray(children)
    || !Array.isArray(tickets)
    || children.length >= ENDING_SCOPE_LIMIT_PLUS_ONE
    || tickets.length >= ENDING_SCOPE_LIMIT_PLUS_ONE
  ) throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  let targetChild: SessionAuthorityRecord | null = null;
  if (target.sessionKind === "child") {
    targetChild = authority.get(root.projectId, target.sessionId);
    if (targetChild === null || targetChild.parentSessionId !== root.sessionId) {
      invalid("INTEGRITY_FAILURE");
    }
    assertConnectionAuthorityMatches(target, targetChild);
  }
  if (invocation.authorizationAuthority.sessionKind === "child") {
    const authorizationFacts = targetChild?.sessionId
      === invocation.authorizationAuthority.sessionId
      ? targetChild
      : authority.get(
          root.projectId,
          invocation.authorizationAuthority.sessionId,
        );
    if (
      authorizationFacts === null
      || authorizationFacts.parentSessionId !== root.sessionId
    ) invalid("INTEGRITY_FAILURE");
    assertConnectionAuthorityMatches(
      invocation.authorizationAuthority,
      authorizationFacts,
    );
  }
  const bindings = children.map((projection) =>
    currentChildBinding(root, projection));
  if (
    target.sessionKind === "child"
    && !children.some((projection) => projection.childSessionId === target.sessionId)
  ) invalid("INTEGRITY_FAILURE");
  bindings.push(...tickets.map((projection) =>
    carryForwardBinding(root, projection)));
  if (bindings.length > MAX_ENDING_SCOPE_BINDINGS) {
    throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  }
  bindings.sort((left, right) => Buffer.compare(
    Buffer.from(left.childSessionId, "utf8"),
    Buffer.from(right.childSessionId, "utf8"),
  ));
  try {
    return decodeFinalEndingScopeBindingsV1(bindings);
  } catch {
    return invalid("INTEGRITY_FAILURE");
  }
}

function evidenceEvent(
  command: RecordEvidenceBatchCommandV2,
  invocation: TrustedEvidenceCoverageInvocationV2,
  payload: JsonValue,
): PendingEvent {
  return {
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    occurredAt: invocation.occurredAt,
    visibilityScope: "session",
    sessionId: command.sessionId,
    ...(invocation.targetAuthority.parentSessionId === null
      ? {}
      : { parentSessionId: invocation.targetAuthority.parentSessionId }),
    confidence: "high",
    verificationStatus: "verified",
    payload,
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function assertPreparedPayloadMatchesCommand(
  command: RecordEvidenceBatchCommandV2,
  payload: ReturnType<typeof decodeEvidenceCoverageRecordedV2>,
): void {
  let framesMatch = false;
  try {
    framesMatch = canonicalJson(payload.frames) === canonicalJson(command.frames);
  } catch {
    invalid("INTEGRITY_FAILURE");
  }
  if (
    payload.adapterSessionId !== command.adapterSessionId
    || payload.batchId !== command.batchId
    || payload.batchFirstOrdinal !== command.firstOrdinal
    || payload.batchLastOrdinal !== command.lastOrdinal
    || payload.frameFingerprintSchemaVersion !== command.fingerprintSchemaVersion
    || payload.frameFingerprintKeyId !== command.fingerprintKeyId
    || payload.frameFingerprintDomain !== command.fingerprintDomain
    || payload.coverageFingerprintKeyId !== command.fingerprintKeyId
    || command.redactionStatus !== "content-not-retained"
    || !framesMatch
  ) invalid("INTEGRITY_FAILURE");
}

export class EvidenceCoverageService {
  readonly #invocations: EvidenceCoverageInvocationScope;

  constructor(options: EvidenceCoverageServiceOptions) {
    if (
      options === undefined
      || typeof options !== "object"
      || typeof options.invocationScope?.current !== "function"
    ) invalid();
    this.#invocations = options.invocationScope;
  }

  record(
    transaction: LifecycleCommandTransaction,
    commandInput: RecordEvidenceBatchCommandV2,
  ): FreshLifecycleEffect<EvidenceCoverageRecordedResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(commandInput);
    if (decoded.commandType !== "record-evidence-batch") invalid();
    const command = decoded;
    const invocation = this.#invocations.current(transaction, command);
    assertInvocation(command, invocation);
    const authority = authorityOperations(transaction);
    const transfers = transferOperations(transaction);
    const coverage = coverageOperations(transaction);
    const eventPosition = authority.nextGlobalPosition();
    if (typeof eventPosition !== "bigint" || eventPosition < 1n) invalid("INTEGRITY_FAILURE");
    const prospectiveEndingScopeBindings = deriveProspectiveEndingScopeBindings(
      invocation,
      authority,
      transfers,
    );
    const prepared = coverage.prepareBatch({
      context: invocation.context,
      command,
      prospectiveEndingScopeBindings,
      plannedEventPosition: eventPosition,
    });
    const preparedHandle = prepared.handle;
    let eventPayload;
    try {
      eventPayload = decodeEvidenceCoverageRecordedV2(prepared.eventPayload);
    } catch {
      return invalid("INTEGRITY_FAILURE");
    }
    assertPreparedPayloadMatchesCommand(command, eventPayload);
    if (
      prepared.sessionId !== command.sessionId
      || prepared.adapterSessionId !== command.adapterSessionId
      || eventPayload.batchId !== command.batchId
      || !LOWER_HASH.test(eventPayload.coverageFingerprint)
    ) invalid("INTEGRITY_FAILURE");
    const aggregate = invocation.targetAggregate;
    const result = decodeEvidenceCoverageRecordedResultV2({
      resultVersion: 2,
      operation: "record-evidence-batch",
      sessionId: command.sessionId,
      adapterSessionId: command.adapterSessionId,
      batchId: command.batchId,
      batchFirstOrdinal: eventPayload.batchFirstOrdinal,
      batchLastOrdinal: eventPayload.batchLastOrdinal,
      coverageFirstOrdinal: eventPayload.coverageFirstOrdinal,
      coverageLastOrdinal: eventPayload.coverageLastOrdinal,
      highestContiguousOrdinal: eventPayload.highestContiguousOrdinal,
      missingIntervals: eventPayload.missingIntervals,
      captureMode: "coverage-only",
      contentRetained: false,
      eventPosition: eventPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
    });
    return {
      append: {
        context: invocation.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: aggregate.streamId,
        streamType: "session",
        events: [
          evidenceEvent(
            command,
            invocation,
            eventPayload as unknown as JsonValue,
          ),
        ],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: invocation.authorizationRecord,
      freshCapabilityGeneration: invocation.freshCapabilityGeneration,
      beforeAppend: (planned) => {
        if (
          planned.events.length !== 1
          || planned.events[0]?.globalPosition !== eventPosition
          || planned.events[0]?.streamVersion !== aggregate.streamVersion + 1n
        ) invalid("INTEGRITY_FAILURE");
      },
      afterAppend: (committed, currentTransaction) => {
        const event = committed.events[0];
        if (
          committed.events.length !== 1
          || event === undefined
          || event.globalPosition !== eventPosition
          || event.streamVersion !== aggregate.streamVersion + 1n
          || event.eventType !== "EvidenceCoverageRecorded"
          || event.eventSchemaVersion !== 2
        ) invalid("INTEGRITY_FAILURE");
        coverageOperations(currentTransaction).persistPrepared(
          preparedHandle,
          event as StoredEvent,
        );
      },
    };
  }
}
