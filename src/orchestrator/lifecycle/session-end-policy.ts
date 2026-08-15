import { LifecycleError } from "./errors.js";
import type {
  QualityPolicyV1,
  QualityProfileV1,
} from "./contracts/session-end.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_PROFILES = 64;
const MAX_WEIGHT = 1_000_000;
const MAX_THRESHOLD = 10_000;

export interface EffectiveQualityPolicyInputV1 {
  readonly trustedProfiles: readonly QualityProfileV1[];
  readonly optionalProfiles: readonly QualityProfileV1[];
  readonly requestedProfileIds: readonly string[];
  readonly requestedQualityThreshold: number;
  readonly trustedMinimumQualityThreshold: number;
  readonly trustedRequireFullEvidence: boolean;
  readonly requestedRequireFullEvidence: boolean;
  readonly trustedRequireMaterialization: boolean;
  readonly requestedRequireMaterialization: boolean;
}

export interface QualityResultForScoreV1 {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly status: "pass" | "fail" | "unavailable";
}

export interface QualityScoreV1 {
  readonly passingWeight: number;
  readonly qualityScore: number;
  readonly requiredFailure: boolean;
}

export interface Version1WholeScopeMemberV1 {
  readonly sessionId: string;
  readonly eligible: boolean;
}

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function checkedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) invalid(field);
  return value;
}

function checkedProfile(profile: QualityProfileV1, field: string): QualityProfileV1 {
  if (
    typeof profile !== "object"
    || profile === null
    || typeof profile.profileId !== "string"
    || profile.profileId.length === 0
    || Array.from(profile.profileId).length > 256
    || !Number.isSafeInteger(profile.profileVersion)
    || profile.profileVersion <= 0
    || !Number.isSafeInteger(profile.weight)
    || profile.weight < 1
    || profile.weight > MAX_WEIGHT
    || typeof profile.required !== "boolean"
  ) invalid(field);
  return Object.freeze({
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    required: profile.required,
    weight: profile.weight,
  });
}

function profileKey(profile: Pick<QualityProfileV1, "profileId" | "profileVersion">): string {
  return `${profile.profileId}\u0000${profile.profileVersion}`;
}

function compareProfiles(left: QualityProfileV1, right: QualityProfileV1): number {
  const idComparison = Buffer.compare(
    Buffer.from(left.profileId, "utf8"),
    Buffer.from(right.profileId, "utf8"),
  );
  return idComparison !== 0 ? idComparison : left.profileVersion - right.profileVersion;
}

function checkedProfileSet(
  profiles: unknown,
  field: string,
): readonly QualityProfileV1[] {
  if (!Array.isArray(profiles)) invalid(field);
  if (profiles.length > MAX_PROFILES) invalid(`${field}.length`);
  const seen = new Set<string>();
  const checked = profiles.map((profile, index) => {
    const decoded = checkedProfile(profile, `${field}[${index}]`);
    const key = profileKey(decoded);
    if (seen.has(key)) invalid(`${field}.duplicate`);
    seen.add(key);
    return decoded;
  });
  return Object.freeze(checked);
}

/**
 * Combines trusted policy with the caller's allowlisted optional profiles.
 * Required trusted profiles are always included and caller booleans can only
 * tighten the trusted defaults.
 */
export function deriveEffectiveQualityPolicyV1(
  input: EffectiveQualityPolicyInputV1,
): QualityPolicyV1 {
  const trusted = checkedProfileSet(input.trustedProfiles, "trustedProfiles");
  const optional = checkedProfileSet(input.optionalProfiles, "optionalProfiles");
  const requested = input.requestedProfileIds;
  if (!Array.isArray(requested) || requested.length > MAX_PROFILES) invalid("requestedProfileIds");
  const requestedIds = new Set<string>();
  for (const [index, profileId] of requested.entries()) {
    if (typeof profileId !== "string" || profileId.length === 0 || requestedIds.has(profileId)) {
      invalid(`requestedProfileIds[${index}]`);
    }
    requestedIds.add(profileId);
  }

  const selected = new Map<string, QualityProfileV1>();
  for (const profile of trusted) {
    if (profile.required || requestedIds.has(profile.profileId)) {
      selected.set(profileKey(profile), profile);
    }
  }
  for (const profile of optional) {
    if (requestedIds.has(profile.profileId)) selected.set(profileKey(profile), profile);
  }
  for (const profileId of requestedIds) {
    if (![...selected.values()].some((profile) => profile.profileId === profileId)) {
      invalid("requestedProfileIds.allowlist");
    }
  }
  const profiles = Object.freeze([...selected.values()].sort(compareProfiles));
  if (profiles.length === 0) invalid("profiles");
  const totalEffectiveWeight = profiles.reduce((sum, profile) => sum + profile.weight, 0);
  if (!Number.isSafeInteger(totalEffectiveWeight) || totalEffectiveWeight <= 0) {
    invalid("profiles.totalEffectiveWeight");
  }
  const trustedMinimum = checkedInteger(
    input.trustedMinimumQualityThreshold,
    "trustedMinimumQualityThreshold",
    0,
    MAX_THRESHOLD,
  );
  const requestedThreshold = checkedInteger(
    input.requestedQualityThreshold,
    "requestedQualityThreshold",
    0,
    MAX_THRESHOLD,
  );
  if (typeof input.trustedRequireFullEvidence !== "boolean"
    || typeof input.requestedRequireFullEvidence !== "boolean"
    || typeof input.trustedRequireMaterialization !== "boolean"
    || typeof input.requestedRequireMaterialization !== "boolean") {
    invalid("requirements");
  }
  return Object.freeze({
    qualityPolicyVersion: 1,
    profiles,
    qualityThreshold: Math.max(trustedMinimum, requestedThreshold),
    requireFullEvidence: input.trustedRequireFullEvidence || input.requestedRequireFullEvidence,
    requireMaterialization:
      input.trustedRequireMaterialization || input.requestedRequireMaterialization,
    totalEffectiveWeight,
  });
}

export function calculateQualityScoreV1(
  policy: QualityPolicyV1,
  results: readonly QualityResultForScoreV1[],
): QualityScoreV1 {
  if (typeof policy !== "object" || policy === null || policy.qualityPolicyVersion !== 1) {
    invalid("policy.qualityPolicyVersion");
  }
  const profiles = checkedProfileSet(policy.profiles, "policy.profiles");
  checkedInteger(policy.qualityThreshold, "policy.qualityThreshold", 0, MAX_THRESHOLD);
  if (typeof policy.requireFullEvidence !== "boolean"
    || typeof policy.requireMaterialization !== "boolean") invalid("policy.requirements");
  checkedInteger(policy.totalEffectiveWeight, "policy.totalEffectiveWeight", 1, Number.MAX_SAFE_INTEGER);
  const expected = new Map(profiles.map((profile) => [profileKey(profile), profile]));
  if (!Array.isArray(results)) invalid("results");
  if (results.length !== profiles.length) invalid("results.length");
  const seen = new Set<string>();
  let passingWeight = 0;
  let requiredFailure = false;
  for (const [index, result] of results.entries()) {
    if (
      typeof result !== "object"
      || result === null
      || typeof result.profileId !== "string"
      || !Number.isSafeInteger(result.profileVersion)
      || !["pass", "fail", "unavailable"].includes(result.status)
    ) invalid(`results[${index}]`);
    const key = profileKey(result);
    const profile = expected.get(key);
    if (profile === undefined || seen.has(key)) invalid(`results[${index}].identity`);
    seen.add(key);
    if (result.status === "pass") passingWeight += profile.weight;
    if (profile.required && result.status !== "pass") requiredFailure = true;
  }
  const totalWeight = BigInt(policy.totalEffectiveWeight);
  const passed = BigInt(passingWeight);
  if (totalWeight <= 0n || totalWeight > MAX_INT64 || passed < 0n || passed > totalWeight) {
    invalid("policy.totalEffectiveWeight");
  }
  const qualityScore = Number((10_000n * passed) / totalWeight);
  return Object.freeze({ passingWeight, qualityScore, requiredFailure });
}

export function assertVersion1WholeScopeEligibleV1(
  members: readonly Version1WholeScopeMemberV1[],
): void {
  if (!Array.isArray(members) || members.length === 0) invalid("wholeScope");
  const seen = new Set<string>();
  for (const [index, member] of members.entries()) {
    if (
      typeof member !== "object"
      || member === null
      || typeof member.sessionId !== "string"
      || member.sessionId.length === 0
      || typeof member.eligible !== "boolean"
      || seen.has(member.sessionId)
    ) invalid(`wholeScope[${index}]`);
    seen.add(member.sessionId);
    if (!member.eligible) invalid(`wholeScope[${index}].eligible`);
  }
}
