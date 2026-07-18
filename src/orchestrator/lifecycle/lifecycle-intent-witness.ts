import { canonicalJson } from "../serialization/canonical-json.js";
import {
  assertInternalValidationResultBinding,
  decodeLifecycleSemanticCommandDraft,
  type InternalValidationResultCommand,
  type InternalWorkflowPhaseCommand,
  type InternalWorkflowSemanticCommand,
  type LifecycleSemanticCommandDraft,
} from "./contracts/commands.js";
import { decodeCheckpointV1 } from "./contracts/checkpoint.js";
import {
  exactRecord,
  parseBoundedString,
  parseCanonicalTimestamp,
  parseDecimalString,
  parseInteger,
  parseLifecycleId,
  parseNullableBoundedString,
  strictArray,
  type ValidationResultId,
} from "./contracts/identifiers.js";
import type { CapabilityKind } from "./authority/capability-key-provider.js";
import {
  canonicalLifecycleIntentHash,
  canonicalLifecycleIntentPreimage,
  type LifecycleIntentActorRole,
  type LifecycleIntentAuthorizationKind,
  type LifecycleIntentAuthorizationV1,
  type LifecycleIntentPreimageV1,
} from "./lifecycle-intent.js";

export type {
  LifecycleIntentActorRole,
  LifecycleIntentAuthorizationKind,
  LifecycleIntentPreimageV1,
} from "./lifecycle-intent.js";

/**
 * Trusted, already-derived assertions that the semantic writer will persist in
 * command_dedup. This deliberately contains no proof, approval, bearer, claim,
 * binding generation, source-state observation, or raw evidence field.
 */
export interface TrustedLifecycleIntentAssertionsV1 {
  readonly authorizationKind: LifecycleIntentAuthorizationKind;
  readonly authorizationSessionId: string | null;
  readonly targetSessionId: string;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly capabilityKind: CapabilityKind | null;
  readonly capabilityGeneration: string | null;
  readonly presentingActorRole: LifecycleIntentActorRole;
  readonly presentingClientInstanceId: string;
  readonly targetActorRole: LifecycleIntentActorRole;
  readonly targetClientInstanceId: string;
  readonly internalWorkflowId: string | null;
  readonly internalWorkflowGeneration: number | null;
  readonly internalPlannedWorkId: string | null;
}

type InternalValidationStableCommand = Omit<InternalValidationResultCommand, "claim">;
type InternalWorkflowPhaseStableCommand = Omit<InternalWorkflowPhaseCommand, "claim">;
type LifecycleIntentCommandV1 =
  | LifecycleSemanticCommandDraft
  | InternalValidationStableCommand
  | InternalWorkflowPhaseStableCommand;

export type LifecycleIntentSemanticAssertionsV1 = LifecycleIntentAuthorizationV1;

export interface LifecycleIntentWitnessV1 {
  readonly lifecycleIntentWitnessVersion: 1;
  readonly intent: LifecycleIntentPreimageV1;
  readonly persistedAssertions: TrustedLifecycleIntentAssertionsV1;
}

export interface BuiltLifecycleIntentWitnessV1 {
  readonly intentHash: string;
  readonly source: string;
  readonly witness: LifecycleIntentWitnessV1;
}

const MAX_WITNESS_BYTES = 1_048_576;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const BEARER_CANARY = /(?:pmcap1|pmrap1)\./i;
const ACTOR_ROLES = new Set<LifecycleIntentActorRole>([
  "primary",
  "maintenance",
  "untrusted",
]);
const CAPABILITY_KINDS = new Set<CapabilityKind>([
  "root-session-handle",
  "root-resume-token",
  "child-session-handle",
]);
const FORBIDDEN_KEYS = new Set([
  "approval",
  "bearer",
  "bindingGeneration",
  "candidateIntentHash",
  "childBindingGrant",
  "claim",
  "claimExpiresAt",
  "claimOwnerId",
  "claimToken",
  "contextFingerprint",
  "environment",
  "projectBindingId",
  "proof",
  "proofDigest",
  "proofFingerprint",
  "proofNonce",
  "proofVersion",
  "rawEvidence",
  "resumeToken",
  "secret",
]);
const ASSERTION_KEYS = [
  "authorizationKind",
  "authorizationSessionId",
  "targetSessionId",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "clientNamespace",
  "capabilityKind",
  "capabilityGeneration",
  "presentingActorRole",
  "presentingClientInstanceId",
  "targetActorRole",
  "targetClientInstanceId",
  "internalWorkflowId",
  "internalWorkflowGeneration",
  "internalPlannedWorkId",
] as const;
const INTERNAL_STABLE_BASE_KEYS = [
  "commandType",
  "commandId",
  "idempotencyKey",
  "agentId",
  "expectedProjectId",
  "expectedVaultId",
  "expectedWorkspaceId",
  "expectedBranchRef",
  "workflowId",
  "workflowGeneration",
  "plannedWorkId",
] as const;

export class LifecycleIntentWitnessError extends Error {
  readonly code = "LIFECYCLE_INTENT_WITNESS_INVALID";

  constructor() {
    super("LIFECYCLE_INTENT_WITNESS_INVALID");
    this.name = "LifecycleIntentWitnessError";
  }
}

function invalid(): never {
  throw new LifecycleIntentWitnessError();
}

function noSecrets(value: unknown): void {
  if (typeof value === "string") {
    if (BEARER_CANARY.test(value)) invalid();
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) noSecrets(child);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) invalid();
    noSecrets(child);
  }
}

function nullableSessionId(value: unknown, field: string): string | null {
  return value === null ? null : parseLifecycleId(value, field);
}

function decodeAssertions(value: unknown): TrustedLifecycleIntentAssertionsV1 {
  const assertions = exactRecord(
    value,
    ASSERTION_KEYS,
    "lifecycleIntent.persistedAssertions",
  );
  const authorizationKind = assertions.authorizationKind;
  if (
    authorizationKind !== "initial-authority"
    && authorizationKind !== "protected"
    && authorizationKind !== "internal-workflow"
  ) invalid();
  const presentingActorRole = assertions.presentingActorRole;
  const targetActorRole = assertions.targetActorRole;
  if (!ACTOR_ROLES.has(presentingActorRole as LifecycleIntentActorRole)
    || !ACTOR_ROLES.has(targetActorRole as LifecycleIntentActorRole)) invalid();
  const decoded: TrustedLifecycleIntentAssertionsV1 = {
    authorizationKind,
    authorizationSessionId: nullableSessionId(
      assertions.authorizationSessionId,
      "lifecycleIntent.authorizationSessionId",
    ),
    targetSessionId: parseLifecycleId(
      assertions.targetSessionId,
      "lifecycleIntent.targetSessionId",
    ),
    projectId: parseLifecycleId(assertions.projectId, "lifecycleIntent.projectId"),
    vaultId: parseLifecycleId(assertions.vaultId, "lifecycleIntent.vaultId"),
    storeId: parseLifecycleId(assertions.storeId, "lifecycleIntent.storeId"),
    workspaceId: typeof assertions.workspaceId === "string" && LOWER_HASH.test(assertions.workspaceId)
      ? assertions.workspaceId
      : invalid(),
    clientNamespace: parseBoundedString(
      assertions.clientNamespace,
      "lifecycleIntent.clientNamespace",
      256,
    ),
    capabilityKind: assertions.capabilityKind === null
      ? null
      : CAPABILITY_KINDS.has(assertions.capabilityKind as CapabilityKind)
        ? assertions.capabilityKind as CapabilityKind
        : invalid(),
    capabilityGeneration: assertions.capabilityGeneration === null
      ? null
      : parseDecimalString(
          assertions.capabilityGeneration,
          "lifecycleIntent.capabilityGeneration",
        ),
    presentingActorRole: presentingActorRole as LifecycleIntentActorRole,
    presentingClientInstanceId: parseBoundedString(
      assertions.presentingClientInstanceId,
      "lifecycleIntent.presentingClientInstanceId",
      256,
    ),
    targetActorRole: targetActorRole as LifecycleIntentActorRole,
    targetClientInstanceId: parseBoundedString(
      assertions.targetClientInstanceId,
      "lifecycleIntent.targetClientInstanceId",
      256,
    ),
    internalWorkflowId: assertions.internalWorkflowId === null
      ? null
      : parseLifecycleId(assertions.internalWorkflowId, "lifecycleIntent.internalWorkflowId"),
    internalWorkflowGeneration: assertions.internalWorkflowGeneration === null
      ? null
      : parseInteger(
          assertions.internalWorkflowGeneration,
          "lifecycleIntent.internalWorkflowGeneration",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
    internalPlannedWorkId: assertions.internalPlannedWorkId === null
      ? null
      : typeof assertions.internalPlannedWorkId === "string"
        && LOWER_HASH.test(assertions.internalPlannedWorkId)
        ? assertions.internalPlannedWorkId
        : invalid(),
  };
  const internalPresent = decoded.internalWorkflowId !== null
    || decoded.internalWorkflowGeneration !== null
    || decoded.internalPlannedWorkId !== null;
  const capabilityPresent = decoded.capabilityKind !== null
    || decoded.capabilityGeneration !== null;
  if ((decoded.capabilityKind === null) !== (decoded.capabilityGeneration === null)) invalid();
  if (authorizationKind === "initial-authority") {
    if (decoded.authorizationSessionId !== null || internalPresent || capabilityPresent) invalid();
  } else if (authorizationKind === "protected") {
    if (decoded.authorizationSessionId === null || internalPresent) invalid();
  } else if (
    decoded.authorizationSessionId === null
    || capabilityPresent
    || decoded.internalWorkflowId === null
    || decoded.internalWorkflowGeneration === null
    || decoded.internalPlannedWorkId === null
  ) invalid();
  return Object.freeze(decoded);
}

function validateStableBase(command: Record<string, unknown>): void {
  parseLifecycleId(command.commandId, "lifecycleIntent.commandId");
  parseBoundedString(command.idempotencyKey, "lifecycleIntent.idempotencyKey", 1_024);
  parseBoundedString(command.agentId, "lifecycleIntent.agentId", 256);
  parseLifecycleId(command.expectedProjectId, "lifecycleIntent.expectedProjectId");
  parseLifecycleId(command.expectedVaultId, "lifecycleIntent.expectedVaultId");
  if (typeof command.expectedWorkspaceId !== "string" || !LOWER_HASH.test(command.expectedWorkspaceId)) {
    invalid();
  }
  parseNullableBoundedString(command.expectedBranchRef, "lifecycleIntent.expectedBranchRef", 1_024);
  parseLifecycleId(command.workflowId, "lifecycleIntent.workflowId");
  parseInteger(
    command.workflowGeneration,
    "lifecycleIntent.workflowGeneration",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (typeof command.plannedWorkId !== "string" || !LOWER_HASH.test(command.plannedWorkId)) {
    invalid();
  }
}

function decodeValidationStableCommand(value: unknown): InternalValidationStableCommand {
  const stable = exactRecord(
    value,
    [...INTERNAL_STABLE_BASE_KEYS, "attemptPlan", "result"],
    "lifecycleIntent.internalValidationCommand",
  );
  if (stable.commandType !== "internal-validation-result") invalid();
  const withSyntheticClaim = {
    ...stable,
    claim: {
      workflowId: stable.workflowId,
      workflowGeneration: stable.workflowGeneration,
      claimOwnerId: "00000000-0000-4000-8000-000000000001",
      claimToken: "1",
      claimExpiresAt: "2000-01-01T00:00:00.000Z",
    },
  } as unknown as InternalValidationResultCommand;
  assertInternalValidationResultBinding(withSyntheticClaim);
  return Object.freeze(stable) as unknown as InternalValidationStableCommand;
}

function decodeValidationResultIds(value: unknown, field: string): readonly ValidationResultId[] {
  const items = strictArray(value, field);
  if (items.length === 0 || items.length > 64) invalid();
  const ids = items.map((item, index) =>
    parseLifecycleId<ValidationResultId>(item, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) invalid();
  return Object.freeze(ids);
}

function decodePhaseAction(value: unknown): InternalWorkflowPhaseCommand["action"] {
  const source = exactRecord(value, Object.keys(value as object), "lifecycleIntent.action");
  switch (source.action) {
    case "record-final-checkpoint-and-queue-ending": {
      const action = exactRecord(
        value,
        ["action", "finalCheckpoint", "materializationTarget"],
        "lifecycleIntent.action",
      );
      return Object.freeze({
        action: source.action,
        finalCheckpoint: decodeCheckpointV1(action.finalCheckpoint),
        materializationTarget: parseBoundedString(
          action.materializationTarget,
          "lifecycleIntent.action.materializationTarget",
          1_024,
        ),
      });
    }
    case "record-verification-failed": {
      const action = exactRecord(
        value,
        ["action", "validationResultIds", "safeFailureCode"],
        "lifecycleIntent.action",
      );
      return Object.freeze({
        action: source.action,
        validationResultIds: decodeValidationResultIds(
          action.validationResultIds,
          "lifecycleIntent.action.validationResultIds",
        ),
        safeFailureCode: parseBoundedString(
          action.safeFailureCode,
          "lifecycleIntent.action.safeFailureCode",
          128,
        ),
      });
    }
    case "record-verification-passed": {
      const action = exactRecord(
        value,
        ["action", "validationResultIds", "qualityScore"],
        "lifecycleIntent.action",
      );
      return Object.freeze({
        action: source.action,
        validationResultIds: decodeValidationResultIds(
          action.validationResultIds,
          "lifecycleIntent.action.validationResultIds",
        ),
        qualityScore: parseInteger(
          action.qualityScore,
          "lifecycleIntent.action.qualityScore",
          0,
          10_000,
        ),
      });
    }
    case "invalidate-verification": {
      const action = exactRecord(
        value,
        ["action", "safeFailureCode"],
        "lifecycleIntent.action",
      );
      if (action.safeFailureCode !== "SESSION_SOURCE_STATE_CONFLICT") invalid();
      return Object.freeze({
        action: source.action,
        safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
      });
    }
    case "append-terminal-completion": {
      const action = exactRecord(
        value,
        ["action", "verificationEventPosition", "materializationTarget"],
        "lifecycleIntent.action",
      );
      return Object.freeze({
        action: source.action,
        verificationEventPosition: parseDecimalString(
          action.verificationEventPosition,
          "lifecycleIntent.action.verificationEventPosition",
        ),
        materializationTarget: parseBoundedString(
          action.materializationTarget,
          "lifecycleIntent.action.materializationTarget",
          1_024,
        ),
      });
    }
    default:
      return invalid();
  }
}

function decodePhaseStableCommand(value: unknown): InternalWorkflowPhaseStableCommand {
  const stable = exactRecord(
    value,
    [...INTERNAL_STABLE_BASE_KEYS, "sourcePhase", "action"],
    "lifecycleIntent.internalPhaseCommand",
  );
  if (stable.commandType !== "internal-workflow-phase") invalid();
  validateStableBase(stable);
  return Object.freeze({
    ...stable,
    commandType: "internal-workflow-phase",
    sourcePhase: parseBoundedString(
      stable.sourcePhase,
      "lifecycleIntent.sourcePhase",
      128,
    ),
    action: decodePhaseAction(stable.action),
  }) as unknown as InternalWorkflowPhaseStableCommand;
}

function decodeStableCommand(value: unknown): LifecycleIntentCommandV1 {
  const record = exactRecord(value, Object.keys(value as object), "lifecycleIntent.command");
  if (record.commandType === "internal-validation-result") {
    return decodeValidationStableCommand(value);
  }
  if (record.commandType === "internal-workflow-phase") {
    return decodePhaseStableCommand(value);
  }
  return decodeLifecycleSemanticCommandDraft(value);
}

function stableInternalCommand(command: InternalWorkflowSemanticCommand):
  InternalValidationStableCommand | InternalWorkflowPhaseStableCommand {
  const input = exactRecord(
    command,
    command.commandType === "internal-validation-result"
      ? [...INTERNAL_STABLE_BASE_KEYS, "attemptPlan", "claim", "result"]
      : [...INTERNAL_STABLE_BASE_KEYS, "sourcePhase", "claim", "action"],
    "lifecycleIntent.internalCommand",
  );
  const claim = exactRecord(
    input.claim,
    ["workflowId", "workflowGeneration", "claimOwnerId", "claimToken", "claimExpiresAt"],
    "lifecycleIntent.claim",
  );
  if (
    claim.workflowId !== input.workflowId
    || claim.workflowGeneration !== input.workflowGeneration
  ) invalid();
  parseLifecycleId(claim.claimOwnerId, "lifecycleIntent.claim.claimOwnerId");
  parseDecimalString(claim.claimToken, "lifecycleIntent.claim.claimToken");
  parseCanonicalTimestamp(claim.claimExpiresAt, "lifecycleIntent.claim.claimExpiresAt");
  const { claim: _volatileClaim, ...stable } = input;
  return input.commandType === "internal-validation-result"
    ? decodeValidationStableCommand(stable)
    : decodePhaseStableCommand(stable);
}

function assertExternalSessionBinding(
  command: LifecycleSemanticCommandDraft,
  assertions: TrustedLifecycleIntentAssertionsV1,
): void {
  if (
    command.expectedProjectId !== assertions.projectId
    || command.expectedVaultId !== assertions.vaultId
    || command.expectedWorkspaceId !== assertions.workspaceId
  ) invalid();
  if (command.commandType === "root-start") {
    if (assertions.authorizationKind !== "initial-authority") invalid();
    return;
  }
  if (assertions.authorizationKind !== "protected" || assertions.authorizationSessionId === null) {
    invalid();
  }
  const authority = assertions.authorizationSessionId;
  const target = assertions.targetSessionId;
  switch (command.commandType) {
    case "root-resume":
      if (command.sessionId === null) {
        if (authority !== target) invalid();
      } else if (authority !== command.sessionId || target !== command.sessionId) invalid();
      return;
    case "root-recovery":
    case "root-suspend":
    case "record-checkpoint":
    case "amend-session-end":
    case "cancel-session-end":
    case "abandon-session":
      if (authority !== command.sessionId || target !== command.sessionId) invalid();
      return;
    case "fork-child":
      if (authority !== command.parentSessionId || target !== command.parentSessionId) invalid();
      return;
    case "amend-child-assignment":
    case "disposition-child-report":
    case "complete-child-session":
    case "suspend-child-session":
    case "create-child-transfer":
      if (authority !== command.parentSessionId || target !== command.childSessionId) invalid();
      return;
    case "record-evidence-batch":
      if (target !== command.sessionId) invalid();
      return;
    case "record-child-report":
      if (target !== command.childSessionId
        || (authority !== command.childSessionId && authority !== command.parentSessionId)) invalid();
      return;
    case "propose-child-completion":
      if (authority !== command.childSessionId || target !== command.childSessionId) invalid();
      return;
    case "claim-child-transfer":
      if (authority !== command.rootSessionId || target !== command.rootSessionId) invalid();
      return;
    case "request-session-end":
      if (authority !== command.request.sessionId || target !== command.request.sessionId) invalid();
      return;
  }
}

function normalize(
  command: LifecycleSemanticCommandDraft | InternalWorkflowSemanticCommand,
  assertionsInput: TrustedLifecycleIntentAssertionsV1,
): BuiltLifecycleIntentWitnessV1 {
  const assertions = decodeAssertions(assertionsInput);
  let stable: LifecycleIntentCommandV1;
  if (
    command.commandType === "internal-validation-result"
    || command.commandType === "internal-workflow-phase"
  ) {
    if (
      assertions.authorizationKind !== "internal-workflow"
      || assertions.internalWorkflowId !== command.workflowId
      || assertions.internalWorkflowGeneration !== command.workflowGeneration
      || assertions.internalPlannedWorkId !== command.plannedWorkId
    ) invalid();
    stable = stableInternalCommand(command);
  } else {
    const decoded = decodeLifecycleSemanticCommandDraft(command);
    assertExternalSessionBinding(decoded, assertions);
    stable = decoded;
  }
  return normalizeStable(stable, assertions);
}

function normalizeStable(
  command: LifecycleIntentCommandV1,
  assertions: TrustedLifecycleIntentAssertionsV1,
): BuiltLifecycleIntentWitnessV1 {
  if (
    command.expectedProjectId !== assertions.projectId
    || command.expectedVaultId !== assertions.vaultId
    || command.expectedWorkspaceId !== assertions.workspaceId
  ) invalid();
  const internal = command.commandType === "internal-validation-result"
    || command.commandType === "internal-workflow-phase";
  if (internal) {
    if (
      assertions.authorizationKind !== "internal-workflow"
      || assertions.internalWorkflowId !== command.workflowId
      || assertions.internalWorkflowGeneration !== command.workflowGeneration
      || assertions.internalPlannedWorkId !== command.plannedWorkId
    ) invalid();
  } else {
    assertExternalSessionBinding(command, assertions);
  }
  const authorization: LifecycleIntentSemanticAssertionsV1 = Object.freeze({
    authorizationKind: assertions.authorizationKind,
    authorizationSessionId: assertions.authorizationSessionId,
    targetSessionId: assertions.authorizationKind === "initial-authority"
      ? null
      : assertions.targetSessionId,
    capabilityKind: assertions.capabilityKind,
    capabilityGeneration: assertions.capabilityGeneration,
    presentingActorRole: assertions.presentingActorRole,
    presentingClientInstanceId: assertions.presentingClientInstanceId,
    targetActorRole: assertions.targetActorRole,
    targetClientInstanceId: assertions.targetClientInstanceId,
    internalWorkflowId: assertions.internalWorkflowId,
    internalWorkflowGeneration: assertions.internalWorkflowGeneration,
    internalPlannedWorkId: assertions.internalPlannedWorkId,
  });
  const intent = canonicalLifecycleIntentPreimage(command, {
    projectId: assertions.projectId,
    vaultId: assertions.vaultId,
    storeId: assertions.storeId,
    workspaceId: assertions.workspaceId,
    clientNamespace: assertions.clientNamespace,
  }, authorization);
  const witness: LifecycleIntentWitnessV1 = Object.freeze({
    lifecycleIntentWitnessVersion: 1,
    intent,
    persistedAssertions: assertions,
  });
  noSecrets(witness);
  const source = canonicalJson(witness);
  return Object.freeze({
    intentHash: canonicalLifecycleIntentHash(intent),
    source,
    witness,
  });
}

/**
 * The sole writer-facing builder. Both arguments are independently strict-
 * decoded at runtime; callers cannot provide arbitrary hash material.
 */
export function buildLifecycleIntentWitness(
  command: LifecycleSemanticCommandDraft | InternalWorkflowSemanticCommand,
  persistedAssertions: TrustedLifecycleIntentAssertionsV1,
): BuiltLifecycleIntentWitnessV1 {
  try {
    return normalize(command, persistedAssertions);
  } catch (error) {
    if (error instanceof LifecycleIntentWitnessError) throw error;
    return invalid();
  }
}

export function decodeLifecycleIntentWitness(source: string): LifecycleIntentWitnessV1 {
  if (
    typeof source !== "string"
    || source.length === 0
    || Buffer.byteLength(source, "utf8") > MAX_WITNESS_BYTES
  ) invalid();
  try {
    const value = JSON.parse(source) as unknown;
    const witness = exactRecord(
      value,
      ["lifecycleIntentWitnessVersion", "intent", "persistedAssertions"],
      "lifecycleIntent.witness",
    );
    if (witness.lifecycleIntentWitnessVersion !== 1 || canonicalJson(value) !== source) invalid();
    const persistedAssertions = decodeAssertions(witness.persistedAssertions);
    const intent = exactRecord(
      witness.intent,
      ["lifecycleIntentVersion", "command", "binding", "authorization"],
      "lifecycleIntent.intent",
    );
    if (intent.lifecycleIntentVersion !== 1) invalid();
    const command = decodeStableCommand(intent.command);
    const normalized = normalizeStable(command, persistedAssertions);
    if (normalized.source !== source) invalid();
    return normalized.witness;
  } catch (error) {
    if (error instanceof LifecycleIntentWitnessError) throw error;
    return invalid();
  }
}

export function lifecycleIntentHashFromWitnessSource(source: string): string {
  const witness = decodeLifecycleIntentWitness(source);
  return canonicalLifecycleIntentHash(witness.intent);
}
