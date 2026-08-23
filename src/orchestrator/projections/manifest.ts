import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { AtomicArtifactReplacer } from "../materialization/atomic-artifact-replacer.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { ProjectBinding } from "./contracts.js";
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
const BINDING_KEYS = Object.freeze([
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "branchScopeId",
  "branchRef",
  "sessionId",
] as const);

export const PROJECTION_MANIFEST_FILENAME = "projection-manifest.json" as const;

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
  readonly coreChecksums: Readonly<Record<ProjectionName, string>>;
  readonly createdAt: string;
}

export interface PublishProjectionManifestInput {
  readonly projectionDirectory: string;
  readonly manifest: unknown;
  readonly expectedBinding: ProjectBinding;
}

export interface ProjectionPathStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProjectionPathInspection {
  lstat(path: string): ProjectionPathStat;
  realpath(path: string): string;
}

export interface VerifiedProjectionPublicationPaths {
  readonly directory: string;
  readonly databasePath: string;
  readonly targetPath: string;
  readonly tempPath: string;
}

const filesystemPathInspection: ProjectionPathInspection = Object.freeze({
  lstat: (path: string) => lstatSync(path),
  realpath: (path: string) => realpathSync(path),
});

function invalid(): never {
  throw new TypeError("PROJECTION_MANIFEST_INVALID");
}

function pathInvalid(): never {
  throw new TypeError("PROJECTION_MANIFEST_PATH_INVALID");
}

function sidecarIntegrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
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
  const source = exactRecord(value, BINDING_KEYS);
  for (const key of ["projectId", "vaultId", "storeId", "workspaceId"] as const) {
    assertHash(source[key]);
  }
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

function validateCoreChecksums(value: unknown): Readonly<Record<ProjectionName, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== PROJECTION_NAMES.length) invalid();
  for (const key of keys) {
    if (typeof key !== "string" || !PROJECTION_NAMES.includes(key as ProjectionName)) invalid();
  }
  const result = {} as Record<ProjectionName, string>;
  for (const name of PROJECTION_NAMES) {
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
  const source = exactRecord(value, MANIFEST_KEYS);
  const expected = validateExpectedBinding(expectedBinding);
  if (source.schemaVersion !== 1 || source.sessionId !== null || !sameScope(source, expected)) invalid();
  for (const key of ["projectId", "vaultId", "storeId", "workspaceId"] as const) {
    assertHash(source[key]);
  }
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
  const coreChecksums = validateCoreChecksums(source.coreChecksums);
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

export function serializeProjectionManifest(manifest: ProjectionManifestV1): Uint8Array {
  return Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
}

function normalizedPath(path: string): string {
  const result = resolve(path);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function contained(base: string, target: string): boolean {
  const fromBase = relative(base, target);
  return fromBase.length > 0
    && fromBase !== ".."
    && !fromBase.startsWith(`..${sep}`)
    && !isAbsolute(fromBase);
}

function safeProjectionDirectory(
  directory: string,
  inspection: ProjectionPathInspection,
): string {
  if (
    typeof directory !== "string"
    || !isAbsolute(directory)
    || normalize(directory) !== directory
    || resolve(directory) !== directory
  ) pathInvalid();
  try {
    const stat = inspection.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) pathInvalid();
    if (normalizedPath(inspection.realpath(directory)) !== normalizedPath(directory)) pathInvalid();
  } catch (error) {
    if (error instanceof TypeError && error.message === "PROJECTION_MANIFEST_PATH_INVALID") throw error;
    pathInvalid();
  }
  return directory;
}

function assertRegularDatabase(path: string, inspection: ProjectionPathInspection): void {
  try {
    const stat = inspection.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) pathInvalid();
  } catch (error) {
    if (error instanceof TypeError && error.message === "PROJECTION_MANIFEST_PATH_INVALID") throw error;
    pathInvalid();
  }
}

export function assertProjectionSidecarsAbsent(
  databasePath: string,
  inspection: ProjectionPathInspection = filesystemPathInspection,
): void {
  if (
    typeof databasePath !== "string"
    || !isAbsolute(databasePath)
    || normalize(databasePath) !== databasePath
    || resolve(databasePath) !== databasePath
  ) pathInvalid();
  for (const sidecarPath of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      inspection.lstat(sidecarPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      return sidecarIntegrity();
    }
    return sidecarIntegrity();
  }
}

export function verifyProjectionPublicationPaths(
  projectionDirectory: string,
  databaseFile: string,
  inspection: ProjectionPathInspection = filesystemPathInspection,
): VerifiedProjectionPublicationPaths {
  if (
    typeof databaseFile !== "string"
    || !/^projections-1-[1-9][0-9]{0,9}\.sqlite$/u.test(databaseFile)
  ) pathInvalid();
  const directory = safeProjectionDirectory(projectionDirectory, inspection);
  const databasePath = join(directory, databaseFile);
  const targetPath = join(directory, PROJECTION_MANIFEST_FILENAME);
  const tempPath = join(directory, `.${PROJECTION_MANIFEST_FILENAME}.tmp`);
  if (
    !contained(normalizedPath(directory), normalizedPath(databasePath))
    || !contained(normalizedPath(directory), normalizedPath(targetPath))
    || !contained(normalizedPath(directory), normalizedPath(tempPath))
  ) pathInvalid();
  assertRegularDatabase(databasePath, inspection);
  assertProjectionSidecarsAbsent(databasePath, inspection);
  return Object.freeze({ directory, databasePath, targetPath, tempPath });
}

export function publishProjectionManifest(input: PublishProjectionManifestInput): string {
  const source = exactRecord(input, ["projectionDirectory", "manifest", "expectedBinding"]);
  const manifest = parseProjectionManifest(
    source.manifest,
    source.expectedBinding as ProjectBinding,
  );
  const paths = verifyProjectionPublicationPaths(
    source.projectionDirectory as string,
    manifest.databaseFile,
  );
  new AtomicArtifactReplacer({ durableBase: paths.directory }).replace({
    targetPath: paths.targetPath,
    tempPath: paths.tempPath,
    bytes: serializeProjectionManifest(manifest),
  });
  return paths.targetPath;
}
