import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonValue } from "../../contracts/event.js";
import type { ProjectContext } from "../../identity/contracts.js";
import { canonicalJson } from "../../serialization/canonical-json.js";
import {
  CapabilityService,
  type AuthorityMaterialDescriptorV1,
  type AuthorityMaterialStatus,
  type LifecycleAuthorityTarget,
  type RootOrChildAuthorityMaterial,
  type StoredCapabilityMaterialV1,
} from "../capability.service.js";
import {
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
  type LifecycleAudience,
  type CapabilityProofV1,
  type LifecycleSemanticCommandDraft,
  type PreparedLifecycleWorkerCommand,
  type RedactedChildBindingGrant,
  type RedactedLifecycleApproval,
  type SemanticCommandAuthorization,
} from "../contracts/commands.js";
import {
  exactRecord,
  strictArray,
  strictRecord,
} from "../contracts/identifiers.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
  type LifecycleErrorCode,
} from "../errors.js";
import { lifecycleIntentHash } from "../lifecycle-intent.js";
import {
  verifyAbandonmentApproval,
  verifyRecoveryApproval,
  type ApprovalVerificationExpectationV1,
} from "./approval-codec.js";
import {
  createCapabilityProof,
  decodeCapabilityClaims,
  verifyCapability,
  type SemanticCommandProofTargetV1,
} from "./capability-codec.js";
import type {
  CapabilityKeyProvider,
  CapabilityKind,
} from "./capability-key-provider.js";
import {
  destroyPendingAuthorization,
  type PendingAuthorizationStore,
  type PendingCommandIdentity,
  type PendingPrivateAuthorization,
  type PendingSemanticCommandRecordV1,
  type StableLifecycleBindingWitnessV1,
} from "./pending-authorization.store.js";
import { SecretString } from "./redacted-secret.js";

export const CHILD_BINDING_GRANT_DOMAIN = "pm-lifecycle-child-binding-grant-v1";
const CHILD_BINDING_GRANT_DIGEST_DOMAIN = "project-memory/child-binding-grant-digest/v1\n";

export type PrivateLifecycleAuthorization =
  | { readonly kind: "initial-authority" }
  | {
      readonly kind: "protected";
      readonly bearer: SecretString | null;
      readonly approval: SecretString | null;
      readonly childBindingGrant: SecretString | null;
    };

export interface RevalidatedTrustedLifecycleContext {
  readonly context: ProjectContext;
  readonly authoritySessionId: string | null;
  readonly targetSessionId: string | null;
  readonly capabilityKind: CapabilityKind | null;
  readonly capabilityGeneration: string | null;
  readonly authorityTarget: LifecycleAuthorityTarget;
  readonly targetBindingFingerprint: string | null;
}

export interface ChildBindingGrantV1 {
  readonly grantVersion: 1;
  readonly grantId: string;
  readonly projectId: string;
  readonly storeId: string;
  readonly parentSessionId: string;
  readonly targetActorRole: "untrusted";
  readonly targetClientInstanceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly bindingFingerprint: string;
  readonly mac: string;
}

export interface PrivateAuthorityChannel {
  isAttached(target: LifecycleAuthorityTarget): boolean;
  isLocalTarget(target: LifecycleAuthorityTarget): boolean;
  deliverLocal(target: LifecycleAuthorityTarget, material: RootOrChildAuthorityMaterial): Promise<void>;
  routeDescriptor(target: LifecycleAuthorityTarget, descriptor: AuthorityMaterialDescriptorV1): Promise<void>;
}

export interface AuthorityAdapterClock {
  nowMs(): bigint;
}

export interface AuthorityAdapterNonceSource {
  uuid(): string;
}

export type AuthorityDeliveryRecoveryCode =
  | "SESSION_HANDLE_STALE"
  | "SESSION_CAPABILITY_KEY_UNAVAILABLE"
  | "AUTHORITY_TARGET_DETACHED";

export interface WorkerAuthorityMaterialResultV1 {
  readonly status: AuthorityMaterialStatus;
  readonly target: LifecycleAuthorityTarget | null;
  readonly authorityCommitment: string | null;
  readonly capabilityGeneration: string | null;
  readonly descriptor: AuthorityMaterialDescriptorV1 | null;
  readonly recoveryCode: Exclude<AuthorityDeliveryRecoveryCode, "AUTHORITY_TARGET_DETACHED"> | null;
}

export type WorkerLifecycleResult<T extends JsonValue> =
  | {
      readonly kind: "success";
      readonly publicResult: T;
      readonly authorityMaterial: WorkerAuthorityMaterialResultV1;
    }
  | {
      readonly kind: "rejected";
      readonly errorCode: Exclude<LifecycleErrorCode, "COMMAND_OUTCOME_UNKNOWN">;
    }
  | {
      readonly kind: "unknown";
      readonly errorCode: "COMMAND_OUTCOME_UNKNOWN";
    };

export interface LifecycleExecutionResult<T extends JsonValue> {
  readonly publicResult: T;
  readonly authorityMaterialStatus: AuthorityMaterialStatus;
  readonly recoveryCode: AuthorityDeliveryRecoveryCode | null;
}

export interface AuthorityMaterialAdapterOptions {
  readonly pendingStore: PendingAuthorizationStore;
  readonly keyProvider: CapabilityKeyProvider;
  readonly capabilityService: CapabilityService;
  readonly channel: PrivateAuthorityChannel;
  readonly clock: AuthorityAdapterClock;
  readonly nonceSource: AuthorityAdapterNonceSource;
}

interface DerivedContext {
  readonly projectContext: ProjectContext;
  readonly presenter: {
    readonly actorRole: "primary" | "maintenance" | "untrusted";
    readonly clientInstanceId: string;
  };
  readonly target: LifecycleAuthorityTarget;
  readonly audience: LifecycleAudience;
  readonly authoritySessionId: string | null;
  readonly targetSessionId: string | null;
  readonly capabilityKind: CapabilityKind | null;
  readonly capabilityGeneration: string | null;
  readonly targetBindingFingerprint: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAPABILITY_KINDS = new Set<CapabilityKind>([
  "root-session-handle",
  "root-resume-token",
  "child-session-handle",
]);
const TERMINAL_CODES = new Set<LifecycleErrorCode>(LIFECYCLE_ERROR_CODES);

function invalid(): never {
  throw new LifecycleError("SESSION_CAPABILITY_INVALID");
}

function conflict(): never {
  throw new LifecycleError("IDEMPOTENCY_CONFLICT");
}

function unavailable(): never {
  throw new LifecycleError("SESSION_CAPABILITY_KEY_UNAVAILABLE");
}

function exact(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  try {
    return exactRecord(value, keys, field, "SESSION_CAPABILITY_INVALID");
  } catch {
    return invalid();
  }
}

function bounded(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function positiveGeneration(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) return false;
  const decoded = BigInt(value);
  return decoded > 0n && decoded <= 9_223_372_036_854_775_807n;
}

function decodeTarget(value: unknown): LifecycleAuthorityTarget {
  const target = exact(value, ["actorRole", "clientInstanceId"], "authorityTarget");
  if (
    (target.actorRole !== "primary" && target.actorRole !== "untrusted")
    || !bounded(target.clientInstanceId, 256)
  ) invalid();
  return Object.freeze({
    actorRole: target.actorRole,
    clientInstanceId: target.clientInstanceId,
  });
}

function sameTarget(left: LifecycleAuthorityTarget, right: LifecycleAuthorityTarget): boolean {
  return left.actorRole === right.actorRole
    && left.clientInstanceId === right.clientInstanceId;
}

function stableBinding(context: DerivedContext): StableLifecycleBindingWitnessV1 {
  const binding = context.projectContext.binding;
  return Object.freeze({
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    clientNamespace: binding.clientNamespace,
    audience: Object.freeze({
      presentingActorRole: context.audience.presentingActorRole,
      presentingClientInstanceId: context.audience.presentingClientInstanceId,
      targetActorRole: context.audience.targetActorRole,
      targetClientInstanceId: context.audience.targetClientInstanceId,
    }),
  });
}

function stableMatches(
  expected: StableLifecycleBindingWitnessV1,
  actual: StableLifecycleBindingWitnessV1,
): boolean {
  return expected.projectId === actual.projectId
    && expected.vaultId === actual.vaultId
    && expected.storeId === actual.storeId
    && expected.workspaceId === actual.workspaceId
    && expected.clientNamespace === actual.clientNamespace
    && expected.audience.presentingActorRole === actual.audience.presentingActorRole
    && expected.audience.presentingClientInstanceId === actual.audience.presentingClientInstanceId
    && expected.audience.targetActorRole === actual.audience.targetActorRole
    && expected.audience.targetClientInstanceId === actual.audience.targetClientInstanceId;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === ""
    || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function assertHostPrivateRoot(
  store: PendingAuthorizationStore,
  context: ProjectContext,
): void {
  const privateRoot = store.privateStateRoot;
  if (
    typeof privateRoot !== "string"
    || !isAbsolute(privateRoot)
    || !sameFilesystemPath(privateRoot, resolve(privateRoot))
  ) invalid();
  for (const protectedRoot of [
    context.binding.projectRoot,
    context.binding.vaultRoot,
    context.binding.storeRoute.storeRoot,
  ]) {
    if (
      typeof protectedRoot !== "string"
      || !isAbsolute(protectedRoot)
      || pathIsWithin(protectedRoot, privateRoot)
    ) invalid();
  }
}

function validateClock(value: bigint): string {
  if (value < 0n || value > BigInt(8_640_000_000_000_000)) invalid();
  return new Date(Number(value)).toISOString();
}

function deriveContext(
  command: LifecycleSemanticCommandDraft,
  context: RevalidatedTrustedLifecycleContext,
  authorization: {
    readonly kind: "initial-authority" | "protected";
    readonly hasProof: boolean;
    readonly hasApproval: boolean;
    readonly hasGrant: boolean;
  },
): DerivedContext {
  if (typeof context !== "object" || context === null) invalid();
  const binding = context.context?.binding;
  if (
    binding === undefined
    || !UUID.test(binding.projectId)
    || !UUID.test(binding.vaultId)
    || !UUID.test(binding.storeId)
    || !HASH.test(binding.workspaceId)
    || !bounded(binding.clientNamespace, 256)
    || !bounded(binding.clientInstanceId, 256)
    || !["primary", "maintenance", "untrusted"].includes(binding.actorRole)
  ) invalid();
  const target = decodeTarget(context.authorityTarget);
  const presenter = Object.freeze({
    actorRole: binding.actorRole,
    clientInstanceId: binding.clientInstanceId,
  });
  const sessionPairValid = context.authoritySessionId === null
    ? context.targetSessionId === null
    : UUID.test(context.authoritySessionId) && UUID.test(context.targetSessionId ?? "");
  const capabilityPairValid = context.capabilityKind === null
    ? context.capabilityGeneration === null
    : CAPABILITY_KINDS.has(context.capabilityKind)
      && positiveGeneration(context.capabilityGeneration);
  if (!sessionPairValid || !capabilityPairValid) invalid();

  if (authorization.kind === "initial-authority") {
    if (
      command.commandType !== "root-start"
      || context.authoritySessionId !== null
      || context.targetSessionId !== null
      || context.capabilityKind !== null
      || context.capabilityGeneration !== null
      || presenter.actorRole !== "primary"
      || target.actorRole !== "primary"
      || target.clientInstanceId !== presenter.clientInstanceId
      || context.targetBindingFingerprint !== null
    ) invalid();
  } else {
    if (command.commandType === "root-start" || context.authoritySessionId === null) invalid();
    if (authorization.hasProof !== (context.capabilityKind !== null)) invalid();
    if (authorization.hasGrant) {
      if (
        command.commandType !== "fork-child"
        || !command.directAccessRequested
        || target.actorRole !== "untrusted"
        || typeof context.targetBindingFingerprint !== "string"
        || !HASH.test(context.targetBindingFingerprint)
      ) invalid();
    } else if (command.commandType === "root-recovery") {
      if (
        !authorization.hasApproval
        || target.actorRole !== "primary"
        || (presenter.actorRole !== "primary" && presenter.actorRole !== "maintenance")
        || context.targetBindingFingerprint !== null
      ) invalid();
    } else if (
      target.actorRole !== presenter.actorRole
      || target.clientInstanceId !== presenter.clientInstanceId
      || context.targetBindingFingerprint !== null
    ) invalid();
  }
  return Object.freeze({
    projectContext: context.context,
    presenter,
    target,
    audience: Object.freeze({
      presentingActorRole: presenter.actorRole,
      presentingClientInstanceId: presenter.clientInstanceId,
      targetActorRole: target.actorRole,
      targetClientInstanceId: target.clientInstanceId,
    }),
    authoritySessionId: context.authoritySessionId,
    targetSessionId: context.targetSessionId,
    capabilityKind: context.capabilityKind,
    capabilityGeneration: context.capabilityGeneration,
    targetBindingFingerprint: context.targetBindingFingerprint,
  });
}

function intentHash(command: LifecycleSemanticCommandDraft, context: DerivedContext): string {
  return lifecycleIntentHash({
    context: context.projectContext,
    command,
    authorizationKind: command.commandType === "root-start" ? "initial-authority" : "protected",
    authoritySessionId: context.authoritySessionId,
    targetSessionId: context.targetSessionId,
    capabilityKind: context.capabilityKind,
    capabilityGeneration: context.capabilityGeneration,
    audience: context.audience,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
}

function parseGrant(secret: SecretString): ChildBindingGrantV1 {
  return secret.withValue((value) => {
    if (!bounded(value, 131_072)) invalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return invalid();
    }
    const grant = exact(parsed, [
      "grantVersion",
      "grantId",
      "projectId",
      "storeId",
      "parentSessionId",
      "targetActorRole",
      "targetClientInstanceId",
      "issuedAt",
      "expiresAt",
      "bindingFingerprint",
      "mac",
    ], "childBindingGrant");
    if (
      canonicalJson(parsed) !== value
      || grant.grantVersion !== 1
      || typeof grant.grantId !== "string" || !UUID.test(grant.grantId)
      || typeof grant.projectId !== "string" || !UUID.test(grant.projectId)
      || typeof grant.storeId !== "string" || !UUID.test(grant.storeId)
      || typeof grant.parentSessionId !== "string" || !UUID.test(grant.parentSessionId)
      || grant.targetActorRole !== "untrusted"
      || !bounded(grant.targetClientInstanceId, 256)
      || !timestamp(grant.issuedAt)
      || !timestamp(grant.expiresAt)
      || Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)
      || typeof grant.bindingFingerprint !== "string" || !HASH.test(grant.bindingFingerprint)
      || typeof grant.mac !== "string" || !BASE64URL.test(grant.mac)
    ) invalid();
    const mac = Buffer.from(grant.mac, "base64url");
    try {
      if (mac.length !== 32 || mac.toString("base64url") !== grant.mac) invalid();
    } finally {
      mac.fill(0);
    }
    return Object.freeze({
      grantVersion: 1,
      grantId: grant.grantId,
      projectId: grant.projectId,
      storeId: grant.storeId,
      parentSessionId: grant.parentSessionId,
      targetActorRole: "untrusted",
      targetClientInstanceId: grant.targetClientInstanceId,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      bindingFingerprint: grant.bindingFingerprint,
      mac: grant.mac,
    });
  });
}

function verifyGrant(
  provider: CapabilityKeyProvider,
  secret: SecretString,
  command: LifecycleSemanticCommandDraft,
  context: DerivedContext,
  nowMs: bigint,
): RedactedChildBindingGrant {
  if (command.commandType !== "fork-child" || context.targetBindingFingerprint === null) invalid();
  const grant = parseGrant(secret);
  if (
    grant.projectId !== context.projectContext.binding.projectId
    || grant.storeId !== context.projectContext.binding.storeId
    || grant.parentSessionId !== command.parentSessionId
    || grant.targetClientInstanceId !== context.target.clientInstanceId
    || grant.bindingFingerprint !== context.targetBindingFingerprint
    || nowMs < BigInt(Date.parse(grant.issuedAt))
    || nowMs >= BigInt(Date.parse(grant.expiresAt))
  ) invalid();
  const claims = {
    grantVersion: 1,
    grantId: grant.grantId,
    projectId: grant.projectId,
    storeId: grant.storeId,
    parentSessionId: grant.parentSessionId,
    targetActorRole: "untrusted" as const,
    targetClientInstanceId: grant.targetClientInstanceId,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    bindingFingerprint: grant.bindingFingerprint,
  };
  const bytes = Buffer.from(canonicalJson(claims), "utf8");
  const mac = Buffer.from(grant.mac, "base64url");
  try {
    let keyId: string;
    try {
      keyId = provider.currentKey(
        { projectId: grant.projectId, storeId: grant.storeId },
        "child-binding-grant",
      ).keyId;
    } catch {
      return unavailable();
    }
    let valid = false;
    try {
      valid = provider.verify({
        projectId: grant.projectId,
        storeId: grant.storeId,
        purpose: "child-binding-grant",
        keyId,
        domain: CHILD_BINDING_GRANT_DOMAIN,
        bytes,
        mac,
      });
    } catch {
      invalid();
    }
    if (!valid) invalid();
    const fingerprint = createHash("sha256")
      .update(CHILD_BINDING_GRANT_DIGEST_DOMAIN, "utf8")
      .update(mac)
      .digest("hex");
    return Object.freeze({
      grantVersion: 1,
      grantId: grant.grantId,
      projectId: grant.projectId as RedactedChildBindingGrant["projectId"],
      storeId: grant.storeId as RedactedChildBindingGrant["storeId"],
      parentSessionId: grant.parentSessionId as RedactedChildBindingGrant["parentSessionId"],
      targetActorRole: "untrusted",
      targetClientInstanceId: grant.targetClientInstanceId,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      bindingFingerprint: grant.bindingFingerprint,
      grantFingerprint: fingerprint,
    });
  } finally {
    bytes.fill(0);
    mac.fill(0);
  }
}

function expectedOwnerGeneration(
  command: LifecycleSemanticCommandDraft,
  context: DerivedContext,
): string {
  if (command.commandType === "root-recovery") return command.expectedOwnerGeneration;
  if (command.commandType === "abandon-session" && context.capabilityGeneration !== null) {
    return context.capabilityGeneration;
  }
  return invalid();
}

function verifyApproval(
  provider: CapabilityKeyProvider,
  secret: SecretString,
  command: LifecycleSemanticCommandDraft,
  context: DerivedContext,
  candidateIntentHash: string,
  nowMs: bigint,
): RedactedLifecycleApproval {
  if (command.commandType !== "root-recovery" && command.commandType !== "abandon-session") invalid();
  if (context.target.actorRole !== "primary") invalid();
  const expectation: ApprovalVerificationExpectationV1 = {
    action: command.commandType === "root-recovery" ? "recover-root-authority" : "abandon-root",
    projectId: context.projectContext.binding.projectId,
    vaultId: context.projectContext.binding.vaultId,
    storeId: context.projectContext.binding.storeId,
    workspaceId: context.projectContext.binding.workspaceId,
    sessionId: command.sessionId,
    expectedOwnerGeneration: expectedOwnerGeneration(command, context),
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    intentHash: candidateIntentHash,
    executorActorRole: context.presenter.actorRole as "primary" | "maintenance",
    executorClientInstanceId: context.presenter.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: context.target.clientInstanceId,
  };
  return command.commandType === "root-recovery"
    ? verifyRecoveryApproval(provider, secret, expectation, nowMs).redacted
    : verifyAbandonmentApproval(provider, secret, expectation, nowMs).redacted;
}

function workerAuthorization(
  context: DerivedContext,
  proof: CapabilityProofV1 | null,
  approval: RedactedLifecycleApproval | null,
  childBindingGrant: RedactedChildBindingGrant | null,
): SemanticCommandAuthorization {
  if (context.authoritySessionId === null || context.targetSessionId === null) {
    if (proof !== null || approval !== null || childBindingGrant !== null) invalid();
    return Object.freeze({
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    });
  }
  return Object.freeze({
    kind: "protected",
    authoritySessionId: context.authoritySessionId as Extract<SemanticCommandAuthorization, { kind: "protected" }>["authoritySessionId"],
    targetSessionId: context.targetSessionId as Extract<SemanticCommandAuthorization, { kind: "protected" }>["targetSessionId"],
    proof,
    approval,
    childBindingGrant,
  });
}

function assertRecoveryTargetAttached(
  command: LifecycleSemanticCommandDraft,
  context: DerivedContext,
  channel: PrivateAuthorityChannel,
): void {
  if (command.commandType === "root-recovery" && !channel.isAttached(context.target)) invalid();
}

function decodeDescriptor(value: unknown): AuthorityMaterialDescriptorV1 {
  const descriptor = exact(value, [
    "descriptorVersion", "authorityCommitment", "capabilityGeneration", "target", "materials",
  ], "authorityMaterialDescriptor");
  if (
    descriptor.descriptorVersion !== 1
    || typeof descriptor.authorityCommitment !== "string"
    || !HASH.test(descriptor.authorityCommitment)
    || !positiveGeneration(descriptor.capabilityGeneration)
  ) invalid();
  const target = decodeTarget(descriptor.target);
  let source: readonly unknown[];
  try {
    source = strictArray(descriptor.materials, "authorityMaterialDescriptor.materials", "SESSION_CAPABILITY_INVALID");
  } catch {
    return invalid();
  }
  if (source.length === 0 || source.length > 2) invalid();
  const materials: StoredCapabilityMaterialV1[] = source.map((value, index) => {
    const material = exact(value, ["claims", "verifier"], `authorityMaterialDescriptor.materials[${index}]`);
    const claims = decodeCapabilityClaims(material.claims);
    if (typeof material.verifier !== "string" || !HASH.test(material.verifier)) invalid();
    return Object.freeze({ claims, verifier: material.verifier });
  });
  return Object.freeze({
    descriptorVersion: 1,
    authorityCommitment: descriptor.authorityCommitment,
    capabilityGeneration: descriptor.capabilityGeneration,
    target: Object.freeze({
      actorRole: target.actorRole,
      clientInstanceId: target.clientInstanceId,
    }),
    materials: Object.freeze(materials),
  });
}

function safeJson<T extends JsonValue>(value: T): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch {
    return invalid();
  }
}

function decodeAuthorityMaterial(value: unknown): WorkerAuthorityMaterialResultV1 {
  const material = exact(value, [
    "status",
    "target",
    "authorityCommitment",
    "capabilityGeneration",
    "descriptor",
    "recoveryCode",
  ], "workerResult.authorityMaterial");
  if (!new Set(["current", "stale", "unavailable", "not-issued"]).has(String(material.status))) invalid();
  if (
    material.recoveryCode !== null
    && material.recoveryCode !== "SESSION_HANDLE_STALE"
    && material.recoveryCode !== "SESSION_CAPABILITY_KEY_UNAVAILABLE"
  ) invalid();
  if (material.status === "current") {
    const target = decodeTarget(material.target);
    const descriptor = decodeDescriptor(material.descriptor);
    if (
      typeof material.authorityCommitment !== "string"
      || !HASH.test(material.authorityCommitment)
      || !positiveGeneration(material.capabilityGeneration)
      || material.recoveryCode !== null
      || descriptor.authorityCommitment !== material.authorityCommitment
      || descriptor.capabilityGeneration !== material.capabilityGeneration
      || !sameTarget(descriptor.target, target)
    ) invalid();
    return Object.freeze({
      status: "current",
      target,
      authorityCommitment: material.authorityCommitment,
      capabilityGeneration: material.capabilityGeneration,
      descriptor,
      recoveryCode: null,
    });
  }
  if (
    material.target !== null
    || material.authorityCommitment !== null
    || material.capabilityGeneration !== null
    || material.descriptor !== null
    || (material.status === "not-issued" && material.recoveryCode !== null)
  ) invalid();
  return Object.freeze({
    status: material.status as Exclude<AuthorityMaterialStatus, "current">,
    target: null,
    authorityCommitment: null,
    capabilityGeneration: null,
    descriptor: null,
    recoveryCode: material.recoveryCode as WorkerAuthorityMaterialResultV1["recoveryCode"],
  });
}

function decodeWorkerResult<T extends JsonValue>(value: WorkerLifecycleResult<T>): WorkerLifecycleResult<T> {
  let preliminary: Record<string, unknown>;
  try {
    preliminary = strictRecord(value, "workerResult", "SESSION_CAPABILITY_INVALID");
  } catch {
    return invalid();
  }
  const source = exact(value, preliminary.kind === "success"
    ? ["kind", "publicResult", "authorityMaterial"]
    : ["kind", "errorCode"], "workerResult");
  if (source.kind === "success") {
    return Object.freeze({
      kind: "success",
      publicResult: safeJson(source.publicResult as T),
      authorityMaterial: decodeAuthorityMaterial(source.authorityMaterial),
    });
  }
  if (source.kind === "unknown") {
    if (source.errorCode !== "COMMAND_OUTCOME_UNKNOWN") invalid();
    return Object.freeze({ kind: "unknown", errorCode: "COMMAND_OUTCOME_UNKNOWN" });
  }
  if (
    source.kind !== "rejected"
    || typeof source.errorCode !== "string"
    || source.errorCode === "COMMAND_OUTCOME_UNKNOWN"
    || !TERMINAL_CODES.has(source.errorCode as LifecycleErrorCode)
  ) invalid();
  return Object.freeze({
    kind: "rejected",
    errorCode: source.errorCode as Exclude<LifecycleErrorCode, "COMMAND_OUTCOME_UNKNOWN">,
  });
}

function decodeIdentity(value: PendingCommandIdentity): PendingCommandIdentity {
  const identity = exact(value, ["projectId", "commandId", "idempotencyKey"], "pendingIdentity");
  if (
    typeof identity.projectId !== "string" || !UUID.test(identity.projectId)
    || typeof identity.commandId !== "string" || !UUID.test(identity.commandId)
    || !bounded(identity.idempotencyKey, 512)
  ) invalid();
  return Object.freeze({
    projectId: identity.projectId,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
  });
}

function destroyMaterial(material: RootOrChildAuthorityMaterial): void {
  if (material.kind === "root") {
    material.handle.destroy();
    material.resumeToken?.destroy();
  } else {
    material.handle.destroy();
  }
}

export class AuthorityMaterialAdapter {
  readonly #pending: PendingAuthorizationStore;
  readonly #provider: CapabilityKeyProvider;
  readonly #capabilities: CapabilityService;
  readonly #channel: PrivateAuthorityChannel;
  readonly #clock: AuthorityAdapterClock;
  readonly #nonces: AuthorityAdapterNonceSource;

  constructor(options: AuthorityMaterialAdapterOptions) {
    if (
      options === undefined
      || options.pendingStore === undefined
      || options.keyProvider === undefined
      || options.capabilityService === undefined
      || options.channel === undefined
      || options.clock === undefined
      || typeof options.clock.nowMs !== "function"
      || options.nonceSource === undefined
      || typeof options.nonceSource.uuid !== "function"
    ) invalid();
    this.#pending = options.pendingStore;
    this.#provider = options.keyProvider;
    this.#capabilities = options.capabilityService;
    this.#channel = options.channel;
    this.#clock = options.clock;
    this.#nonces = options.nonceSource;
  }

  async prepare(
    commandInput: LifecycleSemanticCommandDraft,
    authorization: PrivateLifecycleAuthorization,
    contextInput: RevalidatedTrustedLifecycleContext,
  ): Promise<PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>> {
    let command: LifecycleSemanticCommandDraft;
    try {
      command = decodeLifecycleSemanticCommandDraft(commandInput);
    } catch {
      return invalid();
    }
    let preliminaryAuthorization: Record<string, unknown>;
    try {
      preliminaryAuthorization = strictRecord(
        authorization,
        "privateAuthorization",
        "SESSION_CAPABILITY_INVALID",
      );
    } catch {
      return invalid();
    }
    const authorizationRecord = exact(
      authorization,
      preliminaryAuthorization.kind === "initial-authority"
        ? ["kind"]
        : ["kind", "bearer", "approval", "childBindingGrant"],
      "privateAuthorization",
    );
    if (authorizationRecord.kind === "initial-authority") {
      const context = deriveContext(command, contextInput, {
        kind: "initial-authority", hasProof: false, hasApproval: false, hasGrant: false,
      });
      assertHostPrivateRoot(this.#pending, context.projectContext);
      const candidateIntentHash = intentHash(command, context);
      const worker = workerAuthorization(context, null, null, null);
      assertSemanticCommandAuthorization(command, worker);
      const createdAt = validateClock(this.#clock.nowMs());
      await this.#pending.put(Object.freeze({
        recordVersion: 1,
        projectId: context.projectContext.binding.projectId,
        storeId: context.projectContext.binding.storeId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        command,
        authoritySessionId: null,
        targetSessionId: null,
        stableBinding: stableBinding(context),
        candidateIntentHash,
        authorization: Object.freeze({
          kind: "initial-authority", proof: null, approval: null, childBindingGrant: null,
        }),
        createdAt,
      }));
      return Object.freeze({ command, candidateIntentHash, authorization: worker });
    }
    if (
      authorizationRecord.kind !== "protected"
      || (authorizationRecord.bearer !== null && !(authorizationRecord.bearer instanceof SecretString))
      || (authorizationRecord.approval !== null && !(authorizationRecord.approval instanceof SecretString))
      || (authorizationRecord.childBindingGrant !== null
        && !(authorizationRecord.childBindingGrant instanceof SecretString))
    ) invalid();
    const protectedAuthorization = authorization as Extract<PrivateLifecycleAuthorization, { kind: "protected" }>;
    const hasProof = protectedAuthorization.bearer !== null;
    const hasApproval = protectedAuthorization.approval !== null;
    const hasGrant = protectedAuthorization.childBindingGrant !== null;
    const context = deriveContext(command, contextInput, {
      kind: "protected", hasProof, hasApproval, hasGrant,
    });
    assertHostPrivateRoot(this.#pending, context.projectContext);
    const candidateIntentHash = intentHash(command, context);
    const nowMs = this.#clock.nowMs();
    validateClock(nowMs);
    const approval = protectedAuthorization.approval === null
      ? null
      : verifyApproval(this.#provider, protectedAuthorization.approval, command, context, candidateIntentHash, nowMs);
    const childBindingGrant = protectedAuthorization.childBindingGrant === null
      ? null
      : verifyGrant(this.#provider, protectedAuthorization.childBindingGrant, command, context, nowMs);
    assertRecoveryTargetAttached(command, context, this.#channel);
    let capabilityProof: CapabilityProofV1 | null = null;
    if (protectedAuthorization.bearer !== null) {
      if (
        context.capabilityKind === null
        || context.capabilityGeneration === null
        || context.authoritySessionId === null
        || context.targetSessionId === null
      ) invalid();
      verifyCapability(this.#provider, protectedAuthorization.bearer, {
        projectId: context.projectContext.binding.projectId,
        vaultId: context.projectContext.binding.vaultId,
        storeId: context.projectContext.binding.storeId,
        workspaceId: context.projectContext.binding.workspaceId,
        clientNamespace: context.projectContext.binding.clientNamespace,
        sessionId: context.authoritySessionId,
        kind: context.capabilityKind,
        capabilityGeneration: context.capabilityGeneration,
        audience: context.audience,
      }, nowMs);
      const target: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.projectContext.binding.projectId,
        vaultId: context.projectContext.binding.vaultId,
        storeId: context.projectContext.binding.storeId,
        workspaceId: context.projectContext.binding.workspaceId,
        clientNamespace: context.projectContext.binding.clientNamespace,
        authoritySessionId: context.authoritySessionId,
        targetSessionId: context.targetSessionId,
        presentingActorRole: context.audience.presentingActorRole,
        presentingClientInstanceId: context.audience.presentingClientInstanceId,
        targetActorRole: context.audience.targetActorRole,
        targetClientInstanceId: context.audience.targetClientInstanceId,
        capabilityKind: context.capabilityKind,
        capabilityGeneration: context.capabilityGeneration,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        intentHash: candidateIntentHash,
        proofNonce: this.#nonces.uuid(),
      };
      capabilityProof = createCapabilityProof(protectedAuthorization.bearer, target);
    }
    const worker = workerAuthorization(context, capabilityProof, approval, childBindingGrant);
    assertSemanticCommandAuthorization(command, worker);
    const createdAt = validateClock(nowMs);
    const pendingAuthorization: PendingPrivateAuthorization = Object.freeze({
      kind: "protected",
      proof: capabilityProof,
      approval: protectedAuthorization.approval,
      childBindingGrant: protectedAuthorization.childBindingGrant,
    });
    await this.#pending.put(Object.freeze({
      recordVersion: 1,
      projectId: context.projectContext.binding.projectId,
      storeId: context.projectContext.binding.storeId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      command,
      authoritySessionId: context.authoritySessionId,
      targetSessionId: context.targetSessionId,
      stableBinding: stableBinding(context),
      candidateIntentHash,
      authorization: pendingAuthorization,
      createdAt,
    }));
    return Object.freeze({ command, candidateIntentHash, authorization: worker });
  }

  async resumePending(
    identityInput: PendingCommandIdentity,
    contextInput: RevalidatedTrustedLifecycleContext,
  ): Promise<PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>> {
    const identity = decodeIdentity(identityInput);
    const record = await this.#pending.get(identity.projectId, identity.commandId, identity.idempotencyKey);
    if (record === null) invalid();
    try {
      const authorization = record.authorization;
      let context: DerivedContext;
      try {
        context = deriveContext(record.command, contextInput, {
          kind: authorization.kind,
          hasProof: authorization.proof !== null,
          hasApproval: authorization.kind === "protected" && authorization.approval !== null,
          hasGrant: authorization.kind === "protected" && authorization.childBindingGrant !== null,
        });
      } catch {
        return conflict();
      }
      try {
        assertHostPrivateRoot(this.#pending, context.projectContext);
      } catch {
        return conflict();
      }
      const currentStable = stableBinding(context);
      if (!stableMatches(record.stableBinding, currentStable)) conflict();
      const candidateIntentHash = intentHash(record.command, context);
      if (candidateIntentHash !== record.candidateIntentHash) conflict();
      const replayTime = BigInt(Date.parse(record.createdAt));
      const approval = authorization.kind === "protected" && authorization.approval !== null
        ? verifyApproval(
            this.#provider,
            authorization.approval,
            record.command,
            context,
            candidateIntentHash,
            replayTime,
          )
        : null;
      const childBindingGrant = authorization.kind === "protected" && authorization.childBindingGrant !== null
        ? verifyGrant(
            this.#provider,
            authorization.childBindingGrant,
            record.command,
            context,
            replayTime,
          )
        : null;
      assertRecoveryTargetAttached(record.command, context, this.#channel);
      const worker = workerAuthorization(context, authorization.proof, approval, childBindingGrant);
      assertSemanticCommandAuthorization(record.command, worker);
      return Object.freeze({
        command: record.command,
        candidateIntentHash: record.candidateIntentHash,
        authorization: worker,
      });
    } finally {
      destroyPendingAuthorization(record.authorization);
    }
  }

  async complete<T extends JsonValue>(
    identityInput: PendingCommandIdentity,
    resultInput: WorkerLifecycleResult<T>,
  ): Promise<LifecycleExecutionResult<T>> {
    const identity = decodeIdentity(identityInput);
    const result = decodeWorkerResult(resultInput);
    const record = await this.#pending.get(identity.projectId, identity.commandId, identity.idempotencyKey);
    if (record === null) invalid();
    try {
      if (result.kind === "unknown") throw new LifecycleError("COMMAND_OUTCOME_UNKNOWN");
      if (result.kind === "rejected") {
        await this.#pending.delete(identity.projectId, identity.commandId, identity.idempotencyKey);
        throw new LifecycleError(result.errorCode);
      }
      let status = result.authorityMaterial.status;
      let recoveryCode: AuthorityDeliveryRecoveryCode | null = result.authorityMaterial.recoveryCode;
      if (status === "current") {
        const target = result.authorityMaterial.target;
        const descriptor = result.authorityMaterial.descriptor;
        if (target === null || descriptor === null) invalid();
        const expectedTarget: LifecycleAuthorityTarget = decodeTarget({
          actorRole: record.stableBinding.audience.targetActorRole,
          clientInstanceId: record.stableBinding.audience.targetClientInstanceId,
        });
        if (!sameTarget(target, expectedTarget) || !sameTarget(descriptor.target, expectedTarget)) invalid();
        const presenterIsTarget = record.stableBinding.audience.presentingActorRole === target.actorRole
          && record.stableBinding.audience.presentingClientInstanceId === target.clientInstanceId;
        if (!this.#channel.isAttached(target)) {
          status = "unavailable";
          recoveryCode = "AUTHORITY_TARGET_DETACHED";
        } else if (!presenterIsTarget) {
          await this.#channel.routeDescriptor(target, descriptor);
        } else if (this.#channel.isLocalTarget(target)) {
          await this.#deliverLocal(target, descriptor);
        } else {
          status = "unavailable";
          recoveryCode = "AUTHORITY_TARGET_DETACHED";
        }
      }
      if (status !== "unavailable") {
        await this.#pending.delete(identity.projectId, identity.commandId, identity.idempotencyKey);
      }
      return Object.freeze({
        publicResult: result.publicResult,
        authorityMaterialStatus: status,
        recoveryCode,
      });
    } finally {
      destroyPendingAuthorization(record.authorization);
    }
  }

  async acceptRoutedDescriptor(
    targetInput: LifecycleAuthorityTarget,
    descriptorInput: AuthorityMaterialDescriptorV1,
  ): Promise<void> {
    const target = decodeTarget(targetInput);
    const descriptor = decodeDescriptor(descriptorInput);
    if (
      !sameTarget(target, descriptor.target)
      || !this.#channel.isAttached(target)
      || !this.#channel.isLocalTarget(target)
    ) invalid();
    await this.#deliverLocal(target, descriptor);
  }

  async #deliverLocal(
    target: LifecycleAuthorityTarget,
    descriptor: AuthorityMaterialDescriptorV1,
  ): Promise<void> {
    let material: RootOrChildAuthorityMaterial;
    try {
      material = this.#capabilities.reconstructForTarget(descriptor, target);
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      return invalid();
    }
    try {
      await this.#channel.deliverLocal(target, material);
    } finally {
      destroyMaterial(material);
    }
  }
}
