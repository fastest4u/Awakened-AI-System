import { authorityCommitment, type CommittedAuthorityV1 } from "../lifecycle/authority/authority-commitment.js";
import { decodeLifecycleEventV1, type LifecycleEventV1 } from "../lifecycle/contracts/events.js";
import type { ChildSessionState, RootSessionState } from "../lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  assertAuthorityMirror,
  foldSession,
  type SessionAggregateState,
  type TerminalLifecycleEventType,
} from "../lifecycle/session-aggregate.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  AuthorityCompareAndSwap,
  CheckpointClear,
  CheckpointRequirement,
  ChildAuthorityInsert,
  RootAuthorityInsert,
  SafeResumeCandidateQuery,
  SessionAuthorityMutation,
  SessionAuthorityRecord,
} from "./lifecycle-storage.types.js";
import type { SqliteConnection, SqliteParams, SqliteRow, SqliteValue } from "./sqlite-driver.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROOT_STATES = new Set<RootSessionState>(["active", "suspended", "ending", "ended", "abandoned"]);
const CHILD_STATES = new Set<ChildSessionState>(["active", "completion-proposed", "completed", "suspended", "transferred"]);
const TERMINAL_TYPES = new Set<TerminalLifecycleEventType>([
  "SessionAbandoned",
  "SessionEnded",
  "ChildSessionCompleted",
  "ChildWorkTransferCreated",
]);

const FIELD_MAP = [
  ["projectId", "project_id"], ["sessionId", "session_id"], ["streamId", "stream_id"],
  ["sessionKind", "session_kind"], ["parentSessionId", "parent_session_id"],
  ["workspaceId", "workspace_id"], ["clientNamespace", "client_namespace"],
  ["semanticState", "semantic_state"], ["ownerGeneration", "owner_generation"],
  ["childCapabilityGeneration", "child_capability_generation"],
  ["directAccessEnabled", "direct_access_enabled"],
  ["continuityFingerprintAlgorithm", "continuity_fingerprint_algorithm"],
  ["continuityFingerprintSchemaVersion", "continuity_fingerprint_schema_version"],
  ["continuityFingerprintKeyId", "continuity_fingerprint_key_id"],
  ["continuityFingerprintDomain", "continuity_fingerprint_domain"],
  ["continuityFingerprint", "continuity_fingerprint"],
  ["rootHandleCapabilityVersion", "root_handle_capability_version"],
  ["rootHandleKeyId", "root_handle_key_id"], ["rootHandleIssueNonce", "root_handle_issue_nonce"],
  ["rootHandleIssuedAt", "root_handle_issued_at"], ["rootHandlePolicyCode", "root_handle_policy_code"],
  ["rootHandleExpiryKind", "root_handle_expiry_kind"], ["rootHandleExpiresAt", "root_handle_expires_at"],
  ["rootHandleActorRole", "root_handle_actor_role"],
  ["rootHandleClientInstanceId", "root_handle_client_instance_id"],
  ["rootHandleVerifier", "root_handle_verifier"], ["rootHandleIssuanceId", "root_handle_issuance_id"],
  ["resumeTokenCapabilityVersion", "resume_token_capability_version"],
  ["resumeTokenKeyId", "resume_token_key_id"], ["resumeTokenIssueNonce", "resume_token_issue_nonce"],
  ["resumeTokenIssuedAt", "resume_token_issued_at"], ["resumeTokenPolicyCode", "resume_token_policy_code"],
  ["resumeTokenExpiryKind", "resume_token_expiry_kind"], ["resumeTokenExpiresAt", "resume_token_expires_at"],
  ["resumeTokenActorRole", "resume_token_actor_role"], ["resumeTokenVerifier", "resume_token_verifier"],
  ["resumeTokenIssuanceId", "resume_token_issuance_id"],
  ["childHandleCapabilityVersion", "child_handle_capability_version"],
  ["childHandleKeyId", "child_handle_key_id"], ["childHandleIssueNonce", "child_handle_issue_nonce"],
  ["childHandleIssuedAt", "child_handle_issued_at"], ["childHandlePolicyCode", "child_handle_policy_code"],
  ["childHandleExpiryKind", "child_handle_expiry_kind"], ["childHandleExpiresAt", "child_handle_expires_at"],
  ["childHandleActorRole", "child_handle_actor_role"],
  ["childHandleClientInstanceId", "child_handle_client_instance_id"],
  ["childHandleVerifier", "child_handle_verifier"], ["childHandleIssuanceId", "child_handle_issuance_id"],
  ["authorityCommitment", "authority_commitment"], ["authorityEventPosition", "authority_event_position"],
  ["latestCheckpointId", "latest_checkpoint_id"],
  ["latestCheckpointEventPosition", "latest_checkpoint_event_position"],
  ["latestCheckpointFingerprint", "latest_checkpoint_fingerprint"],
  ["checkpointRequiredReason", "checkpoint_required_reason"],
  ["checkpointRequiredEventPosition", "checkpoint_required_event_position"],
  ["revocationReasonCode", "revocation_reason_code"],
  ["revocationEventPosition", "revocation_event_position"], ["revokedAt", "revoked_at"],
  ["terminalEventPosition", "terminal_event_position"], ["terminalEventType", "terminal_event_type"],
  ["terminalAt", "terminal_at"], ["createdAt", "created_at"], ["updatedAt", "updated_at"],
] as const;

const AUTHORITY_COLUMNS = FIELD_MAP.map(([, column]) => column);
const SELECT_AUTHORITY = AUTHORITY_COLUMNS.join(", ");
const MUTABLE_FIELDS = FIELD_MAP.filter(([field]) => !new Set([
  "projectId", "sessionId", "streamId", "sessionKind", "parentSessionId",
  "workspaceId", "clientNamespace", "createdAt",
]).has(field));

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function ownData(record: object, key: string, error: () => never = integrity): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) error();
  return descriptor.value;
}

function exactKeys(record: object, keys: readonly string[], error: () => never = integrity): void {
  const prototype = Object.getPrototypeOf(record) as unknown;
  if (prototype !== Object.prototype && prototype !== null) error();
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length) error();
  const expected = new Set(keys);
  for (const key of actual) {
    if (typeof key !== "string" || !expected.has(key)) error();
    ownData(record, key, error);
  }
}

function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum) integrity();
  return value;
}

function nullableText(value: unknown, maximum = 512): string | null {
  return value === null ? null : text(value, maximum);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !LOWER_UUID.test(value)) integrity();
  return value;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !LOWER_HASH.test(value)) integrity();
  return value;
}

function nullableHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}

function timestamp(value: unknown, error: () => never = integrity): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) error();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) error();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function checkpointMutationTimestamp(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  value: unknown,
): string {
  const updatedAt = timestamp(value, invalid);
  const row = connection.prepare(`
    SELECT created_at
    FROM session_authority
    WHERE project_id = $projectId AND session_id = $sessionId
  `).get({ $projectId: projectId, $sessionId: sessionId });
  if (row === undefined) return updatedAt;
  exactKeys(row, ["created_at"]);
  if (Date.parse(updatedAt) < Date.parse(timestamp(ownData(row, "created_at")))) invalid();
  return updatedAt;
}

function int64(value: unknown, allowZero = false): bigint {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n) || value > SQLITE_INT64_MAX) integrity();
  return value;
}

function nullableInt64(value: unknown, allowZero = false): bigint | null {
  return value === null ? null : int64(value, allowZero);
}

function version(value: unknown): number {
  const decoded = int64(value);
  if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) integrity();
  return Number(decoded);
}

function nullableVersion(value: unknown): number | null {
  return value === null ? null : version(value);
}

function flag(value: unknown): boolean {
  if (value !== 0n && value !== 1n) integrity();
  return value === 1n;
}

function expiryKind(value: unknown): "until-revoked" | "absolute" | null {
  if (value === null) return null;
  if (value !== "until-revoked" && value !== "absolute") integrity();
  return value;
}

function terminalType(value: unknown): TerminalLifecycleEventType | null {
  if (value === null) return null;
  if (typeof value !== "string" || !TERMINAL_TYPES.has(value as TerminalLifecycleEventType)) integrity();
  return value as TerminalLifecycleEventType;
}

function parseCanonical(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    integrity();
  }
  try {
    if (canonicalJson(parsed) !== value) integrity();
  } catch {
    integrity();
  }
  return parsed;
}

function committedAuthority(record: SessionAuthorityRecord): CommittedAuthorityV1 {
  return {
    authorityVersion: 1,
    projectId: record.projectId,
    sessionId: record.sessionId,
    sessionKind: record.sessionKind,
    parentSessionId: record.parentSessionId,
    workspaceId: record.workspaceId,
    clientNamespace: record.clientNamespace,
    ownerGeneration: record.ownerGeneration?.toString() ?? null,
    childCapabilityGeneration: record.childCapabilityGeneration?.toString() ?? null,
    directAccessEnabled: record.directAccessEnabled,
    continuityFingerprintAlgorithm: record.continuityFingerprintAlgorithm,
    continuityFingerprintSchemaVersion: record.continuityFingerprintSchemaVersion,
    continuityFingerprintKeyId: record.continuityFingerprintKeyId,
    continuityFingerprintDomain: record.continuityFingerprintDomain,
    continuityFingerprint: record.continuityFingerprint,
    rootHandleCapabilityVersion: record.rootHandleCapabilityVersion,
    rootHandleKeyId: record.rootHandleKeyId,
    rootHandleIssueNonce: record.rootHandleIssueNonce,
    rootHandleIssuedAt: record.rootHandleIssuedAt,
    rootHandlePolicyCode: record.rootHandlePolicyCode,
    rootHandleExpiryKind: record.rootHandleExpiryKind,
    rootHandleExpiresAt: record.rootHandleExpiresAt,
    rootHandleActorRole: record.rootHandleActorRole,
    rootHandleClientInstanceId: record.rootHandleClientInstanceId,
    rootHandleVerifier: record.rootHandleVerifier,
    resumeTokenCapabilityVersion: record.resumeTokenCapabilityVersion,
    resumeTokenKeyId: record.resumeTokenKeyId,
    resumeTokenIssueNonce: record.resumeTokenIssueNonce,
    resumeTokenIssuedAt: record.resumeTokenIssuedAt,
    resumeTokenPolicyCode: record.resumeTokenPolicyCode,
    resumeTokenExpiryKind: record.resumeTokenExpiryKind,
    resumeTokenExpiresAt: record.resumeTokenExpiresAt,
    resumeTokenActorRole: record.resumeTokenActorRole,
    resumeTokenVerifier: record.resumeTokenVerifier,
    childHandleCapabilityVersion: record.childHandleCapabilityVersion,
    childHandleKeyId: record.childHandleKeyId,
    childHandleIssueNonce: record.childHandleIssueNonce,
    childHandleIssuedAt: record.childHandleIssuedAt,
    childHandlePolicyCode: record.childHandlePolicyCode,
    childHandleExpiryKind: record.childHandleExpiryKind,
    childHandleExpiresAt: record.childHandleExpiresAt,
    childHandleActorRole: record.childHandleActorRole,
    childHandleClientInstanceId: record.childHandleClientInstanceId,
    childHandleVerifier: record.childHandleVerifier,
    revocationReasonCode: record.revocationReasonCode,
    revocationEventPosition: record.revocationEventPosition?.toString() ?? null,
    revokedAt: record.revokedAt,
    terminalEventPosition: record.terminalEventPosition?.toString() ?? null,
    terminalEventType: record.terminalEventType,
    terminalAt: record.terminalAt,
  };
}

function assertGroup(all: readonly unknown[], present: boolean): void {
  if (all.some((value) => value !== null) !== present || all.every((value) => value !== null) !== present) integrity();
}

function assertAuthorityShape(record: SessionAuthorityRecord): void {
  const rootFields = [
    record.continuityFingerprintAlgorithm, record.continuityFingerprintSchemaVersion,
    record.continuityFingerprintKeyId, record.continuityFingerprintDomain, record.continuityFingerprint,
    record.rootHandleCapabilityVersion, record.rootHandleKeyId, record.rootHandleIssueNonce,
    record.rootHandleIssuedAt, record.rootHandlePolicyCode, record.rootHandleExpiryKind,
    record.rootHandleActorRole, record.rootHandleClientInstanceId, record.rootHandleVerifier,
    record.rootHandleIssuanceId, record.resumeTokenCapabilityVersion, record.resumeTokenKeyId,
    record.resumeTokenIssueNonce, record.resumeTokenIssuedAt, record.resumeTokenPolicyCode,
    record.resumeTokenExpiryKind, record.resumeTokenActorRole, record.resumeTokenVerifier,
    record.resumeTokenIssuanceId,
  ];
  const childFields = [
    record.childHandleCapabilityVersion, record.childHandleKeyId, record.childHandleIssueNonce,
    record.childHandleIssuedAt, record.childHandlePolicyCode, record.childHandleExpiryKind,
    record.childHandleActorRole, record.childHandleClientInstanceId, record.childHandleVerifier,
    record.childHandleIssuanceId,
  ];
  if (record.sessionKind === "root") {
    if (record.parentSessionId !== null || record.ownerGeneration === null
      || record.childCapabilityGeneration !== null || record.directAccessEnabled
      || !ROOT_STATES.has(record.semanticState as RootSessionState)) integrity();
    assertGroup(rootFields, true);
    assertGroup(childFields, false);
    if (record.rootHandleActorRole !== "primary" || record.resumeTokenActorRole !== "primary") integrity();
  } else {
    if (record.parentSessionId === null || record.ownerGeneration !== null
      || !CHILD_STATES.has(record.semanticState as ChildSessionState)) integrity();
    assertGroup(rootFields, false);
    assertGroup(childFields, record.directAccessEnabled);
    if (record.directAccessEnabled !== (record.childCapabilityGeneration !== null)) integrity();
    if (record.directAccessEnabled && record.childHandleActorRole !== "untrusted") integrity();
  }
  if ((record.rootHandleExpiryKind === "absolute") !== (record.rootHandleExpiresAt !== null)) integrity();
  if ((record.resumeTokenExpiryKind === "absolute") !== (record.resumeTokenExpiresAt !== null)) integrity();
  if ((record.childHandleExpiryKind === "absolute") !== (record.childHandleExpiresAt !== null)) integrity();
  assertGroup([record.latestCheckpointId, record.latestCheckpointEventPosition, record.latestCheckpointFingerprint], record.latestCheckpointId !== null);
  assertGroup([record.checkpointRequiredReason, record.checkpointRequiredEventPosition], record.checkpointRequiredReason !== null);
  assertGroup([record.revocationReasonCode, record.revocationEventPosition, record.revokedAt], record.revocationReasonCode !== null);
  assertGroup([record.terminalEventPosition, record.terminalEventType, record.terminalAt], record.terminalEventPosition !== null);
  if (record.terminalEventPosition !== null && record.terminalEventPosition !== record.authorityEventPosition) integrity();
  if (record.revocationEventPosition !== null && record.revocationEventPosition > record.authorityEventPosition) integrity();
  if (record.terminalEventPosition !== null
    && record.latestCheckpointEventPosition !== null
    && record.latestCheckpointEventPosition > record.terminalEventPosition) integrity();
  if (record.sessionKind === "root" && record.terminalEventType !== null
    && record.terminalEventType !== "SessionEnded" && record.terminalEventType !== "SessionAbandoned") integrity();
  if (record.sessionKind === "child" && record.terminalEventType !== null
    && record.terminalEventType !== "ChildSessionCompleted" && record.terminalEventType !== "ChildWorkTransferCreated") integrity();
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) integrity();
  if (authorityCommitment(committedAuthority(record)) !== record.authorityCommitment) integrity();
}

function decodeAuthorityRow(row: SqliteRow): SessionAuthorityRecord {
  exactKeys(row, AUTHORITY_COLUMNS);
  const kind = ownData(row, "session_kind");
  if (kind !== "root" && kind !== "child") integrity();
  const state = text(ownData(row, "semantic_state"), 64) as RootSessionState | ChildSessionState;
  const record: SessionAuthorityRecord = Object.freeze({
    projectId: uuid(ownData(row, "project_id")),
    sessionId: uuid(ownData(row, "session_id")),
    streamId: text(ownData(row, "stream_id"), 128),
    sessionKind: kind,
    parentSessionId: nullableUuid(ownData(row, "parent_session_id")),
    workspaceId: hash(ownData(row, "workspace_id")),
    clientNamespace: text(ownData(row, "client_namespace"), 256),
    semanticState: state,
    ownerGeneration: nullableInt64(ownData(row, "owner_generation")),
    childCapabilityGeneration: nullableInt64(ownData(row, "child_capability_generation")),
    directAccessEnabled: flag(ownData(row, "direct_access_enabled")),
    continuityFingerprintAlgorithm: nullableText(ownData(row, "continuity_fingerprint_algorithm"), 128),
    continuityFingerprintSchemaVersion: nullableVersion(ownData(row, "continuity_fingerprint_schema_version")),
    continuityFingerprintKeyId: nullableText(ownData(row, "continuity_fingerprint_key_id"), 128),
    continuityFingerprintDomain: nullableText(ownData(row, "continuity_fingerprint_domain"), 128),
    continuityFingerprint: nullableHash(ownData(row, "continuity_fingerprint")),
    rootHandleCapabilityVersion: nullableVersion(ownData(row, "root_handle_capability_version")),
    rootHandleKeyId: nullableText(ownData(row, "root_handle_key_id"), 128),
    rootHandleIssueNonce: nullableHash(ownData(row, "root_handle_issue_nonce")),
    rootHandleIssuedAt: nullableTimestamp(ownData(row, "root_handle_issued_at")),
    rootHandlePolicyCode: nullableText(ownData(row, "root_handle_policy_code"), 128),
    rootHandleExpiryKind: expiryKind(ownData(row, "root_handle_expiry_kind")),
    rootHandleExpiresAt: nullableTimestamp(ownData(row, "root_handle_expires_at")),
    rootHandleActorRole: ownData(row, "root_handle_actor_role") as "primary" | null,
    rootHandleClientInstanceId: nullableText(ownData(row, "root_handle_client_instance_id"), 256),
    rootHandleVerifier: nullableHash(ownData(row, "root_handle_verifier")),
    rootHandleIssuanceId: nullableUuid(ownData(row, "root_handle_issuance_id")),
    resumeTokenCapabilityVersion: nullableVersion(ownData(row, "resume_token_capability_version")),
    resumeTokenKeyId: nullableText(ownData(row, "resume_token_key_id"), 128),
    resumeTokenIssueNonce: nullableHash(ownData(row, "resume_token_issue_nonce")),
    resumeTokenIssuedAt: nullableTimestamp(ownData(row, "resume_token_issued_at")),
    resumeTokenPolicyCode: nullableText(ownData(row, "resume_token_policy_code"), 128),
    resumeTokenExpiryKind: expiryKind(ownData(row, "resume_token_expiry_kind")),
    resumeTokenExpiresAt: nullableTimestamp(ownData(row, "resume_token_expires_at")),
    resumeTokenActorRole: ownData(row, "resume_token_actor_role") as "primary" | null,
    resumeTokenVerifier: nullableHash(ownData(row, "resume_token_verifier")),
    resumeTokenIssuanceId: nullableUuid(ownData(row, "resume_token_issuance_id")),
    childHandleCapabilityVersion: nullableVersion(ownData(row, "child_handle_capability_version")),
    childHandleKeyId: nullableText(ownData(row, "child_handle_key_id"), 128),
    childHandleIssueNonce: nullableHash(ownData(row, "child_handle_issue_nonce")),
    childHandleIssuedAt: nullableTimestamp(ownData(row, "child_handle_issued_at")),
    childHandlePolicyCode: nullableText(ownData(row, "child_handle_policy_code"), 128),
    childHandleExpiryKind: expiryKind(ownData(row, "child_handle_expiry_kind")),
    childHandleExpiresAt: nullableTimestamp(ownData(row, "child_handle_expires_at")),
    childHandleActorRole: ownData(row, "child_handle_actor_role") as "untrusted" | null,
    childHandleClientInstanceId: nullableText(ownData(row, "child_handle_client_instance_id"), 256),
    childHandleVerifier: nullableHash(ownData(row, "child_handle_verifier")),
    childHandleIssuanceId: nullableUuid(ownData(row, "child_handle_issuance_id")),
    authorityCommitment: hash(ownData(row, "authority_commitment")),
    authorityEventPosition: int64(ownData(row, "authority_event_position")),
    latestCheckpointId: nullableUuid(ownData(row, "latest_checkpoint_id")),
    latestCheckpointEventPosition: nullableInt64(ownData(row, "latest_checkpoint_event_position")),
    latestCheckpointFingerprint: nullableHash(ownData(row, "latest_checkpoint_fingerprint")),
    checkpointRequiredReason: nullableText(ownData(row, "checkpoint_required_reason"), 128),
    checkpointRequiredEventPosition: nullableInt64(ownData(row, "checkpoint_required_event_position")),
    revocationReasonCode: nullableText(ownData(row, "revocation_reason_code"), 128),
    revocationEventPosition: nullableInt64(ownData(row, "revocation_event_position")),
    revokedAt: nullableTimestamp(ownData(row, "revoked_at")),
    terminalEventPosition: nullableInt64(ownData(row, "terminal_event_position")),
    terminalEventType: terminalType(ownData(row, "terminal_event_type")),
    terminalAt: nullableTimestamp(ownData(row, "terminal_at")),
    createdAt: timestamp(ownData(row, "created_at")),
    updatedAt: timestamp(ownData(row, "updated_at")),
  });
  if (record.streamId !== `session/${record.sessionId}`) integrity();
  if (record.rootHandleActorRole !== null && record.rootHandleActorRole !== "primary") integrity();
  if (record.resumeTokenActorRole !== null && record.resumeTokenActorRole !== "primary") integrity();
  if (record.childHandleActorRole !== null && record.childHandleActorRole !== "untrusted") integrity();
  assertAuthorityShape(record);
  return record;
}

function rowFromInput(input: SessionAuthorityRecord): SqliteRow {
  exactKeys(input, FIELD_MAP.map(([field]) => field), invalid);
  const row: SqliteRow = {};
  for (const [field, column] of FIELD_MAP) {
    const value = ownData(input, field, invalid);
    row[column] = field === "directAccessEnabled"
      ? value === true ? 1n : value === false ? 0n : invalid()
      : field.endsWith("Version") && typeof value === "number"
        ? BigInt(value)
        : value as SqliteValue;
  }
  return row;
}

function paramsFromRecord(input: SessionAuthorityRecord): SqliteParams {
  const row = rowFromInput(input);
  try {
    decodeAuthorityRow(row);
  } catch (error) {
    if (error instanceof LifecycleError) invalid();
    throw error;
  }
  const params: Record<`$${string}`, SqliteValue> = {};
  for (const [, column] of FIELD_MAP) params[`$${column}`] = row[column]!;
  return params;
}

const INSERT_AUTHORITY = `
  INSERT INTO session_authority(${AUTHORITY_COLUMNS.join(", ")})
  VALUES (${AUTHORITY_COLUMNS.map((column) => `$${column}`).join(", ")})
`;

function inputValue(record: object, field: string): SqliteValue {
  const value = ownData(record, field, invalid);
  if (field === "directAccessEnabled") {
    if (value !== true && value !== false) invalid();
    return value ? 1n : 0n;
  }
  if (field.endsWith("Version")) {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
    return BigInt(value);
  }
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  invalid();
}

function mutationParams(input: SessionAuthorityMutation): SqliteParams {
  exactKeys(input, MUTABLE_FIELDS.map(([field]) => field), invalid);
  const params: Record<`$${string}`, SqliteValue> = {};
  for (const [field, column] of MUTABLE_FIELDS) params[`$next_${column}`] = inputValue(input, field);
  if (typeof input.authorityCommitment !== "string" || !LOWER_HASH.test(input.authorityCommitment)) invalid();
  return params;
}

function eventRows(connection: SqliteConnection, authority: SessionAuthorityRecord): readonly LifecycleEventV1[] {
  const columns = [
    "global_position", "event_id", "project_id", "vault_id", "store_id", "workspace_id",
    "stream_id", "stream_type", "stream_version", "event_type", "event_schema_version",
    "session_id", "parent_session_id", "correlation_id", "causation_id", "command_id",
    "idempotency_key", "occurred_at", "payload_json",
  ] as const;
  const rows = connection.prepare(`
    SELECT ${columns.join(", ")}
    FROM events
    WHERE project_id = $projectId AND stream_id = $streamId
    ORDER BY stream_version
  `).all({ $projectId: authority.projectId, $streamId: authority.streamId });
  let currentCommitment: string | null = null;
  return rows.map((row) => {
    exactKeys(row, columns);
    if (ownData(row, "stream_type") !== "session") integrity();
    const payloadText = text(ownData(row, "payload_json"), 1_000_000);
    const payload = parseCanonical(payloadText);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) integrity();
    const payloadRecord = payload as Record<string, unknown>;
    if (typeof payloadRecord.authorityCommitment === "string") {
      currentCommitment = payloadRecord.authorityCommitment;
    }
    if (currentCommitment === null) integrity();
    const schemaVersion = version(ownData(row, "event_schema_version"));
    const streamVersion = int64(ownData(row, "stream_version"));
    const position = int64(ownData(row, "global_position"));
    try {
      return decodeLifecycleEventV1({
        eventSchemaVersion: schemaVersion,
        eventId: ownData(row, "event_id"),
        projectId: ownData(row, "project_id"),
        vaultId: ownData(row, "vault_id"),
        storeId: ownData(row, "store_id"),
        workspaceId: ownData(row, "workspace_id"),
        streamId: ownData(row, "stream_id"),
        streamVersion: streamVersion.toString(),
        globalPosition: position.toString(),
        sessionId: ownData(row, "session_id"),
        parentSessionId: ownData(row, "parent_session_id"),
        eventType: ownData(row, "event_type"),
        correlationId: ownData(row, "correlation_id"),
        causationId: ownData(row, "causation_id"),
        commandId: ownData(row, "command_id"),
        idempotencyKey: ownData(row, "idempotency_key"),
        occurredAt: ownData(row, "occurred_at"),
        authorityCommitment: currentCommitment,
        payload,
      });
    } catch {
      integrity();
    }
  });
}

export class SessionAuthorityRepository {
  get(connection: SqliteConnection, projectId: string, sessionId: string): SessionAuthorityRecord | null {
    if (!LOWER_UUID.test(projectId) || !LOWER_UUID.test(sessionId)) invalid();
    const row = connection.prepare(`
      SELECT ${SELECT_AUTHORITY}
      FROM session_authority
      WHERE project_id = $projectId AND session_id = $sessionId
    `).get({ $projectId: projectId, $sessionId: sessionId });
    return row === undefined ? null : decodeAuthorityRow(row);
  }

  insertRoot(connection: SqliteConnection, input: RootAuthorityInsert): void {
    if (input.sessionKind !== "root") invalid();
    const result = connection.prepare(INSERT_AUTHORITY).run(paramsFromRecord(input));
    if (result.changes !== 1n) integrity();
  }

  insertChild(connection: SqliteConnection, input: ChildAuthorityInsert): void {
    if (input.sessionKind !== "child") invalid();
    const result = connection.prepare(INSERT_AUTHORITY).run(paramsFromRecord(input));
    if (result.changes !== 1n) integrity();
  }

  compareAndSwap(connection: SqliteConnection, input: AuthorityCompareAndSwap): boolean {
    if (!LOWER_UUID.test(input.projectId) || !LOWER_UUID.test(input.sessionId)
      || !LOWER_HASH.test(input.expectedAuthorityCommitment)
      || (input.expectedOwnerGeneration !== null && (input.expectedOwnerGeneration < 1n || input.expectedOwnerGeneration > SQLITE_INT64_MAX))
      || (input.expectedChildCapabilityGeneration !== null
        && (input.expectedChildCapabilityGeneration < 1n || input.expectedChildCapabilityGeneration > SQLITE_INT64_MAX))) invalid();
    const current = this.get(connection, input.projectId, input.sessionId);
    if (current === null
      || current.semanticState !== input.expectedState
      || current.authorityCommitment !== input.expectedAuthorityCommitment
      || current.ownerGeneration !== input.expectedOwnerGeneration
      || current.childCapabilityGeneration !== input.expectedChildCapabilityGeneration) return false;
    const params = mutationParams(input.next);
    decodeAuthorityRow(rowFromInput({
      ...current,
      ...input.next,
    }));
    params.$projectId = input.projectId;
    params.$sessionId = input.sessionId;
    params.$expectedState = input.expectedState;
    params.$expectedOwnerGeneration = input.expectedOwnerGeneration;
    params.$expectedChildCapabilityGeneration = input.expectedChildCapabilityGeneration;
    params.$expectedCommitment = input.expectedAuthorityCommitment;
    const assignments = MUTABLE_FIELDS.map(([, column]) => `${column} = $next_${column}`).join(", ");
    const result = connection.prepare(`
      UPDATE session_authority SET ${assignments}
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND semantic_state = $expectedState
        AND authority_commitment = $expectedCommitment
        AND owner_generation IS $expectedOwnerGeneration
        AND child_capability_generation IS $expectedChildCapabilityGeneration
    `).run(params);
    if (result.changes === 0n) return false;
    if (result.changes !== 1n) integrity();
    return true;
  }

  listNonterminalChildren(
    connection: SqliteConnection,
    projectId: string,
    rootSessionId: string,
  ): readonly SessionAuthorityRecord[] {
    if (!LOWER_UUID.test(projectId) || !LOWER_UUID.test(rootSessionId)) invalid();
    return Object.freeze(connection.prepare(`
      SELECT ${SELECT_AUTHORITY}
      FROM session_authority
      WHERE project_id = $projectId
        AND parent_session_id = $rootSessionId
        AND session_kind = 'child'
        AND terminal_event_position IS NULL
      ORDER BY session_id
    `).all({ $projectId: projectId, $rootSessionId: rootSessionId }).map(decodeAuthorityRow));
  }

  listSafeResumeCandidates(
    connection: SqliteConnection,
    query: SafeResumeCandidateQuery,
  ): readonly SessionAuthorityRecord[] {
    const states = [...query.semanticStates];
    if (!LOWER_UUID.test(query.projectId) || !LOWER_HASH.test(query.workspaceId)
      || query.clientNamespace.length === 0 || Array.from(query.clientNamespace).length > 256
      || (query.sessionId !== undefined && query.sessionId !== null && !LOWER_UUID.test(query.sessionId))
      || (query.continuityFingerprint !== undefined && query.continuityFingerprint !== null
        && !LOWER_HASH.test(query.continuityFingerprint))
      || states.length < 1 || states.length > 2 || new Set(states).size !== states.length
      || states.some((state) => state !== "active" && state !== "suspended")) invalid();
    const rows = connection.prepare(`
      SELECT ${SELECT_AUTHORITY}
      FROM session_authority
      WHERE project_id = $projectId
        AND workspace_id = $workspaceId
        AND client_namespace = $clientNamespace
        AND session_kind = 'root'
        AND terminal_event_position IS NULL
        AND ($sessionId IS NULL OR session_id IS $sessionId)
        AND ($continuityFingerprint IS NULL OR continuity_fingerprint IS $continuityFingerprint)
        AND semantic_state IN ($state0, $state1)
      ORDER BY session_id
    `).all({
      $projectId: query.projectId,
      $workspaceId: query.workspaceId,
      $clientNamespace: query.clientNamespace,
      $sessionId: query.sessionId ?? null,
      $continuityFingerprint: query.continuityFingerprint ?? null,
      $state0: states[0]!,
      $state1: states[1] ?? states[0]!,
    });
    return Object.freeze(rows.map(decodeAuthorityRow));
  }

  requireFoldMatch(
    connection: SqliteConnection,
    authority: SessionAuthorityRecord,
  ): SessionAggregateState {
    const events = eventRows(connection, authority);
    const aggregate = foldSession(events);
    const latestAuthorityEvent = [...events].reverse().find((event) => (
      "authorityCommitment" in event.payload
    ));
    if (aggregate.projectId !== authority.projectId
      || aggregate.sessionId !== authority.sessionId
      || aggregate.streamId !== authority.streamId
      || aggregate.workspaceId !== authority.workspaceId
      || latestAuthorityEvent === undefined
      || BigInt(latestAuthorityEvent.globalPosition) !== authority.authorityEventPosition
      || aggregate.latestCheckpointId !== authority.latestCheckpointId) integrity();
    assertAuthorityMirror(aggregate, {
      sessionKind: authority.sessionKind,
      parentSessionId: authority.parentSessionId as import("../lifecycle/contracts/identifiers.js").SessionId | null,
      semanticState: authority.semanticState,
      ownerGeneration: authority.ownerGeneration,
      childCapabilityGeneration: authority.childCapabilityGeneration,
      authorityCommitment: authority.authorityCommitment,
      latestCheckpointEventPosition: authority.latestCheckpointEventPosition,
      terminalEventPosition: authority.terminalEventPosition,
    });
    return aggregate;
  }

  markCheckpointRequired(connection: SqliteConnection, input: CheckpointRequirement): void {
    if (!LOWER_UUID.test(input.projectId) || !LOWER_UUID.test(input.sessionId)
      || input.eventPosition < 1n || input.eventPosition > SQLITE_INT64_MAX
      || input.reason.length === 0 || Array.from(input.reason).length > 128) invalid();
    const updatedAt = checkpointMutationTimestamp(
      connection,
      input.projectId,
      input.sessionId,
      input.updatedAt,
    );
    const result = connection.prepare(`
      UPDATE session_authority
      SET checkpoint_required_reason = $reason,
          checkpoint_required_event_position = $eventPosition,
          updated_at = $updatedAt
      WHERE project_id = $projectId AND session_id = $sessionId
        AND terminal_event_position IS NULL
        AND (
          checkpoint_required_event_position IS NULL
          OR checkpoint_required_event_position < $eventPosition
        )
    `).run({
      $projectId: input.projectId,
      $sessionId: input.sessionId,
      $reason: input.reason,
      $eventPosition: input.eventPosition,
      $updatedAt: updatedAt,
    });
    if (result.changes > 1n) integrity();
  }

  clearCheckpointRequired(connection: SqliteConnection, input: CheckpointClear): boolean {
    if (!LOWER_UUID.test(input.projectId) || !LOWER_UUID.test(input.sessionId)
      || input.checkpointBaseEventPosition < 0n || input.checkpointBaseEventPosition > SQLITE_INT64_MAX) invalid();
    const updatedAt = checkpointMutationTimestamp(
      connection,
      input.projectId,
      input.sessionId,
      input.updatedAt,
    );
    const result = connection.prepare(`
      UPDATE session_authority
      SET checkpoint_required_reason = NULL,
          checkpoint_required_event_position = NULL,
          updated_at = $updatedAt
      WHERE project_id = $projectId AND session_id = $sessionId
        AND checkpoint_required_event_position IS NOT NULL
        AND checkpoint_required_event_position <= $checkpointBaseEventPosition
    `).run({
      $projectId: input.projectId,
      $sessionId: input.sessionId,
      $checkpointBaseEventPosition: input.checkpointBaseEventPosition,
      $updatedAt: updatedAt,
    });
    if (result.changes === 0n) return false;
    if (result.changes !== 1n) integrity();
    return true;
  }
}
