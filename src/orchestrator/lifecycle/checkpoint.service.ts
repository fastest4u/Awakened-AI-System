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
  decodeCheckpointDraftV2,
  decodeCheckpointDraftV1,
  decodeCheckpointV2,
  decodeCheckpointV1,
  type Checkpoint,
  type CheckpointDraft,
  type CheckpointEvidenceCoverageV1,
  type CheckpointEvidenceCoverageV2,
  type CheckpointV1,
  type SourceStateFingerprintV1,
} from "./contracts/checkpoint.js";
import {
  decodeLifecycleSemanticCommandDraft,
  type RecordFinalCheckpointAndQueueEndingActionV1,
  type RecordFinalCheckpointAndQueueEndingActionV2,
  type RecordCheckpointCommandV2,
  type RecordCheckpointCommandV3,
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

export type CheckpointRecordedResultV2 = JsonValue & {
  readonly checkpointVersion: 2;
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly finalStreamVersion: string;
  readonly checkpointRequiredCleared: boolean;
};

export type CheckpointRecordedResult =
  | CheckpointRecordedResultV1
  | CheckpointRecordedResultV2;

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
    command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3,
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

export interface FinalCheckpointPhasePreparationInput {
  readonly command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3;
  readonly materializationTarget: string;
}

const PREPARED_FINAL_CHECKPOINT_PHASE = Symbol("prepared-final-checkpoint-phase");

export interface PreparedFinalCheckpointPhase {
  readonly [PREPARED_FINAL_CHECKPOINT_PHASE]: true;
  readonly action:
    | RecordFinalCheckpointAndQueueEndingActionV1
    | RecordFinalCheckpointAndQueueEndingActionV2;
  readonly effect: FreshLifecycleEffect<CheckpointRecordedResult>;
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
  readonly checkpoint: Checkpoint | null;
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
  readonly checkpoint: Checkpoint | null;
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
  latestCheckpoint(authority: SessionAuthorityRecord): Checkpoint | null;
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

function assertContext(
  context: ProjectContext,
  command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3,
): void {
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

function assertDraftPaths(context: ProjectContext, draft: CheckpointDraft): void {
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
  draft: CheckpointDraft,
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

function finalCheckpointPreparationInput(
  value: unknown,
): FinalCheckpointPhasePreparationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("command") || !keys.includes("materializationTarget")) {
    invalid();
  }
  const command = Object.getOwnPropertyDescriptor(value, "command");
  const target = Object.getOwnPropertyDescriptor(value, "materializationTarget");
  if (command === undefined || !command.enumerable || !("value" in command)
    || target === undefined || !target.enumerable || !("value" in target)
    || typeof target.value !== "string" || target.value.length === 0
    || Array.from(target.value).length > 1_024) invalid();
  return Object.freeze({
    command: command.value as RecordCheckpointCommandV2 | RecordCheckpointCommandV3,
    materializationTarget: target.value,
  });
}

function immutablePreparedEffect<T extends JsonValue>(
  effect: FreshLifecycleEffect<T>,
): FreshLifecycleEffect<T> {
  const snapshots = new WeakMap<object, object>();
  const snapshot = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const prior = snapshots.get(value);
      if (prior !== undefined) return prior;
      const next: unknown[] = [];
      snapshots.set(value, next);
      for (const item of value) next.push(snapshot(item));
      return Object.freeze(next);
    }
    if (typeof value !== "object" || value === null || typeof value === "function") return value;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalid("INTEGRITY_FAILURE");
    const prior = snapshots.get(value);
    if (prior !== undefined) return prior;
    const next: Record<string, unknown> = {};
    snapshots.set(value, next);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalid("INTEGRITY_FAILURE");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        invalid("INTEGRITY_FAILURE");
      }
      next[key] = snapshot(descriptor.value);
    }
    return Object.freeze(next);
  };
  return snapshot(effect) as FreshLifecycleEffect<T>;
}

const CHECKPOINT_RESULT_KEYS = [
  "checkpointVersion",
  "checkpointId",
  "sessionId",
  "baseEventPosition",
  "checkpointEventPosition",
  "finalStreamVersion",
  "checkpointRequiredCleared",
] as const;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

export function decodeCheckpointRecordedResult(
  value: unknown,
): CheckpointRecordedResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid();
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== CHECKPOINT_RESULT_KEYS.length
    || keys.some((key) => typeof key !== "string" || !CHECKPOINT_RESULT_KEYS.includes(
      key as (typeof CHECKPOINT_RESULT_KEYS)[number],
    ))) invalid();
  for (const key of CHECKPOINT_RESULT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
  if (record.checkpointVersion !== 1 && record.checkpointVersion !== 2) invalid();
  if (typeof record.checkpointId !== "string" || !LOWER_UUID.test(record.checkpointId)
    || typeof record.sessionId !== "string" || !LOWER_UUID.test(record.sessionId)
    || typeof record.baseEventPosition !== "string" || !UNSIGNED_DECIMAL.test(record.baseEventPosition)
    || typeof record.checkpointEventPosition !== "string"
    || !UNSIGNED_DECIMAL.test(record.checkpointEventPosition)
    || typeof record.finalStreamVersion !== "string" || !UNSIGNED_DECIMAL.test(record.finalStreamVersion)
    || record.baseEventPosition.length > 19
    || record.checkpointEventPosition.length > 19
    || record.finalStreamVersion.length > 19
    || record.checkpointRequiredCleared !== true && record.checkpointRequiredCleared !== false) invalid();
  const baseEventPosition = BigInt(record.baseEventPosition);
  const checkpointEventPosition = BigInt(record.checkpointEventPosition);
  const finalStreamVersion = BigInt(record.finalStreamVersion);
  if (baseEventPosition < 1n
    || checkpointEventPosition !== baseEventPosition + 1n
    || checkpointEventPosition > SQLITE_INT64_MAX
    || finalStreamVersion < 1n
    || finalStreamVersion > SQLITE_INT64_MAX) invalid();
  return Object.freeze({
    checkpointVersion: record.checkpointVersion,
    checkpointId: record.checkpointId,
    sessionId: record.sessionId,
    baseEventPosition: record.baseEventPosition,
    checkpointEventPosition: record.checkpointEventPosition,
    finalStreamVersion: record.finalStreamVersion,
    checkpointRequiredCleared: record.checkpointRequiredCleared,
  }) as CheckpointRecordedResult;
}

function checkpointFingerprint(checkpoint: Checkpoint): string {
  return createHash("sha256")
    .update(`project-memory/checkpoint/v${checkpoint.checkpointVersion}\n`, "utf8")
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
    const checkpoint = input.checkpoint.checkpointVersion === 1
      ? decodeCheckpointV1(input.checkpoint)
      : input.checkpoint.checkpointVersion === 2
        ? decodeCheckpointV2(input.checkpoint)
        : invalid("INTEGRITY_FAILURE");
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
): Checkpoint {
  const { authority, aggregate } = input;
  const checkpoint = input.checkpoint === null
    ? null
    : input.checkpoint.checkpointVersion === 1
      ? decodeCheckpointV1(input.checkpoint)
      : input.checkpoint.checkpointVersion === 2
        ? decodeCheckpointV2(input.checkpoint)
        : invalid("INTEGRITY_FAILURE");
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
  checkpoint: Checkpoint,
  parentSessionId: string | null,
  occurredAt: string,
): PendingEvent {
  return {
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: checkpoint.checkpointVersion,
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
  readonly #faultInjector: CheckpointServiceOptions["faultInjector"];
  readonly #preparedFinals = new WeakMap<
    PreparedFinalCheckpointPhase,
    {
      readonly transaction: LifecycleCommandTransaction;
      readonly effect: FreshLifecycleEffect<CheckpointRecordedResult>;
    }
  >();

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
    this.#faultInjector = options.faultInjector;
  }

  record(
    transaction: LifecycleCommandTransaction,
    commandInput: RecordCheckpointCommandV2 | RecordCheckpointCommandV3,
  ): FreshLifecycleEffect<CheckpointRecordedResult> {
    return this.#record(transaction, commandInput, false);
  }

  prepareFinalPhase(
    transaction: LifecycleCommandTransaction,
    input: FinalCheckpointPhasePreparationInput,
  ): PreparedFinalCheckpointPhase {
    const preparedInput = finalCheckpointPreparationInput(input);
    const effect = immutablePreparedEffect(this.#record(transaction, preparedInput.command, true));
    const pending = effect.append.events[0];
    if (pending?.eventType !== "SessionCheckpointRecorded"
      || typeof pending.payload !== "object" || pending.payload === null
      || Array.isArray(pending.payload)) invalid("INTEGRITY_FAILURE");
    const checkpointInput = (pending.payload as Readonly<Record<string, JsonValue>>).checkpoint;
    const checkpoint = preparedInput.command.draft.checkpointVersion === 1
      ? decodeCheckpointV1(checkpointInput)
      : preparedInput.command.draft.checkpointVersion === 2
        ? decodeCheckpointV2(checkpointInput)
        : invalid("INTEGRITY_FAILURE");
    const action = Object.freeze({
      action: "record-final-checkpoint-and-queue-ending" as const,
      finalCheckpoint: checkpoint,
      materializationTarget: preparedInput.materializationTarget,
    });
    const prepared = Object.freeze({
      [PREPARED_FINAL_CHECKPOINT_PHASE]: true as const,
      action,
      effect,
    }) as PreparedFinalCheckpointPhase;
    this.#preparedFinals.set(prepared, Object.freeze({ transaction, effect }));
    return prepared;
  }

  recordPreparedFinal(
    transaction: LifecycleCommandTransaction,
    prepared: PreparedFinalCheckpointPhase,
  ): FreshLifecycleEffect<CheckpointRecordedResult> {
    if (typeof prepared !== "object" || prepared === null) invalid("INTEGRITY_FAILURE");
    const owned = this.#preparedFinals.get(prepared);
    if (owned === undefined || owned.transaction !== transaction) invalid("INTEGRITY_FAILURE");
    void transaction.authority;
    this.#preparedFinals.delete(prepared);
    return owned.effect;
  }

  #record(
    transaction: LifecycleCommandTransaction,
    commandInput: RecordCheckpointCommandV2 | RecordCheckpointCommandV3,
    finalization: boolean,
  ): FreshLifecycleEffect<CheckpointRecordedResult> {
    const decoded = decodeLifecycleSemanticCommandDraft(commandInput);
    if (decoded.commandType !== "record-checkpoint") invalid();
    if (decoded.draft.checkpointVersion !== 1 && decoded.draft.checkpointVersion !== 2) invalid();
    const command = decoded;
    const invocation = this.#invocations.current(transaction, command);
    assertContext(invocation.context, command);
    const draft = command.draft.checkpointVersion === 1
      ? decodeCheckpointDraftV1(command.draft)
      : decodeCheckpointDraftV2(command.draft);
    assertDraftPaths(invocation.context, draft);

    const authority = authorityOperations(transaction);
    const observed = authority.get(invocation.context.binding.projectId, command.sessionId);
    if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
    const aggregate = Object.freeze({
      ...authority.requireFoldMatch(current),
    }) as SessionAggregateState;
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

    const coverage: CheckpointEvidenceCoverageV1 | CheckpointEvidenceCoverageV2 =
      draft.checkpointVersion === 1
        ? (transaction.coverage.assertVersion1Eligible(
            Object.freeze([current.sessionId as SessionId]),
          ), EMPTY_COVERAGE)
        : syncValue(transaction.coverage.snapshotV2(
            current.sessionId as SessionId,
            baseEventPosition,
          ));

    const childSummaries = aggregate.kind === "root"
      ? [...authority.listNonterminalChildren(current.projectId, current.sessionId)]
          .map((childObserved) => {
            const child = Object.freeze({ ...childObserved }) as SessionAuthorityRecord;
            authority.latestCheckpoint(child);
            const childAggregate = Object.freeze({
              ...authority.requireFoldMatch(child),
            }) as SessionAggregateState;
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
    const createdAt = canonicalNow(this.#clock);
    const checkpointInput = {
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
    };
    const checkpoint = draft.checkpointVersion === 1
      ? decodeCheckpointV1(checkpointInput)
      : decodeCheckpointV2(checkpointInput);
    const fingerprint = checkpointFingerprint(checkpoint);
    const checkpointRequiredCleared = markerPosition !== null;
    const result = decodeCheckpointRecordedResult({
      checkpointVersion: checkpoint.checkpointVersion,
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
