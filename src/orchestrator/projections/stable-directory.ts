import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import { LifecycleError } from "../lifecycle/errors.js";

const MUTATION_TIMEOUT_MS = 5_000;
const MAX_STABLE_MANIFEST_BYTES = 64 * 1_024;
const MUTATION_SCRIPT = String.raw`
"use strict";
const { createHash } = require("node:crypto");
const {
  closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, readdirSync, unlinkSync,
} = require("node:fs");
const { basename, resolve } = require("node:path");
const [
  operation, expectedPath, expectedDevice, expectedInode, filename,
  expectedManifestDevice, expectedManifestInode, expectedManifestSize,
  expectedManifestSha256,
] = process.argv.slice(1);
const MAX_MANIFEST_BYTES = ${String(MAX_STABLE_MANIFEST_BYTES)};
const normalized = (path) => {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const invalid = () => { throw new Error("PROJECTION_PATH_INVALID"); };
const integrity = () => { throw new Error("INTEGRITY_FAILURE"); };
const assertDirectory = () => {
  const directory = lstatSync(".", { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) invalid();
  if (
    normalized(realpathSync.native(".")) !== normalized(expectedPath)
    || directory.dev.toString() !== expectedDevice
    || directory.ino.toString() !== expectedInode
  ) invalid();
  return directory;
};
const captureManifest = () => {
  const manifestName = "projection-manifest.json";
  let before;
  try {
    before = lstatSync(manifestName, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const directory = assertDirectory();
      return {
        state: "missing",
        directoryDevice: directory.dev.toString(),
        directoryInode: directory.ino.toString(),
      };
    }
    throw error;
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size < 0n
    || before.size > BigInt(MAX_MANIFEST_BYTES)
  ) invalid();
  let handle;
  try {
    handle = openSync(manifestName, "r");
    const opened = fstatSync(handle, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) invalid();
    const bytes = readFileSync(handle);
    const openedAfter = fstatSync(handle, { bigint: true });
    const after = lstatSync(manifestName, { bigint: true });
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
    ) invalid();
    const directory = assertDirectory();
    return {
      state: "present",
      directoryDevice: directory.dev.toString(),
      directoryInode: directory.ino.toString(),
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
  let handle;
  try {
    handle = openSync(".", "r");
    fsyncSync(handle);
  } catch (error) {
    const code = error && error.code;
    if (
      code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP"
      && code !== "EOPNOTSUPP"
      && !(process.platform === "win32" && (code === "EACCES" || code === "EBADF" || code === "EPERM"))
    ) throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
};
const sidecarPresent = (name) => {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      lstatSync(name + suffix);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      integrity();
    }
  }
  return false;
};
try {
  assertDirectory();
  if (operation === "cleanup") {
    const generationTemp = /^\.projections-1-[1-9][0-9]{0,9}\.sqlite\.tmp(?:-(?:wal|shm))?$/u;
    for (const name of readdirSync(".")) {
      if (name !== ".projection-manifest.json.tmp" && !generationTemp.test(name)) continue;
      const entry = lstatSync(name);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      unlinkSync(name);
    }
    process.stdout.write("cleaned");
  } else if (operation === "capture-manifest") {
    process.stdout.write(JSON.stringify(captureManifest()));
  } else if (operation === "remove-manifest-if-matches") {
    const snapshot = captureManifest();
    if (snapshot.state === "missing") process.stdout.write("missing");
    else if (
      snapshot.device !== expectedManifestDevice
      || snapshot.inode !== expectedManifestInode
      || snapshot.size !== expectedManifestSize
      || snapshot.sha256 !== expectedManifestSha256
    ) process.stdout.write("changed");
    else {
      unlinkSync("projection-manifest.json");
      syncDirectory();
      assertDirectory();
      try {
        lstatSync("projection-manifest.json");
        process.stdout.write("changed");
      } catch (error) {
        if (error && error.code === "ENOENT") process.stdout.write("removed");
        else throw error;
      }
    }
  } else if (operation === "assert-generation") {
    if (
      typeof filename !== "string"
      || basename(filename) !== filename
      || !/^projections-1-[1-9][0-9]{0,9}\.sqlite$/u.test(filename)
    ) invalid();
    if (sidecarPresent(filename)) integrity();
    try {
      const entry = lstatSync(filename);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      process.stdout.write("present");
    } catch (error) {
      if (error && error.code === "ENOENT") process.stdout.write("missing");
      else throw error;
    }
  } else invalid();
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "PROJECTION_PATH_INVALID");
  process.exitCode = 2;
}
`;

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
  captureManifest(
    directory: string,
    identity: ProjectionDirectoryIdentity,
  ): StableProjectionManifestSnapshot;
  removeManifestIfMatches(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    expected: Extract<StableProjectionManifestSnapshot, { readonly state: "present" }>,
  ): "removed" | "changed" | "missing";
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
  operation: "cleanup" | "assert-generation" | "capture-manifest" | "remove-manifest-if-matches",
  directory: string,
  identity: ProjectionDirectoryIdentity,
  argumentsAfterIdentity: readonly string[] = [],
): string {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      MUTATION_SCRIPT,
      operation,
      identity.canonicalPath,
      identity.device,
      identity.inode,
      ...argumentsAfterIdentity,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: (MAX_STABLE_MANIFEST_BYTES * 2) + 4_096,
      timeout: MUTATION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    if (result.error === undefined && result.stderr === "INTEGRITY_FAILURE") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    return invalid(result.error ?? result.stderr);
  }
  return result.stdout;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
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
  captureManifest(
    directory: string,
    identity: ProjectionDirectoryIdentity,
  ): StableProjectionManifestSnapshot {
    return decodeManifestSnapshot(
      runStableMutation("capture-manifest", directory, identity),
      identity.canonicalPath,
    );
  },
  removeManifestIfMatches(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    expected: Extract<StableProjectionManifestSnapshot, { readonly state: "present" }>,
  ): "removed" | "changed" | "missing" {
    if (!sameProjectionDirectoryIdentity(identity, expected.directoryIdentity)) return invalid();
    const result = runStableMutation("remove-manifest-if-matches", directory, identity, [
      "projection-manifest.json",
      expected.fileIdentity.device,
      expected.fileIdentity.inode,
      expected.fileIdentity.size,
      expected.fileIdentity.sha256,
    ]);
    if (result !== "removed" && result !== "changed" && result !== "missing") return invalid();
    return result;
  },
});
