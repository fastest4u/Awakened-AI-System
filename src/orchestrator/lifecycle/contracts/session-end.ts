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
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VALIDATION_RESULT_MAX_ARTIFACT_REFERENCES = 100;
const VALIDATION_RESULT_MAX_SUMMARY_SCALARS = 4_000;

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
  readonly fingerprintDomain: "pm-validation-output-v1";
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

function validationResultInvalid(): never {
  throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
}

const VALIDATION_RESULT_KEYS = [
  "validationResultVersion",
  "resultId",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "sessionId",
  "workflowId",
  "workflowGeneration",
  "finalCheckpointId",
  "finalCheckpointFingerprint",
  "profileId",
  "profileVersion",
  "profileConfigurationHash",
  "runId",
  "runnerId",
  "sourceStateAtStart",
  "sourceStateAtCompletion",
  "startedAt",
  "completedAt",
  "status",
  "exitClassification",
  "summary",
  "outputFingerprint",
  "artifactReferences",
  "fresh",
] as const;

const VALIDATION_SOURCE_STATE_KEYS = [
  "sourceStateScopeVersion",
  "workspaceId",
  "branchRef",
  "headCommit",
  "dirtyWorktreeFingerprint",
] as const;

const VALIDATION_OUTPUT_FINGERPRINT_KEYS = [
  "fingerprintSchemaVersion",
  "fingerprintKeyId",
  "fingerprintDomain",
  "fingerprint",
] as const;

function decodeValidationSourceState(
  value: unknown,
  field: string,
  expectedWorkspaceId: string,
): SourceStateFingerprintV1 {
  const state = exactRecord(
    value,
    VALIDATION_SOURCE_STATE_KEYS,
    field,
    "SESSION_VALIDATION_RESULT_INVALID",
  );
  if (
    state.sourceStateScopeVersion !== 1
    || typeof state.workspaceId !== "string"
    || !LOWER_HASH.test(state.workspaceId)
    || state.workspaceId !== expectedWorkspaceId
  ) validationResultInvalid();
  const branchRef = state.branchRef === null
    ? null
    : parseBoundedString(state.branchRef, `${field}.branchRef`, 1_024);
  const headCommit = state.headCommit;
  if (headCommit !== null && (typeof headCommit !== "string" || !GIT_OBJECT_ID.test(headCommit))) {
    validationResultInvalid();
  }
  if (
    typeof state.dirtyWorktreeFingerprint !== "string"
    || !LOWER_HASH.test(state.dirtyWorktreeFingerprint)
  ) validationResultInvalid();
  return Object.freeze({
    sourceStateScopeVersion: 1,
    workspaceId: state.workspaceId,
    branchRef,
    headCommit: headCommit as string | null,
    dirtyWorktreeFingerprint: state.dirtyWorktreeFingerprint,
  });
}

function decodeValidationOutputFingerprint(value: unknown): ValidationOutputFingerprintV1 {
  const fingerprint = exactRecord(
    value,
    VALIDATION_OUTPUT_FINGERPRINT_KEYS,
    "validationResult.outputFingerprint",
    "SESSION_VALIDATION_RESULT_INVALID",
  );
  if (
    fingerprint.fingerprintSchemaVersion !== 1
    || fingerprint.fingerprintDomain !== "pm-validation-output-v1"
    || typeof fingerprint.fingerprint !== "string"
    || !LOWER_HASH.test(fingerprint.fingerprint)
  ) validationResultInvalid();
  return Object.freeze({
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: parseBoundedString(
      fingerprint.fingerprintKeyId,
      "validationResult.outputFingerprint.fingerprintKeyId",
      128,
    ),
    fingerprintDomain: "pm-validation-output-v1",
    fingerprint: fingerprint.fingerprint,
  });
}

export function decodeValidationResultV1(value: unknown): ValidationResultV1 {
  try {
    const result = exactRecord(
      value,
      VALIDATION_RESULT_KEYS,
      "validationResult",
      "SESSION_VALIDATION_RESULT_INVALID",
    );
    if (result.validationResultVersion !== 1) validationResultInvalid();
    const workspaceId = result.workspaceId;
    if (typeof workspaceId !== "string" || !LOWER_HASH.test(workspaceId)) {
      validationResultInvalid();
    }
    const finalCheckpointFingerprint = result.finalCheckpointFingerprint;
    const profileConfigurationHash = result.profileConfigurationHash;
    if (
      typeof finalCheckpointFingerprint !== "string"
      || !LOWER_HASH.test(finalCheckpointFingerprint)
      || typeof profileConfigurationHash !== "string"
      || !LOWER_HASH.test(profileConfigurationHash)
    ) validationResultInvalid();
    const startedAt = parseCanonicalTimestamp(result.startedAt, "validationResult.startedAt");
    const completedAt = parseCanonicalTimestamp(result.completedAt, "validationResult.completedAt");
    if (completedAt < startedAt) validationResultInvalid();
    const artifactSource = strictArray(
      result.artifactReferences,
      "validationResult.artifactReferences",
      "SESSION_VALIDATION_RESULT_INVALID",
    );
    if (artifactSource.length > VALIDATION_RESULT_MAX_ARTIFACT_REFERENCES) {
      validationResultInvalid();
    }
    const artifactReferences = Object.freeze(artifactSource.map((reference, index) =>
      parseBoundedString(
        reference,
        `validationResult.artifactReferences[${index}]`,
        512,
      )));
    return Object.freeze({
      validationResultVersion: 1,
      resultId: parseLifecycleId<ValidationResultId>(result.resultId, "validationResult.resultId"),
      projectId: parseLifecycleId<ProjectId>(result.projectId, "validationResult.projectId"),
      vaultId: parseLifecycleId<VaultId>(result.vaultId, "validationResult.vaultId"),
      storeId: parseLifecycleId<StoreId>(result.storeId, "validationResult.storeId"),
      workspaceId: workspaceId as WorkspaceId,
      sessionId: parseLifecycleId<SessionId>(result.sessionId, "validationResult.sessionId"),
      workflowId: parseLifecycleId<WorkflowId>(result.workflowId, "validationResult.workflowId"),
      workflowGeneration: parseInteger(
        result.workflowGeneration,
        "validationResult.workflowGeneration",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      finalCheckpointId: parseLifecycleId<CheckpointId>(
        result.finalCheckpointId,
        "validationResult.finalCheckpointId",
      ),
      finalCheckpointFingerprint,
      profileId: parseBoundedString(result.profileId, "validationResult.profileId", 256),
      profileVersion: parseInteger(
        result.profileVersion,
        "validationResult.profileVersion",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      profileConfigurationHash,
      runId: parseLifecycleId(result.runId, "validationResult.runId"),
      runnerId: parseLifecycleId(result.runnerId, "validationResult.runnerId"),
      sourceStateAtStart: decodeValidationSourceState(
        result.sourceStateAtStart,
        "validationResult.sourceStateAtStart",
        workspaceId,
      ),
      sourceStateAtCompletion: decodeValidationSourceState(
        result.sourceStateAtCompletion,
        "validationResult.sourceStateAtCompletion",
        workspaceId,
      ),
      startedAt,
      completedAt,
      status: parseEnum(result.status, VALIDATION_STATUSES, "validationResult.status"),
      exitClassification: parseEnum(
        result.exitClassification,
        VALIDATION_EXIT_CLASSIFICATIONS,
        "validationResult.exitClassification",
      ),
      summary: parseBoundedString(
        result.summary,
        "validationResult.summary",
        VALIDATION_RESULT_MAX_SUMMARY_SCALARS,
      ),
      outputFingerprint: decodeValidationOutputFingerprint(result.outputFingerprint),
      artifactReferences,
      fresh: parseBoolean(result.fresh, "validationResult.fresh"),
    });
  } catch {
    validationResultInvalid();
  }
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
  void decodeValidationResultV1(result);
}
