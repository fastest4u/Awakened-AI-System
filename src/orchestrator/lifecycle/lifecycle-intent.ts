import { createHash } from "node:crypto";
import type { ProjectContext } from "../identity/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  decodeLifecycleSemanticCommandDraft,
  type LifecycleAudience,
  type LifecycleSemanticCommandDraft,
} from "./contracts/commands.js";
import { LifecycleError } from "./errors.js";
import type { CapabilityKind } from "./authority/capability-key-provider.js";

export type LifecycleIntentAuthorizationKind =
  | "initial-authority"
  | "protected"
  | "internal-workflow";

export type LifecycleIntentActorRole = "primary" | "maintenance" | "untrusted";

export interface StableLifecycleIntentBindingV1 {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
}

export interface LifecycleIntentAuthorizationV1 {
  readonly authorizationKind: LifecycleIntentAuthorizationKind;
  readonly authorizationSessionId: string | null;
  readonly targetSessionId: string | null;
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

export interface LifecycleIntentPreimageV1 {
  readonly lifecycleIntentVersion: 1;
  readonly command: LifecycleSemanticCommandDraft | Readonly<Record<string, unknown>>;
  readonly binding: StableLifecycleIntentBindingV1;
  readonly authorization: LifecycleIntentAuthorizationV1;
}

export interface LifecycleIntentInputV1 {
  readonly context: ProjectContext;
  readonly command: LifecycleSemanticCommandDraft;
  readonly authorizationKind: LifecycleIntentAuthorizationKind;
  readonly authoritySessionId: string | null;
  readonly targetSessionId: string | null;
  readonly capabilityKind: CapabilityKind | null;
  readonly capabilityGeneration: string | null;
  readonly audience: LifecycleAudience;
  readonly internalWorkflowId: string | null;
  readonly internalWorkflowGeneration: number | null;
  readonly internalPlannedWorkId: string | null;
}

export function assertEvidenceLifecycleIntentAuthorizationV1(
  authorization: LifecycleIntentAuthorizationV1,
  targetSessionId: string,
): void {
  const self = authorization.authorizationSessionId === targetSessionId;
  if (
    authorization.authorizationKind !== "protected"
    || authorization.targetSessionId !== targetSessionId
    || authorization.authorizationSessionId === null
    || authorization.capabilityGeneration === null
    || authorization.internalWorkflowId !== null
    || authorization.internalWorkflowGeneration !== null
    || authorization.internalPlannedWorkId !== null
    || authorization.targetActorRole !== authorization.presentingActorRole
    || authorization.targetClientInstanceId !== authorization.presentingClientInstanceId
    || (
      authorization.presentingActorRole === "primary"
        ? authorization.capabilityKind !== "root-session-handle"
        : authorization.presentingActorRole === "untrusted"
          ? !self || authorization.capabilityKind !== "child-session-handle"
          : true
    )
  ) invalid();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const ROLES = new Set<LifecycleIntentActorRole>(["primary", "maintenance", "untrusted"]);
const CAPABILITY_KINDS = new Set<CapabilityKind>([
  "root-session-handle",
  "root-resume-token",
  "child-session-handle",
]);

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function nonempty(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum;
}

function capabilityGeneration(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) return false;
  const generation = BigInt(value);
  return generation > 0n && generation <= MAX_INT64;
}

function canonicalBinding(binding: StableLifecycleIntentBindingV1): StableLifecycleIntentBindingV1 {
  if (
    !UUID.test(binding.projectId)
    || !UUID.test(binding.vaultId)
    || !UUID.test(binding.storeId)
    || !HASH.test(binding.workspaceId)
    || !nonempty(binding.clientNamespace, 256)
  ) invalid();
  return Object.freeze({
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    clientNamespace: binding.clientNamespace,
  });
}

function canonicalAuthorization(
  authorization: LifecycleIntentAuthorizationV1,
): LifecycleIntentAuthorizationV1 {
  if (
    !["initial-authority", "protected", "internal-workflow"].includes(authorization.authorizationKind)
    || (authorization.authorizationSessionId !== null && !UUID.test(authorization.authorizationSessionId))
    || (authorization.targetSessionId !== null && !UUID.test(authorization.targetSessionId))
    || (authorization.capabilityKind !== null && !CAPABILITY_KINDS.has(authorization.capabilityKind))
    || (authorization.capabilityGeneration !== null && !capabilityGeneration(authorization.capabilityGeneration))
    || !ROLES.has(authorization.presentingActorRole)
    || !nonempty(authorization.presentingClientInstanceId, 256)
    || !ROLES.has(authorization.targetActorRole)
    || !nonempty(authorization.targetClientInstanceId, 256)
    || (authorization.internalWorkflowId !== null && !UUID.test(authorization.internalWorkflowId))
    || (
      authorization.internalWorkflowGeneration !== null
      && (!Number.isSafeInteger(authorization.internalWorkflowGeneration) || authorization.internalWorkflowGeneration < 1)
    )
    || (authorization.internalPlannedWorkId !== null && !HASH.test(authorization.internalPlannedWorkId))
    || ((authorization.capabilityKind === null) !== (authorization.capabilityGeneration === null))
  ) invalid();
  if (
    authorization.authorizationKind === "initial-authority"
    && (
      authorization.authorizationSessionId !== null
      || authorization.targetSessionId !== null
      || authorization.capabilityKind !== null
      || authorization.internalWorkflowId !== null
      || authorization.internalWorkflowGeneration !== null
      || authorization.internalPlannedWorkId !== null
    )
  ) invalid();
  if (
    authorization.authorizationKind === "protected"
    && (
      authorization.authorizationSessionId === null
      || authorization.targetSessionId === null
    )
  ) invalid();
  if (
    authorization.authorizationKind === "internal-workflow"
    && (
      authorization.authorizationSessionId === null
      || authorization.targetSessionId === null
      || authorization.capabilityKind !== null
      || authorization.internalWorkflowId === null
      || authorization.internalWorkflowGeneration === null
      || authorization.internalPlannedWorkId === null
    )
  ) invalid();
  if (
    authorization.authorizationKind !== "internal-workflow"
    && (
      authorization.internalWorkflowId !== null
      || authorization.internalWorkflowGeneration !== null
      || authorization.internalPlannedWorkId !== null
    )
  ) invalid();
  return Object.freeze({
    authorizationKind: authorization.authorizationKind,
    authorizationSessionId: authorization.authorizationSessionId,
    targetSessionId: authorization.targetSessionId,
    capabilityKind: authorization.capabilityKind,
    capabilityGeneration: authorization.capabilityGeneration,
    presentingActorRole: authorization.presentingActorRole,
    presentingClientInstanceId: authorization.presentingClientInstanceId,
    targetActorRole: authorization.targetActorRole,
    targetClientInstanceId: authorization.targetClientInstanceId,
    internalWorkflowId: authorization.internalWorkflowId,
    internalWorkflowGeneration: authorization.internalWorkflowGeneration,
    internalPlannedWorkId: authorization.internalPlannedWorkId,
  });
}

export function canonicalLifecycleIntentPreimage(
  command: LifecycleIntentPreimageV1["command"],
  binding: StableLifecycleIntentBindingV1,
  authorization: LifecycleIntentAuthorizationV1,
): LifecycleIntentPreimageV1 {
  return Object.freeze({
    lifecycleIntentVersion: 1,
    command,
    binding: canonicalBinding(binding),
    authorization: canonicalAuthorization(authorization),
  });
}

export function lifecycleIntentPreimage(input: LifecycleIntentInputV1): LifecycleIntentPreimageV1 {
  const command = decodeLifecycleSemanticCommandDraft(input.command);
  const binding = input.context.binding;
  return canonicalLifecycleIntentPreimage(command, {
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    clientNamespace: binding.clientNamespace,
  }, {
    authorizationKind: input.authorizationKind,
    authorizationSessionId: input.authoritySessionId,
    targetSessionId: input.targetSessionId,
    capabilityKind: input.capabilityKind,
    capabilityGeneration: input.capabilityGeneration,
    presentingActorRole: input.audience.presentingActorRole,
    presentingClientInstanceId: input.audience.presentingClientInstanceId,
    targetActorRole: input.audience.targetActorRole,
    targetClientInstanceId: input.audience.targetClientInstanceId,
    internalWorkflowId: input.internalWorkflowId,
    internalWorkflowGeneration: input.internalWorkflowGeneration,
    internalPlannedWorkId: input.internalPlannedWorkId,
  });
}

export function lifecycleIntentCanonicalJson(input: LifecycleIntentInputV1): string {
  return canonicalJson(lifecycleIntentPreimage(input));
}

export function lifecycleIntentHash(input: LifecycleIntentInputV1): string {
  return createHash("sha256")
    .update(lifecycleIntentCanonicalJson(input), "utf8")
    .digest("hex");
}

export function canonicalLifecycleIntentHash(preimage: LifecycleIntentPreimageV1): string {
  return createHash("sha256")
    .update(canonicalJson(preimage), "utf8")
    .digest("hex");
}
