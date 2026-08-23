import type {
  ArtifactProjection,
  CanonicalItemProjection,
  CheckpointProjectionEvent,
  FollowUpProjection,
  LexicalChunkProjection,
  MemorySourceProjectionEvent,
  ProjectBinding,
  ProjectionEvent,
  ProjectionFoldState,
  ProjectionItemStatus,
  RetrievalFeedbackProjection,
  SessionCheckpointProjection,
} from "./contracts.js";
import { validateProjectionEvent } from "./source-event-codec.js";

const MAX_ROWS_PER_PROJECTION = 100_000;
const MAX_SUMMARY_BYTES = 16 * 1024;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;

const STATUS_TRANSITIONS: Readonly<Record<ProjectionItemStatus, readonly ProjectionItemStatus[]>> =
  Object.freeze({
    candidate: Object.freeze(["provisional", "verified", "conflicted", "retracted", "expired", "erased-evidence"] as const),
    provisional: Object.freeze(["verified", "conflicted", "retracted", "expired", "erased-evidence"] as const),
    verified: Object.freeze(["conflicted", "superseded", "retracted", "expired", "erased-evidence"] as const),
    conflicted: Object.freeze(["verified", "retracted", "expired", "erased-evidence"] as const),
    superseded: Object.freeze(["erased-evidence"] as const),
    retracted: Object.freeze(["erased-evidence"] as const),
    expired: Object.freeze(["erased-evidence"] as const),
    "erased-evidence": Object.freeze([] as const),
  });

function integrity(): never {
  throw new Error("INTEGRITY_FAILURE");
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return integrity();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return integrity();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || key === "__proto__" || !expectedKeys.includes(key))
  ) return integrity();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return integrity();
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function strictArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return integrity();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    !Number.isSafeInteger(length)
    || Number(length) < 0
    || Number(length) > MAX_ROWS_PER_PROJECTION
  ) return integrity();
  const keys = Reflect.ownKeys(value);
  const expected = [
    ...Array.from({ length: Number(length) }, (_, index) => String(index)),
    "length",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return integrity();
  }
  const result: unknown[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return integrity();
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertBoundedString(
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) return integrity();
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) return integrity();
}

function validateBinding(value: unknown): ProjectBinding {
  const source = exactRecord(value, [
    "projectId",
    "vaultId",
    "storeId",
    "workspaceId",
    "branchScopeId",
    "branchRef",
    "sessionId",
  ]);
  for (const key of ["projectId", "vaultId", "storeId", "workspaceId"] as const) {
    if (typeof source[key] !== "string" || !HASH.test(source[key])) return integrity();
  }
  if (source.branchScopeId !== null) assertUuid(source.branchScopeId);
  if (source.branchRef !== null) assertBoundedString(source.branchRef, 1_024);
  if (source.sessionId !== null) assertUuid(source.sessionId);
  return Object.freeze({
    projectId: source.projectId as ProjectBinding["projectId"],
    vaultId: source.vaultId as ProjectBinding["vaultId"],
    storeId: source.storeId as ProjectBinding["storeId"],
    workspaceId: source.workspaceId as ProjectBinding["workspaceId"],
    branchScopeId: source.branchScopeId as ProjectBinding["branchScopeId"],
    branchRef: source.branchRef as string | null,
    sessionId: source.sessionId as string | null,
  });
}

function inspectRows(value: unknown, expectedKeys: readonly string[]): readonly Record<string, unknown>[] {
  return Object.freeze(strictArray(value).map((row) => Object.freeze(exactRecord(row, expectedKeys))));
}

function assertPositiveBigint(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) return integrity();
}

function assertNumber(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return integrity();
  }
}

function assertTimestamp(value: unknown): asserts value is string {
  assertBoundedString(value, 24);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return integrity();
}

function assertOneOf<T extends string>(value: unknown, values: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) return integrity();
}

function assertProjectRows(
  rows: readonly Record<string, unknown>[],
  binding: ProjectBinding | null,
  terminalEventPosition: bigint | null,
): void {
  if (rows.length > 0 && (binding === null || terminalEventPosition === null)) return integrity();
  for (const row of rows) {
    if (
      row.projectId !== binding?.projectId
      || typeof row.sourceEventPosition !== "bigint"
      || row.sourceEventPosition < 1n
      || row.sourceEventPosition > SQLITE_INT64_MAX
      || (terminalEventPosition !== null && row.sourceEventPosition > terminalEventPosition)
    ) return integrity();
  }
}

function assertUniqueIdentities(
  rows: readonly Record<string, unknown>[],
  identity: (row: Record<string, unknown>) => string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = identity(row);
    if (seen.has(key)) return integrity();
    seen.add(key);
  }
}

function validateState(value: unknown): ProjectionFoldState {
  const source = exactRecord(value, [
    "schemaVersion",
    "binding",
    "terminalEventPosition",
    "sessionCheckpoints",
    "canonicalItems",
    "followUps",
    "artifacts",
    "lexicalChunks",
    "retrievalFeedback",
  ]);
  if (source.schemaVersion !== 1) return integrity();
  const binding = source.binding === null ? null : validateBinding(source.binding);
  if (
    source.terminalEventPosition !== null
    && (
      typeof source.terminalEventPosition !== "bigint"
      || source.terminalEventPosition < 1n
      || source.terminalEventPosition > SQLITE_INT64_MAX
    )
  ) return integrity();
  const sessionCheckpoints = inspectRows(source.sessionCheckpoints, [
    "projectId", "sessionId", "checkpointId", "checkpointVersion", "baseEventPosition",
    "sourceEventPosition", "occurredAt", "taskSummary",
  ]);
  const canonicalItems = inspectRows(source.canonicalItems, [
    "projectId", "itemId", "normalizedKey", "status", "confidence", "verificationMethod",
    "validFrom", "validTo", "summary", "contentHash", "knownFromEventPosition",
    "sourceEventPosition",
  ]);
  const followUps = inspectRows(source.followUps, [
    "projectId", "sessionId", "followUpId", "status", "summary", "confidence",
    "sourceEventPosition",
  ]);
  const artifacts = inspectRows(source.artifacts, [
    "projectId", "sessionId", "artifactId", "path", "summary", "action", "contentHash",
    "branchRef", "confidence", "sourceEventPosition",
  ]);
  const lexicalChunks = inspectRows(source.lexicalChunks, [
    "projectId", "chunkId", "itemId", "sessionId", "section", "normalizedKey", "text",
    "sourceEventPosition",
  ]);
  const retrievalFeedback = inspectRows(source.retrievalFeedback, [
    "projectId", "feedbackId", "itemId", "outcome", "usefulness",
    "sourceItemEventPosition", "sourceEventPosition",
  ]);
  const terminalEventPosition = source.terminalEventPosition as bigint | null;
  for (const rows of [sessionCheckpoints, canonicalItems, followUps, artifacts, lexicalChunks, retrievalFeedback]) {
    assertProjectRows(rows, binding, terminalEventPosition);
  }
  for (const row of sessionCheckpoints) {
    assertUuid(row.sessionId);
    assertUuid(row.checkpointId);
    if (row.checkpointVersion !== 1 && row.checkpointVersion !== 2) return integrity();
    assertPositiveBigint(row.baseEventPosition);
    assertPositiveBigint(row.sourceEventPosition);
    if (row.baseEventPosition > row.sourceEventPosition) return integrity();
    assertTimestamp(row.occurredAt);
    assertBoundedString(row.taskSummary, MAX_SUMMARY_BYTES);
  }
  for (const row of canonicalItems) {
    assertUuid(row.itemId);
    assertBoundedString(row.normalizedKey, 512);
    if (row.normalizedKey.normalize("NFKC").trim().toLowerCase() !== row.normalizedKey) return integrity();
    assertOneOf(row.status, [
      "candidate", "provisional", "verified", "conflicted", "superseded", "retracted",
      "expired", "erased-evidence",
    ] as const);
    assertOneOf(row.confidence, ["high", "medium", "low", "guess"] as const);
    assertBoundedString(row.verificationMethod, 128);
    assertTimestamp(row.validFrom);
    if (row.validTo !== null) {
      assertTimestamp(row.validTo);
      if (Date.parse(row.validTo) <= Date.parse(row.validFrom)) return integrity();
    }
    assertBoundedString(row.summary, MAX_SUMMARY_BYTES);
    if (typeof row.contentHash !== "string" || !HASH.test(row.contentHash)) return integrity();
    assertPositiveBigint(row.knownFromEventPosition);
    assertPositiveBigint(row.sourceEventPosition);
    if (row.knownFromEventPosition > row.sourceEventPosition) return integrity();
  }
  for (const row of followUps) {
    assertUuid(row.sessionId);
    assertBoundedString(row.followUpId, 256);
    assertOneOf(row.status, ["open", "blocked"] as const);
    assertBoundedString(row.summary, MAX_SUMMARY_BYTES);
    assertOneOf(row.confidence, ["high", "medium", "low", "guess"] as const);
  }
  for (const row of artifacts) {
    assertUuid(row.sessionId);
    assertBoundedString(row.artifactId, 256);
    assertBoundedString(row.path, 2_048);
    if (row.summary !== null) assertBoundedString(row.summary, MAX_SUMMARY_BYTES);
    assertOneOf(row.action, ["created", "modified", "deleted", "observed", "renamed", "referenced"] as const);
    if (row.contentHash !== null && (typeof row.contentHash !== "string" || !HASH.test(row.contentHash))) {
      return integrity();
    }
    if (row.branchRef !== null) assertBoundedString(row.branchRef, 1_024);
    assertOneOf(row.confidence, ["high", "medium", "low", "guess"] as const);
  }
  for (const row of lexicalChunks) {
    assertBoundedString(row.chunkId, 256);
    if (row.itemId !== null) assertUuid(row.itemId);
    if (row.sessionId !== null) assertUuid(row.sessionId);
    assertBoundedString(row.section, 128);
    assertBoundedString(row.normalizedKey, 512);
    assertBoundedString(row.text, MAX_SUMMARY_BYTES);
  }
  for (const row of retrievalFeedback) {
    assertUuid(row.feedbackId);
    assertUuid(row.itemId);
    assertOneOf(row.outcome, ["accepted", "dismissed", "corrected"] as const);
    assertNumber(row.usefulness, 0, 10_000);
    assertPositiveBigint(row.sourceItemEventPosition);
    assertPositiveBigint(row.sourceEventPosition);
    if (row.sourceItemEventPosition > row.sourceEventPosition) return integrity();
  }
  assertUniqueIdentities(sessionCheckpoints, (row) => row.sessionId as string);
  assertUniqueIdentities(sessionCheckpoints, (row) => row.checkpointId as string);
  assertUniqueIdentities(canonicalItems, (row) => row.itemId as string);
  assertUniqueIdentities(canonicalItems, (row) => row.normalizedKey as string);
  assertUniqueIdentities(followUps, (row) => row.followUpId as string);
  assertUniqueIdentities(
    artifacts,
    (row) => `${String(row.sessionId)}\u0000${String(row.artifactId)}`,
  );
  assertUniqueIdentities(lexicalChunks, (row) => row.chunkId as string);
  assertUniqueIdentities(
    lexicalChunks.filter((row) => row.itemId !== null),
    (row) => `${String(row.itemId)}\u0000${String(row.section)}`,
  );
  assertUniqueIdentities(retrievalFeedback, (row) => row.feedbackId as string);
  if (
    binding === null
    && (
      terminalEventPosition !== null
      || sessionCheckpoints.length > 0
      || canonicalItems.length > 0
      || followUps.length > 0
      || artifacts.length > 0
      || lexicalChunks.length > 0
      || retrievalFeedback.length > 0
    )
  ) return integrity();
  return Object.freeze({
    schemaVersion: 1,
    binding,
    terminalEventPosition,
    sessionCheckpoints: sessionCheckpoints as unknown as readonly SessionCheckpointProjection[],
    canonicalItems: canonicalItems as unknown as readonly CanonicalItemProjection[],
    followUps: followUps as unknown as readonly FollowUpProjection[],
    artifacts: artifacts as unknown as readonly ArtifactProjection[],
    lexicalChunks: lexicalChunks as unknown as readonly LexicalChunkProjection[],
    retrievalFeedback: retrievalFeedback as unknown as readonly RetrievalFeedbackProjection[],
  });
}

function sameProjectionScope(left: ProjectBinding, right: ProjectBinding): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.branchScopeId === right.branchScopeId
    && left.branchRef === right.branchRef;
}

function frozenRows<T>(rows: readonly T[]): readonly T[] {
  if (rows.length > MAX_ROWS_PER_PROJECTION) return integrity();
  return Object.freeze(rows);
}

export function emptyProjectionFoldState(): ProjectionFoldState {
  return Object.freeze({
    schemaVersion: 1,
    binding: null,
    terminalEventPosition: null,
    sessionCheckpoints: Object.freeze([]),
    canonicalItems: Object.freeze([]),
    followUps: Object.freeze([]),
    artifacts: Object.freeze([]),
    lexicalChunks: Object.freeze([]),
    retrievalFeedback: Object.freeze([]),
  });
}

function replaceBy<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  replacement: T,
): readonly T[] {
  const index = values.findIndex(predicate);
  if (index < 0) return frozenRows([...values, replacement]);
  const result = [...values];
  result[index] = replacement;
  return frozenRows(result);
}

function checkpointFollowUps(event: CheckpointProjectionEvent): readonly FollowUpProjection[] {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  return frozenRows(event.workItems.flatMap((item) => {
    if (item.kind !== "in-progress" && item.kind !== "blocker" && item.kind !== "next-action") {
      return [];
    }
    return [Object.freeze({
      projectId: event.binding.projectId,
      sessionId,
      followUpId: `${event.sourceEventId}/follow-up/${item.kind}/${item.ordinal}`,
      status: item.kind === "blocker" ? "blocked" as const : "open" as const,
      summary: item.summary,
      confidence: item.confidence,
      sourceEventPosition: event.sourceEventPosition,
    })];
  }));
}

function checkpointArtifacts(event: CheckpointProjectionEvent): readonly ArtifactProjection[] {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  const files = event.files.map((file) => Object.freeze({
    projectId: event.binding.projectId,
    sessionId,
    artifactId: `${event.sourceEventId}/file/${file.ordinal}`,
    path: file.path,
    summary: null,
    action: file.action,
    contentHash: file.contentHash,
    branchRef: file.branchRef,
    confidence: file.confidence,
    sourceEventPosition: event.sourceEventPosition,
  }));
  const artifacts = event.artifacts.map((artifact) => Object.freeze({
    projectId: event.binding.projectId,
    sessionId,
    artifactId: artifact.artifactId,
    path: artifact.path,
    summary: artifact.summary,
    action: "referenced",
    contentHash: artifact.contentHash,
    branchRef: event.binding.branchRef,
    confidence: artifact.confidence,
    sourceEventPosition: event.sourceEventPosition,
  }));
  return frozenRows([...files, ...artifacts]);
}

function checkpointChunks(event: CheckpointProjectionEvent): readonly LexicalChunkProjection[] {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  const summary = Object.freeze({
    projectId: event.binding.projectId,
    chunkId: `${event.sourceEventId}/task-summary`,
    itemId: null,
    sessionId,
    section: "task-summary",
    normalizedKey: `checkpoint:${event.checkpointId}:task-summary`,
    text: event.taskSummary,
    sourceEventPosition: event.sourceEventPosition,
  });
  return frozenRows([
    summary,
    ...event.workItems.map((item) => Object.freeze({
      projectId: event.binding.projectId,
      chunkId: `${event.sourceEventId}/${item.kind}/${item.ordinal}`,
      itemId: null,
      sessionId,
      section: item.kind,
      normalizedKey: `checkpoint:${event.checkpointId}:${item.kind}:${item.ordinal}`,
      text: item.summary,
      sourceEventPosition: event.sourceEventPosition,
    })),
  ]);
}

function foldCheckpoint(state: ProjectionFoldState, event: CheckpointProjectionEvent): ProjectionFoldState {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  const checkpoint = Object.freeze({
    projectId: event.binding.projectId,
    sessionId,
    checkpointId: event.checkpointId,
    checkpointVersion: event.checkpointVersion,
    baseEventPosition: event.baseEventPosition,
    sourceEventPosition: event.sourceEventPosition,
    occurredAt: event.occurredAt,
    taskSummary: event.taskSummary,
  });
  return Object.freeze({
    ...state,
    sessionCheckpoints: replaceBy(
      state.sessionCheckpoints,
      (row) => row.sessionId === sessionId,
      checkpoint,
    ),
    followUps: frozenRows([
      ...state.followUps.filter((row) => row.sessionId !== sessionId),
      ...checkpointFollowUps(event),
    ]),
    artifacts: frozenRows([
      ...state.artifacts.filter((row) => row.sessionId !== sessionId),
      ...checkpointArtifacts(event),
    ]),
    lexicalChunks: frozenRows([
      ...state.lexicalChunks.filter((row) => row.sessionId !== sessionId || row.itemId !== null),
      ...checkpointChunks(event),
    ]),
  });
}

function allowedInitialStatus(status: ProjectionItemStatus): boolean {
  return status === "candidate"
    || status === "provisional"
    || status === "verified"
    || status === "conflicted";
}

function foldMemorySource(
  state: ProjectionFoldState,
  event: MemorySourceProjectionEvent,
): ProjectionFoldState {
  const current = state.canonicalItems.find((item) => item.itemId === event.itemId);
  if (current === undefined && !allowedInitialStatus(event.status)) return integrity();
  if (current !== undefined) {
    if (
      current.normalizedKey !== event.normalizedKey
      || current.validFrom !== event.validFrom
      || (
        current.status !== event.status
        && !STATUS_TRANSITIONS[current.status].includes(event.status)
      )
    ) return integrity();
  }
  const item = Object.freeze({
    projectId: event.binding.projectId,
    itemId: event.itemId,
    normalizedKey: event.normalizedKey,
    status: event.status,
    confidence: event.confidence,
    verificationMethod: event.verificationMethod,
    validFrom: event.validFrom,
    validTo: event.validTo,
    summary: event.summary,
    contentHash: event.contentHash,
    knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
    sourceEventPosition: event.sourceEventPosition,
  });
  const chunk = Object.freeze({
    projectId: event.binding.projectId,
    chunkId: `item/${event.itemId}`,
    itemId: event.itemId,
    sessionId: event.binding.sessionId,
    section: "canonical-item",
    normalizedKey: event.normalizedKey,
    text: event.summary,
    sourceEventPosition: event.sourceEventPosition,
  });
  return Object.freeze({
    ...state,
    canonicalItems: replaceBy(state.canonicalItems, (row) => row.itemId === event.itemId, item),
    lexicalChunks: replaceBy(
      state.lexicalChunks,
      (row) => row.itemId === event.itemId && row.section === "canonical-item",
      chunk,
    ),
  });
}

function foldFeedback(
  state: ProjectionFoldState,
  event: Extract<ProjectionEvent, { readonly kind: "retrieval-feedback" }>,
): ProjectionFoldState {
  const item = state.canonicalItems.find((candidate) => candidate.itemId === event.itemId);
  if (
    item === undefined
    || event.sourceItemEventPosition < item.knownFromEventPosition
    || item.sourceEventPosition < event.sourceItemEventPosition
  ) return integrity();
  if (state.retrievalFeedback.some((feedback) => feedback.feedbackId === event.feedbackId)) {
    return integrity();
  }
  const feedback = Object.freeze({
    projectId: event.binding.projectId,
    feedbackId: event.feedbackId,
    itemId: event.itemId,
    outcome: event.outcome,
    usefulness: event.usefulness,
    sourceItemEventPosition: event.sourceItemEventPosition,
    sourceEventPosition: event.sourceEventPosition,
  });
  return Object.freeze({
    ...state,
    retrievalFeedback: frozenRows([...state.retrievalFeedback, feedback]),
  });
}

function applyProjectionFold(state: ProjectionFoldState, event: ProjectionEvent): ProjectionFoldState {
  const binding = state.binding ?? event.binding;
  if (state.binding !== null && !sameProjectionScope(state.binding, event.binding)) return integrity();
  if (
    state.terminalEventPosition !== null
    && event.sourceEventPosition <= state.terminalEventPosition
  ) return integrity();

  const scopedState = Object.freeze({ ...state, binding });
  const applied = event.kind === "checkpoint"
    ? foldCheckpoint(scopedState, event)
    : event.kind === "memory-source"
      ? foldMemorySource(scopedState, event)
      : foldFeedback(scopedState, event);
  return Object.freeze({
    ...applied,
    terminalEventPosition: event.sourceEventPosition,
  });
}

export function foldProjectionEvent(
  state: ProjectionFoldState,
  event: ProjectionEvent,
): ProjectionFoldState {
  try {
    const safeState = validateState(state);
    const safeEvent = validateProjectionEvent(event);
    return Object.freeze(applyProjectionFold(safeState, safeEvent));
  } catch (error) {
    if (error instanceof Error && error.message === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

/**
 * Incremental replay fold used by integrity verification. Unlike
 * foldProjectionEvent(), this keeps indexed mutable working sets and performs
 * the expensive whole-state validation once, when replay is complete.
 */
export class ProjectionFoldAccumulator {
  #binding: ProjectBinding | null = null;
  #terminalEventPosition: bigint | null = null;
  readonly #sessionCheckpoints = new Map<string, SessionCheckpointProjection>();
  readonly #checkpointOwners = new Map<string, string>();
  readonly #canonicalItems = new Map<string, CanonicalItemProjection>();
  readonly #normalizedKeyOwners = new Map<string, string>();
  readonly #followUps = new Map<string, FollowUpProjection>();
  readonly #sessionFollowUps = new Map<string, Set<string>>();
  readonly #artifacts = new Map<string, ArtifactProjection>();
  readonly #sessionArtifacts = new Map<string, Set<string>>();
  readonly #lexicalChunks = new Map<string, LexicalChunkProjection>();
  readonly #sessionChunks = new Map<string, Set<string>>();
  readonly #retrievalFeedback = new Map<string, RetrievalFeedbackProjection>();

  append(value: ProjectionEvent): void {
    const event = validateProjectionEvent(value);
    if (this.#binding !== null && !sameProjectionScope(this.#binding, event.binding)) {
      return integrity();
    }
    if (
      this.#terminalEventPosition !== null
      && event.sourceEventPosition <= this.#terminalEventPosition
    ) return integrity();
    this.#binding ??= event.binding;
    if (event.kind === "checkpoint") this.#appendCheckpoint(event);
    else if (event.kind === "memory-source") this.#appendMemorySource(event);
    else this.#appendFeedback(event);
    this.#terminalEventPosition = event.sourceEventPosition;
  }

  finish(): ProjectionFoldState {
    return validateState(Object.freeze({
      schemaVersion: 1,
      binding: this.#binding,
      terminalEventPosition: this.#terminalEventPosition,
      sessionCheckpoints: Object.freeze([...this.#sessionCheckpoints.values()]),
      canonicalItems: Object.freeze([...this.#canonicalItems.values()]),
      followUps: Object.freeze([...this.#followUps.values()]),
      artifacts: Object.freeze([...this.#artifacts.values()]),
      lexicalChunks: Object.freeze([...this.#lexicalChunks.values()]),
      retrievalFeedback: Object.freeze([...this.#retrievalFeedback.values()]),
    }));
  }

  #assertRoom(size: number, replacing: boolean): void {
    if (!replacing && size >= MAX_ROWS_PER_PROJECTION) return integrity();
  }

  #deleteSessionRows<T>(
    sessionId: string,
    keysBySession: Map<string, Set<string>>,
    rows: Map<string, T>,
  ): void {
    for (const key of keysBySession.get(sessionId) ?? []) rows.delete(key);
    keysBySession.delete(sessionId);
  }

  #appendCheckpoint(event: CheckpointProjectionEvent): void {
    const sessionId = event.binding.sessionId;
    if (sessionId === null) return integrity();
    const prior = this.#sessionCheckpoints.get(sessionId);
    const owner = this.#checkpointOwners.get(event.checkpointId);
    if (owner !== undefined && owner !== sessionId) return integrity();
    this.#assertRoom(this.#sessionCheckpoints.size, prior !== undefined);
    if (prior !== undefined && prior.checkpointId !== event.checkpointId) {
      this.#checkpointOwners.delete(prior.checkpointId);
    }
    this.#sessionCheckpoints.set(sessionId, Object.freeze({
      projectId: event.binding.projectId,
      sessionId,
      checkpointId: event.checkpointId,
      checkpointVersion: event.checkpointVersion,
      baseEventPosition: event.baseEventPosition,
      sourceEventPosition: event.sourceEventPosition,
      occurredAt: event.occurredAt,
      taskSummary: event.taskSummary,
    }));
    this.#checkpointOwners.set(event.checkpointId, sessionId);

    this.#deleteSessionRows(sessionId, this.#sessionFollowUps, this.#followUps);
    const followUps = checkpointFollowUps(event);
    if (this.#followUps.size + followUps.length > MAX_ROWS_PER_PROJECTION) return integrity();
    const followUpKeys = new Set<string>();
    for (const row of followUps) {
      if (this.#followUps.has(row.followUpId)) return integrity();
      this.#followUps.set(row.followUpId, row);
      followUpKeys.add(row.followUpId);
    }
    this.#sessionFollowUps.set(sessionId, followUpKeys);

    this.#deleteSessionRows(sessionId, this.#sessionArtifacts, this.#artifacts);
    const artifacts = checkpointArtifacts(event);
    if (this.#artifacts.size + artifacts.length > MAX_ROWS_PER_PROJECTION) return integrity();
    const artifactKeys = new Set<string>();
    for (const row of artifacts) {
      const key = `${row.sessionId}\u0000${row.artifactId}`;
      if (this.#artifacts.has(key)) return integrity();
      this.#artifacts.set(key, row);
      artifactKeys.add(key);
    }
    this.#sessionArtifacts.set(sessionId, artifactKeys);

    this.#deleteSessionRows(sessionId, this.#sessionChunks, this.#lexicalChunks);
    const chunks = checkpointChunks(event);
    if (this.#lexicalChunks.size + chunks.length > MAX_ROWS_PER_PROJECTION) return integrity();
    const chunkKeys = new Set<string>();
    for (const row of chunks) {
      if (this.#lexicalChunks.has(row.chunkId)) return integrity();
      this.#lexicalChunks.set(row.chunkId, row);
      chunkKeys.add(row.chunkId);
    }
    this.#sessionChunks.set(sessionId, chunkKeys);
  }

  #appendMemorySource(event: MemorySourceProjectionEvent): void {
    const current = this.#canonicalItems.get(event.itemId);
    if (current === undefined && !allowedInitialStatus(event.status)) return integrity();
    if (current !== undefined && (
      current.normalizedKey !== event.normalizedKey
      || current.validFrom !== event.validFrom
      || (
        current.status !== event.status
        && !STATUS_TRANSITIONS[current.status].includes(event.status)
      )
    )) return integrity();
    const normalizedKeyOwner = this.#normalizedKeyOwners.get(event.normalizedKey);
    if (normalizedKeyOwner !== undefined && normalizedKeyOwner !== event.itemId) return integrity();
    this.#assertRoom(this.#canonicalItems.size, current !== undefined);
    this.#canonicalItems.set(event.itemId, Object.freeze({
      projectId: event.binding.projectId,
      itemId: event.itemId,
      normalizedKey: event.normalizedKey,
      status: event.status,
      confidence: event.confidence,
      verificationMethod: event.verificationMethod,
      validFrom: event.validFrom,
      validTo: event.validTo,
      summary: event.summary,
      contentHash: event.contentHash,
      knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
      sourceEventPosition: event.sourceEventPosition,
    }));
    this.#normalizedKeyOwners.set(event.normalizedKey, event.itemId);
    const chunkId = `item/${event.itemId}`;
    this.#assertRoom(this.#lexicalChunks.size, this.#lexicalChunks.has(chunkId));
    this.#lexicalChunks.set(chunkId, Object.freeze({
      projectId: event.binding.projectId,
      chunkId,
      itemId: event.itemId,
      sessionId: event.binding.sessionId,
      section: "canonical-item",
      normalizedKey: event.normalizedKey,
      text: event.summary,
      sourceEventPosition: event.sourceEventPosition,
    }));
  }

  #appendFeedback(
    event: Extract<ProjectionEvent, { readonly kind: "retrieval-feedback" }>,
  ): void {
    const item = this.#canonicalItems.get(event.itemId);
    if (
      item === undefined
      || event.sourceItemEventPosition < item.knownFromEventPosition
      || item.sourceEventPosition < event.sourceItemEventPosition
      || this.#retrievalFeedback.has(event.feedbackId)
    ) return integrity();
    this.#assertRoom(this.#retrievalFeedback.size, false);
    this.#retrievalFeedback.set(event.feedbackId, Object.freeze({
      projectId: event.binding.projectId,
      feedbackId: event.feedbackId,
      itemId: event.itemId,
      outcome: event.outcome,
      usefulness: event.usefulness,
      sourceItemEventPosition: event.sourceItemEventPosition,
      sourceEventPosition: event.sourceEventPosition,
    }));
  }
}
