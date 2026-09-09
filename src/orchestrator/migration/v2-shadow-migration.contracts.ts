import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalJson } from "../serialization/canonical-json.js";

export const SHADOW_MIGRATION_PHASES = Object.freeze([
  "snapshot-verified",
  "package-sealed",
  "import-committed",
  "projection-verified",
  "parity-complete",
  "compatibility-complete",
] as const);

export type ShadowMigrationPhase = (typeof SHADOW_MIGRATION_PHASES)[number];

export type ShadowMigrationErrorCode =
  | "MIGRATION_POLICY_INVALID"
  | "MIGRATION_SOURCE_INVALID"
  | "MIGRATION_SOURCE_MUTATED"
  | "MIGRATION_LIMIT_EXCEEDED"
  | "MIGRATION_IDENTITY_CONFLICT"
  | "MIGRATION_LEDGER_INTEGRITY_FAILURE"
  | "MIGRATION_OUTCOME_UNKNOWN"
  | "MIGRATION_RETRY_EXHAUSTED"
  | "PROJECTION_INTEGRITY_FAILURE"
  | "PARITY_RULE_INVALID"
  | "PARITY_BLOCKING_DIVERGENCE"
  | "COMPATIBILITY_INTEGRITY_FAILURE";

export class ShadowMigrationError extends Error {
  public constructor(
    public readonly code: ShadowMigrationErrorCode,
    public readonly safeDetails: Readonly<Record<string, string | number>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ShadowMigrationError";
  }
}

export interface ShadowMigrationPolicyV1 {
  readonly schemaVersion: 1;
  readonly maxEvents: number;
  readonly maxAggregateBytes: number;
  readonly maxEventBytes: number;
  readonly maxBatchEvents: number;
  readonly maxBatchBytes: number;
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly expectedDifferencePolicyVersion: number;
  readonly maxExpectedDifferenceRuleAgeMs: number;
}

export interface ShadowMigrationConfigurationV1 {
  readonly schemaVersion: 1;
  readonly policyChecksum: string;
  readonly packageFormatVersion: 1;
  readonly migrationAlgorithmVersion: 1;
  readonly expectedDifferencePolicyVersion: number;
}

export interface ShadowMigrationIdentityInput {
  readonly projectId: string;
  readonly storeId: string;
  readonly sourceManifestChecksum: string;
  readonly terminalEventHash: string;
  readonly packageChecksum: string;
  readonly migrationAlgorithmVersion: 1;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
}

const POLICY_KEYS = [
  "schemaVersion",
  "maxEvents",
  "maxAggregateBytes",
  "maxEventBytes",
  "maxBatchEvents",
  "maxBatchBytes",
  "deadlineMs",
  "maxRetries",
  "initialBackoffMs",
  "maxBackoffMs",
  "expectedDifferencePolicyVersion",
  "maxExpectedDifferenceRuleAgeMs",
] as const;
const CONFIGURATION_KEYS = [
  "schemaVersion",
  "policyChecksum",
  "packageFormatVersion",
  "migrationAlgorithmVersion",
  "expectedDifferencePolicyVersion",
] as const;
const IDENTITY_KEYS = [
  "projectId",
  "storeId",
  "sourceManifestChecksum",
  "terminalEventHash",
  "packageChecksum",
  "migrationAlgorithmVersion",
  "buildIdentityHash",
  "configurationChecksum",
] as const;
const UUID_PURPOSES = ["attempt", "command", "event", "claim"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const POLICY_DOMAIN = "project-memory/v2-shadow-migration-policy/v1";
const CONFIGURATION_DOMAIN = "project-memory/v2-shadow-migration-configuration/v1";
const IDENTITY_DOMAIN = "project-memory/v2-shadow-migration-identity/v1";
const UUID_DOMAIN = "project-memory/v2-shadow-migration-uuid/v1";

export function decodeShadowMigrationPolicyV1(input: unknown): ShadowMigrationPolicyV1 {
  try {
    const value = strictRecord(input, POLICY_KEYS);
    const policy: ShadowMigrationPolicyV1 = {
      schemaVersion: literalOne(value.schemaVersion),
      maxEvents: boundedInteger(value.maxEvents, 1, 100_000),
      maxAggregateBytes: boundedInteger(value.maxAggregateBytes, 1, 67_108_864),
      maxEventBytes: boundedInteger(value.maxEventBytes, 1, 1_048_576),
      maxBatchEvents: boundedInteger(value.maxBatchEvents, 1, 1_000),
      maxBatchBytes: boundedInteger(value.maxBatchBytes, 1, 8_388_608),
      deadlineMs: boundedInteger(value.deadlineMs, 1, 300_000),
      maxRetries: boundedInteger(value.maxRetries, 0, 3),
      initialBackoffMs: boundedInteger(value.initialBackoffMs, 10, 500),
      maxBackoffMs: boundedInteger(value.maxBackoffMs, 10, 2_000),
      expectedDifferencePolicyVersion: positiveVersion(value.expectedDifferencePolicyVersion),
      maxExpectedDifferenceRuleAgeMs: boundedInteger(
        value.maxExpectedDifferenceRuleAgeMs,
        1,
        604_800_000,
      ),
    };
    if (policy.maxBackoffMs < policy.initialBackoffMs) invalid();
    return deepFreeze(policy);
  } catch (error) {
    throw policyInvalid(error);
  }
}

export function decodeShadowMigrationConfigurationV1(input: unknown): ShadowMigrationConfigurationV1 {
  try {
    const value = strictRecord(input, CONFIGURATION_KEYS);
    return deepFreeze({
      schemaVersion: literalOne(value.schemaVersion),
      policyChecksum: hash(value.policyChecksum),
      packageFormatVersion: literalOne(value.packageFormatVersion),
      migrationAlgorithmVersion: literalOne(value.migrationAlgorithmVersion),
      expectedDifferencePolicyVersion: positiveVersion(value.expectedDifferencePolicyVersion),
    });
  } catch (error) {
    throw policyInvalid(error);
  }
}

export function shadowMigrationPolicyChecksum(policy: ShadowMigrationPolicyV1): string {
  const decoded = decodeShadowMigrationPolicyV1(policy);
  return sha256(`${POLICY_DOMAIN}\n${canonicalJson(decoded)}`);
}

export function shadowMigrationConfigurationChecksum(
  configuration: ShadowMigrationConfigurationV1,
): string {
  const decoded = decodeShadowMigrationConfigurationV1(configuration);
  return sha256(`${CONFIGURATION_DOMAIN}\n${canonicalJson(decoded)}`);
}

export function shadowMigrationIdentity(input: ShadowMigrationIdentityInput): string {
  try {
    const value = strictRecord(input, IDENTITY_KEYS);
    const decoded: ShadowMigrationIdentityInput = deepFreeze({
      projectId: uuid(value.projectId),
      storeId: uuid(value.storeId),
      sourceManifestChecksum: hash(value.sourceManifestChecksum),
      terminalEventHash: hash(value.terminalEventHash),
      packageChecksum: hash(value.packageChecksum),
      migrationAlgorithmVersion: literalOne(value.migrationAlgorithmVersion),
      buildIdentityHash: hash(value.buildIdentityHash),
      configurationChecksum: hash(value.configurationChecksum),
    });
    return sha256(`${IDENTITY_DOMAIN}\n${canonicalJson(decoded)}`);
  } catch (error) {
    throw sourceInvalid(error);
  }
}

export function deterministicMigrationUuid(
  purpose: "attempt" | "command" | "event" | "claim",
  migrationIdentity: string,
  ordinal: number,
): string {
  try {
    if (typeof purpose !== "string" || !UUID_PURPOSES.includes(purpose)) invalid();
    const decodedIdentity = hash(migrationIdentity);
    const decodedOrdinal = boundedInteger(ordinal, 0, Number.MAX_SAFE_INTEGER);
    const bytes = Buffer.from(
      sha256(`${UUID_DOMAIN}\n${canonicalJson({
        purpose,
        migrationIdentity: decodedIdentity,
        ordinal: decodedOrdinal,
      })}`),
      "hex",
    );
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch (error) {
    throw sourceInvalid(error);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null) invalid();
  if (utilTypes.isProxy(input)) invalid();
  if (Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();

  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    invalid();
  }

  const descriptors: Record<string, PropertyDescriptor> = Object.create(null) as Record<string, PropertyDescriptor>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) invalid();
    descriptors[key] = descriptor;
  }

  const decoded: Record<string, unknown> = {};
  for (const key of keys) decoded[key] = descriptors[key]!.value;
  return decoded;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    invalid();
  }
  return value as number;
}

function positiveVersion(value: unknown): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function literalOne(value: unknown): 1 {
  if (value !== 1) invalid();
  return 1;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
  return value;
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

function policyInvalid(cause: unknown): ShadowMigrationError {
  return new ShadowMigrationError("MIGRATION_POLICY_INVALID", Object.freeze({}), { cause });
}

function sourceInvalid(cause: unknown): ShadowMigrationError {
  return new ShadowMigrationError("MIGRATION_SOURCE_INVALID", Object.freeze({}), { cause });
}

function invalid(): never {
  throw new TypeError("SHADOW_MIGRATION_INPUT_INVALID");
}
