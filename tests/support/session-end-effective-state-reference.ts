import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import type {
  CheckpointDraftV1,
  CheckpointDraftV2,
} from "../../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type { SessionId } from "../../src/orchestrator/lifecycle/contracts/identifiers.js";
import type {
  PersistedQualityPolicyInputV1,
  SessionEndRequestV1,
  SessionEndRequestV2,
} from "../../src/orchestrator/lifecycle/contracts/session-end.js";
import type { SessionEndEffectiveStateV1 } from "../../src/orchestrator/lifecycle/session-end-effective-state.js";

const DOMAIN = "project-memory/session-end-effective-state/v1" as const;
export const EFFECTIVE_STATE_SESSION_ID =
  "44444444-4444-4444-8444-444444444444" as SessionId;

function baseCheckpoint(checkpointVersion: 1 | 2): CheckpointDraftV1 | CheckpointDraftV2 {
  return {
    checkpointVersion,
    taskSummary: "งานเสร็จ",
    completedItems: [],
    inProgressItems: [],
    blockers: [],
    nextActions: [],
    decisions: [],
    assumptions: [],
    unresolvedConflicts: [],
    filesTouched: [],
    artifactReferences: [],
    sourceReferences: [],
    commandResults: [],
    testResults: [],
    materialClaims: [],
  } as CheckpointDraftV1 | CheckpointDraftV2;
}

export function rawCanonicalProbeAtBytes(targetBytes: number): object {
  const seed = { probe: "" };
  const fixedBytes = Buffer.byteLength(canonicalJson(seed), "utf8");
  if (!Number.isSafeInteger(targetBytes) || targetBytes < fixedBytes) {
    throw new TypeError("raw canonical probe target is invalid");
  }
  const payloadBytes = targetBytes - fixedBytes;
  const thaiScalars = Math.floor(payloadBytes / 3);
  const asciiBytes = payloadBytes - (thaiScalars * 3);
  const probe = { probe: `${"ก".repeat(thaiScalars)}${"x".repeat(asciiBytes)}` };
  if (Buffer.byteLength(canonicalJson(probe), "utf8") !== targetBytes) {
    throw new TypeError("raw canonical probe construction failed");
  }
  return probe;
}

export function checkpointDraftAtCanonicalBytes(
  targetBytes: number,
  checkpointVersion: 1 | 2 = 1,
): CheckpointDraftV1 | CheckpointDraftV2 {
  const draft = {
    ...baseCheckpoint(checkpointVersion),
    taskSummary: "x",
    completedItems: Array.from({ length: 100 }, () => ({ summary: "x", confidence: "high" as const })),
  } as CheckpointDraftV1 | CheckpointDraftV2;
  let remaining = targetBytes - Buffer.byteLength(canonicalJson(draft), "utf8");
  if (remaining < 0) throw new TypeError("checkpoint target is too small");
  for (let index = 0; index < draft.completedItems.length && remaining > 0; index += 1) {
    const item = draft.completedItems[index];
    if (item === undefined) throw new TypeError("checkpoint fixture item missing");
    const added = Math.min(remaining, 3_999);
    (draft.completedItems as { summary: string; confidence: "high" }[])[index] = {
      summary: `${item.summary}${"x".repeat(added)}`,
      confidence: "high",
    };
    remaining -= added;
  }
  if (remaining !== 0 || Buffer.byteLength(canonicalJson(draft), "utf8") !== targetBytes) {
    throw new TypeError("checkpoint boundary fixture construction failed");
  }
  return draft;
}

function profiles(count: number): PersistedQualityPolicyInputV1["profiles"] {
  return Array.from({ length: count }, (_unused, index) => ({
    profileId: `profile-${index.toString().padStart(3, "0")}-ก`,
    profileVersion: 1,
    required: index === 0,
    weight: index + 1,
  }));
}

export function referenceSessionEndEffectiveStateHashV1(
  value: Omit<SessionEndEffectiveStateV1, "effectiveStateHash">,
): string {
  const canonical = canonicalJson({
    effectiveStateVersion: value.effectiveStateVersion,
    effectiveStateDomain: value.effectiveStateDomain,
    request: value.request,
    effectivePolicy: value.effectivePolicy,
    effectiveFinalCheckpoint: value.effectiveFinalCheckpoint,
  });
  return createHash("sha256")
    .update(`${DOMAIN}\n`, "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

export interface EffectiveStateFixtureOptions {
  readonly requestVersion?: 1 | 2;
  readonly profileCount?: number;
  readonly checkpoint?: CheckpointDraftV1 | CheckpointDraftV2;
}

export function sessionEndEffectiveStateFixture(
  options: EffectiveStateFixtureOptions = {},
): SessionEndEffectiveStateV1 {
  const requestVersion = options.requestVersion ?? 1;
  const checkpoint = options.checkpoint ?? baseCheckpoint(requestVersion);
  const profileCount = options.profileCount ?? 2;
  const validationProfileIds = profiles(profileCount).map((profile) => profile.profileId);
  const common = {
    sessionId: EFFECTIVE_STATE_SESSION_ID,
    childEndPolicy: "suspend-and-carry-forward" as const,
    finalCheckpoint: checkpoint,
    validationProfileIds,
    requestedQualityThreshold: 7,
    requireFullEvidence: true,
    requireMaterialization: false,
  };
  const request = requestVersion === 1
    ? { requestVersion: 1 as const, ...common, finalCheckpoint: checkpoint as CheckpointDraftV1 }
    : { requestVersion: 2 as const, ...common, finalCheckpoint: checkpoint as CheckpointDraftV2 };
  const withoutHash = {
    effectiveStateVersion: 1 as const,
    effectiveStateDomain: DOMAIN,
    request: request as SessionEndRequestV1 | SessionEndRequestV2,
    effectivePolicy: {
      qualityPolicyVersion: 1 as const,
      profiles: profiles(profileCount),
      qualityThreshold: 7,
      requireFullEvidence: true,
      requireMaterialization: false,
    },
    effectiveFinalCheckpoint: checkpoint,
  };
  return {
    ...withoutHash,
    effectiveStateHash: referenceSessionEndEffectiveStateHashV1(withoutHash),
  };
}
