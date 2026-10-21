import { createHash } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  CheckpointDraftV1,
  CheckpointDraftV2,
} from "./contracts/checkpoint.js";
import {
  decodeCheckpointDraft,
} from "./contracts/checkpoint.js";
import {
  exactRecord,
  parseCanonicalUuid,
  strictRecord,
  type SessionId,
} from "./contracts/identifiers.js";
import type {
  PersistedQualityPolicyInputV1,
  SessionEndAmendment,
  SessionEndRequest,
  SessionEndRequestV1,
  SessionEndRequestV2,
} from "./contracts/session-end.js";
import {
  decodeQualityPolicyV1,
  decodeSessionEndAmendment,
  decodeSessionEndRequest,
} from "./contracts/session-end.js";
import { LifecycleError } from "./errors.js";

export const SESSION_END_EFFECTIVE_STATE_DOMAIN =
  "project-memory/session-end-effective-state/v1";
export const SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES = 1_048_576;

export interface SessionEndEffectiveStateV1 {
  readonly effectiveStateVersion: 1;
  readonly effectiveStateDomain: typeof SESSION_END_EFFECTIVE_STATE_DOMAIN;
  readonly request: SessionEndRequestV1 | SessionEndRequestV2;
  readonly effectivePolicy: PersistedQualityPolicyInputV1;
  readonly effectiveFinalCheckpoint: CheckpointDraftV1 | CheckpointDraftV2;
  readonly effectiveStateHash: string;
}

const EFFECTIVE_STATE_KEYS = [
  "effectiveStateVersion",
  "effectiveStateDomain",
  "request",
  "effectivePolicy",
  "effectiveFinalCheckpoint",
  "effectiveStateHash",
] as const;
const EFFECTIVE_STATE_HASH_INPUT_KEYS = EFFECTIVE_STATE_KEYS.slice(0, -1);
const PERSISTED_POLICY_KEYS = [
  "qualityPolicyVersion",
  "profiles",
  "qualityThreshold",
  "requireFullEvidence",
  "requireMaterialization",
] as const;
const LOWER_HASH = /^[0-9a-f]{64}$/u;

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function ownDataCopy(value: unknown, field: string): Record<string, unknown> {
  const source = strictRecord(value, field);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") invalid(field);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      invalid(field);
    }
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return copy;
}

function exactOwnDataRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  return exactRecord(ownDataCopy(value, field), keys, field);
}

function hashInputRecord(value: unknown): Record<string, unknown> {
  const source = ownDataCopy(value, "effectiveState");
  const actualKeys = Object.keys(source).sort();
  const fiveKeys = [...EFFECTIVE_STATE_HASH_INPUT_KEYS].sort();
  const sixKeys = [...EFFECTIVE_STATE_KEYS].sort();
  const matches = (expected: readonly string[]): boolean =>
    actualKeys.length === expected.length
    && actualKeys.every((key, index) => key === expected[index]);
  if (!matches(fiveKeys) && !matches(sixKeys)) invalid("effectiveState");
  if (
    source.effectiveStateVersion !== 1
    || source.effectiveStateDomain !== SESSION_END_EFFECTIVE_STATE_DOMAIN
  ) invalid("effectiveState");
  const selected = Object.create(null) as Record<string, unknown>;
  for (const key of EFFECTIVE_STATE_HASH_INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !("value" in descriptor)) invalid("effectiveState");
    Object.defineProperty(selected, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return selected;
}

export function decodePersistedQualityPolicyInputV1(
  value: unknown,
): PersistedQualityPolicyInputV1 {
  const source = exactOwnDataRecord(value, PERSISTED_POLICY_KEYS, "effectivePolicy");
  const decoded = decodeQualityPolicyV1(source);
  return Object.freeze({
    qualityPolicyVersion: 1,
    profiles: decoded.profiles,
    qualityThreshold: decoded.qualityThreshold,
    requireFullEvidence: decoded.requireFullEvidence,
    requireMaterialization: decoded.requireMaterialization,
  });
}

export function assertSessionEndEffectiveStateCanonicalSizeV1(value: unknown): void {
  try {
    const canonical = canonicalJson(value);
    if (
      Buffer.byteLength(canonical, "utf8")
      > SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES
    ) invalid("effectiveState.canonicalBytes");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    invalid("effectiveState.canonicalBytes");
  }
}

export function sessionEndEffectiveStateHashV1(value: unknown): string {
  let canonicalBytes: Buffer | undefined;
  let digest: Buffer | undefined;
  try {
    canonicalBytes = Buffer.from(canonicalJson(hashInputRecord(value)), "utf8");
    digest = createHash("sha256")
      .update(`${SESSION_END_EFFECTIVE_STATE_DOMAIN}\n`, "utf8")
      .update(canonicalBytes)
      .digest();
    return digest.toString("hex");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return invalid("effectiveState");
  } finally {
    canonicalBytes?.fill(0);
    digest?.fill(0);
  }
}

/**
 * Builds the immutable Version-1 request snapshot used by every semantic
 * session-end event.  Callers supply only already-derived policy material;
 * this function re-decodes the request, policy, and draft before hashing so
 * the bytes written to the event cannot differ from the bytes validated here.
 */
export function createSessionEndEffectiveStateV1(input: {
  readonly request: SessionEndRequest;
  readonly effectivePolicy: PersistedQualityPolicyInputV1;
  readonly effectiveFinalCheckpoint?: CheckpointDraftV1 | CheckpointDraftV2;
}): SessionEndEffectiveStateV1 {
  const request = decodeSessionEndRequest(input.request);
  const effectivePolicy = decodePersistedQualityPolicyInputV1(input.effectivePolicy);
  const effectiveFinalCheckpoint = decodeCheckpointDraft(
    input.effectiveFinalCheckpoint ?? request.finalCheckpoint,
  );
  if (
    request.requestVersion !== effectiveFinalCheckpoint.checkpointVersion
    || canonicalJson(request.finalCheckpoint) !== canonicalJson(effectiveFinalCheckpoint)
  ) invalid("effectiveFinalCheckpoint");
  const withoutHash = Object.freeze({
    effectiveStateVersion: 1 as const,
    effectiveStateDomain: SESSION_END_EFFECTIVE_STATE_DOMAIN,
    request,
    effectivePolicy,
    effectiveFinalCheckpoint,
  });
  assertSessionEndEffectiveStateCanonicalSizeV1({
    ...withoutHash,
    effectiveStateHash: "0".repeat(64),
  });
  return decodeSessionEndEffectiveStateV1({
    ...withoutHash,
    effectiveStateHash: sessionEndEffectiveStateHashV1(withoutHash),
  });
}

/**
 * Folds a decoded amendment over the prior immutable request snapshot.
 * Nullable amendment fields mean "retain the prior value"; the resulting
 * request version follows the effective final checkpoint version so a V1
 * amendment can retain an existing V2 draft without silently downgrading it.
 */
export function foldSessionEndAmendmentV1(input: {
  readonly previous: SessionEndEffectiveStateV1;
  readonly amendment: SessionEndAmendment;
  readonly effectivePolicy: PersistedQualityPolicyInputV1;
}): SessionEndEffectiveStateV1 {
  const previous = decodeSessionEndEffectiveStateV1(input.previous);
  const amendment = decodeSessionEndAmendment(input.amendment);
  const priorRequest = previous.request;
  const finalCheckpoint = amendment.finalCheckpoint ?? priorRequest.finalCheckpoint;
  const request: SessionEndRequest = finalCheckpoint.checkpointVersion === 1
    ? {
      requestVersion: 1,
      sessionId: priorRequest.sessionId,
      childEndPolicy: amendment.childEndPolicy ?? priorRequest.childEndPolicy,
      finalCheckpoint,
      validationProfileIds: amendment.validationProfileIds ?? priorRequest.validationProfileIds,
      requestedQualityThreshold:
        amendment.requestedQualityThreshold ?? priorRequest.requestedQualityThreshold,
      requireFullEvidence: amendment.requireFullEvidence ?? priorRequest.requireFullEvidence,
      requireMaterialization: amendment.requireMaterialization ?? priorRequest.requireMaterialization,
    }
    : {
      requestVersion: 2,
      sessionId: priorRequest.sessionId,
      childEndPolicy: amendment.childEndPolicy ?? priorRequest.childEndPolicy,
      finalCheckpoint,
      validationProfileIds: amendment.validationProfileIds ?? priorRequest.validationProfileIds,
      requestedQualityThreshold:
        amendment.requestedQualityThreshold ?? priorRequest.requestedQualityThreshold,
      requireFullEvidence: amendment.requireFullEvidence ?? priorRequest.requireFullEvidence,
      requireMaterialization: amendment.requireMaterialization ?? priorRequest.requireMaterialization,
    };
  return createSessionEndEffectiveStateV1({
    request,
    effectivePolicy: input.effectivePolicy,
    effectiveFinalCheckpoint: finalCheckpoint,
  });
}

export function decodeSessionEndEffectiveStateV1(value: unknown): SessionEndEffectiveStateV1 {
  assertSessionEndEffectiveStateCanonicalSizeV1(value);
  const source = exactOwnDataRecord(value, EFFECTIVE_STATE_KEYS, "effectiveState");
  if (
    source.effectiveStateVersion !== 1
    || source.effectiveStateDomain !== SESSION_END_EFFECTIVE_STATE_DOMAIN
  ) invalid("effectiveState");
  const request = decodeSessionEndRequest(source.request);
  const effectivePolicy = decodePersistedQualityPolicyInputV1(source.effectivePolicy);
  const effectiveFinalCheckpoint = decodeCheckpointDraft(source.effectiveFinalCheckpoint);
  if (
    request.requestVersion !== effectiveFinalCheckpoint.checkpointVersion
    || canonicalJson(request.finalCheckpoint) !== canonicalJson(effectiveFinalCheckpoint)
  ) invalid("effectiveFinalCheckpoint");
  if (
    typeof source.effectiveStateHash !== "string"
    || !LOWER_HASH.test(source.effectiveStateHash)
    || source.effectiveStateHash !== sessionEndEffectiveStateHashV1(source)
  ) invalid("effectiveStateHash");
  return Object.freeze({
    effectiveStateVersion: 1,
    effectiveStateDomain: SESSION_END_EFFECTIVE_STATE_DOMAIN,
    request,
    effectivePolicy,
    effectiveFinalCheckpoint,
    effectiveStateHash: source.effectiveStateHash,
  });
}

export function assertSessionEndEffectiveStateRequestCorrelationV1(
  state: SessionEndEffectiveStateV1,
  request: SessionEndRequest,
): void {
  const decodedState = decodeSessionEndEffectiveStateV1(state);
  const decodedRequest = decodeSessionEndRequest(request);
  if (canonicalJson(decodedState.request) !== canonicalJson(decodedRequest)) {
    invalid("effectiveState.request");
  }
}

export function assertSessionEndEffectiveStateSessionCorrelationV1(
  state: SessionEndEffectiveStateV1,
  sessionId: SessionId,
): void {
  const decodedState = decodeSessionEndEffectiveStateV1(state);
  const expectedSessionId = parseCanonicalUuid(sessionId, "sessionId") as SessionId;
  if (decodedState.request.sessionId !== expectedSessionId) invalid("effectiveState.request.sessionId");
}

export function initialSessionEndEvidenceWindowStateV1(
  request: SessionEndRequest,
): "open" | "sealed" {
  return decodeSessionEndRequest(request).requestVersion === 1 ? "sealed" : "open";
}
