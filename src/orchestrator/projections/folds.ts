import type { ProjectionEventV3, GovernedMemorySourceProjectionEventV3, ProjectionSourceDisposition, ProjectionFoldStateV3, GovernedNoteProjectionRowV1 } from "./contracts.js";
import { validateGovernedNoteProjectionRows } from "./contracts.js";
export { validateGovernedNoteProjectionRows } from "./contracts.js";
import { decodeProjectionSourceV3 } from "./source-event-codec.js";
import {
  isProjectionProjectStoreIdentity,
  isProjectionWorkspaceIdentity,
} from "./contracts.js";
import type {
  ArtifactProjection,
  CanonicalItemProjection,
  CheckpointProjectionEvent,
  EntityAliasProjection,
  EntityEdgeProjection,
  EntityNodeProjection,
  FollowUpProjection,
  GovernedMemorySourceProjectionEvent,
  LexicalChunkProjection,
  MemorySourceProjectionEvent,
  ProjectBinding,
  ProjectionEvent,
  ProjectionFoldState,
  ProjectionItemStatus,
  RetrievalFeedbackProjection,
  SessionCheckpointProjection,
  SessionLifecycleProjectionEvent,
  SessionTreeProjection,
} from "./contracts.js";
import { validateProjectionEvent } from "./source-event-codec.js";

const MAX_ROWS = 100_000;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
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

const TERMINAL_LIFECYCLE_EVENTS = new Set<SessionLifecycleProjectionEvent["eventType"]>([
  "SessionEnded",
  "SessionAbandoned",
  "ChildSessionCompleted",
  "ChildWorkTransferCreated",
]);

function integrity(): never {
  throw new Error("INTEGRITY_FAILURE");
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return integrity();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return integrity();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return integrity();
  }
  const result: Record<string, unknown> = {};
  for (const key of names as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return integrity();
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return integrity();
  const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > MAX_ROWS) return integrity();
  const names = Reflect.ownKeys(value);
  const expected = [...Array.from({ length: Number(length) }, (_, index) => String(index)), "length"];
  if (names.length !== expected.length || names.some((key, index) => key !== expected[index])) return integrity();
  return Object.freeze(expected.slice(0, -1).map((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return integrity();
    return descriptor.value;
  }));
}

function rows(value: unknown, keys: readonly string[]): readonly Record<string, unknown>[] {
  return Object.freeze(array(value).map((entry) => Object.freeze(exact(entry, keys))));
}

function text(value: unknown, maximum: number, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value, "utf8") > maximum) {
    return integrity();
  }
}

function uuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) return integrity();
}

function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) return integrity();
}

function position(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) return integrity();
}

function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) return integrity();
}

function timestamp(value: unknown): asserts value is string {
  text(value, 24);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return integrity();
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) return integrity();
}

function nullableText(value: unknown, maximum = MAX_TEXT_BYTES): asserts value is string | null {
  if (value !== null) text(value, maximum);
}

function provenance(row: Record<string, unknown>, terminal: bigint | null): void {
  uuid(row.sourceEventId);
  position(row.sourceEventPosition);
  if (terminal !== null && row.sourceEventPosition > terminal) return integrity();
  nullableText(row.anchor);
}

function binding(value: unknown): ProjectBinding {
  const row = exact(value, [
    "projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId",
  ]);
  for (const key of ["projectId", "vaultId", "storeId"] as const) {
    if (!isProjectionProjectStoreIdentity(row[key])) return integrity();
  }
  if (!isProjectionWorkspaceIdentity(row.workspaceId)) return integrity();
  if (row.branchScopeId !== null) uuid(row.branchScopeId);
  nullableText(row.branchRef, 1_024);
  if (row.sessionId !== null) uuid(row.sessionId);
  return Object.freeze(row) as unknown as ProjectBinding;
}

function sameScope(left: ProjectBinding, right: ProjectBinding): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.branchScopeId === right.branchScopeId
    && left.branchRef === right.branchRef;
}

function unique<T>(values: readonly T[], identity: (value: T) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) return integrity();
    seen.add(key);
  }
}

function validateState(value: unknown): ProjectionFoldState {
  const source = exact(value, [
    "schemaVersion", "binding", "terminalEventPosition", "sessionTree", "sessionCheckpoints",
    "canonicalItems", "followUps", "artifacts", "entityNodes", "entityAliases", "entityEdges",
    "lexicalChunks", "retrievalFeedback",
  ]);
  if (source.schemaVersion !== 2) return integrity();
  const scope = source.binding === null ? null : binding(source.binding);
  const terminal = source.terminalEventPosition;
  if (terminal !== null) position(terminal);
  const tree = rows(source.sessionTree, [
    "projectId", "sessionId", "rootSessionId", "parentSessionId", "lifecycleState", "ownerGeneration",
    "openedEventPosition", "closedEventPosition", "latestCheckpointId", "latestCheckpointEventPosition",
    "sourceEventId", "sourceEventPosition", "latestStreamVersion", "anchor",
  ]);
  const checkpoints = rows(source.sessionCheckpoints, [
    "projectId", "sessionId", "checkpointId", "checkpointVersion", "baseEventPosition",
    "sourceEventPosition", "occurredAt", "taskSummary", "sourceEventId", "anchor",
  ]);
  const items = rows(source.canonicalItems, [
    "projectId", "sessionId", "itemId", "normalizedKey", "status", "confidence", "verificationMethod",
    "validFrom", "validTo", "summary", "contentHash", "conflictGroupId", "supersedingItemId",
    "knownFromEventPosition", "sourceEventId", "sourceEventPosition", "anchor",
  ]);
  const followUps = rows(source.followUps, [
    "projectId", "sessionId", "followUpId", "status", "summary", "confidence", "sourceEventId",
    "sourceEventPosition", "anchor",
  ]);
  const artifacts = rows(source.artifacts, [
    "projectId", "sessionId", "artifactId", "path", "summary", "action", "contentHash", "branchRef",
    "confidence", "symbol", "commitHash", "heading", "sourceEventId", "sourceEventPosition", "anchor",
  ]);
  const nodes = rows(source.entityNodes, [
    "projectId", "entityId", "normalizedName", "entityType", "validFrom", "validTo", "sourceEventId",
    "sourceEventPosition", "anchor",
  ]);
  const aliases = rows(source.entityAliases, [
    "projectId", "aliasId", "entityId", "normalizedAlias", "validFrom", "validTo", "sourceEventId",
    "sourceEventPosition", "anchor",
  ]);
  const edges = rows(source.entityEdges, [
    "projectId", "edgeId", "sourceEntityId", "targetEntityId", "edgeType", "validFrom", "validTo",
    "sourceEventId", "sourceEventPosition", "anchor",
  ]);
  const chunks = rows(source.lexicalChunks, [
    "projectId", "chunkId", "itemId", "sessionId", "section", "normalizedKey", "text", "sourceEventId",
    "sourceEventPosition", "anchor",
  ]);
  const feedback = rows(source.retrievalFeedback, [
    "projectId", "feedbackId", "itemId", "outcome", "usefulness", "sourceItemEventPosition",
    "sourceEventId", "sourceEventPosition", "anchor",
  ]);
  const allRows = [tree, checkpoints, items, followUps, artifacts, nodes, aliases, edges, chunks, feedback];
  for (const collection of allRows) {
    for (const row of collection) {
      if (scope === null || row.projectId !== scope.projectId) return integrity();
      provenance(row, terminal as bigint | null);
    }
  }

  unique(tree, (row) => String(row.sessionId));
  const treeById = new Map<string, Record<string, unknown>>();
  for (const row of tree) {
    uuid(row.sessionId); uuid(row.rootSessionId);
    if (row.parentSessionId !== null) uuid(row.parentSessionId);
    oneOf(row.lifecycleState, ["open", "closed"] as const);
    integer(row.ownerGeneration, 1, 2_147_483_647);
    position(row.openedEventPosition); position(row.latestStreamVersion);
    if (row.closedEventPosition !== null) position(row.closedEventPosition);
    if ((row.lifecycleState === "open") !== (row.closedEventPosition === null)) return integrity();
    if (row.closedEventPosition !== null && row.closedEventPosition < row.openedEventPosition) return integrity();
    if ((row.latestCheckpointId === null) !== (row.latestCheckpointEventPosition === null)) return integrity();
    if (row.latestCheckpointId !== null) uuid(row.latestCheckpointId);
    if (row.latestCheckpointEventPosition !== null) position(row.latestCheckpointEventPosition);
    if (row.sessionId === row.rootSessionId) {
      if (row.parentSessionId !== null) return integrity();
    } else if (row.parentSessionId === null || row.parentSessionId === row.sessionId) return integrity();
    treeById.set(row.sessionId, row);
  }
  for (const row of tree) {
    if (row.parentSessionId === null) continue;
    const parent = treeById.get(String(row.parentSessionId));
    if (parent === undefined || parent.rootSessionId !== row.rootSessionId) return integrity();
    if (row.lifecycleState === "open" && parent.lifecycleState !== "open") return integrity();
    const visited = new Set<string>([String(row.sessionId)]);
    let cursor: Record<string, unknown> | undefined = parent;
    while (cursor !== undefined) {
      const id = String(cursor.sessionId);
      if (visited.has(id)) return integrity();
      visited.add(id);
      if (cursor.parentSessionId === null) break;
      cursor = treeById.get(String(cursor.parentSessionId));
      if (cursor === undefined) return integrity();
    }
  }

  unique(checkpoints, (row) => String(row.checkpointId));
  let priorCheckpointPosition = 0n;
  const latestBySession = new Map<string, Record<string, unknown>>();
  for (const row of checkpoints) {
    uuid(row.sessionId); uuid(row.checkpointId);
    if (row.checkpointVersion !== 1 && row.checkpointVersion !== 2) return integrity();
    position(row.baseEventPosition); timestamp(row.occurredAt); text(row.taskSummary, MAX_SUMMARY_BYTES);
    const session = treeById.get(row.sessionId);
    const sourcePosition = row.sourceEventPosition;
    position(sourcePosition);
    if (session === undefined) return integrity();
    const openedEventPosition = session.openedEventPosition;
    position(openedEventPosition);
    if (
      row.baseEventPosition < openedEventPosition
      || row.baseEventPosition >= sourcePosition
      || sourcePosition <= priorCheckpointPosition
    ) return integrity();
    priorCheckpointPosition = sourcePosition;
    latestBySession.set(row.sessionId, row);
  }
  for (const [sessionId, latest] of latestBySession) {
    const session = treeById.get(sessionId);
    if (session === undefined || session.latestCheckpointId !== latest.checkpointId || session.latestCheckpointEventPosition !== latest.sourceEventPosition) {
      return integrity();
    }
  }
  for (const row of tree) {
    const latest = latestBySession.get(String(row.sessionId));
    if (latest === undefined && (row.latestCheckpointId !== null || row.latestCheckpointEventPosition !== null)) {
      return integrity();
    }
  }

  unique(items, (row) => String(row.itemId));
  unique(items, (row) => String(row.normalizedKey));
  for (const row of items) {
    if (row.sessionId !== null) uuid(row.sessionId);
    uuid(row.itemId); text(row.normalizedKey, 512);
    if (row.normalizedKey.normalize("NFKC").trim().toLowerCase() !== row.normalizedKey) return integrity();
    oneOf(row.status, ["candidate", "provisional", "verified", "conflicted", "superseded", "retracted", "expired", "erased-evidence"] as const);
    oneOf(row.confidence, ["high", "medium", "low", "guess"] as const);
    text(row.verificationMethod, 128); timestamp(row.validFrom);
    if (row.validTo !== null) {
      timestamp(row.validTo);
      if (Date.parse(row.validTo) < Date.parse(row.validFrom)) return integrity();
    }
    text(row.summary, MAX_SUMMARY_BYTES); hash(row.contentHash);
    if (row.conflictGroupId !== null) uuid(row.conflictGroupId);
    if (row.supersedingItemId !== null) {
      uuid(row.supersedingItemId);
      if (row.supersedingItemId === row.itemId) return integrity();
    }
    position(row.knownFromEventPosition);
    position(row.sourceEventPosition);
    if (row.knownFromEventPosition > row.sourceEventPosition) return integrity();
  }

  unique(followUps, (row) => String(row.followUpId));
  for (const row of followUps) {
    uuid(row.sessionId); text(row.followUpId, 256);
    oneOf(row.status, ["open", "blocked", "completed", "carried-forward", "abandoned"] as const);
    text(row.summary, MAX_SUMMARY_BYTES); oneOf(row.confidence, ["high", "medium", "low", "guess"] as const);
  }
  unique(artifacts, (row) => `${String(row.sessionId)}\u0000${String(row.artifactId)}`);
  for (const row of artifacts) {
    uuid(row.sessionId); text(row.artifactId, 256); text(row.path, 2_048);
    if (row.summary !== null) text(row.summary, MAX_SUMMARY_BYTES);
    oneOf(row.action, ["created", "modified", "deleted", "observed", "renamed", "referenced"] as const);
    if (row.contentHash !== null) hash(row.contentHash);
    nullableText(row.branchRef, 1_024); oneOf(row.confidence, ["high", "medium", "low", "guess"] as const);
    nullableText(row.symbol); nullableText(row.heading);
    if (row.commitHash !== null) hash(row.commitHash);
  }

  unique(nodes, (row) => String(row.entityId));
  const nodeIds = new Set<string>();
  for (const row of nodes) {
    uuid(row.entityId); text(row.normalizedName, MAX_TEXT_BYTES); text(row.entityType, MAX_TEXT_BYTES);
    if (row.normalizedName.normalize("NFKC").trim().toLowerCase() !== row.normalizedName) return integrity();
    timestamp(row.validFrom);
    if (row.validTo !== null) { timestamp(row.validTo); if (Date.parse(row.validTo) < Date.parse(row.validFrom)) return integrity(); }
    nodeIds.add(row.entityId);
  }
  unique(aliases, (row) => String(row.aliasId));
  for (const row of aliases) {
    uuid(row.aliasId); uuid(row.entityId); text(row.normalizedAlias, MAX_TEXT_BYTES); timestamp(row.validFrom);
    if (row.normalizedAlias.normalize("NFKC").trim().toLowerCase() !== row.normalizedAlias) return integrity();
    if (!nodeIds.has(row.entityId)) return integrity();
    if (row.validTo !== null) { timestamp(row.validTo); if (Date.parse(row.validTo) < Date.parse(row.validFrom)) return integrity(); }
  }
  unique(edges, (row) => String(row.edgeId));
  for (const row of edges) {
    uuid(row.edgeId); uuid(row.sourceEntityId); uuid(row.targetEntityId); text(row.edgeType, MAX_TEXT_BYTES);
    if (row.sourceEntityId === row.targetEntityId || !nodeIds.has(row.sourceEntityId) || !nodeIds.has(row.targetEntityId)) return integrity();
    timestamp(row.validFrom);
    if (row.validTo !== null) { timestamp(row.validTo); if (Date.parse(row.validTo) < Date.parse(row.validFrom)) return integrity(); }
  }

  unique(chunks, (row) => String(row.chunkId));
  unique(chunks.filter((row) => row.itemId !== null), (row) => `${String(row.itemId)}\u0000${String(row.section)}`);
  for (const row of chunks) {
    text(row.chunkId, 256); if (row.itemId !== null) uuid(row.itemId); if (row.sessionId !== null) uuid(row.sessionId);
    text(row.section, 128); text(row.normalizedKey, 512); text(row.text, MAX_SUMMARY_BYTES);
  }
  unique(feedback, (row) => String(row.feedbackId));
  for (const row of feedback) {
    uuid(row.feedbackId); uuid(row.itemId); oneOf(row.outcome, ["accepted", "dismissed", "corrected"] as const);
    integer(row.usefulness, 0, 10_000); position(row.sourceItemEventPosition);
    position(row.sourceEventPosition);
    if (row.sourceItemEventPosition > row.sourceEventPosition) return integrity();
  }
  if (scope === null && (terminal !== null || allRows.some((collection) => collection.length > 0))) return integrity();
  return Object.freeze({
    schemaVersion: 2,
    binding: scope,
    terminalEventPosition: terminal as bigint | null,
    sessionTree: tree as unknown as readonly SessionTreeProjection[],
    sessionCheckpoints: checkpoints as unknown as readonly SessionCheckpointProjection[],
    canonicalItems: items as unknown as readonly CanonicalItemProjection[],
    followUps: followUps as unknown as readonly FollowUpProjection[],
    artifacts: artifacts as unknown as readonly ArtifactProjection[],
    entityNodes: nodes as unknown as readonly EntityNodeProjection[],
    entityAliases: aliases as unknown as readonly EntityAliasProjection[],
    entityEdges: edges as unknown as readonly EntityEdgeProjection[],
    lexicalChunks: chunks as unknown as readonly LexicalChunkProjection[],
    retrievalFeedback: feedback as unknown as readonly RetrievalFeedbackProjection[],
  });
}

function frozen<T>(values: readonly T[]): readonly T[] {
  if (values.length > MAX_ROWS) return integrity();
  return Object.freeze(values);
}

function replace<T>(values: readonly T[], identity: (value: T) => string, row: T): readonly T[] {
  const key = identity(row);
  const index = values.findIndex((candidate) => identity(candidate) === key);
  if (index < 0) return frozen([...values, row]);
  const result = [...values];
  result[index] = row;
  return frozen(result);
}

export function emptyProjectionFoldState(): ProjectionFoldState {
  return Object.freeze({
    schemaVersion: 2,
    binding: null,
    terminalEventPosition: null,
    sessionTree: Object.freeze([]),
    sessionCheckpoints: Object.freeze([]),
    canonicalItems: Object.freeze([]),
    followUps: Object.freeze([]),
    artifacts: Object.freeze([]),
    entityNodes: Object.freeze([]),
    entityAliases: Object.freeze([]),
    entityEdges: Object.freeze([]),
    lexicalChunks: Object.freeze([]),
    retrievalFeedback: Object.freeze([]),
  });
}

function allowedInitial(status: ProjectionItemStatus): boolean {
  return status === "candidate" || status === "provisional" || status === "verified" || status === "conflicted";
}

function itemTransition(current: CanonicalItemProjection | undefined, event: MemorySourceProjectionEvent | GovernedMemorySourceProjectionEvent | GovernedMemorySourceProjectionEventV3): void {
  const item = event.kind === "memory-source" ? event : event.item;
  if (current === undefined && !allowedInitial(item.status)) return integrity();
  if (current !== undefined && (
    current.normalizedKey !== item.normalizedKey
    || current.sessionId !== event.binding.sessionId
    || current.validFrom !== item.validFrom
    || (current.status !== item.status && !STATUS_TRANSITIONS[current.status].includes(item.status))
  )) return integrity();
}

function checkpointFollowUps(event: CheckpointProjectionEvent): readonly FollowUpProjection[] {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  return frozen(event.workItems.flatMap((item) => (
    item.kind === "in-progress" || item.kind === "blocker" || item.kind === "next-action"
      ? [Object.freeze({
          projectId: event.binding.projectId, sessionId,
          followUpId: `${event.sourceEventId}/follow-up/${item.kind}/${item.ordinal}`,
          status: item.kind === "blocker" ? "blocked" as const : "open" as const,
          summary: item.summary, confidence: item.confidence,
          sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition, anchor: null,
        })]
      : []
  )));
}

function checkpointArtifacts(event: CheckpointProjectionEvent): readonly ArtifactProjection[] {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  return frozen([
    ...event.files.map((file) => Object.freeze({
      projectId: event.binding.projectId, sessionId,
      artifactId: `${event.sourceEventId}/file/${file.ordinal}`, path: file.path, summary: null,
      action: file.action, contentHash: file.contentHash, branchRef: file.branchRef, confidence: file.confidence,
      symbol: null, commitHash: null, heading: null, sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition, anchor: null,
    })),
    ...event.artifacts.map((artifact) => Object.freeze({
      projectId: event.binding.projectId, sessionId, artifactId: artifact.artifactId, path: artifact.path,
      summary: artifact.summary, action: "referenced", contentHash: artifact.contentHash,
      branchRef: event.binding.branchRef, confidence: artifact.confidence,
      symbol: null, commitHash: null, heading: null, sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition, anchor: null,
    })),
  ]);
}

function checkpointChunks(event: CheckpointProjectionEvent): readonly LexicalChunkProjection[] {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  return frozen([
    Object.freeze({
      projectId: event.binding.projectId, chunkId: `${event.sourceEventId}/task-summary`, itemId: null,
      sessionId, section: "task-summary", normalizedKey: `checkpoint:${event.checkpointId}:task-summary`,
      text: event.taskSummary, sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition, anchor: null,
    }),
    ...event.workItems.map((item) => Object.freeze({
      projectId: event.binding.projectId, chunkId: `${event.sourceEventId}/${item.kind}/${item.ordinal}`,
      itemId: null, sessionId, section: item.kind,
      normalizedKey: `checkpoint:${event.checkpointId}:${item.kind}:${item.ordinal}`,
      text: item.summary, sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition, anchor: null,
    })),
  ]);
}

function openingParent(
  tree: ReadonlyMap<string, SessionTreeProjection>,
  event: SessionLifecycleProjectionEvent,
): SessionTreeProjection | null {
  if (event.eventType === "SessionStarted") {
    if (event.parentSessionId !== null) return integrity();
    return null;
  }
  const parentSessionId = event.parentSessionId;
  if (parentSessionId === null || parentSessionId === event.sessionId) return integrity();
  const parent = tree.get(parentSessionId);
  if (parent === undefined || parent.lifecycleState !== "open") return integrity();
  const root = tree.get(parent.rootSessionId);
  if (
    root === undefined
    || root.parentSessionId !== null
    || root.lifecycleState !== "open"
    || event.ownerGeneration !== root.ownerGeneration
  ) return integrity();
  return parent;
}

function foldLifecycle(state: ProjectionFoldState, event: SessionLifecycleProjectionEvent): ProjectionFoldState {
  const current = state.sessionTree.find((row) => row.sessionId === event.sessionId);
  if (event.eventType === "SessionStarted" || event.eventType === "SessionForked") {
    if (current !== undefined || event.sourceStreamVersion !== 1n || event.ownerGeneration === null) return integrity();
    const tree = new Map(state.sessionTree.map((row) => [row.sessionId, row] as const));
    const parent = openingParent(tree, event);
    const row: SessionTreeProjection = Object.freeze({
      projectId: event.binding.projectId, sessionId: event.sessionId,
      rootSessionId: parent === null ? event.sessionId : parent.rootSessionId,
      parentSessionId: event.parentSessionId, lifecycleState: "open", ownerGeneration: event.ownerGeneration,
      openedEventPosition: event.sourceEventPosition, closedEventPosition: null,
      latestCheckpointId: null, latestCheckpointEventPosition: null,
      sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      latestStreamVersion: event.sourceStreamVersion, anchor: null,
    });
    return Object.freeze({ ...state, sessionTree: frozen([...state.sessionTree, row]) });
  }
  if (
    current === undefined || current.lifecycleState !== "open"
    || current.parentSessionId !== event.parentSessionId
    || event.sourceStreamVersion !== current.latestStreamVersion + 1n
  ) return integrity();
  if (
    (event.eventType === "SessionOwnerTransferred" || event.eventType === "SessionOwnershipRecovered")
    && (
      current.parentSessionId !== null || event.ownerGeneration === null
      || event.previousOwnerGeneration !== current.ownerGeneration
      || event.ownerGeneration !== current.ownerGeneration + 1
    )
  ) return integrity();
  const terminal = TERMINAL_LIFECYCLE_EVENTS.has(event.eventType);
  if (
    terminal
    && state.sessionTree.some((row) => (
      row.parentSessionId === current.sessionId && row.lifecycleState === "open"
    ))
  ) return integrity();
  const row: SessionTreeProjection = Object.freeze({
    ...current,
    lifecycleState: terminal ? "closed" : "open",
    ownerGeneration: event.ownerGeneration ?? current.ownerGeneration,
    closedEventPosition: terminal ? event.sourceEventPosition : null,
    sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
    latestStreamVersion: event.sourceStreamVersion,
  });
  return Object.freeze({ ...state, sessionTree: replace(state.sessionTree, (candidate) => candidate.sessionId, row) });
}

function foldCheckpoint(state: ProjectionFoldState, event: CheckpointProjectionEvent): ProjectionFoldState {
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return integrity();
  const session = state.sessionTree.find((row) => row.sessionId === sessionId);
  if (
    session === undefined || session.lifecycleState !== "open"
    || event.sourceStreamVersion !== session.latestStreamVersion + 1n
    || event.baseEventPosition < session.openedEventPosition
    || event.baseEventPosition >= event.sourceEventPosition
    || state.sessionCheckpoints.some((row) => row.checkpointId === event.checkpointId)
  ) return integrity();
  const checkpoint: SessionCheckpointProjection = Object.freeze({
    projectId: event.binding.projectId, sessionId, checkpointId: event.checkpointId,
    checkpointVersion: event.checkpointVersion, baseEventPosition: event.baseEventPosition,
    sourceEventPosition: event.sourceEventPosition, occurredAt: event.occurredAt, taskSummary: event.taskSummary,
    sourceEventId: event.sourceEventId, anchor: null,
  });
  const updatedSession: SessionTreeProjection = Object.freeze({
    ...session, latestCheckpointId: event.checkpointId,
    latestCheckpointEventPosition: event.sourceEventPosition, latestStreamVersion: event.sourceStreamVersion,
  });
  return Object.freeze({
    ...state,
    sessionTree: replace(state.sessionTree, (row) => row.sessionId, updatedSession),
    sessionCheckpoints: frozen([...state.sessionCheckpoints, checkpoint]),
    followUps: frozen([...state.followUps, ...checkpointFollowUps(event)]),
    artifacts: frozen([...state.artifacts, ...checkpointArtifacts(event)]),
    lexicalChunks: frozen([
      ...state.lexicalChunks.filter((row) => row.sessionId !== sessionId || row.itemId !== null),
      ...checkpointChunks(event),
    ]),
  });
}

function foldMemory(state: ProjectionFoldState, event: MemorySourceProjectionEvent): ProjectionFoldState {
  const current = state.canonicalItems.find((row) => row.itemId === event.itemId);
  itemTransition(current, event);
  const item: CanonicalItemProjection = Object.freeze({
    projectId: event.binding.projectId, sessionId: event.binding.sessionId, itemId: event.itemId,
    normalizedKey: event.normalizedKey, status: event.status, confidence: event.confidence,
    verificationMethod: event.verificationMethod, validFrom: event.validFrom, validTo: event.validTo,
    summary: event.summary, contentHash: event.contentHash, conflictGroupId: event.conflictGroupId,
    supersedingItemId: event.supersedingItemId,
    knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
    sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition, anchor: null,
  });
  const chunk: LexicalChunkProjection = Object.freeze({
    projectId: event.binding.projectId, chunkId: `item/${event.itemId}`, itemId: event.itemId,
    sessionId: event.binding.sessionId, section: "canonical-item", normalizedKey: event.normalizedKey,
    text: event.summary, sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
    anchor: null,
  });
  return Object.freeze({
    ...state,
    canonicalItems: replace(state.canonicalItems, (row) => row.itemId, item),
    lexicalChunks: replace(state.lexicalChunks, (row) => row.chunkId, chunk),
  });
}

function foldGoverned(state: ProjectionFoldState, event: GovernedMemorySourceProjectionEvent): ProjectionFoldState {
  const current = state.canonicalItems.find((row) => row.itemId === event.item.itemId);
  itemTransition(current, event);
  const sessionId = event.binding.sessionId;
  if ((event.followUps.length > 0 || event.artifacts.length > 0) && sessionId === null) return integrity();
  const nodes = event.entities.reduce<readonly EntityNodeProjection[]>((result, source) => replace(
    result, (row) => row.entityId,
    Object.freeze({ projectId: event.binding.projectId, ...source, sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition }),
  ), state.entityNodes);
  const nodeIds = new Set(nodes.map((row) => row.entityId));
  if (event.aliases.some((row) => !nodeIds.has(row.entityId))) return integrity();
  if (event.edges.some((row) => !nodeIds.has(row.sourceEntityId) || !nodeIds.has(row.targetEntityId))) return integrity();
  const item: CanonicalItemProjection = Object.freeze({
    projectId: event.binding.projectId, sessionId, ...event.item,
    knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
    sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
  });
  const chunk: LexicalChunkProjection = Object.freeze({
    projectId: event.binding.projectId, chunkId: `item/${event.item.itemId}`, itemId: event.item.itemId,
    sessionId, section: "canonical-item", normalizedKey: event.item.normalizedKey, text: event.item.summary,
    sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition, anchor: event.item.anchor,
  });
  const followUps = event.followUps.reduce<readonly FollowUpProjection[]>((result, source) => replace(
    result, (row) => row.followUpId,
    Object.freeze({ projectId: event.binding.projectId, sessionId: sessionId as string, ...source, sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition }),
  ), state.followUps);
  const artifacts = event.artifacts.reduce<readonly ArtifactProjection[]>((result, source) => replace(
    result, (row) => `${row.sessionId}\u0000${row.artifactId}`,
    Object.freeze({ projectId: event.binding.projectId, sessionId: sessionId as string, ...source, sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition }),
  ), state.artifacts);
  const aliases = event.aliases.reduce<readonly EntityAliasProjection[]>((result, source) => replace(
    result, (row) => row.aliasId,
    Object.freeze({ projectId: event.binding.projectId, ...source, sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition }),
  ), state.entityAliases);
  const edges = event.edges.reduce<readonly EntityEdgeProjection[]>((result, source) => replace(
    result, (row) => row.edgeId,
    Object.freeze({ projectId: event.binding.projectId, ...source, sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition }),
  ), state.entityEdges);
  return Object.freeze({
    ...state,
    canonicalItems: replace(state.canonicalItems, (row) => row.itemId, item),
    lexicalChunks: replace(state.lexicalChunks, (row) => row.chunkId, chunk),
    followUps, artifacts, entityNodes: nodes, entityAliases: aliases, entityEdges: edges,
  });
}

function foldFeedback(state: ProjectionFoldState, event: Extract<ProjectionEvent, { kind: "retrieval-feedback" }>): ProjectionFoldState {
  const item = state.canonicalItems.find((row) => row.itemId === event.itemId);
  if (
    item === undefined || event.sourceItemEventPosition < item.knownFromEventPosition
    || item.sourceEventPosition < event.sourceItemEventPosition
    || state.retrievalFeedback.some((row) => row.feedbackId === event.feedbackId)
  ) return integrity();
  const feedback: RetrievalFeedbackProjection = Object.freeze({
    projectId: event.binding.projectId, feedbackId: event.feedbackId, itemId: event.itemId,
    outcome: event.outcome, usefulness: event.usefulness, sourceItemEventPosition: event.sourceItemEventPosition,
    sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition, anchor: null,
  });
  return Object.freeze({ ...state, retrievalFeedback: frozen([...state.retrievalFeedback, feedback]) });
}

function advanceMaterialEventStream(state: ProjectionFoldState, event: ProjectionEvent): ProjectionFoldState {
  if (event.kind === "session-lifecycle" || event.kind === "checkpoint") return state;
  const sessionId = event.binding.sessionId;
  if (sessionId === null) return state;
  const session = state.sessionTree.find((row) => row.sessionId === sessionId);
  // Legacy memory streams may predate lifecycle topology. Once a topology row
  // exists, every projected event on that session consumes its next version.
  if (session === undefined) return state;
  if (
    session.lifecycleState !== "open"
    || event.sourceStreamVersion !== session.latestStreamVersion + 1n
  ) return integrity();
  return Object.freeze({
    ...state,
    sessionTree: replace(state.sessionTree, (row) => row.sessionId, Object.freeze({
      ...session,
      latestStreamVersion: event.sourceStreamVersion,
    })),
  });
}

function apply(state: ProjectionFoldState, event: ProjectionEvent): ProjectionFoldState {
  const scope = state.binding ?? event.binding;
  if (state.binding !== null && !sameScope(state.binding, event.binding)) return integrity();
  if (state.terminalEventPosition !== null && event.sourceEventPosition <= state.terminalEventPosition) return integrity();
  const scoped = advanceMaterialEventStream(Object.freeze({ ...state, binding: scope }), event);
  const folded = event.kind === "session-lifecycle" ? foldLifecycle(scoped, event)
    : event.kind === "checkpoint" ? foldCheckpoint(scoped, event)
      : event.kind === "memory-source" ? foldMemory(scoped, event)
        : event.kind === "governed-memory-source" ? foldGoverned(scoped, event)
          : foldFeedback(scoped, event);
  return Object.freeze({ ...folded, terminalEventPosition: event.sourceEventPosition });
}

export function foldProjectionEvent(state: ProjectionFoldState, event: ProjectionEvent): ProjectionFoldState {
  try {
    return validateState(apply(validateState(state), validateProjectionEvent(event)));
  } catch (error) {
    if (error instanceof Error && error.message === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

class ProjectionFoldAccumulatorCore {
  #binding: ProjectBinding | null = null;
  #terminalEventPosition: bigint | null = null;
  readonly #sessionTree = new Map<string, SessionTreeProjection>();
  readonly #openChildCounts = new Map<string, number>();
  readonly #sessionCheckpoints: SessionCheckpointProjection[] = [];
  readonly #checkpointIds = new Set<string>();
  readonly #canonicalItems = new Map<string, CanonicalItemProjection>();
  readonly #normalizedKeyOwners = new Map<string, string>();
  readonly #followUps = new Map<string, FollowUpProjection>();
  readonly #artifacts = new Map<string, ArtifactProjection>();
  readonly #entityNodes = new Map<string, EntityNodeProjection>();
  readonly #entityAliases = new Map<string, EntityAliasProjection>();
  readonly #entityEdges = new Map<string, EntityEdgeProjection>();
  readonly #lexicalChunks = new Map<string, LexicalChunkProjection>();
  readonly #checkpointChunks = new Map<string, Set<string>>();
  readonly #retrievalFeedback = new Map<string, RetrievalFeedbackProjection>();

  append(event: ProjectionEventV3, independentGovernedStream = false): void {
    if (this.#binding !== null && !sameScope(this.#binding, event.binding)) return integrity();
    if (this.#terminalEventPosition !== null && event.sourceEventPosition <= this.#terminalEventPosition) {
      return integrity();
    }
    this.#binding ??= event.binding;
    if (event.kind !== "session-lifecycle" && event.kind !== "checkpoint") {
      if (independentGovernedStream) {
        if (event.kind !== "governed-memory-source") return integrity();
        const session = event.binding.sessionId === null ? undefined : this.#sessionTree.get(event.binding.sessionId);
        // The authenticated note pair owns its own stream; it cannot advance lifecycle versions.
        if (session !== undefined && session.lifecycleState !== "open") return integrity();
      } else this.#advanceMaterialEventStream(event);
    }
    if (event.kind === "session-lifecycle") this.#appendLifecycle(event);
    else if (event.kind === "checkpoint") this.#appendCheckpoint(event);
    else if (event.kind === "memory-source") this.#appendMemory(event);
    else if (event.kind === "governed-memory-source") this.#appendGoverned(event);
    else this.#appendFeedback(event);
    this.#terminalEventPosition = event.sourceEventPosition;
  }

  finish(): ProjectionFoldState {
    return validateState(Object.freeze({
      schemaVersion: 2,
      binding: this.#binding,
      terminalEventPosition: this.#terminalEventPosition,
      sessionTree: Object.freeze([...this.#sessionTree.values()]),
      sessionCheckpoints: Object.freeze([...this.#sessionCheckpoints]),
      canonicalItems: Object.freeze([...this.#canonicalItems.values()]),
      followUps: Object.freeze([...this.#followUps.values()]),
      artifacts: Object.freeze([...this.#artifacts.values()]),
      entityNodes: Object.freeze([...this.#entityNodes.values()]),
      entityAliases: Object.freeze([...this.#entityAliases.values()]),
      entityEdges: Object.freeze([...this.#entityEdges.values()]),
      lexicalChunks: Object.freeze([...this.#lexicalChunks.values()]),
      retrievalFeedback: Object.freeze([...this.#retrievalFeedback.values()]),
    }));
  }

  #room(size: number, replacing: boolean): void {
    if (!replacing && size >= MAX_ROWS) return integrity();
  }

  #advanceMaterialEventStream(event: Exclude<ProjectionEventV3, SessionLifecycleProjectionEvent | CheckpointProjectionEvent>): void {
    const sessionId = event.binding.sessionId;
    if (sessionId === null) return;
    const session = this.#sessionTree.get(sessionId);
    if (session === undefined) return;
    if (
      session.lifecycleState !== "open"
      || event.sourceStreamVersion !== session.latestStreamVersion + 1n
    ) return integrity();
    this.#sessionTree.set(sessionId, Object.freeze({
      ...session,
      latestStreamVersion: event.sourceStreamVersion,
    }));
  }

  #appendLifecycle(event: SessionLifecycleProjectionEvent): void {
    const current = this.#sessionTree.get(event.sessionId);
    if (event.eventType === "SessionStarted" || event.eventType === "SessionForked") {
      if (current !== undefined || event.sourceStreamVersion !== 1n || event.ownerGeneration === null) return integrity();
      const parent = openingParent(this.#sessionTree, event);
      this.#room(this.#sessionTree.size, false);
      this.#sessionTree.set(event.sessionId, Object.freeze({
        projectId: event.binding.projectId, sessionId: event.sessionId,
        rootSessionId: parent === null ? event.sessionId : parent.rootSessionId,
        parentSessionId: event.parentSessionId, lifecycleState: "open", ownerGeneration: event.ownerGeneration,
        openedEventPosition: event.sourceEventPosition, closedEventPosition: null,
        latestCheckpointId: null, latestCheckpointEventPosition: null,
        sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
        latestStreamVersion: event.sourceStreamVersion, anchor: null,
      }));
      this.#openChildCounts.set(event.sessionId, 0);
      if (parent !== null) {
        this.#openChildCounts.set(
          parent.sessionId,
          (this.#openChildCounts.get(parent.sessionId) ?? 0) + 1,
        );
      }
      return;
    }
    if (
      current === undefined || current.lifecycleState !== "open"
      || current.parentSessionId !== event.parentSessionId
      || event.sourceStreamVersion !== current.latestStreamVersion + 1n
    ) return integrity();
    if (
      (event.eventType === "SessionOwnerTransferred" || event.eventType === "SessionOwnershipRecovered")
      && (
        current.parentSessionId !== null || event.ownerGeneration === null
        || event.previousOwnerGeneration !== current.ownerGeneration
        || event.ownerGeneration !== current.ownerGeneration + 1
      )
    ) return integrity();
    const terminal = TERMINAL_LIFECYCLE_EVENTS.has(event.eventType);
    if (terminal && (this.#openChildCounts.get(current.sessionId) ?? 0) !== 0) return integrity();
    if (terminal && current.parentSessionId !== null) {
      const parentOpenChildren = this.#openChildCounts.get(current.parentSessionId);
      if (parentOpenChildren === undefined || parentOpenChildren < 1) return integrity();
      this.#openChildCounts.set(current.parentSessionId, parentOpenChildren - 1);
    }
    this.#sessionTree.set(event.sessionId, Object.freeze({
      ...current,
      lifecycleState: terminal ? "closed" : "open",
      ownerGeneration: event.ownerGeneration ?? current.ownerGeneration,
      closedEventPosition: terminal ? event.sourceEventPosition : null,
      sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      latestStreamVersion: event.sourceStreamVersion,
    }));
  }

  #appendCheckpoint(event: CheckpointProjectionEvent): void {
    const sessionId = event.binding.sessionId;
    if (sessionId === null) return integrity();
    const session = this.#sessionTree.get(sessionId);
    if (
      session === undefined || session.lifecycleState !== "open"
      || event.sourceStreamVersion !== session.latestStreamVersion + 1n
      || event.baseEventPosition < session.openedEventPosition
      || event.baseEventPosition >= event.sourceEventPosition
      || this.#checkpointIds.has(event.checkpointId)
      || this.#sessionCheckpoints.length >= MAX_ROWS
    ) return integrity();
    this.#sessionCheckpoints.push(Object.freeze({
      projectId: event.binding.projectId, sessionId, checkpointId: event.checkpointId,
      checkpointVersion: event.checkpointVersion, baseEventPosition: event.baseEventPosition,
      sourceEventPosition: event.sourceEventPosition, occurredAt: event.occurredAt,
      taskSummary: event.taskSummary, sourceEventId: event.sourceEventId, anchor: null,
    }));
    this.#checkpointIds.add(event.checkpointId);
    this.#sessionTree.set(sessionId, Object.freeze({
      ...session, latestCheckpointId: event.checkpointId,
      latestCheckpointEventPosition: event.sourceEventPosition,
      latestStreamVersion: event.sourceStreamVersion,
    }));
    for (const row of checkpointFollowUps(event)) {
      if (this.#followUps.has(row.followUpId)) return integrity();
      this.#room(this.#followUps.size, false);
      this.#followUps.set(row.followUpId, row);
    }
    for (const row of checkpointArtifacts(event)) {
      const key = `${row.sessionId}\u0000${row.artifactId}`;
      if (this.#artifacts.has(key)) return integrity();
      this.#room(this.#artifacts.size, false);
      this.#artifacts.set(key, row);
    }
    for (const key of this.#checkpointChunks.get(sessionId) ?? []) this.#lexicalChunks.delete(key);
    const chunkKeys = new Set<string>();
    for (const row of checkpointChunks(event)) {
      if (this.#lexicalChunks.has(row.chunkId)) return integrity();
      this.#room(this.#lexicalChunks.size, false);
      this.#lexicalChunks.set(row.chunkId, row);
      chunkKeys.add(row.chunkId);
    }
    this.#checkpointChunks.set(sessionId, chunkKeys);
  }

  #appendMemory(event: MemorySourceProjectionEvent): void {
    const current = this.#canonicalItems.get(event.itemId);
    itemTransition(current, event);
    const owner = this.#normalizedKeyOwners.get(event.normalizedKey);
    if (owner !== undefined && owner !== event.itemId) return integrity();
    this.#room(this.#canonicalItems.size, current !== undefined);
    this.#canonicalItems.set(event.itemId, Object.freeze({
      projectId: event.binding.projectId, sessionId: event.binding.sessionId, itemId: event.itemId,
      normalizedKey: event.normalizedKey, status: event.status, confidence: event.confidence,
      verificationMethod: event.verificationMethod, validFrom: event.validFrom, validTo: event.validTo,
      summary: event.summary, contentHash: event.contentHash, conflictGroupId: event.conflictGroupId,
      supersedingItemId: event.supersedingItemId,
      knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
      sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition, anchor: null,
    }));
    this.#normalizedKeyOwners.set(event.normalizedKey, event.itemId);
    const chunkId = `item/${event.itemId}`;
    this.#room(this.#lexicalChunks.size, this.#lexicalChunks.has(chunkId));
    this.#lexicalChunks.set(chunkId, Object.freeze({
      projectId: event.binding.projectId, chunkId, itemId: event.itemId,
      sessionId: event.binding.sessionId, section: "canonical-item", normalizedKey: event.normalizedKey,
      text: event.summary, sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition, anchor: null,
    }));
  }

  #appendGoverned(event: GovernedMemorySourceProjectionEvent | GovernedMemorySourceProjectionEventV3): void {
    const current = this.#canonicalItems.get(event.item.itemId);
    itemTransition(current, event);
    const owner = this.#normalizedKeyOwners.get(event.item.normalizedKey);
    if (owner !== undefined && owner !== event.item.itemId) return integrity();
    const sessionId = event.binding.sessionId;
    if ((event.followUps.length > 0 || event.artifacts.length > 0) && sessionId === null) return integrity();
    for (const source of event.entities) {
      this.#room(this.#entityNodes.size, this.#entityNodes.has(source.entityId));
      this.#entityNodes.set(source.entityId, Object.freeze({
        projectId: event.binding.projectId, ...source,
        sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      }));
    }
    for (const source of event.aliases) {
      if (!this.#entityNodes.has(source.entityId)) return integrity();
      this.#room(this.#entityAliases.size, this.#entityAliases.has(source.aliasId));
      this.#entityAliases.set(source.aliasId, Object.freeze({
        projectId: event.binding.projectId, ...source,
        sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      }));
    }
    for (const source of event.edges) {
      if (!this.#entityNodes.has(source.sourceEntityId) || !this.#entityNodes.has(source.targetEntityId)) return integrity();
      this.#room(this.#entityEdges.size, this.#entityEdges.has(source.edgeId));
      this.#entityEdges.set(source.edgeId, Object.freeze({
        projectId: event.binding.projectId, ...source,
        sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      }));
    }
    this.#room(this.#canonicalItems.size, current !== undefined);
    this.#canonicalItems.set(event.item.itemId, Object.freeze({
      projectId: event.binding.projectId, sessionId, ...event.item,
      knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
      sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
    }));
    this.#normalizedKeyOwners.set(event.item.normalizedKey, event.item.itemId);
    for (const source of event.followUps) {
      this.#room(this.#followUps.size, this.#followUps.has(source.followUpId));
      this.#followUps.set(source.followUpId, Object.freeze({
        projectId: event.binding.projectId, sessionId: sessionId as string, ...source,
        sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      }));
    }
    for (const source of event.artifacts) {
      const key = `${String(sessionId)}\u0000${source.artifactId}`;
      this.#room(this.#artifacts.size, this.#artifacts.has(key));
      this.#artifacts.set(key, Object.freeze({
        projectId: event.binding.projectId, sessionId: sessionId as string, ...source,
        sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      }));
    }
    const chunkId = `item/${event.item.itemId}`;
    this.#room(this.#lexicalChunks.size, this.#lexicalChunks.has(chunkId));
    this.#lexicalChunks.set(chunkId, Object.freeze({
      projectId: event.binding.projectId, chunkId, itemId: event.item.itemId, sessionId,
      section: "canonical-item", normalizedKey: event.item.normalizedKey, text: event.item.summary,
      sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition,
      anchor: event.item.anchor,
    }));
  }

  #appendFeedback(event: Extract<ProjectionEvent, { kind: "retrieval-feedback" }>): void {
    const item = this.#canonicalItems.get(event.itemId);
    if (
      item === undefined || event.sourceItemEventPosition < item.knownFromEventPosition
      || item.sourceEventPosition < event.sourceItemEventPosition
      || this.#retrievalFeedback.has(event.feedbackId)
    ) return integrity();
    this.#room(this.#retrievalFeedback.size, false);
    this.#retrievalFeedback.set(event.feedbackId, Object.freeze({
      projectId: event.binding.projectId, feedbackId: event.feedbackId, itemId: event.itemId,
      outcome: event.outcome, usefulness: event.usefulness,
      sourceItemEventPosition: event.sourceItemEventPosition,
      sourceEventId: event.sourceEventId, sourceEventPosition: event.sourceEventPosition, anchor: null,
    }));
  }
}

/**
 * The production coordinator still publishes schema V1 during Task 3. Keep its
 * historical latest-checkpoint fold semantics isolated from the schema V2
 * accumulator until the explicit adoption task switches that boundary.
 */
export interface LegacyProjectionFoldState {
  readonly binding: ProjectBinding | null;
  readonly terminalEventPosition: bigint | null;
  readonly sessionCheckpoints: readonly SessionCheckpointProjection[];
  readonly canonicalItems: readonly CanonicalItemProjection[];
  readonly followUps: readonly FollowUpProjection[];
  readonly artifacts: readonly ArtifactProjection[];
  readonly lexicalChunks: readonly LexicalChunkProjection[];
  readonly retrievalFeedback: readonly RetrievalFeedbackProjection[];
}

type LegacyProjectionEvent =
  | CheckpointProjectionEvent
  | MemorySourceProjectionEvent
  | Extract<ProjectionEvent, { kind: "retrieval-feedback" }>;

export class LegacyProjectionFoldAccumulator {
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

  append(value: LegacyProjectionEvent): void {
    const event = validateProjectionEvent(value);
    if (event.kind === "session-lifecycle" || event.kind === "governed-memory-source") {
      return integrity();
    }
    if (this.#binding !== null && !sameScope(this.#binding, event.binding)) return integrity();
    if (this.#terminalEventPosition !== null && event.sourceEventPosition <= this.#terminalEventPosition) {
      return integrity();
    }
    this.#binding ??= event.binding;
    if (event.kind === "checkpoint") this.#appendCheckpoint(event);
    else if (event.kind === "memory-source") this.#appendMemory(event);
    else this.#appendFeedback(event);
    this.#terminalEventPosition = event.sourceEventPosition;
  }

  finish(): LegacyProjectionFoldState {
    return Object.freeze({
      binding: this.#binding,
      terminalEventPosition: this.#terminalEventPosition,
      sessionCheckpoints: Object.freeze([...this.#sessionCheckpoints.values()]),
      canonicalItems: Object.freeze([...this.#canonicalItems.values()]),
      followUps: Object.freeze([...this.#followUps.values()]),
      artifacts: Object.freeze([...this.#artifacts.values()]),
      lexicalChunks: Object.freeze([...this.#lexicalChunks.values()]),
      retrievalFeedback: Object.freeze([...this.#retrievalFeedback.values()]),
    });
  }

  #room(size: number, replacing: boolean): void {
    if (!replacing && size >= MAX_ROWS) return integrity();
  }

  #deleteSessionRows<T>(sessionId: string, keys: Map<string, Set<string>>, values: Map<string, T>): void {
    for (const key of keys.get(sessionId) ?? []) values.delete(key);
    keys.delete(sessionId);
  }

  #appendCheckpoint(event: CheckpointProjectionEvent): void {
    const sessionId = event.binding.sessionId;
    if (sessionId === null) return integrity();
    const prior = this.#sessionCheckpoints.get(sessionId);
    const checkpointOwner = this.#checkpointOwners.get(event.checkpointId);
    if (checkpointOwner !== undefined && checkpointOwner !== sessionId) return integrity();
    this.#room(this.#sessionCheckpoints.size, prior !== undefined);
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
      sourceEventId: event.sourceEventId,
      anchor: null,
    }));
    this.#checkpointOwners.set(event.checkpointId, sessionId);

    this.#deleteSessionRows(sessionId, this.#sessionFollowUps, this.#followUps);
    const followUps = checkpointFollowUps(event);
    if (this.#followUps.size + followUps.length > MAX_ROWS) return integrity();
    const followUpKeys = new Set<string>();
    for (const row of followUps) {
      if (this.#followUps.has(row.followUpId)) return integrity();
      this.#followUps.set(row.followUpId, row);
      followUpKeys.add(row.followUpId);
    }
    this.#sessionFollowUps.set(sessionId, followUpKeys);

    this.#deleteSessionRows(sessionId, this.#sessionArtifacts, this.#artifacts);
    const artifacts = checkpointArtifacts(event);
    if (this.#artifacts.size + artifacts.length > MAX_ROWS) return integrity();
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
    if (this.#lexicalChunks.size + chunks.length > MAX_ROWS) return integrity();
    const chunkKeys = new Set<string>();
    for (const row of chunks) {
      if (this.#lexicalChunks.has(row.chunkId)) return integrity();
      this.#lexicalChunks.set(row.chunkId, row);
      chunkKeys.add(row.chunkId);
    }
    this.#sessionChunks.set(sessionId, chunkKeys);
  }

  #appendMemory(event: MemorySourceProjectionEvent): void {
    const current = this.#canonicalItems.get(event.itemId);
    itemTransition(current, event);
    const normalizedKeyOwner = this.#normalizedKeyOwners.get(event.normalizedKey);
    if (normalizedKeyOwner !== undefined && normalizedKeyOwner !== event.itemId) return integrity();
    this.#room(this.#canonicalItems.size, current !== undefined);
    this.#canonicalItems.set(event.itemId, Object.freeze({
      projectId: event.binding.projectId,
      sessionId: event.binding.sessionId,
      itemId: event.itemId,
      normalizedKey: event.normalizedKey,
      status: event.status,
      confidence: event.confidence,
      verificationMethod: event.verificationMethod,
      validFrom: event.validFrom,
      validTo: event.validTo,
      summary: event.summary,
      contentHash: event.contentHash,
      conflictGroupId: event.conflictGroupId,
      supersedingItemId: event.supersedingItemId,
      knownFromEventPosition: current?.knownFromEventPosition ?? event.sourceEventPosition,
      sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition,
      anchor: null,
    }));
    this.#normalizedKeyOwners.set(event.normalizedKey, event.itemId);
    const chunkId = `item/${event.itemId}`;
    this.#room(this.#lexicalChunks.size, this.#lexicalChunks.has(chunkId));
    this.#lexicalChunks.set(chunkId, Object.freeze({
      projectId: event.binding.projectId,
      chunkId,
      itemId: event.itemId,
      sessionId: event.binding.sessionId,
      section: "canonical-item",
      normalizedKey: event.normalizedKey,
      text: event.summary,
      sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition,
      anchor: null,
    }));
  }

  #appendFeedback(event: Extract<ProjectionEvent, { kind: "retrieval-feedback" }>): void {
    const item = this.#canonicalItems.get(event.itemId);
    if (
      item === undefined
      || event.sourceItemEventPosition < item.knownFromEventPosition
      || item.sourceEventPosition < event.sourceItemEventPosition
      || this.#retrievalFeedback.has(event.feedbackId)
    ) return integrity();
    this.#room(this.#retrievalFeedback.size, false);
    this.#retrievalFeedback.set(event.feedbackId, Object.freeze({
      projectId: event.binding.projectId,
      feedbackId: event.feedbackId,
      itemId: event.itemId,
      outcome: event.outcome,
      usefulness: event.usefulness,
      sourceItemEventPosition: event.sourceItemEventPosition,
      sourceEventId: event.sourceEventId,
      sourceEventPosition: event.sourceEventPosition,
      anchor: null,
    }));
  }
}

/** Historical callers retain the exact schema2 event validator. */
export class ProjectionFoldAccumulator extends ProjectionFoldAccumulatorCore {
  override append(value: ProjectionEvent): void { super.append(validateProjectionEvent(value)); }
}

export class ProjectionFoldAccumulatorV3 {
  readonly #core = new ProjectionFoldAccumulatorCore();
  readonly #governedNotes = new Map<string, GovernedNoteProjectionRowV1>();
  #lastSourcePosition: bigint | null = null;
  #binding: ProjectBinding | null = null;

  append(source: ProjectionSourceDisposition): void {
    const decoded = decodeProjectionSourceV3(source);
    if (this.#lastSourcePosition !== null && decoded.sourceEventPosition <= this.#lastSourcePosition) return integrity();
    if (this.#binding !== null && !sameScope(this.#binding, decoded.binding)) return integrity();
    const row = decoded.governedNote;
    const key = row === null ? null : `${row.projectId}\0${row.itemId}`;
    if (key !== null && (this.#governedNotes.has(key) || this.#governedNotes.size >= MAX_ROWS)) return integrity();
    if (decoded.event !== null) this.#core.append(decoded.event, row !== null);
    if (key !== null && row !== null) this.#governedNotes.set(key, row);
    this.#binding ??= decoded.binding;
    this.#lastSourcePosition = decoded.sourceEventPosition;
  }

  finish(): ProjectionFoldStateV3 {
    const rich = this.#core.finish();
    const governedNotes = validateGovernedNoteProjectionRows(rich.canonicalItems, [...this.#governedNotes.values()], rich.terminalEventPosition);
    return Object.freeze({...rich, schemaVersion:3, governedNotes});
  }
}
