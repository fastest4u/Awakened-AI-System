import * as nativeFs from "node:fs";
import { createHash } from "node:crypto";
import { basename as pathBasename, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AtomicArtifactReplacer, type AtomicArtifactFileOperations } from "./atomic-artifact-replacer.js";

export interface CompatibilityFileIdentity { readonly device: string; readonly inode: string; }
export interface StableCompatibilityRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly operation: "prepare" | "publish" | "verify";
  readonly parentPath: string;
  readonly parentIdentity: CompatibilityFileIdentity;
  readonly forbiddenIdentities: readonly CompatibilityFileIdentity[];
  readonly basename: string;
  readonly attemptToken: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly bytesBase64: string | null;
}
export interface StableCompatibilityResponse {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly operation: StableCompatibilityRequest["operation"];
  readonly state: "prepared" | "published" | "verified";
  readonly identity: CompatibilityFileIdentity;
  readonly byteLength: number;
  readonly contentSha256: string;
}
export type CompatibilityWorkerOperations = Pick<typeof nativeFs,
  "lstatSync" | "fstatSync" | "realpathSync" | "openSync" | "readFileSync" | "writeSync" |
  "fsyncSync" | "closeSync" | "mkdirSync" | "renameSync" | "unlinkSync">;

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const identity = (stat: nativeFs.BigIntStats): CompatibilityFileIdentity => Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
const same = (a: CompatibilityFileIdentity, b: CompatibilityFileIdentity) => a.device === b.device && a.inode === b.inode;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("COMPATIBILITY_INTEGRITY_FAILURE"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(k => !keys.includes(k))) invalid();
  return value as Record<string, unknown>;
}
function checkedIdentity(value: unknown): CompatibilityFileIdentity {
  const v = exact(value, ["device", "inode"]);
  if (typeof v.device !== "string" || typeof v.inode !== "string" || !/^\d{1,30}$/.test(v.device) || !/^\d{1,30}$/.test(v.inode)) invalid();
  return { device: v.device, inode: v.inode };
}
function basename(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || /[\\/:\x00-\x1f<>"|?*]/.test(value)
    || value === "." || value === ".." || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) invalid();
  return value;
}
function request(value: unknown): StableCompatibilityRequest {
  const v = exact(value, ["schemaVersion", "requestId", "operation", "parentPath", "parentIdentity", "forbiddenIdentities",
    "basename", "attemptToken", "byteLength", "contentSha256", "bytesBase64"]);
  if (v.schemaVersion !== 1 || typeof v.requestId !== "string" || !TOKEN.test(v.requestId)
    || !["prepare", "publish", "verify"].includes(String(v.operation)) || typeof v.parentPath !== "string"
    || !isAbsolute(v.parentPath) || normalize(v.parentPath) !== v.parentPath || v.parentPath.length > 32768
    || typeof v.attemptToken !== "string" || !TOKEN.test(v.attemptToken)
    || !Number.isSafeInteger(v.byteLength) || Number(v.byteLength) < 0 || Number(v.byteLength) > MAX_ARTIFACT_BYTES
    || typeof v.contentSha256 !== "string" || !HASH.test(v.contentSha256)
    || !Array.isArray(v.forbiddenIdentities) || v.forbiddenIdentities.length > 32) invalid();
  const parentIdentity = checkedIdentity(v.parentIdentity), forbiddenIdentities = v.forbiddenIdentities.map(checkedIdentity);
  const name = basename(v.basename);
  if (name === `.v2-compat-${v.attemptToken}.tmp`) invalid();
  if (v.operation === "publish") {
    if (typeof v.bytesBase64 !== "string" || v.bytesBase64.length > MAX_MESSAGE_BYTES) invalid();
    const bytes = Buffer.from(v.bytesBase64, "base64");
    if (bytes.toString("base64") !== v.bytesBase64 || bytes.length !== v.byteLength || digest(bytes) !== v.contentSha256) invalid();
    bytes.fill(0);
  } else if (v.bytesBase64 !== null) invalid();
  if (v.operation === "prepare" && (v.byteLength !== 0 || v.contentSha256 !== "0".repeat(64))) invalid();
  return { ...v, parentIdentity, forbiddenIdentities, basename: name } as unknown as StableCompatibilityRequest;
}

/** Runs only in a child whose cwd was pinned at spawn. All entry mutations use single relative basenames.
 * The migration owner controls this directory; this is not atomic leaf CAS against arbitrary host actors. */
export function executeStableCompatibilityRequest(input: unknown,
  fs: CompatibilityWorkerOperations = nativeFs): StableCompatibilityResponse {
  const req = request(input);
  let parentFd: number | undefined, tempFd: number | undefined, retainedTempFd: number | undefined;
  let ownedTemp: CompatibilityFileIdentity | undefined;
  let failed = false;
  const temporary = `.v2-compat-${req.attemptToken}.tmp`;
  const virtualBase = key(req.parentPath), virtualTarget = key(join(req.parentPath, req.basename)), virtualTemp = key(join(req.parentPath, temporary));
  const paths = (path: nativeFs.PathLike): string => {
    if (typeof path !== "string") invalid();
    const mapped = key(path);
    if (mapped === virtualBase) return ".";
    if (mapped === virtualTarget) return req.basename;
    if (mapped === virtualTemp) return temporary;
    invalid();
  };
  const directory = () => {
    const stat = fs.lstatSync(".", { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(identity(stat), req.parentIdentity)
      || req.forbiddenIdentities.some(value => same(value, identity(stat)))) invalid();
    if (parentFd !== undefined) {
      const opened = fs.fstatSync(parentFd, { bigint: true });
      if (!opened.isDirectory() || !same(identity(opened), req.parentIdentity)) invalid();
    }
    return stat;
  };
  const regular = (name: string, expected?: CompatibilityFileIdentity) => {
    const stat = fs.lstatSync(name, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 0n || stat.size > BigInt(MAX_ARTIFACT_BYTES)
      || req.forbiddenIdentities.some(value => same(value, identity(stat))) || (expected && !same(expected, identity(stat)))) invalid();
    const canonical = String(fs.realpathSync.native(name));
    if (pathBasename(canonical) !== name || key(canonical) !== key(join(req.parentPath, name))) invalid();
    return stat;
  };
  const descriptor = (fd: number, name: string, expected: CompatibilityFileIdentity) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !same(expected, identity(stat))) invalid();
    const leaf = regular(name, expected);
    if (leaf.size !== stat.size) invalid();
    return stat;
  };
  const flushParent = () => { directory(); fs.fsyncSync(parentFd!); directory(); };
  const verify = (): CompatibilityFileIdentity | null => {
    let stat: nativeFs.BigIntStats;
    try { stat = regular(req.basename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    }
    const expected = identity(stat);
    let fd: number | undefined;
    try {
      // Windows FlushFileBuffers needs write access; this descriptor never reaches a data-write API.
      fd = fs.openSync(req.basename, process.platform === "win32" ? "r+" : "r");
      descriptor(fd, req.basename, expected);
      const bytes = fs.readFileSync(fd);
      try { if (bytes.length !== req.byteLength || digest(bytes) !== req.contentSha256) invalid(); }
      finally { bytes.fill(0); }
      descriptor(fd, req.basename, expected); directory(); fs.fsyncSync(fd);
      descriptor(fd, req.basename, expected); flushParent();
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    regular(req.basename, expected); directory();
    return expected;
  };
  try {
    directory();
    if (key(resolve(String(fs.realpathSync.native(".")))) !== key(req.parentPath)) invalid();
    parentFd = fs.openSync(".", process.platform === "win32" ? "r+" : "r");
    directory();
    if (req.operation === "prepare") {
      let stat: nativeFs.BigIntStats;
      try { stat = fs.lstatSync(req.basename, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        directory(); fs.mkdirSync(req.basename, { recursive: false, mode: 0o700 }); flushParent();
        stat = fs.lstatSync(req.basename, { bigint: true });
      }
      const canonical = String(fs.realpathSync.native(req.basename));
      if (!stat.isDirectory() || stat.isSymbolicLink() || req.forbiddenIdentities.some(value => same(value, identity(stat)))
        || key(resolve(canonical)) !== key(join(req.parentPath, req.basename)) || pathBasename(canonical) !== req.basename) invalid();
      flushParent();
      return Object.freeze({ schemaVersion: 1, requestId: req.requestId, operation: req.operation, state: "prepared",
        identity: identity(stat), byteLength: 0, contentSha256: req.contentSha256 });
    }
    const installed = verify();
    if (installed !== null) return Object.freeze({ schemaVersion: 1, requestId: req.requestId, operation: req.operation,
      state: "verified", identity: installed, byteLength: req.byteLength, contentSha256: req.contentSha256 });
    if (req.operation === "verify") invalid();
    const operations: AtomicArtifactFileOperations = {
      lstat: ((path: nativeFs.PathLike, options?: { bigint?: boolean }) => fs.lstatSync(paths(path), options as { bigint: true })) as typeof nativeFs.lstatSync,
      realpath: ((path: nativeFs.PathLike) => { const name = paths(path); if (name !== ".") invalid(); directory(); return virtualBase; }) as typeof nativeFs.realpathSync,
      openExclusive(path) {
        if (paths(path) !== temporary) invalid(); directory();
        tempFd = fs.openSync(temporary, "wx", 0o600);
        const opened = fs.fstatSync(tempFd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n) invalid();
        ownedTemp = identity(opened); descriptor(tempFd, temporary, ownedTemp);
        return tempFd;
      },
      write(fd, bytes, offset, length, position) {
        if (fd !== tempFd || ownedTemp === undefined) invalid();
        directory(); descriptor(fd, temporary, ownedTemp);
        const written = fs.writeSync(fd, bytes, offset, length, position);
        descriptor(fd, temporary, ownedTemp); return written;
      },
      fsync(fd) {
        if (fd !== tempFd || ownedTemp === undefined) invalid(); descriptor(fd, temporary, ownedTemp);
        fs.fsyncSync(fd); descriptor(fd, temporary, ownedTemp);
      },
      close(fd) {
        if (fd !== tempFd || ownedTemp === undefined) invalid();
        try {
          descriptor(fd, temporary, ownedTemp);
          retainedTempFd = fs.openSync(temporary, "r"); descriptor(retainedTempFd, temporary, ownedTemp);
          fs.closeSync(fd); tempFd = undefined;
        } catch (error) { failed = true; throw error; }
      },
      rename(from, to) {
        if (paths(from) !== temporary || paths(to) !== req.basename || !ownedTemp || retainedTempFd === undefined) invalid();
        directory(); descriptor(retainedTempFd, temporary, ownedTemp);
        // A new attempt may publish only to an absent target. Matching existing bytes reconcile above.
        try { fs.lstatSync(req.basename); invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const bytes = fs.readFileSync(retainedTempFd);
        try { if (bytes.length !== req.byteLength || digest(bytes) !== req.contentSha256) invalid(); } finally { bytes.fill(0); }
        descriptor(retainedTempFd, temporary, ownedTemp); fs.renameSync(temporary, req.basename);
        descriptor(retainedTempFd, req.basename, ownedTemp); directory();
      },
      unlink(path) {
        if (paths(path) !== temporary || !ownedTemp || failed) invalid();
        directory(); regular(temporary, ownedTemp);
        if (tempFd !== undefined) descriptor(tempFd, temporary, ownedTemp);
        if (retainedTempFd !== undefined) descriptor(retainedTempFd, temporary, ownedTemp);
        fs.unlinkSync(temporary); flushParent();
      },
    };
    const bytes = Buffer.from(req.bytesBase64!, "base64");
    try { new AtomicArtifactReplacer({ durableBase: virtualBase, operations, syncDirectory: path => {
      if (paths(path) !== ".") invalid(); flushParent();
    } }).replace({ targetPath: virtualTarget, tempPath: virtualTemp, bytes }); }
    finally { bytes.fill(0); }
    if (failed) invalid();
    const finalIdentity = verify(); if (finalIdentity === null || !ownedTemp || !same(finalIdentity, ownedTemp)) invalid();
    return Object.freeze({ schemaVersion: 1, requestId: req.requestId, operation: req.operation, state: "published",
      identity: finalIdentity, byteLength: req.byteLength, contentSha256: req.contentSha256 });
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "COMPATIBILITY_INTEGRITY_FAILURE"
      ? "COMPATIBILITY_INTEGRITY_FAILURE" : "MIGRATION_OUTCOME_UNKNOWN");
  } finally {
    let closeFailed = false;
    for (const fd of [tempFd, retainedTempFd, parentFd]) if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { closeFailed = true; }
    }
    if (closeFailed) throw new Error("MIGRATION_OUTCOME_UNKNOWN");
  }
}

async function main(): Promise<void> {
  let bytes = 0; const chunks: Buffer[] = []; let requestId: string | null = null;
  try {
    for await (const chunk of process.stdin) {
      bytes += (chunk as Buffer).length; if (bytes > MAX_MESSAGE_BYTES) invalid(); chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8"); const input: unknown = JSON.parse(text);
    const req = request(input); requestId = req.requestId;
    process.stdout.write(JSON.stringify(executeStableCompatibilityRequest(req)));
  } catch (error) {
    const code = requestId !== null && error instanceof Error && error.message === "MIGRATION_OUTCOME_UNKNOWN"
      ? "MIGRATION_OUTCOME_UNKNOWN" : "COMPATIBILITY_INTEGRITY_FAILURE";
    process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId, code }));
    process.exitCode = 1;
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
if (process.argv[2] === "--stable-compatibility-worker" && process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main();
