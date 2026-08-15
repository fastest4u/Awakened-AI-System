import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  calculateQualityScoreV1,
  deriveEffectiveQualityPolicyV1,
  assertVersion1WholeScopeEligibleV1,
  type EffectiveQualityPolicyInputV1,
} from "../src/orchestrator/lifecycle/session-end-policy.js";

const trusted = [
  { profileId: "required-a", profileVersion: 1, required: true, weight: 3 },
  { profileId: "optional-a", profileVersion: 2, required: false, weight: 2 },
] as const;

function policyInput(
  overrides: Partial<EffectiveQualityPolicyInputV1> = {},
): EffectiveQualityPolicyInputV1 {
  return {
    trustedProfiles: trusted,
    optionalProfiles: [
      { profileId: "optional-b", profileVersion: 1, required: false, weight: 5 },
    ],
    requestedProfileIds: ["required-a", "optional-b"],
    requestedQualityThreshold: 7_500,
    trustedMinimumQualityThreshold: 8_000,
    trustedRequireFullEvidence: true,
    requestedRequireFullEvidence: false,
    trustedRequireMaterialization: false,
    requestedRequireMaterialization: true,
    ...overrides,
  };
}

describe("session-end policy arithmetic", () => {
  it("derives trusted required profiles and integer policy arithmetic", () => {
    const policy = deriveEffectiveQualityPolicyV1(policyInput());
    assert.deepEqual(policy.profiles.map((profile) => profile.profileId), [
      "optional-b", "required-a",
    ]);
    assert.equal(policy.qualityThreshold, 8_000);
    assert.equal(policy.requireFullEvidence, true);
    assert.equal(policy.requireMaterialization, true);
    assert.equal(policy.totalEffectiveWeight, 8);

    const result = calculateQualityScoreV1(policy, [
      { profileId: "optional-b", profileVersion: 1, status: "pass" },
      { profileId: "required-a", profileVersion: 1, status: "fail" },
    ]);
    assert.equal(result.passingWeight, 5);
    assert.equal(result.qualityScore, 6_250);
    assert.equal(result.requiredFailure, true);
  });

  it("rejects a Version 1 whole-scope proof with any ineligible member", () => {
    assert.doesNotThrow(() => assertVersion1WholeScopeEligibleV1([
      { sessionId: "root", eligible: true },
      { sessionId: "child", eligible: true },
    ]));
    assert.throws(
      () => assertVersion1WholeScopeEligibleV1([
        { sessionId: "root", eligible: true },
        { sessionId: "child", eligible: false },
      ]),
      /LIFECYCLE_INPUT_INVALID/,
    );
  });
});
