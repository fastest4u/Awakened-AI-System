import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, stat, realpath, open, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import { assertMinimumNodeVersion } from "../orchestrator/runtime/runtime-capabilities.js";

// Replaced only by the build recipe, never by environment or request input.
declare const __V2_DEPLOYMENT_ID__: string;
const artifactNames = ["v2.js", "v2-admin.js", "workers/project-store.worker.js",
  "internal/v2-internal-verified-read.js", "internal/v2-internal-verified-read-cleanup.js"] as const;
const hash = () => createHash("sha256");
const digest = (bytes: Uint8Array | string) => hash().update(bytes).digest("hex");
function fail(): never { throw new FreshStartError("FRESH_START_BUILD_MISMATCH"); }
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== names.length || names.some(name => !Object.hasOwn(source, name))) fail();
  return source;
}
function bytes(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum || realpathSync.native(path) !== resolve(path)) fail();
  const result = readFileSync(path);
  if (result.byteLength !== stat.size) fail();
  return result;
}
function deploymentRoot(entryUrl: string): string {
  assertMinimumNodeVersion();
  if (typeof __V2_DEPLOYMENT_ID__ !== "string") fail();
  const entry = fileURLToPath(entryUrl), directory = dirname(entry);
  const roots = artifactNames.map(name => name.includes("/") ? dirname(directory) : directory);
  const index = artifactNames.findIndex((name, i) => join(roots[i]!, name) === entry);
  if (index < 0) fail();
  const root = roots[index]!;
  if (!artifactNames.some(name => join(root, name) === entry)) fail();
  return root;
}
function manifestBody(value: string): Record<string, unknown> {
  const manifest = exact(JSON.parse(value), ["schemaVersion", "deploymentId", "runtime", "artifacts", "buildIdentityHash"]);
  if (manifest.schemaVersion !== 1 || manifest.deploymentId !== __V2_DEPLOYMENT_ID__) fail();
  return manifest;
}
function runtimePolicy(manifest: Record<string, unknown>): Record<string, unknown> {
  const runtime = exact(manifest.runtime, ["nodeVersion", "platform", "arch", "executableSha256"]);
  if (runtime.nodeVersion !== process.versions.node || runtime.platform !== process.platform || runtime.arch !== process.arch) fail();
  return runtime;
}
function artifactDescriptors(manifest: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== artifactNames.length) fail();
  return manifest.artifacts.map((value, index) => {
    const artifact = exact(value, ["path", "bytes", "sha256"]);
    if (artifact.path !== artifactNames[index]) fail();
    return artifact;
  });
}
function artifactIdentity(artifact: Record<string, unknown>, length: number, sha256: string): void {
  if (artifact.bytes !== length || artifact.sha256 !== sha256) fail();
}
function measuredIdentity(manifest: Record<string, unknown>, runtime: Record<string, unknown>, artifacts: Record<string, unknown>[]): string {
  const body = { schemaVersion: 1, deploymentId: manifest.deploymentId, runtime, artifacts };
  const measured = digest(canonicalJson(body));
  if (manifest.buildIdentityHash !== measured) fail();
  return measured;
}

/** Independent local integrity measurement, not production release attestation. */
export function inspectV2Build(entryUrl: string = import.meta.url): string {
  try {
    const root = deploymentRoot(entryUrl);
    const manifest = manifestBody(bytes(join(root, "v2-build.json"), 16384).toString("utf8"));
    const runtime = runtimePolicy(manifest);
    if (runtime.executableSha256 !== digest(readFileSync(process.execPath))) fail();
    const artifacts = artifactDescriptors(manifest);
    artifacts.forEach((artifact, index) => {
      const actual = bytes(join(root, artifactNames[index]!), 32 * 1024 * 1024);
      artifactIdentity(artifact, actual.byteLength, digest(actual));
    });
    return measuredIdentity(manifest, runtime, artifacts);
  } catch { return fail(); }
}

const CHUNK_BYTES = 64 * 1024;
const MEASUREMENT_CONCURRENCY = 3;
function checkpoint(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason; }
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.ctimeNs === after.ctimeNs && before.nlink === after.nlink;
}
/** One reusable chunk per handle; manifest capture alone is bounded at the existing16KiB policy. */
async function fileIdentity(path: string, maximum: number | undefined, collect: boolean, signal?: AbortSignal) {
  checkpoint(signal);
  const before = maximum === undefined ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true });
  checkpoint(signal);
  if (maximum !== undefined && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size > BigInt(maximum) || await realpath(path) !== resolve(path))) fail();
  checkpoint(signal);
  let handle: FileHandle | undefined; let failed = false;
  try {
    handle = await open(path, "r"); checkpoint(signal);
    if (!sameFile(before, await handle.stat({ bigint: true }))) fail(); checkpoint(signal);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES), collected = collect ? Buffer.alloc(Number(before.size)) : undefined;
    const sha256 = hash(); let length = 0;
    for (;;) {
      checkpoint(signal);
      const { bytesRead } = await handle.read({ buffer, offset: 0, length: CHUNK_BYTES, position: length });
      checkpoint(signal); if (!bytesRead) break;
      if (BigInt(length + bytesRead) > before.size) fail();
      const chunk = buffer.subarray(0, bytesRead); sha256.update(chunk); collected?.set(chunk, length); length += bytesRead;
    }
    if (BigInt(length) !== before.size || !sameFile(before, await handle.stat({ bigint: true }))) fail(); checkpoint(signal);
    const after = maximum === undefined ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true });
    checkpoint(signal);
    if (!sameFile(before, after) || maximum !== undefined && (after.isSymbolicLink() || after.nlink !== 1n
      || await realpath(path) !== resolve(path))) fail();
    checkpoint(signal);
    return { length, sha256: sha256.digest("hex"), collected };
  } catch (error) { failed = true; throw error; }
  finally {
    // A secondary close error must not replace the primary failure. Other pool handles still drain.
    try { await handle?.close(); } catch (error) { if (!failed) { checkpoint(signal); throw error; } }
  }
}
async function boundedMeasurement(jobs: ((signal: AbortSignal) => Promise<void>)[], signal?: AbortSignal): Promise<void> {
  checkpoint(signal);
  const controller = new AbortController(), unset = Symbol("no failure"); let first: unknown = unset, next = 0;
  const refused = (error: unknown) => { if (first === unset) first = error; if (!controller.signal.aborted) controller.abort(error); };
  const aborted = () => refused(signal!.reason);
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    await Promise.all(Array.from({ length: MEASUREMENT_CONCURRENCY }, async () => {
      while (next < jobs.length && !controller.signal.aborted) {
        const job = jobs[next++]!;
        try { await job(controller.signal); } catch (error) { refused(error); return; }
      }
    }));
    if (first !== unset) throw first;
    checkpoint(signal);
  } finally { signal?.removeEventListener("abort", aborted); }
}
/** Same independent identity policy, with fixed3 handles and incremental hashing; no shared/cache authority. */
export async function inspectV2BuildAsync(entryUrl: string = import.meta.url, signal?: AbortSignal): Promise<string> {
  try {
    checkpoint(signal); const root = deploymentRoot(entryUrl);
    const header = await fileIdentity(join(root, "v2-build.json"), 16384, true, signal); checkpoint(signal);
    const manifest = manifestBody(header.collected!.toString("utf8")), runtime = runtimePolicy(manifest);
    const artifacts = artifactDescriptors(manifest);
    await boundedMeasurement([
      async activeSignal => { const actual = await fileIdentity(process.execPath, undefined, false, activeSignal);
        if (runtime.executableSha256 !== actual.sha256) fail(); },
      ...artifacts.map((artifact, index) => async (activeSignal: AbortSignal) => {
        const actual = await fileIdentity(join(root, artifactNames[index]!), 32 * 1024 * 1024, false, activeSignal);
        artifactIdentity(artifact, actual.length, actual.sha256);
      }),
    ], signal);
    checkpoint(signal); return measuredIdentity(manifest, runtime, artifacts);
  } catch (error) {
    if (error instanceof FreshStartError && error.code === "FRESH_START_BUILD_MISMATCH"
      || signal?.aborted && error === signal.reason) throw error;
    return fail();
  }
}
