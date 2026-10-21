import { createHash } from "node:crypto";
import { FreshStartError, type FreshStartIdentity, type FreshStartRelease } from "../orchestrator/fresh-start/contracts.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";

const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

export const V2_CAPABILITIES = Object.freeze({
  profile: "fresh-start",
  version: 1,
  tools: Object.freeze(["memory_v2Status"]),
  content: "unavailable",
});

export const V2_RECOVERY_POLICY = Object.freeze({
  profile: "fresh-start",
  version: 1,
  productionReady: false,
  promotion: "closed",
});

export const V2_SUPPORTED_V1_TOOLS = Object.freeze([
  "memory_search",
  "memory_get",
  "memory_list",
  "memory_recent",
  "memory_contextPack",
  "memory_followUpRadar",
  "memory_writeSessionLog",
  "memory_writeInsight",
  "memory_writeMistake",
  "memory_writeADR",
  "memory_sessionStart",
  "memory_sessionEnd",
  "memory_lifecycleStatus",
  "memory_selfCheck",
  "memory_awaken",
  "memory_verifyVault",
  "memory_verifyNote",
  "memory_verifySourceTruth",
  "memory_findDuplicates",
  "memory_checkStaleness",
] as const);

export const V2_SUPERSEDED_V1_TOOLS = Object.freeze({
  memory_bootstrapProject: Object.freeze({ supersededBy: "v2-admin.js initialize-fresh" }),
  memory_reindex: Object.freeze({ supersededBy: "v2-admin.js rebuild-projections" }),
  memory_indexNote: Object.freeze({ supersededBy: "v2-admin.js rebuild-projections" }),
  memory_diagnoseWorkspace: Object.freeze({ supersededBy: "v2-admin.js status" }),
} as const);

export const V2_UNAVAILABLE_V1_TOOLS = Object.freeze([
  "memory_createFromTemplate",
  "memory_findBrokenLinks",
  "memory_validateFrontmatter",
  "memory_fixFrontmatter",
  "memory_migrateFrontmatter",
  "memory_compactVault",
  "memory_export",
  "memory_import",
] as const);

export type V1ToolParityEntry =
  | Readonly<{ status: "V2-supported" }>
  | Readonly<{ status: "superseded"; supersededBy: string }>
  | Readonly<{ status: "unavailable" }>;

export const V2_V1_PARITY_CLASSIFICATION: Readonly<Record<string, V1ToolParityEntry>> = Object.freeze({
  ...Object.fromEntries(
    V2_SUPPORTED_V1_TOOLS.map(name => [name, Object.freeze({ status: "V2-supported" as const })]),
  ),
  ...Object.fromEntries(
    Object.entries(V2_SUPERSEDED_V1_TOOLS).map(([name, info]) => [
      name,
      Object.freeze({ status: "superseded" as const, supersededBy: info.supersededBy }),
    ]),
  ),
  ...Object.fromEntries(
    V2_UNAVAILABLE_V1_TOOLS.map(name => [name, Object.freeze({ status: "unavailable" as const })]),
  ),
});

export const V2_NATIVE_TOOLS = Object.freeze([
  "memory_v2Status",
  "memory_checkpoint",
  "memory_recoverSession",
  "memory_sessionFork",
  "memory_recordChildResult",
  "memory_completeChildSession",
  "memory_amendSessionEnd",
  "memory_cancelSessionEnd",
  "memory_recordEvidenceBatch",
  "memory_promote",
  "memory_supersede",
  "memory_retract",
  "memory_expire",
  "memory_forgetEvidence",
] as const);

export const V2_PRODUCTION_CAPABILITIES = Object.freeze({
  profile: "fresh-start",
  version: 1,
  content: "governed-v2",
  tools: Object.freeze([...V2_SUPPORTED_V1_TOOLS, ...V2_NATIVE_TOOLS]),
  v1Parity: V2_V1_PARITY_CLASSIFICATION,
});

export const V2_PRODUCTION_RECOVERY_POLICY = Object.freeze({
  profile: "fresh-start",
  version: 1,
  productionReady: true,
  promotion: "operator-approved",
});

export function isProductionReleaseManifest(
  release: Omit<FreshStartRelease, keyof FreshStartIdentity> | Pick<FreshStartRelease, "capabilityManifestHash" | "recoveryPolicyHash">,
): boolean {
  const isFoundation =
    release.capabilityManifestHash === digest(V2_CAPABILITIES) &&
    release.recoveryPolicyHash === digest(V2_RECOVERY_POLICY);
  const isProduction =
    release.capabilityManifestHash === digest(V2_PRODUCTION_CAPABILITIES) &&
    release.recoveryPolicyHash === digest(V2_PRODUCTION_RECOVERY_POLICY);
  if (!isFoundation && !isProduction) {
    throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
  }
  return isProduction;
}
