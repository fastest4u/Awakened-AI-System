import type { LifecycleAudience, LifecycleSemanticCommandDraft, CapabilityProofV1 } from "../contracts/commands.js";
import {
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
  type ChildBindingGrantV1,
  type RedactedLifecycleApproval,
  type SemanticCommandAuthorization,
} from "../contracts/commands.js";
import { exactRecord } from "../contracts/identifiers.js";
import { LifecycleError } from "../errors.js";
import { SecretString } from "./redacted-secret.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROLES = new Set(["primary", "maintenance", "untrusted"]);
const MAX_SECRET_SCALARS = 131_072;

export type PendingPrivateAuthorization =
  | {
      readonly kind: "initial-authority";
      readonly proof: null;
      readonly approval: null;
      readonly childBindingGrant: null;
    }
  | {
      readonly kind: "protected";
      readonly proof: CapabilityProofV1 | null;
      readonly approval: SecretString | null;
      readonly childBindingGrant: SecretString | null;
    };

export interface StableLifecycleBindingWitnessV1 {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly audience: LifecycleAudience;
}

export interface PendingSemanticCommandRecordV1 {
  readonly recordVersion: 1;
  readonly projectId: string;
  readonly storeId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly command: LifecycleSemanticCommandDraft;
  readonly authoritySessionId: string | null;
  readonly targetSessionId: string | null;
  readonly stableBinding: StableLifecycleBindingWitnessV1;
  readonly candidateIntentHash: string;
  readonly authorization: PendingPrivateAuthorization;
  readonly createdAt: string;
}

export interface PendingCommandIdentity {
  readonly projectId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export interface PendingAuthorizationStore {
  /** Canonical trusted-host root when the store is filesystem-backed. */
  readonly privateStateRoot?: string;
  put(record: PendingSemanticCommandRecordV1): Promise<void>;
  get(projectId: string, commandId: string, idempotencyKey: string): Promise<PendingSemanticCommandRecordV1 | null>;
  list(projectId: string): Promise<readonly PendingSemanticCommandRecordV1[]>;
  delete(projectId: string, commandId: string, idempotencyKey: string): Promise<void>;
}

interface PendingPrivateAuthorizationPlain {
  readonly kind: "initial-authority" | "protected";
  readonly proof: CapabilityProofV1 | null;
  readonly approval: string | null;
  readonly childBindingGrant: string | null;
}

interface PendingSemanticCommandPlainV1 extends Omit<PendingSemanticCommandRecordV1, "authorization"> {
  readonly authorization: PendingPrivateAuthorizationPlain;
}

function invalid(): never {
  throw new LifecycleError("SESSION_CAPABILITY_INVALID");
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Array.from(value).length <= maximum;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || uuid(value);
}

function exact(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  try {
    return exactRecord(value, keys, field, "SESSION_CAPABILITY_INVALID");
  } catch {
    return invalid();
  }
}

function proof(value: unknown): CapabilityProofV1 | null {
  if (value === null) return null;
  const record = exact(
    value,
    ["proofVersion", "target", "proofNonce", "proofFingerprint"],
    "authorization.proof",
  );
  if (
    record.proofVersion !== 1
    || record.target !== "semantic-command"
    || !uuid(record.proofNonce)
    || typeof record.proofFingerprint !== "string"
    || !HASH.test(record.proofFingerprint)
  ) invalid();
  return Object.freeze({
    proofVersion: 1,
    target: "semantic-command",
    proofNonce: record.proofNonce,
    proofFingerprint: record.proofFingerprint,
  });
}

function audience(value: unknown): LifecycleAudience {
  const record = exact(value, [
    "presentingActorRole",
    "presentingClientInstanceId",
    "targetActorRole",
    "targetClientInstanceId",
  ], "stableBinding.audience");
  if (
    !ROLES.has(String(record.presentingActorRole))
    || !bounded(record.presentingClientInstanceId, 256)
    || !ROLES.has(String(record.targetActorRole))
    || !bounded(record.targetClientInstanceId, 256)
  ) invalid();
  return Object.freeze({
    presentingActorRole: record.presentingActorRole as LifecycleAudience["presentingActorRole"],
    presentingClientInstanceId: record.presentingClientInstanceId,
    targetActorRole: record.targetActorRole as LifecycleAudience["targetActorRole"],
    targetClientInstanceId: record.targetClientInstanceId,
  });
}

function stableBinding(value: unknown): StableLifecycleBindingWitnessV1 {
  const record = exact(value, [
    "projectId", "vaultId", "storeId", "workspaceId", "clientNamespace", "audience",
  ], "stableBinding");
  if (
    !uuid(record.projectId)
    || !uuid(record.vaultId)
    || !uuid(record.storeId)
    || typeof record.workspaceId !== "string"
    || !HASH.test(record.workspaceId)
    || !bounded(record.clientNamespace, 256)
  ) invalid();
  return Object.freeze({
    projectId: record.projectId,
    vaultId: record.vaultId,
    storeId: record.storeId,
    workspaceId: record.workspaceId,
    clientNamespace: record.clientNamespace,
    audience: audience(record.audience),
  });
}

function privateAuthorization(value: unknown): {
  readonly decoded: PendingPrivateAuthorization;
  readonly plain: PendingPrivateAuthorizationPlain;
} {
  const record = exact(
    value,
    ["kind", "proof", "approval", "childBindingGrant"],
    "authorization",
  );
  const decodedProof = proof(record.proof);
  if (record.kind === "initial-authority") {
    if (
      decodedProof !== null
      || record.approval !== null
      || record.childBindingGrant !== null
    ) invalid();
    const authorization = Object.freeze({
      kind: "initial-authority" as const,
      proof: null,
      approval: null,
      childBindingGrant: null,
    });
    return { decoded: authorization, plain: authorization };
  }
  if (
    record.kind !== "protected"
    || (record.approval !== null && !bounded(record.approval, MAX_SECRET_SCALARS))
    || (record.childBindingGrant !== null && !bounded(record.childBindingGrant, MAX_SECRET_SCALARS))
    || (decodedProof === null && record.approval === null && record.childBindingGrant === null)
  ) invalid();
  const approval = record.approval === null ? null : SecretString.from(record.approval as string);
  const childBindingGrant = record.childBindingGrant === null
    ? null
    : SecretString.from(record.childBindingGrant as string);
  return {
    decoded: Object.freeze({
      kind: "protected" as const,
      proof: decodedProof,
      approval,
      childBindingGrant,
    }),
    plain: Object.freeze({
      kind: "protected" as const,
      proof: decodedProof,
      approval: record.approval as string | null,
      childBindingGrant: record.childBindingGrant as string | null,
    }),
  };
}

function dummyWorkerAuthorization(
  command: LifecycleSemanticCommandDraft,
  authoritySessionId: string | null,
  targetSessionId: string | null,
  authorization: PendingPrivateAuthorization,
  targetClientInstanceId: string,
): SemanticCommandAuthorization {
  if (authorization.kind === "initial-authority") {
    return {
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    };
  }
  if (authoritySessionId === null || targetSessionId === null) invalid();
  const approval: RedactedLifecycleApproval | null = authorization.approval === null
    ? null
    : {
        approvalVersion: 1,
        approvalId: "00000000-0000-4000-8000-000000000001" as RedactedLifecycleApproval["approvalId"],
        action: command.commandType === "root-recovery" ? "recover-root-authority" : "abandon-root",
        reasonCode: "explicit-user-approval",
        approvalFingerprint: "0".repeat(64),
        nonceDigest: "0".repeat(64),
        projectId: "00000000-0000-4000-8000-000000000003" as RedactedLifecycleApproval["projectId"],
        vaultId: "00000000-0000-4000-8000-000000000004" as RedactedLifecycleApproval["vaultId"],
        storeId: "00000000-0000-4000-8000-000000000005" as RedactedLifecycleApproval["storeId"],
        workspaceId: "0".repeat(64) as RedactedLifecycleApproval["workspaceId"],
        sessionId: authoritySessionId as RedactedLifecycleApproval["sessionId"],
        expectedOwnerGeneration: "1",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        intentHash: "0".repeat(64),
        executorActorRole: "primary",
        executorClientInstanceId: targetClientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:10:00.000Z",
        redactedApprovalReference: "pending-authorization-shape-check",
      };
  const childBindingGrant: ChildBindingGrantV1 | null = authorization.childBindingGrant === null
    ? null
    : {
        grantVersion: 1,
        grantId: "00000000-0000-4000-8000-000000000002",
        projectId: "00000000-0000-4000-8000-000000000003",
        storeId: "00000000-0000-4000-8000-000000000005",
        parentSessionId: authoritySessionId,
        targetActorRole: "untrusted",
        targetClientInstanceId,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:10:00.000Z",
        bindingFingerprint: "0".repeat(64),
        mac: "A".repeat(43),
      };
  return {
    kind: "protected",
    authoritySessionId: authoritySessionId as Extract<SemanticCommandAuthorization, { kind: "protected" }>["authoritySessionId"],
    targetSessionId: targetSessionId as Extract<SemanticCommandAuthorization, { kind: "protected" }>["targetSessionId"],
    proof: authorization.proof,
    approval,
    childBindingGrant,
  };
}

function assertSemanticShape(record: PendingSemanticCommandRecordV1): void {
  try {
    assertSemanticCommandAuthorization(
      record.command,
      dummyWorkerAuthorization(
        record.command,
        record.authoritySessionId,
        record.targetSessionId,
        record.authorization,
        record.stableBinding.audience.targetClientInstanceId,
      ),
    );
  } catch {
    invalid();
  }
}

export function decodePendingSemanticCommandRecord(value: unknown): PendingSemanticCommandRecordV1 {
  const record = exact(value, [
    "recordVersion",
    "projectId",
    "storeId",
    "commandId",
    "idempotencyKey",
    "command",
    "authoritySessionId",
    "targetSessionId",
    "stableBinding",
    "candidateIntentHash",
    "authorization",
    "createdAt",
  ], "pendingRecord");
  if (
    record.recordVersion !== 1
    || !uuid(record.projectId)
    || !uuid(record.storeId)
    || !uuid(record.commandId)
    || !bounded(record.idempotencyKey, 512)
    || !nullableUuid(record.authoritySessionId)
    || !nullableUuid(record.targetSessionId)
    || typeof record.candidateIntentHash !== "string"
    || !HASH.test(record.candidateIntentHash)
    || !timestamp(record.createdAt)
  ) invalid();
  let command: LifecycleSemanticCommandDraft;
  try {
    command = decodeLifecycleSemanticCommandDraft(record.command);
  } catch {
    return invalid();
  }
  const binding = stableBinding(record.stableBinding);
  const decodedAuthorization = privateAuthorization(record.authorization);
  const output: PendingSemanticCommandRecordV1 = Object.freeze({
    recordVersion: 1,
    projectId: record.projectId,
    storeId: record.storeId,
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    command,
    authoritySessionId: record.authoritySessionId as string | null,
    targetSessionId: record.targetSessionId as string | null,
    stableBinding: binding,
    candidateIntentHash: record.candidateIntentHash,
    authorization: decodedAuthorization.decoded,
    createdAt: record.createdAt,
  });
  if (
    output.command.commandId !== output.commandId
    || output.command.idempotencyKey !== output.idempotencyKey
    || output.command.expectedProjectId !== output.projectId
    || output.command.expectedProjectId !== output.stableBinding.projectId
    || output.command.expectedVaultId !== output.stableBinding.vaultId
    || output.command.expectedWorkspaceId !== output.stableBinding.workspaceId
    || output.storeId !== output.stableBinding.storeId
  ) {
    destroyPendingAuthorization(output.authorization);
    invalid();
  }
  try {
    assertSemanticShape(output);
    return output;
  } catch (error) {
    destroyPendingAuthorization(output.authorization);
    throw error;
  }
}

function secretValue(secret: SecretString | null): string | null {
  if (secret === null) return null;
  try {
    return secret.withValue((value) => value);
  } catch {
    return invalid();
  }
}

export function encodePendingSemanticCommandRecord(
  value: PendingSemanticCommandRecordV1,
): PendingSemanticCommandPlainV1 {
  const record = exact(value, [
    "recordVersion",
    "projectId",
    "storeId",
    "commandId",
    "idempotencyKey",
    "command",
    "authoritySessionId",
    "targetSessionId",
    "stableBinding",
    "candidateIntentHash",
    "authorization",
    "createdAt",
  ], "pendingRecord");
  const sourceAuthorization = exact(
    record.authorization,
    ["kind", "proof", "approval", "childBindingGrant"],
    "authorization",
  );
  if (
    sourceAuthorization.kind !== "initial-authority"
    && sourceAuthorization.kind !== "protected"
  ) invalid();
  if (sourceAuthorization.kind === "initial-authority") {
    if (
      sourceAuthorization.proof !== null
      || sourceAuthorization.approval !== null
      || sourceAuthorization.childBindingGrant !== null
    ) invalid();
  } else if (
    (sourceAuthorization.approval !== null
      && !(sourceAuthorization.approval instanceof SecretString))
    || (sourceAuthorization.childBindingGrant !== null
      && !(sourceAuthorization.childBindingGrant instanceof SecretString))
  ) invalid();
  const authorizationRecord = privateAuthorization({
    kind: sourceAuthorization.kind,
    proof: sourceAuthorization.proof,
    approval: sourceAuthorization.kind === "protected"
      ? secretValue(sourceAuthorization.approval as SecretString | null)
      : null,
    childBindingGrant: sourceAuthorization.kind === "protected"
      ? secretValue(sourceAuthorization.childBindingGrant as SecretString | null)
      : null,
  });
  destroyPendingAuthorization(authorizationRecord.decoded);
  const plain = {
    recordVersion: record.recordVersion,
    projectId: record.projectId,
    storeId: record.storeId,
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    command: record.command,
    authoritySessionId: record.authoritySessionId,
    targetSessionId: record.targetSessionId,
    stableBinding: record.stableBinding,
    candidateIntentHash: record.candidateIntentHash,
    authorization: authorizationRecord.plain,
    createdAt: record.createdAt,
  };
  const decoded = decodePendingSemanticCommandRecord(plain);
  try {
    return Object.freeze({
      recordVersion: 1,
      projectId: decoded.projectId,
      storeId: decoded.storeId,
      commandId: decoded.commandId,
      idempotencyKey: decoded.idempotencyKey,
      command: decoded.command,
      authoritySessionId: decoded.authoritySessionId,
      targetSessionId: decoded.targetSessionId,
      stableBinding: decoded.stableBinding,
      candidateIntentHash: decoded.candidateIntentHash,
      authorization: authorizationRecord.plain,
      createdAt: decoded.createdAt,
    });
  } finally {
    destroyPendingAuthorization(decoded.authorization);
  }
}

export function destroyPendingAuthorization(authorization: PendingPrivateAuthorization): void {
  if (authorization.kind === "protected") {
    authorization.approval?.destroy();
    authorization.childBindingGrant?.destroy();
  }
}
