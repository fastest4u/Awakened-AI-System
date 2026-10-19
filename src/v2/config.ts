import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { FreshStartError } from "../orchestrator/fresh-start/contracts.js";
import type { FreshStartPaths } from "../orchestrator/fresh-start/fresh-start-paths.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";

import {
  V2_CAPABILITIES,
  V2_RECOVERY_POLICY,
  V2_SUPPORTED_V1_TOOLS,
  V2_SUPERSEDED_V1_TOOLS,
  V2_UNAVAILABLE_V1_TOOLS,
  V2_V1_PARITY_CLASSIFICATION,
  V2_NATIVE_TOOLS,
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  isProductionReleaseManifest,
  type V1ToolParityEntry,
} from "./capabilities.js";

export type V2LaunchConfig = FreshStartPaths & Readonly<{ releaseId: string }>;
export {
  V2_CAPABILITIES,
  V2_RECOVERY_POLICY,
  V2_SUPPORTED_V1_TOOLS,
  V2_SUPERSEDED_V1_TOOLS,
  V2_UNAVAILABLE_V1_TOOLS,
  V2_V1_PARITY_CLASSIFICATION,
  V2_NATIVE_TOOLS,
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  isProductionReleaseManifest,
  type V1ToolParityEntry,
};
export const configurationDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function loadV2LaunchConfig(env: Readonly<Record<string, string | undefined>>): V2LaunchConfig {
  const path = (name: string): string => {
    const value = env[name];
    if (!value || value.trim() !== value || !isAbsolute(value) || /[\0\r\n]|\$\{|%[^%]+%/u.test(value)
      || (process.platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/iu.test(value))) throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    return value;
  };
  const projectRoot = path("MEMORY_PROJECT_ROOT"), v2VaultRoot = path("MEMORY_V2_VAULT_PATH"), v1ArchiveRoot = path("MEMORY_V1_ARCHIVE_PATH");
  const releaseId = env.MEMORY_V2_RELEASE_ID;
  if (!releaseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(releaseId)) throw new FreshStartError("FRESH_START_CONFIG_INVALID");
  return Object.freeze({ projectRoot, v2VaultRoot, v1ArchiveRoot, releaseId });
}

/** Never include native errors, caller input, filesystem paths or credentials. */
export function diagnosticCode(error: unknown): string {
  return error instanceof FreshStartError ? error.code : "FRESH_START_STORAGE_FAILURE";
}
