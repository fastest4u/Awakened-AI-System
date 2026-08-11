import type {
  BranchScopeId,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";
import type { TrustedActorRole } from "../identity/project-binding.request.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type DeepReadonlyJson<T extends JsonValue> =
  T extends JsonPrimitive ? T
    : T extends JsonValue[] ? readonly DeepReadonlyJson<T[number]>[]
      : T extends { [key: string]: JsonValue }
        ? { readonly [K in keyof T]: DeepReadonlyJson<T[K]> }
        : never;
export type ReadonlyJsonValue =
  | JsonPrimitive
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };
export type VisibilityScope = "session" | "workspace" | "branch" | "project" | "global";
export type Confidence = "high" | "medium" | "low" | "guess";
export type VerificationStatus = "unverified" | "provisional" | "verified" | "conflicted";

export interface EvidenceDigest {
  ciphertextHash: string;
  keyedFingerprint: string;
}

export interface PendingEvent {
  eventType: string;
  eventSchemaVersion: number;
  occurredAt: string;
  visibilityScope: VisibilityScope;
  sessionId?: string;
  parentSessionId?: string;
  causationId?: string;
  confidence: Confidence;
  verificationStatus: VerificationStatus;
  payload: JsonValue;
  sourceRefs: string[];
  evidenceRefs: string[];
  evidenceDigests: EvidenceDigest[];
}

export interface PendingOutbox {
  readonly targetKey: string;
  readonly kind: string;
  readonly eventIndex: number;
  readonly payload: JsonValue;
}

const RESERVED_LIFECYCLE_OUTBOX_KIND = "materialize-lifecycle-log";

function invalidGenericPendingOutbox(): never {
  throw new TypeError("PENDING_OUTBOX_INVALID");
}

function exactOwnDataRecord(
  value: unknown,
  expectedKeys: readonly string[] | undefined,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidGenericPendingOutbox();
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidGenericPendingOutbox();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key === "__proto__")) {
    return invalidGenericPendingOutbox();
  }
  if (
    expectedKeys !== undefined
    && (
      keys.length !== expectedKeys.length
      || keys.some((key) => !expectedKeys.includes(key as string))
    )
  ) return invalidGenericPendingOutbox();

  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalidGenericPendingOutbox();
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function strictJsonSnapshot(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const copy = (current: unknown): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return invalidGenericPendingOutbox();
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      return invalidGenericPendingOutbox();
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          return invalidGenericPendingOutbox();
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const length = Reflect.getOwnPropertyDescriptor(current, "length")?.value;
        if (!Number.isSafeInteger(length) || Number(length) < 0) {
          return invalidGenericPendingOutbox();
        }
        const expectedKeys = [
          ...Array.from({ length: Number(length) }, (_, index) => String(index)),
          "length",
        ];
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== expectedKeys.length
          || keys.some((key, index) => key !== expectedKeys[index])
        ) return invalidGenericPendingOutbox();
        const result: JsonValue[] = [];
        for (let index = 0; index < Number(length); index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            return invalidGenericPendingOutbox();
          }
          result.push(copy(descriptor.value));
        }
        return Object.freeze(result) as JsonValue;
      }

      const record = exactOwnDataRecord(current, undefined);
      const result: Record<string, JsonValue> = {};
      for (const key of Object.keys(record)) {
        Object.defineProperty(result, key, {
          value: copy(record[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  const snapshot = copy(value);
  canonicalJson(snapshot);
  return snapshot;
}

function nonemptyString(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
  ) return invalidGenericPendingOutbox();
  return value;
}

/**
 * Strictly decodes only the generic outbox branch. The lifecycle materializer
 * literal is reserved for its closed descriptor codec.
 */
export function decodeGenericPendingOutbox(value: unknown): PendingOutbox {
  const source = exactOwnDataRecord(
    value,
    ["targetKey", "kind", "eventIndex", "payload"],
  );
  const targetKey = nonemptyString(source.targetKey);
  const kind = nonemptyString(source.kind);
  if (kind === RESERVED_LIFECYCLE_OUTBOX_KIND) return invalidGenericPendingOutbox();
  if (!Number.isSafeInteger(source.eventIndex) || Number(source.eventIndex) < 0) {
    return invalidGenericPendingOutbox();
  }
  const payload = strictJsonSnapshot(source.payload);
  return Object.freeze({
    targetKey,
    kind,
    eventIndex: Number(source.eventIndex),
    payload,
  });
}

export interface AppendCommand<TResponse extends JsonValue> {
  context: ProjectContext;
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  correlationId: string;
  agentId: string;
  expectedStreamVersion: bigint;
  streamId: string;
  streamType: string;
  events: PendingEvent[];
  outbox: PendingOutbox[];
  publicResponse: TResponse;
  /** Canonical nonsecret Version 2 witness stored on command event zero. */
  lifecycleIntentWitness?: string;
}

export interface AppendResult<TResponse extends JsonValue> {
  deduplicated: boolean;
  firstGlobalPosition: bigint;
  lastGlobalPosition: bigint;
  finalStreamVersion: bigint;
  eventIds: string[];
  response: TResponse;
  responseHash: string;
}

export interface StoredCommandResponse<TResponse extends JsonValue> {
  readonly eventIds: readonly string[];
  readonly firstGlobalPosition: string;
  readonly lastGlobalPosition: string;
  readonly finalStreamVersion: string;
  readonly response: DeepReadonlyJson<TResponse>;
}

export interface LifecyclePrincipal {
  actorRole: TrustedActorRole;
  clientInstanceId: string;
}

export type LifecycleCommandOrigin =
  | {
      kind: "initial-authority";
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    }
  | {
      kind: "protected";
      proof: null | { version: 1; nonce: string; digest: string };
      approval: null | { approvalId: string; digest: string };
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    }
  | {
      kind: "internal-workflow";
      workflowId: string;
      workflowGeneration: bigint;
      plannedWorkId: string;
      claimOwnerId: string;
      claimToken: bigint;
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    };

export type PersistedLifecycleAuthorizationRecord =
  | (Extract<LifecycleCommandOrigin, { kind: "initial-authority" }> & {
      authorizationSessionId: null;
      targetSessionId: string;
      proof: null;
      approval: null;
    })
  | Extract<LifecycleCommandOrigin, { kind: "protected" | "internal-workflow" }>;

export type LifecycleReplayExpectation =
  | Extract<LifecycleCommandOrigin, { kind: "initial-authority" | "protected" }>
  | {
      kind: "internal-workflow";
      workflowId: string;
      workflowGeneration: bigint;
      plannedWorkId: string;
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    };

export interface StoredEvent {
  readonly globalPosition: bigint;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly streamId: string;
  readonly streamType: string;
  readonly streamVersion: bigint;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly sessionId: string | null;
  readonly parentSessionId: string | null;
  readonly actorRole: TrustedActorRole;
  readonly agentId: string;
  readonly clientInstanceId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandEventIndex: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly visibilityScope: Exclude<VisibilityScope, "global">;
  readonly confidence: Confidence;
  readonly verificationStatus: VerificationStatus;
  readonly sourceRefs: readonly string[];
  readonly evidenceRefs: readonly [];
  readonly evidenceDigests: readonly [];
  readonly payload: ReadonlyJsonValue;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly previousGlobalHash: string;
  readonly eventHash: string;
  /** Canonical source is persisted only by Version 2 command event zero. */
  readonly lifecycleIntentJson?: string | null;
}
