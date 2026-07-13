import type {
  AppendCommand,
  AppendResult,
  JsonValue,
  PendingEvent,
  PendingOutbox,
} from "../contracts/event.js";
import type {
  BranchScopeId,
  ProjectContext,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "../identity/contracts.js";
import { computeProjectContextFingerprint } from "../identity/project-binding.service.js";
import type { ProjectBindingSource, TrustedActorRole } from "../identity/project-binding.request.js";
import {
  INTEGRITY_ISSUE_CODES,
  type IntegrityIssue,
  type IntegrityMode,
  type IntegrityReport,
} from "../integrity/integrity.types.js";
import type { MaintenanceLease } from "../storage/maintenance-fence.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;
const HASH = /^[0-9a-f]{64}$/;
const SOURCES = new Set<ProjectBindingSource>([
  "stdio-explicit-root",
  "mcp-roots",
  "trusted-ide-adapter",
  "explicit-cli",
]);
const ACTOR_ROLES = new Set<TrustedActorRole>(["primary", "maintenance", "untrusted"]);
const VISIBILITY = new Set(["session", "workspace", "branch", "project"] as const);
const CONFIDENCE = new Set(["high", "medium", "low", "guess"] as const);
const VERIFICATION = new Set(["unverified", "provisional", "verified", "conflicted"] as const);
const INTEGRITY_MODES = new Set<IntegrityMode>(["quick", "full", "range"]);
const INTEGRITY_CODES = new Set<string>(INTEGRITY_ISSUE_CODES);

export class WorkerProtocolError extends Error {
  readonly code = "WORKER_PROTOCOL_INVALID";

  constructor() {
    super("WORKER_PROTOCOL_INVALID");
    this.name = "WorkerProtocolError";
  }
}

function invalid(): never {
  throw new WorkerProtocolError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const observed = record(value);
  const actual = Object.keys(observed).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return observed;
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) invalid();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid();
  return Number(value);
}

function positiveInteger(value: unknown): number {
  return safeInteger(value, 1);
}

function decimal(value: unknown, minimum = 0n): bigint {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) invalid();
  const decoded = BigInt(value);
  if (decoded < minimum || decoded > SQLITE_INT64_MAX) invalid();
  return decoded;
}

function decimalWire(value: bigint, minimum = 0n): string {
  if (typeof value !== "bigint" || value < minimum || value > SQLITE_INT64_MAX) invalid();
  return value.toString(10);
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (Array.isArray(value)) return array(value).map((item) => json(item));
  const source = record(value);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(source)) result[key] = json(item);
  return result;
}

function stringArray(value: unknown): string[] {
  return array(value).map((item) => string(item, true));
}

function emptyArray(value: unknown): [] {
  if (array(value).length !== 0) invalid();
  return [];
}

export interface ProjectStoreRouteWire {
  kind: "git-common" | "vault-local";
  storeRoot: string;
  eventsPath: string;
  storeManifestPath: string;
  projectionManifestPath: string;
}

export interface StoreIdentityWire {
  projectId: string;
  vaultId: string;
  storeId: string;
}

export interface StoreIdentityExpectationWire {
  projectId: string;
  vaultId: string;
}

export type WorkspaceSnapshotWire =
  | {
      kind: "git";
      worktreeRoot: string;
      gitDir: string;
      gitCommonDir: string;
      headCommit: string;
      branchRef: string | null;
      detached: boolean;
      workspaceId: string;
    }
  | {
      kind: "non-git";
      workspaceRoot: string;
      workspaceId: string;
    };

export interface WorkerBindingAssertion extends StoreIdentityWire {
  bindingGeneration: number;
  contextFingerprint: string;
}

export interface WorkerBinding extends WorkerBindingAssertion {
  projectBindingId: string;
  source: ProjectBindingSource;
  projectRoot: string;
  vaultRoot: string;
  descriptorPath: string;
  storeRoute: ProjectStoreRouteWire;
  workspaceId: string;
  workspace: WorkspaceSnapshotWire;
  clientNamespace: string;
  clientInstanceId: string;
  actorRole: TrustedActorRole;
  establishedAt: string;
  checkedAt: string;
  branchScopeId: string | null;
}

export interface PendingEventWire {
  eventType: string;
  eventSchemaVersion: number;
  occurredAt: string;
  visibilityScope: "session" | "workspace" | "branch" | "project";
  sessionId: string | null;
  parentSessionId: string | null;
  causationId: string | null;
  confidence: "high" | "medium" | "low" | "guess";
  verificationStatus: "unverified" | "provisional" | "verified" | "conflicted";
  payload: JsonValue;
  sourceRefs: string[];
  evidenceRefs: [];
  evidenceDigests: [];
}

export interface PendingOutboxWire {
  targetKey: string;
  kind: string;
  eventIndex: number;
  payload: JsonValue;
}

export interface AppendCommandWire {
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  correlationId: string;
  agentId: string;
  expectedStreamVersion: string;
  streamId: string;
  streamType: string;
  events: PendingEventWire[];
  outbox: PendingOutboxWire[];
  publicResponse: JsonValue;
}

export interface AppendResultWire {
  deduplicated: boolean;
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  finalStreamVersion: string;
  eventIds: string[];
  response: JsonValue;
  responseHash: string;
}

export interface MaintenanceLeaseWire {
  epoch: string;
  fencingToken: string;
  ownerId: string;
  leaseExpiresAt: string;
}

export interface WorkerPingResult {
  nodeVersion: string;
  sqliteVersion: string;
  walSafe: boolean;
}

export interface WorkerOpenResult extends WorkerBindingAssertion {
  executorId: string;
}

export type WorkerRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "verifyIdentity"; route: ProjectStoreRouteWire; expected: StoreIdentityWire }
  | { id: string; type: "inspectExisting"; route: ProjectStoreRouteWire; expected: StoreIdentityExpectationWire }
  | { id: string; type: "open"; binding: WorkerBinding }
  | { id: string; type: "append"; binding: WorkerBindingAssertion; command: AppendCommandWire }
  | { id: string; type: "quickIntegrity"; binding: WorkerBindingAssertion; tailLimit: number }
  | { id: string; type: "fullIntegrity"; binding: WorkerBindingAssertion }
  | { id: string; type: "quiesce"; binding: WorkerBindingAssertion; lease: MaintenanceLeaseWire }
  | { id: string; type: "close" };

export type WorkerSuccessData =
  | WorkerPingResult
  | WorkerOpenResult
  | StoreIdentityWire
  | AppendResultWire
  | IntegrityReport
  | { verified: true }
  | { quiesced: true; epoch: string; connectionClosed: true }
  | { closed: true };

export type WorkerResponse =
  | { id: string; ok: true; data: WorkerSuccessData }
  | { id: string; ok: false; error: { code: string; message: string; details: Record<string, JsonValue> } };

export interface WorkerNotification {
  type: "quiesced";
  executorId: string;
  epoch: string;
  fencingToken: string;
  connectionClosed: true;
}

export type WorkerMessage = WorkerResponse | WorkerNotification;

function decodeRoute(value: unknown): ProjectStoreRouteWire {
  const route = exact(value, ["kind", "storeRoot", "eventsPath", "storeManifestPath", "projectionManifestPath"]);
  if (route.kind !== "git-common" && route.kind !== "vault-local") invalid();
  return {
    kind: route.kind,
    storeRoot: string(route.storeRoot),
    eventsPath: string(route.eventsPath),
    storeManifestPath: string(route.storeManifestPath),
    projectionManifestPath: string(route.projectionManifestPath),
  };
}

function decodeIdentity(value: unknown): StoreIdentityWire {
  const identity = exact(value, ["projectId", "vaultId", "storeId"]);
  return {
    projectId: string(identity.projectId),
    vaultId: string(identity.vaultId),
    storeId: string(identity.storeId),
  };
}

function decodeIdentityExpectation(value: unknown): StoreIdentityExpectationWire {
  const identity = exact(value, ["projectId", "vaultId"]);
  return { projectId: string(identity.projectId), vaultId: string(identity.vaultId) };
}

function decodeWorkspace(value: unknown): WorkspaceSnapshotWire {
  const observed = record(value);
  if (observed.kind === "git") {
    const workspace = exact(value, [
      "kind", "worktreeRoot", "gitDir", "gitCommonDir", "headCommit", "branchRef", "detached", "workspaceId",
    ]);
    return {
      kind: "git",
      worktreeRoot: string(workspace.worktreeRoot),
      gitDir: string(workspace.gitDir),
      gitCommonDir: string(workspace.gitCommonDir),
      headCommit: string(workspace.headCommit),
      branchRef: nullableString(workspace.branchRef),
      detached: boolean(workspace.detached),
      workspaceId: string(workspace.workspaceId),
    };
  }
  if (observed.kind === "non-git") {
    const workspace = exact(value, ["kind", "workspaceRoot", "workspaceId"]);
    return {
      kind: "non-git",
      workspaceRoot: string(workspace.workspaceRoot),
      workspaceId: string(workspace.workspaceId),
    };
  }
  invalid();
}

function decodeAssertion(value: unknown): WorkerBindingAssertion {
  const assertion = exact(value, [
    "projectId", "vaultId", "storeId", "bindingGeneration", "contextFingerprint",
  ]);
  const fingerprint = string(assertion.contextFingerprint);
  if (!HASH.test(fingerprint)) invalid();
  return {
    projectId: string(assertion.projectId),
    vaultId: string(assertion.vaultId),
    storeId: string(assertion.storeId),
    bindingGeneration: positiveInteger(assertion.bindingGeneration),
    contextFingerprint: fingerprint,
  };
}

export function encodeWorkerBindingAssertion(context: ProjectContext): WorkerBindingAssertion {
  return {
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    bindingGeneration: context.binding.generation,
    contextFingerprint: context.binding.contextFingerprint,
  };
}

export function decodeWorkerBindingAssertion(value: unknown): WorkerBindingAssertion {
  return decodeAssertion(value);
}

function encodeWorkspace(workspace: WorkspaceSnapshot): WorkspaceSnapshotWire {
  return workspace.kind === "git"
    ? {
        kind: "git",
        worktreeRoot: workspace.worktreeRoot,
        gitDir: workspace.gitDir,
        gitCommonDir: workspace.gitCommonDir,
        headCommit: workspace.headCommit,
        branchRef: workspace.branchRef,
        detached: workspace.detached,
        workspaceId: workspace.workspaceId,
      }
    : {
        kind: "non-git",
        workspaceRoot: workspace.workspaceRoot,
        workspaceId: workspace.workspaceId,
      };
}

export function encodeWorkerBinding(context: ProjectContext): WorkerBinding {
  const binding = context.binding;
  return {
    ...encodeWorkerBindingAssertion(context),
    projectBindingId: binding.projectBindingId,
    source: binding.source,
    projectRoot: binding.projectRoot,
    vaultRoot: binding.vaultRoot,
    descriptorPath: binding.descriptorPath,
    storeRoute: { ...binding.storeRoute },
    workspaceId: binding.workspaceId,
    workspace: encodeWorkspace(binding.workspace),
    clientNamespace: binding.clientNamespace,
    clientInstanceId: binding.clientInstanceId,
    actorRole: binding.actorRole,
    establishedAt: binding.establishedAt,
    checkedAt: context.checkedAt,
    branchScopeId: context.branchScopeId ?? null,
  };
}

export function decodeWorkerBinding(value: unknown): ProjectContext {
  const wire = exact(value, [
    "projectId", "vaultId", "storeId", "bindingGeneration", "contextFingerprint",
    "projectBindingId", "source", "projectRoot", "vaultRoot", "descriptorPath",
    "storeRoute", "workspaceId", "workspace", "clientNamespace", "clientInstanceId",
    "actorRole", "establishedAt", "checkedAt", "branchScopeId",
  ]);
  const assertion = decodeAssertion({
    projectId: wire.projectId,
    vaultId: wire.vaultId,
    storeId: wire.storeId,
    bindingGeneration: wire.bindingGeneration,
    contextFingerprint: wire.contextFingerprint,
  });
  const source = string(wire.source) as ProjectBindingSource;
  const actorRole = string(wire.actorRole) as TrustedActorRole;
  if (!SOURCES.has(source) || !ACTOR_ROLES.has(actorRole)) invalid();
  const workspace = decodeWorkspace(wire.workspace);
  const workspaceId = string(wire.workspaceId);
  if (workspaceId !== workspace.workspaceId) invalid();
  const storeRoute = decodeRoute(wire.storeRoute);
  const withoutPrivate = {
    generation: assertion.bindingGeneration,
    source,
    projectId: assertion.projectId as ProjectId,
    vaultId: assertion.vaultId as VaultId,
    storeId: assertion.storeId as StoreId,
    workspaceId: workspaceId as WorkspaceId,
    clientNamespace: string(wire.clientNamespace),
    clientInstanceId: string(wire.clientInstanceId),
    actorRole,
    projectRoot: string(wire.projectRoot),
    vaultRoot: string(wire.vaultRoot),
    descriptorPath: string(wire.descriptorPath),
    storeRoute: storeRoute as ProjectStoreRoute,
    workspace: workspace as WorkspaceSnapshot,
  };
  if (computeProjectContextFingerprint(withoutPrivate) !== assertion.contextFingerprint) invalid();
  const branchScope = wire.branchScopeId === null
    ? undefined
    : string(wire.branchScopeId) as BranchScopeId;
  return {
    binding: {
      ...withoutPrivate,
      projectBindingId: string(wire.projectBindingId),
      contextFingerprint: assertion.contextFingerprint,
      establishedAt: string(wire.establishedAt),
    },
    workspace: workspace as WorkspaceSnapshot,
    ...(branchScope === undefined ? {} : { branchScopeId: branchScope }),
    checkedAt: string(wire.checkedAt),
  };
}

function encodeEvent(event: PendingEvent): PendingEventWire {
  if (!VISIBILITY.has(event.visibilityScope as PendingEventWire["visibilityScope"])) invalid();
  if (event.evidenceRefs.length !== 0 || event.evidenceDigests.length !== 0) invalid();
  return {
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    occurredAt: event.occurredAt,
    visibilityScope: event.visibilityScope as PendingEventWire["visibilityScope"],
    sessionId: event.sessionId ?? null,
    parentSessionId: event.parentSessionId ?? null,
    causationId: event.causationId ?? null,
    confidence: event.confidence,
    verificationStatus: event.verificationStatus,
    payload: json(event.payload),
    sourceRefs: [...event.sourceRefs],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function decodeEvent(value: unknown): PendingEvent {
  const event = exact(value, [
    "eventType", "eventSchemaVersion", "occurredAt", "visibilityScope", "sessionId",
    "parentSessionId", "causationId", "confidence", "verificationStatus", "payload",
    "sourceRefs", "evidenceRefs", "evidenceDigests",
  ]);
  if (!VISIBILITY.has(event.visibilityScope as PendingEventWire["visibilityScope"])) invalid();
  if (!CONFIDENCE.has(event.confidence as PendingEventWire["confidence"])) invalid();
  if (!VERIFICATION.has(event.verificationStatus as PendingEventWire["verificationStatus"])) invalid();
  const sessionId = nullableString(event.sessionId);
  const parentSessionId = nullableString(event.parentSessionId);
  const causationId = nullableString(event.causationId);
  emptyArray(event.evidenceRefs);
  emptyArray(event.evidenceDigests);
  return {
    eventType: string(event.eventType),
    eventSchemaVersion: positiveInteger(event.eventSchemaVersion),
    occurredAt: string(event.occurredAt),
    visibilityScope: event.visibilityScope as PendingEventWire["visibilityScope"],
    ...(sessionId === null ? {} : { sessionId }),
    ...(parentSessionId === null ? {} : { parentSessionId }),
    ...(causationId === null ? {} : { causationId }),
    confidence: event.confidence as PendingEventWire["confidence"],
    verificationStatus: event.verificationStatus as PendingEventWire["verificationStatus"],
    payload: json(event.payload),
    sourceRefs: stringArray(event.sourceRefs),
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function encodeOutbox(item: PendingOutbox): PendingOutboxWire {
  return { targetKey: item.targetKey, kind: item.kind, eventIndex: item.eventIndex, payload: json(item.payload) };
}

function decodeOutbox(value: unknown): PendingOutbox {
  const item = exact(value, ["targetKey", "kind", "eventIndex", "payload"]);
  return {
    targetKey: string(item.targetKey),
    kind: string(item.kind),
    eventIndex: safeInteger(item.eventIndex),
    payload: json(item.payload),
  };
}

export function encodeAppendCommandWire(command: AppendCommand<JsonValue>): AppendCommandWire {
  return {
    commandId: string(command.commandId),
    idempotencyKey: string(command.idempotencyKey),
    commandType: string(command.commandType),
    correlationId: string(command.correlationId),
    agentId: string(command.agentId),
    expectedStreamVersion: decimalWire(command.expectedStreamVersion),
    streamId: string(command.streamId),
    streamType: string(command.streamType),
    events: command.events.map(encodeEvent),
    outbox: command.outbox.map(encodeOutbox),
    publicResponse: json(command.publicResponse),
  };
}

export function decodeAppendCommandWire(value: unknown, context: ProjectContext): AppendCommand<JsonValue> {
  const command = exact(value, [
    "commandId", "idempotencyKey", "commandType", "correlationId", "agentId",
    "expectedStreamVersion", "streamId", "streamType", "events", "outbox", "publicResponse",
  ]);
  const events = array(command.events);
  const outbox = array(command.outbox);
  return {
    context,
    commandId: string(command.commandId),
    idempotencyKey: string(command.idempotencyKey),
    commandType: string(command.commandType),
    correlationId: string(command.correlationId),
    agentId: string(command.agentId),
    expectedStreamVersion: decimal(command.expectedStreamVersion),
    streamId: string(command.streamId),
    streamType: string(command.streamType),
    events: events.map(decodeEvent),
    outbox: outbox.map(decodeOutbox),
    publicResponse: json(command.publicResponse),
  };
}

export function encodeAppendResultWire(result: AppendResult<JsonValue>): AppendResultWire {
  return {
    deduplicated: result.deduplicated,
    firstGlobalPosition: decimalWire(result.firstGlobalPosition),
    lastGlobalPosition: decimalWire(result.lastGlobalPosition),
    finalStreamVersion: decimalWire(result.finalStreamVersion),
    eventIds: [...result.eventIds],
    response: json(result.response),
    responseHash: result.responseHash,
  };
}

export function decodeAppendResultWire(value: unknown): AppendResult<JsonValue> {
  const result = exact(value, [
    "deduplicated", "firstGlobalPosition", "lastGlobalPosition", "finalStreamVersion",
    "eventIds", "response", "responseHash",
  ]);
  return {
    deduplicated: boolean(result.deduplicated),
    firstGlobalPosition: decimal(result.firstGlobalPosition),
    lastGlobalPosition: decimal(result.lastGlobalPosition),
    finalStreamVersion: decimal(result.finalStreamVersion),
    eventIds: stringArray(result.eventIds),
    response: json(result.response),
    responseHash: string(result.responseHash),
  };
}

export function encodeMaintenanceLeaseWire(lease: MaintenanceLease): MaintenanceLeaseWire {
  return {
    epoch: decimalWire(lease.epoch, 1n),
    fencingToken: decimalWire(lease.fencingToken, 1n),
    ownerId: string(lease.ownerId),
    leaseExpiresAt: string(lease.leaseExpiresAt),
  };
}

export function decodeMaintenanceLeaseWire(value: unknown): MaintenanceLease {
  const lease = exact(value, ["epoch", "fencingToken", "ownerId", "leaseExpiresAt"]);
  return {
    epoch: decimal(lease.epoch, 1n),
    fencingToken: decimal(lease.fencingToken, 1n),
    ownerId: string(lease.ownerId),
    leaseExpiresAt: string(lease.leaseExpiresAt),
  };
}

function decodeIntegrityIssue(value: unknown): IntegrityIssue {
  const issue = record(value);
  const optional = ["globalPosition", "streamId", "commandId"].filter((key) => key in issue);
  exact(value, ["code", "message", ...optional]);
  const code = string(issue.code);
  if (!INTEGRITY_CODES.has(code)) invalid();
  return {
    code: code as IntegrityIssue["code"],
    message: string(issue.message, true),
    ...(issue.globalPosition === undefined ? {} : { globalPosition: string(issue.globalPosition) }),
    ...(issue.streamId === undefined ? {} : { streamId: string(issue.streamId) }),
    ...(issue.commandId === undefined ? {} : { commandId: string(issue.commandId) }),
  };
}

export function decodeIntegrityReport(value: unknown): IntegrityReport {
  const report = exact(value, [
    "ok", "mode", "projectId", "storeId", "firstGlobalPosition", "lastGlobalPosition",
    "eventsVerified", "streamsVerified", "commandsVerified", "schemaFingerprint",
    "terminalEventHash", "issues",
  ]);
  if (!INTEGRITY_MODES.has(report.mode as IntegrityMode)) invalid();
  const issues = array(report.issues);
  decimal(report.firstGlobalPosition);
  decimal(report.lastGlobalPosition);
  const schemaFingerprint = string(report.schemaFingerprint);
  const terminalEventHash = string(report.terminalEventHash);
  if (!HASH.test(schemaFingerprint) || !HASH.test(terminalEventHash)) invalid();
  return {
    ok: boolean(report.ok),
    mode: report.mode as IntegrityMode,
    projectId: string(report.projectId),
    storeId: string(report.storeId),
    firstGlobalPosition: report.firstGlobalPosition as string,
    lastGlobalPosition: report.lastGlobalPosition as string,
    eventsVerified: safeInteger(report.eventsVerified),
    streamsVerified: safeInteger(report.streamsVerified),
    commandsVerified: safeInteger(report.commandsVerified),
    schemaFingerprint,
    terminalEventHash,
    issues: issues.map(decodeIntegrityIssue),
  };
}

export function decodeWorkerRequest(value: unknown): WorkerRequest {
  const request = record(value);
  const id = string(request.id);
  const type = string(request.type);
  switch (type) {
    case "ping":
    case "close":
      exact(value, ["id", "type"]);
      return { id, type };
    case "verifyIdentity":
      exact(value, ["id", "type", "route", "expected"]);
      return { id, type, route: decodeRoute(request.route), expected: decodeIdentity(request.expected) };
    case "inspectExisting":
      exact(value, ["id", "type", "route", "expected"]);
      return { id, type, route: decodeRoute(request.route), expected: decodeIdentityExpectation(request.expected) };
    case "open":
      exact(value, ["id", "type", "binding"]);
      decodeWorkerBinding(request.binding);
      return { id, type, binding: request.binding as WorkerBinding };
    case "append":
      exact(value, ["id", "type", "binding", "command"]);
      return { id, type, binding: decodeAssertion(request.binding), command: decodeAppendCommandWireShape(request.command) };
    case "quickIntegrity":
      exact(value, ["id", "type", "binding", "tailLimit"]);
      return { id, type, binding: decodeAssertion(request.binding), tailLimit: positiveInteger(request.tailLimit) };
    case "fullIntegrity":
      exact(value, ["id", "type", "binding"]);
      return { id, type, binding: decodeAssertion(request.binding) };
    case "quiesce":
      exact(value, ["id", "type", "binding", "lease"]);
      decodeMaintenanceLeaseWire(request.lease);
      return { id, type, binding: decodeAssertion(request.binding), lease: request.lease as MaintenanceLeaseWire };
    default:
      invalid();
  }
}

function decodeAppendCommandWireShape(value: unknown): AppendCommandWire {
  const placeholder = {
    binding: {
      generation: 1,
    },
  } as unknown as ProjectContext;
  const decoded = decodeAppendCommandWire(value, placeholder);
  return encodeAppendCommandWire(decoded);
}

function decodeFailure(value: unknown): WorkerResponse {
  const response = exact(value, ["id", "ok", "error"]);
  if (response.ok !== false) invalid();
  const error = exact(response.error, ["code", "message", "details"]);
  const details = json(error.details);
  if (typeof details !== "object" || details === null || Array.isArray(details)) invalid();
  return {
    id: string(response.id),
    ok: false,
    error: {
      code: string(error.code),
      message: string(error.message, true),
      details: details as Record<string, JsonValue>,
    },
  };
}

function decodePing(value: unknown): WorkerPingResult {
  const result = exact(value, ["nodeVersion", "sqliteVersion", "walSafe"]);
  return {
    nodeVersion: string(result.nodeVersion),
    sqliteVersion: string(result.sqliteVersion),
    walSafe: boolean(result.walSafe),
  };
}

function decodeOpen(value: unknown): WorkerOpenResult {
  const result = exact(value, [
    "projectId", "vaultId", "storeId", "bindingGeneration", "contextFingerprint", "executorId",
  ]);
  return { ...decodeAssertion({
    projectId: result.projectId,
    vaultId: result.vaultId,
    storeId: result.storeId,
    bindingGeneration: result.bindingGeneration,
    contextFingerprint: result.contextFingerprint,
  }), executorId: string(result.executorId) };
}

function decodeSuccessForType(type: WorkerRequest["type"], value: unknown): WorkerSuccessData {
  switch (type) {
    case "ping": return decodePing(value);
    case "verifyIdentity": {
      const result = exact(value, ["verified"]);
      if (result.verified !== true) invalid();
      return { verified: true };
    }
    case "inspectExisting": return decodeIdentity(value);
    case "open": return decodeOpen(value);
    case "append": return encodeAppendResultWire(decodeAppendResultWire(value));
    case "quickIntegrity":
    case "fullIntegrity": return decodeIntegrityReport(value);
    case "quiesce": {
      const result = exact(value, ["quiesced", "epoch", "connectionClosed"]);
      if (result.quiesced !== true || result.connectionClosed !== true) invalid();
      decimal(result.epoch, 1n);
      return { quiesced: true, epoch: result.epoch as string, connectionClosed: true };
    }
    case "close": {
      const result = exact(value, ["closed"]);
      if (result.closed !== true) invalid();
      return { closed: true };
    }
  }
}

function decodeUnknownSuccess(value: unknown): WorkerSuccessData {
  const decoders: Array<(input: unknown) => WorkerSuccessData> = [
    decodePing,
    decodeOpen,
    decodeIdentity,
    (input) => encodeAppendResultWire(decodeAppendResultWire(input)),
    decodeIntegrityReport,
    (input) => {
      const result = exact(input, ["verified"]);
      if (result.verified !== true) invalid();
      return { verified: true };
    },
    (input) => {
      const result = exact(input, ["quiesced", "epoch", "connectionClosed"]);
      if (result.quiesced !== true || result.connectionClosed !== true) invalid();
      decimal(result.epoch, 1n);
      return { quiesced: true, epoch: result.epoch as string, connectionClosed: true };
    },
    (input) => {
      const result = exact(input, ["closed"]);
      if (result.closed !== true) invalid();
      return { closed: true };
    },
  ];
  for (const decode of decoders) {
    try { return decode(value); } catch (error) {
      if (!(error instanceof WorkerProtocolError)) throw error;
    }
  }
  invalid();
}

export function decodeWorkerResponse(value: unknown): WorkerResponse {
  const response = record(value);
  if (response.ok === false) return decodeFailure(value);
  exact(value, ["id", "ok", "data"]);
  if (response.ok !== true) invalid();
  return { id: string(response.id), ok: true, data: decodeUnknownSuccess(response.data) };
}

export function decodeWorkerResponseForRequest(
  value: unknown,
  request: WorkerRequest,
): WorkerResponse {
  const response = record(value);
  if (response.id !== request.id) invalid();
  if (response.ok === false) return decodeFailure(value);
  exact(value, ["id", "ok", "data"]);
  if (response.ok !== true) invalid();
  return {
    id: string(response.id),
    ok: true,
    data: decodeSuccessForType(request.type, response.data),
  };
}

export function decodeWorkerNotification(value: unknown): WorkerNotification {
  const notification = exact(value, [
    "type", "executorId", "epoch", "fencingToken", "connectionClosed",
  ]);
  if (notification.type !== "quiesced" || notification.connectionClosed !== true) invalid();
  decimal(notification.epoch, 1n);
  decimal(notification.fencingToken, 1n);
  return {
    type: "quiesced",
    executorId: string(notification.executorId),
    epoch: notification.epoch as string,
    fencingToken: notification.fencingToken as string,
    connectionClosed: true,
  };
}

export function decodeWorkerMessage(value: unknown): WorkerMessage {
  const message = record(value);
  return "id" in message ? decodeWorkerResponse(value) : decodeWorkerNotification(value);
}
