import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StoredEvent } from "../contracts/event.js";
import { fsyncDirectory } from "../identity/directory-durability.js";
import { AtomicArtifactReplacer } from "../materialization/atomic-artifact-replacer.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  ShadowMigrationError,
  decodeShadowMigrationPolicyV1,
  shadowMigrationIdentity,
  type ShadowMigrationPolicyV1,
} from "./v2-shadow-migration.contracts.js";
import type { VerifiedLegacyArtifact, VerifiedV1SourceCopy } from "./v1-source-copy.js";

const PACKAGE_DOMAIN = "project-memory/v2-shadow-migration-package/v1";
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024;
const MANIFEST_KEYS = ["schemaVersion", "packageFormatVersion", "migrationAlgorithmVersion", "projectId", "vaultId", "storeId",
  "workspaceId", "sourceManifestChecksum", "eventCount", "legacyArtifactCount", "aggregateSourceBytes", "terminalEventPosition",
  "terminalEventHash", "createdAt", "recordDescriptors", "recordsChecksum", "buildIdentityHash", "configurationChecksum", "creationReasonCode",
  "packageChecksum"] as const;
const DESCRIPTOR_KEYS = ["schemaVersion", "ordinal", "kind", "sourceIdentity", "relativePath", "byteLength", "contentSha256"] as const;

export type V2MigrationRecordDescriptorV1 = Readonly<{
  schemaVersion: 1;
  ordinal: number;
  kind: "source-event" | "legacy-artifact";
  sourceIdentity: string;
  relativePath: string | null;
  byteLength: number;
  contentSha256: string;
}>;

export interface V2MigrationPackageManifestV1 {
  readonly schemaVersion: 1;
  readonly packageFormatVersion: 1;
  readonly migrationAlgorithmVersion: 1;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly sourceManifestChecksum: string;
  readonly eventCount: number;
  readonly legacyArtifactCount: number;
  readonly aggregateSourceBytes: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly createdAt: string;
  readonly recordDescriptors: readonly V2MigrationRecordDescriptorV1[];
  readonly recordsChecksum: string;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
  readonly creationReasonCode: "production-shaped-rehearsal";
  readonly packageChecksum: string;
}

export interface V2MigrationPackageRecordV1 {
  readonly descriptor: V2MigrationRecordDescriptorV1;
  readChunks(): Iterable<Uint8Array>;
}

export interface SealedV2MigrationPackage {
  readonly rootPath: string;
  readonly migrationIdentity: string;
  readonly manifest: V2MigrationPackageManifestV1;
  records(): Iterable<V2MigrationPackageRecordV1>;
  assertUnchanged(): void;
  close(): void;
}

export interface SealV2MigrationPackageInput {
  readonly source: VerifiedV1SourceCopy;
  readonly packageRoot: string;
  readonly policy: ShadowMigrationPolicyV1;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
  readonly now?: () => number;
  readonly onPhase?: (phase: "existing-target-final-open" | "fresh-target-final-open") => void;
}

export interface OpenSealedV2MigrationPackageInput {
  readonly rootPath: string;
  readonly expectedMigrationIdentity: string;
}

interface RecordLocation {
  readonly descriptor: V2MigrationRecordDescriptorV1;
  readonly path: string;
  readonly offset: number;
}

interface PackageIdentity { readonly path: string; readonly device: bigint; readonly inode: bigint; readonly size: bigint; readonly directory: boolean; }

function conflict(): never {
  throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({}));
}

function held<T>(operation: () => T): T {
  try { return operation(); } catch (error) { if (error instanceof ShadowMigrationError) throw error; conflict(); }
}

function sourceInvalid(): never {
  throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID", Object.freeze({}));
}

function limitExceeded(ordinal: number): never {
  throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED", Object.freeze({ category: "package", ordinal }));
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function contained(base: string, target: string): boolean {
  const suffix = relative(base, target);
  return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function safePath(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\\") || relativePath.includes("\0")
    || relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")) conflict();
  const path = resolve(root, relativePath);
  if (!contained(root, path)) conflict();
  return path;
}

function assertDirectory(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) conflict();
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) conflict();
}

function assertPackageTree(rootPath: string): void {
  assertDirectory(rootPath);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) conflict();
      if (stat.isDirectory()) walk(path);
      else if (!stat.isFile() || stat.nlink !== 1n) conflict();
    }
  };
  walk(rootPath);
}

function capturePackageIdentities(rootPath: string): readonly PackageIdentity[] {
  const identities: PackageIdentity[] = [];
  const capture = (path: string): void => {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) conflict();
    identities.push(Object.freeze({ path: relative(rootPath, path), device: stat.dev, inode: stat.ino, size: stat.size, directory: stat.isDirectory() }));
    if (stat.isDirectory()) for (const entry of readdirSync(path, { withFileTypes: true })) capture(join(path, entry.name));
  };
  capture(rootPath);
  return Object.freeze(identities.sort((left, right) => left.path.localeCompare(right.path)));
}

function assertPackageIdentities(rootPath: string, expected: readonly PackageIdentity[]): void {
  const actual = capturePackageIdentities(rootPath);
  if (actual.length !== expected.length) conflict();
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index]!; const right = expected[index]!;
    if (left.path !== right.path || left.device !== right.device || left.inode !== right.inode || left.size !== right.size || left.directory !== right.directory) conflict();
  }
}

function writeAll(handle: number, bytes: Uint8Array, assertDeadline?: () => void): void {
  let offset = 0;
  while (offset < bytes.length) {
    assertDeadline?.();
    const written = writeSync(handle, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) conflict();
    offset += written;
  }
}

function writeFileDurably(path: string, chunks: Iterable<Uint8Array>, assertDeadline?: () => void): { readonly bytes: number; readonly sha256: string } {
  let handle: number | undefined;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    handle = openSync(path, "wx", 0o600);
    for (const chunk of chunks) {
      assertDeadline?.();
      if (!(chunk instanceof Uint8Array) || chunk.length > MAX_CHUNK_BYTES) conflict();
      writeAll(handle, chunk, assertDeadline);
      hash.update(chunk);
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes)) conflict();
    }
    assertDeadline?.(); fsyncSync(handle); assertDeadline?.();
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function descriptorChecksum(descriptors: readonly V2MigrationRecordDescriptorV1[]): string {
  const hash = createHash("sha256");
  for (const descriptor of descriptors) hash.update(canonicalJson(descriptor)).update("\n", "utf8");
  return hash.digest("hex");
}

function canonicalEventEnvelope(event: StoredEvent): string {
  return canonicalJson({
    globalPosition: event.globalPosition.toString(), eventId: event.eventId, projectId: event.projectId,
    vaultId: event.vaultId, storeId: event.storeId, workspaceId: event.workspaceId, branchScopeId: event.branchScopeId,
    branchRef: event.branchRef, streamId: event.streamId, streamType: event.streamType,
    streamVersion: event.streamVersion.toString(), eventType: event.eventType, eventSchemaVersion: event.eventSchemaVersion,
    sessionId: event.sessionId, parentSessionId: event.parentSessionId, actorRole: event.actorRole, agentId: event.agentId,
    clientInstanceId: event.clientInstanceId, correlationId: event.correlationId, causationId: event.causationId,
    commandId: event.commandId, idempotencyKey: event.idempotencyKey, commandEventIndex: event.commandEventIndex,
    occurredAt: event.occurredAt, recordedAt: event.recordedAt, visibilityScope: event.visibilityScope,
    confidence: event.confidence, verificationStatus: event.verificationStatus, sourceRefs: event.sourceRefs,
    evidenceRefs: event.evidenceRefs, evidenceDigests: event.evidenceDigests, payload: event.payload,
    payloadJson: event.payloadJson, payloadHash: event.payloadHash, previousGlobalHash: event.previousGlobalHash,
    eventHash: event.eventHash, lifecycleIntentJson: event.lifecycleIntentJson ?? null,
  });
}

function eventDescriptor(event: StoredEvent, ordinal: number, bytes: Uint8Array): V2MigrationRecordDescriptorV1 {
  if (!UUID.test(event.eventId)) sourceInvalid();
  return Object.freeze({ schemaVersion: 1, ordinal, kind: "source-event", sourceIdentity: event.eventId,
    relativePath: null, byteLength: bytes.length, contentSha256: sha256(bytes) });
}

function artifactDescriptor(artifact: VerifiedLegacyArtifact, ordinal: number, bytes: number, digest: string): V2MigrationRecordDescriptorV1 {
  const descriptor = artifact.descriptor;
  if (!HASH.test(descriptor.sha256) || !HASH.test(digest) || bytes !== descriptor.size) sourceInvalid();
  return Object.freeze({ schemaVersion: 1, ordinal, kind: "legacy-artifact", sourceIdentity: descriptor.sha256,
    relativePath: descriptor.relativePath, byteLength: bytes, contentSha256: digest });
}

function manifestChecksum(manifest: Omit<V2MigrationPackageManifestV1, "packageChecksum">): string {
  return sha256(`${PACKAGE_DOMAIN}\n${canonicalJson(manifest)}`);
}

function createManifest(
  source: VerifiedV1SourceCopy,
  records: readonly V2MigrationRecordDescriptorV1[],
  eventCount: number,
  aggregateSourceBytes: number,
  input: SealV2MigrationPackageInput,
): V2MigrationPackageManifestV1 {
  const sourceManifest = source.manifest;
  const body = Object.freeze({ schemaVersion: 1 as const, packageFormatVersion: 1 as const, migrationAlgorithmVersion: 1 as const,
    projectId: sourceManifest.projectId, vaultId: sourceManifest.vaultId, storeId: sourceManifest.storeId,
    workspaceId: sourceManifest.workspaceId, sourceManifestChecksum: sourceManifest.manifestChecksum, eventCount,
    legacyArtifactCount: records.length - eventCount, aggregateSourceBytes, terminalEventPosition: sourceManifest.terminalEventPosition,
    terminalEventHash: sourceManifest.terminalEventHash, createdAt: sourceManifest.createdAt, recordDescriptors: Object.freeze([...records]),
    recordsChecksum: descriptorChecksum(records), buildIdentityHash: input.buildIdentityHash,
    configurationChecksum: input.configurationChecksum, creationReasonCode: "production-shaped-rehearsal" as const });
  return Object.freeze({ ...body, packageChecksum: manifestChecksum(body) });
}

function identityFor(manifest: V2MigrationPackageManifestV1): string {
  return shadowMigrationIdentity({ projectId: manifest.projectId, storeId: manifest.storeId,
    sourceManifestChecksum: manifest.sourceManifestChecksum, terminalEventHash: manifest.terminalEventHash,
    packageChecksum: manifest.packageChecksum, migrationAlgorithmVersion: 1, buildIdentityHash: manifest.buildIdentityHash,
    configurationChecksum: manifest.configurationChecksum });
}

function validateSealInput(input: SealV2MigrationPackageInput): ShadowMigrationPolicyV1 {
  if (typeof input !== "object" || input === null || typeof input.packageRoot !== "string" || !isAbsolute(input.packageRoot)
    || !HASH.test(input.buildIdentityHash) || !HASH.test(input.configurationChecksum)) sourceInvalid();
  try { assertDirectory(normalized(input.packageRoot)); } catch (error) { if (error instanceof ShadowMigrationError) throw error; sourceInvalid(); }
  return decodeShadowMigrationPolicyV1(input.policy);
}

function quarantine(path: string): void {
  try { renameSync(path, join(dirname(path), `.quarantine-${basename(path)}-${randomUUID()}`)); } catch { /* retain the original temporary path if it cannot be renamed safely */ }
}

export async function sealV2MigrationPackage(input: SealV2MigrationPackageInput): Promise<SealedV2MigrationPackage> {
  const policy = validateSealInput(input);
  const packageRoot = normalized(input.packageRoot);
  const source = input.source;
  let temporary: string | undefined;
  try {
    const sourceRoot = normalized(realpathSync(source.sourceRoot));
    const stagingRoot = normalized(realpathSync(packageRoot));
    if (sourceRoot === stagingRoot || contained(sourceRoot, stagingRoot) || contained(stagingRoot, sourceRoot)) sourceInvalid();
    const now = input.now ?? Date.now;
    const deadlineAt = now() + policy.deadlineMs;
    const assertBeforeDeadline = (ordinal: number): void => { if (now() > deadlineAt) limitExceeded(ordinal); };
    assertBeforeDeadline(0);
    source.assertUnchanged();
    temporary = mkdtempSync(join(packageRoot, ".v2-migration-package-"));
    assertDirectory(temporary);
    const eventsPath = join(temporary, "events.ndjson");
    const artifactsPath = join(temporary, "artifacts");
    mkdirSync(artifactsPath, { mode: 0o700 });
    const artifactDirectories = new Set<string>([artifactsPath]);
    const eventHandle = openSync(eventsPath, "wx", 0o600);
    const descriptors: V2MigrationRecordDescriptorV1[] = [];
    let sourceBytes = 0;
    let eventCount = 0;
    let batchEvents = 0;
    let batchBytes = 0;
    const reserveBatch = (bytes: number, ordinal: number): void => {
      assertBeforeDeadline(ordinal);
      if (bytes > policy.maxBatchBytes) limitExceeded(ordinal);
      if (batchEvents === policy.maxBatchEvents || batchBytes + bytes > policy.maxBatchBytes) { batchEvents = 0; batchBytes = 0; }
      if (batchEvents >= policy.maxBatchEvents || batchBytes + bytes > policy.maxBatchBytes) limitExceeded(ordinal);
      batchEvents += 1; batchBytes += bytes;
    };
    try {
      let priorPosition = -1n;
      for (const event of source.events()) {
        assertBeforeDeadline(eventCount);
        if (event.globalPosition <= priorPosition || eventCount >= policy.maxEvents) limitExceeded(eventCount);
        const payloadBytes = Buffer.byteLength(event.payloadJson, "utf8");
        if (payloadBytes > policy.maxEventBytes || sourceBytes + payloadBytes > policy.maxAggregateBytes) limitExceeded(eventCount);
        const bytes = Buffer.from(`${canonicalEventEnvelope(event)}\n`, "utf8");
        if (bytes.length > MAX_EVENT_LINE_BYTES) limitExceeded(eventCount);
        reserveBatch(bytes.length - 1, eventCount);
        writeAll(eventHandle, bytes, () => assertBeforeDeadline(eventCount));
        descriptors.push(eventDescriptor(event, eventCount, bytes.subarray(0, bytes.length - 1)));
        sourceBytes += payloadBytes;
        eventCount += 1;
        priorPosition = event.globalPosition;
      }
      assertBeforeDeadline(eventCount); fsyncSync(eventHandle); assertBeforeDeadline(eventCount);
    } finally { closeSync(eventHandle); }
    if (eventCount !== source.manifest.eventCount) sourceInvalid();
    let ordinal = eventCount;
    let previousPath: string | undefined;
    for (const artifact of source.legacyArtifacts()) {
      assertBeforeDeadline(ordinal);
      const relativePath = artifact.descriptor.relativePath;
      if (previousPath !== undefined && previousPath >= relativePath) sourceInvalid();
      const artifactPath = safePath(artifactsPath, relativePath);
      if (artifact.descriptor.size > policy.maxEventBytes || sourceBytes + artifact.descriptor.size > policy.maxAggregateBytes) limitExceeded(ordinal);
      reserveBatch(artifact.descriptor.size, ordinal);
      mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
      let directory = dirname(artifactPath);
      while (contained(artifactsPath, directory) || directory === artifactsPath) {
        artifactDirectories.add(directory);
        if (directory === artifactsPath) break;
        directory = dirname(directory);
      }
      artifact.assertUnchanged();
      const copied = writeFileDurably(artifactPath, artifact.readChunks(), () => assertBeforeDeadline(ordinal));
      artifact.assertUnchanged();
      if (copied.bytes !== artifact.descriptor.size) sourceInvalid();
      descriptors.push(artifactDescriptor(artifact, ordinal, copied.bytes, copied.sha256));
      sourceBytes += copied.bytes;
      ordinal += 1;
      previousPath = relativePath;
    }
    if (sourceBytes !== source.manifest.aggregateSourceBytes || sourceBytes > policy.maxAggregateBytes) sourceInvalid();
    assertBeforeDeadline(ordinal);
    const manifest = createManifest(source, descriptors, eventCount, sourceBytes, input);
    const migrationIdentity = identityFor(manifest);
    assertBeforeDeadline(ordinal);
    new AtomicArtifactReplacer({ durableBase: temporary }).replace({
      targetPath: join(temporary, "package-manifest.json"),
      tempPath: join(temporary, `.package-manifest-${randomUUID()}.tmp`),
      bytes: Buffer.from(canonicalJson(manifest), "utf8"),
    });
    for (const directory of [...artifactDirectories].sort((left, right) => right.length - left.length)) fsyncDirectory(directory);
    assertBeforeDeadline(ordinal);
    fsyncDirectory(temporary);
    assertBeforeDeadline(ordinal);
    source.assertUnchanged();
    assertBeforeDeadline(ordinal);
    const verified = openSealedV2MigrationPackage({ rootPath: temporary, expectedMigrationIdentity: migrationIdentity });
    verified.close();
    const target = join(packageRoot, migrationIdentity);
    try {
      assertBeforeDeadline(ordinal);
      const existing = openSealedV2MigrationPackage({ rootPath: target, expectedMigrationIdentity: migrationIdentity });
      if (existing.manifest.packageChecksum !== manifest.packageChecksum || canonicalJson(existing.manifest) !== canonicalJson(manifest)) {
        existing.close();
        conflict();
      }
      existing.close();
      assertBeforeDeadline(ordinal);
      quarantine(temporary);
      temporary = undefined;
      assertBeforeDeadline(ordinal);
      const adopted = openSealedV2MigrationPackage({ rootPath: target, expectedMigrationIdentity: migrationIdentity });
      try {
        input.onPhase?.("existing-target-final-open");
        assertBeforeDeadline(ordinal);
        return adopted;
      } catch (error) {
        adopted.close();
        throw error;
      }
    } catch (error) {
      if (error instanceof ShadowMigrationError && error.code !== "MIGRATION_IDENTITY_CONFLICT") throw error;
      if (error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT") {
        const targetExists = (() => { try { lstatSync(target); return true; } catch { return false; } })();
        if (targetExists) throw error;
      }
    }
    if (temporary === undefined) conflict();
    assertBeforeDeadline(ordinal);
    renameSync(temporary, target);
    temporary = undefined;
    fsyncDirectory(packageRoot);
    assertBeforeDeadline(ordinal);
    const published = openSealedV2MigrationPackage({ rootPath: target, expectedMigrationIdentity: migrationIdentity });
    try { input.onPhase?.("fresh-target-final-open"); assertBeforeDeadline(ordinal); return published; } catch (error) { published.close(); throw error; }
  } catch (error) {
    if (temporary !== undefined) quarantine(temporary);
    if (error instanceof ShadowMigrationError) throw error;
    sourceInvalid();
  }
}

function parseManifest(path: string): V2MigrationPackageManifestV1 {
  assertRegularFile(path);
  if (Number(lstatSync(path, { bigint: true }).size) > 64 * 1024 * 1024) conflict();
  const bytes = Buffer.concat([...readChunks(path, 0, undefined)].map((chunk) => Buffer.from(chunk)));
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) conflict();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { conflict(); }
  if (canonicalJson(value) !== bytes.toString("utf8")) conflict();
  const manifest = value as V2MigrationPackageManifestV1;
  if (Reflect.ownKeys(manifest).length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some((key) => !Object.hasOwn(manifest, key))) conflict();
  if (typeof manifest !== "object" || manifest === null || manifest.schemaVersion !== 1 || manifest.packageFormatVersion !== 1
    || manifest.migrationAlgorithmVersion !== 1 || manifest.creationReasonCode !== "production-shaped-rehearsal"
    || !HASH.test(manifest.sourceManifestChecksum) || !HASH.test(manifest.recordsChecksum) || !HASH.test(manifest.buildIdentityHash)
    || !HASH.test(manifest.configurationChecksum) || !HASH.test(manifest.packageChecksum) || !Array.isArray(manifest.recordDescriptors)) conflict();
  for (const id of [manifest.projectId, manifest.vaultId, manifest.storeId]) if (typeof id !== "string" || !UUID.test(id)) conflict();
  if (typeof manifest.workspaceId !== "string" || !HASH.test(manifest.workspaceId) || !HASH.test(manifest.terminalEventHash)
    || !/^(0|[1-9][0-9]*)$/u.test(manifest.terminalEventPosition)) conflict();
  if (typeof manifest.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(manifest.createdAt)
    || Number.isNaN(Date.parse(manifest.createdAt)) || new Date(manifest.createdAt).toISOString() !== manifest.createdAt) conflict();
  for (const numeric of [manifest.eventCount, manifest.legacyArtifactCount, manifest.aggregateSourceBytes]) if (!Number.isSafeInteger(numeric) || numeric < 0) conflict();
  const descriptors = manifest.recordDescriptors.map((descriptor, ordinal) => {
    if (typeof descriptor !== "object" || descriptor === null || Reflect.ownKeys(descriptor).length !== DESCRIPTOR_KEYS.length
      || DESCRIPTOR_KEYS.some((key) => !Object.hasOwn(descriptor, key)) || descriptor.schemaVersion !== 1 || descriptor.ordinal !== ordinal
      || (descriptor.kind !== "source-event" && descriptor.kind !== "legacy-artifact") || typeof descriptor.sourceIdentity !== "string"
      || typeof descriptor.byteLength !== "number" || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0
      || !HASH.test(descriptor.contentSha256) || (descriptor.kind === "source-event" ? descriptor.relativePath !== null
        : typeof descriptor.relativePath !== "string")) conflict();
    if ((descriptor.kind === "source-event" && !UUID.test(descriptor.sourceIdentity))
      || (descriptor.kind === "legacy-artifact" && (!HASH.test(descriptor.sourceIdentity) || !isSafeRelativePath(descriptor.relativePath!)))) conflict();
    return Object.freeze({ ...descriptor }) as V2MigrationRecordDescriptorV1;
  });
  if (descriptors.length !== manifest.eventCount + manifest.legacyArtifactCount || descriptorChecksum(descriptors) !== manifest.recordsChecksum) conflict();
  const { packageChecksum: ignored, ...body } = manifest;
  void ignored;
  if (manifestChecksum(body) !== manifest.packageChecksum) conflict();
  return Object.freeze({ ...manifest, recordDescriptors: Object.freeze(descriptors) });
}

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.includes("\\") && !relativePath.includes("\0")
    && relativePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function* readChunks(path: string, offset: number, length: number | undefined): Iterable<Uint8Array> {
  assertRegularFile(path);
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    const opened = fstatSync(handle, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) conflict();
    const size = Number(opened.size);
    const remaining = length ?? size - offset;
    if (!Number.isSafeInteger(remaining) || remaining < 0 || offset < 0 || offset + remaining > size) conflict();
    let cursor = offset;
    let left = remaining;
    while (left > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(MAX_CHUNK_BYTES, left));
      const read = readSync(handle, buffer, 0, buffer.length, cursor);
      if (read <= 0 || read > buffer.length) conflict();
      cursor += read;
      left -= read;
      yield Uint8Array.from(buffer.subarray(0, read));
    }
    const after = fstatSync(handle, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || !after.isFile() || after.nlink !== 1n) conflict();
  } finally { if (handle !== undefined) closeSync(handle); }
}

function lineLocations(rootPath: string, manifest: V2MigrationPackageManifestV1): RecordLocation[] {
  const path = join(rootPath, "events.ndjson");
  const eventDescriptors = manifest.recordDescriptors.slice(0, manifest.eventCount);
  const locations: RecordLocation[] = [];
  let pending = Buffer.alloc(0);
  let offset = 0;
  let ordinal = 0;
  for (const chunk of readChunks(path, 0, undefined)) {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_EVENT_LINE_BYTES + MAX_CHUNK_BYTES) conflict();
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const value = pending.subarray(0, newline);
      const descriptor = eventDescriptors[ordinal++];
      if (descriptor === undefined || value.length !== descriptor.byteLength || sha256(value) !== descriptor.contentSha256) {
        throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({ category: "record", ordinal }));
      }
      let event: unknown;
      try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); } catch { conflict(); }
      if (canonicalJson(event) !== value.toString("utf8") || typeof event !== "object" || event === null
        || (event as { eventId?: unknown }).eventId !== descriptor.sourceIdentity) {
        throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({ category: "canonical-record", ordinal }));
      }
      locations.push(Object.freeze({ descriptor, path, offset }));
      offset += newline + 1;
      pending = pending.subarray(newline + 1);
    }
  }
  if (pending.length !== 0 || ordinal !== eventDescriptors.length) conflict();
  return locations;
}

function assertExactPackageLayout(rootPath: string, manifest: V2MigrationPackageManifestV1): void {
  const rootEntries = readdirSync(rootPath, { withFileTypes: true }).map((entry) => entry.name).sort();
  if (canonicalJson(rootEntries) !== canonicalJson(["artifacts", "events.ndjson", "package-manifest.json"])) conflict();
  const artifactRoot = join(rootPath, "artifacts");
  assertDirectory(artifactRoot);
  const expected = new Set(manifest.recordDescriptors.slice(manifest.eventCount).map((descriptor) => descriptor.relativePath!));
  const expectedDirectories = new Set<string>([""]);
  for (const file of expected) {
    let directory = dirname(file).split(sep).join("/");
    while (directory !== "." && directory !== "") { expectedDirectories.add(directory); directory = dirname(directory).split(sep).join("/"); }
  }
  const actual = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const suffix = relative(artifactRoot, path).split(sep).join("/");
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) conflict();
      if (stat.isDirectory()) { if (!expectedDirectories.has(suffix)) conflict(); walk(path); }
      else if (stat.isFile() && stat.nlink === 1n) actual.add(suffix);
      else conflict();
    }
  };
  walk(artifactRoot);
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) conflict();
}

function verifiedRecordLocations(rootPath: string, manifest: V2MigrationPackageManifestV1): RecordLocation[] {
  assertExactPackageLayout(rootPath, manifest);
  const locations = lineLocations(rootPath, manifest);
  for (const descriptor of manifest.recordDescriptors.slice(manifest.eventCount)) {
    const path = safePath(join(rootPath, "artifacts"), descriptor.relativePath!);
    const hash = createHash("sha256"); let length = 0;
    for (const chunk of readChunks(path, 0, undefined)) { hash.update(chunk); length += chunk.length; }
    if (length !== descriptor.byteLength || hash.digest("hex") !== descriptor.contentSha256) conflict();
    locations.push(Object.freeze({ descriptor, path, offset: 0 }));
  }
  return locations;
}

function assertPackageContent(rootPath: string, expectedManifest: V2MigrationPackageManifestV1): void {
  const currentManifest = parseManifest(join(rootPath, "package-manifest.json"));
  if (canonicalJson(currentManifest) !== canonicalJson(expectedManifest)) conflict();
  verifiedRecordLocations(rootPath, expectedManifest);
}

export function openSealedV2MigrationPackage(input: OpenSealedV2MigrationPackageInput): SealedV2MigrationPackage {
  try {
    if (typeof input !== "object" || input === null || typeof input.rootPath !== "string" || !isAbsolute(input.rootPath)
      || typeof input.expectedMigrationIdentity !== "string" || !HASH.test(input.expectedMigrationIdentity)) conflict();
    const rootPath = normalized(input.rootPath);
    assertPackageTree(rootPath);
    const identities = capturePackageIdentities(rootPath);
    const manifest = parseManifest(join(rootPath, "package-manifest.json"));
    const migrationIdentity = identityFor(manifest);
    if (migrationIdentity !== input.expectedMigrationIdentity) conflict();
    const locations = verifiedRecordLocations(rootPath, manifest);
    assertPackageIdentities(rootPath, identities);
    let closed = false;
    const requireOpen = (): void => { if (closed) conflict(); };
    const assertMetadataUnchanged = (): void => {
      requireOpen();
      held(() => assertPackageIdentities(rootPath, identities));
    };
    const assertUnchanged = (): void => {
      requireOpen();
      held(() => {
        assertPackageIdentities(rootPath, identities);
        assertPackageContent(rootPath, manifest);
        assertPackageIdentities(rootPath, identities);
      });
    };
    const records = (): Iterable<V2MigrationPackageRecordV1> => {
      requireOpen();
      assertMetadataUnchanged();
      return locations.map((location) => Object.freeze({ descriptor: location.descriptor,
        readChunks(): Iterable<Uint8Array> {
          return (function* (): Iterable<Uint8Array> {
            requireOpen(); assertMetadataUnchanged();
            const bytes = held(() => {
              const chunks = [...readChunks(location.path, location.offset, location.descriptor.byteLength)];
              const value = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
              if (value.length !== location.descriptor.byteLength || sha256(value) !== location.descriptor.contentSha256) conflict();
              return Uint8Array.from(value);
            });
            for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
              requireOpen(); assertMetadataUnchanged();
              yield Uint8Array.from(bytes.subarray(offset, offset + MAX_CHUNK_BYTES));
            }
          })();
        },
      })).values();
    };
    return Object.freeze({ rootPath, migrationIdentity, manifest, records, assertUnchanged, close(): void { closed = true; } });
  } catch (error) {
    if (error instanceof ShadowMigrationError) throw error;
    conflict();
  }
}
