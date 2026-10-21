import { createHash } from "node:crypto";

export type RolloutMode =
  | "off"
  | "shadow"
  | "canary"
  | "primary"
  | "rollback-pending"
  | "read-only-recovery";

export interface RolloutRevision {
  readonly projectId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly buildIdentityHash: string;
  readonly migrationIdentityHash: string;
  readonly configurationChecksum: string;
  readonly v1BaselineChecksum: string;
  readonly cohortAlgorithmVersion: 1;
  readonly cohortSalt: string;
  readonly cohortBasisPoints: number;
  readonly createdAt: string;
}

export interface RolloutCohortBinding {
  readonly projectId: string;
  readonly workspaceId: string;
}

export class RolloutControlPlaneError extends Error {
  public constructor(
    public readonly code:
      | "ROLLOUT_INPUT_INVALID"
      | "ROLLOUT_SCOPE_DENIED"
      | "ROLLOUT_STATE_CONFLICT"
      | "ROLLOUT_TRANSITION_DENIED"
      | "ROLLOUT_V2_ROUTING_DISABLED"
      | "ROLLOUT_INTEGRITY_FAILURE",
  ) {
    super(code);
    this.name = "RolloutControlPlaneError";
  }
}

const ROLLOUT_REVISION_KEYS = [
  "projectId",
  "revisionId",
  "parentRevisionId",
  "buildIdentityHash",
  "migrationIdentityHash",
  "configurationChecksum",
  "v1BaselineChecksum",
  "cohortAlgorithmVersion",
  "cohortSalt",
  "cohortBasisPoints",
  "createdAt",
] as const;

const ROLLOUT_COHORT_BINDING_KEYS = ["projectId", "workspaceId"] as const;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COHORT_HASH_DOMAIN = "project-memory/v2-rollout-cohort/v1";

export function decodeRolloutRevision(input: unknown): RolloutRevision {
  try {
    const value = decodeStrictRecord(input, ROLLOUT_REVISION_KEYS);
    const parentRevisionId = value.parentRevisionId;

    if (parentRevisionId !== null && !isCanonicalUuid(parentRevisionId)) invalidInput();

    const revision: RolloutRevision = {
      projectId: decodeUuid(value.projectId),
      revisionId: decodeUuid(value.revisionId),
      parentRevisionId,
      buildIdentityHash: decodeHash(value.buildIdentityHash),
      migrationIdentityHash: decodeHash(value.migrationIdentityHash),
      configurationChecksum: decodeHash(value.configurationChecksum),
      v1BaselineChecksum: decodeHash(value.v1BaselineChecksum),
      cohortAlgorithmVersion: decodeAlgorithmVersion(value.cohortAlgorithmVersion),
      cohortSalt: decodeHash(value.cohortSalt),
      cohortBasisPoints: decodeBasisPoints(value.cohortBasisPoints),
      createdAt: decodeTimestamp(value.createdAt),
    };

    return deepFreeze(revision);
  } catch (error) {
    return invalidInput();
  }
}

export function cohortBucket(revision: RolloutRevision, binding: RolloutCohortBinding): number {
  const decodedRevision = decodeRolloutRevision(revision);
  const decodedBinding = decodeRolloutCohortBinding(binding);

  if (decodedBinding.projectId !== decodedRevision.projectId) {
    throw new RolloutControlPlaneError("ROLLOUT_SCOPE_DENIED");
  }

  const digest = createHash("sha256")
    .update(
      [
        COHORT_HASH_DOMAIN,
        decodedRevision.revisionId,
        String(decodedRevision.cohortAlgorithmVersion),
        decodedRevision.cohortSalt,
        decodedBinding.projectId,
        decodedBinding.workspaceId,
      ].join("\n"),
      "utf8",
    )
    .digest();

  return digest.readUInt32BE(0) % 10000;
}

export function isSelectedCanaryCohort(revision: RolloutRevision, binding: RolloutCohortBinding): boolean {
  const decodedRevision = decodeRolloutRevision(revision);
  return cohortBucket(decodedRevision, binding) < decodedRevision.cohortBasisPoints;
}

function decodeRolloutCohortBinding(input: unknown): RolloutCohortBinding {
  try {
    const value = decodeStrictRecord(input, ROLLOUT_COHORT_BINDING_KEYS);
    const workspaceId = value.workspaceId;

    if (!isSensibleWorkspaceId(workspaceId)) invalidInput();

    return deepFreeze({
      projectId: decodeUuid(value.projectId),
      workspaceId,
    });
  } catch (error) {
    return invalidInput();
  }
}

function decodeStrictRecord(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalidInput();
  if (Object.getPrototypeOf(input) !== Object.prototype) invalidInput();

  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== "string")) invalidInput();

  const actualKeys = new Set(ownKeys);
  if (expectedKeys.some((key) => !actualKeys.has(key))) invalidInput();

  const decoded: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidInput();
    decoded[key] = descriptor.value;
  }

  return decoded;
}

function decodeUuid(value: unknown): string {
  if (!isCanonicalUuid(value)) invalidInput();
  return value;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function decodeHash(value: unknown): string {
  if (typeof value !== "string" || !LOWERCASE_SHA256_PATTERN.test(value)) invalidInput();
  return value;
}

function decodeAlgorithmVersion(value: unknown): 1 {
  if (value !== 1) invalidInput();
  return 1;
}

function decodeBasisPoints(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000) invalidInput();
  return value;
}

function decodeTimestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_UTC_MILLIS_PATTERN.test(value)) invalidInput();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) invalidInput();
  return value;
}

function isSensibleWorkspaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }

  return Object.freeze(value);
}

function invalidInput(): never {
  throw new RolloutControlPlaneError("ROLLOUT_INPUT_INVALID");
}
