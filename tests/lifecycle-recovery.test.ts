import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  LifecycleRecoveryCoordinator,
  type LifecycleRecoveryScanInput,
} from "../src/orchestrator/lifecycle/lifecycle-recovery.coordinator.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";

function context(): ProjectContext {
  return { binding: { projectId: PROJECT_ID } } as unknown as ProjectContext;
}

function input(overrides: Partial<LifecycleRecoveryScanInput> = {}): LifecycleRecoveryScanInput {
  return {
    context: context(),
    workId: "recovery-1",
    ownerId: "99999999-9999-4999-8999-999999999999",
    fencingToken: 1n,
    dueBefore: "2026-08-16T00:00:00.000Z",
    limit: 20,
    ...overrides,
  };
}

describe("LifecycleRecoveryCoordinator", () => {
  it("performs only a read-only ordered recovery scan through the shared owner", () => {
    let observedWork: unknown;
    let observedInput: unknown;
    const operationalStore = {
      execute(work: unknown, callback: (transaction: unknown) => unknown) {
        observedWork = work;
        const result = callback({
          workflows: {
            recover(value: unknown) {
              observedInput = value;
              return {
                resultVersion: 1,
                integrityOk: true,
                readOnly: true,
                workflowCandidateCount: 2,
                outboxCandidateCount: 1,
                endingSessionCount: 1,
                expiredRootLeaseCount: 0,
                invariantFailureCodes: [],
              };
            },
          },
        });
        return { publicResult: result };
      },
    };
    const coordinator = new LifecycleRecoveryCoordinator({
      operationalStore: operationalStore as never,
    });

    const result = coordinator.execute(input());

    assert.deepEqual(result, {
      resultVersion: 1,
      integrityOk: true,
      readOnly: true,
      workflowCandidateCount: 2,
      outboxCandidateCount: 1,
      endingSessionCount: 1,
      expiredRootLeaseCount: 0,
      invariantFailureCodes: [],
    });
    assert.deepEqual(observedWork, {
      kind: "workflow-recovery",
      projectId: PROJECT_ID,
      workId: "recovery-1",
      operation: "recovery",
      ownerId: "99999999-9999-4999-8999-999999999999",
      claimToken: 1n,
    });
    assert.deepEqual(observedInput, {
      projectId: PROJECT_ID,
      dueBefore: "2026-08-16T00:00:00.000Z",
      limit: 20,
    });
  });

  it("does not infer or repair semantic work when the scan reports an invariant failure", () => {
    let callbackCount = 0;
    const operationalStore = {
      execute(_work: unknown, callback: (transaction: unknown) => unknown) {
        callbackCount += 1;
        return {
          publicResult: callback({
            workflows: {
              recover: () => ({
                resultVersion: 1,
                integrityOk: false,
                readOnly: true,
                workflowCandidateCount: 0,
                outboxCandidateCount: 0,
                endingSessionCount: 0,
                expiredRootLeaseCount: 0,
                invariantFailureCodes: ["LIFECYCLE_VALIDATION_RESULT_MISMATCH"],
              }),
            },
          }),
        };
      },
    };
    const coordinator = new LifecycleRecoveryCoordinator({ operationalStore: operationalStore as never });

    const result = coordinator.execute(input({ workId: `recovery/${WORKFLOW_ID}` }));

    assert.equal(result.integrityOk, false);
    assert.deepEqual(result.invariantFailureCodes, ["LIFECYCLE_VALIDATION_RESULT_MISMATCH"]);
    assert.equal(callbackCount, 1);
  });
});
