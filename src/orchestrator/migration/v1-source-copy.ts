import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { types as utilTypes } from "node:util";
import type { StoredEvent } from "../contracts/event.js";
import { assertContainedPath, canonicalExistingDirectory, canonicalExistingPath, sameCanonicalPath } from "../identity/canonical-path.js";
import { isProjectionProjectStoreIdentity, isProjectionWorkspaceIdentity, type ProjectBinding } from "../projections/contracts.js";
import { replayCommittedProjectionEvents, type ProjectionEventSnapshot } from "../projections/event-reader.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION } from "../storage/migrations/registry.js";
import type { SqliteDriver } from "../storage/sqlite-driver.js";
import { decodeShadowMigrationPolicyV1, ShadowMigrationError, type ShadowMigrationErrorCode, type ShadowMigrationPolicyV1 } from "./v2-shadow-migration.contracts.js";
import type { ShadowMigrationInvocationDeadline } from "./v2-shadow-migration-runtime.js";

export interface SourceFileDescriptorV1 {
  readonly relativePath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly ctimeNs: string;
  readonly sha256: string;
}
export interface LegacyArtifactDescriptorV1 extends SourceFileDescriptorV1 {
  readonly mediaType: "text/markdown; charset=utf-8";
}
export interface VerifiedLegacyArtifact {
  readonly descriptor: LegacyArtifactDescriptorV1;
  readChunks(): Iterable<Uint8Array>;
  assertUnchanged(): void;
}
export interface V1SourceCopyManifestV1 {
  readonly schemaVersion: 1;
  readonly copyFormatVersion: 1;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly branchScopeId: string | null;
  readonly branchRef: string | null;
  readonly sourceSchemaVersion: number;
  readonly database: SourceFileDescriptorV1;
  readonly sqliteSidecars: readonly SourceFileDescriptorV1[];
  readonly legacyArtifacts: readonly LegacyArtifactDescriptorV1[];
  readonly eventCount: number;
  readonly aggregateSourceBytes: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly createdAt: string;
  readonly authorizedActorFingerprint: string;
  readonly manifestChecksum: string;
}
export interface VerifiedV1SourceCopy {
  readonly sourceRoot: string;
  readonly manifest: V1SourceCopyManifestV1;
  readonly projectionSnapshot: ProjectionEventSnapshot;
  events(): Iterable<StoredEvent>;
  legacyArtifacts(): Iterable<VerifiedLegacyArtifact>;
  assertUnchanged(): void;
  close(): void;
}
export interface VerifyV1SourceCopyInput {
  readonly invocationDeadline?: ShadowMigrationInvocationDeadline;
  readonly driver: SqliteDriver;
  readonly sourceRoot: string;
  readonly manifestPath: string;
  readonly liveEventStorePath: string;
  readonly liveLegacyArtifactRoot: string;
  readonly expectedBinding: ProjectBinding;
  readonly policy: ShadowMigrationPolicyV1;
}

const FILE_KEYS = ["relativePath", "device", "inode", "size", "ctimeNs", "sha256"] as const;
const BINDING_KEYS = ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef"] as const;
const MANIFEST_KEYS = ["schemaVersion", "copyFormatVersion", ...BINDING_KEYS, "sourceSchemaVersion", "database", "sqliteSidecars",
  "legacyArtifacts", "eventCount", "aggregateSourceBytes", "terminalEventPosition", "terminalEventHash", "createdAt",
  "authorizedActorFingerprint", "manifestChecksum"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The manifest itself is metadata, bounded independently of the logical import budget.
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

function fail(code: ShadowMigrationErrorCode = "MIGRATION_SOURCE_INVALID", category = "source", ordinal = 0): never {
  throw new ShadowMigrationError(code, Object.freeze({ category, ordinal }));
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input) || Array.isArray(input)) fail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function array<T>(input: unknown, decode: (value: unknown) => T, maximum: number): readonly T[] {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input) || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype) fail();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value as unknown;
  const count = integer(length);
  if (count > maximum || Reflect.ownKeys(input).length !== count + 1) fail();
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail();
    result.push(decode(descriptor.value));
  }
  return Object.freeze(result);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail();
  return value;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || value.length > 30 || !DECIMAL.test(value)) fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) fail();
  return value;
}
function sourceRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || isAbsolute(value) || win32.isAbsolute(value)
    || /[\\\0:]/u.test(value) || value.split("/").some((part) => !part || part === "." || part === ".."
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail();
  return value;
}
function descriptor(input: unknown, artifact = false): SourceFileDescriptorV1 | LegacyArtifactDescriptorV1 {
  const value = record(input, artifact ? [...FILE_KEYS, "mediaType"] : FILE_KEYS);
  const result = { relativePath: sourceRelativePath(value.relativePath), device: decimal(value.device), inode: decimal(value.inode),
    size: integer(value.size), ctimeNs: decimal(value.ctimeNs), sha256: hash(value.sha256) };
  if (artifact) {
    if (value.mediaType !== "text/markdown; charset=utf-8") fail();
    return Object.freeze({ ...result, mediaType: value.mediaType });
  }
  return Object.freeze(result);
}
function binding(input: unknown): ProjectBinding {
  const value = record(input, [...BINDING_KEYS, "sessionId"]);
  for (const key of ["projectId", "vaultId", "storeId"] as const) if (!isProjectionProjectStoreIdentity(value[key])) fail();
  if (!isProjectionWorkspaceIdentity(value.workspaceId) || value.sessionId !== null
    || (value.branchScopeId !== null && (typeof value.branchScopeId !== "string" || !UUID.test(value.branchScopeId)))
    || (value.branchRef !== null && (typeof value.branchRef !== "string" || !value.branchRef || value.branchRef.includes("\0")))) fail();
  return Object.freeze(value) as unknown as ProjectBinding;
}

export function decodeV1SourceCopyManifestV1(input: unknown): V1SourceCopyManifestV1 {
  try {
    const value = record(input, MANIFEST_KEYS);
    if (value.schemaVersion !== 1 || value.copyFormatVersion !== 1 || value.sourceSchemaVersion !== CURRENT_PROJECT_STORE_SCHEMA_VERSION) fail();
    const scope = binding(Object.fromEntries([...BINDING_KEYS.map((key) => [key, value[key]]), ["sessionId", null]]));
    const terminal = decimal(value.terminalEventPosition);
    if (BigInt(terminal) > 9_223_372_036_854_775_807n) fail();
    if (typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.createdAt)
      || new Date(value.createdAt).toISOString() !== value.createdAt) fail();
    const result: V1SourceCopyManifestV1 = Object.freeze({ schemaVersion: 1, copyFormatVersion: 1,
      projectId: scope.projectId, vaultId: scope.vaultId, storeId: scope.storeId, workspaceId: scope.workspaceId,
      branchScopeId: scope.branchScopeId, branchRef: scope.branchRef, sourceSchemaVersion: CURRENT_PROJECT_STORE_SCHEMA_VERSION,
      database: descriptor(value.database), sqliteSidecars: array(value.sqliteSidecars, (item) => descriptor(item), 2),
      legacyArtifacts: array(value.legacyArtifacts, (item) => descriptor(item, true) as LegacyArtifactDescriptorV1, 100_000),
      eventCount: integer(value.eventCount), aggregateSourceBytes: integer(value.aggregateSourceBytes), terminalEventPosition: terminal,
      terminalEventHash: hash(value.terminalEventHash), createdAt: value.createdAt,
      authorizedActorFingerprint: hash(value.authorizedActorFingerprint), manifestChecksum: hash(value.manifestChecksum) });
    const { manifestChecksum, ...body } = result;
    if (createHash("sha256").update(canonicalJson(body), "utf8").digest("hex") !== manifestChecksum) fail();
    return result;
  } catch { return fail(); }
}

interface DirectoryIdentity { readonly path: string; readonly device: bigint; readonly inode: bigint }
interface Capture { readonly path: string; readonly descriptor: SourceFileDescriptorV1 }
function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.ctimeNs === right.ctimeNs;
}
/** Check the lexical path before opening anything: realpath alone would hide a junction. */
function checkComponents(path: string, directories?: Map<string, DirectoryIdentity>): BigIntStats {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  const parts = relative(cursor, absolute).split(sep).filter(Boolean);
  let stat = lstatSync(cursor, { bigint: true });
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) { cursor = join(cursor, parts[i - 1]!); stat = lstatSync(cursor, { bigint: true }); }
    if (stat.isSymbolicLink() || !sameCanonicalPath(canonicalExistingPath(cursor), cursor)) fail();
    if (i < parts.length && !stat.isDirectory()) fail();
    if (stat.isDirectory() && directories) {
      const old = directories.get(cursor);
      if (old && (old.device !== stat.dev || old.inode !== stat.ino)) fail();
      directories.set(cursor, { path: cursor, device: stat.dev, inode: stat.ino });
    }
  }
  return stat;
}
function readCapture(path: string, relativePath: string, directories: Map<string, DirectoryIdentity>, collect = false, maximum = Number.MAX_SAFE_INTEGER, copyTo?: string, deadline?: ShadowMigrationInvocationDeadline): { capture: Capture; bytes: Buffer } {
  deadline?.remainingMs();
  const initial = checkComponents(path, directories);
  if (!initial.isFile() || initial.nlink !== 1n || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  if (initial.size > BigInt(maximum)) fail("MIGRATION_LIMIT_EXCEEDED", "file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: number | undefined;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameStat(initial, opened)) fail();
    if (copyTo !== undefined) output = openSync(copyTo, "wx", 0o600);
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      deadline?.remainingMs();
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      length += count;
      if (length > maximum || length > Number(initial.size)) fail();
      digest.update(buffer.subarray(0, count));
      if (output !== undefined) {
        let offset = 0;
        while (offset < count) {
          deadline?.remainingMs();
          const written = writeSync(output, buffer, offset, count - offset);
          if (written < 1) fail();
          offset += written;
        }
      }
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (length !== Number(initial.size) || !sameStat(opened, fstatSync(fd, { bigint: true }))
      || !sameStat(initial, checkComponents(path, directories))) fail();
    deadline?.remainingMs();
    return { capture: { path, descriptor: Object.freeze({ relativePath, device: String(opened.dev), inode: String(opened.ino),
      size: Number(opened.size), ctimeNs: String(opened.ctimeNs), sha256: digest.digest("hex") }) }, bytes: Buffer.concat(chunks) };
  } finally {
    try { if (output !== undefined) closeSync(output); } finally { closeSync(fd); }
  }
}
function equalDescriptor(left: SourceFileDescriptorV1, right: SourceFileDescriptorV1): boolean {
  return FILE_KEYS.every((key) => left[key] === right[key]);
}
function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}
function freezeEvent(event: StoredEvent): StoredEvent {
  const copy = structuredClone(event);
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}

/** SQLite read-only WAL connections still update SHM. Confine those writes to scratch. */
function workingImage(sourceRoot: string, liveDatabase: string, liveRoot: string, manifest: V1SourceCopyManifestV1,
  directories: Map<string, DirectoryIdentity>, deadline?: ShadowMigrationInvocationDeadline): { databasePath: string; close(): void } {
  deadline?.remainingMs();
  const temporaryRoot = canonicalExistingDirectory(tmpdir());
  checkComponents(temporaryRoot);
  if ([sourceRoot, dirname(liveDatabase), liveRoot].some((protectedRoot) => contains(protectedRoot, temporaryRoot))) fail();
  const directory = canonicalExistingDirectory(mkdtempSync(join(temporaryRoot, "v1-source-verification-")));
  const identity = checkComponents(directory);
  let closed = false;
  const assertOwnedDirectory = (): void => {
    const current = checkComponents(directory);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) fail();
  };
  const transientCleanupError = (error: unknown): boolean =>
    ["EBUSY", "EAGAIN", "EINTR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
  const close = (): void => {
    if (closed) return;
    assertOwnedDirectory();
    let cleanupError: unknown;
    const retry: string[] = [];
    // Only remove verifier-owned leaf names, never recurse through a substituted tree.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      assertOwnedDirectory();
      try { unlinkSync(join(directory, `events.sqlite${suffix}`)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (transientCleanupError(error)) retry.push(suffix);
        else cleanupError ??= error;
      }
    }
    // Finish the other safe leaves first. Cleanup gets one immediate retry per
    // transient failure, not a renewed invocation or migration retry budget.
    for (const suffix of retry) {
      assertOwnedDirectory();
      try { unlinkSync(join(directory, `events.sqlite${suffix}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError ??= error; }
    }
    if (cleanupError !== undefined) throw cleanupError;
    assertOwnedDirectory();
    try { rmdirSync(directory); }
    catch (error) {
      if (!transientCleanupError(error)) throw error;
      assertOwnedDirectory();
      rmdirSync(directory);
    }
    closed = true;
  };
  try {
    if (overlaps(directory, sourceRoot) || overlaps(directory, dirname(liveDatabase)) || overlaps(directory, liveRoot)) fail();
    for (const declared of [manifest.database, ...manifest.sqliteSidecars]) {
      deadline?.remainingMs();
      const suffix = declared === manifest.database ? "" : declared.relativePath.slice(manifest.database.relativePath.length);
      const destination = join(directory, `events.sqlite${suffix}`);
      const copied = readCapture(join(sourceRoot, declared.relativePath), declared.relativePath, directories, false,
        Number.MAX_SAFE_INTEGER, destination, deadline).capture.descriptor;
      if (!equalDescriptor(copied, declared)) fail("MIGRATION_SOURCE_MUTATED");
      const scratch = readCapture(destination, declared.relativePath, new Map(), false, Number.MAX_SAFE_INTEGER, undefined, deadline).capture.descriptor;
      if (scratch.size !== declared.size || scratch.sha256 !== declared.sha256
        || (scratch.device === declared.device && scratch.inode === declared.inode)) fail();
    }
    return { databasePath: join(directory, "events.sqlite"), close };
  } catch (error) { try { close(); } catch { /* preserve the original verification failure */ } throw error; }
}

export async function verifyV1SourceCopy(input: VerifyV1SourceCopyInput): Promise<VerifiedV1SourceCopy> {
  try {
    if (typeof input !== "object" || input === null || utilTypes.isProxy(input)) fail();
    const supplied = record(input, ["driver", "sourceRoot", "manifestPath", "liveEventStorePath", "liveLegacyArtifactRoot", "expectedBinding", "policy",
      ...(Object.getOwnPropertyDescriptor(input, "invocationDeadline") === undefined ? [] : ["invocationDeadline"])]);
    const deadline = supplied.invocationDeadline as ShadowMigrationInvocationDeadline | undefined;
    deadline?.remainingMs();
    for (const key of ["sourceRoot", "manifestPath", "liveEventStorePath", "liveLegacyArtifactRoot"] as const) {
      if (typeof supplied[key] !== "string" || !supplied[key] || supplied[key].includes("\0")) fail();
    }
    const sourceRoot = canonicalExistingDirectory(supplied.sourceRoot as string);
    const liveDatabase = canonicalExistingPath(supplied.liveEventStorePath as string);
    const liveRoot = canonicalExistingDirectory(supplied.liveLegacyArtifactRoot as string);
    if (overlaps(sourceRoot, dirname(liveDatabase)) || overlaps(sourceRoot, liveRoot)) fail();
    const directories = new Map<string, DirectoryIdentity>();
    checkComponents(supplied.sourceRoot as string, directories);
    checkComponents(supplied.liveEventStorePath as string);
    checkComponents(supplied.liveLegacyArtifactRoot as string);
    const manifestPath = resolve(supplied.manifestPath as string);
    assertContainedPath(sourceRoot, manifestPath);
    const manifestRelative = sourceRelativePath(relative(sourceRoot, manifestPath).split(sep).join("/"));
    // This is the only manifest read for decoding; later reads solely revalidate bytes.
    const manifestRead = readCapture(manifestPath, manifestRelative, directories, true, MAX_MANIFEST_BYTES, undefined, deadline);
    const manifest = decodeV1SourceCopyManifestV1(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.bytes)) as unknown);
    const policy = decodeShadowMigrationPolicyV1(supplied.policy);
    const expected = binding(supplied.expectedBinding);
    if (BINDING_KEYS.some((key) => expected[key] !== manifest[key])) fail();
    if (manifest.eventCount > policy.maxEvents || manifest.aggregateSourceBytes > policy.maxAggregateBytes
      || manifest.legacyArtifacts.length > policy.maxEvents) fail("MIGRATION_LIMIT_EXCEEDED", "manifest");
    let logicalBytes = 0;
    for (const artifact of manifest.legacyArtifacts) {
      deadline?.remainingMs();
      if (artifact.size > policy.maxEventBytes) fail("MIGRATION_LIMIT_EXCEEDED", "artifact");
      logicalBytes += artifact.size;
      if (!Number.isSafeInteger(logicalBytes) || logicalBytes > policy.maxAggregateBytes) fail("MIGRATION_LIMIT_EXCEEDED", "artifact");
    }
    const paths = new Set<string>([manifestRelative.toLowerCase()]);
    const identities = new Set<string>([`${manifestRead.capture.descriptor.device}:${manifestRead.capture.descriptor.inode}`]);
    const captures: Capture[] = [manifestRead.capture];
    const artifactBytes: Buffer[] = [];
    const allDescriptors = [manifest.database, ...manifest.sqliteSidecars, ...manifest.legacyArtifacts];
    for (const declared of allDescriptors) {
      deadline?.remainingMs();
      const folded = declared.relativePath.toLowerCase();
      if (paths.has(folded)) fail();
      paths.add(folded);
      const path = join(sourceRoot, declared.relativePath);
      assertContainedPath(sourceRoot, path);
      if (!checkComponents(path, directories).isFile()) fail();
    }
    for (const sidecar of manifest.sqliteSidecars) {
      deadline?.remainingMs();
      if (![`${manifest.database.relativePath}-wal`, `${manifest.database.relativePath}-shm`].includes(sidecar.relativePath)) fail();
    }
    const databasePath = join(sourceRoot, manifest.database.relativePath);
    const checkSidecars = (): void => {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        let exists = true;
        try { lstatSync(`${databasePath}${suffix}`); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          exists = false;
        }
        if (exists !== manifest.sqliteSidecars.some((d) => d.relativePath === `${manifest.database.relativePath}${suffix}`)) fail();
      }
    };
    checkSidecars();
    for (let ordinal = 0; ordinal < allDescriptors.length; ordinal++) {
      deadline?.remainingMs();
      const declared = allDescriptors[ordinal]!;
      const isArtifact = ordinal > manifest.sqliteSidecars.length;
      const read = readCapture(join(sourceRoot, declared.relativePath), declared.relativePath, directories, isArtifact,
        isArtifact ? policy.maxEventBytes : Number.MAX_SAFE_INTEGER, undefined, deadline);
      if (!equalDescriptor(read.capture.descriptor, declared)) fail();
      const identity = `${declared.device}:${declared.inode}`;
      if (identities.has(identity)) fail();
      identities.add(identity);
      captures.push(read.capture);
      if (isArtifact) { new TextDecoder("utf-8", { fatal: true }).decode(read.bytes); artifactBytes.push(read.bytes); }
    }
    const liveStat = checkComponents(liveDatabase);
    if (!liveStat.isFile() || (String(liveStat.dev) === manifest.database.device && String(liveStat.ino) === manifest.database.inode)) fail();
    const liveRootStat = checkComponents(liveRoot);
    for (const dir of directories.values()) {
      if (overlaps(sourceRoot, dir.path) && dir.device === liveRootStat.dev && dir.inode === liveRootStat.ino) fail();
    }
    const assertUnchanged = (): void => {
      try {
        deadline?.remainingMs();
        for (const directory of directories.values()) {
          deadline?.remainingMs();
          const stat = checkComponents(directory.path);
          if (!stat.isDirectory() || stat.dev !== directory.device || stat.ino !== directory.inode) fail();
        }
        checkSidecars();
        for (const capture of captures) {
          if (!equalDescriptor(capture.descriptor, readCapture(capture.path, capture.descriptor.relativePath, directories, false, Number.MAX_SAFE_INTEGER, undefined, deadline).capture.descriptor)) fail();
        }
        deadline?.remainingMs();
      } catch (error) {
        if (error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") throw error;
        fail("MIGRATION_SOURCE_MUTATED", "source");
      }
    };
    const driver = supplied.driver as SqliteDriver;
    const checkedDriver: SqliteDriver = { open(path, options) {
      assertUnchanged();
      const connection = driver.open(path, deadline === undefined ? options
        : { ...options, busyTimeoutMs: Math.min(options.busyTimeoutMs, deadline.remainingMs()) });
      try {
        deadline?.remainingMs();
        const row = connection.prepare("SELECT schema_version FROM project_meta WHERE singleton = 1").get();
        if (row?.schema_version !== BigInt(manifest.sourceSchemaVersion) && row?.schema_version !== manifest.sourceSchemaVersion) fail();
        const terminal = connection.prepare("SELECT coalesce(max(global_position), 0) AS terminal_position FROM events").get();
        if (terminal?.terminal_position !== BigInt(manifest.terminalEventPosition)
          && terminal?.terminal_position !== Number(manifest.terminalEventPosition)) fail();
        deadline?.remainingMs();
        return connection;
      } catch (error) { try { connection.close(); } catch { /* preserve the verification failure */ } throw error; }
    } };
    const sourceEvents: StoredEvent[] = [];
    const scratch = workingImage(sourceRoot, liveDatabase, liveRoot, manifest, directories, deadline);
    let replay: ReturnType<typeof replayCommittedProjectionEvents>;
    let replayFailed = false;
    try {
      replay = replayCommittedProjectionEvents(expected, { driver: checkedDriver, eventStorePath: scratch.databasePath,
        terminalEventPosition: BigInt(manifest.terminalEventPosition), maxEvents: policy.maxEvents }, (event) => {
        // The production replay authenticates each canonical payload before this callback.
        deadline?.remainingMs();
        const bytes = Buffer.byteLength(event.payloadJson, "utf8");
        logicalBytes += bytes;
        if (bytes > policy.maxEventBytes || logicalBytes > policy.maxAggregateBytes) fail("MIGRATION_LIMIT_EXCEEDED", "event", sourceEvents.length);
        sourceEvents.push(freezeEvent(event));
      });
      deadline?.remainingMs();
    } catch (error) {
      replayFailed = true;
      throw error;
    } finally {
      try { scratch.close(); }
      catch (error) {
        // A secondary cleanup failure must not replace the primary replay error.
        // Without a primary error, failed cleanup still refuses successful return.
        if (!replayFailed) { deadline?.remainingMs(); throw error; }
      }
    }
    deadline?.remainingMs();
    if (sourceEvents.length !== manifest.eventCount || replay.eventCount !== manifest.eventCount
      || logicalBytes !== manifest.aggregateSourceBytes || replay.terminalEventPosition.toString() !== manifest.terminalEventPosition
      || replay.terminalEventHash !== manifest.terminalEventHash) fail();
    assertUnchanged();
    Object.freeze(sourceEvents);
    let closed = false;
    const requireOpen = (): void => { if (closed) fail(); deadline?.remainingMs(); };
    const values = <T>(items: readonly T[]): Iterable<T> => {
      requireOpen();
      if (deadline === undefined) return items.values();
      return (function* () {
        for (const item of items) { requireOpen(); yield item; }
        requireOpen();
      })();
    };
    const events = (): Iterable<StoredEvent> => values(sourceEvents);
    const close = (): void => { if (closed) return; closed = true; };
    const artifacts = Object.freeze(manifest.legacyArtifacts.map((descriptor, ordinal) => Object.freeze({ descriptor,
      readChunks(): Iterable<Uint8Array> {
        requireOpen(); assertUnchanged();
        const bytes = artifactBytes[ordinal]!;
        return (function* () { for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          requireOpen(); yield Uint8Array.from(bytes.subarray(offset, offset + 64 * 1024));
        } if (deadline !== undefined) requireOpen(); })();
      }, assertUnchanged,
    })));
    const projectionSnapshot: ProjectionEventSnapshot = Object.freeze({ binding: expected, ...replay, events, close });
    deadline?.remainingMs();
    return Object.freeze({ sourceRoot, manifest, projectionSnapshot, events,
      legacyArtifacts(): Iterable<VerifiedLegacyArtifact> { return values(artifacts); }, assertUnchanged, close });
  } catch (error) {
    if (error instanceof ShadowMigrationError) {
      return fail(error.code, error.code === "MIGRATION_LIMIT_EXCEEDED" ? "limit" : "source");
    }
    return fail();
  }
}
