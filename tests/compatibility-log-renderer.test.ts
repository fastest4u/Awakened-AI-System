import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectCompatibilityLogV2 } from "../src/orchestrator/materialization/compatibility-log.projection.js";
import { renderCompatibilityLogV2 } from "../src/orchestrator/materialization/compatibility-log.renderer.js";
import { deriveCompatibilityLogTarget } from "../src/orchestrator/materialization/vault-artifact-path.js";
import { compatibilityLogReferenceCases, referenceSha256 } from "./support/compatibility-log-reference.js";
import { sessionEndEffectiveStateFixture } from "./support/session-end-effective-state-reference.js";
import {
  CHECKPOINT_ID,
  PROJECT_ID,
  STORE_ID,
  VAULT_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  checkpointFixture,
  childDispositionFixture,
  childReportFixture,
  lifecycleEvent,
  lifecycleTimestamp,
  lifecycleUuid,
} from "./support/lifecycle-fixtures.js";

const FIXTURE_ROOT = new URL("../../tests/fixtures/compatibility-log/", import.meta.url);
const ROOT_SESSION_ID = "44444444-4444-4444-8444-444444444444" as any;
const CHILD_SESSION_ID = lifecycleUuid(711) as any;
const BRANCH_REF = "refs/heads/codex/subproject-2-lifecycle-spec";

function semanticEvent(input: {
  readonly eventType: any;
  readonly eventSchemaVersion?: number;
  readonly globalPosition: number;
  readonly streamVersion: number;
  readonly payload: any;
  readonly sessionId?: any;
  readonly parentSessionId?: any;
  readonly origin?: any;
}): any {
  const sessionId = input.sessionId ?? ROOT_SESSION_ID;
  const parentSessionId = input.parentSessionId === undefined ? null : input.parentSessionId;
  return Object.freeze({
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: null,
    branchRef: BRANCH_REF,
    streamId: `session/${sessionId}`,
    streamVersion: input.streamVersion.toString(),
    globalPosition: input.globalPosition.toString(),
    sessionId,
    parentSessionId,
    eventType: input.eventType,
    eventSchemaVersion: input.eventSchemaVersion ?? 1,
    occurredAt: lifecycleTimestamp(input.globalPosition),
    payload: input.payload,
    materializationOrigin: input.origin ?? null,
    legacyIntentSemantics: null,
  });
}

function rootStart(): any {
  return semanticEvent({
    eventType: "SessionStarted",
    globalPosition: 1,
    streamVersion: 1,
    payload: lifecycleEvent(1, "SessionStarted", {}, {
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      workspaceId: WORKSPACE_ID,
    }).payload,
  });
}

function v3Request(position = 2): any {
  return semanticEvent({
    eventType: "SessionEndRequested",
    eventSchemaVersion: 3,
    globalPosition: position,
    streamVersion: 2,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      effectiveState: sessionEndEffectiveStateFixture({ requestVersion: 1 }),
    },
  });
}

function childEvent(
  eventType: any,
  globalPosition: number,
  streamVersion: number,
  payload: any,
): any {
  return semanticEvent({
    eventType,
    globalPosition,
    streamVersion,
    payload,
    sessionId: CHILD_SESSION_ID,
    parentSessionId: ROOT_SESSION_ID,
  });
}

function project(
  root: readonly any[],
  trigger: any,
  directChildren: readonly any[] = [],
  foreignClaims: readonly any[] = [],
): any {
  return projectCompatibilityLogV2({
    closure: { root, directChildren, foreignClaims },
    trigger,
    target: deriveCompatibilityLogTarget(root[0]!.occurredAt, ROOT_SESSION_ID, BigInt(trigger.globalPosition)),
  });
}

test("renders all six compatibility log literals byte for byte", () => {
  const cases = compatibilityLogReferenceCases();
  assert.equal(cases.length, 6);
  assert.equal(cases[0]!.byteLength, 1729);
  assert.equal(cases[0]!.sha256, "9c8c7650657a0f9f2c7a8828dedfad89bbff44f25d87cac1e51b1d2a539e72ce");
  for (const fixture of cases) {
    const expected = readFileSync(new URL(fixture.fixtureName, FIXTURE_ROOT));
    assert.equal(expected.length, fixture.byteLength);
    assert.equal(createHash("sha256").update(expected).digest("hex"), fixture.sha256);
    assert.equal(referenceSha256(fixture.literalUtf8), fixture.sha256);
    assert.equal(expected[0], "#".charCodeAt(0), `${fixture.fixtureName} has no BOM`);
    assert.equal(expected.includes(13), false, `${fixture.fixtureName} uses LF only`);
    assert.equal(expected.at(-1), 10, `${fixture.fixtureName} has a terminal LF`);
    assert.notEqual(expected.at(-2), 10, `${fixture.fixtureName} has exactly one terminal LF`);
    const bytes = renderCompatibilityLogV2(fixture.projection as any);
    try { assert.deepEqual(bytes, expected); } finally { bytes.fill(0); }
  }
});

test("returns fresh caller-owned buffers detached from projection input", () => {
  const fixture = compatibilityLogReferenceCases()[0]!;
  const first = renderCompatibilityLogV2(fixture.projection as any);
  const second = renderCompatibilityLogV2(fixture.projection as any);
  try { assert.notEqual(first, second); assert.deepEqual(first, second); } finally { first.fill(0); second.fill(0); }
});

test("omits random ids clocks locale topics secrets commands and raw evidence", () => {
  const projection = structuredClone(compatibilityLogReferenceCases()[1]!.projection) as any;
  projection.validation.results[0].rawEvidence = "secret bearer material";

  assert.throws(
    () => renderCompatibilityLogV2(projection),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
});

test("folds every child disposition independently per report", () => {
  const reportAFull = childReportFixture({
    reportId: lifecycleUuid(720) as any,
    childSessionId: CHILD_SESSION_ID,
    parentSessionId: ROOT_SESSION_ID,
    itemIds: [lifecycleUuid(721) as any, lifecycleUuid(722) as any],
  });
  const reportBFull = childReportFixture({
    reportId: lifecycleUuid(723) as any,
    childSessionId: CHILD_SESSION_ID,
    parentSessionId: ROOT_SESSION_ID,
    itemIds: [lifecycleUuid(724) as any, lifecycleUuid(725) as any],
  });
  const { allReportItemIds: reportAIds, ...reportA } = reportAFull;
  const { allReportItemIds: reportBIds, ...reportB } = reportBFull;
  const accepted = {
    ...childDispositionFixture("accepted", reportAFull.reportId),
    allReportItemIds: reportAIds,
    acceptedItemIds: reportAIds,
    rejectedItemIds: [],
    deferredItemIds: [],
  };
  const rejected = {
    ...childDispositionFixture("rejected", reportBFull.reportId),
    allReportItemIds: reportBIds,
    acceptedItemIds: [],
    rejectedItemIds: reportBIds,
    deferredItemIds: [],
  };
  const fork = lifecycleEvent(3, "SessionForked", {}, {
    sessionId: CHILD_SESSION_ID,
    parentSessionId: ROOT_SESSION_ID,
    globalPosition: 3,
    streamVersion: 1,
    workspaceId: WORKSPACE_ID,
  });
  const children = [{
    childSessionId: CHILD_SESSION_ID,
    events: [
      childEvent("SessionForked", 3, 1, fork.payload),
      childEvent("ChildWorkReported", 4, 2, { report: reportA, childAuthorAgentId: "agent-child", primaryRecorderAgentId: "agent-primary" }),
      childEvent("ChildWorkDispositioned", 5, 3, { disposition: accepted }),
      childEvent("ChildWorkReported", 6, 4, { report: reportB, childAuthorAgentId: "agent-child", primaryRecorderAgentId: "agent-primary" }),
      childEvent("ChildWorkDispositioned", 7, 5, { disposition: rejected }),
    ],
  }];
  const checkpoint = {
    ...checkpointFixture({
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      baseEventPosition: 7,
      checkpointEventPosition: 8,
    }),
    childSummaries: [{
      childSessionId: CHILD_SESSION_ID,
      state: "active",
      lastEventPosition: "7",
      streamVersion: "5",
      latestCheckpointId: null,
    }],
  };
  const marker = semanticEvent({
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 3,
    globalPosition: 8,
    streamVersion: 3,
    payload: {
      checkpoint,
      baseEventPosition: "7",
      checkpointEventPosition: "8",
      finalCheckpointBindingVersion: 1,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
    },
    origin: { kind: "workflow", workflowId: WORKFLOW_ID, workflowGeneration: 1 },
  });

  const projection = project([rootStart(), v3Request()], marker, children);
  assert.equal(projection.acceptedChildren.length, 2);
  assert.equal(projection.unresolvedFollowUps.length, 2);
  assert.deepEqual(
    projection.acceptedChildren.map((item: any) => item.reportId),
    [reportAFull.reportId, reportAFull.reportId],
  );
  assert.deepEqual(
    projection.unresolvedFollowUps.map((item: any) => item.reportId),
    [reportBFull.reportId, reportBFull.reportId],
  );
});
