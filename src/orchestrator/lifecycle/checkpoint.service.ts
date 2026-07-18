import { createHash } from "node:crypto";

import type {
  JsonValue,
  PendingEvent,
  PersistedLifecycleAuthorizationRecord,
} from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import { resolveContainedProjectPath } from "../identity/canonical-path.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  CheckpointClear,
  CheckpointIndexCompareAndSwap,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import {
  decodeCheckpointDraftV1,
  decodeCheckpointV1,
  type CheckpointDraftV1,
  type CheckpointEvidenceCoverageV1,
  type CheckpointV1,
  type SourceStateFingerprintV1,
} from "./contracts/checkpoint.js";
import {
  decodeLifecycleSemanticCommandDraft,
  type RecordCheckpointCommandV2,
} from "./contracts/commands.js";
import type { CheckpointId, SessionId } from "./contracts/identifiers.js";
import { LifecycleError } from "./errors.js";
import type {
  LifecycleCommandTransaction,
  PreparedLifecycleCommit,
} from "./lifecycle-command.store.js";
import type { SessionAggregateState } from "./session-aggregate.js";
import type {
  SourceStateProvider,
  SourceStateScopeV1,
} from "./source-state.provider.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHECKPOINT_AGE_LIMIT_MILLISECONDS_V1 = 900_000n;

export const RISKY_TRANSITIONS_V1 = Object.freeze([
  "ownership-transfer",
  "ownership-recovery",
  "suspension",
  "carry-forward-claim",
  "end-amendment",
  "end-cancellation",
  "abandonment",
] as const);

export type RiskyTransitionV1 = (typeof RISKY_TRANSITIONS_V1)[number];

export type CheckpointRecordedResultV1 = JsonValue & {
  readonly checkpointVersion: 1;
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly finalStreamVersion: string;
  readonly checkpointRequiredCleared: boolean;
};

export type FreshLifecycleEffect<T extends JsonValue> = PreparedLifecycleCommit<T>;

export interface TrustedCheckpointInvocationV1 {
  readonly context: ProjectContext;
  readonly sourceStateScope: SourceStateScopeV1;
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord;
  readonly freshCapabilityGeneration?: string;
}

export interface CheckpointInvocationScope {
  current(
    transaction: LifecycleCommandTransaction,
    command: RecordCheckpointCommandV2,
  ): TrustedCheckpointInvocationV1;
}

export interface CheckpointIdentitySource { uuid(): string }
export interface CheckpointClock { now(): string }

export interface CheckpointCoverageSnapshotPort {
  capture(
    transaction: LifecycleCommandTransaction,
    authority: SessionAuthorityRecord,
    aggregate: SessionAggregateState,
  ): CheckpointEvidenceCoverageV1;
}

export interface FinalCheckpointPhaseInput {
  readonly command: RecordCheckpointCommandV2;
}

export interface CheckpointServiceOptions {
  readonly invocationScope: CheckpointInvocationScope;
  readonly sourceStateProvider: SourceStateProvider;
  readonly identitySource: CheckpointIdentitySource;
  readonly clock: CheckpointClock;
  readonly coverageSnapshot?: CheckpointCoverageSnapshotPort;
  readonly faultInjector?: (
    point: "before-checkpoint-index-cas" | "after-checkpoint-index-before-marker-clear",
  ) => void;
}

export interface RiskyTransitionRelevantChildV1 {
  readonly authority: SessionAuthorityRecord;
  readonly aggregate: SessionAggregateState;
}

export interface RiskyTransitionCheckpointInputV1 {
  readonly authority: SessionAuthorityRecord;
  readonly aggregate: SessionAggregateState;
  readonly checkpoint: CheckpointV1 | null;
  readonly explicitCheckpointId?: string;
  readonly minimumBaseEventPosition?: bigint;
  readonly relevantChildren: readonly RiskyTransitionRelevantChildV1[];
}

export interface CheckpointAgeDiagnosticInputV1 {
  readonly authority: Pick<
    SessionAuthorityRecord,
    | "sessionId"
    | "createdAt"
    | "latestCheckpointId"
    | "latestCheckpointEventPosition"
    | "latestCheckpointFingerprint"
    | "checkpointRequiredReason"
    | "checkpointRequiredEventPosition"
  >;
  readonly checkpoint: CheckpointV1 | null;
  readonly observedAt: string;
}

export type CheckpointAgeDiagnosticV1 = JsonValue & {
  readonly diagnosticVersion: 1;
  readonly diagnosticKind: "checkpoint-age";
  readonly sessionId: string;
  readonly observedAt: string;
  readonly latestCheckpointId: string | null;
  readonly latestCheckpointCreatedAt: string | null;
  readonly ageMilliseconds: string;
  readonly ageLimitMilliseconds: "900000";
  readonly checkpointRequiredReason: string | null;
  readonly checkpointRequiredEventPosition: string | null;
  readonly checkpointDue: boolean;
};

interface CheckpointAuthorityOperations {
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  requireFoldMatch(authority: SessionAuthorityRecord): SessionAggregateState;
  latestCheckpoint(authority: SessionAuthorityRecord): CheckpointV1 | null;
  listNonterminalChildren(projectId: string, rootSessionId: string): readonly SessionAuthorityRecord[];
  nextGlobalPosition(): bigint;
  updateCheckpointIndex(input: CheckpointIndexCompareAndSwap): boolean;
  clearCheckpointRequired(input: CheckpointClear): boolean;
}

const EMPTY_COVERAGE: CheckpointEvidenceCoverageV1 = Object.freeze({
  captureMode: "coverage-only",
  contentRetained: false,
  highestContiguousOrdinal: null,
  missingIntervals: Object.freeze([]),
});

function invalid(code: "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "LIFECYCLE_INPUT_INVALID"): never {
  throw new LifecycleError(code);
}

function ownMethod<T extends (...arguments_: never[]) => unknown>(value: object, name: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function") invalid("INTEGRITY_FAILURE");
  return descriptor.value as T;
}

function authorityOperations(transaction: LifecycleCommandTransaction): CheckpointAuthorityOperations {
  const value = transaction.authority as object;
  return Object.freeze({
    get: ownMethod<CheckpointAuthorityOperations["get"]>(value, "get"),
    requireFoldMatch: ownMethod<CheckpointAuthorityOperations["requireFoldMatch"]>(value, "requireFoldMatch"),
    latestCheckpoint: ownMethod<CheckpointAuthorityOperations["latestCheckpoint"]>(value, "latestCheckpoint"),
    listNonterminalChildren: ownMethod<CheckpointAuthorityOperations["listNonterminalChildren"]>(value, "listNonterminalChildren"),
    nextGlobalPosition: ownMethod<CheckpointAuthorityOperations["nextGlobalPosition"]>(value, "nextGlobalPosition"),
    updateCheckpointIndex: ownMethod<CheckpointAuthorityOperations["updateCheckpointIndex"]>(value, "updateCheckpointIndex"),
    clearCheckpointRequired: ownMethod<CheckpointAuthorityOperations["clearCheckpointRequired"]>(value, "clearCheckpointRequired"),
  });
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = value;
  if (typeof timestamp !== "string" || !CANONICAL_TIMESTAMP.test(timestamp)) invalid();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) invalid();
  return timestamp;
}

function canonicalNow(clock: CheckpointClock): string {
  return canonicalTimestamp(clock.now());
}

function assertContext(context: ProjectContext, command: RecordCheckpointCommandV2): void {
  const binding = context?.binding;
  if (binding === undefined
    || context.workspace !== binding.workspace
    || binding.projectId !== command.expectedProjectId
    || binding.vaultId !== command.expectedVaultId
    || binding.workspaceId !== command.expectedWorkspaceId
    || context.workspace.workspaceId !== binding.workspaceId
    || (binding.actorRole !== "primary" && binding.actorRole !== "untrusted")) {
    throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  }
  const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (branchRef !== command.expectedBranchRef) throw new LifecycleError("WORKSPACE_AMBIGUOUS");
}

function assertDraftPaths(context: ProjectContext, draft: CheckpointDraftV1): void {
  try {
    for (const file of draft.filesTouched) {
      resolveContainedProjectPath(context.binding.projectRoot, file.path);
    }
    for (const artifact of draft.artifactReferences) {
      resolveContainedProjectPath(context.binding.projectRoot, artifact.path);
    }
    for (const source of draft.sourceReferences) {
      resolveContainedProjectPath(context.binding.projectRoot, source.path);
    }
  } catch {
    invalid();
  }
}

/**
 * Validate checkpoint content against worker-owned project and source-state
 * witnesses. Callers may describe work, but cannot select a different path
 * authority or branch authority for persisted file assertions.
 */
export function requireTrustedCheckpointDraftV1(
  context: ProjectContext,
  draft: CheckpointDraftV1,
  sourceState: SourceStateFingerprintV1,
): void {
  assertDraftPaths(context, draft);
  const expectedBranchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (sourceState.sourceStateScopeVersion !== 1
    || sourceState.workspaceId !== context.workspace.workspaceId
    || sourceState.branchRef !== expectedBranchRef) invalid("INTEGRITY_FAILURE");
  if (draft.filesTouched.some((file) => file.branchRef !== sourceState.branchRef)) invalid();
}

function nonterminal(authority: SessionAuthorityRecord): boolean {
  return authority.terminalEventPosition === null || authority.terminalEventPosition === undefined;
}

function assertAuthorityAndAggregate(
  authority: SessionAuthorityRecord,
  aggregate: SessionAggregateState,
): void {
  if (authority.projectId !== aggregate.projectId
    || authority.sessionId !== aggregate.sessionId
    || authority.streamId !== aggregate.streamId
    || authority.sessionKind !== aggregate.kind
    || authority.parentSessionId !== aggregate.parentSessionId
    || authority.workspaceId !== aggregate.workspaceId
    || !nonterminal(authority)
    || aggregate.terminalEventPosition !== null) invalid("INTEGRITY_FAILURE");
  if (aggregate.kind === "root") {
    if (aggregate.state !== "active" && aggregate.state !== "suspended" && aggregate.state !== "ending") {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
  } else if (aggregate.state !== "active"
    && aggregate.state !== "completion-proposed"
    && aggregate.state !== "suspended") {
    throw new LifecycleError("SESSION_STATE_CONFLICT");
  }
}

function syncValue<T>(value: T): T {
  if (typeof value === "object" && value !== null && "then" in value
    && typeof (value as { readonly then?: unknown }).then === "function") invalid();
  return value;
}

function checkpointFingerprint(checkpoint: CheckpointV1): string {
  return createHash("sha256")
    .update("project-memory/checkpoint/v1\n", "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
}

/**
 * Report a missed fixed time trigger without entering the semantic command
 * store. This function is intentionally pure and cannot fabricate an event.
 */
export function checkpointAgeDiagnosticV1(
  input: CheckpointAgeDiagnosticInputV1,
): CheckpointAgeDiagnosticV1 {
  if (typeof input !== "object" || input === null || typeof input.authority !== "object"
    || input.authority === null) invalid();
  const { authority } = input;
  if ((authority.checkpointRequiredReason === null)
      !== (authority.checkpointRequiredEventPosition === null)) invalid("INTEGRITY_FAILURE");
  const observedAt = canonicalTimestamp(input.observedAt);
  const sessionCreatedAt = canonicalTimestamp(authority.createdAt);
  let baseline = sessionCreatedAt;
  let latestCheckpointCreatedAt: string | null = null;
  if (input.checkpoint === null) {
    if (authority.latestCheckpointId !== null
      || authority.latestCheckpointEventPosition !== null
      || authority.latestCheckpointFingerprint !== null) invalid("INTEGRITY_FAILURE");
  } else {
    const checkpoint = decodeCheckpointV1(input.checkpoint);
    latestCheckpointCreatedAt = checkpoint.createdAt;
    baseline = latestCheckpointCreatedAt;
    if (checkpoint.sessionId !== authority.sessionId
      || checkpoint.checkpointId !== authority.latestCheckpointId
      || authority.latestCheckpointEventPosition === null
      || BigInt(checkpoint.checkpointEventPosition) !== authority.latestCheckpointEventPosition
      || checkpointFingerprint(checkpoint) !== authority.latestCheckpointFingerprint) {
      invalid("INTEGRITY_FAILURE");
    }
  }
  const baselineMilliseconds = Date.parse(baseline);
  const observedMilliseconds = Date.parse(observedAt);
  if (baselineMilliseconds < Date.parse(sessionCreatedAt)
    || observedMilliseconds < baselineMilliseconds) invalid("INTEGRITY_FAILURE");
  const ageMilliseconds = BigInt(observedMilliseconds - baselineMilliseconds);
  return Object.freeze({
    diagnosticVersion: 1,
    diagnosticKind: "checkpoint-age",
    sessionId: authority.sessionId,
    observedAt,
    latestCheckpointId: authority.latestCheckpointId,
    latestCheckpointCreatedAt,
    ageMilliseconds: ageMilliseconds.toString(),
    ageLimitMilliseconds: "900000",
    checkpointRequiredReason: authority.checkpointRequiredReason,
    checkpointRequiredEventPosition: authority.checkpointRequiredEventPosition?.toString() ?? null,
    checkpointDue: authority.checkpointRequiredEventPosition !== null
      || ageMilliseconds >= CHECKPOINT_AGE_LIMIT_MILLISECONDS_V1,
  });
}

/**
 * Require a durable checkpoint at the target stream tip. Global events from
 * unrelated streams may follow it; only the supplied relevant child folds and
 * an optional transition-specific watermark must be covered by its base.
 */
export function requireRiskyTransitionCheckpointV1(
  input: RiskyTransitionCheckpointInputV1,
): CheckpointV1 {
  const { authority, aggregate, checkpoint } = input;
  if ((authority.checkpointRequiredReason === null)
      !== (authority.checkpointRequiredEventPosition === null)) invalid("INTEGRITY_FAILURE");
  if (authority.checkpointRequiredEventPosition !== null) {
    throw new LifecycleError("CHECKPOINT_BASE_INVALID");
  }
  if (checkpoint === null
    || authority.projectId !== aggregate.projectId
    || authority.sessionId !== aggregate.sessionId
    || authority.streamId !== aggregate.streamId
    || authority.sessionKind !== aggregate.kind
    || authority.parentSessionId !== aggregate.parentSessionId
    || authority.workspaceId !== aggregate.workspaceId
    || aggregate.terminalEventPosition !== null
    || checkpoint.sessionId !== authority.sessionId
    || checkpoint.parentSessionId !== authority.parentSessionId
    || checkpoint.sourceState.workspaceId !== authority.workspaceId
    || authority.latestCheckpointId !== checkpoint.checkpointId
    || aggregate.latestCheckpointId !== checkpoint.checkpointId
    || (input.explicitCheckpointId !== undefined
      && input.explicitCheckpointId !== checkpoint.checkpointId)
    || authority.latestCheckpointEventPosition === null
    || aggregate.latestCheckpointEventPosition === null
    || aggregate.latestCheckpointBaseEventPosition === null
    || BigInt(checkpoint.checkpointEventPosition) !== authority.latestCheckpointEventPosition
    || BigInt(checkpoint.checkpointEventPosition) !== aggregate.latestCheckpointEventPosition
    || BigInt(checkpoint.checkpointEventPosition) !== aggregate.eventPosition
    || BigInt(checkpoint.baseEventPosition) !== aggregate.latestCheckpointBaseEventPosition
    || authority.latestCheckpointFingerprint !== checkpointFingerprint(checkpoint)) {
    throw new LifecycleError("CHECKPOINT_BASE_INVALID");
  }
  const base = BigInt(checkpoint.baseEventPosition);
  if (input.minimumBaseEventPosition !== undefined && base < input.minimumBaseEventPosition) {
    throw new LifecycleError("CHECKPOINT_BASE_INVALID");
  }
  if (aggregate.kind !== "root") {
    if (input.relevantChildren.length !== 0 || checkpoint.childSummaries.length !== 0) {
      throw new LifecycleError("CHECKPOINT_BASE_INVALID");
    }
    return checkpoint;
  }
  const summaries = new Map<string, CheckpointV1["childSummaries"][number]>(
    checkpoint.childSummaries.map((summary) => [summary.childSessionId, summary]),
  );
  if (summaries.size !== checkpoint.childSummaries.length
    || summaries.size !== input.relevantChildren.length) {
    throw new LifecycleError("CHECKPOINT_BASE_INVALID");
  }
  for (const relevant of input.relevantChildren) {
    const child = relevant.authority;
    const childAggregate = relevant.aggregate;
    const summary = summaries.get(child.sessionId);
    if (child.sessionKind !== "child"
      || child.parentSessionId !== authority.sessionId
      || child.projectId !== authority.projectId
      || child.workspaceId !== authority.workspaceId
      || child.terminalEventPosition !== null
      || childAggregate.kind !== "child"
      || childAggregate.parentSessionId !== authority.sessionId
      || childAggregate.sessionId !== child.sessionId
      || childAggregate.streamId !== child.streamId
      || childAggregate.terminalEventPosition !== null
      || childAggregate.eventPosition > base
      || summary === undefined
      || summary.state !== childAggregate.state
      || summary.lastEventPosition !== childAggregate.eventPosition.toString()
      || summary.streamVersion !== childAggregate.streamVersion.toString()
      || summary.latestCheckpointId !== childAggregate.latestCheckpointId) {
      throw new LifecycleError("CHECKPOINT_BASE_INVALID");
    }
  }
  return checkpoint;
}

function pendingCheckpointEvent(
  checkpoint: CheckpointV1,
  parentSessionId: string | null,
  occurredAt: string,
): PendingEvent {
  return {
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 1,
    occurredAt,
    visibilityScope: "session",
    sessionId: checkpoint.sessionId,
    ...(parentSessionId === null ? {} : { parentSessionId }),
    confidence: "high",
    verificationStatus: "verified",
    payload: {
      checkpoint: checkpoint as unknown as JsonValue,
      baseEventPosition: checkpoint.baseEventPosition,
      checkpointEventPosition: checkpoint.checkpointEventPosition,
    },
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

export class CheckpointService {
  readonly #invocations: CheckpointInvocationScope;
  readonly #sourceState: SourceStateProvider;
  readonly #ids: CheckpointIdentitySource;
  readonly #clock: CheckpointClock;
  readonly #coverage: CheckpointCoverageSnapshotPort;
  readonly #faultInjector: CheckpointServiceOptions["faultInjector"];

  constructor(options: CheckpointServiceOptions) {
    if (options === undefined || typeof options !== "object"
      || typeof options.invocationScope?.current !== "function"
      || typeof options.sourceStateProvider?.captureForCheckpoint !== "function"
      || typeof options.sourceStateProvider?.captureForFinalization !== "function"
      || typeof options.identitySource?.uuid !== "function"
      || typeof options.clock?.now !== "function"
      || (options.coverageSnapshot !== undefined && typeof options.coverageSnapshot.capture !== "function")
      || (options.faultInjector !== undefined && typeof options.faultInjector !== "function")) invalid();
    this.#invocations = options.invocationScope;
    this.#sourceState = options.sourceStateProvider;
    this.#ids = options.identitySource;
    this.#clock = options.clock;
    this.#coverage = options.coverageSnapshot ?? { capture: () => EMPTY_COVERAGE };
    this.#faultInjector = options.faultInjector;
  }

  record(
    transaction: LifecycleCommandTransaction,
    commandInput: RecordCheckpointCommandV2,
  ): FreshLifecycleEffect<CheckpointRecordedResultV1> {
    return this.#record(transaction, commandInput, false);
  }

  recordFinal(
    transaction: LifecycleCommandTransaction,
    input: FinalCheckpointPhaseInput,
  ): FreshLifecycleEffect<CheckpointRecordedResultV1> {
    if (typeof input !== "object" || input === null || Reflect.ownKeys(input).length !== 1
      || !Object.hasOwn(input, "command")) invalid();
    return this.#record(transaction, input.command, true);
  }

  #record(
    transaction: LifecycleCommandTransaction,
    commandInput: RecordCheckpointCommandV2,
    finalization: boolean,
  ): FreshLifecycleEffect<CheckpointRecordedResultV1> {
    const decoded = decodeLifecycleSemanticCommandDraft(commandInput);
    if (decoded.commandType !== "record-checkpoint") invalid();
    const command = decoded;
    const invocation = this.#invocations.current(transaction, command);
    assertContext(invocation.context, command);
    const draft = decodeCheckpointDraftV1(command.draft);
    assertDraftPaths(invocation.context, draft);

    const authority = authorityOperations(transaction);
    const observed = authority.get(invocation.context.binding.projectId, command.sessionId);
    if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
    const aggregate = authority.requireFoldMatch(current);
    assertAuthorityAndAggregate(current, aggregate);
    authority.latestCheckpoint(current);
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) {
      throw new LifecycleError("EVENT_CONFLICT");
    }

    const checkpointPosition = authority.nextGlobalPosition();
    if (typeof checkpointPosition !== "bigint" || checkpointPosition < 2n
      || checkpointPosition > SQLITE_INT64_MAX) invalid("INTEGRITY_FAILURE");
    const baseEventPosition = checkpointPosition - 1n;
    if (baseEventPosition < aggregate.eventPosition) invalid("INTEGRITY_FAILURE");
    if (command.expectedBaseEventPosition !== null
      && BigInt(command.expectedBaseEventPosition) !== baseEventPosition) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    const markerPosition = current.checkpointRequiredEventPosition;
    const markerReason = current.checkpointRequiredReason;
    if ((markerPosition === null) !== (markerReason === null)) invalid("INTEGRITY_FAILURE");
    if (markerPosition !== null && markerPosition > baseEventPosition) {
      throw new LifecycleError("CHECKPOINT_BASE_INVALID");
    }

    const childSummaries = aggregate.kind === "root"
      ? [...authority.listNonterminalChildren(current.projectId, current.sessionId)]
          .map((childObserved) => {
            const child = Object.freeze({ ...childObserved }) as SessionAuthorityRecord;
            const childAggregate = authority.requireFoldMatch(child);
            assertAuthorityAndAggregate(child, childAggregate);
            if (childAggregate.kind !== "child" || child.parentSessionId !== current.sessionId
              || childAggregate.eventPosition > baseEventPosition) invalid("INTEGRITY_FAILURE");
            return Object.freeze({
              childSessionId: child.sessionId as SessionId,
              state: childAggregate.state,
              lastEventPosition: childAggregate.eventPosition.toString(),
              streamVersion: childAggregate.streamVersion.toString(),
              latestCheckpointId: childAggregate.latestCheckpointId,
            });
          })
          .sort((left, right) => left.childSessionId < right.childSessionId ? -1
            : left.childSessionId > right.childSessionId ? 1 : 0)
      : [];

    const sourceState = syncValue(finalization
      ? this.#sourceState.captureForFinalization(invocation.context, invocation.sourceStateScope)
      : this.#sourceState.captureForCheckpoint(invocation.context, invocation.sourceStateScope));
    requireTrustedCheckpointDraftV1(invocation.context, draft, sourceState);
    const coverage = syncValue(this.#coverage.capture(transaction, current, aggregate));
    const createdAt = canonicalNow(this.#clock);
    const checkpoint = decodeCheckpointV1({
      ...draft,
      checkpointId: this.#ids.uuid(),
      sessionId: current.sessionId,
      parentSessionId: current.parentSessionId,
      baseEventPosition: baseEventPosition.toString(),
      checkpointEventPosition: checkpointPosition.toString(),
      createdAt,
      creatorAgentId: command.agentId,
      creatorClientInstanceId: invocation.context.binding.clientInstanceId,
      sourceState,
      childSummaries,
      evidenceCoverage: coverage,
    });
    const fingerprint = checkpointFingerprint(checkpoint);
    const checkpointRequiredCleared = markerPosition !== null;
    const result: CheckpointRecordedResultV1 = Object.freeze({
      checkpointVersion: 1,
      checkpointId: checkpoint.checkpointId,
      sessionId: checkpoint.sessionId,
      baseEventPosition: checkpoint.baseEventPosition,
      checkpointEventPosition: checkpoint.checkpointEventPosition,
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
      checkpointRequiredCleared,
    });
    const event = pendingCheckpointEvent(checkpoint, current.parentSessionId, createdAt);
    return {
      append: {
        context: invocation.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: current.streamId,
        streamType: "session",
        events: [event],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: invocation.authorizationRecord,
      ...(invocation.freshCapabilityGeneration === undefined
        ? {}
        : { freshCapabilityGeneration: invocation.freshCapabilityGeneration }),
      beforeAppend: (planned) => {
        if (planned.events.length !== 1
          || planned.events[0]?.globalPosition !== checkpointPosition
          || planned.events[0]?.streamVersion !== aggregate.streamVersion + 1n) invalid("INTEGRITY_FAILURE");
      },
      afterAppend: (committed, currentTransaction) => {
        if (committed.events.length !== 1
          || committed.events[0]?.globalPosition !== checkpointPosition
          || committed.events[0]?.streamVersion !== aggregate.streamVersion + 1n) invalid("INTEGRITY_FAILURE");
        this.#faultInjector?.("before-checkpoint-index-cas");
        const currentAuthority = authorityOperations(currentTransaction);
        if (!currentAuthority.updateCheckpointIndex({
          projectId: current.projectId,
          sessionId: current.sessionId,
          expectedLatestCheckpointId: current.latestCheckpointId,
          expectedLatestCheckpointEventPosition: current.latestCheckpointEventPosition,
          expectedLatestCheckpointFingerprint: current.latestCheckpointFingerprint,
          checkpointId: checkpoint.checkpointId,
          checkpointEventPosition: checkpointPosition,
          checkpointFingerprint: fingerprint,
          updatedAt: createdAt,
        })) throw new LifecycleError("EVENT_CONFLICT");
        this.#faultInjector?.("after-checkpoint-index-before-marker-clear");
        if (checkpointRequiredCleared && !currentAuthority.clearCheckpointRequired({
          projectId: current.projectId,
          sessionId: current.sessionId,
          checkpointBaseEventPosition: baseEventPosition,
          updatedAt: createdAt,
        })) invalid("INTEGRITY_FAILURE");
      },
    };
  }

}
