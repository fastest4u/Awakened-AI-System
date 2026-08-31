import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  cohortBucket,
  decodeRolloutRevision,
  isSelectedCanaryCohort,
  RolloutControlPlaneError,
} from "../src/orchestrator/rollout/rollout-cohort.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

interface RolloutRevisionInput {
  projectId: string;
  revisionId: string;
  parentRevisionId: string | null;
  buildIdentityHash: string;
  migrationIdentityHash: string;
  configurationChecksum: string;
  v1BaselineChecksum: string;
  cohortAlgorithmVersion: number;
  cohortSalt: string;
  cohortBasisPoints: number;
  createdAt: string;
}

const REVISION_INPUT: Readonly<RolloutRevisionInput> = Object.freeze({
  projectId: PROJECT_ID,
  revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parentRevisionId: null,
  buildIdentityHash: "a".repeat(64),
  migrationIdentityHash: "b".repeat(64),
  configurationChecksum: "c".repeat(64),
  v1BaselineChecksum: "d".repeat(64),
  cohortAlgorithmVersion: 1,
  cohortSalt: "e".repeat(64),
  cohortBasisPoints: 500,
  createdAt: "2026-08-31T00:00:00.000Z",
});

const BINDING = Object.freeze({
  projectId: PROJECT_ID,
  workspaceId: "workspace-alpha",
});

function inputWith(overrides: Partial<RolloutRevisionInput>): Readonly<RolloutRevisionInput> {
  return Object.freeze({ ...REVISION_INPUT, ...overrides });
}

function assertInputInvalid(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    return error instanceof RolloutControlPlaneError && error.code === "ROLLOUT_INPUT_INVALID";
  });
}

describe("rollout control-plane deterministic cohorts", () => {
  it("decodes and deep-freezes an immutable canonical revision", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);

    assert.deepEqual(revision, REVISION_INPUT);
    assert.equal(Object.isFrozen(revision), true);
  });

  it("assigns the same revision, project, and workspace to the same bucket", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);

    assert.equal(cohortBucket(revision, BINDING), cohortBucket(revision, BINDING));
  });

  it("assigns a bucket from 0 through 9999", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);
    const bucket = cohortBucket(revision, BINDING);

    assert.ok(bucket >= 0);
    assert.ok(bucket <= 9999);
  });

  it("never deselects an already selected cohort when its threshold grows", () => {
    const selectedRevision = decodeRolloutRevision(inputWith({ cohortBasisPoints: 508 }));
    const largerRevision = decodeRolloutRevision(inputWith({ cohortBasisPoints: 509 }));

    assert.equal(cohortBucket(selectedRevision, BINDING), 507);
    assert.equal(isSelectedCanaryCohort(selectedRevision, BINDING), true);
    assert.equal(isSelectedCanaryCohort(largerRevision, BINDING), true);
  });

  it("rejects revisions with inherited fields", () => {
    assertInputInvalid(() => decodeRolloutRevision(Object.create(REVISION_INPUT)));
  });

  it("rejects an unsupported cohort algorithm", () => {
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ cohortAlgorithmVersion: 101 })));
  });

  it("accepts all integer basis-point values from 0 through 10000", () => {
    assert.equal(decodeRolloutRevision(inputWith({ cohortBasisPoints: 0 })).cohortBasisPoints, 0);
    assert.equal(decodeRolloutRevision(inputWith({ cohortBasisPoints: 101 })).cohortBasisPoints, 101);
    assert.equal(decodeRolloutRevision(inputWith({ cohortBasisPoints: 10000 })).cohortBasisPoints, 10000);
  });

  it("rejects invalid basis-point values", () => {
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ cohortBasisPoints: 10001 })));
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ cohortBasisPoints: 100.5 })));
  });

  it("rejects a binding outside the revision project scope", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);
    const foreignBinding = Object.freeze({ ...BINDING, projectId: OTHER_PROJECT_ID });

    assert.throws(
      () => cohortBucket(revision, foreignBinding),
      (error: unknown) => error instanceof RolloutControlPlaneError && error.code === "ROLLOUT_SCOPE_DENIED",
    );
  });

  it("rejects malformed hashes and timestamps", () => {
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ buildIdentityHash: "A".repeat(64) })));
    assertInputInvalid(() => decodeRolloutRevision(inputWith({ createdAt: "2026-08-31T00:00:00Z" })));
  });

  it("rejects arrays, unknown keys, and missing keys", () => {
    assertInputInvalid(() => decodeRolloutRevision([]));
    assertInputInvalid(() => decodeRolloutRevision(Object.freeze({ ...REVISION_INPUT, unexpected: true })));

    const { cohortSalt: _cohortSalt, ...withoutCohortSalt } = REVISION_INPUT;
    assertInputInvalid(() => decodeRolloutRevision(Object.freeze(withoutCohortSalt)));
  });

  it("rejects accessors, symbols, and non-enumerable revision properties", () => {
    const accessorInput = { ...REVISION_INPUT };
    Object.defineProperty(accessorInput, "projectId", {
      enumerable: true,
      get: () => PROJECT_ID,
    });
    assertInputInvalid(() => decodeRolloutRevision(accessorInput));

    const symbolInput = { ...REVISION_INPUT, [Symbol("hostile")]: true };
    assertInputInvalid(() => decodeRolloutRevision(symbolInput));

    const hiddenInput = { ...REVISION_INPUT };
    Object.defineProperty(hiddenInput, "hidden", { value: true, enumerable: false });
    assertInputInvalid(() => decodeRolloutRevision(hiddenInput));
  });

  it("normalizes hostile proxy trap errors to input-invalid", () => {
    const scopeDenied = () => new RolloutControlPlaneError("ROLLOUT_SCOPE_DENIED");
    const hostileRevision = new Proxy(REVISION_INPUT, {
      getPrototypeOf: () => {
        throw scopeDenied();
      },
    });
    const hostileBinding = new Proxy(BINDING, {
      getPrototypeOf: () => {
        throw scopeDenied();
      },
    });

    assertInputInvalid(() => decodeRolloutRevision(hostileRevision));
    assertInputInvalid(() => cohortBucket(decodeRolloutRevision(REVISION_INPUT), hostileBinding));
  });

  it("strictly validates cohort bindings", () => {
    const revision = decodeRolloutRevision(REVISION_INPUT);
    const inheritedBinding = Object.create(BINDING) as typeof BINDING;
    assertInputInvalid(() => cohortBucket(revision, inheritedBinding));

    const accessorBinding = { ...BINDING };
    Object.defineProperty(accessorBinding, "workspaceId", {
      enumerable: true,
      get: () => "workspace-alpha",
    });
    assertInputInvalid(() => cohortBucket(revision, accessorBinding));

    assertInputInvalid(() => cohortBucket(revision, Object.freeze({ ...BINDING, workspaceId: "" })));
  });
});
