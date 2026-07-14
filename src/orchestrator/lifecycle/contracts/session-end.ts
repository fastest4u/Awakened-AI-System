import { LifecycleError } from "../errors.js";
import type { ProjectId, StoreId, VaultId, WorkspaceId } from "../../identity/contracts.js";
import {
  decodeCheckpointDraftV1,
  type CheckpointDraftV1,
  type SourceStateFingerprintV1,
} from "./checkpoint.js";
import {
  exactRecord,
  parseBoolean,
  parseBoundedString,
  parseCanonicalTimestamp,
  parseEnum,
  parseInteger,
  parseLifecycleId,
  strictArray,
  type CheckpointId,
  type ChildEndPolicy,
  type SessionId,
  type ValidationResultId,
  type WorkflowId,
} from "./identifiers.js";

export const QUALITY_POLICY_MAX_PROFILES = 64;
export const QUALITY_THRESHOLD_MAX = 10_000;
export const QUALITY_PROFILE_WEIGHT_MAX = 1_000_000;

const CHILD_END_POLICIES = ["require-completed", "suspend-and-carry-forward"] as const;
const VALIDATION_STATUSES = ["pass", "fail", "unavailable"] as const;
const VALIDATION_EXIT_CLASSIFICATIONS = ["passed", "failed", "unavailable", "not-run"] as const;
const LOWER_HASH = /^[0-9a-f]{64}$/;

export interface QualityProfileV1 {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly required: boolean;
  readonly weight: number;
}

export interface QualityPolicyV1 {
  readonly qualityPolicyVersion: 1;
  readonly profiles: readonly QualityProfileV1[];
  readonly qualityThreshold: number;
  readonly requireFullEvidence: boolean;
  readonly requireMaterialization: boolean;
  readonly totalEffectiveWeight: number;
}

export interface SessionEndRequestV1 {
  readonly requestVersion: 1;
  readonly sessionId: SessionId;
  readonly childEndPolicy: ChildEndPolicy;
  readonly finalCheckpoint: CheckpointDraftV1;
  readonly validationProfileIds: readonly string[];
  readonly requestedQualityThreshold: number;
  readonly requireFullEvidence: boolean;
  readonly requireMaterialization: boolean;
}

export interface SessionEndAmendmentV1 {
  readonly amendmentVersion: 1;
  readonly childEndPolicy: ChildEndPolicy | null;
  readonly finalCheckpoint: CheckpointDraftV1 | null;
  readonly validationProfileIds: readonly string[] | null;
  readonly requestedQualityThreshold: number | null;
  readonly requireFullEvidence: boolean | null;
  readonly requireMaterialization: boolean | null;
}

export const SESSION_END_PHASES = Object.freeze([
  "requested",
  "children-resolved",
  "final-checkpoint-recorded",
  "ending-materialization-queued",
  "validating",
  "verification-passed",
  "verification-failed",
  "completion-appended",
  "completed-materialization-confirmed",
  "completed",
  "cancelled",
  "abandoned",
] as const);

export type SessionEndPhase = (typeof SESSION_END_PHASES)[number];

export interface ValidationOutputFingerprintV1 {
  readonly fingerprintSchemaVersion: 1;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: string;
  readonly fingerprint: string;
}

export interface ValidationResultV1 {
  readonly validationResultVersion: 1;
  readonly resultId: ValidationResultId;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly finalCheckpointId: CheckpointId;
  readonly finalCheckpointFingerprint: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileConfigurationHash: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly sourceStateAtStart: SourceStateFingerprintV1;
  readonly sourceStateAtCompletion: SourceStateFingerprintV1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: (typeof VALIDATION_STATUSES)[number];
  readonly exitClassification: (typeof VALIDATION_EXIT_CLASSIFICATIONS)[number];
  readonly summary: string;
  readonly outputFingerprint: ValidationOutputFingerprintV1;
  readonly artifactReferences: readonly string[];
  readonly fresh: boolean;
}

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeProfile(value: unknown, field: string): QualityProfileV1 {
  const profile = exactRecord(value, ["profileId", "profileVersion", "required", "weight"], field);
  return Object.freeze({
    profileId: parseBoundedString(profile.profileId, `${field}.profileId`, 256),
    profileVersion: parseInteger(profile.profileVersion, `${field}.profileVersion`, 1, Number.MAX_SAFE_INTEGER),
    required: parseBoolean(profile.required, `${field}.required`),
    weight: parseInteger(profile.weight, `${field}.weight`, 1, QUALITY_PROFILE_WEIGHT_MAX),
  });
}

export function decodeQualityPolicyV1(value: unknown): QualityPolicyV1 {
  const policy = exactRecord(value, [
    "qualityPolicyVersion",
    "profiles",
    "qualityThreshold",
    "requireFullEvidence",
    "requireMaterialization",
  ], "qualityPolicy");
  if (policy.qualityPolicyVersion !== 1) invalid("qualityPolicyVersion");
  const source = strictArray(policy.profiles, "profiles");
  if (source.length === 0 || source.length > QUALITY_POLICY_MAX_PROFILES) invalid("profiles");
  const profiles = source.map((item, index) => decodeProfile(item, `profiles[${index}]`));
  const identities = new Set<string>();
  let totalEffectiveWeight = 0;
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (profile === undefined) invalid("profiles");
    const identity = `${profile.profileId}\u0000${profile.profileVersion}`;
    if (identities.has(identity)) invalid("profiles");
    identities.add(identity);
    totalEffectiveWeight += profile.weight;
    if (!Number.isSafeInteger(totalEffectiveWeight)) invalid("profiles.totalEffectiveWeight");
    const previous = profiles[index - 1];
    if (previous !== undefined) {
      const idOrder = lexicalCompare(previous.profileId, profile.profileId);
      if (idOrder > 0 || (idOrder === 0 && previous.profileVersion >= profile.profileVersion)) invalid("profiles");
    }
  }
  if (totalEffectiveWeight <= 0) invalid("profiles.totalEffectiveWeight");
  return Object.freeze({
    qualityPolicyVersion: 1,
    profiles: Object.freeze(profiles),
    qualityThreshold: parseInteger(policy.qualityThreshold, "qualityThreshold", 0, QUALITY_THRESHOLD_MAX),
    requireFullEvidence: parseBoolean(policy.requireFullEvidence, "requireFullEvidence"),
    requireMaterialization: parseBoolean(policy.requireMaterialization, "requireMaterialization"),
    totalEffectiveWeight,
  });
}

function decodeProfileIds(value: unknown): readonly string[] {
  const source = strictArray(value, "validationProfileIds");
  if (source.length > QUALITY_POLICY_MAX_PROFILES) invalid("validationProfileIds");
  const profiles = source.map((item, index) =>
    parseBoundedString(item, `validationProfileIds[${index}]`, 256));
  if (new Set(profiles).size !== profiles.length) invalid("validationProfileIds");
  for (let index = 1; index < profiles.length; index += 1) {
    const previous = profiles[index - 1];
    const current = profiles[index];
    if (previous === undefined || current === undefined || lexicalCompare(previous, current) >= 0) {
      invalid("validationProfileIds");
    }
  }
  return Object.freeze(profiles);
}

export function decodeSessionEndRequestV1(value: unknown): SessionEndRequestV1 {
  const request = exactRecord(value, [
    "requestVersion",
    "sessionId",
    "childEndPolicy",
    "finalCheckpoint",
    "validationProfileIds",
    "requestedQualityThreshold",
    "requireFullEvidence",
    "requireMaterialization",
  ], "sessionEndRequest");
  if (request.requestVersion !== 1) invalid("requestVersion");
  return Object.freeze({
    requestVersion: 1,
    sessionId: parseLifecycleId<SessionId>(request.sessionId, "sessionId"),
    childEndPolicy: parseEnum(request.childEndPolicy, CHILD_END_POLICIES, "childEndPolicy"),
    finalCheckpoint: decodeCheckpointDraftV1(request.finalCheckpoint),
    validationProfileIds: decodeProfileIds(request.validationProfileIds),
    requestedQualityThreshold: parseInteger(
      request.requestedQualityThreshold,
      "requestedQualityThreshold",
      0,
      QUALITY_THRESHOLD_MAX,
    ),
    requireFullEvidence: parseBoolean(request.requireFullEvidence, "requireFullEvidence"),
    requireMaterialization: parseBoolean(request.requireMaterialization, "requireMaterialization"),
  });
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  return value === null ? null : parseBoolean(value, field);
}

function nullableThreshold(value: unknown): number | null {
  return value === null
    ? null
    : parseInteger(value, "requestedQualityThreshold", 0, QUALITY_THRESHOLD_MAX);
}

export function decodeSessionEndAmendmentV1(value: unknown): SessionEndAmendmentV1 {
  const amendment = exactRecord(value, [
    "amendmentVersion",
    "childEndPolicy",
    "finalCheckpoint",
    "validationProfileIds",
    "requestedQualityThreshold",
    "requireFullEvidence",
    "requireMaterialization",
  ], "sessionEndAmendment");
  if (amendment.amendmentVersion !== 1) invalid("amendmentVersion");
  const childEndPolicy = amendment.childEndPolicy === null
    ? null
    : parseEnum(amendment.childEndPolicy, CHILD_END_POLICIES, "childEndPolicy");
  const finalCheckpoint = amendment.finalCheckpoint === null
    ? null
    : decodeCheckpointDraftV1(amendment.finalCheckpoint);
  const validationProfileIds = amendment.validationProfileIds === null
    ? null
    : decodeProfileIds(amendment.validationProfileIds);
  const requestedQualityThreshold = nullableThreshold(amendment.requestedQualityThreshold);
  const requireFullEvidence = nullableBoolean(amendment.requireFullEvidence, "requireFullEvidence");
  const requireMaterialization = nullableBoolean(amendment.requireMaterialization, "requireMaterialization");
  if (
    childEndPolicy === null
    && finalCheckpoint === null
    && validationProfileIds === null
    && requestedQualityThreshold === null
    && requireFullEvidence === null
    && requireMaterialization === null
  ) invalid("sessionEndAmendment");
  return Object.freeze({
    amendmentVersion: 1,
    childEndPolicy,
    finalCheckpoint,
    validationProfileIds,
    requestedQualityThreshold,
    requireFullEvidence,
    requireMaterialization,
  });
}

export function assertValidationResultShape(result: ValidationResultV1): void {
  if (
    result.validationResultVersion !== 1
    || !LOWER_HASH.test(result.profileConfigurationHash)
    || !LOWER_HASH.test(result.finalCheckpointFingerprint)
    || result.workflowGeneration < 1
  ) invalid("validationResult");
  parseCanonicalTimestamp(result.startedAt, "validationResult.startedAt");
  parseCanonicalTimestamp(result.completedAt, "validationResult.completedAt");
  parseEnum(result.status, VALIDATION_STATUSES, "validationResult.status");
  parseEnum(result.exitClassification, VALIDATION_EXIT_CLASSIFICATIONS, "validationResult.exitClassification");
}
