import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import { assertMinimumNodeVersion } from "../orchestrator/runtime/runtime-capabilities.js";

// Replaced only by the build recipe, never by environment or request input.
declare const __V2_DEPLOYMENT_ID__: string;
const artifactNames = ["v2.js", "v2-admin.js", "workers/project-store.worker.js"] as const;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
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

/** Independent local integrity measurement, not production release attestation.
 * The embedded generation binds the loaded code to this exact emitted deployment.
 * All JS dependencies of these three entries are bundled; only Node builtins remain.
 */
export function inspectV2Build(entryUrl: string = import.meta.url): string {
  try {
    assertMinimumNodeVersion();
    if (typeof __V2_DEPLOYMENT_ID__ !== "string") fail();
    const entry = fileURLToPath(entryUrl);
    const directory = dirname(entry);
    const root = entry.endsWith("project-store.worker.js") ? dirname(directory) : directory;
    if (!artifactNames.some(name => join(root, name) === entry)) fail();
    const manifest = exact(JSON.parse(bytes(join(root, "v2-build.json"), 16384).toString("utf8")),
      ["schemaVersion", "deploymentId", "runtime", "artifacts", "buildIdentityHash"]);
    if (manifest.schemaVersion !== 1 || manifest.deploymentId !== __V2_DEPLOYMENT_ID__) fail();
    const runtime = exact(manifest.runtime, ["nodeVersion", "platform", "arch", "executableSha256"]);
    if (runtime.nodeVersion !== process.versions.node || runtime.platform !== process.platform || runtime.arch !== process.arch
      || runtime.executableSha256 !== digest(readFileSync(process.execPath))) fail();
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== artifactNames.length) fail();
    const artifacts = manifest.artifacts.map((value, index) => {
      const artifact = exact(value, ["path", "bytes", "sha256"]);
      if (artifact.path !== artifactNames[index]) fail();
      const actual = bytes(join(root, artifactNames[index]!), 32 * 1024 * 1024);
      if (artifact.bytes !== actual.byteLength || artifact.sha256 !== digest(actual)) fail();
      return artifact;
    });
    const body = { schemaVersion: 1, deploymentId: manifest.deploymentId, runtime, artifacts };
    const measured = digest(canonicalJson(body));
    if (manifest.buildIdentityHash !== measured) fail();
    return measured;
  } catch { return fail(); }
}
