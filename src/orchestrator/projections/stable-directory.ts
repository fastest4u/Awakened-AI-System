import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import { LifecycleError } from "../lifecycle/errors.js";
import type {
  V2RetiredGeneration,
  V2RetirementImage,
  V2RetirementIntent,
} from "./reconciliation-journal.js";

const MAX_STABLE_MANIFEST_BYTES = 64 * 1_024;
const MAX_STABLE_GENERATION_BYTES = 512 * 1_024 * 1_024;
export const PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME =
  ".projection-manifest.publish.lock" as const;
export const PROJECTION_RECONCILIATION_JOURNAL_FILENAME =
  "projection-reconciliation-v2.json" as const;

export interface ProjectionDirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface StableProjectionManifestFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly sha256: string;
}

export interface StableProjectionManifestContentIdentity {
  readonly size: string;
  readonly sha256: string;
}

export interface StableProjectionGenerationIdentity {
  readonly filename: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly ctimeNs: string;
  readonly sha256: string;
}

export interface StableProjectionGenerationImage {
  readonly identity: StableProjectionGenerationIdentity;
  readonly bytes: Uint8Array;
}

export type StableProjectionManifestSnapshot =
  | Readonly<{
    readonly state: "missing";
    readonly directoryIdentity: ProjectionDirectoryIdentity;
  }>
  | Readonly<{
    readonly state: "present";
    readonly directoryIdentity: ProjectionDirectoryIdentity;
    readonly fileIdentity: StableProjectionManifestFileIdentity;
    readonly bytesBase64: string;
  }>;

export interface StableProjectionDirectoryOperations {
  capture(directory: string): ProjectionDirectoryIdentity;
  cleanupKnownTemps(directory: string, identity: ProjectionDirectoryIdentity): void;
  assertGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): void;
  reserveReconciliationJournal(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    minimumGeneration: number,
  ): number;
  beginReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
  ): V2RetirementIntent;
  completeReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
    image: V2RetirementImage,
  ): V2RetiredGeneration;
  readReconciliationRetirements(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): readonly (V2RetirementIntent | V2RetiredGeneration)[];
  readGenerationImage(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    filename: string,
  ): StableProjectionGenerationImage;
  retireGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    expected: StableProjectionGenerationIdentity,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity;
  captureRetiredGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity | null;
  installGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    temporaryFilename: string,
    finalFilename: string,
    expected: StableProjectionGenerationIdentity,
  ): "installed" | "superseded";
  captureManifest(
    directory: string,
    identity: ProjectionDirectoryIdentity,
  ): StableProjectionManifestSnapshot;
  acquireManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "acquired" | "busy";
  prepareManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "prepared" | "superseded" | "poisoned";
  installManifestIfExpected(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "installed" | "superseded" | "poisoned";
  commitManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    attempted: StableProjectionManifestContentIdentity,
  ): "committed" | "poisoned";
  rollbackManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    installed: Extract<StableProjectionManifestSnapshot, { readonly state: "present" }>,
  ): "restored" | "removed" | "superseded" | "poisoned";
  releaseManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "released" | "poisoned";
}

function normalizedPath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function invalid(cause?: unknown): never {
  throw new Error("PROJECTION_PATH_INVALID", cause === undefined ? undefined : { cause });
}

export function captureProjectionDirectoryIdentity(
  directory: string,
): ProjectionDirectoryIdentity {
  if (
    !isAbsolute(directory)
    || normalize(directory) !== directory
    || resolve(directory) !== directory
  ) {
    return invalid();
  }
  try {
    const stat = lstatSync(directory, { bigint: true });
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || normalizedPath(realpathSync.native(directory)) !== normalizedPath(directory)
    ) return invalid();
    return Object.freeze({
      canonicalPath: directory,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECTION_PATH_INVALID") throw error;
    return invalid(error);
  }
}

export function sameProjectionDirectoryIdentity(
  left: ProjectionDirectoryIdentity,
  right: ProjectionDirectoryIdentity,
): boolean {
  return normalizedPath(left.canonicalPath) === normalizedPath(right.canonicalPath)
    && left.device === right.device
    && left.inode === right.inode;
}

function runStableMutation(
  operation:
    | "cleanup"
    | "assert-generation"
    | "reserve-reconciliation-journal"
    | "begin-reconciliation-retirement"
    | "complete-reconciliation-retirement"
    | "read-reconciliation-retirements"
    | "read-generation-image"
    | "retire-generation"
    | "capture-retired-generation"
    | "install-generation"
    | "capture-manifest"
    | "acquire-manifest-lock"
    | "prepare-manifest"
    | "install-manifest"
    | "commit-manifest"
    | "rollback-manifest"
    | "release-manifest-lock",
  directory: string,
  identity: ProjectionDirectoryIdentity,
  argumentsAfterIdentity: readonly string[] = [],
): string {
  const expectedPath = identity.canonicalPath;
  const expectedDevice = identity.device;
  const expectedInode = identity.inode;
  const operationArguments = argumentsAfterIdentity;
  const MAX_MANIFEST_BYTES = MAX_STABLE_MANIFEST_BYTES;
  const MAX_GENERATION_BYTES = MAX_STABLE_GENERATION_BYTES;
  const MANIFEST_NAME = "projection-manifest.json";
  const MANIFEST_TEMP_NAME = ".projection-manifest.json.tmp";
  const LOCK_NAME = PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME;
  const RECONCILIATION_JOURNAL_NAME = PROJECTION_RECONCILIATION_JOURNAL_FILENAME;
  const RECONCILIATION_JOURNAL_TEMP_NAME = ".projection-reconciliation-v2.json.tmp";
  const TOKEN = /^[0-9a-f]{32}$/u;
  const V2_GENERATION = /^projections-[23]-([1-9][0-9]{0,9})\.sqlite$/u;
  const V2_RETIRED = /^\.projections-[23]-retired-([0-9a-f]{32})\.sqlite$/u;

  const integrity = (): never => {
    throw new Error("INTEGRITY_FAILURE");
  };
  const fileInDir = (name: string): string => {
    if (
      typeof name !== "string"
      || name.length === 0
      || basename(name) !== name
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
    ) {
      return invalid();
    }
    return join(directory, name);
  };
  const assertDirectory = () => {
    if (
      typeof directory !== "string"
      || !isAbsolute(directory)
      || normalize(directory) !== directory
      || resolve(directory) !== directory
    ) {
      return invalid();
    }
    const dirStat = lstatSync(directory, { bigint: true });
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return invalid();
    if (
      dirStat.dev.toString() !== expectedDevice
      || dirStat.ino.toString() !== expectedInode
    ) {
      return invalid();
    }
    if (normalizedPath(realpathSync.native(directory)) !== normalizedPath(expectedPath)) {
      return invalid();
    }
    return dirStat;
  };
  const captureManifestInDir = () => {
    const manifestPath = fileInDir(MANIFEST_NAME);
    let before;
    try {
      before = lstatSync(manifestPath, { bigint: true });
    } catch (error) {
      if (error && (error as { code?: string }).code === "ENOENT") {
        const dirStat = assertDirectory();
        return {
          state: "missing",
          directoryDevice: dirStat.dev.toString(),
          directoryInode: dirStat.ino.toString(),
        };
      }
      throw error;
    }
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size < 0n
      || before.size > BigInt(MAX_MANIFEST_BYTES)
    ) {
      return invalid();
    }
    let handle: number | undefined;
    try {
      handle = openSync(manifestPath, "r");
      const opened = fstatSync(handle, { bigint: true });
      if (
        !opened.isFile()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.size !== before.size
      ) {
        return invalid();
      }
      const bytes = readFileSync(handle);
      const openedAfter = fstatSync(handle, { bigint: true });
      const after = lstatSync(manifestPath, { bigint: true });
      if (
        bytes.byteLength !== Number(before.size)
        || openedAfter.dev !== opened.dev
        || openedAfter.ino !== opened.ino
        || openedAfter.size !== opened.size
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || !after.isFile()
        || after.isSymbolicLink()
      ) {
        return invalid();
      }
      const dirStat = assertDirectory();
      return {
        state: "present",
        directoryDevice: dirStat.dev.toString(),
        directoryInode: dirStat.ino.toString(),
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        size: opened.size.toString(),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytesBase64: bytes.toString("base64"),
      };
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };
  const syncDirectory = () => {
    let handle: number | undefined;
    try {
      handle = openSync(directory, "r");
      fsyncSync(handle);
    } catch (error) {
      const code = error && (error as { code?: string }).code;
      if (
        code !== "EINVAL"
        && code !== "EISDIR"
        && code !== "ENOTSUP"
        && code !== "EOPNOTSUPP"
        && !(process.platform === "win32" && (code === "EACCES" || code === "EBADF" || code === "EPERM"))
      ) {
        throw error;
      }
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };
  const sidecarPresent = (name: string): boolean => {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        lstatSync(fileInDir(name + suffix));
        return true;
      } catch (error) {
        if (error && (error as { code?: string }).code === "ENOENT") continue;
        integrity();
      }
    }
    return false;
  };
  const captureFileIdentity = (name: string, maximumBytes = MAX_MANIFEST_BYTES) => {
    const fullPath = fileInDir(name);
    const before = lstatSync(fullPath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size < 0n
      || before.size > BigInt(maximumBytes)
    ) {
      return invalid();
    }
    let handle: number | undefined;
    try {
      handle = openSync(fullPath, "r");
      const opened = fstatSync(handle, { bigint: true });
      if (
        !opened.isFile()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.size !== before.size
        || opened.ctimeNs !== before.ctimeNs
      ) {
        return invalid();
      }
      const bytes = readFileSync(handle);
      const openedAfter = fstatSync(handle, { bigint: true });
      const after = lstatSync(fullPath, { bigint: true });
      if (
        bytes.byteLength !== Number(before.size)
        || openedAfter.dev !== opened.dev
        || openedAfter.ino !== opened.ino
        || openedAfter.size !== opened.size
        || openedAfter.ctimeNs !== opened.ctimeNs
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.ctimeNs !== before.ctimeNs
        || !after.isFile()
        || after.isSymbolicLink()
      ) {
        return invalid();
      }
      assertDirectory();
      return {
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        size: opened.size.toString(),
        ctimeNs: opened.ctimeNs.toString(),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      };
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };
  const assertToken = (token: string | undefined): string => {
    if (typeof token !== "string" || !TOKEN.test(token)) return invalid();
    return token;
  };
  const assertLock = (token: string) => {
    const lock = captureFileIdentity(LOCK_NAME);
    if (lock.bytes.toString("utf8") !== token) return invalid();
  };
  const linkIfAbsent = (source: string, target: string): boolean => {
    try {
      linkSync(fileInDir(source), fileInDir(target));
      return true;
    } catch (error) {
      if (error && (error as { code?: string }).code === "EEXIST") return false;
      throw error;
    }
  };
  const removeRegularFile = (name: string) => {
    const fullPath = fileInDir(name);
    const entry = lstatSync(fullPath);
    if (!entry.isFile() || entry.isSymbolicLink()) return invalid();
    unlinkSync(fullPath);
  };
  const fileMatchesArguments = (
    file: { device: string; inode: string; size: string; sha256: string },
    offset: number,
  ): boolean => (
    file.device === operationArguments[offset]
    && file.inode === operationArguments[offset + 1]
    && file.size === operationArguments[offset + 2]
    && file.sha256 === operationArguments[offset + 3]
  );
  const sameGenerationIdentity = (
    file: { device: string; inode: string; size: string; ctimeNs: string; sha256: string },
    expected: { device?: string; inode?: string; size?: string; ctimeNs?: string; sha256?: string },
  ): boolean => (
    file.device === expected.device
    && file.inode === expected.inode
    && file.size === expected.size
    && file.ctimeNs === expected.ctimeNs
    && file.sha256 === expected.sha256
  );
  const sameGenerationRenameContinuity = (
    file: { device: string; inode: string; size: string; sha256: string },
    expected: { device?: string; inode?: string; size?: string; sha256?: string },
  ): boolean => (
    file.device === expected.device
    && file.inode === expected.inode
    && file.size === expected.size
    && file.sha256 === expected.sha256
  );
  const exactKeys = (value: unknown, keys: readonly string[]): boolean => (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
  const validGeneration = (value: unknown): value is number => (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647
  );
  const validRetirementGen = (value: unknown): value is number => (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2147483647
  );
  const exactRetirementImage = (rawValue: unknown): V2RetirementImage => {
    const value = rawValue as Record<string, unknown>;
    if (
      !exactKeys(rawValue, ["device", "inode", "size", "ctimeNs", "sha256"])
      || typeof value.device !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.device)
      || typeof value.inode !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.inode)
      || typeof value.size !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.size)
      || BigInt(value.size) > BigInt(MAX_GENERATION_BYTES)
      || typeof value.ctimeNs !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.ctimeNs)
      || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)
    ) {
      return invalid();
    }
    return {
      device: value.device,
      inode: value.inode,
      size: value.size,
      ctimeNs: value.ctimeNs,
      sha256: value.sha256,
    };
  };
  const exactRetirement = (value: unknown): V2RetirementIntent | V2RetiredGeneration => {
    const rec = value as Record<string, unknown> | null | undefined;
    if (!rec || !validRetirementGen(rec.generation)) return invalid();
    if (rec.state === "intent") {
      if (
        !exactKeys(rec, ["state", "generation", "finalFilename", "retiredFilename", "image"])
        || typeof rec.finalFilename !== "string"
        || !V2_GENERATION.test(rec.finalFilename)
        || Number(V2_GENERATION.exec(rec.finalFilename)![1]) !== rec.generation
        || typeof rec.retiredFilename !== "string"
        || !V2_RETIRED.test(rec.retiredFilename)
        || rec.finalFilename.split("-")[1] !== rec.retiredFilename.split("-")[1]
      ) {
        return invalid();
      }
      return {
        state: "intent",
        generation: rec.generation,
        finalFilename: rec.finalFilename,
        retiredFilename: rec.retiredFilename,
        image: exactRetirementImage(rec.image),
      };
    }
    if (
      rec.state !== "retired"
      || !exactKeys(rec, ["state", "generation", "retiredFilename", "image"])
      || typeof rec.retiredFilename !== "string"
      || !V2_RETIRED.test(rec.retiredFilename)
    ) {
      return invalid();
    }
    return {
      state: "retired",
      generation: rec.generation,
      retiredFilename: rec.retiredFilename,
      image: exactRetirementImage(rec.image),
    };
  };
  const canonicalJournalBytes = (journal: unknown): Buffer =>
    Buffer.from(JSON.stringify(journal) + "\n", "utf8");
  const exactJournal = (
    bytes: Buffer,
  ): { highestReservedGeneration: number; retirements: Array<V2RetirementIntent | V2RetiredGeneration> } => {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      return invalid();
    }
    if (!validGeneration(value && value.highestReservedGeneration)) return invalid();
    if (exactKeys(value, ["highestReservedGeneration"])) {
      const legacy = { highestReservedGeneration: value.highestReservedGeneration };
      if (!canonicalJournalBytes(legacy).equals(bytes)) throw new Error("JOURNAL_FORMAT_MISMATCH");
      return { highestReservedGeneration: legacy.highestReservedGeneration as number, retirements: [] };
    }
    if (exactKeys(value, ["highestReservedGeneration", "schemaVersion"]) && value.schemaVersion === 1) {
      const legacy = { highestReservedGeneration: value.highestReservedGeneration, schemaVersion: 1 };
      if (!canonicalJournalBytes(legacy).equals(bytes)) throw new Error("JOURNAL_FORMAT_MISMATCH");
      return { highestReservedGeneration: legacy.highestReservedGeneration as number, retirements: [] };
    }
    if (
      !exactKeys(value, ["highestReservedGeneration", "retirements"])
      || !Array.isArray(value.retirements)
      || value.retirements.length > 100000
    ) {
      return invalid();
    }
    const generations = new Set<number>();
    const retiredFilenames = new Set<string>();
    const retirements = value.retirements.map((record) => {
      const retirement = exactRetirement(record);
      if (
        retirement.generation > (value.highestReservedGeneration as number)
        || generations.has(retirement.generation)
        || retiredFilenames.has(retirement.retiredFilename)
      ) {
        return invalid();
      }
      generations.add(retirement.generation);
      retiredFilenames.add(retirement.retiredFilename);
      return retirement;
    });
    const canonical = {
      highestReservedGeneration: value.highestReservedGeneration as number,
      retirements,
    };
    if (!canonicalJournalBytes(canonical).equals(bytes)) throw new Error("JOURNAL_FORMAT_MISMATCH");
    return canonical;
  };
  const readJournal = () => {
    try {
      return exactJournal(captureFileIdentity(RECONCILIATION_JOURNAL_NAME).bytes);
    } catch (error) {
      if (error && (error as { code?: string }).code === "ENOENT") {
        return { highestReservedGeneration: 0, retirements: [] as Array<V2RetirementIntent | V2RetiredGeneration> };
      }
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
    }
  };
  const writeDurable = (name: string, bytes: Buffer) => {
    const fullPath = fileInDir(name);
    let handle: number | undefined;
    try {
      handle = openSync(fullPath, "wx", 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(handle, bytes, offset, bytes.byteLength - offset, offset);
        if (!Number.isSafeInteger(written) || written <= 0) return invalid();
        offset += written;
      }
      fsyncSync(handle);
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };
  const writeJournal = (journal: {
    highestReservedGeneration: number;
    retirements: ReadonlyArray<V2RetirementIntent | V2RetiredGeneration>;
  }) => {
    try {
      lstatSync(fileInDir(RECONCILIATION_JOURNAL_TEMP_NAME));
      return invalid();
    } catch (error) {
      if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
    }
    const bytes = canonicalJournalBytes(journal);
    writeDurable(RECONCILIATION_JOURNAL_TEMP_NAME, bytes);
    renameSync(fileInDir(RECONCILIATION_JOURNAL_TEMP_NAME), fileInDir(RECONCILIATION_JOURNAL_NAME));
    syncDirectory();
    const observed = readJournal();
    if (!canonicalJournalBytes(observed).equals(bytes)) throw new Error("JOURNAL_VERIFY_MISMATCH");
  };
  const transactionNames = (attemptToken: string) => ({
    previous: ".projection-manifest.previous-" + attemptToken,
    attempted: ".projection-manifest.attempted-" + attemptToken,
    displaced: ".projection-manifest.displaced-" + attemptToken,
    failed: ".projection-manifest.failed-" + attemptToken,
  });

  try {
    assertDirectory();
    if (operation === "cleanup") {
      const generationTemp = /^\.projections-[123]-[1-9][0-9]{0,9}(?:-[0-9a-f]{32})?\.sqlite\.tmp(?:-(?:wal|shm))?$/u;
      for (const name of readdirSync(directory)) {
        if (name !== ".projection-manifest.json.tmp" && !generationTemp.test(name)) continue;
        const fullPath = fileInDir(name);
        const entry = lstatSync(fullPath);
        if (!entry.isFile() || entry.isSymbolicLink()) return invalid();
        unlinkSync(fullPath);
      }
      return "cleaned";
    } else if (operation === "capture-manifest") {
      return JSON.stringify(captureManifestInDir());
    } else if (operation === "assert-generation") {
      const [filename] = operationArguments;
      if (
        typeof filename !== "string"
        || basename(filename) !== filename
        || !/^projections-[123]-[1-9][0-9]{0,9}\.sqlite$/u.test(filename)
      ) {
        return invalid();
      }
      if (sidecarPresent(filename)) integrity();
      try {
        const entry = lstatSync(fileInDir(filename));
        if (!entry.isFile() || entry.isSymbolicLink()) return invalid();
        return "present";
      } catch (error) {
        if (error && (error as { code?: string }).code === "ENOENT") return "missing";
        throw error;
      }
    } else if (operation === "reserve-reconciliation-journal") {
      const [rawLockToken, requested] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (typeof requested !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(requested)) return invalid();
      const requestedGeneration = Number(requested);
      if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration > 2147483647) return invalid();
      const journal = readJournal();
      const next = Math.max(journal.highestReservedGeneration, requestedGeneration);
      writeJournal({ highestReservedGeneration: next, retirements: journal.retirements });
      assertLock(lockToken);
      return String(next);
    } else if (operation === "begin-reconciliation-retirement") {
      const [rawLockToken, encodedIntent] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (typeof encodedIntent !== "string") return invalid();
      let input: unknown;
      try {
        input = JSON.parse(encodedIntent);
      } catch {
        return invalid();
      }
      const intent = exactRetirement(input);
      if (intent.state !== "intent" || JSON.stringify(intent) !== encodedIntent) return invalid();
      const journal = readJournal();
      if (
        intent.generation > journal.highestReservedGeneration
        || journal.retirements.some(
          (record) => record.generation === intent.generation || record.retiredFilename === intent.retiredFilename,
        )
      ) {
        return invalid();
      }
      writeJournal({
        highestReservedGeneration: journal.highestReservedGeneration,
        retirements: [...journal.retirements, intent],
      });
      assertLock(lockToken);
      return JSON.stringify(intent);
    } else if (operation === "complete-reconciliation-retirement") {
      const [rawLockToken, encodedIntent, encodedImage] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (typeof encodedIntent !== "string" || typeof encodedImage !== "string") return invalid();
      let intentInput: unknown;
      let imageInput: unknown;
      try {
        intentInput = JSON.parse(encodedIntent);
        imageInput = JSON.parse(encodedImage);
      } catch {
        return invalid();
      }
      const intent = exactRetirement(intentInput);
      const image = exactRetirementImage(imageInput);
      if (
        intent.state !== "intent"
        || JSON.stringify(intent) !== encodedIntent
        || JSON.stringify(image) !== encodedImage
        || !sameGenerationRenameContinuity(image, intent.image)
      ) {
        return invalid();
      }
      const journal = readJournal();
      const index = journal.retirements.findIndex((record) => record.generation === intent.generation);
      if (index < 0 || JSON.stringify(journal.retirements[index]) !== JSON.stringify(intent)) return invalid();
      const retired: V2RetiredGeneration = {
        state: "retired",
        generation: intent.generation,
        retiredFilename: intent.retiredFilename,
        image,
      };
      const retirements = [...journal.retirements];
      retirements[index] = retired;
      writeJournal({ highestReservedGeneration: journal.highestReservedGeneration, retirements });
      assertLock(lockToken);
      return JSON.stringify(retired);
    } else if (operation === "read-reconciliation-retirements") {
      const [rawLockToken] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      const journal = readJournal();
      assertLock(lockToken);
      return JSON.stringify(journal.retirements);
    } else if (operation === "read-generation-image") {
      const [rawLockToken, filename] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (typeof filename !== "string" || !V2_GENERATION.test(filename)) return invalid();
      if (sidecarPresent(filename)) integrity();
      const image = captureFileIdentity(
        filename,
        filename.startsWith("projections-3-") ? 64 * 1024 * 1024 : MAX_GENERATION_BYTES,
      );
      assertLock(lockToken);
      return JSON.stringify({
        filename,
        device: image.device,
        inode: image.inode,
        size: image.size,
        ctimeNs: image.ctimeNs,
        sha256: image.sha256,
        bytesBase64: image.bytes.toString("base64"),
      });
    } else if (operation === "retire-generation") {
      const [rawLockToken, filename, retiredFilename, device, inode, size, ctimeNs, sha256] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (
        typeof filename !== "string"
        || !V2_GENERATION.test(filename)
        || typeof retiredFilename !== "string"
        || !V2_RETIRED.test(retiredFilename)
        || filename.split("-")[1] !== retiredFilename.split("-")[1]
      ) {
        return invalid();
      }
      try {
        lstatSync(fileInDir(retiredFilename));
        return invalid();
      } catch (error) {
        if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
      }
      if (sidecarPresent(filename) || sidecarPresent(retiredFilename)) integrity();
      const expected = { device, inode, size, ctimeNs, sha256 };
      const current = captureFileIdentity(filename, MAX_GENERATION_BYTES);
      if (!sameGenerationIdentity(current, expected)) return invalid();
      renameSync(fileInDir(filename), fileInDir(retiredFilename));
      syncDirectory();
      const retired = captureFileIdentity(retiredFilename, MAX_GENERATION_BYTES);
      if (!sameGenerationRenameContinuity(retired, expected)) return invalid();
      assertLock(lockToken);
      return JSON.stringify({
        filename: retiredFilename,
        device: retired.device,
        inode: retired.inode,
        size: retired.size,
        ctimeNs: retired.ctimeNs,
        sha256: retired.sha256,
      });
    } else if (operation === "capture-retired-generation") {
      const [rawLockToken, retiredFilename] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (typeof retiredFilename !== "string" || !V2_RETIRED.test(retiredFilename)) return invalid();
      if (sidecarPresent(retiredFilename)) integrity();
      let retired: ReturnType<typeof captureFileIdentity> | undefined;
      try {
        retired = captureFileIdentity(retiredFilename, MAX_GENERATION_BYTES);
      } catch (error) {
        if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        assertDirectory();
      }
      assertLock(lockToken);
      return retired === undefined
        ? "null"
        : JSON.stringify({
            filename: retiredFilename,
            device: retired.device,
            inode: retired.inode,
            size: retired.size,
            ctimeNs: retired.ctimeNs,
            sha256: retired.sha256,
          });
    } else if (operation === "install-generation") {
      const [rawLockToken, temporaryFilename, finalFilename, device, inode, size, sha256] = operationArguments;
      const lockToken = assertToken(rawLockToken);
      assertLock(lockToken);
      if (
        typeof temporaryFilename !== "string"
        || !/^\.projections-[23]-[1-9][0-9]{0,9}-[0-9a-f]{32}\.sqlite\.tmp$/u.test(temporaryFilename)
        || typeof finalFilename !== "string"
        || !/^projections-[23]-[1-9][0-9]{0,9}\.sqlite$/u.test(finalFilename)
        || !temporaryFilename.startsWith("." + finalFilename.slice(0, -7) + "-")
      ) {
        return invalid();
      }
      const temporary = captureFileIdentity(temporaryFilename, MAX_GENERATION_BYTES);
      if (
        temporary.device !== device
        || temporary.inode !== inode
        || temporary.size !== size
        || temporary.sha256 !== sha256
        || sidecarPresent(temporaryFilename)
        || sidecarPresent(finalFilename)
      ) {
        return invalid();
      }
      if (!linkIfAbsent(temporaryFilename, finalFilename)) {
        return "superseded";
      }
      const installed = captureFileIdentity(finalFilename, MAX_GENERATION_BYTES);
      if (
        installed.device !== temporary.device
        || installed.inode !== temporary.inode
        || installed.size !== temporary.size
        || installed.sha256 !== temporary.sha256
      ) {
        integrity();
      }
      removeRegularFile(temporaryFilename);
      syncDirectory();
      assertLock(lockToken);
      return "installed";
    } else if (operation === "acquire-manifest-lock") {
      const lockToken = assertToken(operationArguments[0]);
      const lockPath = fileInDir(LOCK_NAME);
      let handle: number | undefined;
      try {
        handle = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if (error && (error as { code?: string }).code === "EEXIST") {
          return "busy";
        }
        throw error;
      }
      try {
        const bytes = Buffer.from(lockToken, "utf8");
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(handle, bytes, offset, bytes.byteLength - offset, offset);
          if (!Number.isSafeInteger(written) || written <= 0) return invalid();
          offset += written;
        }
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      syncDirectory();
      assertLock(lockToken);
      return "acquired";
    } else if (operation === "release-manifest-lock") {
      const lockToken = assertToken(operationArguments[0]);
      assertLock(lockToken);
      const retained = readdirSync(directory).some(
        (name) =>
          name.startsWith(".projection-manifest.previous-")
          || name.startsWith(".projection-manifest.attempted-")
          || name.startsWith(".projection-manifest.displaced-")
          || name.startsWith(".projection-manifest.failed-"),
      );
      if (retained) return "poisoned";
      removeRegularFile(LOCK_NAME);
      syncDirectory();
      assertDirectory();
      return "released";
    } else if (operation === "prepare-manifest") {
      const lockToken = assertToken(operationArguments[0]);
      const attemptToken = assertToken(operationArguments[1]);
      const expectedState = operationArguments[2];
      if (expectedState !== "missing" && expectedState !== "present") return invalid();
      const names = transactionNames(attemptToken);
      assertLock(lockToken);
      const candidate = captureFileIdentity(MANIFEST_TEMP_NAME);
      for (const name of Object.values(names)) {
        try {
          lstatSync(fileInDir(name));
          return invalid();
        } catch (error) {
          if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      if (!linkIfAbsent(MANIFEST_TEMP_NAME, names.attempted)) return invalid();
      const attempted = captureFileIdentity(names.attempted);
      if (
        attempted.device !== candidate.device
        || attempted.inode !== candidate.inode
        || attempted.size !== candidate.size
        || attempted.sha256 !== candidate.sha256
      ) {
        return invalid();
      }
      let outcome = "prepared";
      if (expectedState === "present") {
        try {
          linkSync(fileInDir(MANIFEST_NAME), fileInDir(names.previous));
        } catch (error) {
          if (error && (error as { code?: string }).code === "ENOENT") outcome = "poisoned";
          else throw error;
        }
        if (outcome === "prepared") {
          const previous = captureFileIdentity(names.previous);
          if (!fileMatchesArguments(previous, 3)) outcome = "superseded";
        }
      } else {
        try {
          lstatSync(fileInDir(MANIFEST_NAME));
          outcome = "superseded";
        } catch (error) {
          if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      syncDirectory();
      assertLock(lockToken);
      return outcome;
    } else if (operation === "install-manifest") {
      const lockToken = assertToken(operationArguments[0]);
      const attemptToken = assertToken(operationArguments[1]);
      const expectedState = operationArguments[2];
      if (expectedState !== "missing" && expectedState !== "present") return invalid();
      const names = transactionNames(attemptToken);
      assertLock(lockToken);
      captureFileIdentity(names.attempted);
      if (expectedState === "present") {
        const previous = captureFileIdentity(names.previous);
        if (!fileMatchesArguments(previous, 3)) return invalid();
      } else {
        try {
          lstatSync(fileInDir(names.previous));
          return invalid();
        } catch (error) {
          if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      for (const name of [names.displaced, names.failed]) {
        try {
          lstatSync(fileInDir(name));
          return invalid();
        } catch (error) {
          if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      if (expectedState === "missing") {
        if (!linkIfAbsent(names.attempted, MANIFEST_NAME)) {
          return "superseded";
        }
        removeRegularFile(MANIFEST_TEMP_NAME);
        syncDirectory();
        assertLock(lockToken);
        return "installed";
      }
      let moved = false;
      try {
        renameSync(fileInDir(MANIFEST_NAME), fileInDir(names.displaced));
        moved = true;
      } catch (error) {
        if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
      }
      if (!moved) return "poisoned";
      const displaced = captureFileIdentity(names.displaced);
      if (!fileMatchesArguments(displaced, 3)) {
        if (!linkIfAbsent(names.displaced, MANIFEST_NAME)) {
          return "poisoned";
        }
        syncDirectory();
        return "superseded";
      }
      if (!linkIfAbsent(names.attempted, MANIFEST_NAME)) {
        syncDirectory();
        return "superseded";
      }
      removeRegularFile(MANIFEST_TEMP_NAME);
      syncDirectory();
      assertLock(lockToken);
      return "installed";
    } else if (operation === "commit-manifest") {
      const lockToken = assertToken(operationArguments[0]);
      const attemptToken = assertToken(operationArguments[1]);
      const previousState = operationArguments[2];
      if (previousState !== "missing" && previousState !== "present") return invalid();
      const names = transactionNames(attemptToken);
      assertLock(lockToken);
      const attemptedSize = operationArguments[7];
      const attemptedSha256 = operationArguments[8];
      if (
        typeof attemptedSize !== "string"
        || !/^(?:0|[1-9][0-9]*)$/u.test(attemptedSize)
        || BigInt(attemptedSize) > BigInt(MAX_MANIFEST_BYTES)
        || typeof attemptedSha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(attemptedSha256)
      ) {
        return invalid();
      }
      const attempted = captureFileIdentity(names.attempted);
      if (attempted.size !== attemptedSize || attempted.sha256 !== attemptedSha256) return invalid();
      if (previousState === "present") {
        captureFileIdentity(names.previous);
      } else {
        try {
          lstatSync(fileInDir(names.previous));
          return invalid();
        } catch (error) {
          if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      const retained: string[] = [];
      for (const name of [names.displaced, names.failed]) {
        try {
          captureFileIdentity(name);
          retained.push(name);
        } catch (error) {
          if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
      removeRegularFile(names.attempted);
      if (previousState === "present") removeRegularFile(names.previous);
      for (const name of retained) removeRegularFile(name);
      syncDirectory();
      assertLock(lockToken);
      return "committed";
    } else if (operation === "rollback-manifest") {
      const lockToken = assertToken(operationArguments[0]);
      const attemptToken = assertToken(operationArguments[1]);
      const previousState = operationArguments[2];
      if (previousState !== "missing" && previousState !== "present") return invalid();
      const names = transactionNames(attemptToken);
      assertLock(lockToken);
      const attempted = captureFileIdentity(names.attempted);
      if (!fileMatchesArguments(attempted, 7)) return invalid();
      if (previousState === "present") {
        const previous = captureFileIdentity(names.previous);
        if (!fileMatchesArguments(previous, 3)) return invalid();
        const displaced = captureFileIdentity(names.displaced);
        if (!fileMatchesArguments(displaced, 3)) return invalid();
      } else {
        for (const name of [names.previous, names.displaced]) {
          try {
            lstatSync(fileInDir(name));
            return invalid();
          } catch (error) {
            if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
          }
        }
      }
      try {
        lstatSync(fileInDir(names.failed));
        return invalid();
      } catch (error) {
        if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
      }
      let moved = false;
      try {
        renameSync(fileInDir(MANIFEST_NAME), fileInDir(names.failed));
        moved = true;
      } catch (error) {
        if (!error || (error as { code?: string }).code !== "ENOENT") throw error;
      }
      if (!moved) {
        syncDirectory();
        return "poisoned";
      }
      const failed = captureFileIdentity(names.failed);
      if (!fileMatchesArguments(failed, 7)) {
        if (!linkIfAbsent(names.failed, MANIFEST_NAME)) {
          return "superseded";
        }
        syncDirectory();
        return "superseded";
      }
      let outcome: string;
      if (previousState === "present") {
        outcome = linkIfAbsent(names.previous, MANIFEST_NAME) ? "restored" : "superseded";
        if (outcome === "restored") {
          const restored = captureFileIdentity(MANIFEST_NAME);
          if (!fileMatchesArguments(restored, 3)) return invalid();
        }
      } else {
        try {
          lstatSync(fileInDir(MANIFEST_NAME));
          outcome = "superseded";
        } catch (error) {
          if (error && (error as { code?: string }).code === "ENOENT") outcome = "removed";
          else throw error;
        }
      }
      syncDirectory();
      assertLock(lockToken);
      return outcome;
    }
    return invalid();
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    const message = error instanceof Error ? error.message : "PROJECTION_PATH_INVALID";
    if (message === "INTEGRITY_FAILURE") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (message === "PROJECTION_PUBLICATION_RECOVERY_REQUIRED") {
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
    }
    return invalid(error);
  }
}

function snapshotIdentityArguments(
  snapshot: StableProjectionManifestSnapshot,
): readonly [string, string, string, string, string] {
  if (snapshot.state === "missing") return ["missing", "", "", "", ""];
  return [
    "present",
    snapshot.fileIdentity.device,
    snapshot.fileIdentity.inode,
    snapshot.fileIdentity.size,
    snapshot.fileIdentity.sha256,
  ];
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function decodeGenerationIdentity(value: string, filename: string): StableProjectionGenerationIdentity {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (
    Reflect.ownKeys(source).length !== 5
    || !decimal(source.device)
    || !decimal(source.inode)
    || !decimal(source.size)
    || !decimal(source.ctimeNs)
    || BigInt(source.size) > BigInt(MAX_STABLE_GENERATION_BYTES)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
  ) return invalid();
  return Object.freeze({
    filename,
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  });
}

function decodeGenerationImage(value: string): StableProjectionGenerationImage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (
    Reflect.ownKeys(source).length !== 7
    || typeof source.filename !== "string"
    || !/^projections-[23]-[1-9][0-9]{0,9}\.sqlite$/u.test(source.filename)
    || typeof source.bytesBase64 !== "string"
  ) return invalid();
  const identity = decodeGenerationIdentity(JSON.stringify({
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  }), source.filename);
  if (source.filename.startsWith("projections-3-") && BigInt(identity.size) > 64n * 1024n * 1024n) return invalid();
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== source.bytesBase64
    || BigInt(bytes.byteLength) !== BigInt(identity.size)
    || createHash("sha256").update(bytes).digest("hex") !== identity.sha256
  ) return invalid();
  return Object.freeze({ identity, bytes });
}

function decodeRetiredGeneration(value: string): StableProjectionGenerationIdentity {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (
    Reflect.ownKeys(source).length !== 6
    || typeof source.filename !== "string"
    || !/^\.projections-[23]-retired-[0-9a-f]{32}\.sqlite$/u.test(source.filename)
  ) return invalid();
  return decodeGenerationIdentity(JSON.stringify({
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  }), source.filename);
}

function exactRecordKeys(source: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(source).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function decodeRetirementImage(value: unknown): V2RetirementImage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const source = value as Record<PropertyKey, unknown>;
  if (
    !exactRecordKeys(source, ["device", "inode", "size", "ctimeNs", "sha256"])
    || !decimal(source.device)
    || !decimal(source.inode)
    || !decimal(source.size)
    || BigInt(source.size) > BigInt(MAX_STABLE_GENERATION_BYTES)
    || !decimal(source.ctimeNs)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
  ) return invalid();
  return Object.freeze({
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  });
}

function validRetirementGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= 2_147_483_647;
}

function decodeRetirementRecord(value: unknown): V2RetirementIntent | V2RetiredGeneration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const source = value as Record<PropertyKey, unknown>;
  if (
    !validRetirementGeneration(source.generation)
    || typeof source.retiredFilename !== "string"
    || !/^\.projections-[23]-retired-[0-9a-f]{32}\.sqlite$/u.test(source.retiredFilename)
  ) return invalid();
  const generation = source.generation;
  const image = decodeRetirementImage(source.image);
  if (source.state === "intent") {
    if (
      !exactRecordKeys(source, ["state", "generation", "finalFilename", "retiredFilename", "image"])
      || typeof source.finalFilename !== "string"
      || !/^projections-[23]-[1-9][0-9]{0,9}\.sqlite$/u.test(source.finalFilename)
      || Number(/^projections-[23]-([1-9][0-9]{0,9})\.sqlite$/u.exec(source.finalFilename)?.[1]) !== generation
      || source.finalFilename.split("-")[1] !== String(source.retiredFilename).split("-")[1]
    ) return invalid();
    return Object.freeze({
      state: "intent",
      generation,
      finalFilename: source.finalFilename,
      retiredFilename: source.retiredFilename,
      image,
    });
  }
  if (source.state !== "retired" || !exactRecordKeys(
    source,
    ["state", "generation", "retiredFilename", "image"],
  )) return invalid();
  return Object.freeze({
    state: "retired",
    generation,
    retiredFilename: source.retiredFilename,
    image,
  });
}

function decodeRetirementRecordText(value: string): V2RetirementIntent | V2RetiredGeneration {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  return decodeRetirementRecord(decoded);
}

function decodeReconciliationRetirements(
  value: string,
): readonly (V2RetirementIntent | V2RetiredGeneration)[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!Array.isArray(decoded) || decoded.length > 100_000) return invalid();
  const generations = new Set<number>();
  const retiredFilenames = new Set<string>();
  const records = decoded.map((value) => {
    const record = decodeRetirementRecord(value);
    if (generations.has(record.generation) || retiredFilenames.has(record.retiredFilename)) {
      return invalid();
    }
    generations.add(record.generation);
    retiredFilenames.add(record.retiredFilename);
    return record;
  });
  return Object.freeze(records);
}

function decodeManifestSnapshot(
  value: string,
  canonicalPath: string,
): StableProjectionManifestSnapshot {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (!decimal(source.directoryDevice) || !decimal(source.directoryInode)) return invalid();
  const directoryIdentity = Object.freeze({
    canonicalPath,
    device: source.directoryDevice,
    inode: source.directoryInode,
  });
  if (source.state === "missing") {
    if (Reflect.ownKeys(source).length !== 3) return invalid();
    return Object.freeze({ state: "missing", directoryIdentity });
  }
  if (
    source.state !== "present"
    || Reflect.ownKeys(source).length !== 8
    || !decimal(source.device)
    || !decimal(source.inode)
    || !decimal(source.size)
    || BigInt(source.size) > BigInt(MAX_STABLE_MANIFEST_BYTES)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
    || typeof source.bytesBase64 !== "string"
  ) return invalid();
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== source.bytesBase64
    || BigInt(bytes.byteLength) !== BigInt(source.size)
    || createHash("sha256").update(bytes).digest("hex") !== source.sha256
  ) return invalid();
  return Object.freeze({
    state: "present",
    directoryIdentity,
    fileIdentity: Object.freeze({
      device: source.device,
      inode: source.inode,
      size: source.size,
      sha256: source.sha256,
    }),
    bytesBase64: source.bytesBase64,
  });
}

export const filesystemStableProjectionDirectoryOperations:
StableProjectionDirectoryOperations = Object.freeze({
  capture: captureProjectionDirectoryIdentity,
  cleanupKnownTemps(directory: string, identity: ProjectionDirectoryIdentity): void {
    if (runStableMutation("cleanup", directory, identity) !== "cleaned") return invalid();
  },
  assertGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): void {
    if (runStableMutation("assert-generation", directory, identity, [filename]) !== "present") {
      return invalid();
    }
  },
  reserveReconciliationJournal(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    minimumGeneration: number,
  ): number {
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0 || minimumGeneration > 2_147_483_647) {
      return invalid();
    }
    const result = runStableMutation(
      "reserve-reconciliation-journal",
      directory,
      identity,
      [lockToken, String(minimumGeneration)],
    );
    if (!decimal(result) || Number(result) > 2_147_483_647) return invalid();
    return Number(result);
  },
  beginReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
  ): V2RetirementIntent {
    const validated = decodeRetirementRecord(intent);
    if (validated.state !== "intent") return invalid();
    const result = decodeRetirementRecordText(runStableMutation(
      "begin-reconciliation-retirement",
      directory,
      identity,
      [lockToken, JSON.stringify(validated)],
    ));
    if (result.state !== "intent" || JSON.stringify(result) !== JSON.stringify(validated)) {
      return invalid();
    }
    return result;
  },
  completeReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
    image: V2RetirementImage,
  ): V2RetiredGeneration {
    const validatedIntent = decodeRetirementRecord(intent);
    if (validatedIntent.state !== "intent") return invalid();
    const validatedImage = decodeRetirementImage(image);
    const result = decodeRetirementRecordText(runStableMutation(
      "complete-reconciliation-retirement",
      directory,
      identity,
      [lockToken, JSON.stringify(validatedIntent), JSON.stringify(validatedImage)],
    ));
    if (
      result.state !== "retired"
      || result.generation !== validatedIntent.generation
      || result.retiredFilename !== validatedIntent.retiredFilename
      || JSON.stringify(result.image) !== JSON.stringify(validatedImage)
    ) return invalid();
    return result;
  },
  readReconciliationRetirements(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): readonly (V2RetirementIntent | V2RetiredGeneration)[] {
    return decodeReconciliationRetirements(runStableMutation(
      "read-reconciliation-retirements",
      directory,
      identity,
      [lockToken],
    ));
  },
  readGenerationImage(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    filename: string,
  ): StableProjectionGenerationImage {
    return decodeGenerationImage(runStableMutation(
      "read-generation-image",
      directory,
      identity,
      [lockToken, filename],
    ));
  },
  retireGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    expected: StableProjectionGenerationIdentity,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity {
    if (!/^projections-[23]-[1-9][0-9]{0,9}\.sqlite$/u.test(expected.filename)
      || expected.filename.split("-")[1] !== retiredFilename.split("-")[1]) return invalid();
    if (!/^\.projections-[23]-retired-[0-9a-f]{32}\.sqlite$/u.test(retiredFilename)) return invalid();
    const result = runStableMutation("retire-generation", directory, identity, [
      lockToken,
      expected.filename,
      retiredFilename,
      expected.device,
      expected.inode,
      expected.size,
      expected.ctimeNs,
      expected.sha256,
    ]);
    return decodeRetiredGeneration(result);
  },
  captureRetiredGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity | null {
    if (!/^\.projections-[23]-retired-[0-9a-f]{32}\.sqlite$/u.test(retiredFilename)) return invalid();
    const result = runStableMutation(
      "capture-retired-generation",
      directory,
      identity,
      [lockToken, retiredFilename],
    );
    return result === "null" ? null : decodeRetiredGeneration(result);
  },
  installGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    temporaryFilename: string,
    finalFilename: string,
    expected: StableProjectionGenerationIdentity,
  ): "installed" | "superseded" {
    const result = runStableMutation("install-generation", directory, identity, [
      lockToken,
      temporaryFilename,
      finalFilename,
      expected.device,
      expected.inode,
      expected.size,
      expected.sha256,
    ]);
    if (result !== "installed" && result !== "superseded") return invalid();
    return result;
  },
  captureManifest(
    directory: string,
    identity: ProjectionDirectoryIdentity,
  ): StableProjectionManifestSnapshot {
    return decodeManifestSnapshot(
      runStableMutation("capture-manifest", directory, identity),
      identity.canonicalPath,
    );
  },
  acquireManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "acquired" | "busy" {
    const result = runStableMutation("acquire-manifest-lock", directory, identity, [lockToken]);
    if (result !== "acquired" && result !== "busy") return invalid();
    return result;
  },
  prepareManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "prepared" | "superseded" | "poisoned" {
    if (!sameProjectionDirectoryIdentity(identity, expected.directoryIdentity)) return invalid();
    const result = runStableMutation("prepare-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(expected),
    ]);
    if (result !== "prepared" && result !== "superseded" && result !== "poisoned") {
      return invalid();
    }
    return result;
  },
  installManifestIfExpected(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "installed" | "superseded" | "poisoned" {
    if (!sameProjectionDirectoryIdentity(identity, expected.directoryIdentity)) return invalid();
    const result = runStableMutation("install-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(expected),
    ]);
    if (result !== "installed" && result !== "superseded" && result !== "poisoned") {
      return invalid();
    }
    return result;
  },
  commitManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    attempted: StableProjectionManifestContentIdentity,
  ): "committed" | "poisoned" {
    if (
      !sameProjectionDirectoryIdentity(identity, previous.directoryIdentity)
      || !decimal(attempted.size)
      || BigInt(attempted.size) > BigInt(MAX_STABLE_MANIFEST_BYTES)
      || !/^[0-9a-f]{64}$/u.test(attempted.sha256)
    ) return invalid();
    const result = runStableMutation("commit-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(previous),
      attempted.size,
      attempted.sha256,
    ]);
    if (result !== "committed" && result !== "poisoned") return invalid();
    return result;
  },
  rollbackManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    installed: Extract<StableProjectionManifestSnapshot, { readonly state: "present" }>,
  ): "restored" | "removed" | "superseded" | "poisoned" {
    if (
      !sameProjectionDirectoryIdentity(identity, previous.directoryIdentity)
      || !sameProjectionDirectoryIdentity(identity, installed.directoryIdentity)
    ) return invalid();
    const installedIdentity = snapshotIdentityArguments(installed);
    const result = runStableMutation("rollback-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(previous),
      ...installedIdentity.slice(1),
    ]);
    if (
      result !== "restored"
      && result !== "removed"
      && result !== "superseded"
      && result !== "poisoned"
    ) return invalid();
    return result;
  },
  releaseManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "released" | "poisoned" {
    const result = runStableMutation("release-manifest-lock", directory, identity, [lockToken]);
    if (result !== "released" && result !== "poisoned") return invalid();
    return result;
  },
});
