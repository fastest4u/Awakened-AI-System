import { createHash } from "node:crypto";
import type { ProjectContext } from "../identity/contracts.js";
import { MAX_CANONICAL_TIMESTAMP_MS } from "../runtime/clock.js";
import type { SessionAuthorityRecord } from "../storage/lifecycle-storage.types.js";
import type { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SessionAggregateState } from "./session-aggregate.js";
import {
  CapabilityService,
  MAX_BOUNDED_PROOF_HORIZON_MS,
  type StoredCapabilityMaterialV1,
} from "./capability.service.js";
import type {
  BoundedLifecycleOperation,
  CapabilityProofV1,
} from "./contracts/commands.js";
import type { BoundedOperationProofTargetV1 } from "./authority/capability-codec.js";
import { LifecycleError } from "./errors.js";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const MAX_SESSION_TREE_CHILDREN = 200;

export type ProtectedLifecycleReadOperation = Exclude<
  BoundedLifecycleOperation,
  { readonly operation: "renew-root-lease" }
>;

export interface RedactedSessionSummaryV1 {
  readonly sessionId: string;
  readonly sessionKind: "root" | "child";
  readonly parentSessionId: string | null;
  readonly state: string;
  readonly ownerGeneration: string | null;
  readonly childCapabilityGeneration: string | null;
  readonly authorityClientInstanceId: string | null;
  readonly directAccessEnabled: boolean;
  readonly streamVersion: string;
  readonly eventPosition: string;
  readonly latestCheckpointEventPosition: string | null;
  readonly checkpointRequired: boolean;
}

export interface SessionTreeSummaryV1 {
  readonly resultVersion: 1;
  readonly operation: "read-session-tree";
  readonly operationId: string;
  readonly requestId: string;
  readonly root: RedactedSessionSummaryV1;
  readonly children: readonly RedactedSessionSummaryV1[];
  readonly childrenTruncated: boolean;
}

export interface SessionStatusSummaryV1 {
  readonly resultVersion: 1;
  readonly operation: "read-session-status";
  readonly operationId: string;
  readonly requestId: string;
  readonly session: RedactedSessionSummaryV1;
}

export interface SessionAssociationValidationV1 {
  readonly resultVersion: 1;
  readonly operation: "read-session-association";
  readonly operationId: string;
  readonly requestId: string;
  readonly associated: true;
  readonly sessionId: string;
  readonly rootSessionId: string;
}

export type ProtectedLifecycleReadResultV1 =
  | SessionTreeSummaryV1
  | SessionStatusSummaryV1
  | SessionAssociationValidationV1;

interface LifecycleQueryAuthorityRepository {
  get(connection: SqliteConnection, projectId: string, sessionId: string): SessionAuthorityRecord | null;
  requireFoldMatch(
    connection: SqliteConnection,
    authority: SessionAuthorityRecord,
  ): SessionAggregateState;
  listDirectChildrenBounded(
    connection: SqliteConnection,
    projectId: string,
    rootSessionId: string,
    limit: number,
  ): readonly SessionAuthorityRecord[];
}

export interface LifecycleQueryServiceOptions {
  readonly connection: SqliteConnection;
  readonly authorityRepository: Pick<
    SessionAuthorityRepository,
    "get" | "requireFoldMatch" | "listDirectChildrenBounded"
  >;
  readonly capabilityService: CapabilityService;
}

function invalid(code: "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "LIFECYCLE_INPUT_INVALID"): never {
  throw new LifecycleError(code);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) invalid();
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function canonicalTimestampMilliseconds(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  const milliseconds = BigInt(parsed);
  if (milliseconds < 0n || milliseconds > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  return milliseconds;
}

function validateContext(context: ProjectContext, supplied: unknown): void {
  const binding = context?.binding;
  if (
    binding === undefined
    || (binding.actorRole !== "primary" && binding.actorRole !== "untrusted")
    || context.workspace !== binding.workspace
    || context.workspace.workspaceId !== binding.workspaceId
    || binding.clientNamespace.length === 0
    || binding.clientInstanceId.length === 0
  ) throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  canonicalTimestampMilliseconds(context.checkedAt);
  try {
    if (canonicalJson(context) !== canonicalJson(supplied)) invalid();
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    invalid();
  }
}

function boundedReadHash(input: {
  readonly operationType: ProtectedLifecycleReadOperation["operation"];
  readonly operationId: string;
  readonly requestId: string;
  readonly sessionId: string;
}): string {
  return createHash("sha256")
    .update("project-memory/bounded-operation/v1\n", "utf8")
    .update(canonicalJson({
      operationType: input.operationType,
      operationId: input.operationId,
      requestId: input.requestId,
      sessionId: input.sessionId,
    }), "utf8")
    .digest("hex");
}

function preparedRead(
  context: ProjectContext,
  input: ProtectedLifecycleReadOperation,
): {
  readonly operation: ProtectedLifecycleReadOperation["operation"];
  readonly operationId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly authorization: ProtectedLifecycleReadOperation["authorization"];
  readonly proof: CapabilityProofV1;
} {
  const operation = exactDataRecord(input, [
    "context", "operation", "operationId", "requestId", "sessionId", "authorization",
  ]);
  if (
    operation.operation !== "read-session-tree"
    && operation.operation !== "read-session-status"
    && operation.operation !== "read-session-association"
  ) invalid();
  if (
    typeof operation.operationId !== "string" || !LOWER_UUID.test(operation.operationId)
    || typeof operation.requestId !== "string" || !LOWER_UUID.test(operation.requestId)
    || typeof operation.sessionId !== "string" || !LOWER_UUID.test(operation.sessionId)
  ) invalid();
  validateContext(context, operation.context);
  const authorization = exactDataRecord(operation.authorization, [
    "kind", "authoritySessionId", "targetSessionId", "proof", "audience",
  ]);
  const audience = exactDataRecord(authorization.audience, [
    "presentingActorRole",
    "presentingClientInstanceId",
    "targetActorRole",
    "targetClientInstanceId",
  ]);
  if (
    authorization.kind !== "bounded-operation"
    || authorization.authoritySessionId !== operation.sessionId
    || authorization.targetSessionId !== operation.sessionId
    || audience.presentingActorRole !== context.binding.actorRole
    || audience.presentingClientInstanceId !== context.binding.clientInstanceId
    || audience.targetActorRole !== context.binding.actorRole
    || audience.targetClientInstanceId !== context.binding.clientInstanceId
  ) invalid();
  const proof = exactDataRecord(authorization.proof, [
    "proofVersion", "target", "proofNonce", "proofFingerprint",
  ]);
  if (
    proof.proofVersion !== 1
    || proof.target !== "bounded-operation"
    || typeof proof.proofNonce !== "string" || !LOWER_UUID.test(proof.proofNonce)
    || typeof proof.proofFingerprint !== "string" || !LOWER_HASH.test(proof.proofFingerprint)
  ) invalid();
  return Object.freeze({
    operation: operation.operation,
    operationId: operation.operationId,
    requestId: operation.requestId,
    sessionId: operation.sessionId,
    authorization: input.authorization,
    proof: Object.freeze({
      proofVersion: 1,
      target: "bounded-operation",
      proofNonce: proof.proofNonce,
      proofFingerprint: proof.proofFingerprint,
    }),
  });
}

function currentCapabilityMaterial(
  context: ProjectContext,
  authority: SessionAuthorityRecord,
): { readonly material: StoredCapabilityMaterialV1; readonly generation: string } {
  const common = {
    projectId: authority.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: authority.workspaceId,
    clientNamespace: authority.clientNamespace,
    sessionId: authority.sessionId,
  } as const;
  if (authority.sessionKind === "root") {
    if (
      authority.ownerGeneration === null
      || authority.rootHandleCapabilityVersion !== 1
      || authority.rootHandleKeyId === null
      || authority.rootHandleIssueNonce === null
      || authority.rootHandleIssuedAt === null
      || authority.rootHandlePolicyCode === null
      || authority.rootHandleExpiryKind === null
      || authority.rootHandleActorRole !== "primary"
      || authority.rootHandleClientInstanceId === null
      || authority.rootHandleVerifier === null
      || context.binding.actorRole !== "primary"
      || context.binding.clientInstanceId !== authority.rootHandleClientInstanceId
    ) throw new LifecycleError("SESSION_HANDLE_STALE");
    const generation = authority.ownerGeneration.toString();
    return Object.freeze({
      generation,
      material: Object.freeze({
        claims: Object.freeze({
          capabilityVersion: 1,
          keyId: authority.rootHandleKeyId,
          ...common,
          kind: "root-session-handle",
          capabilityGeneration: generation,
          issuedAt: authority.rootHandleIssuedAt,
          policyCode: authority.rootHandlePolicyCode,
          expiryKind: authority.rootHandleExpiryKind,
          expiresAt: authority.rootHandleExpiresAt,
          issueNonce: authority.rootHandleIssueNonce,
          actorRole: "primary",
          clientInstanceId: authority.rootHandleClientInstanceId,
        }),
        verifier: authority.rootHandleVerifier,
      }),
    });
  }
  if (
    !authority.directAccessEnabled
    || authority.childCapabilityGeneration === null
    || authority.childHandleCapabilityVersion !== 1
    || authority.childHandleKeyId === null
    || authority.childHandleIssueNonce === null
    || authority.childHandleIssuedAt === null
    || authority.childHandlePolicyCode === null
    || authority.childHandleExpiryKind === null
    || authority.childHandleActorRole !== "untrusted"
    || authority.childHandleClientInstanceId === null
    || authority.childHandleVerifier === null
    || authority.revocationEventPosition !== null
    || context.binding.actorRole !== "untrusted"
    || context.binding.clientInstanceId !== authority.childHandleClientInstanceId
  ) throw new LifecycleError("SESSION_HANDLE_STALE");
  const generation = authority.childCapabilityGeneration.toString();
  return Object.freeze({
    generation,
    material: Object.freeze({
      claims: Object.freeze({
        capabilityVersion: 1,
        keyId: authority.childHandleKeyId,
        ...common,
        kind: "child-session-handle",
        capabilityGeneration: generation,
        issuedAt: authority.childHandleIssuedAt,
        policyCode: authority.childHandlePolicyCode,
        expiryKind: authority.childHandleExpiryKind,
        expiresAt: authority.childHandleExpiresAt,
        issueNonce: authority.childHandleIssueNonce,
        actorRole: "untrusted",
        clientInstanceId: authority.childHandleClientInstanceId,
      }),
      verifier: authority.childHandleVerifier,
    }),
  });
}

function proofTarget(
  context: ProjectContext,
  read: ReturnType<typeof preparedRead>,
  generation: string,
): BoundedOperationProofTargetV1 {
  const checkedAtMs = canonicalTimestampMilliseconds(context.checkedAt);
  const expiresAtMs = checkedAtMs + MAX_BOUNDED_PROOF_HORIZON_MS;
  if (expiresAtMs > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  return Object.freeze({
    proofVersion: 1,
    target: "bounded-operation",
    operationType: read.operation,
    operationId: read.operationId,
    requestId: read.requestId,
    operationHash: boundedReadHash({
      operationType: read.operation,
      operationId: read.operationId,
      requestId: read.requestId,
      sessionId: read.sessionId,
    }),
    authoritySessionId: read.sessionId,
    targetSessionId: read.sessionId,
    presentingActorRole: context.binding.actorRole,
    presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole: context.binding.actorRole,
    targetClientInstanceId: context.binding.clientInstanceId,
    capabilityGeneration: generation,
    proofNonce: read.proof.proofNonce,
    expiresAt: new Date(Number(expiresAtMs)).toISOString(),
  });
}

function redactedSummary(
  authority: SessionAuthorityRecord,
  aggregate: SessionAggregateState,
): RedactedSessionSummaryV1 {
  if (
    aggregate.projectId !== authority.projectId
    || aggregate.sessionId !== authority.sessionId
    || aggregate.kind !== authority.sessionKind
    || aggregate.parentSessionId !== authority.parentSessionId
  ) invalid("INTEGRITY_FAILURE");
  return Object.freeze({
    sessionId: authority.sessionId,
    sessionKind: authority.sessionKind,
    parentSessionId: authority.parentSessionId,
    state: authority.semanticState,
    ownerGeneration: authority.ownerGeneration?.toString() ?? null,
    childCapabilityGeneration: authority.childCapabilityGeneration?.toString() ?? null,
    authorityClientInstanceId: authority.sessionKind === "root"
      ? authority.rootHandleClientInstanceId
      : authority.childHandleClientInstanceId,
    directAccessEnabled: authority.directAccessEnabled,
    streamVersion: aggregate.streamVersion.toString(),
    eventPosition: aggregate.eventPosition.toString(),
    latestCheckpointEventPosition: authority.latestCheckpointEventPosition?.toString() ?? null,
    checkpointRequired: authority.checkpointRequiredEventPosition !== null,
  });
}

export class LifecycleQueryService {
  readonly #connection: SqliteConnection;
  readonly #authority: LifecycleQueryAuthorityRepository;
  readonly #capabilities: CapabilityService;

  constructor(options: LifecycleQueryServiceOptions) {
    this.#connection = options.connection;
    this.#authority = options.authorityRepository;
    this.#capabilities = options.capabilityService;
  }

  read(
    context: ProjectContext,
    operationInput: ProtectedLifecycleReadOperation,
  ): ProtectedLifecycleReadResultV1 {
    const read = preparedRead(context, operationInput);
    let transactionBegan = false;
    try {
      this.#connection.exec("BEGIN DEFERRED");
      transactionBegan = true;
      const authority = this.#authority.get(
        this.#connection,
        context.binding.projectId,
        read.sessionId,
      );
      if (authority === null) throw new LifecycleError("SESSION_NOT_FOUND");
      if (
        authority.workspaceId !== context.binding.workspaceId
        || authority.clientNamespace !== context.binding.clientNamespace
      ) throw new LifecycleError("SESSION_NOT_FOUND");
      if (read.operation === "read-session-tree" && authority.sessionKind !== "root") {
        throw new LifecycleError("SESSION_STATE_CONFLICT");
      }
      const aggregate = this.#authority.requireFoldMatch(this.#connection, authority);
      const capability = currentCapabilityMaterial(context, authority);
      this.#capabilities.verifyProof(
        capability.material,
        proofTarget(context, read, capability.generation),
        read.proof,
      );
      const base = {
        resultVersion: 1 as const,
        operationId: read.operationId,
        requestId: read.requestId,
      };
      let result: ProtectedLifecycleReadResultV1;
      if (read.operation === "read-session-tree") {
        const candidates = [...this.#authority.listDirectChildrenBounded(
          this.#connection,
          context.binding.projectId,
          authority.sessionId,
          MAX_SESSION_TREE_CHILDREN + 1,
        )].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
        const visible = candidates.slice(0, MAX_SESSION_TREE_CHILDREN);
        const children = Object.freeze(visible.map((child) => {
          if (
            child.parentSessionId !== authority.sessionId
            || child.workspaceId !== authority.workspaceId
            || child.clientNamespace !== authority.clientNamespace
          ) invalid("INTEGRITY_FAILURE");
          return redactedSummary(
            child,
            this.#authority.requireFoldMatch(this.#connection, child),
          );
        }));
        result = Object.freeze({
          ...base,
          operation: "read-session-tree",
          root: redactedSummary(authority, aggregate),
          children,
          childrenTruncated: candidates.length > MAX_SESSION_TREE_CHILDREN,
        });
      } else if (read.operation === "read-session-status") {
        result = Object.freeze({
          ...base,
          operation: "read-session-status",
          session: redactedSummary(authority, aggregate),
        });
      } else {
        result = Object.freeze({
          ...base,
          operation: "read-session-association",
          associated: true,
          sessionId: authority.sessionId,
          rootSessionId: authority.parentSessionId ?? authority.sessionId,
        });
      }
      this.#connection.exec("COMMIT");
      transactionBegan = false;
      return result;
    } catch (error) {
      if (transactionBegan) {
        try {
          this.#connection.exec("ROLLBACK");
        } catch {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
      }
      throw error;
    }
  }
}
