import { randomUUID, createHash } from "node:crypto";
import { open, lstat, realpath, link, rename, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isAbsolute, normalize, join } from "node:path";
import type { ProjectionDirectoryIdentity } from "../projections/stable-directory.js";
import type { ReadLaunchIntent, ReadMessageIds, ReadOwnershipRecord } from "./contracts.js";

const NAME = "verified-read-owner.json";
const LIMIT = 8192;
function refused(): never { throw Object.assign(new Error("WORKER_UNAVAILABLE"), { code: "WORKER_UNAVAILABLE" }); }
function code(error: unknown): unknown { return (error as { code?: unknown } | null)?.code; }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refused();
  const actual = Reflect.ownKeys(value); if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) return refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return refused(); result[key] = descriptor.value; }
  return result;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || Buffer.byteLength(value) > maximum || value.includes("\0")) return refused(); return value;
}
function decodeIntent(value: unknown): ReadLaunchIntent {
  const input = exact(value, ["schemaVersion", "bindingFingerprint", "buildHash", "supervisorId", "ids", "lockToken"]);
  const ids = exact(input.ids, ["requestId", "attemptId", "laneEpoch"]);
  if (input.schemaVersion !== 1) return refused();
  const bindingFingerprint = text(input.bindingFingerprint, 64); const buildHash = text(input.buildHash, 64); const lockToken = text(input.lockToken, 32);
  if (!/^[0-9a-f]{64}$/u.test(bindingFingerprint) || !/^[0-9a-f]{64}$/u.test(buildHash) || !/^[0-9a-f]{32}$/u.test(lockToken)) return refused();
  return Object.freeze({ schemaVersion: 1, bindingFingerprint, buildHash, lockToken, supervisorId: text(input.supervisorId, 128),
    ids: Object.freeze({ requestId: text(ids.requestId, 128), attemptId: text(ids.attemptId, 128), laneEpoch: text(ids.laneEpoch, 128) }) });
}
function decodeRecord(value: unknown): ReadOwnershipRecord {
  const source = exact(value, ["schemaVersion", "bindingFingerprint", "buildHash", "supervisorId", "ids", "lockToken", "state", "pid"]);
  const { state, pid, ...intent } = source;
  if (!["launch-intent", "child-observed", "complete", "incomplete"].includes(state as string)
    || (pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 0))) return refused();
  if (state === "launch-intent" && pid !== null || state === "child-observed" && pid === null) return refused();
  return Object.freeze({ ...decodeIntent(intent), state: state as ReadOwnershipRecord["state"], pid: pid as number | null });
}
function sameIds(a: ReadMessageIds, b: ReadMessageIds): boolean { return a.requestId === b.requestId && a.attemptId === b.attemptId && a.laneEpoch === b.laneEpoch; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && !b.isSymbolicLink() && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeNs === b.ctimeNs;
}
type Capture = { record: ReadOwnershipRecord; stat: BigIntStats; digest: string };

/** One repository owns only records it created. Persisted PIDs are diagnostics, never process authority. */
export class VerifiedReadOwnershipRepository {
  readonly #directory: ProjectionDirectoryIdentity;
  readonly #path: string;
  #owned: Capture | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(directory: ProjectionDirectoryIdentity) {
    const source = exact(directory, ["canonicalPath", "device", "inode"]);
    const path = text(source.canonicalPath, 2048);
    if (!isAbsolute(path) || normalize(path) !== path) refused();
    this.#directory = Object.freeze({ canonicalPath: path, device: text(source.device, 128), inode: text(source.inode, 128) });
    this.#path = join(path, NAME);
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation); this.#tail = next.catch(() => undefined); return next;
  }
  async #directoryProof(): Promise<void> {
    const path = this.#directory.canonicalPath; const before = await lstat(path, { bigint: true }); const canonical = await realpath(path);
    const equal = process.platform === "win32" ? canonical.toLowerCase() === path.toLowerCase() : canonical === path;
    if (!before.isDirectory() || before.isSymbolicLink() || !equal || String(before.dev) !== this.#directory.device || String(before.ino) !== this.#directory.inode) refused();
    const after = await lstat(path, { bigint: true }); if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || after.isSymbolicLink()) refused();
  }
  async #syncDirectory(): Promise<void> {
    let handle;
    try { handle = await open(this.#directory.canonicalPath, "r"); await handle.sync(); }
    catch (error) { if (!["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP"].includes(code(error) as string)
      && !(process.platform === "win32" && ["EACCES", "EBADF", "EPERM"].includes(code(error) as string))) throw error; }
    finally { await handle?.close(); }
    await this.#directoryProof();
  }
  async #capture(): Promise<Capture | null> {
    await this.#directoryProof(); let before: BigIntStats;
    try { before = await lstat(this.#path, { bigint: true }); }
    catch (error) { if (code(error) !== "ENOENT") throw error; await this.#directoryProof(); return null; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(LIMIT)) refused();
    const handle = await open(this.#path, "r");
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) refused();
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) refused(); offset += read.bytesRead; }
      if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(this.#path, { bigint: true }))) refused();
      await this.#directoryProof();
      return { record: decodeRecord(JSON.parse(bytes.toString("utf8"))), stat: before, digest: createHash("sha256").update(bytes).digest("hex") };
    } finally { await handle.close(); }
  }
  async #matches(expected: Capture): Promise<void> {
    const current = await this.#capture(); if (!current || !sameFile(expected.stat, current.stat) || expected.digest !== current.digest) refused();
  }
  async #publish(record: ReadOwnershipRecord, replacing?: Capture): Promise<Capture> {
    await this.#directoryProof();
    const bytes = Buffer.from(JSON.stringify(record)); if (bytes.length > LIMIT) refused();
    const temporary = join(this.#directory.canonicalPath, `.${NAME}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600); const identity = await handle.stat({ bigint: true });
    let installed = false;
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      await this.#directoryProof();
      if (replacing) { await this.#matches(replacing); await rename(temporary, this.#path); }
      else { await link(temporary, this.#path); await unlink(temporary); }
      installed = true; await this.#syncDirectory();
      const captured = await this.#capture();
      if (!captured || captured.stat.dev !== identity.dev || captured.stat.ino !== identity.ino || captured.digest !== createHash("sha256").update(bytes).digest("hex")) refused();
      return captured;
    } finally {
      await handle.close();
      if (!installed) {
        // Only remove this invocation's temporary, never an unknown destination or substituted file.
        try { await this.#directoryProof(); const stat = await lstat(temporary, { bigint: true });
          if (stat.dev === identity.dev && stat.ino === identity.ino && stat.isFile() && !stat.isSymbolicLink()) await unlink(temporary);
        } catch { /* Uncertain evidence is retained. */ }
      }
    }
  }
  inspect(): Promise<ReadOwnershipRecord | null> { return this.#serial(async () => (await this.#capture())?.record ?? null); }
  begin(input: ReadLaunchIntent): Promise<void> {
    const intent = decodeIntent(input);
    return this.#serial(async () => {
      if (this.#owned) refused();
      const prior = await this.#capture();
      // Complete is not permission to reclaim: its creator can still have an unlink in flight.
      // Only actual absence followed by exclusive publication can admit another owner.
      if (prior) refused();
      this.#owned = await this.#publish({ ...intent, state: "launch-intent", pid: null });
    });
  }
  #change(ids: ReadMessageIds, state: ReadOwnershipRecord["state"], pid?: number): Promise<void> {
    return this.#serial(async () => {
      const owned = this.#owned; if (!owned || !sameIds(owned.record.ids, ids)) refused();
      await this.#matches(owned);
      this.#owned = await this.#publish({ ...owned.record, state, pid: pid ?? owned.record.pid }, owned);
    });
  }
  observeChild(ids: ReadMessageIds, pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(Object.assign(new Error("WORKER_UNAVAILABLE"), { code: "WORKER_UNAVAILABLE" }));
    return this.#change(ids, "child-observed", pid);
  }
  retainIncomplete(ids: ReadMessageIds): Promise<void> { return this.#change(ids, "incomplete"); }
  async complete(ids: ReadMessageIds): Promise<void> {
    await this.#change(ids, "complete");
    await this.#serial(async () => {
      const owned = this.#owned; if (!owned || !sameIds(owned.record.ids, ids) || owned.record.state !== "complete") refused();
      await this.#matches(owned); await unlink(this.#path); await this.#syncDirectory(); this.#owned = undefined;
    });
  }
}
