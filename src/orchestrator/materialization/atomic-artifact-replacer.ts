import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsyncDirectory, type DirectorySync } from "../identity/directory-durability.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
} from "../lifecycle/lifecycle-faults.js";

const DURABLE_FILE_MODE = 0o600;

export interface AtomicArtifactReplacementInput {
  readonly targetPath: string;
  readonly tempPath: string;
  readonly bytes: Uint8Array;
  readonly faultContext?: LifecycleFaultContext;
}

export interface AtomicArtifactFileOperations {
  readonly lstat: typeof lstatSync;
  readonly realpath: typeof realpathSync;
  readonly openExclusive: (path: string) => number;
  readonly write: (
    handle: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly fsync: typeof fsyncSync;
  readonly close: typeof closeSync;
  readonly rename: typeof renameSync;
  readonly unlink: typeof unlinkSync;
}

export interface AtomicArtifactReplacerOptions {
  readonly durableBase: string;
  readonly operations?: Partial<AtomicArtifactFileOperations>;
  readonly syncDirectory?: DirectorySync;
  readonly faultInjector?: LifecycleFaultInjector;
}

const defaultOperations: AtomicArtifactFileOperations = {
  lstat: lstatSync,
  realpath: realpathSync,
  openExclusive: (path) => openSync(path, "wx", DURABLE_FILE_MODE),
  write: (handle, buffer, offset, length, position) => writeSync(handle, buffer, offset, length, position),
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

function materializationConflict(): never {
  throw new LifecycleError("MATERIALIZATION_CONFLICT");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isPathSafetyError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EINVAL";
}

function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function contained(base: string, target: string): boolean {
  const pathFromBase = relative(base, target);
  return pathFromBase.length > 0
    && pathFromBase !== ".."
    && !pathFromBase.startsWith(`..${sep}`)
    && !isAbsolute(pathFromBase);
}

function samePath(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

export class AtomicArtifactReplacer {
  readonly #durableBase: string;
  readonly #durableBaseReal: string;
  readonly #operations: AtomicArtifactFileOperations;
  readonly #syncDirectory: DirectorySync;
  readonly #faults: LifecycleFaultInjector | undefined;

  constructor(options: AtomicArtifactReplacerOptions) {
    this.#operations = { ...defaultOperations, ...(options.operations ?? {}) };
    this.#syncDirectory = options.syncDirectory ?? ((path) => fsyncDirectory(path));
    this.#faults = options.faultInjector;
    const durableBase = normalized(options.durableBase);
    try {
      const stat = this.#operations.lstat(durableBase);
      if (!stat.isDirectory() || stat.isSymbolicLink()) materializationConflict();
      this.#durableBaseReal = normalized(this.#operations.realpath(durableBase));
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (isPathSafetyError(error)) materializationConflict();
      throw error;
    }
    this.#durableBase = durableBase;
  }

  replace(input: AtomicArtifactReplacementInput): void {
    const paths = this.#validateInput(input);
    const hit = (
      point: "before-temp-write" | "after-temp-fsync-before-replace" | "after-replace-before-ack",
    ): void => {
      if (this.#faults === undefined) return;
      if (input.faultContext === undefined) materializationConflict();
      this.#faults.hit("temporary-file-write", point, input.faultContext);
    };
    let handle: number | undefined;
    let renamed = false;
    let bytes: Buffer | undefined;
    try {
      hit("before-temp-write");
      handle = this.#operations.openExclusive(paths.tempPath);
      bytes = Buffer.from(input.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const remaining = bytes.length - offset;
        const written = this.#operations.write(handle, bytes, offset, remaining, offset);
        if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
          materializationConflict();
        }
        offset += written;
      }
      this.#operations.fsync(handle);
      hit("after-temp-fsync-before-replace");
      this.#operations.close(handle);
      handle = undefined;
      this.#operations.rename(paths.tempPath, paths.targetPath);
      renamed = true;
      if (this.#faults !== undefined) {
        if (input.faultContext === undefined) materializationConflict();
        this.#faults.hit("artifact-replace", "after-replace-before-ack", input.faultContext);
      }
      this.#syncDirectory(paths.parentPath);
    } catch (error) {
      if (handle !== undefined) {
        try {
          this.#operations.close(handle);
        } catch {
          // Preserve the first failure; the handle is no longer usable here.
        }
      }
      if (!renamed) this.#removeKnownTemp(paths.tempPath);
      throw error;
    } finally {
      bytes?.fill(0);
    }
  }

  cleanup(input: Pick<AtomicArtifactReplacementInput, "targetPath" | "tempPath">): void {
    const paths = this.#validateInput({ ...input, bytes: new Uint8Array(0) });
    this.#removeKnownTemp(paths.tempPath);
  }

  #validateInput(input: AtomicArtifactReplacementInput): {
    readonly targetPath: string;
    readonly tempPath: string;
    readonly parentPath: string;
  } {
    if (
      typeof input !== "object"
      || input === null
      || typeof input.targetPath !== "string"
      || typeof input.tempPath !== "string"
      || !(input.bytes instanceof Uint8Array)
      || !isAbsolute(input.targetPath)
      || !isAbsolute(input.tempPath)
    ) materializationConflict();
    const targetPath = normalized(input.targetPath);
    const tempPath = normalized(input.tempPath);
    const parentPath = dirname(targetPath);
    if (
      !contained(this.#durableBase, targetPath)
      || !contained(this.#durableBase, tempPath)
      || !samePath(parentPath, dirname(tempPath))
    ) materializationConflict();
    this.#assertExistingDirectory(parentPath);
    this.#assertNoSymlinkComponents(parentPath);
    this.#assertExistingTarget(targetPath);
    return { targetPath, tempPath, parentPath };
  }

  #assertExistingDirectory(path: string): void {
    try {
      const stat = this.#operations.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) materializationConflict();
      const realPath = normalized(this.#operations.realpath(path));
      if (!contained(this.#durableBaseReal, realPath) && !samePath(this.#durableBaseReal, realPath)) {
        materializationConflict();
      }
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (isPathSafetyError(error)) materializationConflict();
      throw error;
    }
  }

  #assertNoSymlinkComponents(path: string): void {
    const pathFromBase = relative(this.#durableBase, path);
    let cursor = this.#durableBase;
    for (const part of pathFromBase.split(sep).filter((value) => value.length > 0)) {
      cursor = join(cursor, part);
      try {
        const stat = this.#operations.lstat(cursor);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !samePath(cursor, path))) {
          materializationConflict();
        }
      } catch (error) {
        if (error instanceof LifecycleError) throw error;
        if (isPathSafetyError(error)) materializationConflict();
        throw error;
      }
    }
  }

  #assertExistingTarget(path: string): void {
    try {
      const stat = this.#operations.lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) materializationConflict();
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof LifecycleError) throw error;
        if (isPathSafetyError(error)) materializationConflict();
        throw error;
      }
    }
  }

  #removeKnownTemp(path: string): void {
    try {
      const stat = this.#operations.lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) materializationConflict();
      this.#operations.unlink(path);
    } catch (error) {
      if (isNotFound(error)) return;
      if (error instanceof LifecycleError) throw error;
      throw error;
    }
  }
}
