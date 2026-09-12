import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ShadowMigrationError } from "../migration/v2-shadow-migration.contracts.js";
import type { CompatibilityFileIdentity, StableCompatibilityRequest, StableCompatibilityResponse } from "./stable-compatibility-directory.worker.js";

export interface PreparedCompatibilityParent {
  readonly relativePath: string;
  readonly path: string;
  readonly identity: CompatibilityFileIdentity;
}
interface ArtifactVerification {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly remainingMs: number;
}
export interface CompatibilityPublicationResult {
  readonly identity: CompatibilityFileIdentity;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly deduplicated: boolean;
}
const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
function fail(unknown = false): never { throw new ShadowMigrationError(unknown ? "MIGRATION_OUTCOME_UNKNOWN" : "COMPATIBILITY_INTEGRITY_FAILURE"); }
const same = (a: CompatibilityFileIdentity, b: CompatibilityFileIdentity) => a.device === b.device && a.inode === b.inode;
function overlap(a: string, b: string): boolean {
  const part = relative(a, b); return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
export function captureCompatibilityPath(path: string, directory: boolean): CompatibilityFileIdentity {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || key(realpathSync.native(path)) !== key(path)) fail();
    // Checking every ancestor rejects junctions even when a final realpath happens to match.
    let cursor = path;
    while (true) {
      const stat = lstatSync(cursor, { bigint: true });
      if (stat.isSymbolicLink() || (cursor !== path && !stat.isDirectory())) fail();
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    const stat = lstatSync(path, { bigint: true });
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) fail();
    return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
  } catch { fail(); }
}
function components(path: string): readonly string[] {
  if (typeof path !== "string" || path.length > 32768 || path.startsWith("/") || /\\/.test(path)) fail();
  const parts = path.split("/");
  if (parts.some(part => !part || part.length > 255 || part === "." || part === ".." || /[/:\x00-\x1f<>"|?*]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail();
  return parts;
}
function deadline(milliseconds: number): () => number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 300000) fail();
  const end = performance.now() + milliseconds;
  return () => { const remaining = Math.floor(end - performance.now()); if (remaining < 1) fail(true); return remaining; };
}

/** No parent-process cwd changes or filesystem mutations. Children retain their own directory handles. */
export class StableCompatibilityDirectory {
  readonly #root: string;
  readonly #identity: CompatibilityFileIdentity;
  readonly #forbidden: readonly CompatibilityFileIdentity[];
  readonly #parents = new WeakSet<PreparedCompatibilityParent>();
  readonly #launch: typeof spawn;
  constructor(options: { readonly rootPath: string; readonly forbiddenRoots: readonly string[] }, launch: typeof spawn = spawn) {
    this.#launch = launch;
    this.#root = options.rootPath;
    this.#identity = captureCompatibilityPath(this.#root, true);
    if (!Array.isArray(options.forbiddenRoots) || options.forbiddenRoots.length > 32) fail();
    this.#forbidden = Object.freeze(options.forbiddenRoots.map(path => {
      const id = captureCompatibilityPath(path, true);
      if (same(id, this.#identity) || overlap(path, this.#root) || overlap(this.#root, path)) fail();
      return id;
    }));
  }
  #checkRoot(): void { if (!same(captureCompatibilityPath(this.#root, true), this.#identity)) fail(); }
  async prepareParent(relativePath: string, remainingMs: number): Promise<PreparedCompatibilityParent> {
    const remaining = deadline(remainingMs), parts = components(relativePath); this.#checkRoot();
    let path = this.#root, identity = this.#identity;
    for (const part of parts.slice(0, -1)) {
      const response = await this.#request({ operation: "prepare", parentPath: path, parentIdentity: identity,
        basename: part, byteLength: 0, contentSha256: "0".repeat(64), bytesBase64: null }, remaining());
      path = join(path, part); identity = response.identity;
      if (!same(captureCompatibilityPath(path, true), identity)) fail(); this.#checkRoot();
    }
    const parent = Object.freeze({ relativePath, path, identity }); this.#parents.add(parent); return parent;
  }
  async publishOrReconcile(input: ArtifactVerification & { readonly parent: PreparedCompatibilityParent; readonly bytes: Uint8Array }): Promise<CompatibilityPublicationResult> {
    const remaining = deadline(input.remainingMs), parts = components(input.relativePath), parent = input.parent;
    if (!this.#parents.has(parent) || parent.relativePath !== input.relativePath || !(input.bytes instanceof Uint8Array)) fail();
    this.#checkRoot(); if (!same(captureCompatibilityPath(parent.path, true), parent.identity)) fail();
    const response = await this.#request({ operation: "publish", parentPath: parent.path, parentIdentity: parent.identity,
      basename: parts.at(-1)!, byteLength: input.byteLength, contentSha256: input.contentSha256,
      bytesBase64: Buffer.from(input.bytes).toString("base64") }, remaining());
    this.#checkRoot(); if (!same(captureCompatibilityPath(parent.path, true), parent.identity)) fail();
    return Object.freeze({ identity: response.identity, byteLength: response.byteLength, contentSha256: response.contentSha256,
      deduplicated: response.state === "verified" });
  }
  async verifyOnly(input: ArtifactVerification): Promise<CompatibilityPublicationResult> {
    const remaining = deadline(input.remainingMs), parts = components(input.relativePath); this.#checkRoot();
    let path = this.#root;
    for (const part of parts.slice(0, -1)) { path = join(path, part); captureCompatibilityPath(path, true); }
    const identity = captureCompatibilityPath(path, true);
    const response = await this.#request({ operation: "verify", parentPath: path, parentIdentity: identity,
      basename: parts.at(-1)!, byteLength: input.byteLength, contentSha256: input.contentSha256, bytesBase64: null }, remaining());
    this.#checkRoot(); if (!same(captureCompatibilityPath(path, true), identity)) fail();
    return Object.freeze({ identity: response.identity, byteLength: response.byteLength, contentSha256: response.contentSha256, deduplicated: true });
  }
  async #request(value: Omit<StableCompatibilityRequest, "schemaVersion" | "requestId" | "attemptToken" | "forbiddenIdentities">,
    remainingMs: number): Promise<StableCompatibilityResponse> {
    const request: StableCompatibilityRequest = { schemaVersion: 1, requestId: randomBytes(16).toString("hex"),
      attemptToken: randomBytes(16).toString("hex"), forbiddenIdentities: this.#forbidden, ...value };
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) fail();
    const worker = fileURLToPath(new URL("./stable-compatibility-directory.worker.js", import.meta.url));
    captureCompatibilityPath(worker, false);
    return new Promise((resolve, reject) => {
      const child = (() => {
        try { return this.#launch(process.execPath, [worker, "--stable-compatibility-worker"], {
          cwd: request.parentPath, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false,
        }); } catch { fail(true); }
      })();
      const chunks: Buffer[] = []; let bytes = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill(); }, remainingMs);
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length;
        if (bytes > 16384) { failed = true; child.kill(); } else chunks.push(chunk); });
      child.stderr.resume();
      child.on("error", () => { failed = true; }); child.stdin.on("error", () => { failed = true; });
      child.once("close", code => {
        clearTimeout(timer);
        try {
          if (failed) fail(true);
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (code !== 0) fail(result.code === "MIGRATION_OUTCOME_UNKNOWN");
          const keys = ["schemaVersion", "requestId", "operation", "state", "identity", "byteLength", "contentSha256"];
          if (Object.keys(result).length !== keys.length || Object.keys(result).some(k => !keys.includes(k)) || result.schemaVersion !== 1
            || result.requestId !== request.requestId || result.operation !== request.operation || result.byteLength !== request.byteLength
            || result.contentSha256 !== request.contentSha256 || (request.operation === "prepare" ? result.state !== "prepared"
              : request.operation === "verify" ? result.state !== "verified" : result.state !== "verified" && result.state !== "published")) fail();
          const id = result.identity as CompatibilityFileIdentity;
          if (!id || typeof id !== "object" || Object.keys(id).sort().join(",") !== "device,inode"
            || typeof id.device !== "string" || typeof id.inode !== "string" || !/^\d{1,30}$/.test(id.device) || !/^\d{1,30}$/.test(id.inode)
            || this.#forbidden.some(forbidden => same(forbidden, id))) fail();
          resolve(Object.freeze({ ...result, identity: Object.freeze(id) }) as unknown as StableCompatibilityResponse);
        } catch (error) { reject(error instanceof ShadowMigrationError ? error : new ShadowMigrationError("COMPATIBILITY_INTEGRITY_FAILURE")); }
      });
      child.stdin.end(body);
    });
  }
}
