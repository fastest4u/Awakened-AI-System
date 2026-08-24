import { createHash, randomBytes } from "node:crypto";
import { fsyncSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { AtomicArtifactReplacer } from "../materialization/atomic-artifact-replacer.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { ProjectBinding } from "./contracts.js";
import { PROJECTION_NAMES, type ProjectionName } from "./checksum.js";
import {
  filesystemStableProjectionDirectoryOperations,
  sameProjectionDirectoryIdentity,
  type ProjectionDirectoryIdentity,
  type StableProjectionDirectoryOperations,
  type StableProjectionManifestContentIdentity,
  type StableProjectionManifestSnapshot,
} from "./stable-directory.js";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITION = /^(?:0|[1-9][0-9]{0,18})$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_BRANCH_REF_BYTES = 1_024;
const MAX_MANIFEST_BYTES = 64 * 1_024;
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

export type ProjectionManifestPublicationFaultBoundary =
  | "after-manifest-temp-fsync-before-replace"
  | "after-manifest-replace-before-validation";

export interface ProjectionManifestPublicationFaultInjector {
  hit(boundary: ProjectionManifestPublicationFaultBoundary): void;
}

export interface PublishProjectionManifestOptions {
  readonly faultInjector?: ProjectionManifestPublicationFaultInjector;
  readonly directoryOperations?: StableProjectionDirectoryOperations;
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

export const filesystemProjectionPathInspection: ProjectionPathInspection = Object.freeze({
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

function materializationConflict(): never {
  throw new LifecycleError("MATERIALIZATION_CONFLICT");
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
  inspection: ProjectionPathInspection = filesystemProjectionPathInspection,
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
  inspection: ProjectionPathInspection = filesystemProjectionPathInspection,
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

function assertPinnedGeneration(
  directory: string,
  databaseFile: string,
  identity: ProjectionDirectoryIdentity,
  operations: StableProjectionDirectoryOperations,
): void {
  try {
    operations.assertGeneration(directory, databaseFile, identity);
    if (!sameProjectionDirectoryIdentity(identity, operations.capture(directory))) {
      return materializationConflict();
    }
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    if (error instanceof LifecycleError && error.code === "MATERIALIZATION_CONFLICT") throw error;
    return materializationConflict();
  }
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return materializationConflict();
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(
    (key) => typeof key !== "string" || !keys.includes(key),
  )) return materializationConflict();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return materializationConflict();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function projectionDirectoryIdentity(value: unknown): ProjectionDirectoryIdentity {
  const source = dataRecord(value, ["canonicalPath", "device", "inode"]);
  if (
    typeof source.canonicalPath !== "string"
    || typeof source.device !== "string"
    || !/^(?:0|[1-9][0-9]*)$/u.test(source.device)
    || typeof source.inode !== "string"
    || !/^(?:0|[1-9][0-9]*)$/u.test(source.inode)
  ) return materializationConflict();
  return Object.freeze({
    canonicalPath: source.canonicalPath,
    device: source.device,
    inode: source.inode,
  });
}

function validatedManifestSnapshot(
  value: unknown,
  expectedDirectoryIdentity: ProjectionDirectoryIdentity,
): StableProjectionManifestSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return materializationConflict();
  }
  const state = Object.getOwnPropertyDescriptor(value, "state");
  if (state === undefined || !("value" in state)) return materializationConflict();
  if (state.value === "missing") {
    const source = dataRecord(value, ["state", "directoryIdentity"]);
    const directoryIdentity = projectionDirectoryIdentity(source.directoryIdentity);
    if (!sameProjectionDirectoryIdentity(directoryIdentity, expectedDirectoryIdentity)) {
      return materializationConflict();
    }
    return Object.freeze({ state: "missing", directoryIdentity });
  }
  if (state.value !== "present") return materializationConflict();
  const source = dataRecord(value, [
    "state",
    "directoryIdentity",
    "fileIdentity",
    "bytesBase64",
  ]);
  const directoryIdentity = projectionDirectoryIdentity(source.directoryIdentity);
  if (!sameProjectionDirectoryIdentity(directoryIdentity, expectedDirectoryIdentity)) {
    return materializationConflict();
  }
  const fileIdentity = dataRecord(source.fileIdentity, ["device", "inode", "size", "sha256"]);
  for (const key of ["device", "inode", "size"] as const) {
    if (typeof fileIdentity[key] !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(fileIdentity[key])) {
      return materializationConflict();
    }
  }
  if (
    BigInt(fileIdentity.size as string) > BigInt(MAX_MANIFEST_BYTES)
    || typeof fileIdentity.sha256 !== "string"
    || !HASH.test(fileIdentity.sha256)
    || typeof source.bytesBase64 !== "string"
  ) return materializationConflict();
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== source.bytesBase64
    || BigInt(bytes.byteLength) !== BigInt(fileIdentity.size as string)
    || createHash("sha256").update(bytes).digest("hex") !== fileIdentity.sha256
  ) return materializationConflict();
  return Object.freeze({
    state: "present",
    directoryIdentity,
    fileIdentity: Object.freeze({
      device: fileIdentity.device as string,
      inode: fileIdentity.inode as string,
      size: fileIdentity.size as string,
      sha256: fileIdentity.sha256,
    }),
    bytesBase64: source.bytesBase64,
  });
}

function captureManifestSnapshot(
  directory: string,
  directoryIdentity: ProjectionDirectoryIdentity,
  operations: StableProjectionDirectoryOperations,
): StableProjectionManifestSnapshot {
  try {
    return validatedManifestSnapshot(
      operations.captureManifest(directory, directoryIdentity),
      directoryIdentity,
    );
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "MATERIALIZATION_CONFLICT") throw error;
    return materializationConflict();
  }
}

function sameManifestSnapshot(
  left: StableProjectionManifestSnapshot,
  right: StableProjectionManifestSnapshot,
): boolean {
  if (
    left.state !== right.state
    || !sameProjectionDirectoryIdentity(left.directoryIdentity, right.directoryIdentity)
  ) return false;
  if (left.state === "missing" || right.state === "missing") return true;
  return left.fileIdentity.device === right.fileIdentity.device
    && left.fileIdentity.inode === right.fileIdentity.inode
    && left.fileIdentity.size === right.fileIdentity.size
    && left.fileIdentity.sha256 === right.fileIdentity.sha256
    && left.bytesBase64 === right.bytesBase64;
}

function snapshotHasBytes(
  snapshot: StableProjectionManifestSnapshot,
  bytes: Uint8Array,
): boolean {
  if (snapshot.state !== "present") return false;
  const expected = Buffer.from(bytes);
  return snapshot.bytesBase64 === expected.toString("base64")
    && snapshot.fileIdentity.size === String(expected.byteLength)
    && snapshot.fileIdentity.sha256 === createHash("sha256").update(expected).digest("hex");
}

function manifestContentIdentity(bytes: Uint8Array): StableProjectionManifestContentIdentity {
  const source = Buffer.from(bytes);
  return Object.freeze({
    size: String(source.byteLength),
    sha256: createHash("sha256").update(source).digest("hex"),
  });
}

interface ManifestPublicationLockState {
  activeAttempts: number;
  authorityEpoch: bigint;
  readonly directory: string;
  readonly directoryIdentity: ProjectionDirectoryIdentity;
  readonly lockToken: string;
  readonly lockOperations: StableProjectionDirectoryOperations;
  poisoned: boolean;
}

interface ManifestPublicationAttempt {
  readonly key: string;
  readonly state: ManifestPublicationLockState;
  readonly authorityEpoch: bigint;
  readonly transactionToken: string;
}

const manifestPublicationLocks = new Map<string, ManifestPublicationLockState>();

function publicationToken(): string {
  return randomBytes(16).toString("hex");
}

// On a local filesystem that honors exclusive creation, the lock serializes
// cooperative processes and workers. It is not a manifest CAS and does not
// constrain direct pathname writers; the stable mutation helper separately
// uses move-aside plus link-if-absent so those writers are never overwritten.
// Same-stack publication re-enters, and only a successful authority change
// fences older rollback ownership.
function beginManifestPublicationAttempt(
  directory: string,
  identity: ProjectionDirectoryIdentity,
  operations: StableProjectionDirectoryOperations,
): ManifestPublicationAttempt {
  const key = JSON.stringify([
    normalizedPath(identity.canonicalPath),
    identity.device,
    identity.inode,
  ]);
  let state = manifestPublicationLocks.get(key);
  if (state === undefined) {
    const lockToken = publicationToken();
    let acquired: "acquired" | "busy";
    try {
      acquired = operations.acquireManifestPublicationLock(directory, identity, lockToken);
    } catch {
      return materializationConflict();
    }
    if (acquired !== "acquired") return materializationConflict();
    state = {
      activeAttempts: 0,
      authorityEpoch: 0n,
      directory,
      directoryIdentity: identity,
      lockToken,
      lockOperations: operations,
      poisoned: false,
    };
    manifestPublicationLocks.set(key, state);
  }
  if (state.poisoned) return materializationConflict();
  state.activeAttempts += 1;
  return Object.freeze({
    key,
    state,
    authorityEpoch: state.authorityEpoch,
    transactionToken: publicationToken(),
  });
}

function manifestPublicationAttemptIsCurrent(attempt: ManifestPublicationAttempt): boolean {
  return !attempt.state.poisoned
    && attempt.state.authorityEpoch === attempt.authorityEpoch;
}

function finishManifestPublicationAttempt(attempt: ManifestPublicationAttempt): void {
  attempt.state.activeAttempts -= 1;
  if (attempt.state.activeAttempts !== 0) return;
  if (!attempt.state.poisoned) {
    let released: "released" | "poisoned";
    try {
      released = attempt.state.lockOperations.releaseManifestPublicationLock(
        attempt.state.directory,
        attempt.state.directoryIdentity,
        attempt.state.lockToken,
      );
    } catch {
      attempt.state.poisoned = true;
      return materializationConflict();
    }
    if (released !== "released") {
      attempt.state.poisoned = true;
      return materializationConflict();
    }
  }
  if (
    !attempt.state.poisoned
    && manifestPublicationLocks.get(attempt.key) === attempt.state
  ) manifestPublicationLocks.delete(attempt.key);
}

function poisonManifestPublication(attempt: ManifestPublicationAttempt): never {
  attempt.state.poisoned = true;
  return materializationConflict();
}

function commitManifestPublication(
  paths: VerifiedProjectionPublicationPaths,
  previous: StableProjectionManifestSnapshot,
  attempted: StableProjectionManifestContentIdentity,
  attempt: ManifestPublicationAttempt,
): void {
  if (attempt.state.poisoned) return poisonManifestPublication(attempt);
  let result: "committed" | "poisoned";
  try {
    result = attempt.state.lockOperations.commitManifestPublication(
      paths.directory,
      attempt.state.directoryIdentity,
      attempt.state.lockToken,
      attempt.transactionToken,
      previous,
      attempted,
    );
  } catch {
    return poisonManifestPublication(attempt);
  }
  if (result !== "committed") return poisonManifestPublication(attempt);
}

function recordManifestPublicationSuccess(attempt: ManifestPublicationAttempt): void {
  if (!manifestPublicationAttemptIsCurrent(attempt)) return materializationConflict();
  attempt.state.authorityEpoch += 1n;
}

function verifyPresentManifestAuthority(
  paths: VerifiedProjectionPublicationPaths,
  observed: StableProjectionManifestSnapshot,
  expectedBinding: ProjectBinding,
  directoryIdentity: ProjectionDirectoryIdentity,
  operations: StableProjectionDirectoryOperations,
  publicationAttempt: ManifestPublicationAttempt,
): void {
  if (publicationAttempt.state.poisoned || observed.state !== "present") {
    return poisonManifestPublication(publicationAttempt);
  }
  try {
    const bytes = Buffer.from(observed.bytesBase64, "base64");
    const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    const manifest = parseProjectionManifest(decoded, expectedBinding);
    if (!Buffer.from(serializeProjectionManifest(manifest)).equals(bytes)) {
      return poisonManifestPublication(publicationAttempt);
    }
    assertPinnedGeneration(
      paths.directory,
      manifest.databaseFile,
      directoryIdentity,
      operations,
    );
    const confirmed = captureManifestSnapshot(paths.directory, directoryIdentity, operations);
    if (!sameManifestSnapshot(observed, confirmed)) {
      return poisonManifestPublication(publicationAttempt);
    }
  } catch {
    return poisonManifestPublication(publicationAttempt);
  }
}

function verifyDifferentManifestAuthority(
  paths: VerifiedProjectionPublicationPaths,
  observed: StableProjectionManifestSnapshot,
  attemptedBytes: Uint8Array,
  expectedBinding: ProjectBinding,
  directoryIdentity: ProjectionDirectoryIdentity,
  operations: StableProjectionDirectoryOperations,
  publicationAttempt: ManifestPublicationAttempt,
): void {
  verifyPresentManifestAuthority(
    paths,
    observed,
    expectedBinding,
    directoryIdentity,
    operations,
    publicationAttempt,
  );
  if (
    publicationAttempt.state.authorityEpoch === publicationAttempt.authorityEpoch
    && snapshotHasBytes(observed, attemptedBytes)
  ) return poisonManifestPublication(publicationAttempt);
}

function verifyRestoredManifestAuthority(
  paths: VerifiedProjectionPublicationPaths,
  observed: StableProjectionManifestSnapshot,
  previous: StableProjectionManifestSnapshot,
  expectedBinding: ProjectBinding,
  directoryIdentity: ProjectionDirectoryIdentity,
  operations: StableProjectionDirectoryOperations,
  publicationAttempt: ManifestPublicationAttempt,
): void {
  if (!sameManifestSnapshot(observed, previous)) {
    return poisonManifestPublication(publicationAttempt);
  }
  verifyPresentManifestAuthority(
    paths,
    observed,
    expectedBinding,
    directoryIdentity,
    operations,
    publicationAttempt,
  );
}

function restorePreviousManifestIfOwned(
  paths: VerifiedProjectionPublicationPaths,
  directoryIdentity: ProjectionDirectoryIdentity,
  previous: StableProjectionManifestSnapshot,
  installed: StableProjectionManifestSnapshot,
  attempted: StableProjectionManifestContentIdentity,
  attemptedBytes: Uint8Array,
  expectedBinding: ProjectBinding,
  operations: StableProjectionDirectoryOperations,
  publicationAttempt: ManifestPublicationAttempt,
): "restored" | "removed" | "superseded" {
  const supersededBeforeRollback = (): "superseded" => {
    commitManifestPublication(paths, previous, attempted, publicationAttempt);
    return "superseded";
  };
  if (publicationAttempt.state.poisoned) return poisonManifestPublication(publicationAttempt);
  let current: StableProjectionManifestSnapshot;
  try {
    current = captureManifestSnapshot(paths.directory, directoryIdentity, operations);
  } catch {
    return poisonManifestPublication(publicationAttempt);
  }
  if (current.state === "missing") return poisonManifestPublication(publicationAttempt);
  if (
    !manifestPublicationAttemptIsCurrent(publicationAttempt)
    || !sameManifestSnapshot(current, installed)
  ) {
    verifyDifferentManifestAuthority(
      paths,
      current,
      attemptedBytes,
      expectedBinding,
      directoryIdentity,
      operations,
      publicationAttempt,
    );
    return supersededBeforeRollback();
  }
  let before: StableProjectionManifestSnapshot;
  try {
    before = captureManifestSnapshot(paths.directory, directoryIdentity, operations);
  } catch {
    return poisonManifestPublication(publicationAttempt);
  }
  if (before.state === "missing") return poisonManifestPublication(publicationAttempt);
  if (
    !manifestPublicationAttemptIsCurrent(publicationAttempt)
    || !sameManifestSnapshot(before, installed)
  ) {
    verifyDifferentManifestAuthority(
      paths,
      before,
      attemptedBytes,
      expectedBinding,
      directoryIdentity,
      operations,
      publicationAttempt,
    );
    return supersededBeforeRollback();
  }
  if (installed.state !== "present") return poisonManifestPublication(publicationAttempt);
  let result: "restored" | "removed" | "superseded" | "poisoned";
  try {
    result = publicationAttempt.state.lockOperations.rollbackManifestPublication(
      paths.directory,
      directoryIdentity,
      publicationAttempt.state.lockToken,
      publicationAttempt.transactionToken,
      previous,
      installed,
    );
  } catch {
    return poisonManifestPublication(publicationAttempt);
  }
  if (result === "poisoned") return poisonManifestPublication(publicationAttempt);
  if (result === "restored") {
    let authority: StableProjectionManifestSnapshot;
    try {
      authority = captureManifestSnapshot(paths.directory, directoryIdentity, operations);
    } catch {
      return poisonManifestPublication(publicationAttempt);
    }
    verifyRestoredManifestAuthority(
      paths,
      authority,
      previous,
      expectedBinding,
      directoryIdentity,
      operations,
      publicationAttempt,
    );
  } else if (result === "superseded") {
    let authority: StableProjectionManifestSnapshot;
    try {
      authority = captureManifestSnapshot(paths.directory, directoryIdentity, operations);
    } catch {
      return poisonManifestPublication(publicationAttempt);
    }
    verifyDifferentManifestAuthority(
      paths,
      authority,
      attemptedBytes,
      expectedBinding,
      directoryIdentity,
      operations,
      publicationAttempt,
    );
  }
  commitManifestPublication(paths, previous, attempted, publicationAttempt);
  return result;
}

export function publishProjectionManifest(
  input: PublishProjectionManifestInput,
  options: PublishProjectionManifestOptions = {},
): string {
  const source = exactRecord(input, ["projectionDirectory", "manifest", "expectedBinding"]);
  const expectedBinding = source.expectedBinding as ProjectBinding;
  const manifest = parseProjectionManifest(source.manifest, expectedBinding);
  const paths = verifyProjectionPublicationPaths(
    source.projectionDirectory as string,
    manifest.databaseFile,
  );
  const directoryOperations = options.directoryOperations
    ?? filesystemStableProjectionDirectoryOperations;
  let directoryIdentity: ProjectionDirectoryIdentity;
  try {
    directoryIdentity = directoryOperations.capture(paths.directory);
  } catch {
    return materializationConflict();
  }
  const publicationAttempt = beginManifestPublicationAttempt(
    paths.directory,
    directoryIdentity,
    directoryOperations,
  );
  try {
    const previous = captureManifestSnapshot(paths.directory, directoryIdentity, directoryOperations);
    const manifestBytes = serializeProjectionManifest(manifest);
    const attempted = manifestContentIdentity(manifestBytes);
    let replaced = false;
    let installed: StableProjectionManifestSnapshot | undefined;
    let observedDifferentAuthority = false;
    try {
      new AtomicArtifactReplacer({
        durableBase: paths.directory,
        operations: {
          fsync(handle): void {
            fsyncSync(handle);
            options.faultInjector?.hit("after-manifest-temp-fsync-before-replace");
          },
          rename(): void {
            assertPinnedGeneration(
              paths.directory,
              manifest.databaseFile,
              directoryIdentity,
              directoryOperations,
            );
            const current = captureManifestSnapshot(
              paths.directory,
              directoryIdentity,
              directoryOperations,
            );
            if (
              !manifestPublicationAttemptIsCurrent(publicationAttempt)
              || !sameManifestSnapshot(current, previous)
            ) return materializationConflict();
            let prepareResult: "prepared" | "superseded" | "poisoned";
            try {
              prepareResult = publicationAttempt.state.lockOperations.prepareManifestPublication(
                paths.directory,
                directoryIdentity,
                publicationAttempt.state.lockToken,
                publicationAttempt.transactionToken,
                previous,
              );
            } catch {
              return poisonManifestPublication(publicationAttempt);
            }
            if (prepareResult === "poisoned") {
              return poisonManifestPublication(publicationAttempt);
            }
            if (prepareResult === "superseded") {
              let superseding: StableProjectionManifestSnapshot;
              try {
                superseding = captureManifestSnapshot(
                  paths.directory,
                  directoryIdentity,
                  directoryOperations,
                );
              } catch {
                return poisonManifestPublication(publicationAttempt);
              }
              verifyDifferentManifestAuthority(
                paths,
                superseding,
                manifestBytes,
                expectedBinding,
                directoryIdentity,
                directoryOperations,
                publicationAttempt,
              );
              commitManifestPublication(paths, previous, attempted, publicationAttempt);
              return materializationConflict();
            }
            let installResult: "installed" | "superseded" | "poisoned";
            try {
              installResult = publicationAttempt.state.lockOperations.installManifestIfExpected(
                paths.directory,
                directoryIdentity,
                publicationAttempt.state.lockToken,
                publicationAttempt.transactionToken,
                previous,
              );
            } catch {
              return poisonManifestPublication(publicationAttempt);
            }
            if (installResult === "poisoned") {
              return poisonManifestPublication(publicationAttempt);
            }
            if (installResult !== "installed") {
              let superseding: StableProjectionManifestSnapshot;
              try {
                superseding = captureManifestSnapshot(
                  paths.directory,
                  directoryIdentity,
                  directoryOperations,
                );
              } catch {
                return poisonManifestPublication(publicationAttempt);
              }
              verifyDifferentManifestAuthority(
                paths,
                superseding,
                manifestBytes,
                expectedBinding,
                directoryIdentity,
                directoryOperations,
                publicationAttempt,
              );
              commitManifestPublication(paths, previous, attempted, publicationAttempt);
              return materializationConflict();
            }
            replaced = true;
            const observedInstalled = captureManifestSnapshot(
              paths.directory,
              directoryIdentity,
              directoryOperations,
            );
            const installedHasExpectedBytes = snapshotHasBytes(observedInstalled, manifestBytes);
            const differentAuthorityObserved = observedInstalled.state === "present"
              && (
                !installedHasExpectedBytes
                || publicationAttempt.state.authorityEpoch !== publicationAttempt.authorityEpoch
              );
            if (differentAuthorityObserved) {
              verifyDifferentManifestAuthority(
                paths,
                observedInstalled,
                manifestBytes,
                expectedBinding,
                directoryIdentity,
                directoryOperations,
                publicationAttempt,
              );
            }
            observedDifferentAuthority = differentAuthorityObserved;
            if (
              !manifestPublicationAttemptIsCurrent(publicationAttempt)
              || !installedHasExpectedBytes
            ) return materializationConflict();
            installed = observedInstalled;
            options.faultInjector?.hit("after-manifest-replace-before-validation");
            assertPinnedGeneration(
              paths.directory,
              manifest.databaseFile,
              directoryIdentity,
              directoryOperations,
            );
          },
        },
        syncDirectory: () => undefined,
      }).replace({
        targetPath: paths.targetPath,
        tempPath: paths.tempPath,
        bytes: manifestBytes,
      });
      assertPinnedGeneration(
        paths.directory,
        manifest.databaseFile,
        directoryIdentity,
        directoryOperations,
      );
      let finalManifest: StableProjectionManifestSnapshot;
      try {
        finalManifest = captureManifestSnapshot(
          paths.directory,
          directoryIdentity,
          directoryOperations,
        );
      } catch {
        return poisonManifestPublication(publicationAttempt);
      }
      if (finalManifest.state === "missing" || installed === undefined) {
        return poisonManifestPublication(publicationAttempt);
      }
      if (
        !manifestPublicationAttemptIsCurrent(publicationAttempt)
        || !sameManifestSnapshot(finalManifest, installed)
      ) {
        verifyDifferentManifestAuthority(
          paths,
          finalManifest,
          manifestBytes,
          expectedBinding,
          directoryIdentity,
          directoryOperations,
          publicationAttempt,
        );
        observedDifferentAuthority = true;
        installed = undefined;
        return materializationConflict();
      }
      commitManifestPublication(paths, previous, attempted, publicationAttempt);
      recordManifestPublicationSuccess(publicationAttempt);
    } catch (error) {
      if (replaced) {
        if (
          installed === undefined
          || !manifestPublicationAttemptIsCurrent(publicationAttempt)
        ) {
          if (installed === undefined && !observedDifferentAuthority) {
            return poisonManifestPublication(publicationAttempt);
          }
          commitManifestPublication(paths, previous, attempted, publicationAttempt);
          throw error;
        }
        try {
          restorePreviousManifestIfOwned(
            paths,
            directoryIdentity,
            previous,
            installed,
            attempted,
            manifestBytes,
            expectedBinding,
            directoryOperations,
            publicationAttempt,
          );
        } catch {
          return materializationConflict();
        }
      }
      throw error;
    }
    return paths.targetPath;
  } finally {
    finishManifestPublicationAttempt(publicationAttempt);
  }
}
