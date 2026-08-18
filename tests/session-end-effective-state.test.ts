import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES,
  assertSessionEndEffectiveStateCanonicalSizeV1,
  assertSessionEndEffectiveStateRequestCorrelationV1,
  assertSessionEndEffectiveStateSessionCorrelationV1,
  decodeSessionEndEffectiveStateV1,
  foldSessionEndAmendmentV1,
  initialSessionEndEvidenceWindowStateV1,
  sessionEndEffectiveStateHashV1,
  type SessionEndEffectiveStateV1,
} from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import {
  EFFECTIVE_STATE_SESSION_ID,
  checkpointDraftAtCanonicalBytes,
  rawCanonicalProbeAtBytes,
  referenceSessionEndEffectiveStateHashV1,
  sessionEndEffectiveStateFixture,
} from "./support/session-end-effective-state-reference.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof LifecycleError && error.code === code;
}

function withReferenceHash(
  value: Omit<SessionEndEffectiveStateV1, "effectiveStateHash">,
): SessionEndEffectiveStateV1 {
  return { ...value, effectiveStateHash: referenceSessionEndEffectiveStateHashV1(value) };
}

describe("session end effective state", () => {
  it("folds an amendment over the prior snapshot and preserves an omitted V2 draft", () => {
    const previous = decodeSessionEndEffectiveStateV1(
      sessionEndEffectiveStateFixture({ requestVersion: 2 }),
    );
    const amended = foldSessionEndAmendmentV1({
      previous,
      amendment: {
        amendmentVersion: 1,
        childEndPolicy: "require-completed",
        finalCheckpoint: null,
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
      },
      effectivePolicy: previous.effectivePolicy,
    });
    assert.equal(amended.request.requestVersion, 2);
    assert.equal(amended.request.childEndPolicy, "require-completed");
    assert.deepEqual(amended.request.finalCheckpoint, previous.request.finalCheckpoint);
    assert.deepEqual(amended.effectiveFinalCheckpoint, amended.request.finalCheckpoint);
    assert.equal(amended.effectiveStateHash, sessionEndEffectiveStateHashV1(amended));
  });

  it("enforces the session end effective-state raw UTF-8 guard at exact cap", () => {
    const exact = rawCanonicalProbeAtBytes(SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES);
    const over = rawCanonicalProbeAtBytes(SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES + 1);
    assert.equal(Buffer.byteLength(canonicalJson(exact), "utf8"), 1_048_576);
    assert.equal(Buffer.byteLength(canonicalJson(over), "utf8"), 1_048_577);
    assert.ok(JSON.stringify(exact).length < Buffer.byteLength(canonicalJson(exact), "utf8"));
    assert.doesNotThrow(() => assertSessionEndEffectiveStateCanonicalSizeV1(exact));
    assert.throws(
      () => assertSessionEndEffectiveStateCanonicalSizeV1(over),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
  });

  it("strictly decodes hashes freezes and correlates a valid effective state", () => {
    const fixture = sessionEndEffectiveStateFixture();
    const decoded = decodeSessionEndEffectiveStateV1(fixture);
    assert.deepEqual(decoded, fixture);
    assert.equal(sessionEndEffectiveStateHashV1(fixture), fixture.effectiveStateHash);
    assert.equal(fixture.effectiveStateHash, referenceSessionEndEffectiveStateHashV1(fixture));
    assert.equal(Object.isFrozen(decoded), true);
    assert.equal(Object.isFrozen(decoded.request), true);
    assert.equal(Object.isFrozen(decoded.request.finalCheckpoint), true);
    assert.equal(Object.isFrozen(decoded.effectivePolicy), true);
    assert.equal(Object.isFrozen(decoded.effectivePolicy.profiles), true);
    assert.equal(Object.isFrozen(decoded.effectivePolicy.profiles[0]), true);
    assert.doesNotThrow(() => assertSessionEndEffectiveStateRequestCorrelationV1(
      decoded,
      decoded.request,
    ));
    assert.doesNotThrow(() => assertSessionEndEffectiveStateSessionCorrelationV1(
      decoded,
      EFFECTIVE_STATE_SESSION_ID,
    ));
    assert.equal(initialSessionEndEvidenceWindowStateV1(decoded.request), "sealed");
    const versionTwo = decodeSessionEndEffectiveStateV1(
      sessionEndEffectiveStateFixture({ requestVersion: 2 }),
    );
    assert.equal(initialSessionEndEvidenceWindowStateV1(versionTwo.request), "open");
  });

  it("rejects unknown accessor proto hash draft and context mutations", () => {
    const fixture = sessionEndEffectiveStateFixture();
    assert.throws(
      () => decodeSessionEndEffectiveStateV1({ ...fixture, unknown: true }),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
    assert.throws(
      () => decodeSessionEndEffectiveStateV1({
        ...fixture,
        effectivePolicy: { ...fixture.effectivePolicy, totalEffectiveWeight: 3 },
      }),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );

    let getterCalled = false;
    const accessor = Object.defineProperty({ ...fixture }, "effectiveStateHash", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return fixture.effectiveStateHash;
      },
    });
    assert.throws(
      () => decodeSessionEndEffectiveStateV1(accessor),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
    assert.equal(getterCalled, false);

    const ownProto = { ...fixture };
    Object.defineProperty(ownProto, "__proto__", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { hidden: true },
    });
    assert.equal(Object.hasOwn(ownProto, "__proto__"), true);
    assert.throws(
      () => decodeSessionEndEffectiveStateV1(ownProto),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );

    const mismatchedDraft = { ...fixture.effectiveFinalCheckpoint, taskSummary: "different" };
    const draftMismatch = withReferenceHash({ ...fixture, effectiveFinalCheckpoint: mismatchedDraft });
    assert.throws(
      () => decodeSessionEndEffectiveStateV1(draftMismatch),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
    assert.throws(
      () => decodeSessionEndEffectiveStateV1({ ...fixture, effectiveStateHash: "0".repeat(64) }),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
    assert.throws(
      () => assertSessionEndEffectiveStateSessionCorrelationV1(
        fixture,
        "55555555-5555-4555-8555-555555555555" as never,
      ),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
    assert.throws(
      () => assertSessionEndEffectiveStateRequestCorrelationV1(
        fixture,
        { ...fixture.request, requestedQualityThreshold: 8 },
      ),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
  });

  it("preserves canonical hashing and authoritative subordinate maxima", () => {
    const boundaryCheckpoint = checkpointDraftAtCanonicalBytes(262_144);
    assert.equal(Buffer.byteLength(canonicalJson(boundaryCheckpoint), "utf8"), 262_144);
    const fixture = sessionEndEffectiveStateFixture({
      checkpoint: boundaryCheckpoint,
      profileCount: 64,
    });
    const reordered = {
      effectiveFinalCheckpoint: fixture.effectiveFinalCheckpoint,
      effectivePolicy: fixture.effectivePolicy,
      request: fixture.request,
      effectiveStateDomain: fixture.effectiveStateDomain,
      effectiveStateVersion: fixture.effectiveStateVersion,
    };
    assert.equal(
      sessionEndEffectiveStateHashV1(reordered),
      referenceSessionEndEffectiveStateHashV1(fixture),
    );
    const decoded = decodeSessionEndEffectiveStateV1(fixture);
    assert.equal(decoded.effectivePolicy.profiles.length, 64);
    assert.equal(decoded.request.validationProfileIds.length, 64);

    const reversedProfiles = [...fixture.effectivePolicy.profiles].reverse();
    const unsorted = withReferenceHash({
      ...fixture,
      effectivePolicy: { ...fixture.effectivePolicy, profiles: reversedProfiles },
    });
    assert.throws(
      () => decodeSessionEndEffectiveStateV1(unsorted),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
  });
});
