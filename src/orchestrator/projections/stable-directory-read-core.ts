import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, readdirSync, unlinkSync, writeSync, type BigIntStats,
} from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { LifecycleError } from "../lifecycle/errors.js";
import type {
  ProjectionDirectoryIdentity, StableProjectionManifestSnapshot, StableProjectionGenerationImage,
} from "./stable-directory.js";

const MANIFEST = "projection-manifest.json";
const LOCK = ".projection-manifest.publish.lock";
const MAX_MANIFEST_BYTES = 64 * 1024;
const TOKEN = /^[0-9a-f]{32}$/u;
const GENERATION = /^projections-[23]-([1-9][0-9]{0,9})\.sqlite$/u;
const RETAINED = ["previous", "attempted", "displaced", "failed"]
  .map(kind => `.projection-manifest.${kind}-`);
type CwdManifestSnapshot = Extract<StableProjectionManifestSnapshot, { state: "missing" }>
  | (Extract<StableProjectionManifestSnapshot, { state: "present" }> & { readonly ctimeNs: string });

export interface CwdProjectionReadCore {
  assertDirectory(): void;
  captureManifest(): CwdManifestSnapshot;
  acquireLock(token: string): "acquired" | "busy";
  captureGeneration(token: string, filename: string, maximumBytes: number): StableProjectionGenerationImage;
  releaseOwnedLock(token: string, allowAbsent: boolean): "released" | "absent" | "poisoned";
}

function invalid(): never { throw new TypeError("PROJECTION_PATH_INVALID"); }
function integrity(): never { throw new LifecycleError("INTEGRITY_FAILURE"); }
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function assertToken(token: string): void {
  if (typeof token !== "string" || !TOKEN.test(token)) invalid();
}
function continuous(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev
    && before.ino === after.ino && before.size === after.size && before.ctimeNs === after.ctimeNs;
}
function syncDirectory(): void {
  let handle: number | undefined;
  try {
    handle = openSync(".", "r");
    fsyncSync(handle);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP" && code !== "EOPNOTSUPP"
      && !(process.platform === "win32" && (code === "EACCES" || code === "EBADF" || code === "EPERM"))) throw error;
  } finally { if (handle !== undefined) closeSync(handle); }
}

/** Runs inside a child whose cwd is fixed to one owned projection directory. */
export function createCwdProjectionReadCore(expected: ProjectionDirectoryIdentity): CwdProjectionReadCore {
  const directoryIdentity = Object.freeze({ canonicalPath: expected.canonicalPath, device: expected.device, inode: expected.inode });
  function assertDirectory(): void {
    if (!isAbsolute(directoryIdentity.canonicalPath) || normalize(directoryIdentity.canonicalPath) !== directoryIdentity.canonicalPath
      || resolve(directoryIdentity.canonicalPath) !== directoryIdentity.canonicalPath) invalid();
    const directory = lstatSync(".", { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || normalized(realpathSync.native(".")) !== normalized(directoryIdentity.canonicalPath)
      || directory.dev.toString() !== directoryIdentity.device || directory.ino.toString() !== directoryIdentity.inode) invalid();
  }
  function captureFile(name: string, maximumBytes: number) {
    let handle: number | undefined;
    try {
      const before = lstatSync(name, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size < 0n || before.size > BigInt(maximumBytes)) invalid();
      handle = openSync(name, "r");
      const opened = fstatSync(handle, { bigint: true });
      if (!continuous(before, opened)) invalid();
      const bytes = readFileSync(handle);
      const openedAfter = fstatSync(handle, { bigint: true });
      const after = lstatSync(name, { bigint: true });
      if (bytes.byteLength !== Number(before.size) || !continuous(opened, openedAfter) || !continuous(before, after)) invalid();
      assertDirectory();
      return { device: opened.dev.toString(), inode: opened.ino.toString(), size: opened.size.toString(),
        ctimeNs: opened.ctimeNs.toString(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
    } catch { return invalid(); }
    finally { if (handle !== undefined) closeSync(handle); }
  }
  function assertLock(token: string): void {
    if (captureFile(LOCK, MAX_MANIFEST_BYTES).bytes.toString("utf8") !== token) invalid();
  }
  function assertSidecarsAbsent(filename: string): void {
    for (const suffix of ["-wal", "-shm"]) {
      try { lstatSync(filename + suffix); }
      catch (error) { if (errorCode(error) === "ENOENT") continue; return integrity(); }
      integrity();
    }
  }
  return Object.freeze({
    assertDirectory,
    captureManifest(): CwdManifestSnapshot {
      assertDirectory();
      try { lstatSync(MANIFEST, { bigint: true }); }
      catch (error) {
        if (errorCode(error) !== "ENOENT") return invalid();
        assertDirectory();
        return Object.freeze({ state: "missing", directoryIdentity });
      }
      const image = captureFile(MANIFEST, MAX_MANIFEST_BYTES);
      return Object.freeze({ state: "present", directoryIdentity, ctimeNs: image.ctimeNs,
        fileIdentity: Object.freeze({ device: image.device, inode: image.inode, size: image.size, sha256: image.sha256 }),
        bytesBase64: image.bytes.toString("base64") });
    },
    acquireLock(token: string): "acquired" | "busy" {
      assertDirectory();
      assertToken(token);
      let handle: number;
      try { handle = openSync(LOCK, "wx", 0o600); }
      catch (error) { if (errorCode(error) === "EEXIST") return "busy"; throw error; }
      try {
        const bytes = Buffer.from(token, "utf8");
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(handle, bytes, offset, bytes.byteLength - offset, offset);
          if (!Number.isSafeInteger(written) || written <= 0) invalid();
          offset += written;
        }
        fsyncSync(handle);
      } finally { closeSync(handle); }
      syncDirectory();
      assertLock(token);
      return "acquired";
    },
    captureGeneration(token: string, filename: string, maximumBytes: number): StableProjectionGenerationImage {
      assertDirectory();
      assertToken(token);
      assertLock(token);
      if (typeof filename !== "string" || !GENERATION.test(filename)
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 64 * 1024 * 1024) invalid();
      assertSidecarsAbsent(filename);
      const image = captureFile(filename, maximumBytes);
      assertSidecarsAbsent(filename);
      assertLock(token);
      return Object.freeze({ identity: Object.freeze({ filename, device: image.device, inode: image.inode,
        size: image.size, ctimeNs: image.ctimeNs, sha256: image.sha256 }), bytes: image.bytes });
    },
    releaseOwnedLock(token: string, allowAbsent: boolean): "released" | "absent" | "poisoned" {
      assertDirectory();
      assertToken(token);
      // Only this initial lookup may mean absent. Later ENOENT is a continuity failure.
      try { lstatSync(LOCK, { bigint: true }); }
      catch (error) {
        if (!allowAbsent || errorCode(error) !== "ENOENT") return invalid();
        assertDirectory();
        return "absent";
      }
      assertLock(token);
      if (readdirSync(".").some(name => RETAINED.some(prefix => name.startsWith(prefix)))) return "poisoned";
      const entry = lstatSync(LOCK);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      unlinkSync(LOCK);
      syncDirectory();
      assertDirectory();
      return "released";
    },
  });
}
