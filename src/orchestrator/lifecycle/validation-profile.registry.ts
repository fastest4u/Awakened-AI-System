import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import type { ValidationAttemptPlanIdentityV1 } from "./contracts/commands.js";
import type { PersistedValidationAttemptPlanV1 } from "../storage/session-end.repository.js";
import {
  parseBoundedString,
  parseCanonicalUuid,
  parseInteger,
  type CheckpointId,
  type SessionId,
  type WorkflowId,
} from "./contracts/identifiers.js";
import type { ProjectId, StoreId, VaultId, WorkspaceId } from "../identity/contracts.js";
import { LifecycleError } from "./errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { uuidV5 } from "../crypto/uuid-v5.js";

const MAX_PROFILES = 64;
const MAX_ARGS = 128;
const MAX_ENV_ENTRIES = 128;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const PERSISTED_PLAN_KEYS = ["profileId", "profileVersion", "runId", "resultId", "commandId", "idempotencyKey"] as const;

export const VALIDATION_RUN_NAMESPACE = "1c6d7f04-6d38-5f50-bc2b-1c6a3f22f9e4";
export const VALIDATION_RESULT_NAMESPACE = "9c1f39e7-0f2b-5f92-a8f2-2d4b3d5f0b3c";
export const VALIDATION_COMMAND_NAMESPACE = "b10a5f9d-4db2-5d0c-8cf2-7a3ce6e8a0e1";

export interface TrustedValidationProfileEntry {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly runnerId: string;
}

export interface ResolvedTrustedValidationProfile extends TrustedValidationProfileEntry {
  readonly configurationHash: string;
}

export interface ValidationProfileKey {
  readonly profileId: string;
  readonly profileVersion: number;
}

/**
 * The composition root may narrow the immutable profile table to an explicit
 * executable and working-directory allowlist.  When omitted, the paths in
 * the supplied trusted table become that closed allowlist; no runner input
 * can add or replace an entry after construction.
 */
export interface TrustedValidationProfileRegistryOptions {
  readonly executableAllowlist?: readonly string[];
  readonly workingDirectoryAllowlist?: readonly string[];
}

export interface ValidationAttemptExpansionContext {
  readonly projectId: ProjectId | string;
  readonly vaultId: VaultId | string;
  readonly storeId: StoreId | string;
  readonly workspaceId: WorkspaceId | string;
  readonly sessionId: SessionId | string;
  readonly workflowId: WorkflowId | string;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly finalCheckpointId: CheckpointId | string;
  readonly finalCheckpointFingerprint: string;
}

export interface ValidationAttemptPlanCreationInput extends ValidationAttemptExpansionContext {
  readonly profiles: readonly ValidationProfileKey[];
}

export interface ExpandValidationAttemptPlanInput {
  readonly plan: unknown;
  readonly context: ValidationAttemptExpansionContext;
  readonly expectedProfileConfigurationHash: string;
}

export interface BoundValidationAttemptPlanV1 {
  readonly plan: PersistedValidationAttemptPlanV1;
  readonly expectedProfileConfigurationHash: string;
}

type ValidatedValidationAttemptExpansionContext = Omit<
  ValidationAttemptExpansionContext,
  "projectId" | "vaultId" | "storeId" | "workspaceId" | "sessionId" | "workflowId" | "finalCheckpointId"
> & {
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly workflowId: WorkflowId;
  readonly finalCheckpointId: CheckpointId;
};

function invalid(): never {
  throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cloneAndFreeze<T>(value: T): T {
  const parsed = JSON.parse(canonicalJson(value)) as unknown;
  const freeze = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      for (const item of current) freeze(item);
    } else if (plainRecord(current)) {
      for (const item of Object.values(current)) freeze(item);
    }
    return Object.freeze(current);
  };
  return freeze(parsed) as T;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileKey(profileId: string, profileVersion: number): string {
  return `${profileId}\u0000${profileVersion}`;
}

function noNul(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\u0000")) invalid();
  return parseBoundedString(value, field, 4_096);
}

function canonicalTrustedPath(value: unknown, field: string): string {
  const source = noNul(value as string, field);
  if (!isAbsolute(source)) invalid();
  const normalized = normalize(resolve(source));
  try {
    return existsSync(normalized) ? realpathSync.native(normalized) : normalized;
  } catch {
    return normalized;
  }
}

function trustedPathKey(value: string): string {
  const canonical = canonicalTrustedPath(value, "trustedPath");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function trustedUuid(value: unknown, field: string): string {
  try {
    return parseCanonicalUuid(value, field);
  } catch {
    return invalid();
  }
}

function strictStringArray(value: unknown, field: string, maximumEntries: number): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximumEntries) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key, index) => key !== (index === value.length ? "length" : String(index)))) invalid();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)
      || typeof descriptor.value !== "string" || descriptor.value.includes("\u0000")
      || Array.from(descriptor.value).length > 4_096) invalid();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function strictEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!plainRecord(value) || Reflect.ownKeys(value).length > MAX_ENV_ENTRIES) invalid();
  const result: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)
      || typeof descriptor.value !== "string" || descriptor.value.includes("\u0000")
      || Array.from(descriptor.value).length > 4_096) invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function validateProfileEntry(input: TrustedValidationProfileEntry): TrustedValidationProfileEntry {
  if (!plainRecord(input)) invalid();
  const allowedKeys = new Set(["profileId", "profileVersion", "executable", "args", "cwd", "env", "timeoutMs", "maxOutputBytes", "runnerId"]);
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) invalid();
  for (const key of ["profileId", "profileVersion", "executable", "args", "cwd", "timeoutMs", "maxOutputBytes", "runnerId"]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) invalid();
  }
  const profileId = parseBoundedString(input.profileId, "profileId", 256);
  if (profileId.includes("\u0000")) invalid();
  const profileVersion = parseInteger(input.profileVersion, "profileVersion", 1, Number.MAX_SAFE_INTEGER);
  const executable = canonicalTrustedPath(input.executable, "executable");
  const args = strictStringArray(input.args, "args", MAX_ARGS);
  const cwd = canonicalTrustedPath(input.cwd, "cwd");
  const env = input.env === undefined ? undefined : strictEnvironment(input.env);
  const timeoutMs = parseInteger(input.timeoutMs, "timeoutMs", 1, 300_000);
  const maxOutputBytes = parseInteger(input.maxOutputBytes, "maxOutputBytes", 1, 1_048_576);
  const runnerId = trustedUuid(input.runnerId, "runnerId");
  return {
    profileId,
    profileVersion,
    executable,
    args: Object.freeze([...args]),
    cwd,
    ...(env === undefined ? {} : { env }),
    timeoutMs,
    maxOutputBytes,
    runnerId,
  };
}

function strictPersistedPlan(value: unknown): PersistedValidationAttemptPlanV1 {
  if (!plainRecord(value)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== PERSISTED_PLAN_KEYS.length
    || keys.some((key) => typeof key !== "string" || !PERSISTED_PLAN_KEYS.includes(key as never))) invalid();
  const source: Record<string, unknown> = {};
  for (const key of PERSISTED_PLAN_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) invalid();
    source[key] = descriptor.value;
  }
  const profileId = parseBoundedString(source.profileId, "plan.profileId", 256);
  const profileVersion = parseInteger(source.profileVersion, "plan.profileVersion", 1, Number.MAX_SAFE_INTEGER);
  const runId = trustedUuid(source.runId, "plan.runId");
  const resultId = trustedUuid(source.resultId, "plan.resultId");
  const commandId = trustedUuid(source.commandId, "plan.commandId");
  const idempotencyKey = parseBoundedString(source.idempotencyKey, "plan.idempotencyKey", 512);
  return Object.freeze({ profileId, profileVersion, runId, resultId, commandId, idempotencyKey });
}

function configurationHash(profile: TrustedValidationProfileEntry): string {
  const bytes = Buffer.from(canonicalJson({
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    executable: profile.executable,
    args: profile.args,
    cwd: profile.cwd ?? null,
    env: profile.env ?? null,
    timeoutMs: profile.timeoutMs,
    maxOutputBytes: profile.maxOutputBytes,
    runnerId: profile.runnerId,
  }), "utf8");
  try {
    return createHash("sha256")
      .update("project-memory/validation-profile-configuration/v1\n", "utf8")
      .update(bytes)
      .digest("hex");
  } finally {
    bytes.fill(0);
  }
}

export class TrustedValidationProfileRegistry {
  readonly #entries: ReadonlyMap<string, ResolvedTrustedValidationProfile>;
  readonly #executableAllowlist: ReadonlySet<string>;
  readonly #workingDirectoryAllowlist: ReadonlySet<string>;

  constructor(
    entries: readonly TrustedValidationProfileEntry[],
    options: TrustedValidationProfileRegistryOptions = {},
  ) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_PROFILES) invalid();
    if (!plainRecord(options)) invalid();
    const resolved = new Map<string, ResolvedTrustedValidationProfile>();
    const suppliedExecutables = options.executableAllowlist;
    const suppliedWorkingDirectories = options.workingDirectoryAllowlist;
    const executableAllowlist = suppliedExecutables === undefined
      ? new Set<string>()
      : new Set(strictStringArray(suppliedExecutables, "executableAllowlist", MAX_PROFILES).map(trustedPathKey));
    const workingDirectoryAllowlist = suppliedWorkingDirectories === undefined
      ? new Set<string>()
      : new Set(strictStringArray(suppliedWorkingDirectories, "workingDirectoryAllowlist", MAX_PROFILES).map(trustedPathKey));
    for (const input of entries) {
      const profile = validateProfileEntry(input);
      if (suppliedExecutables === undefined) executableAllowlist.add(trustedPathKey(profile.executable));
      if (suppliedWorkingDirectories === undefined) workingDirectoryAllowlist.add(trustedPathKey(profile.cwd));
      if (!executableAllowlist.has(trustedPathKey(profile.executable))
        || !workingDirectoryAllowlist.has(trustedPathKey(profile.cwd))) invalid();
      const key = profileKey(profile.profileId, profile.profileVersion);
      if (resolved.has(key)) invalid();
      const frozen = cloneAndFreeze({ ...profile, configurationHash: configurationHash(profile) });
      resolved.set(key, frozen);
    }
    this.#entries = resolved;
    this.#executableAllowlist = new Set(executableAllowlist);
    this.#workingDirectoryAllowlist = new Set(workingDirectoryAllowlist);
    Object.freeze(this);
  }

  resolve(profileId: string, profileVersion: number): ResolvedTrustedValidationProfile {
    const id = parseBoundedString(profileId, "profileId", 256);
    const version = parseInteger(profileVersion, "profileVersion", 1, Number.MAX_SAFE_INTEGER);
    const entry = this.#entries.get(profileKey(id, version));
    if (entry === undefined
      || !this.#executableAllowlist.has(trustedPathKey(entry.executable))
      || !this.#workingDirectoryAllowlist.has(trustedPathKey(entry.cwd))) invalid();
    return entry;
  }

  list(): readonly ResolvedTrustedValidationProfile[] {
    return Object.freeze([...this.#entries.values()].sort((left, right) =>
      lexicalCompare(left.profileId, right.profileId) || left.profileVersion - right.profileVersion));
  }
}

export function createTrustedValidationProfileRegistry(
  entries: readonly TrustedValidationProfileEntry[],
  options?: TrustedValidationProfileRegistryOptions,
): TrustedValidationProfileRegistry {
  return new TrustedValidationProfileRegistry(entries, options);
}

function validatedContext(input: ValidationAttemptExpansionContext): ValidatedValidationAttemptExpansionContext {
  const projectId = parseCanonicalUuid(input.projectId, "projectId") as ProjectId;
  const vaultId = parseCanonicalUuid(input.vaultId, "vaultId") as VaultId;
  const storeId = parseCanonicalUuid(input.storeId, "storeId") as StoreId;
  if (typeof input.workspaceId !== "string" || !LOWER_HASH.test(input.workspaceId)) invalid();
  const workspaceId = input.workspaceId as WorkspaceId;
  const sessionId = parseCanonicalUuid(input.sessionId, "sessionId") as SessionId;
  const workflowId = parseCanonicalUuid(input.workflowId, "workflowId") as WorkflowId;
  parseInteger(input.workflowGeneration, "workflowGeneration", 1, Number.MAX_SAFE_INTEGER);
  if (typeof input.plannedWorkId !== "string" || !LOWER_HASH.test(input.plannedWorkId)) invalid();
  const finalCheckpointId = parseCanonicalUuid(input.finalCheckpointId, "finalCheckpointId") as CheckpointId;
  if (typeof input.finalCheckpointFingerprint !== "string" || !LOWER_HASH.test(input.finalCheckpointFingerprint)) invalid();
  return {
    ...input,
    projectId,
    vaultId,
    storeId,
    workspaceId,
    sessionId,
    workflowId,
    finalCheckpointId,
  };
}

function identityBytes(
  context: ValidationAttemptExpansionContext,
  profile: ResolvedTrustedValidationProfile,
): Buffer {
  return Buffer.from(canonicalJson({
    attemptPlanVersion: 1,
    projectId: context.projectId,
    vaultId: context.vaultId,
    storeId: context.storeId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    workflowId: context.workflowId,
    workflowGeneration: context.workflowGeneration,
    plannedWorkId: context.plannedWorkId,
    finalCheckpointId: context.finalCheckpointId,
    finalCheckpointFingerprint: context.finalCheckpointFingerprint,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    profileConfigurationHash: profile.configurationHash,
  }), "utf8");
}

function deterministicIds(
  context: ValidationAttemptExpansionContext,
  profile: ResolvedTrustedValidationProfile,
): PersistedValidationAttemptPlanV1 {
  const bytes = identityBytes(context, profile);
  let idempotencyDigest: Buffer | undefined;
  try {
    const runId = uuidV5(VALIDATION_RUN_NAMESPACE, bytes);
    const resultId = uuidV5(VALIDATION_RESULT_NAMESPACE, bytes);
    const commandId = uuidV5(VALIDATION_COMMAND_NAMESPACE, bytes);
    idempotencyDigest = createHash("sha256")
      .update("pm-lifecycle-validation-idempotency-v1\n", "utf8")
      .update(bytes)
      .digest();
    return Object.freeze({
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      runId,
      resultId,
      commandId,
      idempotencyKey: `lifecycle-validation-v1/${idempotencyDigest.toString("hex")}`,
    });
  } finally {
    bytes.fill(0);
    idempotencyDigest?.fill(0);
  }
}

export function createValidationAttemptPlans(
  input: ValidationAttemptPlanCreationInput,
  registry: TrustedValidationProfileRegistry,
): readonly PersistedValidationAttemptPlanV1[] {
  const context = validatedContext(input);
  if (!Array.isArray(input.profiles) || input.profiles.length === 0 || input.profiles.length > MAX_PROFILES) invalid();
  const profiles = [...input.profiles]
    .map((profile) => ({
      profileId: parseBoundedString(profile.profileId, "profileId", 256),
      profileVersion: parseInteger(profile.profileVersion, "profileVersion", 1, Number.MAX_SAFE_INTEGER),
    }))
    .sort((left, right) => lexicalCompare(left.profileId, right.profileId) || left.profileVersion - right.profileVersion);
  const seen = new Set<string>();
  const plans = profiles.map((profile) => {
    const key = profileKey(profile.profileId, profile.profileVersion);
    if (seen.has(key)) invalid();
    seen.add(key);
    return deterministicIds(context, registry.resolve(profile.profileId, profile.profileVersion));
  });
  return Object.freeze(plans);
}

export function expandValidationAttemptPlan(
  input: ExpandValidationAttemptPlanInput,
  registry: TrustedValidationProfileRegistry,
): ValidationAttemptPlanIdentityV1 {
  const context = validatedContext(input.context);
  const plan = strictPersistedPlan(input.plan);
  const profile = registry.resolve(plan.profileId, plan.profileVersion);
  if (typeof input.expectedProfileConfigurationHash !== "string"
    || !LOWER_HASH.test(input.expectedProfileConfigurationHash)
    || input.expectedProfileConfigurationHash !== profile.configurationHash) invalid();
  const expected = deterministicIds(context, profile);
  if (
    plan.profileId !== expected.profileId
    || plan.profileVersion !== expected.profileVersion
    || plan.runId !== expected.runId
    || plan.resultId !== expected.resultId
    || plan.commandId !== expected.commandId
    || plan.idempotencyKey !== expected.idempotencyKey
  ) invalid();
  return Object.freeze({
    attemptPlanVersion: 1,
    ...context,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    profileConfigurationHash: profile.configurationHash,
    runId: plan.runId,
    resultId: plan.resultId as ValidationAttemptPlanIdentityV1["resultId"],
    resultCommandId: plan.commandId,
    resultIdempotencyKey: plan.idempotencyKey,
  });
}

export function expandValidationAttemptPlans(
  input: {
    readonly plans: readonly unknown[];
    readonly context: ValidationAttemptExpansionContext;
    readonly expectedProfileConfigurationHashes: ReadonlyMap<string, string>;
  },
  registry: TrustedValidationProfileRegistry,
): readonly ValidationAttemptPlanIdentityV1[] {
  const result = input.plans.map((plan) => {
    const trustedPlan = strictPersistedPlan(plan);
    const expectedProfileConfigurationHash = input.expectedProfileConfigurationHashes.get(
      profileKey(trustedPlan.profileId, trustedPlan.profileVersion),
    );
    if (expectedProfileConfigurationHash === undefined) invalid();
    return expandValidationAttemptPlan({
      plan: trustedPlan,
      context: input.context,
      expectedProfileConfigurationHash,
    }, registry);
  });
  return Object.freeze(result);
}

export function bindValidationAttemptPlan(
  plan: unknown,
  registry: TrustedValidationProfileRegistry,
): BoundValidationAttemptPlanV1 {
  const trustedPlan = strictPersistedPlan(plan);
  const profile = registry.resolve(trustedPlan.profileId, trustedPlan.profileVersion);
  return Object.freeze({
    plan: trustedPlan,
    expectedProfileConfigurationHash: profile.configurationHash,
  });
}

export function createValidationAttemptPlanBindings(
  input: ValidationAttemptPlanCreationInput,
  registry: TrustedValidationProfileRegistry,
): readonly BoundValidationAttemptPlanV1[] {
  return Object.freeze(createValidationAttemptPlans(input, registry).map((plan) =>
    bindValidationAttemptPlan(plan, registry)));
}
