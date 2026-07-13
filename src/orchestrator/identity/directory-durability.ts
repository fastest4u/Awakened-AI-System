import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type DirectorySync = (path: string) => void;

export interface DirectoryFsyncOperations {
  platform: NodeJS.Platform;
  openDirectory: (path: string) => number;
  fsync: (handle: number) => void;
  close: (handle: number) => void;
}

const defaultOperations: DirectoryFsyncOperations = {
  platform: process.platform,
  openDirectory: (path) => openSync(path, "r"),
  fsync: fsyncSync,
  close: closeSync,
};

const portableUnsupportedCodes = new Set([
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EOPNOTSUPP",
]);
const windowsUnsupportedCodes = new Set(["EACCES", "EBADF", "EPERM"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function unsupportedDirectoryFsync(error: unknown, platform: NodeJS.Platform): boolean {
  const code = errorCode(error);
  return code !== undefined
    && (portableUnsupportedCodes.has(code)
      || (platform === "win32" && windowsUnsupportedCodes.has(code)));
}

export function fsyncDirectory(
  path: string,
  operations: DirectoryFsyncOperations = defaultOperations,
): void {
  let handle: number | undefined;
  try {
    handle = operations.openDirectory(path);
    operations.fsync(handle);
  } catch (error) {
    if (!unsupportedDirectoryFsync(error, operations.platform)) throw error;
  } finally {
    if (handle !== undefined) operations.close(handle);
  }
}

export function createDirectoryDurably(
  path: string,
  durableBase: string,
  syncDirectory: DirectorySync,
): void {
  const target = resolve(path);
  const base = resolve(durableBase);
  const pathFromBase = relative(base, target);
  if (
    pathFromBase === ".."
    || pathFromBase.startsWith(`..${sep}`)
    || isAbsolute(pathFromBase)
  ) {
    throw new Error("DIRECTORY_OUTSIDE_DURABLE_BASE");
  }

  const entryParents: string[] = [];
  let cursor = target;
  while (process.platform === "win32"
    ? cursor.toLowerCase() !== base.toLowerCase()
    : cursor !== base) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("DIRECTORY_OUTSIDE_DURABLE_BASE");
    entryParents.push(parent);
    cursor = parent;
  }

  mkdirSync(target, { recursive: true });
  for (const parent of entryParents.reverse()) syncDirectory(parent);
}
