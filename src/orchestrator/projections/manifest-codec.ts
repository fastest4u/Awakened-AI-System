import {
  isProjectionProjectStoreIdentity,
  isProjectionWorkspaceIdentity,
  type ProjectBinding,
} from "./contracts.js";
import { PROJECTION_NAMES, type ProjectionName } from "./checksum.js";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITION = /^(?:0|[1-9][0-9]{0,18})$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_BRANCH_REF_BYTES = 1_024;
const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "branchScopeId",
  "branchRef",
  "sessionId",
  "generation",
  "terminalEventPosition",
  "terminalEventHash",
  "databaseFile",
  "databaseSha256",
  "coreChecksums",
  "createdAt",
] as const);
const MANIFEST_V2_KEYS = Object.freeze([
  "schemaVersion",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "branchScopeId",
  "branchRef",
  "sessionId",
  "generation",
  "highestObservedGeneration",
  "terminalEventPosition",
  "terminalEventHash",
  "databaseFile",
  "databaseSha256",
  "coreChecksums",
  "createdAt",
] as const);
const BINDING_KEYS = Object.freeze([
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "branchScopeId",
  "branchRef",
  "sessionId",
] as const);

export interface ProjectionManifestV1 {
  readonly schemaVersion: 1;
  readonly projectId: ProjectBinding["projectId"];
  readonly vaultId: ProjectBinding["vaultId"];
  readonly storeId: ProjectBinding["storeId"];
  readonly workspaceId: ProjectBinding["workspaceId"];
  readonly branchScopeId: ProjectBinding["branchScopeId"];
  readonly branchRef: string | null;
  readonly sessionId: null;
  readonly generation: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly databaseFile: string;
  readonly databaseSha256: string;
  readonly coreChecksums: Readonly<Record<ProjectionNameV1, string>>;
  readonly createdAt: string;
}

export const PROJECTION_NAMES_V1 = Object.freeze([
  "sessionTree",
  "canonicalItems",
  "tasksFollowups",
  "artifactsFiles",
  "entityGraph",
  "lexicalChunks",
  "retrievalFeedback",
] as const);
export type ProjectionNameV1 = (typeof PROJECTION_NAMES_V1)[number];

export interface ProjectionManifestV2 {
  readonly schemaVersion: 2;
  readonly projectId: ProjectBinding["projectId"];
  readonly vaultId: ProjectBinding["vaultId"];
  readonly storeId: ProjectBinding["storeId"];
  readonly workspaceId: ProjectBinding["workspaceId"];
  readonly branchScopeId: ProjectBinding["branchScopeId"];
  readonly branchRef: string | null;
  readonly sessionId: null;
  readonly generation: number;
  readonly highestObservedGeneration: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly databaseFile: string;
  readonly databaseSha256: string;
  readonly coreChecksums: Readonly<Record<ProjectionName, string>>;
  readonly createdAt: string;
}

export type ProjectionManifest = ProjectionManifestV1 | ProjectionManifestV2;

function invalid(): never {
  throw new TypeError("PROJECTION_MANIFEST_INVALID");
}

export function exactProjectionManifestRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
}

function assertNullableUuid(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !UUID.test(value))) invalid();
}

function assertNullableBranchRef(value: unknown): asserts value is string | null {
  if (
    value !== null
    && (
      typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAX_BRANCH_REF_BYTES
    )
  ) invalid();
}

function validateExpectedBinding(value: unknown): ProjectBinding {
  const source = exactProjectionManifestRecord(value, BINDING_KEYS);
  for (const key of ["projectId", "vaultId", "storeId"] as const) {
    if (!isProjectionProjectStoreIdentity(source[key])) invalid();
  }
  if (!isProjectionWorkspaceIdentity(source.workspaceId)) invalid();
  assertNullableUuid(source.branchScopeId);
  assertNullableBranchRef(source.branchRef);
  assertNullableUuid(source.sessionId);
  if (source.sessionId !== null) invalid();
  return source as unknown as ProjectBinding;
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 24) invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid();
  return value;
}

function validateCoreChecksums<T extends string>(
  value: unknown,
  names: readonly T[],
): Readonly<Record<T, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length) invalid();
  for (const key of keys) {
    if (typeof key !== "string" || !names.includes(key as T)) invalid();
  }
  const result = {} as Record<T, string>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    assertHash(descriptor.value);
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function sameScope(manifest: Record<string, unknown>, expected: ProjectBinding): boolean {
  return manifest.projectId === expected.projectId
    && manifest.vaultId === expected.vaultId
    && manifest.storeId === expected.storeId
    && manifest.workspaceId === expected.workspaceId
    && manifest.branchScopeId === expected.branchScopeId
    && manifest.branchRef === expected.branchRef;
}

export function parseProjectionManifest(
  value: unknown,
  expectedBinding: ProjectBinding,
): ProjectionManifestV1 {
  const source = exactProjectionManifestRecord(value, MANIFEST_KEYS);
  const expected = validateExpectedBinding(expectedBinding);
  if (source.schemaVersion !== 1 || source.sessionId !== null || !sameScope(source, expected)) invalid();
  for (const key of ["projectId", "vaultId", "storeId"] as const) {
    if (!isProjectionProjectStoreIdentity(source[key])) invalid();
  }
  if (!isProjectionWorkspaceIdentity(source.workspaceId)) invalid();
  assertNullableUuid(source.branchScopeId);
  assertNullableBranchRef(source.branchRef);
  if (
    !Number.isSafeInteger(source.generation)
    || Number(source.generation) < 1
    || Number(source.generation) > 2_147_483_647
  ) invalid();
  if (
    typeof source.terminalEventPosition !== "string"
    || !POSITION.test(source.terminalEventPosition)
    || BigInt(source.terminalEventPosition) > SQLITE_INT64_MAX
  ) invalid();
  assertHash(source.terminalEventHash);
  assertHash(source.databaseSha256);
  const databaseFile = `projections-1-${String(source.generation)}.sqlite`;
  if (source.databaseFile !== databaseFile) invalid();
  const coreChecksums = validateCoreChecksums(source.coreChecksums, PROJECTION_NAMES_V1);
  const createdAt = validateTimestamp(source.createdAt);

  return Object.freeze({
    schemaVersion: 1,
    projectId: source.projectId as ProjectBinding["projectId"],
    vaultId: source.vaultId as ProjectBinding["vaultId"],
    storeId: source.storeId as ProjectBinding["storeId"],
    workspaceId: source.workspaceId as ProjectBinding["workspaceId"],
    branchScopeId: source.branchScopeId as ProjectBinding["branchScopeId"],
    branchRef: source.branchRef as string | null,
    sessionId: null,
    generation: source.generation as number,
    terminalEventPosition: source.terminalEventPosition,
    terminalEventHash: source.terminalEventHash,
    databaseFile,
    databaseSha256: source.databaseSha256,
    coreChecksums,
    createdAt,
  });
}

export function parseProjectionManifestV2(
  value: unknown,
  expectedBinding: ProjectBinding,
): ProjectionManifestV2 {
  const source = exactProjectionManifestRecord(value, MANIFEST_V2_KEYS);
  const expected = validateExpectedBinding(expectedBinding);
  if (source.schemaVersion !== 2 || source.sessionId !== null || !sameScope(source, expected)) invalid();
  for (const key of ["projectId", "vaultId", "storeId"] as const) {
    if (!isProjectionProjectStoreIdentity(source[key])) invalid();
  }
  if (!isProjectionWorkspaceIdentity(source.workspaceId)) invalid();
  assertNullableUuid(source.branchScopeId);
  assertNullableBranchRef(source.branchRef);
  if (!Number.isSafeInteger(source.generation) || Number(source.generation) < 1 || Number(source.generation) > 2_147_483_647) {
    invalid();
  }
  if (
    !Number.isSafeInteger(source.highestObservedGeneration)
    || Number(source.highestObservedGeneration) < Number(source.generation)
    || Number(source.highestObservedGeneration) > 2_147_483_647
  ) invalid();
  if (
    typeof source.terminalEventPosition !== "string"
    || !POSITION.test(source.terminalEventPosition)
    || BigInt(source.terminalEventPosition) > SQLITE_INT64_MAX
  ) invalid();
  assertHash(source.terminalEventHash);
  assertHash(source.databaseSha256);
  const databaseFile = `projections-2-${String(source.generation)}.sqlite`;
  if (source.databaseFile !== databaseFile) invalid();
  const coreChecksums = validateCoreChecksums(source.coreChecksums, PROJECTION_NAMES);
  const createdAt = validateTimestamp(source.createdAt);
  return Object.freeze({
    schemaVersion: 2,
    projectId: source.projectId as ProjectBinding["projectId"],
    vaultId: source.vaultId as ProjectBinding["vaultId"],
    storeId: source.storeId as ProjectBinding["storeId"],
    workspaceId: source.workspaceId as ProjectBinding["workspaceId"],
    branchScopeId: source.branchScopeId as ProjectBinding["branchScopeId"],
    branchRef: source.branchRef as string | null,
    sessionId: null,
    generation: source.generation as number,
    highestObservedGeneration: source.highestObservedGeneration as number,
    terminalEventPosition: source.terminalEventPosition,
    terminalEventHash: source.terminalEventHash,
    databaseFile,
    databaseSha256: source.databaseSha256,
    coreChecksums,
    createdAt,
  });
}

/** Parses either immutable manifest version for internal publication only. */
export function parseProjectionManifestForPublication(
  value: unknown,
  expectedBinding: ProjectBinding,
): ProjectionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const schemaVersion = Object.getOwnPropertyDescriptor(value, "schemaVersion");
  if (schemaVersion === undefined || !("value" in schemaVersion)) invalid();
  if (schemaVersion.value === 1) return parseProjectionManifest(value, expectedBinding);
  if (schemaVersion.value === 2) return parseProjectionManifestV2(value, expectedBinding);
  return invalid();
}
