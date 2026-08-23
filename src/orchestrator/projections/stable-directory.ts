import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

const MUTATION_TIMEOUT_MS = 5_000;
const MUTATION_SCRIPT = String.raw`
"use strict";
const { lstatSync, realpathSync, readdirSync, unlinkSync } = require("node:fs");
const { basename, resolve } = require("node:path");
const [operation, expectedPath, expectedDevice, expectedInode, filename] = process.argv.slice(1);
const normalized = (path) => {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const invalid = () => { throw new Error("PROJECTION_PATH_INVALID"); };
try {
  const directory = lstatSync(".", { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) invalid();
  if (
    normalized(realpathSync.native(".")) !== normalized(expectedPath)
    || directory.dev.toString() !== expectedDevice
    || directory.ino.toString() !== expectedInode
  ) invalid();
  if (operation === "cleanup") {
    const generationTemp = /^\.projections-1-[1-9][0-9]{0,9}\.sqlite\.tmp(?:-(?:wal|shm))?$/u;
    for (const name of readdirSync(".")) {
      if (name !== ".projection-manifest.json.tmp" && !generationTemp.test(name)) continue;
      const entry = lstatSync(name);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      unlinkSync(name);
    }
    process.stdout.write("cleaned");
  } else if (operation === "assert-generation" || operation === "unlink-generation") {
    if (
      typeof filename !== "string"
      || basename(filename) !== filename
      || !/^projections-1-[1-9][0-9]{0,9}\.sqlite$/u.test(filename)
    ) invalid();
    try {
      const entry = lstatSync(filename);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      if (operation === "unlink-generation") {
        unlinkSync(filename);
        process.stdout.write("removed");
      } else process.stdout.write("present");
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

export interface StableProjectionDirectoryOperations {
  capture(directory: string): ProjectionDirectoryIdentity;
  cleanupKnownTemps(directory: string, identity: ProjectionDirectoryIdentity): void;
  assertGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): void;
  unlinkGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): "removed" | "missing";
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
  operation: "cleanup" | "assert-generation" | "unlink-generation",
  directory: string,
  identity: ProjectionDirectoryIdentity,
  filename?: string,
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
      ...(filename === undefined ? [] : [filename]),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 1_024,
      timeout: MUTATION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error !== undefined) return invalid(result.error ?? result.stderr);
  return result.stdout;
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
    if (runStableMutation("assert-generation", directory, identity, filename) !== "present") {
      return invalid();
    }
  },
  unlinkGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): "removed" | "missing" {
    const result = runStableMutation("unlink-generation", directory, identity, filename);
    if (result !== "removed" && result !== "missing") return invalid();
    return result;
  },
});
